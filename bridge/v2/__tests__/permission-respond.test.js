import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { Session, SessionManager } = require('../sessions');
const { SessionState, EventKind, DecisionType } = require('../types');

// ─── Unit: Response Validation ───────────────────────────────────────────────

describe('SessionManager.respond() validation', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-respond';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('throws SESSION_NOT_FOUND for nonexistent project', () => {
    try {
      manager.respond('ghost', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('throws PERMISSION_ALREADY_RESOLVED when session is running (not waiting)', () => {
    manager.start('proj-a');
    try {
      manager.respond('proj-a', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('PERMISSION_ALREADY_RESOLVED');
    }
  });

  it('throws SESSION_ENDED when session is in completed state', () => {
    const session = manager.start('proj-a');
    // Force to completed via exit
    session.transition(SessionState.COMPLETED);
    try {
      manager.respond('proj-a', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws SESSION_ENDED when session is in failed state', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.FAILED);
    try {
      manager.respond('proj-a', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws SESSION_ENDED when session is ended', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.FAILED);
    session.transition(SessionState.ENDED);
    try {
      manager.respond('proj-a', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws PERMISSION_NOT_FOUND when permissionId does not match pending', () => {
    const session = manager.start('proj-a');
    // Simulate a pending permission
    session.pendingPermission = { id: 'perm_real123' };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    try {
      manager.respond('proj-a', 'perm_wrong', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('PERMISSION_NOT_FOUND');
    }
  });

  it('throws PERMISSION_NOT_FOUND when no pending permission exists', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    // pendingPermission is null
    try {
      manager.respond('proj-a', 'perm_abc', DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('PERMISSION_NOT_FOUND');
    }
  });

  it('throws INVALID_DECISION for unrecognized decision', () => {
    const session = manager.start('proj-a');
    session.pendingPermission = { id: 'perm_abc' };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    try {
      manager.respond('proj-a', 'perm_abc', 'approve_always');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_DECISION');
    }
  });
});

// ─── Unit: State Transitions on Respond ──────────────────────────────────────

describe('SessionManager.respond() state transitions', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-respond';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  /**
   * Helper: start a session and put it into waiting_for_permission state.
   * @param {string} project
   * @returns {{ session: Session, permissionId: string }}
   */
  function startAndWait(project) {
    const session = manager.start(project);
    const permissionId = `perm_${Date.now().toString(16)}`;
    session.pendingPermission = { id: permissionId };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    return { session, permissionId };
  }

  it('approve_once transitions from waiting_for_permission → running', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('deny transitions from waiting_for_permission → running', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.DENY);
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('abort_session transitions from waiting_for_permission → failed', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.ABORT_SESSION);
    expect(session.state).toBe(SessionState.FAILED);
  });

  it('clears pendingPermission after approve', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);
    expect(session.pendingPermission).toBeNull();
  });

  it('clears pendingPermission after deny', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.DENY);
    expect(session.pendingPermission).toBeNull();
  });

  it('clears pendingPermission after abort', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.ABORT_SESSION);
    expect(session.pendingPermission).toBeNull();
  });

  it('resets permission parser after respond', () => {
    const { session, permissionId } = startAndWait('proj-a');
    // Parser _pendingDetection should be reset
    session.permissionParser._pendingDetection = true;
    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);
    expect(session.permissionParser._pendingDetection).toBe(false);
  });
});

// ─── Unit: Decision Events in Event Log ──────────────────────────────────────

describe('SessionManager.respond() decision events', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-respond';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  function startAndWait(project) {
    const session = manager.start(project);
    const permissionId = `perm_${Date.now().toString(16)}`;
    session.pendingPermission = { id: permissionId };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    return { session, permissionId };
  }

  it('appends a decision event on approve', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const decisionEvent = manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE, {
      reason: 'Looks safe',
      actor: 'test-reviewer',
    });

    expect(decisionEvent.kind).toBe(EventKind.DECISION);
    expect(decisionEvent.permissionId).toBe(permissionId);
    expect(decisionEvent.decision).toBe(DecisionType.APPROVE_ONCE);
    expect(decisionEvent.actor).toBe('test-reviewer');
    expect(decisionEvent.reason).toBe('Looks safe');
    expect(decisionEvent.seq).toBeGreaterThanOrEqual(0);
    expect(decisionEvent.timestamp).toBeDefined();
  });

  it('appends a decision event on deny', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const decisionEvent = manager.respond('proj-a', permissionId, DecisionType.DENY);

    expect(decisionEvent.kind).toBe(EventKind.DECISION);
    expect(decisionEvent.decision).toBe(DecisionType.DENY);
    expect(decisionEvent.actor).toBe('nhe-itl'); // default actor
    expect(decisionEvent.reason).toBeNull();
  });

  it('appends a decision event on abort_session', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const decisionEvent = manager.respond('proj-a', permissionId, DecisionType.ABORT_SESSION, {
      reason: 'Dangerous operation',
    });

    expect(decisionEvent.kind).toBe(EventKind.DECISION);
    expect(decisionEvent.decision).toBe(DecisionType.ABORT_SESSION);
    expect(decisionEvent.reason).toBe('Dangerous operation');
  });

  it('decision event appears in event log', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);

    const events = session.eventLog.toArray();
    const decisionEvents = events.filter(e => e.kind === EventKind.DECISION);
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0].permissionId).toBe(permissionId);
  });

  it('decision event seq is monotonically ordered with other events', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const preDecisionCursor = session.eventLog.cursor;

    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);

    const events = session.eventLog.toArray();
    const decisionEvent = events.find(e => e.kind === EventKind.DECISION);
    expect(decisionEvent.seq).toBeGreaterThanOrEqual(preDecisionCursor);

    // All seqs should be monotonic
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1);
    }
  });
});

// ─── Unit: PTY stdin writes ──────────────────────────────────────────────────

describe('SessionManager.respond() PTY stdin', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-respond';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  function startAndWait(project) {
    const session = manager.start(project);
    const permissionId = `perm_${Date.now().toString(16)}`;
    session.pendingPermission = { id: permissionId };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    return { session, permissionId };
  }

  it('writes "y\\n" to PTY stdin on approve_once', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const writeSpy = vi.spyOn(session.pty, 'write');

    manager.respond('proj-a', permissionId, DecisionType.APPROVE_ONCE);

    expect(writeSpy).toHaveBeenCalledWith('\r');
  });

  it('writes "n\\n" to PTY stdin on deny', () => {
    const { session, permissionId } = startAndWait('proj-a');
    const writeSpy = vi.spyOn(session.pty, 'write');

    manager.respond('proj-a', permissionId, DecisionType.DENY);

    expect(writeSpy).toHaveBeenCalledWith('\x1b');
  });

  it('kills PTY on abort_session', () => {
    const { session, permissionId } = startAndWait('proj-a');
    manager.respond('proj-a', permissionId, DecisionType.ABORT_SESSION);

    // PTY should be killed — either exited already or will exit
    // The session should be in failed state
    expect(session.state).toBe(SessionState.FAILED);
  });
});

// ─── Integration: Full Permission Review Loop ────────────────────────────────

describe('Integration: permission → respond → continue', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-respond';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('full flow: start → permission detected → approve → session continues', () => {
    const session = manager.start('full-flow');

    // Simulate Claude Code emitting a permission prompt by feeding the parser directly
    const permPrompt = 'Claude wants to write to /tmp/bridge-v2-test-respond/full-flow/index.js\nAllow? [Y/n]';
    session.permissionParser.feed(permPrompt);

    // Session should be waiting for permission
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission).not.toBeNull();

    const permissionId = session.pendingPermission.id;

    // Verify permission event in log
    const permEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.PERMISSION);
    expect(permEvents).toHaveLength(1);

    // Respond with approval
    const decisionEvent = manager.respond('full-flow', permissionId, DecisionType.APPROVE_ONCE, {
      actor: 'test-nhe',
    });

    // Session should be back to running
    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.pendingPermission).toBeNull();
    expect(decisionEvent.decision).toBe(DecisionType.APPROVE_ONCE);

    // Decision event should be in the log
    const decisionEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.DECISION);
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0].permissionId).toBe(permissionId);
  });

  it('full flow: start → permission detected → deny → session continues', () => {
    const session = manager.start('deny-flow');

    session.permissionParser.feed('Claude wants to run: rm -rf /\nAllow? [Y/n]');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    const permissionId = session.pendingPermission.id;

    manager.respond('deny-flow', permissionId, DecisionType.DENY, {
      reason: 'Too dangerous',
    });

    // Deny transitions back to running (Claude Code may continue or exit)
    expect(session.state).toBe(SessionState.RUNNING);

    const decisionEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.DECISION);
    expect(decisionEvents[0].decision).toBe(DecisionType.DENY);
    expect(decisionEvents[0].reason).toBe('Too dangerous');
  });

  it('full flow: start → permission detected → abort → session failed', () => {
    const session = manager.start('abort-flow');

    session.permissionParser.feed('Claude wants to delete /etc/hosts\nAllow? [Y/n]');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    const permissionId = session.pendingPermission.id;

    manager.respond('abort-flow', permissionId, DecisionType.ABORT_SESSION);

    expect(session.state).toBe(SessionState.FAILED);
  });

  it('multiple permission prompts in sequence', () => {
    const session = manager.start('multi-perm');

    // First permission
    session.permissionParser.feed('Claude wants to write to /tmp/bridge-v2-test-respond/multi-perm/a.js\nAllow? [Y/n]');
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    const perm1Id = session.pendingPermission.id;

    manager.respond('multi-perm', perm1Id, DecisionType.APPROVE_ONCE);
    expect(session.state).toBe(SessionState.RUNNING);

    // Second permission
    session.permissionParser.feed('Claude wants to run: npm install express\nAllow? [Y/n]');
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    const perm2Id = session.pendingPermission.id;
    expect(perm2Id).not.toBe(perm1Id);

    manager.respond('multi-perm', perm2Id, DecisionType.APPROVE_ONCE);
    expect(session.state).toBe(SessionState.RUNNING);

    // Event log should have both permission and decision events
    const events = session.eventLog.toArray();
    const permEvents = events.filter(e => e.kind === EventKind.PERMISSION);
    const decisionEvents = events.filter(e => e.kind === EventKind.DECISION);
    expect(permEvents).toHaveLength(2);
    expect(decisionEvents).toHaveLength(2);
  });

  it('cannot respond twice to the same permission', () => {
    const session = manager.start('double-respond');

    session.permissionParser.feed('Claude wants to write to /tmp/bridge-v2-test-respond/double-respond/x.js\nAllow? [Y/n]');
    const permissionId = session.pendingPermission.id;

    manager.respond('double-respond', permissionId, DecisionType.APPROVE_ONCE);
    expect(session.state).toBe(SessionState.RUNNING);

    // Second respond should fail — session is now running, not waiting
    try {
      manager.respond('double-respond', permissionId, DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('PERMISSION_ALREADY_RESOLVED');
    }
  });

  it('late respond after prompt timeout returns PERMISSION_ALREADY_RESOLVED', () => {
    vi.useFakeTimers();
    const mgr = new SessionManager({
      projectsDir: '/tmp/bridge-v2-test-respond',
      claudeBin: '/bin/cat',
      usePipes: true,
      promptTimeoutMs: 5000,
    });

    const session = mgr.start('stale-perm');
    session.permissionParser.feed('Claude wants to write to /tmp/bridge-v2-test-respond/stale-perm/x.js\nAllow? [Y/n]');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    const permissionId = session.pendingPermission.id;

    // Let the prompt timer fire — auto-denies and transitions back to running
    vi.advanceTimersByTime(6000);

    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.pendingPermission).toBeNull();

    // Late respond should fail
    try {
      mgr.respond('stale-perm', permissionId, DecisionType.APPROVE_ONCE);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('PERMISSION_ALREADY_RESOLVED');
    }

    // Event log should contain the timeout denial
    const decisionEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.DECISION);
    expect(decisionEvents.length).toBe(1);
    expect(decisionEvents[0].actor).toBe('timeout');

    mgr.destroyAll();
    vi.useRealTimers();
  });

  it('event log ordering: lifecycle → permission → decision → lifecycle', () => {
    const session = manager.start('ordering');

    session.permissionParser.feed('Claude wants to edit /tmp/bridge-v2-test-respond/ordering/file.js\nAllow? [Y/n]');
    const permissionId = session.pendingPermission.id;

    manager.respond('ordering', permissionId, DecisionType.APPROVE_ONCE);

    const events = session.eventLog.toArray();
    // Filter to just lifecycle, permission, and decision events
    const significant = events.filter(e =>
      [EventKind.LIFECYCLE, EventKind.PERMISSION, EventKind.DECISION].includes(e.kind)
    );

    // Should be: starting→running, running→waiting, decision, waiting→running
    expect(significant.length).toBeGreaterThanOrEqual(4);

    // Find the permission and decision
    const permIdx = significant.findIndex(e => e.kind === EventKind.PERMISSION);
    const decIdx = significant.findIndex(e => e.kind === EventKind.DECISION);
    expect(permIdx).toBeLessThan(decIdx);

    // Lifecycle: waiting→running should come after the decision
    const resumeIdx = significant.findIndex(e =>
      e.kind === EventKind.LIFECYCLE &&
      e.fromState === SessionState.WAITING_FOR_PERMISSION &&
      e.toState === SessionState.RUNNING
    );
    expect(decIdx).toBeLessThan(resumeIdx);
  });
});
