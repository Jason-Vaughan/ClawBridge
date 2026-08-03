'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ── v2 PTY broker ──
const { SessionManager } = require('./v2/sessions');
const { ptyAvailable, checkSpawnable } = require('./v2/pty');
const { handleV2Route } = require('./v2/routes');
const { validateProjectPath: _validateProjectPath } = require('./v2/path-safety');

// Own package version, surfaced on /health so deployments can verify which
// bridge build is actually serving traffic. Resolved at boot, not per
// request — package.json doesn't change after the process starts. Falls
// back to 'unknown' rather than throwing, so a malformed install can still
// answer /health.
let BRIDGE_VERSION;
try {
  BRIDGE_VERSION = require('../package.json').version;
} catch {
  BRIDGE_VERSION = 'unknown';
}

// ── Load .env ──

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ── Config ──

const PORT = parseInt(process.env.BRIDGE_PORT || '3201', 10);
const TOKEN = process.env.BRIDGE_TOKEN || '';

// Running without a bearer token exposes every route — including session start,
// which spawns an agent with shell access to this host — to anyone who can reach
// the port, and the server binds 0.0.0.0. That is a deliberate choice or it is a
// misconfiguration, and the two must not look alike, so it takes an explicit
// opt-in and the process refuses to start otherwise.
//
// Exact-match on purpose: accepting '1'/'yes'/any-truthy makes a security control
// easy to enable absent-mindedly, and this one should read as a decision in a
// deployment audit.
const ALLOW_UNAUTHENTICATED = process.env.CLAWBRIDGE_ALLOW_UNAUTHENTICATED === 'true';
const HOME = process.env.HOME || '';
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, 'projects');
const PRAWDUCT_DIR = path.join(HOME, 'prawduct');
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude';
const PRAWDUCT_SETUP = path.join(PRAWDUCT_DIR, 'tools', 'prawduct-setup.py');

/**
 * Resolve the python3 binary path, checking env var then known locations.
 * @returns {string} Resolved path to python3
 */
function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { execSync } = require('node:child_process');
    const resolved = execSync('which python3', { encoding: 'utf8', timeout: 3000 }).trim();
    if (resolved) return resolved;
  } catch { /* which failed */ }
  return 'python3';
}

const PYTHON_BIN = resolvePythonBin();
const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(HOME, 'exports');

const DEFAULT_TIMEOUT = 300000; // 5 min
const MAX_TIMEOUT = 1800000;    // 30 min

// ── Tools extension (optional) ──
// Contract: docs/tools-extension.md. Module must export
// { init, handleToolsRoute, getToolsHealth, close } as async functions.

/**
 * Load and validate the tools extension module at the given absolute path.
 * Failures are logged and return null — the bridge runs without /tools/* support.
 * @param {string} modulePath - Absolute filesystem path to the extension module
 * @returns {object|null} Validated extension module, or null on any failure
 */
function loadToolsExtension(modulePath) {
  if (!path.isAbsolute(modulePath)) {
    console.warn(`CLAWBRIDGE_TOOLS_MODULE must be an absolute path (got: ${modulePath}) — tools extension disabled`);
    return null;
  }
  if (!fs.existsSync(modulePath)) {
    console.warn(`CLAWBRIDGE_TOOLS_MODULE not found at ${modulePath} — tools extension disabled`);
    return null;
  }
  let mod;
  try {
    mod = require(modulePath);
  } catch (err) {
    console.warn(`Failed to load CLAWBRIDGE_TOOLS_MODULE at ${modulePath}: ${err.message} — tools extension disabled`);
    return null;
  }
  for (const name of ['init', 'handleToolsRoute', 'getToolsHealth', 'close']) {
    if (typeof mod[name] !== 'function') {
      console.warn(`CLAWBRIDGE_TOOLS_MODULE at ${modulePath} missing export '${name}' — tools extension disabled`);
      return null;
    }
  }
  return mod;
}

const TOOLS_MODULE_PATH = process.env.CLAWBRIDGE_TOOLS_MODULE || '';
let toolsExtension = TOOLS_MODULE_PATH ? loadToolsExtension(TOOLS_MODULE_PATH) : null;

// ── Process Registry (for external polling / sidecar visibility) ──

/** @type {Map<string, object>} Active/recent process entries keyed by run ID */
const _processRegistry = new Map();

/** How long to retain completed runs (30 minutes) */
const PROCESS_RETAIN_MS = 30 * 60 * 1000;

/** Quiet threshold: no output for this long → status = quiet */
const QUIET_THRESHOLD_MS = 30 * 1000;

/** Stalled threshold: no output for this long while running → suspectedStalled */
const STALLED_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Register a new process in the registry.
 * @param {object} opts
 * @param {string} opts.id - Unique run ID
 * @param {string} opts.type - Process type (claude, prawduct, exec, session)
 * @param {string} opts.label - Description
 * @param {string|null} [opts.project] - Project name
 * @param {string|null} [opts.workDir] - Working directory
 * @returns {object} The registry entry
 */
function registerProcess(opts) {
  const entry = {
    id: opts.id,
    type: opts.type,
    label: opts.label,
    project: opts.project || null,
    workDir: opts.workDir || null,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastUpdateAt: null,
    completedAt: null,
    exitCode: null,
    signal: null,
    lastOutputSnippet: null,
    needsAttention: false,
    waitingForInput: false,
    suspectedStalled: false
  };
  _processRegistry.set(opts.id, entry);
  return entry;
}

/**
 * Update process output state.
 * @param {string} id - Process ID
 * @param {string} output - New output chunk
 */
function updateProcessOutput(id, output) {
  const entry = _processRegistry.get(id);
  if (!entry) return;
  entry.lastUpdateAt = new Date().toISOString();
  entry.status = 'running';
  entry.suspectedStalled = false;
  // Keep last ~200 chars
  const snippet = (entry.lastOutputSnippet || '') + output;
  entry.lastOutputSnippet = snippet.slice(-200);
}

/**
 * Mark a process as completed.
 * @param {string} id - Process ID
 * @param {number} exitCode
 * @param {string|null} [signal]
 */
function completeProcess(id, exitCode, signal) {
  const entry = _processRegistry.get(id);
  if (!entry) return;
  entry.completedAt = new Date().toISOString();
  entry.exitCode = exitCode;
  entry.signal = signal || null;
  entry.status = exitCode === 0 ? 'completed' : (signal ? 'terminated' : 'failed');
  entry.needsAttention = entry.status === 'failed';
  entry.suspectedStalled = false;
}

/**
 * Refresh heuristic flags on a process entry.
 * @param {object} entry
 */
function refreshHeuristics(entry) {
  if (entry.completedAt) return;
  const now = Date.now();
  const lastUpdate = entry.lastUpdateAt ? new Date(entry.lastUpdateAt).getTime() : new Date(entry.startedAt).getTime();
  const elapsed = now - lastUpdate;

  if (elapsed > STALLED_THRESHOLD_MS) {
    entry.suspectedStalled = true;
  } else if (elapsed > QUIET_THRESHOLD_MS) {
    entry.status = 'quiet';
  }

  entry.needsAttention = entry.waitingForInput || entry.suspectedStalled || entry.status === 'failed';
}

/**
 * Purge completed processes older than PROCESS_RETAIN_MS.
 */
function purgeOldProcesses() {
  const cutoff = Date.now() - PROCESS_RETAIN_MS;
  for (const [id, entry] of _processRegistry) {
    if (entry.completedAt && new Date(entry.completedAt).getTime() < cutoff) {
      _processRegistry.delete(id);
    }
  }
}

/**
 * Build the /api/processes response from the registry + v2 sessions.
 * @returns {{ active: object[], recent: object[] }}
 */
function buildProcessesResponse() {
  purgeOldProcesses();

  const active = [];
  const recent = [];

  // v1 registry entries
  for (const entry of _processRegistry.values()) {
    refreshHeuristics(entry);
    if (entry.completedAt) {
      recent.push({ ...entry });
    } else {
      active.push({ ...entry });
    }
  }

  // v2 PTY sessions — map to process shape
  for (const session of v2SessionManager.list()) {
    // Skip if already tracked in v1 registry
    if (_processRegistry.has(`v2-${session.sessionId}`)) continue;

    const isTerminal = session.isTerminal;
    let status = 'running';
    if (session.state === 'waiting_for_permission') {
      status = 'running';
    } else if (session.state === 'completed') {
      status = 'completed';
    } else if (session.state === 'failed') {
      status = 'failed';
    } else if (session.state === 'timed_out') {
      status = 'terminated';
    } else if (session.state === 'ended') {
      status = session.exitCode === 0 ? 'completed' : 'failed';
    }

    const waitingForInput = session.state === 'waiting_for_permission';
    const transcript = session.eventLog ? session.eventLog.getTranscript() : '';
    const lastOutput = transcript ? transcript.slice(-500) : null;

    // Detect test results for pill content
    let testResult = null;
    try {
      const { detectTestResult } = require('./v2/routes');
      if (session.eventLog) testResult = detectTestResult(session.eventLog);
    } catch { /* routes not loaded yet */ }

    // Build a useful summary line
    let summary = `v2 session: ${session.project}`;
    if (testResult) {
      summary += ` | tests: ${testResult.passed} passed`;
      if (testResult.failed > 0) summary += `, ${testResult.failed} failed`;
      summary += ` (${testResult.runner})`;
    }
    if (waitingForInput) {
      summary += ' | WAITING FOR PERMISSION';
      if (session.pendingPermission) {
        summary += `: ${session.pendingPermission.permissionType}`;
        const target = session.pendingPermission.target;
        if (target && target.path) summary += ` → ${target.path}`;
        if (target && target.command) summary += ` → ${target.command}`;
      }
    }

    const proc = {
      id: `v2-${session.sessionId}`,
      type: 'claude',
      label: summary,
      project: session.project,
      workDir: session.projectDir,
      status,
      startedAt: session.createdAt,
      lastUpdateAt: session.updatedAt,
      completedAt: isTerminal ? session.updatedAt : null,
      exitCode: session.exitCode,
      signal: null,
      lastOutputSnippet: lastOutput,
      testResult,
      needsAttention: waitingForInput || status === 'failed',
      waitingForInput,
      suspectedStalled: false
    };

    if (isTerminal) {
      recent.push(proc);
    } else {
      active.push(proc);
    }
  }

  return { active, recent };
}

// ── v2 Session Manager ──

const HISTORY_DIR = path.join(__dirname, '.session-history');

const v2SessionManager = new SessionManager({
  projectsDir: PROJECTS_DIR,
  claudeBin: CLAUDE_BIN,
  historyDir: HISTORY_DIR,
});

const crypto = require('node:crypto');

// ── Helpers ──

/**
 * Parse JSON body from request.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} data
 */
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Validate bearer token.
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function checkAuth(req) {
  // Fail closed. Reaching here without a token means the operator opted in via
  // CLAWBRIDGE_ALLOW_UNAUTHENTICATED (startServer refuses to listen otherwise),
  // so this returns the opt-in itself rather than a bare `true` — an unset token
  // can never widen authority on its own, which is the rule policy.js already
  // follows for approval envelopes.
  if (!TOKEN) return ALLOW_UNAUTHENTICATED;

  const auth = req.headers['authorization'] || '';
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const presented = Buffer.from(auth);
  // timingSafeEqual throws on unequal lengths, so the length check has to come
  // first. It leaks only the header's length, which its own transmission already
  // reveals; the byte comparison below is what must not leak a prefix match.
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

/**
 * Validate a working directory is within allowed paths.
 * @param {string} dir
 * @returns {boolean}
 */
const BRIDGE_DIR = path.join(HOME, 'clawbridge');

function isAllowedDir(dir) {
  const resolved = path.resolve(dir);
  return resolved.startsWith(PROJECTS_DIR) || resolved.startsWith(PRAWDUCT_DIR) || resolved.startsWith(BRIDGE_DIR);
}

// ── Content-Type helper ──

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
};

/**
 * Get the Content-Type for a filename based on its extension.
 * @param {string} filename
 * @returns {string} MIME type string
 */
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ── Project file helpers ──

/** @type {Set<string>} Directories excluded from project file listings by default */
const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.claude']);

/**
 * Server-local wrapper that binds the shared `validateProjectPath` to this
 * process's `PROJECTS_DIR`. Kept as a thin shim so the call sites below stay
 * unchanged.
 * @param {string} project
 * @param {string} [subPath]
 * @returns {{valid: boolean, projectDir: string, resolvedPath: string, error?: string}}
 */
function validateProjectPath(project, subPath) {
  return _validateProjectPath(PROJECTS_DIR, project, subPath);
}

/**
 * List files in a project directory.
 * @param {string} baseDir - Absolute path to project root
 * @param {object} [options]
 * @param {string} [options.subPath] - Subdirectory to list (relative to baseDir)
 * @param {boolean} [options.recursive] - Recurse into subdirectories (default false)
 * @param {number} [options.maxDepth] - Maximum recursion depth (default 10)
 * @param {Set<string>} [options.excludeDirs] - Directory names to skip (default: node_modules, .git, .claude)
 * @param {string} [options.project] - Project name for URL generation
 * @returns {Array<{name: string, path: string, size?: number, mtime?: string, type: string, url?: string, children?: number}>}
 */
function listProjectFiles(baseDir, options = {}) {
  const recursive = options.recursive || false;
  const maxDepth = options.maxDepth ?? 10;
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const project = options.project || '';

  const startDir = options.subPath ? path.join(baseDir, options.subPath) : baseDir;
  if (!fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) {
    return [];
  }

  const files = [];

  function walk(dir, relPrefix, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (recursive) {
          walk(path.join(dir, entry.name), relPath, depth + 1);
        } else {
          // Count children (non-excluded)
          let children = 0;
          try {
            children = fs.readdirSync(path.join(dir, entry.name)).filter(
              n => !excludeDirs.has(n)
            ).length;
          } catch { /* unreadable */ }
          files.push({ name: entry.name, path: relPath, type: 'directory', children });
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            name: entry.name,
            path: relPath,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            type: 'file',
            url: project ? `/projects/${project}/files/${relPath}` : undefined
          });
        } catch { /* unreadable */ }
      }
    }
  }

  walk(startDir, options.subPath || '', 0);
  return files;
}

/**
 * Run a command as a child process and collect output.
 * @param {string} cmd - Command binary
 * @param {string[]} args - Arguments
 * @param {object} options
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms
 * @param {object} [options.track] - Process registry tracking options
 * @param {string} [options.track.type] - Process type (claude, prawduct, exec)
 * @param {string} [options.track.label] - Description
 * @param {string} [options.track.project] - Project name
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, durationMs: number}>}
 */
function runCommand(cmd, args, options = {}) {
  const cwd = options.cwd || PROJECTS_DIR;
  const timeout = Math.min(options.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

  // Register in process registry if tracking requested
  let processId = null;
  if (options.track) {
    processId = crypto.randomUUID();
    registerProcess({
      id: processId,
      type: options.track.type || 'exec',
      label: options.track.label || cmd,
      project: options.track.project || null,
      workDir: cwd
    });
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const stdout = [];
    const stderr = [];

    const child = spawn(cmd, args, {
      cwd,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}` }
    });

    child.stdout.on('data', d => {
      stdout.push(d);
      if (processId) updateProcessOutput(processId, d.toString());
    });
    child.stderr.on('data', d => {
      stderr.push(d);
      if (processId) updateProcessOutput(processId, d.toString());
    });

    child.on('close', (code) => {
      if (processId) completeProcess(processId, code ?? 1, null);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        durationMs: Date.now() - start
      });
    });

    child.on('error', (err) => {
      if (processId) completeProcess(processId, 1, null);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - start
      });
    });
  });
}

// ── Routes ──

const server = http.createServer(async (req, res) => {
 try {
  // `new URL` throws ERR_INVALID_URL on a request target like `//` or `///`,
  // which a raw client can send even though curl normalizes it away. This is the
  // FIRST statement of the handler — above auth, above every route — so an
  // uncaught throw here is not a 400, it is process death: the callback is
  // async, so it surfaces as an unhandledRejection and Node's default exits.
  // Unauthenticated, one request, every in-memory PTY session gone.
  //
  // The whole handler is wrapped for the same reason. Guarding individual
  // handlers was not enough: the `/exports` pair got its own try/catch and this
  // line still sat outside it, which is the third time this exact shape has been
  // found here. The boundary that needs the guard is the callback, not whichever
  // statement most recently threw.
  //
  // This is a per-request boundary, not a process-level `uncaughtException`
  // handler — see architecture.md, which rejects the latter. The request fails;
  // the process keeps its invariants.
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return json(res, 400, { error: 'Invalid request target' });
  }
  const method = req.method;
  const pathname = url.pathname;

  // CORS for container access. Wildcard origin, and the preflight below allows
  // POST with an Authorization header — so any web page the operator visits can
  // make cross-origin calls to this bridge on localhost. With a token that is
  // merely a nuisance (the page has no credential). Under
  // CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true it is not: a visited page can
  // POST /v2/session/start and spawn an agent with shell access to the host.
  //
  // This is why the escape hatch's precondition is stated as "no browser on this
  // host" rather than "unreachable from the network" — see README Security
  // Posture. Narrowing the origin when running open is filed as CRS-4T8K.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.writeHead(204);
    return res.end();
  }

  // Static exports serving (no auth — read-only, public)
  //
  // These two handlers run BEFORE the auth check, so they cannot live inside the
  // main request try/catch further down — that sits after auth, and moving them
  // there would make the routes private.
  //
  // The whole callback is wrapped (see the top of this handler), so a throw here
  // is no longer fatal. These narrower guards remain because they turn a
  // filesystem error into a specific status and log line instead of the generic
  // 500 the outer net produces — worth keeping on the one surface that is
  // unauthenticated and reads arbitrary paths.
  //
  // History, because it explains why both layers exist: an undefined `ext` here
  // was a remote unauthenticated process kill, and fixing that one throw left
  // EACCES on an unreadable file (verified) and TOCTOU on a rotated file
  // reachable through the identical path. Per-handler guards then still left
  // `new URL(req.url, ...)` above them. Guard the boundary, not the statement.
  if (method === 'GET' && pathname.startsWith('/exports/')) {
   try {
    const filename = pathname.slice('/exports/'.length);
    // Block traversal and symlink escape
    if (!filename || filename.includes('..') || filename.includes('\0') || path.isAbsolute(filename)) {
      return json(res, 400, { error: 'Invalid filename' });
    }
    const filePath = path.join(EXPORTS_DIR, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(EXPORTS_DIR))) {
      return json(res, 403, { error: 'Access denied' });
    }
    // Check symlink doesn't escape
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(path.resolve(EXPORTS_DIR))) {
        return json(res, 403, { error: 'Access denied' });
      }
    } catch {
      return json(res, 404, { error: 'File not found' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return json(res, 404, { error: 'File not found' });
    }
    const contentType = getContentType(filename);
    // Always inline. This was a ternary over an undefined `ext`, which threw a
    // ReferenceError on every successful download — above the auth check and
    // outside the request try/catch, so it terminated the process rather than
    // returning 500. Both branches were 'inline' anyway, so the condition never
    // decided anything.
    const disposition = 'inline';
    const content = fs.readFileSync(resolved);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${path.basename(filename)}"`,
      'Content-Length': content.length
    });
    return res.end(content);
   } catch (err) { // prawduct:allow prawduct/broad-except -- any sync-fs failure on this unauthenticated route becomes a specific 500 + log line rather than the outer wrapper's generic one
    console.error(`[bridge] /exports serve failed for ${pathname}:`, err);
    if (!res.headersSent) return json(res, 500, { error: 'Export read failed' });
    return res.destroy(err);
   }
  }

  // GET /exports — list available exports (no auth). Same reasoning as above:
  // readdirSync/statSync can throw (permissions, or a file rotated away between
  // the readdir and its stat). The outer wrapper would catch it; this guard is
  // here to return a listing-specific error instead of a generic one.
  if (method === 'GET' && pathname === '/exports') {
   try {
    if (!fs.existsSync(EXPORTS_DIR)) {
      return json(res, 200, { exports: [] });
    }
    const files = fs.readdirSync(EXPORTS_DIR, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => {
        // Tolerate a single unstattable entry rather than failing the whole
        // listing — the common cause is a file removed between readdir and stat.
        let size = null;
        try {
          size = fs.statSync(path.join(EXPORTS_DIR, d.name)).size;
        } catch { /* size stays null; the entry is still listed */ }
        return { name: d.name, size, url: `/exports/${d.name}` };
      });
    return json(res, 200, { exports: files });
   } catch (err) { // prawduct:allow prawduct/broad-except -- any sync-fs failure on this unauthenticated route becomes a specific 500 + log line rather than the outer wrapper's generic one
    console.error('[bridge] /exports listing failed:', err);
    if (!res.headersSent) return json(res, 500, { error: 'Export listing failed' });
    return res.destroy(err);
   }
  }

  // Auth check (skip for health and exports)
  if (pathname !== '/health' && !checkAuth(req)) {
    // Leave a trace. This binds 0.0.0.0 and every authenticated route can spawn
    // an agent with shell access, so repeated 401s are the signal that someone
    // is probing — and stdout is the operator's only channel on an unattended
    // daemon (observability-strategy.md). Log the method, path and coarse peer;
    // never the presented credential, which would move a would-be secret from
    // the wire into a log file that outlives the request.
    console.warn(`[bridge] 401 ${method} ${pathname} from ${req.socket?.remoteAddress ?? 'unknown'}`);
    return json(res, 401, { error: 'Unauthorized' });
  }

  try {
    // ── v2 routes ──
    if (pathname.startsWith('/v2/')) {
      const handled = await handleV2Route({
        method, pathname, url, req, res,
        parseBody, json,
        sessionManager: v2SessionManager,
      });
      if (handled) return;
    }

    // ── tools extension routes ──
    if (toolsExtension && (pathname === '/tools' || pathname.startsWith('/tools/'))) {
      try {
        const handled = await toolsExtension.handleToolsRoute({ pathname, req, res });
        if (handled) return;
        return json(res, 404, { error: 'Not found' });
      } catch (err) {
        console.error('Tools extension handleToolsRoute error:', err);
        if (!res.headersSent) {
          return json(res, 500, { error: 'Tools extension error' });
        }
        res.destroy(err);
        return;
      }
    }

    // GET /api/processes — process visibility for external orchestrators
    if (method === 'GET' && pathname === '/api/processes') {
      const data = buildProcessesResponse();
      return json(res, 200, data);
    }

    // GET /health
    if (method === 'GET' && pathname === '/health') {
      const claudeExists = fs.existsSync(CLAUDE_BIN);
      const prawductExists = fs.existsSync(PRAWDUCT_SETUP);
      const claudeVersion = claudeExists
        ? (await runCommand(CLAUDE_BIN, ['--version'], { timeout: 5000 })).stdout.trim()
        : 'not found';

      // ptySpawnable is re-checked per request so it reflects the current
      // on-disk state of `spawn-helper`. ptyAvailable (require-load) can be
      // true while ptySpawnable is false — see issue #16, where node-pty's
      // shipped spawn-helper had no exec bit and every session died with
      // `posix_spawnp failed` even though the native binding loaded fine.
      //
      // `bridge` reports this package's own semver so operators can verify
      // which bridge build is actually serving traffic after `npm update`
      // — `claude` is the Claude binary's version, not the bridge's.
      const payload = {
        ok: true,
        bridge: BRIDGE_VERSION,
        claude: claudeVersion,
        prawduct: prawductExists ? 'available' : 'not found',
        projectsDir: PROJECTS_DIR,
        activeSessions: v2SessionManager.activeCount,
        ptyMode: ptyAvailable ? 'pty' : 'pipes-fallback',
        ptyAvailable,
        ptySpawnable: checkSpawnable(),
        auth: { required: Boolean(TOKEN) },
      };

      // A health endpoint that asserts wellness over an open door is its own
      // defect. `ok` stays true — it means "the broker is serving", and the
      // tools-extension contract already holds that line by never letting an
      // extension failure flip it — so `insecure` is the separate, alertable
      // signal for a bridge running without authentication.
      //
      // This does tell an unauthenticated caller that auth is off, but a single
      // request to any other route reveals the same thing. Withholding it would
      // only keep the operator blind to protect a secret an attacker already has.
      if (!TOKEN) {
        payload.insecure = true;
        payload.auth.warning =
          'No BRIDGE_TOKEN is set. Every route is served without authentication, '
          + 'enabled by CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true.';
      }

      if (toolsExtension) {
        try {
          payload.tools = await toolsExtension.getToolsHealth();
        } catch (err) {
          payload.tools = { ok: false, error: err.message || String(err) };
        }
      }

      return json(res, 200, payload);
    }

    // POST /prawduct/run
    if (method === 'POST' && pathname === '/prawduct/run') {
      const body = await parseBody(req);
      if (!body.command) {
        return json(res, 400, { error: 'command is required (setup, sync, validate)' });
      }

      const allowedCommands = ['setup', 'sync', 'validate'];
      if (!allowedCommands.includes(body.command)) {
        return json(res, 400, { error: `command must be one of: ${allowedCommands.join(', ')}` });
      }

      const workDir = body.workDir || PROJECTS_DIR;
      if (!isAllowedDir(workDir)) {
        return json(res, 403, { error: `workDir must be under ${PROJECTS_DIR} or ${PRAWDUCT_DIR}` });
      }

      const args = [PRAWDUCT_SETUP, body.command, workDir];
      if (body.args && Array.isArray(body.args)) {
        args.push(...body.args);
      }

      const result = await runCommand(PYTHON_BIN, args, {
        cwd: workDir,
        timeout: body.timeout || 120000,
        track: { type: 'prawduct', label: `prawduct ${body.command}`, project: null }
      });

      return json(res, 200, result);
    }

    // GET /projects
    if (method === 'GET' && pathname === '/projects') {
      let projects = [];
      if (fs.existsSync(PROJECTS_DIR)) {
        projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
      }
      return json(res, 200, { projectsDir: PROJECTS_DIR, projects });
    }

    // GET /projects/:project/files or GET /projects/:project/files/*
    const projectFilesMatch = method === 'GET' && pathname.match(/^\/projects\/([^/]+)\/files(?:\/(.+))?$/);
    if (projectFilesMatch) {
      const project = decodeURIComponent(projectFilesMatch[1]);
      const subPath = projectFilesMatch[2] ? decodeURIComponent(projectFilesMatch[2]) : null;

      const validation = validateProjectPath(project, subPath);
      if (!validation.valid) {
        return json(res, 400, { error: validation.error });
      }

      if (!fs.existsSync(validation.projectDir)) {
        return json(res, 404, { error: `Project not found: ${project}` });
      }

      if (subPath) {
        // Serve a specific file
        if (!fs.existsSync(validation.resolvedPath)) {
          return json(res, 404, { error: 'File not found' });
        }
        const stat = fs.statSync(validation.resolvedPath);
        if (!stat.isFile()) {
          return json(res, 400, { error: 'Not a file (use files listing for directories)' });
        }
        const contentType = getContentType(subPath);
        const content = fs.readFileSync(validation.resolvedPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${path.basename(subPath)}"`,
          'Content-Length': content.length
        });
        return res.end(content);
      }

      // List files in the project
      const queryParams = url.searchParams;
      const recursive = queryParams.get('recursive') === 'true';
      const scopePath = queryParams.get('path') || '';

      // Validate scope path if provided
      if (scopePath) {
        const scopeValidation = validateProjectPath(project, scopePath);
        if (!scopeValidation.valid) {
          return json(res, 400, { error: scopeValidation.error });
        }
      }

      const files = listProjectFiles(validation.projectDir, {
        subPath: scopePath || undefined,
        recursive,
        project
      });

      return json(res, 200, {
        project,
        basePath: scopePath,
        files
      });
    }

    // 404
    return json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('Request error:', err);
    return json(res, 500, { error: err.message });
  }
 } catch (err) { // prawduct:allow prawduct/broad-except -- request-boundary net; an uncaught throw in this async callback exits the process
   console.error(`[bridge] unhandled error serving ${req.method} ${req.url}:`, err);
   if (!res.headersSent) {
     try { return json(res, 500, { error: 'Internal error' }); } catch { /* response already gone */ }
   }
   return res.destroy(err);
 }
});

/**
 * Initialize the tools extension (if loaded), then start listening.
 * If init() rejects, the extension is disabled and the bridge starts anyway.
 * @returns {Promise<void>}
 */
async function startServer() {
  // Refuse a fail-open configuration before the socket opens. README.md has
  // documented BRIDGE_TOKEN as required since before this check existed; until
  // now the code disagreed, and an unattended daemon started without its
  // environment served every route to the local network while /health reported
  // a healthy service. A warning would not have helped — nobody reads stdout on
  // a launchd service at 3am, which is the same blindness that hid the
  // spawn-helper failure for a release.
  if (!TOKEN && !ALLOW_UNAUTHENTICATED) {
    console.error('FATAL: BRIDGE_TOKEN is not set.');
    console.error('');
    console.error('  ClawBridge binds 0.0.0.0 and every authenticated route can spawn an agent');
    console.error('  with shell access to this host, so it will not start without a bearer token.');
    console.error('');
    console.error('  Fix: set BRIDGE_TOKEN in bridge/.env (or the service environment).');
    console.error('  It is a secret you invent, not one that is issued — generate one with:');
    console.error('    openssl rand -base64 32');
    console.error('  (This is NOT the same as CLAUDE_CODE_OAUTH_TOKEN, which comes from');
    console.error('   `claude setup-token`.)');
    console.error('  Override — only if nothing else can reach this port AND no browser runs');
    console.error('  on this host (CORS is wildcard, so a visited page could call the API):');
    console.error('    CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true');
    process.exit(1);
  }

  if (toolsExtension) {
    try {
      await toolsExtension.init();
    } catch (err) {
      console.warn(`Tools extension init() failed: ${err.message || err} — continuing without /tools/*`);
      toolsExtension = null;
    }
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ClawBridge listening on 0.0.0.0:${PORT}`);
    console.log(`  Claude: ${CLAUDE_BIN}`);
    console.log(`  Python: ${PYTHON_BIN}`);
    if (fs.existsSync(PRAWDUCT_SETUP)) console.log(`  Prawduct: ${PRAWDUCT_SETUP}`);
    console.log(`  Projects: ${PROJECTS_DIR}`);
    if (TOKEN) {
      console.log(`  Auth: Bearer token required`);
    } else {
      console.warn(`  Auth: *** UNAUTHENTICATED *** — every route is open to anyone who can`);
      console.warn(`        reach 0.0.0.0:${PORT}, including session start. Enabled by`);
      console.warn(`        CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true. Unset it to require a token.`);
    }
    console.log(`  v2 PTY broker: enabled`);
    if (toolsExtension) console.log(`  Tools extension: ${TOOLS_MODULE_PATH}`);
  });
}

startServer();

// ── Cleanup on shutdown ──

let _shuttingDown = false;

/**
 * Destroy all v2 PTY sessions and close the tools extension before exiting.
 * Idempotent: a second SIGTERM/SIGINT while shutdown is in flight is ignored,
 * so the extension's `close()` runs exactly once per the v1 contract.
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log('Shutting down — destroying v2 sessions...');
  v2SessionManager.destroyAll();
  // Null the module reference before awaiting close() so late /tools/*
  // requests fall through to 404 instead of hitting a closing extension.
  const ext = toolsExtension;
  toolsExtension = null;
  if (ext) {
    try {
      await ext.close();
    } catch (err) {
      console.error('Tools extension close() failed:', err);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
