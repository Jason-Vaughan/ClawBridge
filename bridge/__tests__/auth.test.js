/**
 * Regression tests for the authentication boundary.
 *
 * Guards the fix for the fail-open auth path: the bridge used to treat an unset
 * BRIDGE_TOKEN as "no auth required" and serve every route to anyone, on a
 * 0.0.0.0 bind, while /health reported a healthy service. README.md has listed
 * BRIDGE_TOKEN as Required since before the code existed, so the code was the
 * side that disagreed with the contract.
 *
 * Spawns real bridge subprocesses — the behavior under test is startup and
 * request-time auth, neither of which is observable from a unit import.
 *
 * Covers:
 *   - refusal to start unauthenticated, and the actionability of the message
 *   - the explicit opt-in, including that only the exact value enables it
 *   - /health declaring the exposure instead of reporting plain health
 *   - token comparison correctness across equal, wrong, and unequal-length tokens
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const TEST_TOKEN = 'test-auth-token-value';

// server.js loads bridge/.env with `if (!process.env[key])`, which treats an
// explicitly-empty variable as absent and backfills it. So a developer machine
// with a real bridge/.env defining BRIDGE_TOKEN would silently give the
// "tokenless" cases below a token, and they would fail for a reason nobody could
// guess from the assertion. Fail loudly and diagnosably instead of mysteriously.
// The loader's empty-vs-absent conflation is tracked as CFG-3QK7.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  const conflicting = ['BRIDGE_TOKEN', 'CLAWBRIDGE_ALLOW_UNAUTHENTICATED']
    .filter(key => new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(envText));
  if (conflicting.length) {
    throw new Error(
      `${ENV_FILE} defines ${conflicting.join(' and ')}, which bridge/server.js backfills into `
      + "this suite's deliberately-empty environment, making the tokenless cases fail for a "
      + 'reason the assertions cannot show. Move the file aside to run the auth suite. '
      + 'Tracked as CFG-3QK7; noted in the operational spec under Release procedure step 1.',
    );
  }
}

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = [];

afterEach(() => {
  while (spawned.length) {
    const proc = spawned.pop();
    if (proc && !proc.killed) proc.kill('SIGKILL');
  }
});

/**
 * Ask the kernel for a free ephemeral port and release it.
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
 * Spawn a bridge subprocess with a fully controlled environment.
 *
 * BRIDGE_TOKEN is always present as a key, and '' means "no token". Note that
 * server.js's .env loader treats '' as absent and will backfill it from
 * bridge/.env if one exists (CFG-3QK7) — the load-time guard at the top of this
 * file exists precisely because of that, and must not be removed while it holds.
 *
 * @param {object} [options]
 * @param {string} [options.token] — BRIDGE_TOKEN value ('' for none).
 * @param {object} [options.extraEnv] — additional env vars.
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number, getOutput: () => { stdout: string, stderr: string }, waitForListening: (timeoutMs?: number) => Promise<void>, waitForExit: (timeoutMs?: number) => Promise<number|null> }>}
 */
async function spawnBridge(options = {}) {
  const port = await getFreePort();
  const env = {
    BRIDGE_PORT: String(port),
    BRIDGE_TOKEN: options.token === undefined ? TEST_TOKEN : options.token,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    ...(options.extraEnv || {}),
  };

  const proc = spawn('node', [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  /** @param {number} [timeoutMs] */
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

  /** @param {number} [timeoutMs] */
  function waitForExit(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Bridge did not exit within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  }

  /**
   * Wait for a substring to appear in combined output.
   *
   * `waitForListening` resolves on the "ClawBridge listening" line, but the
   * startup banner keeps printing after it — the auth warning is emitted
   * further down the same callback. Asserting on output immediately after
   * waitForListening is therefore a race that passes or fails on scheduling.
   * @param {string} needle
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  function waitForOutput(needle, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = setInterval(() => {
        if ((stdout + stderr).includes(needle)) {
          clearInterval(check);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(check);
          reject(new Error(`Timed out waiting for ${JSON.stringify(needle)}.\nstdout: ${stdout}\nstderr: ${stderr}`));
        }
      }, 25);
    });
  }

  return { proc, port, getOutput: () => ({ stdout, stderr }), waitForListening, waitForExit, waitForOutput };
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
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { /* leave raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startup refuses a fail-open configuration', () => {
  it('exits non-zero when BRIDGE_TOKEN is unset and no opt-in is given', async () => {
    const bridge = await spawnBridge({ token: '' });
    const code = await bridge.waitForExit();

    expect(code).not.toBe(0);
    expect(bridge.getOutput().stdout).not.toContain('ClawBridge listening');
  });

  it('names both the required variable and the escape hatch in the failure message', async () => {
    // An unattended daemon's operator reads this once, at 3am, in a launchd log.
    // A message that says only "misconfigured" costs them the debugging session.
    const bridge = await spawnBridge({ token: '' });
    await bridge.waitForExit();

    const { stdout, stderr } = bridge.getOutput();
    const output = stdout + stderr;
    expect(output).toContain('BRIDGE_TOKEN');
    expect(output).toContain('CLAWBRIDGE_ALLOW_UNAUTHENTICATED');
  });

});

describe('the unauthenticated escape hatch', () => {
  it('starts when CLAWBRIDGE_ALLOW_UNAUTHENTICATED is exactly "true"', async () => {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();
    expect(bridge.getOutput().stdout).toContain('ClawBridge listening');
  });

  it('warns loudly on every boot while the hatch is open', async () => {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();
    await bridge.waitForOutput('UNAUTHENTICATED');

    const { stdout, stderr } = bridge.getOutput();
    expect(stdout + stderr).toContain('UNAUTHENTICATED');
  });

  it.each(['1', 'yes', 'TRUE', 'True', 'on', ' true'])(
    'refuses to start for near-miss opt-in value %j',
    async (value) => {
      // Only the exact value enables it. Accepting every truthy spelling is how
      // a security control gets switched on absent-mindedly.
      const bridge = await spawnBridge({
        token: '',
        extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: value },
      });
      const code = await bridge.waitForExit();
      expect(code).not.toBe(0);
    },
  );

  it('serves protected routes without a token once open — the documented cost', async () => {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/api/processes', null);
    expect(res.status).toBe(200);
  });
});

describe('/health declares the exposure', () => {
  it('reports auth.required true and no insecure flag when a token is set', async () => {
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/health', null);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.auth).toEqual({ required: true });
    expect(res.body.insecure).toBeUndefined();
  });

  it('reports auth.required false, an insecure flag, and a warning when open', async () => {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/health', null);
    expect(res.status).toBe(200);
    expect(res.body.insecure).toBe(true);
    expect(res.body.auth.required).toBe(false);
    expect(typeof res.body.auth.warning).toBe('string');
    expect(res.body.auth.warning.length).toBeGreaterThan(0);
  });

  it('keeps ok true while open — ok means serving, not safe', async () => {
    // Deliberate: the repo already holds this line for the tools extension,
    // whose failure never flips root ok. Flipping it here would also page an
    // operator about a state they explicitly asked for. `insecure` is the
    // alertable signal instead.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/health', null);
    expect(res.body.ok).toBe(true);
  });

  it('stays reachable without a token in the normal, authenticated mode', async () => {
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/health', null);
    expect(res.status).toBe(200);
  });
});

describe('token comparison', () => {
  it('accepts the correct token', async () => {
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/api/processes', TEST_TOKEN);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token of identical length', async () => {
    const wrong = 'x'.repeat(TEST_TOKEN.length);
    expect(wrong.length).toBe(TEST_TOKEN.length);

    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/api/processes', wrong);
    expect(res.status).toBe(401);
  });

  it('rejects a token of different length without throwing', async () => {
    // timingSafeEqual throws on unequal-length buffers. The length guard must
    // return 401 rather than surfacing a 500 — a crash here would be both an
    // availability bug and an oracle.
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/api/processes', 'short');
    expect(res.status).toBe(401);
  });

  it('rejects a missing Authorization header', async () => {
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await httpGet(bridge.port, '/api/processes', null);
    expect(res.status).toBe(401);
  });

  it('rejects a correct token sent without the Bearer scheme', async () => {
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: bridge.port,
        path: '/api/processes',
        method: 'GET',
        headers: { 'Authorization': TEST_TOKEN },
      }, (r) => {
        r.on('data', () => {});
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(401);
  });
});

describe('rejected requests leave a trace, without leaking the credential', () => {
  it('logs method, path and peer on a 401', async () => {
    // stdout is the only operator channel on an unattended daemon, and this
    // binds 0.0.0.0 where every authenticated route can spawn a host shell.
    // Repeated 401s are the probing signal; without this line there is none.
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    await httpGet(bridge.port, '/v2/sessions', 'definitely-the-wrong-token');
    await bridge.waitForOutput('[bridge] 401');

    const { stdout, stderr } = bridge.getOutput();
    const output = stdout + stderr;
    expect(output).toContain('[bridge] 401');
    expect(output).toContain('/v2/sessions');
    expect(output).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  it('never writes the presented credential to the log', async () => {
    // The security property, not a formatting preference: logging the header
    // would move a would-be secret from the wire into a file that outlives the
    // request and is read by whoever tails the service.
    const bridge = await spawnBridge();
    await bridge.waitForListening();

    const presented = 'super-secret-presented-value-9f3a';
    await httpGet(bridge.port, '/v2/sessions', presented);
    await bridge.waitForOutput('[bridge] 401');

    const { stdout, stderr } = bridge.getOutput();
    const output = stdout + stderr;
    expect(output).toContain('[bridge] 401');   // it did log the rejection...
    expect(output).not.toContain(presented);    // ...without the credential
    expect(output).not.toContain(TEST_TOKEN);   // nor the real one
  });
});
