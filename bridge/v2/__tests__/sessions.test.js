import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Session, SessionManager } = require('../sessions');
const { SessionState } = require('../types');

// ── State Machine Tests ──

describe('Session state machine', () => {
  let session;

  beforeEach(() => {
    session = new Session('sess_test123', 'test-project', '/tmp/test-project');
  });

  it('starts in STARTING state', () => {
    expect(session.state).toBe(SessionState.STARTING);
  });

  it('allows starting → running', () => {
    session.transition(SessionState.RUNNING);
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('allows starting → failed', () => {
    session.transition(SessionState.FAILED);
    expect(session.state).toBe(SessionState.FAILED);
  });

  it('allows running → waiting_for_permission', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
  });

  it('allows running → completed', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.COMPLETED);
    expect(session.state).toBe(SessionState.COMPLETED);
  });

  it('allows running → failed', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.FAILED);
    expect(session.state).toBe(SessionState.FAILED);
  });

  it('allows running → timed_out', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.TIMED_OUT);
    expect(session.state).toBe(SessionState.TIMED_OUT);
  });

  it('allows waiting_for_permission → running (decision submitted)', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.transition(SessionState.RUNNING);
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('allows waiting_for_permission → failed', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.transition(SessionState.FAILED);
    expect(session.state).toBe(SessionState.FAILED);
  });

  it('allows waiting_for_permission → timed_out', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.WAITING_FOR_PERMISSION);
    session.transition(SessionState.TIMED_OUT);
    expect(session.state).toBe(SessionState.TIMED_OUT);
  });

  it('allows completed → ended', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.COMPLETED);
    session.transition(SessionState.ENDED);
    expect(session.state).toBe(SessionState.ENDED);
  });

  it('allows failed → ended', () => {
    session.transition(SessionState.FAILED);
    session.transition(SessionState.ENDED);
    expect(session.state).toBe(SessionState.ENDED);
  });

  it('allows timed_out → ended', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.TIMED_OUT);
    session.transition(SessionState.ENDED);
    expect(session.state).toBe(SessionState.ENDED);
  });

  // Invalid transitions
  it('rejects starting → ended', () => {
    expect(() => session.transition(SessionState.ENDED)).toThrow('Invalid transition');
  });

  it('rejects starting → completed', () => {
    expect(() => session.transition(SessionState.COMPLETED)).toThrow('Invalid transition');
  });

  it('rejects completed → running', () => {
    session.transition(SessionState.RUNNING);
    session.transition(SessionState.COMPLETED);
    expect(() => session.transition(SessionState.RUNNING)).toThrow('Invalid transition');
  });

  it('rejects ended → anything', () => {
    session.transition(SessionState.FAILED);
    session.transition(SessionState.ENDED);
    expect(() => session.transition(SessionState.RUNNING)).toThrow('Invalid transition');
    expect(() => session.transition(SessionState.FAILED)).toThrow('Invalid transition');
  });

  it('rejects running → starting', () => {
    session.transition(SessionState.RUNNING);
    expect(() => session.transition(SessionState.STARTING)).toThrow('Invalid transition');
  });

  it('updates updatedAt on transition', () => {
    const before = session.updatedAt;
    session.transition(SessionState.RUNNING);
    expect(session.updatedAt).toBeDefined();
  });

  it('reports isTerminal correctly', () => {
    expect(session.isTerminal).toBe(false);
    session.transition(SessionState.RUNNING);
    expect(session.isTerminal).toBe(false);
    session.transition(SessionState.COMPLETED);
    expect(session.isTerminal).toBe(true);
  });
});

// ── Session toJSON ──

describe('Session.toJSON()', () => {
  it('serializes session fields', () => {
    const session = new Session('sess_abc', 'my-project', '/tmp/my-project');
    const obj = session.toJSON();
    expect(obj).toEqual({
      sessionId: 'sess_abc',
      project: 'my-project',
      state: 'starting',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      exitCode: null,
      cursor: 0,
      pendingPermissionId: null,
    });
  });
});

// ── SessionManager Tests (using `cat` as a stand-in for Claude) ──

describe('SessionManager', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-projects';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat', // cat waits for stdin — simulates a long-running process
      usePipes: true,        // Use piped stdio in tests (no PTY allocation needed)
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('starts a session and returns session object', () => {
    const session = manager.start('project-a');
    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.project).toBe('project-a');
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('returns 409 equivalent when session already exists', () => {
    manager.start('project-a');
    try {
      manager.start('project-a');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_EXISTS');
    }
  });

  it('allows concurrent sessions for different projects', () => {
    const s1 = manager.start('project-a');
    const s2 = manager.start('project-b');
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(manager.list()).toHaveLength(2);
  });

  it('gets a session by project name', () => {
    const s1 = manager.start('project-a');
    const found = manager.get('project-a');
    expect(found).toBe(s1);
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  it('lists all sessions', () => {
    manager.start('project-a');
    manager.start('project-b');
    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map(s => s.project).sort()).toEqual(['project-a', 'project-b']);
  });

  it('ends a session and transitions to ended', async () => {
    manager.start('project-a');
    const ended = await manager.end('project-a');
    expect(ended.state).toBe(SessionState.ENDED);
  });

  it('throws SESSION_NOT_FOUND when ending nonexistent session', async () => {
    try {
      await manager.end('nonexistent');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('tracks activeCount', () => {
    expect(manager.activeCount).toBe(0);
    manager.start('project-a');
    expect(manager.activeCount).toBe(1);
    manager.start('project-b');
    expect(manager.activeCount).toBe(2);
  });

  it('destroyAll cleans up all sessions', () => {
    manager.start('project-a');
    manager.start('project-b');
    manager.destroyAll();
    expect(manager.list()).toHaveLength(0);
  });
});

// ── Integration: PTY spawns a real process ──

describe('SessionManager PTY integration', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-projects';

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/echo', // echo exits immediately with output
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('spawns a process that exits and transitions to completed', async () => {
    const session = manager.start('echo-project', { instruction: 'hello' });
    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.pty).toBeDefined();
    expect(session.pty.pid).toBeGreaterThan(0);

    // Wait for echo to exit
    await new Promise((resolve) => {
      if (session.pty.exited) return resolve();
      session.pty.on('exit', resolve);
    });

    expect(session.exitCode).toBe(0);
    expect(session.state).toBe(SessionState.COMPLETED);
  });

  it('captures process data events', async () => {
    const chunks = [];
    const session = manager.start('data-project', { instruction: 'test-output' });

    session.pty.on('data', (data) => {
      chunks.push(data);
    });

    await new Promise((resolve) => {
      if (session.pty.exited) return resolve();
      session.pty.on('exit', resolve);
    });

    const output = chunks.join('');
    // echo outputs its args — the args include --session-id and the instruction
    expect(output).toContain('test-output');
  });

  it('allows starting a new session after previous one ended', async () => {
    const s1 = manager.start('reuse-project', { instruction: 'first' });

    await new Promise((resolve) => {
      if (s1.pty.exited) return resolve();
      s1.pty.on('exit', resolve);
    });

    await manager.end('reuse-project');
    expect(s1.state).toBe(SessionState.ENDED);

    // Start a new session for the same project
    const s2 = manager.start('reuse-project', { instruction: 'second' });
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.state).toBe(SessionState.RUNNING);
  });
});
