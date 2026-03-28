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
const HOME = process.env.HOME || require('node:os').homedir();
const PROJECTS_DIR = path.join(HOME, '.openclaw', 'projects');
const PRAWDUCT_DIR = path.join(HOME, 'prawduct');
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude';
const PYTHON_BIN = process.env.PYTHON_BIN || '/usr/bin/python3';
const PRAWDUCT_SETUP = path.join(PRAWDUCT_DIR, 'tools', 'prawduct-setup.py');
const EXPORTS_DIR = path.join(HOME, '.openclaw', 'exports');

const DEFAULT_TIMEOUT = 300000; // 5 min
const MAX_TIMEOUT = 1800000;    // 30 min

// ── v2 Session Manager ──

const v2SessionManager = new SessionManager({
  projectsDir: PROJECTS_DIR,
  claudeBin: CLAUDE_BIN,
});

// ── Circuit Breaker ──

const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.BRIDGE_CIRCUIT_BREAKER || '3', 10);
let _consecutiveFailures = 0;
let _circuitOpen = false;
let _circuitOpenedAt = null;

/**
 * Record a build result and trip/reset the circuit breaker.
 * @param {number} exitCode - Process exit code
 */
function recordBuildResult(exitCode) {
  if (exitCode !== 0) {
    _consecutiveFailures++;
    if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      _circuitOpen = true;
      _circuitOpenedAt = new Date().toISOString();
      console.log(`Circuit breaker OPEN after ${_consecutiveFailures} consecutive failures`);
    }
  } else {
    if (_consecutiveFailures > 0) {
      console.log(`Circuit breaker reset (was at ${_consecutiveFailures} failures)`);
    }
    _consecutiveFailures = 0;
  }
}

/**
 * Check if the circuit breaker allows execution.
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkCircuitBreaker() {
  if (!_circuitOpen) return { allowed: true };
  return {
    allowed: false,
    reason: `Circuit breaker open: ${_consecutiveFailures} consecutive failures since ${_circuitOpenedAt}. POST /circuit-breaker/reset to re-enable.`
  };
}

// ── Session Manager ──

const crypto = require('node:crypto');

/** @type {Map<string, {sessionId: string, projectDir: string, startedAt: string, lastActivity: string}>} */
const _sessions = new Map();

/**
 * Get or create a session for a project.
 * @param {string} project - Project name (directory under PROJECTS_DIR)
 * @returns {{sessionId: string, projectDir: string, isNew: boolean}}
 */
function getOrCreateSession(project) {
  const projectDir = path.join(PROJECTS_DIR, project);
  const existing = _sessions.get(project);
  if (existing) {
    existing.lastActivity = new Date().toISOString();
    return { sessionId: existing.sessionId, projectDir, isNew: false };
  }
  const sessionId = crypto.randomUUID();
  _sessions.set(project, {
    sessionId,
    projectDir,
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString()
  });
  return { sessionId, projectDir, isNew: true };
}

/**
 * Run Claude Code with session support (--resume for existing sessions).
 * @param {string} project - Project name
 * @param {string} message - Prompt message
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms
 * @returns {Promise<{sessionId: string, isNew: boolean, exitCode: number, stdout: string, stderr: string, durationMs: number}>}
 */
async function runSessionCommand(project, message, options = {}) {
  const { sessionId, projectDir, isNew } = getOrCreateSession(project);
  const timeout = Math.min(options.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const args = ['--print', '--permission-mode', 'bypassPermissions'];
  if (isNew) {
    // New session: set session ID
    args.push('--session-id', sessionId);
  } else {
    // Resume existing session
    args.push('--resume', sessionId);
  }
  args.push(message);

  const result = await runCommand(CLAUDE_BIN, args, { cwd: projectDir, timeout });

  // Update last activity
  const session = _sessions.get(project);
  if (session) session.lastActivity = new Date().toISOString();

  return {
    sessionId,
    isNew,
    ...result
  };
}

/**
 * End a session for a project.
 * @param {string} project - Project name
 * @returns {{sessionId: string|null, removed: boolean}}
 */
function endSession(project) {
  const session = _sessions.get(project);
  if (!session) return { sessionId: null, removed: false };
  _sessions.delete(project);
  return { sessionId: session.sessionId, removed: true };
}

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
const BRIDGE_DIR = path.join(HOME, 'builder-bridge');

function isAllowedDir(dir) {
  const resolved = path.resolve(dir);
  return resolved.startsWith(PROJECTS_DIR) || resolved.startsWith(PRAWDUCT_DIR) || resolved.startsWith(BRIDGE_DIR);
}

/**
 * Run a command as a child process and collect output.
 * @param {string} cmd - Command binary
 * @param {string[]} args - Arguments
 * @param {object} options
 * @param {string} [options.cwd] - Working directory
 * @param {number} [options.timeout] - Timeout in ms
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, durationMs: number}>}
 */
function runCommand(cmd, args, options = {}) {
  const cwd = options.cwd || PROJECTS_DIR;
  const timeout = Math.min(options.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

  return new Promise((resolve) => {
    const start = Date.now();
    const stdout = [];
    const stderr = [];

    const child = spawn(cmd, args, {
      cwd,
      timeout,
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}` }
    });

    child.stdout.on('data', d => stdout.push(d));
    child.stderr.on('data', d => stderr.push(d));

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        durationMs: Date.now() - start
      });
    });

    child.on('error', (err) => {
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
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
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
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
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

    // GET /health
    if (method === 'GET' && pathname === '/health') {
      const claudeExists = fs.existsSync(CLAUDE_BIN);
      const prawductExists = fs.existsSync(PRAWDUCT_SETUP);
      const claudeVersion = claudeExists
        ? (await runCommand(CLAUDE_BIN, ['--version'], { timeout: 5000 })).stdout.trim()
        : 'not found';

      return json(res, 200, {
        ok: true,
        claude: claudeVersion,
        prawduct: prawductExists ? 'available' : 'not found',
        projectsDir: PROJECTS_DIR,
        circuitBreaker: { open: _circuitOpen, failures: _consecutiveFailures, threshold: CIRCUIT_BREAKER_THRESHOLD },
        activeSessions: _sessions.size,
        v2ActiveSessions: v2SessionManager.activeCount
      });
    }

    // POST /circuit-breaker/reset — manually reset the circuit breaker
    if (method === 'POST' && pathname === '/circuit-breaker/reset') {
      const was = { open: _circuitOpen, failures: _consecutiveFailures, openedAt: _circuitOpenedAt };
      _circuitOpen = false;
      _consecutiveFailures = 0;
      _circuitOpenedAt = null;
      console.log('Circuit breaker manually reset');
      return json(res, 200, { ok: true, previous: was });
    }

    // GET /circuit-breaker — check circuit breaker status
    if (method === 'GET' && pathname === '/circuit-breaker') {
      return json(res, 200, {
        open: _circuitOpen,
        consecutiveFailures: _consecutiveFailures,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        openedAt: _circuitOpenedAt
      });
    }

    // POST /session/send — send a message to a persistent session
    if (method === 'POST' && pathname === '/session/send') {
      const body = await parseBody(req);
      if (!body.project || !body.message) {
        return json(res, 400, { error: 'project and message are required' });
      }

      // Validate project is under allowed dir
      const projectDir = path.join(PROJECTS_DIR, body.project);
      if (!isAllowedDir(projectDir)) {
        return json(res, 403, { error: `project must be under ${PROJECTS_DIR}` });
      }

      // Circuit breaker check
      const cb = checkCircuitBreaker();
      if (!cb.allowed) {
        return json(res, 503, { error: cb.reason });
      }

      const result = await runSessionCommand(body.project, body.message, {
        timeout: body.timeout
      });

      recordBuildResult(result.exitCode);
      return json(res, 200, result);
    }

    // POST /session/end — end a session (optionally send a final wrap-up message first)
    if (method === 'POST' && pathname === '/session/end') {
      const body = await parseBody(req);
      if (!body.project) {
        return json(res, 400, { error: 'project is required' });
      }

      const session = _sessions.get(body.project);
      if (!session) {
        return json(res, 404, { error: `No active session for project '${body.project}'` });
      }

      // Optionally send a final wrap-up message before ending
      const wrapUpMessage = body.message || 'Session is ending. Complete any pending reflection, critic review, or governance tasks now. Write a session handoff to .prawduct/.session-handoff.md summarizing what was done and what remains.';

      const result = await runSessionCommand(body.project, wrapUpMessage, {
        timeout: body.timeout || DEFAULT_TIMEOUT
      });

      // Remove the session
      const ended = endSession(body.project);

      return json(res, 200, {
        ...result,
        sessionEnded: true,
        previousSessionId: ended.sessionId
      });
    }

    // GET /session/status — check session status for a project
    if (method === 'GET' && pathname === '/session/status') {
      const project = url.searchParams.get('project');
      if (!project) {
        return json(res, 400, { error: 'project query parameter is required' });
      }
      const session = _sessions.get(project);
      if (!session) {
        return json(res, 200, { project, active: false });
      }
      return json(res, 200, {
        project,
        active: true,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        lastActivity: session.lastActivity
      });
    }

    // GET /sessions — list all active sessions
    if (method === 'GET' && pathname === '/sessions') {
      const sessions = [];
      for (const [project, session] of _sessions) {
        sessions.push({
          project,
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity
        });
      }
      return json(res, 200, { sessions });
    }

    // POST /claude/run — legacy fire-and-forget (kept for simple one-shot tasks)
    if (method === 'POST' && pathname === '/claude/run') {
      const body = await parseBody(req);
      if (!body.prompt) {
        return json(res, 400, { error: 'prompt is required' });
      }

      // Circuit breaker check
      const cb = checkCircuitBreaker();
      if (!cb.allowed) {
        return json(res, 503, { error: cb.reason });
      }

      const workDir = body.workDir || PROJECTS_DIR;
      if (!isAllowedDir(workDir)) {
        return json(res, 403, { error: `workDir must be under ${PROJECTS_DIR} or ${PRAWDUCT_DIR}` });
      }

      // Ensure workDir exists
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
      }

      // Default: --print for output, --dangerously-skip-permissions for autonomous writes
      const args = ['--print', '--dangerously-skip-permissions'];
      if (body.flags && Array.isArray(body.flags)) {
        // Only allow safe flags
        const allowedFlags = ['--print', '--dangerously-skip-permissions', '--model', '--max-turns', '--verbose'];
        for (const flag of body.flags) {
          if (allowedFlags.some(f => flag.startsWith(f))) {
            if (!args.includes(flag)) args.push(flag);
          }
        }
      }
      args.push(body.prompt);

      const result = await runCommand(CLAUDE_BIN, args, {
        cwd: workDir,
        timeout: body.timeout || DEFAULT_TIMEOUT
      });

      recordBuildResult(result.exitCode);
      return json(res, 200, result);
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

      const args = [PRAWDUCT_SETUP, body.command];
      if (body.args && Array.isArray(body.args)) {
        args.push(...body.args);
      }

      const workDir = body.workDir || PROJECTS_DIR;
      if (!isAllowedDir(workDir)) {
        return json(res, 403, { error: `workDir must be under ${PROJECTS_DIR} or ${PRAWDUCT_DIR}` });
      }

      const result = await runCommand(PYTHON_BIN, args, {
        cwd: workDir,
        timeout: body.timeout || 120000
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

    // 404
    return json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('Request error:', err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Builder bridge listening on 0.0.0.0:${PORT}`);
  console.log(`  Claude: ${CLAUDE_BIN}`);
  console.log(`  Prawduct: ${PRAWDUCT_SETUP}`);
  console.log(`  Projects: ${PROJECTS_DIR}`);
  console.log(`  Auth: ${TOKEN ? 'Bearer token required' : 'OPEN (no token set)'}`);
  console.log(`  v2 PTY broker: enabled`);
});

// ── Cleanup on shutdown ──

/**
 * Destroy all v2 PTY sessions on process exit to prevent orphaned processes.
 */
function shutdown() {
  console.log('Shutting down — destroying v2 sessions...');
  v2SessionManager.destroyAll();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
