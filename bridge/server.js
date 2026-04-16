'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ── v2 PTY broker ──
const { SessionManager } = require('./v2/sessions');
const { handleV2Route } = require('./v2/routes');

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
const HOME = process.env.HOME || '';
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, 'projects');
const PRAWDUCT_DIR = path.join(HOME, 'prawduct');
const CLAUDE_BIN = '/usr/local/bin/claude';
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
  if (!TOKEN) return true; // no token = open (dev mode)
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${TOKEN}`;
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
 * Validate a project name and optional subpath for path traversal attacks.
 * @param {string} project - Project name from URL
 * @param {string} [subPath] - Optional file/directory subpath
 * @returns {{valid: boolean, projectDir: string, resolvedPath: string, error?: string}}
 */
function validateProjectPath(project, subPath) {
  // Reject dangerous characters in project name
  if (!project || project.includes('..') || project.includes('\0') || project.includes('/')) {
    return { valid: false, projectDir: '', resolvedPath: '', error: 'Invalid project name' };
  }

  const projectDir = path.join(PROJECTS_DIR, project);

  if (!subPath) {
    return { valid: true, projectDir, resolvedPath: projectDir };
  }

  // Reject traversal in subpath
  if (subPath.includes('\0') || path.isAbsolute(subPath)) {
    return { valid: false, projectDir, resolvedPath: '', error: 'Invalid path' };
  }

  // Normalize and check for traversal
  const resolvedPath = path.resolve(projectDir, subPath);
  const resolvedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(resolvedProjectDir + path.sep) && resolvedPath !== resolvedProjectDir) {
    return { valid: false, projectDir, resolvedPath, error: 'Path escapes project directory' };
  }

  // Symlink escape check (resolve both sides to handle /tmp → /private/tmp etc.)
  try {
    const real = fs.realpathSync(resolvedPath);
    const realProjectsDir = fs.realpathSync(PROJECTS_DIR);
    if (!real.startsWith(realProjectsDir + path.sep) && !real.startsWith(realProjectsDir)) {
      return { valid: false, projectDir, resolvedPath, error: 'Symlink escapes allowed directory' };
    }
  } catch {
    // File doesn't exist — that's OK for validation, caller handles 404
  }

  return { valid: true, projectDir, resolvedPath };
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
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS for container access
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.writeHead(204);
    return res.end();
  }

  // Static exports serving (no auth — read-only, public)
  if (method === 'GET' && pathname.startsWith('/exports/')) {
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
    const disposition = ['.pdf', '.png', '.jpg', '.jpeg', '.svg'].includes(ext) ? 'inline' : 'inline';
    const content = fs.readFileSync(resolved);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${path.basename(filename)}"`,
      'Content-Length': content.length
    });
    return res.end(content);
  }

  // GET /exports — list available exports (no auth)
  if (method === 'GET' && pathname === '/exports') {
    if (!fs.existsSync(EXPORTS_DIR)) {
      return json(res, 200, { exports: [] });
    }
    const files = fs.readdirSync(EXPORTS_DIR, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => ({
        name: d.name,
        size: fs.statSync(path.join(EXPORTS_DIR, d.name)).size,
        url: `/exports/${d.name}`
      }));
    return json(res, 200, { exports: files });
  }

  // Auth check (skip for health and exports)
  if (pathname !== '/health' && !checkAuth(req)) {
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

      const payload = {
        ok: true,
        claude: claudeVersion,
        prawduct: prawductExists ? 'available' : 'not found',
        projectsDir: PROJECTS_DIR,
        activeSessions: v2SessionManager.activeCount
      };

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
});

/**
 * Initialize the tools extension (if loaded), then start listening.
 * If init() rejects, the extension is disabled and the bridge starts anyway.
 * @returns {Promise<void>}
 */
async function startServer() {
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
    console.log(`  Auth: ${TOKEN ? 'Bearer token required' : 'OPEN (no token set)'}`);
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
