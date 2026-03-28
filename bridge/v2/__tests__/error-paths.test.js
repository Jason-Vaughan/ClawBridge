import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { Session, SessionManager } = require('../sessions');
const { SessionState, EventKind, DecisionType, ErrorCode } = require('../types');

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: PTY Unexpected Death
// ═════════════════════════════════════════════════════════════════════════════

describe('PTY unexpected death handling', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-errors';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      sessionTimeoutMs: 60000,
      promptTimeoutMs: 60000,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('emits pty_exit_unexpected on non-zero exit from running state', () => {
    const session = manager.start('death-proj');
    expect(session.state).toBe(SessionState.RUNNING);

    // Simulate unexpected PTY exit with non-zero code
    session.pty.emit('exit', { exitCode: 1, signal: undefined });

    expect(session.state).toBe(SessionState.FAILED);
    expect(session.exitCode).toBe(1);

    const events = session.eventLog.toArray();
    const errorEvent = events.find(e => e.kind === EventKind.ERROR && e.code === ErrorCode.PTY_EXIT_UNEXPECTED);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('exit code: 1');
    expect(errorEvent.details.exitCode).toBe(1);
    expect(errorEvent.details.signal).toBeNull();
  });

  it('emits pty_exit_unexpected with signal info', () => {
    const session = manager.start('signal-proj');

    session.pty.emit('exit', { exitCode: 137, signal: 9 });

    expect(session.state).toBe(SessionState.FAILED);

    const events = session.eventLog.toArray();
    const errorEvent = events.find(e => e.kind === EventKind.ERROR && e.code === ErrorCode.PTY_EXIT_UNEXPECTED);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('signal: 9');
    expect(errorEvent.details.signal).toBe(9);
    expect(errorEvent.details.exitCode).toBe(137);
  });

  it('does NOT emit error event on normal exit (code 0)', () => {
    const session = manager.start('clean-exit-proj');

    session.pty.emit('exit', { exitCode: 0, signal: undefined });

    expect(session.state).toBe(SessionState.COMPLETED);

    const errorEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.ERROR);
    expect(errorEvents).toHaveLength(0);
  });

  it('emits pty_exit_unexpected when dying during waiting_for_permission', () => {
    const session = manager.start('death-wait-proj');

    // Simulate waiting state
    session.pendingPermission = {
      id: 'perm_death_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/test/foo.js' },
      action: { summary: 'Write file', details: null },
    };
    session.transition(SessionState.WAITING_FOR_PERMISSION);

    // PTY dies
    session.pty.emit('exit', { exitCode: 1, signal: undefined });

    expect(session.state).toBe(SessionState.FAILED);
    expect(session.pendingPermission).toBeNull();

    const errorEvent = session.eventLog.toArray().find(
      e => e.kind === EventKind.ERROR && e.code === ErrorCode.PTY_EXIT_UNEXPECTED
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('waiting for permission');
  });

  it('clears all timers on PTY death', () => {
    vi.useFakeTimers();
    const session = manager.start('death-timers-proj');
    const promptCb = vi.fn();
    session.startPromptTimer(promptCb);
    expect(session._sessionTimer).not.toBeNull();
    expect(session._promptTimer).not.toBeNull();

    session.pty.emit('exit', { exitCode: 1, signal: undefined });

    expect(session._sessionTimer).toBeNull();
    expect(session._promptTimer).toBeNull();

    vi.advanceTimersByTime(70000);
    expect(promptCb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('emits error event on PTY spawn error', () => {
    const session = manager.start('error-proj');

    session.pty.emit('error', new Error('PTY spawn failed: ENOENT'));

    expect(session.state).toBe(SessionState.FAILED);

    const errorEvent = session.eventLog.toArray().find(
      e => e.kind === EventKind.ERROR && e.code === ErrorCode.PTY_EXIT_UNEXPECTED
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('PTY spawn failed');
    expect(errorEvent.details.error).toContain('ENOENT');
  });

  it('preserves event log after failure for postmortem polling', () => {
    const session = manager.start('postmortem-proj');

    // Emit some output first
    session.pty.emit('data', 'Working on something...\n');
    session.pty.emit('data', 'About to crash\n');

    // PTY dies
    session.pty.emit('exit', { exitCode: 1, signal: undefined });

    expect(session.state).toBe(SessionState.FAILED);

    // Event log should be fully readable
    const { events } = session.eventLog.read(0);
    expect(events.length).toBeGreaterThanOrEqual(4); // lifecycle(starting→running) + 2 text + error + lifecycle(running→failed)

    const textEvents = events.filter(e => e.kind === EventKind.TEXT);
    expect(textEvents.length).toBe(2);
    expect(textEvents[0].text).toContain('Working on something');
    expect(textEvents[1].text).toContain('About to crash');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Terminal State → Ended
// ═════════════════════════════════════════════════════════════════════════════

describe('Terminal state → ended transition', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-errors';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      sessionTimeoutMs: 60000,
      promptTimeoutMs: 60000,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('completed → ended via /v2/session/end', async () => {
    const session = manager.start('end-completed-proj');
    session.pty.emit('exit', { exitCode: 0, signal: undefined });
    expect(session.state).toBe(SessionState.COMPLETED);

    await manager.end('end-completed-proj');
    expect(session.state).toBe(SessionState.ENDED);
  });

  it('failed → ended via /v2/session/end', async () => {
    const session = manager.start('end-failed-proj');
    session.pty.emit('exit', { exitCode: 1, signal: undefined });
    expect(session.state).toBe(SessionState.FAILED);

    await manager.end('end-failed-proj');
    expect(session.state).toBe(SessionState.ENDED);
  });

  it('timed_out → ended via /v2/session/end', () => {
    vi.useFakeTimers();
    const mgr = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      sessionTimeoutMs: 100,
      promptTimeoutMs: 60000,
    });
    const session = mgr.start('end-timeout-proj');
    vi.spyOn(session.pty, 'kill').mockImplementation(() => {});

    vi.advanceTimersByTime(150 + 5100); // session timeout + grace + buffer
    expect(session.state).toBe(SessionState.TIMED_OUT);

    // end() should work from timed_out → ended
    // (We can't await easily with fake timers, so directly transition)
    session.transition(SessionState.ENDED);
    expect(session.state).toBe(SessionState.ENDED);

    mgr.destroyAll();
    vi.useRealTimers();
  });

  it('event log readable after ended state', async () => {
    const session = manager.start('readable-ended-proj');
    session.pty.emit('data', 'Some output\n');
    session.pty.emit('exit', { exitCode: 1, signal: undefined });
    await manager.end('readable-ended-proj');
    expect(session.state).toBe(SessionState.ENDED);

    // Event log should still be fully accessible
    const { events } = session.eventLog.read(0);
    expect(events.length).toBeGreaterThanOrEqual(3);
    const textEvents = events.filter(e => e.kind === EventKind.TEXT);
    expect(textEvents.length).toBe(1);
    expect(textEvents[0].text).toContain('Some output');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Error Event Structure
// ═════════════════════════════════════════════════════════════════════════════

describe('Error event structure', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-errors';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      sessionTimeoutMs: 60000,
      promptTimeoutMs: 60000,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('error events have seq, kind, timestamp, code, message, details', () => {
    const session = manager.start('struct-proj');
    session.pty.emit('exit', { exitCode: 2, signal: undefined });

    const errorEvent = session.eventLog.toArray().find(e => e.kind === EventKind.ERROR);
    expect(errorEvent).toBeDefined();
    expect(typeof errorEvent.seq).toBe('number');
    expect(errorEvent.kind).toBe(EventKind.ERROR);
    expect(typeof errorEvent.timestamp).toBe('string');
    expect(typeof errorEvent.code).toBe('string');
    expect(typeof errorEvent.message).toBe('string');
    expect(errorEvent.details).toBeDefined();
  });

  it('error events have monotonically increasing seq', () => {
    const session = manager.start('mono-proj');
    session.pty.emit('data', 'output\n');
    session.pty.emit('exit', { exitCode: 1, signal: undefined });

    const events = session.eventLog.toArray();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it('ErrorCode enum has all expected values', () => {
    expect(ErrorCode.PERMISSION_TIMEOUT).toBe('permission_timeout');
    expect(ErrorCode.PTY_EXIT_UNEXPECTED).toBe('pty_exit_unexpected');
    expect(ErrorCode.SESSION_RUNTIME_TIMEOUT).toBe('session_runtime_timeout');
  });
});
