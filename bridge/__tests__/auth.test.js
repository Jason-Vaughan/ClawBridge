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
import os from 'node:os';
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

describe('no documented install path can route around the guard', () => {
  // README Quickstart step 2 says `cp bridge/.env.example bridge/.env`, and the
  // README also prints an env block to paste. BOTH are documented install paths,
  // and the guard only checks that a token is PRESENT — so any sample that
  // yields a non-empty value hands the reader a running bridge on a credential
  // published in this repo.
  //
  // This has now happened twice: `.env.example` shipped `BRIDGE_TOKEN=changeme`,
  // and the fix for that introduced a README block with an INLINE comment, which
  // the loader (bridge/server.js — only skips lines *starting* with #) parses as
  // the value. Hence one test over every documented sample rather than one test
  // per file: the next sample is covered before it is written.

  /**
   * Parse env-file text the way bridge/server.js parses .env — including its
   * inline-comment behavior, which is the whole point.
   * @param {string} text
   * @returns {Record<string,string>}
   */
  function parseEnv(text) {
    /** @type {Record<string,string>} */
    const out = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
  }

  /**
   * Every env sample a reader could copy: the shipped template, plus every
   * ```env fenced block in the README.
   * @returns {Array<{ source: string, vars: Record<string,string> }>}
   */
  function documentedSamples() {
    const root = path.join(__dirname, '..', '..');
    const samples = [{
      source: 'bridge/.env.example',
      vars: parseEnv(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')),
    }];
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    let i = 0;
    for (const m of readme.matchAll(/```env\n([\s\S]*?)```/g)) {
      samples.push({ source: `README.md env block #${++i}`, vars: parseEnv(m[1]) });
    }
    return samples;
  }

  const samples = documentedSamples();

  it('finds the samples it claims to check', () => {
    // Guards the guard: if the fence syntax or filename changes, the loop below
    // would silently check nothing and stay green.
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.some(s => s.source.startsWith('README'))).toBe(true);
  });

  it.each(samples.map(s => [s.source, s.vars]))(
    '%s yields no usable BRIDGE_TOKEN',
    (_source, vars) => {
      expect((vars.BRIDGE_TOKEN || '').trim()).toBe('');
    },
  );

  it.each(samples.map(s => [s.source, s.vars]))(
    'a bridge configured from %s refuses to start',
    async (_source, vars) => {
      const bridge = await spawnBridge({
        token: vars.BRIDGE_TOKEN || '',
        extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: vars.CLAUDE_CODE_OAUTH_TOKEN || '' },
      });
      const code = await bridge.waitForExit();
      expect(code).not.toBe(0);
      expect(bridge.getOutput().stdout).not.toContain('ClawBridge listening');
    },
  );

  it('tells the operator how to generate one', async () => {
    // The FATAL block is read by whoever the install stopped — often not the
    // person who wrote the config. "Set BRIDGE_TOKEN" without a command sends
    // them looking for a token to be issued, which is the other variable.
    const bridge = await spawnBridge({ token: '' });
    await bridge.waitForExit();

    const { stdout, stderr } = bridge.getOutput();
    expect(stdout + stderr).toMatch(/openssl rand|head -c|uuidgen/);
  });
});

/**
 * Issue a request with full control over method, headers and body.
 *
 * `httpGet` above fixes the method and sends only Authorization; the origin gate
 * is only observable by varying Origin, method and Content-Type together.
 *
 * @param {number} port
 * @param {object} options
 * @param {string} options.path
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @returns {Promise<{ status: number, headers: Record<string,any>, body: any }>}
 */
function httpSend(port, { path: urlPath, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* leave raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const HOSTILE_ORIGIN = 'https://evil.example';

describe('the origin gate on an unauthenticated bridge', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  /**
   * A projects dir holding one real file, so the consume-on-read route has
   * something to destroy.
   * @returns {{ projectsDir: string, filePath: string }}
   */
  function makeProjectsDir() {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-origin-'));
    tempDirs.push(projectsDir);
    const projectDir = path.join(projectsDir, 'demo');
    fs.mkdirSync(projectDir);
    const filePath = path.join(projectDir, 'target.txt');
    fs.writeFileSync(filePath, 'bytes that must survive a refused request');
    return { projectsDir, filePath };
  }

  /**
   * @param {object} [extraEnv]
   * @returns {Promise<{ port: number }>}
   */
  async function openBridge(extraEnv = {}) {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true', ...extraEnv },
    });
    await bridge.waitForListening();
    return bridge;
  }

  it('refuses a POST that never triggers a preflight', async () => {
    // The case a CORS-header-only fix leaves wide open, and therefore the single
    // most important test here. text/plain is CORS-safelisted, so the browser
    // sends this without asking permission first; server.js parses the body
    // regardless of the declared type. If the gate only decorated responses,
    // the session would start and only the reply would be withheld.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/v2/session/start',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Origin': HOSTILE_ORIGIN },
      body: JSON.stringify({ project: 'demo' }),
    });

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a destructive GET before it can delete the file', async () => {
    // GET /v2/session/file?consume=true unlinks what it returns, and a bare
    // cross-origin GET needs no preflight and no custom header at all. Asserting
    // only the status would pass against a gate that ran after the unlink, so
    // the surviving file is the actual assertion.
    const { projectsDir, filePath } = makeProjectsDir();
    const bridge = await openBridge({ PROJECTS_DIR: projectsDir });

    const res = await httpSend(bridge.port, {
      path: '/v2/session/file?project=demo&path=target.txt&consume=true',
      headers: { 'Origin': HOSTILE_ORIGIN },
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('refuses a no-cors GET that carries no Origin at all', async () => {
    // The gap an Origin-only gate leaves, and the easiest attack of the lot.
    // Browsers append Origin only when the request mode is CORS or the method is
    // not GET/HEAD, so <img src="…?consume=true">, <script src>, <iframe> and a
    // top-level navigation all arrive without one. Sec-Fetch-Site is what makes
    // them visible. The earlier test passes only because it sets Origin by hand
    // — which fetch() does and an <img> tag never does.
    const { projectsDir, filePath } = makeProjectsDir();
    const bridge = await openBridge({ PROJECTS_DIR: projectsDir });

    const res = await httpSend(bridge.port, {
      path: '/v2/session/file?project=demo&path=target.txt&consume=true',
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('lets an allowed Origin win over a same-site metadata report', async () => {
    // A fetch() from a dev UI on http://localhost:5173 to this bridge on another
    // loopback port sends BOTH headers, and reports Sec-Fetch-Site: same-site,
    // because ports do not make a different site. Origin has to decide, or the
    // metadata check would refuse the deployment the loopback allowance exists
    // to serve.
    //
    // Note what this does NOT cover: a genuine no-cors same-site load (an <img>
    // from that same dev UI) sends no Origin and IS refused. That is deliberate
    // — the bridge binds 0.0.0.0, so "same site" can include a subdomain an
    // attacker controls, and a UI that needs data can use fetch(). Naming this
    // test for the no-cors case would have claimed coverage it does not have.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' },
    });

    expect(res.status).toBe(200);
  });

  it('refuses a same-site no-cors load, since a shared site can include a subdomain we do not control', async () => {
    // The behavior the test above deliberately does not cover, pinned so the
    // trade-off is visible rather than discovered later by an operator.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Sec-Fetch-Site': 'same-site' },
    });

    expect(res.status).toBe(403);
  });

  it('allows a user-initiated navigation, which reports Sec-Fetch-Site: none', async () => {
    // Typing the URL or opening a bookmark. Refusing this would make the bridge
    // unbrowsable on the host that runs it.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Sec-Fetch-Site': 'none' },
    });

    expect(res.status).toBe(200);
  });

  it('sets Vary on every tokenless response, not just the one that echoes an origin', async () => {
    // The header carries a stated security rationale, so it needs assertions;
    // otherwise a later edit drops it and the suite stays green. All three
    // response shapes are checked, because the regression this guards against is
    // precisely Vary being set on the echo path alone — an intermediary could
    // then serve one origin's 403 to another. Asserting only the 200 would leave
    // that reintroducible without a red test.
    const bridge = await openBridge();

    const shapes = [
      ['echoes an allowed origin', { 'Origin': 'http://localhost:5173' }],
      ['refuses a disallowed origin', { 'Origin': HOSTILE_ORIGIN }],
      ['carries no origin at all', {}],
    ];
    expect(shapes.length).toBeGreaterThan(0);

    for (const [label, headers] of shapes) {
      const res = await httpSend(bridge.port, { path: '/health', headers });
      expect(res.headers['vary'], `Vary missing when the response ${label}`).toBeDefined();
      expect(res.headers['vary']).toContain('Origin');
      expect(res.headers['vary']).toContain('Sec-Fetch-Site');
    }
  });

  it.each([
    ['http://127.0.0.1:9000'],
    ['http://[::1]:9000'],
    ['https://localhost:9000'],
  ])('allows the documented loopback spelling %s', async (allowedOrigin) => {
    // Each spelling is named as a default in the security model and about to be
    // published on /health; naming one and testing another is how a record and
    // its code drift apart.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': allowedOrigin },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
  });

  it('lets the consuming request through when no browser is involved, so the guard above means something', async () => {
    // The falsification partner of the previous test. Without it, a gate that
    // refused everything unconditionally would look identical.
    //
    // POST rather than GET since 2.0.0: consuming moved off GET because a safe
    // method must not delete (security-model G7). The claim under test is
    // unchanged — a caller sending no Origin reaches the handler and the
    // side effect happens — only the method carrying it moved.
    const { projectsDir, filePath } = makeProjectsDir();
    const bridge = await openBridge({ PROJECTS_DIR: projectsDir });

    const res = await httpSend(bridge.port, {
      method: 'POST',
      path: '/v2/session/file?project=demo&path=target.txt&consume=true',
    });

    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('fails the preflight for a refused origin', async () => {
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/v2/session/start',
      method: 'OPTIONS',
      headers: { 'Origin': HOSTILE_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves every route reachable for callers that send no Origin', async () => {
    // Containers, curl and the packaged client send no Origin header, and the
    // gate keys on its presence — so this is the compatibility claim the change
    // rests on. Enumerated rather than sampled: "the route I happened to think
    // of still works" is how a too-narrow check ships green.
    const { projectsDir } = makeProjectsDir();
    const bridge = await openBridge({ PROJECTS_DIR: projectsDir });

    const routes = ['/health', '/exports', '/projects', '/v2/sessions', '/v2/api-docs'];
    expect(routes.length).toBeGreaterThan(0); // a filtered-empty list must not pass vacuously

    for (const route of routes) {
      const res = await httpSend(bridge.port, { path: route });
      expect(res.status, `${route} must be unaffected by the origin gate`).toBe(200);
    }
  });

  it('allows a loopback origin, since a page cannot hold one without local execution', async () => {
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'http://localhost:5173' },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not mistake a loopback-prefixed hostname for loopback', async () => {
    // http://127.0.0.1.evil.example is a remote origin that a prefix match or a
    // startsWith would wave through.
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'http://127.0.0.1.evil.example' },
    });

    expect(res.status).toBe(403);
  });

  it('refuses the literal null origin a sandboxed iframe sends', async () => {
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'null' },
    });

    expect(res.status).toBe(403);
  });

  it('admits an origin named in CLAWBRIDGE_ALLOWED_ORIGINS', async () => {
    const bridge = await openBridge({ CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example, https://other.example' });
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'https://ui.example' },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://ui.example');
  });

  it('does not widen anything when CLAWBRIDGE_ALLOWED_ORIGINS is absent', async () => {
    // Absent configuration must never widen authority — this product shipped the
    // opposite once, when an unset BRIDGE_TOKEN resolved to "no auth required".
    const bridge = await openBridge();
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'https://ui.example' },
    });

    expect(res.status).toBe(403);
  });
});

describe('/health reports the CORS posture, so the gate cannot regress unobserved', () => {
  /** @type {string[]} */
  const tempDirs = [];
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('declares the gate and the loopback default when running open', async () => {
    // Nobody reads stdout on a launchd service at 3am. A security control that
    // is only observable by shell access to the host is one nobody checks.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: { CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true' },
    });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, { path: '/health' });

    expect(res.status).toBe(200);
    expect(res.body.cors.mode).toBe('gated');
    expect(res.body.cors.loopbackAllowed).toBe(true);
    expect(res.body.cors.additionalOrigins).toEqual([]);
  });

  it('names a widened allowlist, which is the part an operator will not remember', async () => {
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example,https://other.example',
      },
    });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, { path: '/health' });

    expect(res.body.cors.mode).toBe('gated');
    expect(res.body.cors.additionalOrigins).toEqual(['https://ui.example', 'https://other.example']);
  });

  it('distinguishes wildcard from gated rather than omitting the key', async () => {
    // "The key is absent" and "the key says wildcard" are different facts, and
    // only one of them answers an operator asking whether this bridge is gated.
    const bridge = await spawnBridge({ token: TEST_TOKEN });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Authorization': `Bearer ${TEST_TOKEN}` },
    });

    expect(res.body.cors.mode).toBe('wildcard');
  });

  it('does not present an inert allowlist entry as though it were active', async () => {
    // /health is the surface a remote operator can actually reach, so listing a
    // configured-but-unmatchable origin under additionalOrigins would answer
    // their question with the opposite of the truth. The valid sibling proves
    // the split is a split and not a blanket rejection.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example/,https://good.example',
      },
    });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, { path: '/health' });

    expect(res.body.cors.additionalOrigins).toEqual(['https://good.example']);
    expect(res.body.cors.invalidOrigins).toEqual(['https://ui.example/']);
    expect(res.body.cors.warning).toContain('never match');
  });

  it('does not honour an allowlist entry it reports as inert', async () => {
    // `null` is the case that makes this more than bookkeeping: it fails to
    // parse as a URL, so it is classified malformed and /health tells the
    // operator it can never match — but it IS a real Origin header value, sent
    // by sandboxed iframes and file:// pages. Matching it against the raw set
    // would have the gate admitting exactly what its own health report calls
    // inert. The trailing-slash case cannot catch this: no browser can send it.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'null',
      },
    });
    await bridge.waitForListening();

    const health = await httpSend(bridge.port, { path: '/health' });
    expect(health.body.cors.invalidOrigins).toEqual(['null']);
    expect(health.body.cors.additionalOrigins).toEqual([]);

    // ...and the gate must agree with that report.
    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'null' },
    });
    expect(res.status).toBe(403);
  });

  it('logs a refusal, naming the origin actually presented', async () => {
    // A well-formed but wrong entry — right host, wrong port — raises no boot
    // warning and shows on /health as active, so the log line is the only place
    // the operator can see which origin was really turned away.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example:8443',
      },
    });
    await bridge.waitForListening();

    await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'https://ui.example:9999' },
    });
    await bridge.waitForOutput('[bridge] 403');

    const { stdout, stderr } = bridge.getOutput();
    expect(stdout + stderr).toContain('origin=https://ui.example:9999');
  });

  it('refuses an origin that was configured in an unmatchable spelling', async () => {
    // The report and the behavior have to agree: /health says it never matches,
    // so a request from the spelling the operator *meant* must still be refused.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example/',
      },
    });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': 'https://ui.example' },
    });

    expect(res.status).toBe(403);
  });

  it('warns at boot about an allowlist entry that can never match', async () => {
    // Failing closed on a typo is right, but silently is not: the operator sees
    // a refused browser and no reason. A trailing slash is the likely typo,
    // because it is what a human copies out of a URL bar.
    const bridge = await spawnBridge({
      token: '',
      extraEnv: {
        CLAWBRIDGE_ALLOW_UNAUTHENTICATED: 'true',
        CLAWBRIDGE_ALLOWED_ORIGINS: 'https://ui.example/',
      },
    });
    await bridge.waitForListening();
    await bridge.waitForOutput('will never match');

    const { stdout, stderr } = bridge.getOutput();
    expect(stdout + stderr).toContain('https://ui.example/');
    expect(stdout + stderr).toContain('did you mean https://ui.example');
  });
});

describe('the origin gate stays out of the way when a token is set', () => {
  it('keeps the wildcard and the pre-existing behavior for a token-holding caller', async () => {
    // The compatibility half of the scope decision: the gate exists because an
    // unauthenticated bridge has no other defense. With a token, a cross-origin
    // page holds no credential and cannot attach Authorization without tripping
    // a preflight, so nothing here needed to change — and changing it would
    // have broken container callers for no security gain.
    const bridge = await spawnBridge({ token: TEST_TOKEN });
    await bridge.waitForListening();

    const res = await httpSend(bridge.port, {
      path: '/health',
      headers: { 'Origin': HOSTILE_ORIGIN, 'Authorization': `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
