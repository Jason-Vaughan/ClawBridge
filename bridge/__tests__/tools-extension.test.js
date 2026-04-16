/**
 * End-to-end tests for the CLAWBRIDGE_TOOLS_MODULE extension point.
 *
 * Spawns real bridge subprocesses configured against
 * fixtures/mock-tools-extension.js and verifies:
 *   - /tools/* dispatch and prefix matching (exact /tools and /tools/*)
 *   - /health merge semantics (success, throw → substituted, extension absent → omitted)
 *   - graceful-degradation when the loader, the path, or init() fail
 *   - error paths in handleToolsRoute (500), getToolsHealth (substituted), close (logged)
 *   - close() invoked exactly once during SIGTERM, even under repeated signals
 *   - init() awaited before the listen socket accepts connections
 *   - decline (false) returning the bridge's canonical 404 body
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MOCK_PATH = path.join(__dirname, 'fixtures', 'mock-tools-extension.js');
const TEST_TOKEN = 'test-tools-ext-token';

/**
 * Ask the kernel for a free ephemeral port and release it. Racier than
 * pre-allocating via SO_REUSEPORT, but good enough for vitest parallel runs.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn a bridge subprocess. Does NOT wait for the listening message —
 * returns the handles and the caller decides when to wait.
 * @param {object} [options]
 * @param {string|null} [options.extensionPath] — path to set as CLAWBRIDGE_TOOLS_MODULE (null to unset).
 * @param {object} [options.extraEnv] — additional env vars.
 * @param {number} [options.port] — override port; defaults to a free one.
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number, getOutput: () => { stdout: string, stderr: string }, waitForListening: (timeoutMs?: number) => Promise<void> }>}
 */
async function spawnBridge(options = {}) {
  const extensionPath = options.extensionPath === undefined ? MOCK_PATH : options.extensionPath;
  const extraEnv = options.extraEnv || {};
  const port = options.port || (await getFreePort());

  const env = {
    BRIDGE_PORT: String(port),
    BRIDGE_TOKEN: TEST_TOKEN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    ...extraEnv,
  };
  if (extensionPath !== null) {
    env.CLAWBRIDGE_TOOLS_MODULE = extensionPath;
  }

  const proc = spawn('node', [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  /**
   * @param {number} [timeoutMs]
   */
  function waitForListening(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Bridge did not start within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, timeoutMs);
      const interval = setInterval(() => {
        if (stdout.includes('ClawBridge listening')) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 25);
      proc.on('exit', (code) => {
        clearInterval(interval);
        clearTimeout(timeout);
        if (!stdout.includes('ClawBridge listening')) {
          reject(new Error(`Bridge exited before listening (code=${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
        }
      });
    });
  }

  return { proc, port, getOutput: () => ({ stdout, stderr }), waitForListening };
}

/**
 * Convenience: spawn and wait for the listening message.
 * @param {Parameters<typeof spawnBridge>[0]} [options]
 * @returns {Promise<Awaited<ReturnType<typeof spawnBridge>>>}
 */
async function startBridge(options) {
  const bridge = await spawnBridge(options);
  await bridge.waitForListening();
  return bridge;
}

/**
 * @param {number} port
 * @param {string} urlPath
 * @param {string|null} [token]
 * @returns {Promise<{ status: number, body: any }>}
 */
function httpGet(port, urlPath, token = TEST_TOKEN) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Attempt a single TCP connect on the given port. Resolves to the error
 * code on failure (e.g. 'ECONNREFUSED'), or 'connected' on success.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function tryTcpConnect(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const finish = (result) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.once('connect', () => finish('connected'));
    sock.once('error', (err) => finish(err.code || 'error'));
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/**
 * Send SIGTERM and await exit (or SIGKILL after 4s). Captures exit metadata.
 * @param {import('node:child_process').ChildProcess} proc
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null }>}
 */
function stopBridge(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) {
      return resolve({ code: proc.exitCode, signal: proc.signalCode });
    }
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && !proc.signalCode) proc.kill('SIGKILL');
    }, 4000);
  });
}

describe('CLAWBRIDGE_TOOLS_MODULE extension point', () => {
  /** @type {Awaited<ReturnType<typeof spawnBridge>> | null} */
  let bridge = null;
  /** @type {string} */
  let logFile = '';

  afterEach(async () => {
    if (bridge) {
      await stopBridge(bridge.proc);
      bridge = null;
    }
    if (logFile) {
      try { fs.unlinkSync(logFile); } catch { /* may not exist */ }
      logFile = '';
    }
  });

  /** @returns {string} */
  function freshLogFile() {
    return path.join(os.tmpdir(), `clawbridge-mock-tools-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
  }

  describe('extension loaded and healthy', () => {
    it('dispatches /tools/* requests to the extension', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/tools/ping');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mock: true, pathname: '/tools/ping', method: 'GET' });
    });

    it('dispatches exact /tools path (no trailing slash) to the extension', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/tools');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mock: true, pathname: '/tools' });
    });

    it('merges getToolsHealth() under the tools key of /health', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/health', null);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tools).toEqual({ ok: true, mock: true, initialized: true });
    });

    it('enforces bridge-level auth before handoff', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/tools/ping', null);
      expect(res.status).toBe(401);
    });

    it('returns the bridge canonical 404 when the extension declines (returns false)', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/tools/decline');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('does not route non-/tools paths through the extension', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      const res = await httpGet(bridge.port, '/projects');
      expect(res.status).toBe(200);
      expect(res.body.projects).toBeDefined();
    });

    it('does not accept connections before init() resolves', async () => {
      logFile = freshLogFile();
      const port = await getFreePort();
      bridge = await spawnBridge({
        port,
        extraEnv: { MOCK_TOOLS_LOG: logFile, MOCK_TOOLS_INIT_DELAY_MS: '800' },
      });
      // Wait until the mock confirms init-delay began, so the bridge subprocess is certainly past module load.
      const waitForDelayRecord = Date.now();
      while (!fs.existsSync(logFile) || !fs.readFileSync(logFile, 'utf8').includes('init-delay:')) {
        if (Date.now() - waitForDelayRecord > 4000) throw new Error('mock init-delay marker never appeared');
        await new Promise(r => setTimeout(r, 25));
      }
      const earlyResult = await tryTcpConnect(port, 200);
      expect(earlyResult).toBe('ECONNREFUSED');

      await bridge.waitForListening(5000);
      const res = await httpGet(port, '/tools/ping');
      expect(res.status).toBe(200);
    });

    it('invokes close() exactly once during SIGTERM', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      await stopBridge(bridge.proc);
      bridge = null;
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toMatch(/^init-ok$/m);
      expect(log).toMatch(/^close$/m);
      const closeCount = (log.match(/^close$/gm) || []).length;
      expect(closeCount).toBe(1);
      expect(log.indexOf('close')).toBeGreaterThan(log.indexOf('init-ok'));
    });

    it('invokes close() exactly once when SIGTERM and SIGINT both fire', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({ extraEnv: { MOCK_TOOLS_LOG: logFile } });
      bridge.proc.kill('SIGTERM');
      bridge.proc.kill('SIGINT');
      await new Promise((resolve) => {
        bridge.proc.once('exit', resolve);
        setTimeout(() => {
          if (bridge && bridge.proc.exitCode === null) bridge.proc.kill('SIGKILL');
        }, 4000);
      });
      bridge = null;
      const log = fs.readFileSync(logFile, 'utf8');
      const closeCount = (log.match(/^close$/gm) || []).length;
      expect(closeCount).toBe(1);
    });
  });

  describe('extension error paths', () => {
    it('returns 500 when handleToolsRoute rejects', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({
        extraEnv: { MOCK_TOOLS_LOG: logFile, MOCK_TOOLS_ROUTE_THROW: '1' },
      });
      const res = await httpGet(bridge.port, '/tools/ping');
      expect(res.status).toBe(500);
    });

    it('substitutes { ok:false, error } when getToolsHealth rejects — root ok stays true', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({
        extraEnv: { MOCK_TOOLS_LOG: logFile, MOCK_TOOLS_HEALTH_THROW: '1' },
      });
      const res = await httpGet(bridge.port, '/health', null);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tools.ok).toBe(false);
      expect(res.body.tools.error).toMatch(/mock health failure/);
    });

    it('does not crash or hang the bridge when close() rejects', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({
        extraEnv: { MOCK_TOOLS_LOG: logFile, MOCK_TOOLS_CLOSE_THROW: '1' },
      });
      const start = Date.now();
      const { signal } = await stopBridge(bridge.proc);
      const elapsed = Date.now() - start;
      bridge = null;
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toMatch(/^close$/m);
      expect(signal).not.toBe('SIGKILL');
      expect(elapsed).toBeLessThan(3500);
    });
  });

  describe('graceful degradation', () => {
    it('init() rejection → bridge starts, /tools/* → 404, /health omits tools', async () => {
      logFile = freshLogFile();
      bridge = await startBridge({
        extraEnv: { MOCK_TOOLS_LOG: logFile, MOCK_TOOLS_INIT_THROW: '1' },
      });
      const toolsRes = await httpGet(bridge.port, '/tools/ping');
      expect(toolsRes.status).toBe(404);
      const healthRes = await httpGet(bridge.port, '/health', null);
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.ok).toBe(true);
      expect(healthRes.body.tools).toBeUndefined();
      expect(bridge.getOutput().stderr + bridge.getOutput().stdout).toMatch(/init\(\) failed/);
    });

    it('CLAWBRIDGE_TOOLS_MODULE unset → bridge runs as pure broker', async () => {
      bridge = await startBridge({ extensionPath: null });
      const toolsRes = await httpGet(bridge.port, '/tools/ping');
      expect(toolsRes.status).toBe(404);
      const healthRes = await httpGet(bridge.port, '/health', null);
      expect(healthRes.body.tools).toBeUndefined();
    });

    it('relative extension path → warning, disabled, pure broker behavior', async () => {
      bridge = await startBridge({ extensionPath: 'relative/path.js' });
      const res = await httpGet(bridge.port, '/tools/ping');
      expect(res.status).toBe(404);
      const output = bridge.getOutput().stdout + bridge.getOutput().stderr;
      expect(output).toMatch(/must be an absolute path/);
    });

    it('non-existent absolute extension path → warning, disabled', async () => {
      const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.js`);
      bridge = await startBridge({ extensionPath: missing });
      const res = await httpGet(bridge.port, '/tools/ping');
      expect(res.status).toBe(404);
      const output = bridge.getOutput().stdout + bridge.getOutput().stderr;
      expect(output).toMatch(/not found/);
    });

    it('extension module throwing at require-time → warning, disabled', async () => {
      const badModule = path.join(os.tmpdir(), `throw-tools-ext-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`);
      fs.writeFileSync(badModule, "throw new Error('boom at require-time');\n");
      try {
        bridge = await startBridge({ extensionPath: badModule });
        const res = await httpGet(bridge.port, '/tools/ping');
        expect(res.status).toBe(404);
        const output = bridge.getOutput().stdout + bridge.getOutput().stderr;
        expect(output).toMatch(/Failed to load CLAWBRIDGE_TOOLS_MODULE/);
        expect(output).toMatch(/boom at require-time/);
      } finally {
        try { fs.unlinkSync(badModule); } catch { /* ignore */ }
      }
    });

    it.each(['init', 'handleToolsRoute', 'getToolsHealth', 'close'])(
      'extension missing required export "%s" → warning, disabled',
      async (missingExport) => {
        const allFns = {
          init: 'async function () {}',
          handleToolsRoute: 'async function () { return false; }',
          getToolsHealth: 'async function () { return {}; }',
          close: 'async function () {}',
        };
        delete allFns[missingExport];
        const body = `module.exports = { ${Object.entries(allFns).map(([k, v]) => `${k}: ${v}`).join(', ')} };\n`;
        const badModule = path.join(os.tmpdir(), `missing-${missingExport}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`);
        fs.writeFileSync(badModule, body);
        try {
          bridge = await startBridge({ extensionPath: badModule });
          const res = await httpGet(bridge.port, '/tools/ping');
          expect(res.status).toBe(404);
          const output = bridge.getOutput().stdout + bridge.getOutput().stderr;
          expect(output).toMatch(new RegExp(`missing export '${missingExport}'`));
        } finally {
          try { fs.unlinkSync(badModule); } catch { /* ignore */ }
        }
      }
    );
  });
});
