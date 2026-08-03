import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleV2Route } = require('../routes');
const { SessionManager } = require('../sessions');

const PROJECT = 'capture-back';

let TEST_DIR;
let manager;

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-session-file-'));
  fs.mkdirSync(path.join(TEST_DIR, PROJECT), { recursive: true });
  manager = new SessionManager({
    projectsDir: TEST_DIR,
    claudeBin: '/bin/echo',
    usePipes: true,
  });
});

afterEach(() => {
  manager.destroyAll();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

/**
 * Mock GET handler invocation for /v2/session/file. Mirrors the shape
 * `handleV2Route` expects, capturing the JSON response for assertions.
 *
 * @param {Record<string, string>} query - querystring params
 * @returns {{ run: Function, captured: Function }}
 */
function mockGet(query) {
  return mockRequest('GET', query);
}

/**
 * Mock handler invocation for /v2/session/file at an arbitrary method.
 *
 * `res` carries a real `setHeader` rather than being `{}`: the handler sets
 * `Allow` alongside its 405, and a bare object would throw there — which would
 * make the harness, not the route, decide what the route may do.
 *
 * @param {string} method - HTTP method
 * @param {Record<string, string>} query - querystring params
 * @returns {{ run: Function, captured: Function, headers: Function }}
 */
function mockRequest(method, query) {
  const search = new URLSearchParams(query).toString();
  const pathname = '/v2/session/file';
  let captured = null;
  const headers = {};
  return {
    run: () =>
      handleV2Route({
        method,
        pathname,
        url: new URL(`http://localhost${pathname}?${search}`),
        req: {},
        res: { setHeader: (k, v) => { headers[k] = v; } },
        parseBody: async () => ({}),
        json: (_res, status, body) => { captured = { status, body }; },
        sessionManager: manager,
      }),
    captured: () => captured,
    headers: () => headers,
  };
}

/**
 * Seed a file under `<TEST_DIR>/<PROJECT>/` at a project-relative path.
 * Creates intermediate directories. Returns the absolute path.
 *
 * @param {string} relPath
 * @param {string|Buffer} content
 * @returns {string}
 */
function seed(relPath, content) {
  const abs = path.join(TEST_DIR, PROJECT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe('GET /v2/session/file', () => {
  // Test 1 (from issue): happy path returns raw bytes verbatim.
  it('returns raw file bytes — markdown preserved, no rendering', async () => {
    const content =
      '## Next action\n\nWrap-capture probe. Tokens that the TUI mangles:\n' +
      '- `**bold**` and `<<TC:x>>...<<END>>`\n' +
      '- multi-line\n  - nested bullet\n';
    seed('.tangleclaw/wrap-capture.md', content);

    const m = mockGet({ project: PROJECT, path: '.tangleclaw/wrap-capture.md' });
    await m.run();
    const { status, body } = m.captured();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.project).toBe(PROJECT);
    expect(body.path).toBe('.tangleclaw/wrap-capture.md');
    expect(body.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(body.content).toBe(content);
    expect(body.consumed).toBe(false);
  });

  // Test 2 (from issue): consume=true unlinks; second read → 404.
  // Moved to POST in 2.0.0 — see the G7 block below for why the method changed.
  it('consume=true returns content then unlinks the file', async () => {
    const file = seed('cap.md', '## Heading\nbody\n');

    const m1 = mockRequest('POST', { project: PROJECT, path: 'cap.md', consume: 'true' });
    await m1.run();
    expect(m1.captured().status).toBe(200);
    expect(m1.captured().body.consumed).toBe(true);
    expect(m1.captured().body.content).toBe('## Heading\nbody\n');
    expect(fs.existsSync(file)).toBe(false);

    const m2 = mockRequest('POST', { project: PROJECT, path: 'cap.md', consume: 'true' });
    await m2.run();
    expect(m2.captured().status).toBe(404);
  });

  // Test 3 (from issue): unlink failure → still 200 with content + consumed:false.
  // We trigger unlink failure by making the *parent directory* read-only on
  // POSIX — unlink requires write+exec on the parent, not on the file itself.
  it('consume=true with failing unlink still returns content (consumed:false)', async () => {
    const dirAbs = path.join(TEST_DIR, PROJECT, 'ro-parent');
    fs.mkdirSync(dirAbs);
    const fileAbs = path.join(dirAbs, 'cap.md');
    fs.writeFileSync(fileAbs, '## locked\n');
    fs.chmodSync(dirAbs, 0o555);

    try {
      const m = mockRequest('POST', { project: PROJECT, path: 'ro-parent/cap.md', consume: 'true' });
      await m.run();
      const { status, body } = m.captured();
      expect(status).toBe(200);
      expect(body.content).toBe('## locked\n');
      expect(body.consumed).toBe(false);
      expect(fs.existsSync(fileAbs)).toBe(true);
    } finally {
      fs.chmodSync(dirAbs, 0o755); // restore so afterEach can clean up
    }
  });

  // Test 4 (from issue): missing file → 404, no throw.
  it('returns 404 when the file does not exist', async () => {
    const m = mockGet({ project: PROJECT, path: '.tangleclaw/never-written.md' });
    await m.run();
    expect(m.captured().status).toBe(404);
    expect(m.captured().body.error).toMatch(/File not found/);
  });

  // Test 5 (from issue): relative traversal → 400.
  it('rejects relative traversal (../../etc/passwd) with 400', async () => {
    // Even if the target exists (it does on every Unix), we must refuse.
    const m = mockGet({ project: PROJECT, path: '../../etc/passwd' });
    await m.run();
    expect(m.captured().status).toBe(400);
    expect(m.captured().body.error).toMatch(/escapes project directory/);
  });

  // Test 6 (from issue): absolute path → 400.
  it('rejects absolute paths with 400', async () => {
    const m = mockGet({ project: PROJECT, path: '/etc/passwd' });
    await m.run();
    expect(m.captured().status).toBe(400);
    expect(m.captured().body.error).toMatch(/Invalid path/);
  });

  // Test 7 (from issue): symlink escape → realpath check → 400.
  it('rejects a symlink that escapes the project root', async () => {
    seed('.tangleclaw/.gitkeep', '');
    const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-outside-'));
    fs.writeFileSync(path.join(escapeTarget, 'secret.txt'), 'sshhhh');
    try {
      const linkAbs = path.join(TEST_DIR, PROJECT, '.tangleclaw', 'escape');
      fs.symlinkSync(escapeTarget, linkAbs);

      const m = mockGet({
        project: PROJECT,
        path: '.tangleclaw/escape/secret.txt',
      });
      await m.run();
      expect(m.captured().status).toBe(400);
      expect(m.captured().body.error).toMatch(/Symlink escapes/);
    } finally {
      fs.rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  // Test 8 (from issue): unknown project → consistent v2 404, no throw.
  it('returns 404 when the project directory does not exist', async () => {
    const m = mockGet({ project: 'no-such-project', path: 'whatever.md' });
    await m.run();
    expect(m.captured().status).toBe(404);
    expect(m.captured().body.error).toMatch(/Project not found/);
  });

  // Test 9 (from issue): multibyte UTF-8 round-trips byte-identical.
  it('round-trips multibyte UTF-8 byte-for-byte', async () => {
    const content =
      '## 概要 — résumé / 🪝\n' +
      'Mixed: ascii + 中文 + Ωmega + 𝄞 (musical sym, 4-byte UTF-8).\n';
    seed('utf8.md', content);

    const m = mockGet({ project: PROJECT, path: 'utf8.md' });
    await m.run();
    const { status, body } = m.captured();

    expect(status).toBe(200);
    expect(body.content).toBe(content);
    expect(body.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(Buffer.byteLength(body.content, 'utf8')).toBe(body.bytes);
  });

  // ── Parameter & input validation ──

  it('returns 400 when project param is missing', async () => {
    const m = mockGet({ path: 'cap.md' });
    await m.run();
    expect(m.captured().status).toBe(400);
    expect(m.captured().body.error).toMatch(/project is required/);
  });

  it('returns 400 when path param is missing', async () => {
    const m = mockGet({ project: PROJECT });
    await m.run();
    expect(m.captured().status).toBe(400);
    expect(m.captured().body.error).toMatch(/path is required/);
  });

  it('rejects invalid project names (.. / \\0 / slash)', async () => {
    for (const evil of ['..', 'foo/bar', 'has\0null']) {
      const m = mockGet({ project: evil, path: 'cap.md' });
      await m.run();
      expect(m.captured().status).toBe(400);
      expect(m.captured().body.error).toMatch(/Invalid project name/);
    }
  });

  it('returns 400 when the resolved target is a directory, not a file', async () => {
    fs.mkdirSync(path.join(TEST_DIR, PROJECT, 'subdir'), { recursive: true });
    const m = mockGet({ project: PROJECT, path: 'subdir' });
    await m.run();
    expect(m.captured().status).toBe(400);
    expect(m.captured().body.error).toMatch(/Not a file/);
  });

  it('treats consume=false (or omitted) as no-unlink', async () => {
    const file = seed('keep.md', 'still here\n');

    const m1 = mockGet({ project: PROJECT, path: 'keep.md', consume: 'false' });
    await m1.run();
    expect(m1.captured().body.consumed).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    const m2 = mockGet({ project: PROJECT, path: 'keep.md' }); // omitted
    await m2.run();
    expect(m2.captured().body.consumed).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

/**
 * Guards for security-model.md § Known gaps G7 (`SEC-K4RD`): a destructive
 * operation must not answer a safe method.
 *
 * Enumerated over request *shape* rather than over routes, because that is the
 * axis this defect lives on — the motivating caller is not a browser at all but
 * anything that follows a URL, which is why the origin gate in server.js cannot
 * cover it.
 */
describe('GET /v2/session/file must not have side effects (G7)', () => {
  it('refuses consume=true on GET and leaves the file in place', async () => {
    // The prefetcher / link-unfurler case, and the whole reason for the change.
    // Asserting the status alone would pass against a handler that unlinked and
    // *then* refused, so the surviving file is the real assertion.
    const file = seed('cap.md', 'must survive a GET\n');

    const m = mockGet({ project: PROJECT, path: 'cap.md', consume: 'true' });
    await m.run();

    expect(m.captured().status).toBe(405);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('names the method to use, so the refusal is actionable', async () => {
    // A 405 without Allow tells a caller it is wrong but not what to do; the
    // migration hint belongs in the response, not only in the changelog.
    seed('cap.md', 'x\n');

    const m = mockGet({ project: PROJECT, path: 'cap.md', consume: 'true' });
    await m.run();

    expect(m.headers()['Allow']).toBe('POST');
    expect(m.captured().body.error).toMatch(/POST/);
  });

  it('refuses rather than quietly downgrading to a plain read', async () => {
    // The tempting alternative was to ignore consume on GET and return 200.
    // That hands the caller a file it believes it consumed; the duplicate
    // capture then surfaces much later, somewhere else. So: no content on a
    // refused consume.
    seed('cap.md', 'contents\n');

    const m = mockGet({ project: PROJECT, path: 'cap.md', consume: 'true' });
    await m.run();

    expect(m.captured().status).not.toBe(200);
    expect(m.captured().body.content).toBeUndefined();
  });

  it('leaves the plain read untouched', async () => {
    // The compatibility half: only the consuming form moved. Without this, a
    // handler that refused every GET would look identical to a correct one.
    const file = seed('cap.md', 'read me\n');

    const m = mockGet({ project: PROJECT, path: 'cap.md' });
    await m.run();

    expect(m.captured().status).toBe(200);
    expect(m.captured().body.content).toBe('read me\n');
    expect(m.captured().body.consumed).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('still reads on POST without consume, so the method is not a consume switch', async () => {
    const file = seed('cap.md', 'plain post\n');

    const m = mockRequest('POST', { project: PROJECT, path: 'cap.md' });
    await m.run();

    expect(m.captured().status).toBe(200);
    expect(m.captured().body.consumed).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});
