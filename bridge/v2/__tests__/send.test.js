import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { SessionManager } = require('../sessions');
const { SessionState, EventKind } = require('../types');

// ─── Unit: send() Validation ─────────────────────────────────────────────────

describe('SessionManager.send() validation', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-send';

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
      manager.send('ghost', 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('throws SESSION_ENDED when session is in completed state', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.COMPLETED);
    try {
      manager.send('proj-a', 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws SESSION_ENDED when session is in failed state', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.FAILED);
    try {
      manager.send('proj-a', 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws SESSION_ENDED when session is in timed_out state', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.TIMED_OUT);
    try {
      manager.send('proj-a', 'hello');
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
      manager.send('proj-a', 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_ENDED');
    }
  });

  it('throws SESSION_NOT_WRITABLE when session is waiting_for_permission', () => {
    const session = manager.start('proj-a');
    session.pendingPermission = { id: 'perm_abc' };
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    try {
      manager.send('proj-a', 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_NOT_WRITABLE');
    }
  });
});

// ─── Unit: send() Success Behavior ───────────────────────────────────────────

describe('SessionManager.send() success', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-send';

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

  it('returns accepted:true with cursor for running session', () => {
    const session = manager.start('proj-a');
    const result = manager.send('proj-a', 'do something');
    expect(result.accepted).toBe(true);
    expect(typeof result.cursor).toBe('number');
    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe(SessionState.RUNNING);
  });

  it('writes message + carriage return to PTY stdin', () => {
    const session = manager.start('proj-a');
    const writeSpy = vi.spyOn(session.pty, 'write');
    manager.send('proj-a', 'run tests');
    expect(writeSpy).toHaveBeenCalledWith('run tests\r');
  });

  it('returns current event log cursor position', () => {
    const session = manager.start('proj-a');
    // Log has lifecycle events from start (starting→running)
    const cursorBefore = session.eventLog.cursor;
    const result = manager.send('proj-a', 'build it');
    expect(result.cursor).toBe(cursorBefore);
  });

  it('does not throw if PTY has already exited', () => {
    const session = manager.start('proj-a');
    // Kill PTY to set exited=true, but keep session in running state
    session.pty.kill();
    // Wait a tick for exit to register, but send() should not throw
    const result = manager.send('proj-a', 'hello');
    expect(result.accepted).toBe(true);
  });

  it('session remains in running state after send', () => {
    manager.start('proj-a');
    manager.send('proj-a', 'instruction 1');
    manager.send('proj-a', 'instruction 2');
    const session = manager.get('proj-a');
    expect(session.state).toBe(SessionState.RUNNING);
  });
});

// ─── Integration: send() with PTY interaction ────────────────────────────────

describe('SessionManager.send() integration', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-send-int';

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

  it('send writes to PTY stdin immediately after start (before exit)', () => {
    const session = manager.start('proj-echo');
    // Spy immediately — before cat has a chance to exit
    const writeSpy = vi.spyOn(session.pty, 'write');

    // send() should succeed since session is still running at this point
    const result = manager.send('proj-echo', 'hello world');
    expect(result.accepted).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith('hello world\r');
    expect(result.cursor).toBeGreaterThanOrEqual(0);
  });

  it('multiple sends all write to PTY stdin in order', () => {
    const session = manager.start('proj-multi');
    const writeSpy = vi.spyOn(session.pty, 'write');

    manager.send('proj-multi', 'first');
    manager.send('proj-multi', 'second');
    manager.send('proj-multi', 'third');

    expect(writeSpy).toHaveBeenCalledTimes(3);
    expect(writeSpy).toHaveBeenNthCalledWith(1, 'first\r');
    expect(writeSpy).toHaveBeenNthCalledWith(2, 'second\r');
    expect(writeSpy).toHaveBeenNthCalledWith(3, 'third\r');
  });
});
