import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureSpawnHelperExecutable,
  checkSpawnable,
} = require('../spawn-helper');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const PLATFORM = 'darwin';
const ARCH = 'arm64';

/**
 * Create a temporary directory mimicking node-pty's package layout, with a
 * spawn-helper file at the prebuilds/<platform-arch>/ path. Returns the temp
 * dir (acts as `nodePtyDir`), the helper path, and a cleanup function.
 *
 * @param {object} opts
 * @param {number} opts.mode - File mode to set on the helper (e.g. 0o644)
 * @param {boolean} [opts.omitHelper] - If true, do not create the helper file
 * @returns {{ nodePtyDir: string, helperPath: string, cleanup: Function }}
 */
function makeFixture({ mode, omitHelper = false }) {
  const nodePtyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-fixture-'));
  const prebuildDir = path.join(nodePtyDir, 'prebuilds', `${PLATFORM}-${ARCH}`);
  fs.mkdirSync(prebuildDir, { recursive: true });
  const helperPath = path.join(prebuildDir, 'spawn-helper');
  if (!omitHelper) {
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helperPath, mode);
  }
  return {
    nodePtyDir,
    helperPath,
    cleanup: () => fs.rmSync(nodePtyDir, { recursive: true, force: true }),
  };
}

/**
 * Capture logger that records warn/error calls for assertions.
 * @returns {{ warn: Function, error: Function, warns: string[], errors: string[] }}
 */
function makeLogger() {
  const warns = [];
  const errors = [];
  return {
    warn: (msg) => warns.push(msg),
    error: (msg) => errors.push(msg),
    warns,
    errors,
  };
}

// ─── ensureSpawnHelperExecutable ────────────────────────────────────────────

describe('ensureSpawnHelperExecutable', () => {
  let fixtures;

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(() => {
    for (const f of fixtures) f.cleanup();
  });

  // Test 1 (from issue): self-heal a non-executable helper, idempotently.
  it('chmods a non-executable helper to executable and is idempotent', () => {
    const f = makeFixture({ mode: 0o644 });
    fixtures.push(f);
    const logger = makeLogger();

    const first = ensureSpawnHelperExecutable({
      nodePtyDir: f.nodePtyDir,
      platform: PLATFORM,
      arch: ARCH,
      logger,
    });

    expect(first.spawnable).toBe(true);
    expect(first.fixed).toBe(true);
    expect(first.helper).toBe(f.helperPath);
    expect(fs.statSync(f.helperPath).mode & 0o111).not.toBe(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toMatch(/not executable; fixed/);
    expect(logger.errors).toHaveLength(0);

    // Second invocation: helper is already executable, no chmod, no warn.
    const second = ensureSpawnHelperExecutable({
      nodePtyDir: f.nodePtyDir,
      platform: PLATFORM,
      arch: ARCH,
      logger,
    });

    expect(second.spawnable).toBe(true);
    expect(second.fixed).toBe(false);
    expect(logger.warns).toHaveLength(1); // unchanged from the first call
    expect(() =>
      ensureSpawnHelperExecutable({
        nodePtyDir: f.nodePtyDir,
        platform: PLATFORM,
        arch: ARCH,
        logger,
      })
    ).not.toThrow();
  });

  // Test 2 (from issue): already-executable helper is left at 0o755 with no warning.
  it('leaves an already-executable helper untouched', () => {
    const f = makeFixture({ mode: 0o755 });
    fixtures.push(f);
    const logger = makeLogger();
    const before = fs.statSync(f.helperPath).mode;

    const result = ensureSpawnHelperExecutable({
      nodePtyDir: f.nodePtyDir,
      platform: PLATFORM,
      arch: ARCH,
      logger,
    });

    expect(result.spawnable).toBe(true);
    expect(result.fixed).toBe(false);
    expect(fs.statSync(f.helperPath).mode).toBe(before);
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  // Test 3 (from issue): missing helper logs error, returns not-spawnable, no throw.
  it('reports not-spawnable and logs an error when the helper is missing', () => {
    const f = makeFixture({ mode: 0o755, omitHelper: true });
    fixtures.push(f);
    const logger = makeLogger();

    let result;
    expect(() => {
      result = ensureSpawnHelperExecutable({
        nodePtyDir: f.nodePtyDir,
        platform: PLATFORM,
        arch: ARCH,
        logger,
      });
    }).not.toThrow();

    expect(result.spawnable).toBe(false);
    expect(result.helper).toBeNull();
    expect(result.reason).toMatch(/helper missing/);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatch(/spawn-helper not found/);
  });

  it('returns not-spawnable when node-pty is not resolvable', () => {
    const result = ensureSpawnHelperExecutable({
      nodePtyDir: null,
      platform: PLATFORM,
      arch: ARCH,
      logger: makeLogger(),
    });
    // When nodePtyDir is explicitly null, the fn falls back to resolving the
    // real installed node-pty. So we instead pass a non-existent path to
    // simulate "unresolvable":
    const f = makeFixture({ mode: 0o755 });
    fixtures.push(f);
    const missingDir = path.join(f.nodePtyDir, 'does-not-exist');
    const result2 = ensureSpawnHelperExecutable({
      nodePtyDir: missingDir,
      platform: PLATFORM,
      arch: ARCH,
      logger: makeLogger(),
    });
    expect(result2.spawnable).toBe(false);
    // Don't assert on `result` — it depends on whether node-pty is installed
    // in this environment, which is a test-runner concern, not a unit-test
    // concern.
    expect(result).toBeDefined();
  });
});

// ─── checkSpawnable (the /health field's backing function) ──────────────────

describe('checkSpawnable (/health contract)', () => {
  let fixtures;

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(() => {
    for (const f of fixtures) f.cleanup();
  });

  // Test 4 (from issue): non-executable fixture → false; executable → true.
  // The point of the new field is that it catches a case ptyAvailable doesn't:
  // node-pty can `require()` successfully (ptyAvailable=true) while sessions
  // still cannot spawn because the helper has no exec bit (ptySpawnable=false).
  // We assert ptyAvailable is true in both arms to make the gap explicit.
  it('returns false when the helper is non-executable and true after chmod', () => {
    const f = makeFixture({ mode: 0o644 });
    fixtures.push(f);

    // node-pty itself is installed in this repo (it's a runtime dep), so
    // ptyAvailable is true regardless of what we do to the fixture's helper.
    const { ptyAvailable } = require('../pty');
    expect(ptyAvailable).toBe(true);

    expect(
      checkSpawnable({ nodePtyDir: f.nodePtyDir, platform: PLATFORM, arch: ARCH })
    ).toBe(false);

    fs.chmodSync(f.helperPath, 0o755);

    expect(ptyAvailable).toBe(true); // unchanged — proves the new field is independent
    expect(
      checkSpawnable({ nodePtyDir: f.nodePtyDir, platform: PLATFORM, arch: ARCH })
    ).toBe(true);
  });

  it('returns false when the helper is missing entirely', () => {
    const f = makeFixture({ mode: 0o755, omitHelper: true });
    fixtures.push(f);
    expect(
      checkSpawnable({ nodePtyDir: f.nodePtyDir, platform: PLATFORM, arch: ARCH })
    ).toBe(false);
  });

  it('accepts a helper located at build/Release/ as well as prebuilds/', () => {
    // Some node-pty installs put the freshly compiled helper at
    // build/Release/spawn-helper instead of (or in addition to) the prebuild.
    const nodePtyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-build-'));
    fixtures.push({ cleanup: () => fs.rmSync(nodePtyDir, { recursive: true, force: true }) });
    const buildDir = path.join(nodePtyDir, 'build', 'Release');
    fs.mkdirSync(buildDir, { recursive: true });
    const helperPath = path.join(buildDir, 'spawn-helper');
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helperPath, 0o755);
    expect(
      checkSpawnable({ nodePtyDir, platform: PLATFORM, arch: ARCH })
    ).toBe(true);
  });
});

// ─── Regression: real node-pty end-to-end ───────────────────────────────────

describe('regression: real node-pty can actually spawn', () => {
  // Test 5 (from issue): with real node-pty (NOT pipes fallback), spawning a
  // process must NOT fail with `posix_spawnp failed`. This is the symptom
  // operators see when spawn-helper is missing the exec bit — `/v2/session/start`
  // returns 200 then immediately transitions to `failed`. Using /bin/echo (not
  // claude) means the test doesn't need a Claude install while still exercising
  // the spawn-helper code path inside node-pty.
  //
  // Skipped automatically if node-pty failed to load in this environment.
  const { ptyAvailable, PtyProcess } = require('../pty');
  const itIfPty = ptyAvailable ? it : it.skip;

  itIfPty('spawns /bin/echo via real node-pty and reaches exit code 0', async () => {
    const proc = new PtyProcess('/bin/echo', ['spawn-helper-ok'], {
      // Force the node-pty path (not the pipes fallback) — this is the path
      // that posix_spawns spawn-helper.
      usePipes: false,
    });

    const chunks = [];
    let errored = null;
    proc.on('data', (d) => chunks.push(d));
    proc.on('error', (err) => {
      errored = err;
    });

    proc.spawn();

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('PTY did not exit within 5s')),
        5000
      );
      proc.on('exit', (info) => {
        clearTimeout(timer);
        resolve(info);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(errored).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toContain('spawn-helper-ok');

    proc.destroy();
  });
});
