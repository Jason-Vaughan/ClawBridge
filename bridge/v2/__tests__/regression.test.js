/**
 * Regression tests for the 11 bugs found during bridge v2 E2E validation.
 * Each test group maps to a numbered item in docs/bridge-v2-regression-checklist.md.
 *
 * These are unit/integration-level tests that cover the deterministic aspects
 * of each bug. Timing-sensitive behaviors (e.g., 500ms auto-approve delay into
 * a live TUI) still require live PTY E2E confirmation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PermissionParser, stripAnsi, CONFIRMATION_PATTERN } = require('../permission-parser');
const { Session, SessionManager } = require('../sessions');
const { SessionState, PermissionType, TERMINAL_STATES } = require('../types');

// ─── Bug #1: Permission target misattribution ──────────────────────────────
// Root cause: Parser matched stale buffer content from earlier PTY redraws.
// Fix: Scan lines bottom-up so the most recent prompt wins.

describe('Bug #1 — permission target misattribution (bottom-up scan)', () => {
  let parser;
  let detected;

  beforeEach(() => {
    detected = [];
    parser = new PermissionParser({
      projectRoot: '/home/user/project',
      sessionId: 'sess_reg1',
      project: 'test',
      onPermission: (e) => detected.push(e),
    });
  });

  it('attributes the correct target when multiple file paths are in the buffer', () => {
    // Simulate stale UI: earlier status line mentions package.json,
    // but the real permission is for src/add.js
    parser.feed('Status: wrote package.json\n');
    parser.reset();
    parser.feed(
      'Claude wants to write to src/add.js\n' +
      '❯ 1. Yes\n' +
      '  2. Yes, allow all\n' +
      '  3. No\n'
    );
    expect(detected).toHaveLength(1);
    expect(detected[0].target.path).toBe('src/add.js');
  });

  it('picks the bottom-most matching prompt when buffer has consecutive write prompts', () => {
    // Two prompts in the buffer — bottom-up scan should find the second one
    parser.feed(
      'Claude wants to write to src/first.js\n' +
      'Claude wants to write to src/second.js\n' +
      'Allow? (y/n)\n'
    );
    expect(detected).toHaveLength(1);
    expect(detected[0].target.path).toBe('src/second.js');
  });
});

// ─── Bug #2: /v2/sessions returning ended sessions ─────────────────────────
// Root cause: Session listing was not filtering to active-only by default.
// Fix: routes.js filters by !isTerminal unless ?all=true.

describe('Bug #2 — sessions listing filters to active-only', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/echo',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('list() includes terminal sessions (route-level filtering is separate)', () => {
    const session = manager.start('proj-a', { instruction: 'hi' });
    // echo exits immediately → COMPLETED
    return new Promise((resolve) => {
      const check = () => {
        if (session.isTerminal) {
          // Manager.list() returns ALL sessions (route filters)
          expect(manager.list()).toHaveLength(1);
          expect(manager.list()[0].isTerminal).toBe(true);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
  });

  it('isTerminal is true for all terminal states', () => {
    for (const state of TERMINAL_STATES) {
      const session = new Session('sess_t', 'p', '/tmp/p');
      // Manually set state (bypassing transitions for this assertion)
      session.state = state;
      expect(session.isTerminal).toBe(true);
    }
  });
});

// ─── Bug #3: Trust buffer swallowing early permission prompts ───────────────
// Root cause: Startup trust buffering discarded data instead of flushing to parser.
// Fix: On safety-valve flush (>2KB) or tool-call detection, feed buffer to parser.

describe('Bug #3 — trust buffer flushes to permission parser', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('flushes trust buffer to parser when tool-call text is detected', async () => {
    const session = manager.start('flush-project');
    const permissionEvents = [];

    // Intercept permission parser to track detections
    const origFeed = session.permissionParser.feed.bind(session.permissionParser);
    session.permissionParser.feed = (data) => {
      const result = origFeed(data);
      if (result) permissionEvents.push(result);
      return result;
    };

    // Simulate PTY output that includes a Write() tool-call announcement
    // (which triggers trust buffer flush) followed by a permission menu
    session.pty.emit('data', 'Write(src/index.js)\n❯ 1. Yes\n  2. Yes, allow all\nEsc to cancel\n');

    // Give a tick for processing
    await new Promise(r => setTimeout(r, 50));

    // The trust buffer should have flushed and the permission parser should detect the prompt
    expect(permissionEvents.length).toBeGreaterThanOrEqual(1);
    expect(permissionEvents[0].target.path).toBe('src/index.js');
  });
});

// ─── Bug #12: Trust prompt misclassified as unknown permission after safety valve ─
// Root cause: Startup ANSI output exceeded 2KB safety valve before trust prompt rendered.
// Safety valve set trustPromptHandled=true. Trust prompt then reached permission parser,
// "Esc to cancel" matched CONFIRMATION_PATTERN, no PROMPT_PATTERNS matched → unknown.
// Fix: Increased safety valve to 8KB + 5s grace period for secondary trust detection.

describe('Bug #12 — trust prompt after safety valve does not trigger unknown permission', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.destroyAll();
  });

  it('does not emit unknown permission when trust prompt arrives after safety valve', () => {
    const session = manager.start('trust-late-project');
    const permissionEvents = [];

    // Intercept permission parser to track detections
    const origOnPerm = session.permissionParser._onPermission;
    session.permissionParser._onPermission = (event) => {
      permissionEvents.push(event);
      origOnPerm(event);
    };

    // Simulate >8KB of startup ANSI output (triggers safety valve)
    session.pty.emit('data', 'x'.repeat(9000));

    // Now the trust prompt arrives (after safety valve already fired)
    session.pty.emit('data', 'Yes, I trust this folder\nNo, exit\nEnter to confirm · Esc to cancel\n');

    // Should NOT have emitted an unknown permission
    const unknowns = permissionEvents.filter(e => e.permissionType === 'unknown');
    expect(unknowns).toHaveLength(0);
  });

  it('auto-confirms trust prompt that arrives during grace period', () => {
    const session = manager.start('trust-grace-project');
    const writes = [];
    const origWrite = session.pty.write.bind(session.pty);
    session.pty.write = (data) => {
      writes.push(data);
      try { return origWrite(data); } catch { /* EPIPE in test mode */ }
    };

    // Trigger safety valve with big startup output
    session.pty.emit('data', 'x'.repeat(9000));

    // Trust prompt arrives during grace period
    session.pty.emit('data', 'Is this a project you created or one you trust?\nEnter to confirm\n');

    // Advance past the 500ms confirm delay
    vi.advanceTimersByTime(600);

    // Should have attempted to send \r to confirm trust
    expect(writes.some(w => w === '\r')).toBe(true);
  });

  it('still detects trust prompt within buffer before safety valve', () => {
    const session = manager.start('trust-inline-project');
    const writes = [];
    const origWrite = session.pty.write.bind(session.pty);
    session.pty.write = (data) => {
      writes.push(data);
      try { return origWrite(data); } catch { /* EPIPE in test mode */ }
    };

    // Trust prompt within buffer (well under 8KB)
    session.pty.emit('data', 'Welcome to Claude\nIs this a project you created or one you trust?\nEnter to confirm\n');

    // Advance past the 500ms confirm delay
    vi.advanceTimersByTime(600);

    expect(writes.some(w => w === '\r')).toBe(true);
  });
});

// ─── Bug #4: Confirmation pattern too narrow for interactive menus ──────────
// Root cause: Only matched Allow?/Do you want/(y/n) — not Claude Code's menu format.
// Fix: CONFIRMATION_PATTERN now also matches "1. Yes", "Esc to cancel".

describe('Bug #4 — confirmation pattern matches interactive menus', () => {
  it('matches numbered menu "1. Yes"', () => {
    expect(CONFIRMATION_PATTERN.test('❯ 1. Yes')).toBe(true);
  });

  it('matches "1. Yes" without arrow prefix', () => {
    expect(CONFIRMATION_PATTERN.test('1. Yes')).toBe(true);
  });

  it('matches "Esc to cancel"', () => {
    expect(CONFIRMATION_PATTERN.test('Esc to cancel')).toBe(true);
  });

  it('matches "Do you want to create"', () => {
    expect(CONFIRMATION_PATTERN.test('Do you want to create this file?')).toBe(true);
  });

  it('matches "Do you want to edit"', () => {
    expect(CONFIRMATION_PATTERN.test('Do you want to edit this file?')).toBe(true);
  });

  it('matches "Do you want to delete"', () => {
    expect(CONFIRMATION_PATTERN.test('Do you want to delete this file?')).toBe(true);
  });

  it('still matches traditional "Allow?" format', () => {
    expect(CONFIRMATION_PATTERN.test('Allow? (y/n)')).toBe(true);
  });

  it('still matches [Y/N] format', () => {
    expect(CONFIRMATION_PATTERN.test('[Y/N]')).toBe(true);
  });
});

// ─── Bug #5: Duplicate unknown permission from menu remnants after reset ────
// Root cause: After auto-approve reset, trailing menu fragments re-triggered unknown.
// Fix: 2-second cooldown window after reset suppresses unknown fallback.

describe('Bug #5 — cooldown suppresses false unknown after reset', () => {
  let parser;
  let detected;

  beforeEach(() => {
    detected = [];
    parser = new PermissionParser({
      projectRoot: '/home/user/project',
      sessionId: 'sess_reg5',
      project: 'test',
      onPermission: (e) => detected.push(e),
    });
  });

  it('does not emit unknown for menu remnants arriving within cooldown window', () => {
    // First: a real permission is detected
    parser.feed('Claude wants to write to src/file.js\n❯ 1. Yes\nEsc to cancel\n');
    expect(detected).toHaveLength(1);
    expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);

    // Parser is reset (as happens after auto-approve)
    parser.reset();

    // Menu remnants arrive in next PTY chunk — still within cooldown
    parser.feed('  2. Yes, allow all\n  3. No\nEsc to cancel\n');

    // Should NOT emit a second (unknown) permission
    expect(detected).toHaveLength(1);
  });

  it('does emit unknown after cooldown expires', async () => {
    // Detect a real permission
    parser.feed('Claude wants to write to src/file.js\n❯ 1. Yes\nEsc to cancel\n');
    expect(detected).toHaveLength(1);

    // Reset and override lastResetAt to simulate cooldown expiry
    parser.reset();
    parser._lastResetAt = Date.now() - 3000; // 3s ago, past the 2s cooldown

    // Now an unrecognized confirmation should trigger unknown
    parser.feed('Something unexpected\nEsc to cancel\n');
    expect(detected).toHaveLength(2);
    expect(detected[1].permissionType).toBe(PermissionType.UNKNOWN);
  });
});

// ─── Bug #6: Auto-approve sent before interactive menu rendered ─────────────
// Root cause: \r sent immediately on detection, before TUI menu was ready.
// Fix: 500ms setTimeout before writing \r or \x1b to PTY.
// Note: The actual timing is tested in E2E. Here we verify the code path uses setTimeout.

describe('Bug #6 — auto-approve uses delayed write', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.destroyAll();
  });

  it('does not write \\r to PTY immediately on auto-approve', () => {
    const session = manager.start('delay-project', {
      approvalEnvelope: {
        mode: 'scoped',
        projectRoot: '/tmp/bridge-v2-reg-test/delay-project',
        rules: {
          fileWrites: { withinProject: 'auto_approve', outsideProject: 'deny' },
        },
        defaults: { lowRisk: 'auto_approve', mediumRisk: 'require_review', highRisk: 'deny' },
      },
    });

    const writes = [];
    const origWrite = session.pty.write.bind(session.pty);
    session.pty.write = (data) => {
      writes.push({ data, time: Date.now() });
      return origWrite(data);
    };

    // Skip trust buffer by simulating tool-call detection
    session.pty.emit('data', 'Write(src/index.js)\n❯ 1. Yes\nEsc to cancel\n');

    // Immediately after feed — no \r written yet
    const immediateWrites = writes.filter(w => w.data === '\r');
    expect(immediateWrites).toHaveLength(0);

    // Advance past the 500ms delay
    vi.advanceTimersByTime(600);

    const delayedWrites = writes.filter(w => w.data === '\r');
    expect(delayedWrites.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Bug #7: start() blocking on completed sessions ────────────────────────
// Root cause: Only allowed overwrite from ENDED, not other terminal states.
// Fix: Check isTerminal instead of specific state.

describe('Bug #7 — start() allows overwrite for any terminal state', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/echo',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('allows restart after COMPLETED', async () => {
    const s1 = manager.start('restart-project', { instruction: 'first' });

    await new Promise((resolve) => {
      if (s1.pty.exited) return resolve();
      s1.pty.on('exit', resolve);
    });

    expect(s1.isTerminal).toBe(true);
    expect(s1.state).toBe(SessionState.COMPLETED);

    // Should not throw SESSION_EXISTS
    const s2 = manager.start('restart-project', { instruction: 'second' });
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.state).toBe(SessionState.RUNNING);
  });

  it('allows restart after FAILED', () => {
    const session = manager.start('fail-project');
    // Force into FAILED state
    session.transition(SessionState.FAILED);
    session.pty.destroy();

    const s2 = manager.start('fail-project', { instruction: 'retry' });
    expect(s2.state).toBe(SessionState.RUNNING);
  });

  it('allows restart after TIMED_OUT', () => {
    const session = manager.start('timeout-project');
    session.transition(SessionState.TIMED_OUT);
    session.pty.destroy();

    const s2 = manager.start('timeout-project', { instruction: 'retry' });
    expect(s2.state).toBe(SessionState.RUNNING);
  });

  it('still blocks restart for RUNNING session', () => {
    manager.start('running-project');
    try {
      manager.start('running-project');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_EXISTS');
    }
  });
});

// ─── Bug #8: activeCount counting completed sessions as active ──────────────
// Root cause: Used state != ENDED instead of isTerminal.
// Fix: activeCount iterates and checks !isTerminal.

describe('Bug #8 — activeCount excludes all terminal states', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('does not count COMPLETED sessions as active', async () => {
    // Use echo so it completes immediately
    const echoManager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/echo',
      usePipes: true,
    });

    const session = echoManager.start('count-project', { instruction: 'done' });

    await new Promise((resolve) => {
      if (session.pty.exited) return resolve();
      session.pty.on('exit', resolve);
    });

    expect(session.state).toBe(SessionState.COMPLETED);
    expect(echoManager.activeCount).toBe(0);
    echoManager.destroyAll();
  });

  it('does not count FAILED sessions as active', () => {
    const session = manager.start('fail-count');
    session.transition(SessionState.FAILED);
    expect(manager.activeCount).toBe(0);
  });

  it('does not count TIMED_OUT sessions as active', () => {
    const session = manager.start('timeout-count');
    session.transition(SessionState.TIMED_OUT);
    expect(manager.activeCount).toBe(0);
  });

  it('counts RUNNING sessions as active', () => {
    manager.start('active-count');
    expect(manager.activeCount).toBe(1);
  });

  it('counts WAITING_FOR_PERMISSION sessions as active', () => {
    const session = manager.start('perm-count');
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    expect(manager.activeCount).toBe(1);
  });
});

// ─── Bug #9: send()/end() using \n instead of \r ───────────────────────────
// Root cause: Bridge wrote \n (newline) which doesn't submit in Claude's TUI.
// Fix: send() appends \r, end() uses \r.

describe('Bug #9 — send() and end() use \\r for TUI submission', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-reg-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('send() appends \\r (not \\n) to the message', () => {
    const session = manager.start('send-project');
    const writes = [];
    const origWrite = session.pty.write.bind(session.pty);
    session.pty.write = (data) => {
      writes.push(data);
      return origWrite(data);
    };

    manager.send('send-project', 'hello world');

    const sendWrite = writes.find(w => w.includes('hello world'));
    expect(sendWrite).toBe('hello world\r');
    expect(sendWrite).not.toContain('\n');
  });

  it('end() sends wrap message with \\r', async () => {
    const session = manager.start('end-project');
    const writes = [];
    const origWrite = session.pty.write.bind(session.pty);
    session.pty.write = (data) => {
      writes.push(data);
      return origWrite(data);
    };

    await manager.end('end-project', { message: 'wrap up now' });

    const wrapWrite = writes.find(w => w.includes('wrap up now'));
    expect(wrapWrite).toBeDefined();
    expect(wrapWrite.endsWith('\r')).toBe(true);
    expect(wrapWrite).not.toContain('\n');
  });
});

// ─── Bug #10: False permission detection on tool-call announcements ─────────
// Root cause: Parser triggered on Write(...) announcement before confirmation existed.
// Fix: Require CONFIRMATION_PATTERN match before emitting any permission event.

describe('Bug #10 — tool-call announcements alone do not trigger permission', () => {
  let parser;
  let detected;

  beforeEach(() => {
    detected = [];
    parser = new PermissionParser({
      projectRoot: '/home/user/project',
      sessionId: 'sess_reg10',
      project: 'test',
      onPermission: (e) => detected.push(e),
    });
  });

  it('does not emit permission for Write(...) without confirmation', () => {
    parser.feed('Write(src/index.js)\n');
    expect(detected).toHaveLength(0);
  });

  it('does not emit permission for Edit(...) without confirmation', () => {
    parser.feed('Edit(src/main.js)\n');
    expect(detected).toHaveLength(0);
  });

  it('does not emit permission for Bash(...) without confirmation', () => {
    parser.feed('Bash(npm test)\n');
    expect(detected).toHaveLength(0);
  });

  it('does not emit permission for "Claude wants to write" without confirmation', () => {
    parser.feed('Claude wants to write to src/file.js\n');
    expect(detected).toHaveLength(0);
  });

  it('emits permission only after confirmation pattern arrives', () => {
    parser.feed('Write(src/index.js)\n');
    expect(detected).toHaveLength(0);

    // Now the actual menu renders
    parser.feed('❯ 1. Yes\n  2. Yes, allow all\nEsc to cancel\n');
    expect(detected).toHaveLength(1);
    expect(detected[0].target.path).toBe('src/index.js');
  });
});

// ─── Bug #11: ANSI cursor-right stripping eating spaces in arguments ────────
// Root cause: \x1b[1C (cursor right 1) was stripped to "" instead of " ".
// Fix: stripAnsi replaces \x1b[\d*C with space before stripping other sequences.

describe('Bug #11 — ANSI cursor-right replaced with space, not empty', () => {
  it('preserves space between "node" and "src/add.test.js" via cursor-right', () => {
    // Claude Code renders: node\x1b[1Csrc/add.test.js (cursor-right = visual gap)
    const raw = 'node\x1b[1Csrc/add.test.js';
    expect(stripAnsi(raw)).toBe('node src/add.test.js');
  });

  it('preserves multiple cursor-right sequences as spaces', () => {
    const raw = 'git\x1b[1Ccommit\x1b[1C-m\x1b[1C"msg"';
    expect(stripAnsi(raw)).toBe('git commit -m "msg"');
  });

  it('handles cursor-right with explicit column count', () => {
    // \x1b[3C = move cursor right 3 columns → one space
    const raw = 'token1\x1b[3Ctoken2';
    expect(stripAnsi(raw)).toBe('token1 token2');
  });

  it('handles cursor-right with no column number (defaults to 1)', () => {
    const raw = 'a\x1b[Cb';
    expect(stripAnsi(raw)).toBe('a b');
  });

  it('correctly parses command with cursor-right in permission prompt', () => {
    const parser = new PermissionParser({
      projectRoot: '/home/user/project',
      sessionId: 'sess_reg11',
      project: 'test',
      onPermission: () => {},
    });

    const detected = [];
    parser._onPermission = (e) => detected.push(e);

    // Simulate: "Claude wants to run: node\x1b[1Csrc/add.test.js" with confirmation
    parser.feed('Claude wants to run: node\x1b[1Csrc/add.test.js\n❯ 1. Yes\nEsc to cancel\n');
    expect(detected).toHaveLength(1);
    expect(detected[0].target.command).toBe('node src/add.test.js');
  });
});
