import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { detectTestResult, getApiDocs } = require('../routes');
const { EventLog } = require('../event-log');
const { EventKind } = require('../types');

// ── detectTestResult ──

describe('detectTestResult', () => {
  /**
   * Helper: create an EventLog with text events containing the given string.
   * @param {string} text - Raw PTY output to inject
   * @returns {EventLog}
   */
  function logWithText(text) {
    const log = new EventLog();
    log.appendText(text);
    return log;
  }

  describe('vitest output', () => {
    it('detects all-passing vitest output', () => {
      const log = logWithText('  Tests  444 passed (444)\n  Duration  12.34s');
      const result = detectTestResult(log);
      expect(result).toEqual({
        runner: 'vitest',
        passed: 444,
        failed: 0,
        total: 444,
        summary: 'Tests  444 passed (444)',
        command: null,
      });
    });

    it('detects vitest output with failures', () => {
      const log = logWithText('  Tests  3 failed | 39 passed (42)\n  Duration  5.67s');
      const result = detectTestResult(log);
      expect(result).toEqual({
        runner: 'vitest',
        passed: 39,
        failed: 3,
        total: 42,
        summary: 'Tests  3 failed | 39 passed (42)',
        command: null,
      });
    });

    it('detects vitest command in output', () => {
      const log = logWithText('$ npx vitest run\n  Tests  10 passed (10)\n');
      const result = detectTestResult(log);
      expect(result.command).toBe('npx vitest run');
      expect(result.runner).toBe('vitest');
    });

    it('handles ANSI codes in vitest output', () => {
      const log = logWithText('\x1b[32m  Tests  5 passed (5)\x1b[0m\n');
      const result = detectTestResult(log);
      expect(result).not.toBeNull();
      expect(result.runner).toBe('vitest');
      expect(result.passed).toBe(5);
    });
  });

  describe('pytest output', () => {
    it('detects all-passing pytest output', () => {
      const log = logWithText('========== 170 passed in 4.52s ==========');
      const result = detectTestResult(log);
      expect(result).toEqual({
        runner: 'pytest',
        passed: 170,
        failed: 0,
        total: 170,
        summary: '170 passed',
        command: null,
      });
    });

    it('detects pytest output with failures', () => {
      const log = logWithText('========== 3 failed, 167 passed in 5.10s ==========');
      const result = detectTestResult(log);
      expect(result.runner).toBe('pytest');
      expect(result.passed).toBe(167);
      expect(result.failed).toBe(3);
      expect(result.total).toBe(170);
    });

    it('detects pytest command in output', () => {
      const log = logWithText('$ pytest tests/ -v\n========== 10 passed in 1.23s ==========');
      const result = detectTestResult(log);
      expect(result.command).toBe('pytest tests/ -v');
    });
  });

  describe('jest output', () => {
    it('detects all-passing jest output', () => {
      const log = logWithText('Tests:  42 passed, 42 total');
      const result = detectTestResult(log);
      expect(result).toEqual({
        runner: 'jest',
        passed: 42,
        failed: 0,
        total: 42,
        summary: 'Tests:  42 passed, 42 total',
        command: null,
      });
    });

    it('detects jest output with failures', () => {
      const log = logWithText('Tests:  2 failed, 40 passed, 42 total');
      const result = detectTestResult(log);
      expect(result.runner).toBe('jest');
      expect(result.passed).toBe(40);
      expect(result.failed).toBe(2);
      expect(result.total).toBe(42);
    });
  });

  describe('mocha output', () => {
    it('detects all-passing mocha output', () => {
      const log = logWithText('  15 passing (2s)');
      const result = detectTestResult(log);
      expect(result).toEqual({
        runner: 'mocha',
        passed: 15,
        failed: 0,
        total: 15,
        summary: '15 passing',
        command: null,
      });
    });

    it('detects mocha output with failures', () => {
      const log = logWithText('  13 passing (2s)\n  2 failing');
      const result = detectTestResult(log);
      expect(result.runner).toBe('mocha');
      expect(result.passed).toBe(13);
      expect(result.failed).toBe(2);
      expect(result.total).toBe(15);
    });
  });

  describe('no test output', () => {
    it('returns null when no test output detected', () => {
      const log = logWithText('Hello world\nsome random output\n');
      expect(detectTestResult(log)).toBeNull();
    });

    it('returns null for empty event log', () => {
      const log = new EventLog();
      expect(detectTestResult(log)).toBeNull();
    });
  });
});

// ── getApiDocs ──

describe('getApiDocs', () => {
  it('returns ok: true', () => {
    const docs = getApiDocs();
    expect(docs.ok).toBe(true);
  });

  it('includes all v2 endpoints', () => {
    const docs = getApiDocs();
    const paths = docs.endpoints.map(e => e.path);
    expect(paths).toContain('/v2/session/start');
    expect(paths).toContain('/v2/session/output');
    expect(paths).toContain('/v2/session/peek');
    expect(paths).toContain('/v2/session/respond');
    expect(paths).toContain('/v2/session/send');
    expect(paths).toContain('/v2/session/status');
    expect(paths).toContain('/v2/session/transcript');
    expect(paths).toContain('/v2/session/end');
    expect(paths).toContain('/v2/session/policy');
    expect(paths).toContain('/v2/sessions');
    expect(paths).toContain('/v2/api-docs');
  });

  it('includes quickstart steps', () => {
    const docs = getApiDocs();
    expect(docs.quickstart).toBeDefined();
    expect(docs.quickstart.steps.length).toBeGreaterThan(0);
  });

  it('every endpoint has method, path, and description', () => {
    const docs = getApiDocs();
    for (const ep of docs.endpoints) {
      expect(ep.method).toBeDefined();
      expect(ep.path).toBeDefined();
      expect(ep.description).toBeDefined();
    }
  });
});

// ── Peek route integration (via handleV2Route) ──

describe('peek route integration', () => {
  const { handleV2Route } = require('../routes');
  const { SessionManager } = require('../sessions');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');

  const TEST_DIR = path.join(os.tmpdir(), `clawbridge-peek-test-${Date.now()}`);

  /** Minimal mock for HTTP route testing */
  function mockRoute(method, pathname, query = {}) {
    const sp = new URLSearchParams(query);
    const url = new URL(`http://localhost/${pathname}?${sp.toString()}`);
    let captured = null;
    const res = {};
    const json = (_res, status, body) => { captured = { status, body }; };
    const parseBody = async () => ({});
    return { method, pathname, url, req: {}, res, parseBody, json, captured: () => captured };
  }

  let manager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager({
      projectsDir: TEST_DIR,
      claudeBin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('peek returns active:false for unknown project', async () => {
    const m = mockRoute('GET', '/v2/session/peek', { project: 'nonexistent' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured()).toEqual({ status: 200, body: { ok: true, project: 'nonexistent', active: false } });
  });

  it('peek returns session state and tail for active session', async () => {
    const session = manager.start('peek-test');
    // Inject some text directly into the event log
    session.eventLog.appendText('line 1\nline 2\nline 3\n');

    const m = mockRoute('GET', '/v2/session/peek', { project: 'peek-test', lines: '2' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.active).toBe(true);
    expect(result.body.state).toBe('running');
    expect(result.body.tail).toContain('line 3');
    expect(result.body.testResult).toBeNull();
  });

  it('peek surfaces pendingPermission when present', async () => {
    const session = manager.start('perm-peek');
    // Simulate a pending permission
    session.pendingPermission = {
      id: 'perm_123',
      permissionType: 'file_write',
      risk: 'low',
      target: '/tmp/test.js',
      timeoutAt: '2026-03-30T12:00:00Z',
    };

    const m = mockRoute('GET', '/v2/session/peek', { project: 'perm-peek' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured();
    expect(result.body.pendingPermission).toEqual({
      id: 'perm_123',
      permissionType: 'file_write',
      risk: 'low',
      target: '/tmp/test.js',
      timeoutAt: '2026-03-30T12:00:00Z',
    });
  });

  it('peek detects test results in output', async () => {
    const session = manager.start('test-peek');
    session.eventLog.appendText('Running tests...\n  Tests  42 passed (42)\n  Duration  3.21s\n');

    const m = mockRoute('GET', '/v2/session/peek', { project: 'test-peek' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured();
    expect(result.body.testResult).not.toBeNull();
    expect(result.body.testResult.runner).toBe('vitest');
    expect(result.body.testResult.passed).toBe(42);
  });

  it('peek returns 400 without project param', async () => {
    const m = mockRoute('GET', '/v2/session/peek', {});
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().status).toBe(400);
  });

  it('peek includes inputReady=true for running session', async () => {
    manager.start('input-ready');
    const m = mockRoute('GET', '/v2/session/peek', { project: 'input-ready' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().body.inputReady).toBe(true);
  });

  it('peek includes inputReady=false for waiting_for_permission session', async () => {
    const session = manager.start('input-blocked');
    // Simulate permission wait state
    session.pendingPermission = { id: 'p1', permissionType: 'file_write', risk: 'low', target: {} };
    session.transition('waiting_for_permission');

    const m = mockRoute('GET', '/v2/session/peek', { project: 'input-blocked' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().body.inputReady).toBe(false);
  });

  it('peek strips ANSI when clean=true', async () => {
    const session = manager.start('ansi-peek');
    session.eventLog.appendText('\x1b[32mgreen text\x1b[0m\n\x1b[31mred text\x1b[0m\n');

    const m = mockRoute('GET', '/v2/session/peek', { project: 'ansi-peek', clean: 'true' });
    await handleV2Route({ ...m, sessionManager: manager });
    const tail = m.captured().body.tail;
    expect(tail).not.toContain('\x1b[');
    expect(tail).toContain('green text');
    expect(tail).toContain('red text');
  });

  it('peek returns raw ANSI when clean is not set', async () => {
    const session = manager.start('raw-peek');
    session.eventLog.appendText('\x1b[32mcolored\x1b[0m\n');

    const m = mockRoute('GET', '/v2/session/peek', { project: 'raw-peek' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().body.tail).toContain('\x1b[');
  });
});

// ── Live transcript (no terminal-state gate) ──

describe('live transcript', () => {
  const { handleV2Route } = require('../routes');
  const { SessionManager } = require('../sessions');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');

  const TEST_DIR = path.join(os.tmpdir(), `clawbridge-transcript-test-${Date.now()}`);

  function mockRoute(method, pathname, query = {}) {
    const sp = new URLSearchParams(query);
    const url = new URL(`http://localhost/${pathname}?${sp.toString()}`);
    let captured = null;
    const res = {};
    const json = (_res, status, body) => { captured = { status, body }; };
    const parseBody = async () => ({});
    return { method, pathname, url, req: {}, res, parseBody, json, captured: () => captured };
  }

  let manager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager({
      projectsDir: TEST_DIR,
      claudeBin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('returns transcript for active (non-terminal) session', async () => {
    const session = manager.start('live-transcript');
    session.eventLog.appendText('hello from running session\n');

    const m = mockRoute('GET', '/v2/session/transcript', { project: 'live-transcript' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured();
    expect(result.status).toBe(200);
    expect(result.body.active).toBe(true);
    expect(result.body.transcript).toContain('hello from running session');
  });

  it('returns transcript for ended session', async () => {
    const session = manager.start('ended-transcript');
    session.eventLog.appendText('completed work\n');
    // Force to terminal state for testing
    session.transition('completed');

    const m = mockRoute('GET', '/v2/session/transcript', { project: 'ended-transcript' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured();
    expect(result.status).toBe(200);
    expect(result.body.active).toBe(false);
    expect(result.body.transcript).toContain('completed work');
  });

  it('returns 404 for unknown project', async () => {
    const m = mockRoute('GET', '/v2/session/transcript', { project: 'nope' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().status).toBe(404);
  });

  it('strips ANSI from transcript when clean=true', async () => {
    const session = manager.start('clean-transcript');
    session.eventLog.appendText('\x1b[1mbold\x1b[0m normal\n');

    const m = mockRoute('GET', '/v2/session/transcript', { project: 'clean-transcript', clean: 'true' });
    await handleV2Route({ ...m, sessionManager: manager });
    const transcript = m.captured().body.transcript;
    expect(transcript).not.toContain('\x1b[');
    expect(transcript).toContain('bold');
    expect(transcript).toContain('normal');
  });
});

// ── api-docs route ──

describe('api-docs route', () => {
  const { handleV2Route } = require('../routes');
  const { SessionManager } = require('../sessions');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');

  const TEST_DIR = path.join(os.tmpdir(), `clawbridge-docs-test-${Date.now()}`);

  function mockRoute(method, pathname, query = {}) {
    const sp = new URLSearchParams(query);
    const url = new URL(`http://localhost/${pathname}?${sp.toString()}`);
    let captured = null;
    const res = {};
    const json = (_res, status, body) => { captured = { status, body }; };
    const parseBody = async () => ({});
    return { method, pathname, url, req: {}, res, parseBody, json, captured: () => captured };
  }

  let manager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager({
      projectsDir: TEST_DIR,
      claudeBin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('serves api-docs via route handler', async () => {
    const m = mockRoute('GET', '/v2/api-docs');
    const handled = await handleV2Route({ ...m, sessionManager: manager });
    expect(handled).toBe(true);
    expect(m.captured().status).toBe(200);
    expect(m.captured().body.ok).toBe(true);
    expect(m.captured().body.endpoints.length).toBeGreaterThan(0);
  });

  it('api-docs includes /v2/session/last endpoint', () => {
    const docs = getApiDocs();
    const paths = docs.endpoints.map(e => e.path);
    expect(paths).toContain('/v2/session/last');
  });
});

// ── Session last (post-completion retrieval) ──

describe('session last endpoint', () => {
  const { handleV2Route } = require('../routes');
  const { SessionManager } = require('../sessions');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');

  const TEST_DIR = path.join(os.tmpdir(), `clawbridge-last-test-${Date.now()}`);
  const HISTORY_DIR = path.join(TEST_DIR, '.history');

  function mockRoute(method, pathname, query = {}) {
    const sp = new URLSearchParams(query);
    const url = new URL(`http://localhost/${pathname}?${sp.toString()}`);
    let captured = null;
    const res = {};
    const json = (_res, status, body) => { captured = { status, body }; };
    const parseBody = async () => ({});
    return { method, pathname, url, req: {}, res, parseBody, json, captured: () => captured };
  }

  let manager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager({
      projectsDir: TEST_DIR,
      claudeBin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      usePipes: true,
      historyDir: HISTORY_DIR,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('returns found:false for project with no history', async () => {
    const m = mockRoute('GET', '/v2/session/last', { project: 'no-history' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().body.found).toBe(false);
  });

  it('returns completed session data after session ends', async () => {
    const session = manager.start('hist-test');
    session.eventLog.appendText('did some work\n  Tests  5 passed (5)\n');
    session.transition('completed');
    // The PTY exit handler would call _snapshotSession; simulate it
    manager._snapshotSession(session);

    const m = mockRoute('GET', '/v2/session/last', { project: 'hist-test' });
    await handleV2Route({ ...m, sessionManager: manager });

    const result = m.captured().body;
    expect(result.found).toBe(true);
    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe('completed');
    expect(result.transcript).toContain('did some work');
    expect(result.testResult).not.toBeNull();
    expect(result.testResult.runner).toBe('vitest');
    expect(result.testResult.passed).toBe(5);
  });

  it('persists history to disk and reloads', async () => {
    const session = manager.start('persist-test');
    session.eventLog.appendText('persisted output\n');
    session.transition('completed');
    manager._snapshotSession(session);

    // Verify file on disk
    const histFile = path.join(HISTORY_DIR, 'persist-test.json');
    expect(fs.existsSync(histFile)).toBe(true);

    // Create a new manager that loads from disk
    const manager2 = new SessionManager({
      projectsDir: TEST_DIR,
      claudeBin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      usePipes: true,
      historyDir: HISTORY_DIR,
    });

    const snapshot = manager2.getLastCompleted('persist-test');
    expect(snapshot).not.toBeNull();
    expect(snapshot.transcript).toContain('persisted output');
    manager2.destroyAll();
  });

  it('strips ANSI with clean=true', async () => {
    const session = manager.start('clean-last');
    session.eventLog.appendText('\x1b[32mgreen\x1b[0m\n');
    session.transition('completed');
    manager._snapshotSession(session);

    const m = mockRoute('GET', '/v2/session/last', { project: 'clean-last', clean: 'true' });
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().body.transcript).not.toContain('\x1b[');
    expect(m.captured().body.transcript).toContain('green');
  });

  it('returns 400 without project param', async () => {
    const m = mockRoute('GET', '/v2/session/last', {});
    await handleV2Route({ ...m, sessionManager: manager });
    expect(m.captured().status).toBe(400);
  });
});
