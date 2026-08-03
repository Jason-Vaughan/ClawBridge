/**
 * Tests for the unauthenticated /exports surface.
 *
 * This route had no coverage at all, which is how a crash on its happy path
 * survived: `GET /exports/<file>` referenced an undefined `ext`, and because the
 * handler runs above the auth check and outside the request try/catch, the
 * ReferenceError was an uncaught exception that killed the whole daemon rather
 * than returning 500. Unauthenticated, and self-service — the equally public
 * listing supplies the filename.
 *
 * The first test below is the regression guard: it asserts the process is still
 * alive after a successful download. Asserting only the 200 would not have
 * caught the original defect's worst property.
 *
 * Also pins the containment rules (traversal, absolute paths, NUL, symlink
 * escape) that were already correct, so a future change to this handler cannot
 * quietly relax them.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const TEST_TOKEN = 'test-exports-token';

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = [];
/** @type {string[]} */
const tmpDirs = [];

/**
 * Real path under the user's home rather than os.tmpdir(): on macOS /var is a
 * symlink to /private/var, so an EXPORTS_DIR under tmp trips the handler's own
 * symlink-escape guard and every request 403s — which looks exactly like the
 * containment tests passing for the wrong reason.
 * @returns {string}
 */
function makeExportsDir() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.clawbridge-exports-test-'));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

afterEach(() => {
  while (spawned.length) {
    const proc = spawned.pop();
    if (proc && !proc.killed) proc.kill('SIGKILL');
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

/** @returns {Promise<number>} */
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
 * @param {string} exportsDir
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number }>}
 */
async function startBridge(exportsDir) {
  const port = await getFreePort();
  const proc = spawn('node', [SERVER_PATH], {
    env: {
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: TEST_TOKEN,
      EXPORTS_DIR: exportsDir,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(proc);

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Bridge did not start.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 8000);
    const interval = setInterval(() => {
      if (stdout.includes('ClawBridge listening')) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 25);
  });

  return { proc, port };
}

/**
 * @param {number} port
 * @param {string} urlPath
 * @returns {Promise<{ status: number, body: string }>}
 */
function rawGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /exports/* — the download path', () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'report.txt'), 'hello export');
  });

  it('serves the file body', async () => {
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/report.txt');

    expect(res.status).toBe(200);
    expect(res.body).toBe('hello export');
  });

  it('leaves the process alive after a successful download', async () => {
    // The regression guard. The original defect threw an uncaught
    // ReferenceError here and terminated the daemon, taking every live PTY
    // session with it — a 200 assertion alone would not have caught it.
    const { proc, port } = await startBridge(dir);

    await rawGet(port, '/exports/report.txt');
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();

    // Still serving, not merely un-exited.
    const second = await rawGet(port, '/exports/report.txt');
    expect(second.status).toBe(200);
  });

  it('needs no bearer token — this route is public by design', async () => {
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/report.txt');
    expect(res.status).toBe(200);
  });

  it('404s a file that is not there', async () => {
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/nope.txt');
    expect(res.status).toBe(404);
  });
});

describe('GET /exports — the listing', () => {
  it('lists filenames without a token', async () => {
    const dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'b.md'), 'b');

    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports');

    expect(res.status).toBe(200);
    const names = JSON.parse(res.body).exports.map(e => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.md']);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const dir = makeExportsDir();
    fs.rmSync(dir, { recursive: true, force: true });

    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).exports).toEqual([]);
  });
});

// Root bypasses file permission bits, so the three tests below would invert:
// the "unreadable" file reads fine and the assertions fail for a reason that has
// nothing to do with the guard. No CI runs today (TST-RYHK), but containers
// commonly run as root, so skip rather than emit a confusing failure.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const itUnlessRoot = asRoot ? it.skip : it;

describe('filesystem errors must not kill the daemon', () => {
  // Historically these throws killed the daemon: the handlers run before the
  // auth check, and at the time nothing wrapped the callback. The wrapper added
  // later (see the sibling block below) is what closes that class. These tests
  // pin the narrower guarantee that survives it — a filesystem error yields a
  // route-specific 500 and the process keeps serving.

  itUnlessRoot('returns 500 and keeps serving when a file cannot be read', async () => {
    const dir = makeExportsDir();
    const locked = path.join(dir, 'locked.txt');
    fs.writeFileSync(locked, 'secret');
    fs.chmodSync(locked, 0o000);
    fs.writeFileSync(path.join(dir, 'fine.txt'), 'fine');

    const { proc, port } = await startBridge(dir);

    const res = await rawGet(port, '/exports/locked.txt');
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret');

    expect(proc.exitCode).toBeNull();
    const after = await rawGet(port, '/exports/fine.txt');
    expect(after.status).toBe(200);

    fs.chmodSync(locked, 0o644);
  });

  itUnlessRoot('still lists, with size null, when an entry cannot be stat-ed', async () => {
    // Deterministic trigger for the per-entry catch: a directory with r but not
    // x is readable (readdir succeeds) while traversal into it fails, so
    // statSync on each entry raises EACCES. That is the same shape as the
    // TOCTOU case — a file readdir saw and stat cannot reach — without the race.
    const dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');

    const { proc, port } = await startBridge(dir);

    fs.chmodSync(dir, 0o444);
    let res;
    try {
      res = await rawGet(port, '/exports');
    } finally {
      fs.chmodSync(dir, 0o755);
    }

    expect(res.status).toBe(200);
    expect(proc.exitCode).toBeNull();

    const entries = JSON.parse(res.body).exports;
    expect(entries.map(e => e.name)).toContain('a.txt');
    // The listing degrades rather than failing: the entry survives without size.
    expect(entries.find(e => e.name === 'a.txt').size).toBeNull();
  });

  itUnlessRoot('returns 500 rather than dying when the exports directory is unreadable', async () => {
    const dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const { proc, port } = await startBridge(dir);

    fs.chmodSync(dir, 0o000);
    const res = await rawGet(port, '/exports');
    fs.chmodSync(dir, 0o755);

    expect(res.status).toBe(500);
    expect(proc.exitCode).toBeNull();

    // Still serving afterward — the point of the whole exercise.
    const after = await rawGet(port, '/exports');
    expect(after.status).toBe(200);
  });
});

describe('containment — these rules must not quietly relax', () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'report.txt'), 'hello export');
  });

  it.each([
    ['..%2F..%2Fetc%2Fpasswd', 'encoded traversal'],
    ['../../etc/passwd', 'literal traversal'],
    ['..', 'bare parent'],
  ])('rejects %s (%s)', async (segment) => {
    const { proc, port } = await startBridge(dir);
    const res = await rawGet(port, `/exports/${segment}`);

    expect(res.status).not.toBe(200);
    expect(proc.exitCode).toBeNull();
  });

  it('rejects an absolute path', async () => {
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports//etc/passwd');
    expect(res.status).not.toBe(200);
  });

  it('rejects a NUL byte', async () => {
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/report.txt%00.png');
    expect(res.status).not.toBe(200);
  });

  it('rejects a symlink escaping the exports directory', async () => {
    const outside = makeExportsDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));

    const { proc, port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/link.txt');

    expect(res.status).toBe(403);
    expect(res.body).not.toContain('not yours');
    expect(proc.exitCode).toBeNull();
  });

  it('does not serve a directory as a file', async () => {
    fs.mkdirSync(path.join(dir, 'subdir'));
    const { port } = await startBridge(dir);
    const res = await rawGet(port, '/exports/subdir');
    expect(res.status).not.toBe(200);
  });
});

describe('the request callback itself must not be able to kill the daemon', () => {
  // Guarding individual handlers was not enough three times running. This pins
  // the outermost boundary: whatever throws, the process survives and keeps
  // serving. `new URL(req.url, ...)` is the concrete case — it is the first
  // statement of the handler and throws on a target like `//`, which curl
  // normalizes away but a raw socket sends verbatim.

  /**
   * Send a raw request line, bypassing any client-side normalization.
   * @param {number} port
   * @param {string} target
   * @returns {Promise<string>} first line of the response, or '' if none
   */
  function rawRequestLine(port, target) {
    return new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', d => { buf += d.toString(); });
      const done = () => { sock.destroy(); resolve(buf.split('\r\n')[0] || ''); };
      sock.on('close', done);
      setTimeout(done, 1500);
    });
  }

  it.each(['//', '///', '//%'])('survives a malformed request target %j', async (target) => {
    const dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const { proc, port } = await startBridge(dir);

    const line = await rawRequestLine(port, target);
    expect(line).toMatch(/^HTTP\/1\.1 400/);

    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
    const after = await rawGet(port, '/exports/a.txt');
    expect(after.status).toBe(200);
  });
});

describe('the callback boundary holds against hostile input generally', () => {
  // Deliberately NOT claiming to trigger the outer catch — every throw this can
  // currently produce is caught by a more specific guard, which is the point.
  // What it pins is the property the outer wrapper exists to provide: whatever
  // a caller sends, the process keeps serving. If a future change adds a
  // throwing statement before the auth check, this notices.
  it.each([
    ['GET', '/' + 'a'.repeat(4000), 'very long path'],
    ['GET', '/%ZZ%', 'invalid percent-encoding'],
    ['GET', '/../../etc/passwd', 'traversal at the root'],
    ['POST', '/v2/session/start', 'unauthenticated POST to a real route'],
    ['DELETE', '/health', 'wrong method on the public route'],
    ['GET', '/tools/nope', 'tools route with no extension mounted'],
  ])('survives %s %s (%s)', async (method, target) => {
    const dir = makeExportsDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const { proc, port } = await startBridge(dir);

    await new Promise((resolve) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: target, method }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', () => resolve());
      req.end();
    });

    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
    const after = await rawGet(port, '/exports/a.txt');
    expect(after.status).toBe(200);
  });
});
