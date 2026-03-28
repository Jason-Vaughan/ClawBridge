import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { Session, SessionManager, DEFAULT_PROMPT_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS, GRACEFUL_SHUTDOWN_MS } = require('../sessions');
const { SessionState, EventKind, DecisionType, ErrorCode } = require('../types');

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Timer Management
// ═════════════════════════════════════════════════════════════════════════════

describe('Session timer management', () => {
  let session;

  beforeEach(() => {
    session = new Session('sess_timer01', 'timer-proj', '/tmp/timer-proj');
  });

  afterEach(() => {
    session.clearAllTimers();
  });

  it('has correct default timeout values', () => {
    expect(session.promptTimeoutMs).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    expect(session.sessionTimeoutMs).toBe(DEFAULT_SESSION_TIMEOUT_MS);
    expect(DEFAULT_PROMPT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_SESSION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('startPromptTimer fires callback after timeout', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    session.startPromptTimer(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(session.promptTimeoutMs);
    expect(cb).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('clearPromptTimer prevents callback from firing', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    session.startPromptTimer(cb);
    session.clearPromptTimer();
    vi.advanceTimersByTime(session.promptTimeoutMs + 1000);
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('startPromptTimer replaces previous timer', () => {
    vi.useFakeTimers();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    session.startPromptTimer(cb1);
    session.startPromptTimer(cb2);
    vi.advanceTimersByTime(session.promptTimeoutMs);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('startSessionTimer fires callback after timeout', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    session.startSessionTimer(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(session.sessionTimeoutMs);
    expect(cb).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('clearSessionTimer prevents callback from firing', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    session.startSessionTimer(cb);
    session.clearSessionTimer();
    vi.advanceTimersByTime(session.sessionTimeoutMs + 1000);
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clearAllTimers clears all active timers', () => {
    vi.useFakeTimers();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    session.startPromptTimer(cb1);
    session.startSessionTimer(cb2);
    session._killTimer = setTimeout(vi.fn(), 10000);
    session.clearAllTimers();
    vi.advanceTimersByTime(session.sessionTimeoutMs + 1000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('timer handle is nulled after firing', () => {
    vi.useFakeTimers();
    session.startPromptTimer(() => {});
    expect(session._promptTimer).not.toBeNull();
    vi.advanceTimersByTime(session.promptTimeoutMs);
    expect(session._promptTimer).toBeNull();
    vi.useRealTimers();
  });

  it('timer handle is nulled after clearing', () => {
    session.startPromptTimer(() => {});
    expect(session._promptTimer).not.toBeNull();
    session.clearPromptTimer();
    expect(session._promptTimer).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: SessionManager timeout config
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager timeout configuration', () => {
  it('uses provided default timeouts', () => {
    const manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-test-timeouts',
      claudeBin: '/bin/cat',
      usePipes: true,
      promptTimeoutMs: 1000,
      sessionTimeoutMs: 2000,
    });

    const session = manager.start('cfg-proj');
    expect(session.promptTimeoutMs).toBe(1000);
    expect(session.sessionTimeoutMs).toBe(2000);
    manager.destroyAll();
  });

  it('per-session timeout overrides manager defaults', () => {
    const manager = new SessionManager({
      projectsDir: '/tmp/bridge-v2-test-timeouts',
      claudeBin: '/bin/cat',
      usePipes: true,
      promptTimeoutMs: 1000,
      sessionTimeoutMs: 2000,
    });

    const session = manager.start('override-proj', {
      promptTimeout: 500,
      timeout: 800,
    });
    expect(session.promptTimeoutMs).toBe(500);
    expect(session.sessionTimeoutMs).toBe(800);
    manager.destroyAll();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Prompt Timeout
// ═════════════════════════════════════════════════════════════════════════════

describe('Prompt-wait timeout integration', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-timeouts';

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      promptTimeoutMs: 100,
      sessionTimeoutMs: 60000, // large enough to not interfere
    });
  });

  afterEach(() => {
    manager.destroyAll();
    vi.useRealTimers();
  });

  it('auto-denies pending permission on prompt timeout', () => {
    const session = manager.start('timeout-proj');

    // Simulate a permission prompt requiring review (no envelope = all require review)
    const permEvent = {
      id: 'perm_timeout_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/bridge-v2-test-timeouts/timeout-proj/src/foo.js' },
      action: { summary: 'Write file', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };

    // Manually trigger the onPermission callback to simulate detection
    session.pendingPermission = permEvent;
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.startPromptTimer(() => {
      manager._handlePromptTimeout(session);
    });

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);

    // Advance past the prompt timeout
    vi.advanceTimersByTime(150);

    // Should have transitioned back to running
    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.pendingPermission).toBeNull();

    // Check error event was emitted
    const events = session.eventLog.toArray();
    const errorEvent = events.find(e => e.kind === EventKind.ERROR && e.code === ErrorCode.PERMISSION_TIMEOUT);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.details.permissionId).toBe('perm_timeout_001');

    // Check denial decision event
    const decisionEvent = events.find(e => e.kind === EventKind.DECISION && e.actor === 'timeout');
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent.decision).toBe(DecisionType.DENY);
    expect(decisionEvent.permissionId).toBe('perm_timeout_001');
  });

  it('does not fire prompt timeout if permission is resolved before expiry', () => {
    const session = manager.start('notimeout-proj');

    // Set up waiting state with a pending permission
    session.pendingPermission = {
      id: 'perm_notimeout_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/test/src/foo.js' },
      action: { summary: 'Write file', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.startPromptTimer(() => {
      manager._handlePromptTimeout(session);
    });

    // Respond before timeout
    manager.respond('notimeout-proj', 'perm_notimeout_001', DecisionType.APPROVE_ONCE);
    expect(session.state).toBe(SessionState.RUNNING);

    // Advance past the timeout — should not cause issues
    vi.advanceTimersByTime(200);
    expect(session.state).toBe(SessionState.RUNNING);

    // No timeout error event should exist
    const errorEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.ERROR);
    expect(errorEvents).toHaveLength(0);
  });

  it('prompt timeout does nothing if session already in terminal state', () => {
    const session = manager.start('terminal-proj');

    session.pendingPermission = {
      id: 'perm_terminal_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/test/src/foo.js' },
      action: { summary: 'Write file', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.startPromptTimer(() => {
      manager._handlePromptTimeout(session);
    });

    // Force session to failed before timeout
    session.transition(SessionState.FAILED);

    const eventsBeforeTimeout = session.eventLog.toArray().length;
    vi.advanceTimersByTime(200);

    // No new events should be added
    expect(session.eventLog.toArray().length).toBe(eventsBeforeTimeout);
    expect(session.state).toBe(SessionState.FAILED);
  });

  it('writes "n" to PTY stdin on prompt timeout', () => {
    const session = manager.start('stdin-deny-proj');

    // Spy on PTY write
    const writeSpy = vi.spyOn(session.pty, 'write');

    session.pendingPermission = {
      id: 'perm_stdin_001',
      kind: 'permission',
      permissionType: 'shell_command',
      risk: 'medium',
      withinProject: true,
      target: { command: 'rm -rf /' },
      action: { summary: 'Run command', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.startPromptTimer(() => {
      manager._handlePromptTimeout(session);
    });

    vi.advanceTimersByTime(150);

    // Verify Escape was written to PTY stdin to cancel the permission prompt
    const escWrites = writeSpy.mock.calls.filter(([data]) => data === '\x1b');
    expect(escWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('sets timeoutAt on pending permission when requiring review', () => {
    const session = manager.start('timeoutat-proj');

    // Simulate a permission that requires review (no envelope)
    session.pendingPermission = {
      id: 'perm_ta_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/test/src/foo.js' },
      action: { summary: 'Write file', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };
    // The timeoutAt should be set by the onPermission callback in real flow
    // Here we verify the toJSON includes it when set
    session.pendingPermission.timeoutAt = new Date(Date.now() + 100).toISOString();

    const json = session.toJSON();
    expect(json.pendingPermissionId).toBe('perm_ta_001');
    expect(json.permissionTimeoutAt).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Session Runtime Timeout
// ═════════════════════════════════════════════════════════════════════════════

describe('Session runtime timeout integration', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-timeouts';

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
      promptTimeoutMs: 60000, // large enough to not interfere
      sessionTimeoutMs: 200,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    vi.useRealTimers();
  });

  it('emits session_runtime_timeout error event on timeout', () => {
    const session = manager.start('runtime-proj');
    expect(session.state).toBe(SessionState.RUNNING);

    vi.advanceTimersByTime(250);

    // Check error event was emitted
    const events = session.eventLog.toArray();
    const errorEvent = events.find(e => e.kind === EventKind.ERROR && e.code === ErrorCode.SESSION_RUNTIME_TIMEOUT);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.details.timeoutMs).toBe(200);
  });

  it('sends SIGINT for graceful interruption', () => {
    const session = manager.start('sigint-proj');
    const killSpy = vi.spyOn(session.pty, 'kill');

    vi.advanceTimersByTime(250);

    // Should have called kill with SIGINT
    const sigintCalls = killSpy.mock.calls.filter(([sig]) => sig === 'SIGINT');
    expect(sigintCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('force-kills PTY after grace period if still alive', () => {
    const session = manager.start('forcekill-proj');
    const killSpy = vi.spyOn(session.pty, 'kill').mockImplementation(() => {
      // Don't actually kill — simulate process not responding
    });

    // Trigger session timeout
    vi.advanceTimersByTime(250);

    // Advance past grace period
    vi.advanceTimersByTime(GRACEFUL_SHUTDOWN_MS + 100);

    // Should have called kill with SIGKILL
    const sigkillCalls = killSpy.mock.calls.filter(([sig]) => sig === 'SIGKILL');
    expect(sigkillCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('transitions to timed_out after kill timer fires', () => {
    const session = manager.start('timedout-proj');
    // Mock kill so PTY doesn't actually exit
    vi.spyOn(session.pty, 'kill').mockImplementation(() => {});

    vi.advanceTimersByTime(250);

    // After grace period + kill timer
    vi.advanceTimersByTime(GRACEFUL_SHUTDOWN_MS + 100);

    expect(session.state).toBe(SessionState.TIMED_OUT);
  });

  it('clears prompt timer when session times out', () => {
    const session = manager.start('clear-prompt-proj');

    // Set up a prompt timer
    const promptCb = vi.fn();
    session.startPromptTimer(promptCb);

    // Trigger session timeout
    vi.advanceTimersByTime(250);

    // Advance well past prompt timeout — callback should not fire
    vi.advanceTimersByTime(60000 + GRACEFUL_SHUTDOWN_MS);
    expect(promptCb).not.toHaveBeenCalled();
  });

  it('does nothing if session already terminal', () => {
    const session = manager.start('already-terminal-proj');
    session.transition(SessionState.COMPLETED);
    const eventsCount = session.eventLog.toArray().length;

    vi.advanceTimersByTime(250);

    // No new error events
    const errorEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.ERROR);
    expect(errorEvents).toHaveLength(0);
  });

  it('session timeout while waiting_for_permission clears pending permission', () => {
    const session = manager.start('timeout-perm-proj');
    vi.spyOn(session.pty, 'kill').mockImplementation(() => {});

    // Simulate waiting state
    session.pendingPermission = { id: 'perm_rt_001' };
    session.transition(SessionState.WAITING_FOR_PERMISSION);

    // Trigger session timeout
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(GRACEFUL_SHUTDOWN_MS + 100);

    expect(session.pendingPermission).toBeNull();
    expect(session.state).toBe(SessionState.TIMED_OUT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Timer cleanup
// ═════════════════════════════════════════════════════════════════════════════

describe('Timer cleanup', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-timeouts';

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  it('end() clears all timers', async () => {
    const session = manager.start('cleanup-end-proj');
    const promptCb = vi.fn();
    session.startPromptTimer(promptCb);

    await manager.end('cleanup-end-proj');

    vi.advanceTimersByTime(70000);
    expect(promptCb).not.toHaveBeenCalled();
    expect(session._promptTimer).toBeNull();
    expect(session._sessionTimer).toBeNull();
  });

  it('destroyAll() clears all timers for all sessions', () => {
    const s1 = manager.start('cleanup-d1');
    const s2 = manager.start('cleanup-d2');
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    s1.startPromptTimer(cb1);
    s2.startPromptTimer(cb2);

    manager.destroyAll();

    vi.advanceTimersByTime(70000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('session timers cleared on normal PTY exit', () => {
    const session = manager.start('cleanup-exit-proj');
    expect(session._sessionTimer).not.toBeNull();

    // Simulate normal PTY exit
    session.pty.emit('exit', { exitCode: 0, signal: undefined });

    expect(session._sessionTimer).toBeNull();
    expect(session._promptTimer).toBeNull();
  });

  it('respond() clears prompt timer', () => {
    const session = manager.start('cleanup-respond-proj');

    session.pendingPermission = {
      id: 'perm_cr_001',
      kind: 'permission',
      permissionType: 'file_write',
      risk: 'low',
      withinProject: true,
      target: { path: '/tmp/test/src/foo.js' },
      action: { summary: 'Write file', details: null },
      policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
    };
    session.transition(SessionState.WAITING_FOR_PERMISSION);

    const promptCb = vi.fn();
    session.startPromptTimer(promptCb);
    expect(session._promptTimer).not.toBeNull();

    manager.respond('cleanup-respond-proj', 'perm_cr_001', DecisionType.APPROVE_ONCE);

    expect(session._promptTimer).toBeNull();
    vi.advanceTimersByTime(70000);
    expect(promptCb).not.toHaveBeenCalled();
  });
});
