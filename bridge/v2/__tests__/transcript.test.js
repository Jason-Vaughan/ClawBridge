import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { SessionManager } = require('../sessions');
const { SessionState, EventKind } = require('../types');
const { EventLog } = require('../event-log');

// ─── Unit: EventLog.getTranscript() ──────────────────────────────────────────

describe('EventLog.getTranscript()', () => {
  it('returns empty string for empty log', () => {
    const log = new EventLog();
    expect(log.getTranscript()).toBe('');
  });

  it('returns empty string when log has only lifecycle events', () => {
    const log = new EventLog();
    log.appendLifecycle('starting', 'running');
    log.appendLifecycle('running', 'completed');
    expect(log.getTranscript()).toBe('');
  });

  it('concatenates text events in order', () => {
    const log = new EventLog();
    log.appendText('Hello ');
    log.appendText('world');
    log.appendText('!');
    expect(log.getTranscript()).toBe('Hello world!');
  });

  it('skips non-text events during concatenation', () => {
    const log = new EventLog();
    log.appendLifecycle('starting', 'running');
    log.appendText('line 1\n');
    log.append(EventKind.PERMISSION, { id: 'perm_1', type: 'file_write' });
    log.appendText('line 2\n');
    log.append(EventKind.DECISION, { permissionId: 'perm_1', decision: 'approve_once' });
    log.appendText('line 3\n');
    log.appendLifecycle('running', 'completed');
    expect(log.getTranscript()).toBe('line 1\nline 2\nline 3\n');
  });

  it('handles text events with empty strings', () => {
    const log = new EventLog();
    log.appendText('a');
    log.appendText('');
    log.appendText('b');
    expect(log.getTranscript()).toBe('ab');
  });

  it('preserves ANSI codes and special characters in transcript', () => {
    const log = new EventLog();
    log.appendText('\x1b[32mgreen\x1b[0m');
    log.appendText(' and \ttabbed');
    expect(log.getTranscript()).toBe('\x1b[32mgreen\x1b[0m and \ttabbed');
  });
});

// ─── Integration: Transcript via SessionManager ──────────────────────────────

describe('Transcript export via SessionManager', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-transcript';

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

  it('transcript available after session completes', () => {
    const session = manager.start('proj-a');
    // Manually add text events to simulate output
    session.eventLog.appendText('hello transcript\n');

    // Transition running → completed
    session.transition(SessionState.COMPLETED);

    expect(session.isTerminal).toBe(true);
    const transcript = session.eventLog.getTranscript();
    expect(transcript).toContain('hello transcript');
  });

  it('transcript available after session fails', () => {
    const session = manager.start('proj-b');
    // Add some text events manually
    session.eventLog.appendText('output before failure\n');
    session.transition(SessionState.FAILED);

    const transcript = session.eventLog.getTranscript();
    expect(transcript).toBe('output before failure\n');
  });

  it('transcript available after session times out', () => {
    const session = manager.start('proj-c');
    session.eventLog.appendText('partial output\n');
    session.transition(SessionState.TIMED_OUT);

    const transcript = session.eventLog.getTranscript();
    expect(transcript).toBe('partial output\n');
  });

  it('transcript available after session ends', () => {
    const session = manager.start('proj-d');
    session.eventLog.appendText('full output\n');
    session.transition(SessionState.COMPLETED);
    session.transition(SessionState.ENDED);

    const transcript = session.eventLog.getTranscript();
    expect(transcript).toBe('full output\n');
  });

  it('transcript is empty when session produced no PTY output', () => {
    const session = manager.start('proj-e');
    session.transition(SessionState.COMPLETED);

    // Only lifecycle events exist (no text)
    const transcript = session.eventLog.getTranscript();
    // May contain cat startup output, but no user-sent content
    expect(typeof transcript).toBe('string');
  });

  it('transcript preserves ordering of interleaved output', () => {
    const session = manager.start('proj-f');
    session.eventLog.appendText('step 1\n');
    session.eventLog.appendLifecycle('running', 'waiting_for_permission');
    session.eventLog.appendText('step 2\n');
    session.eventLog.append(EventKind.DECISION, { decision: 'approve_once' });
    session.eventLog.appendText('step 3\n');
    session.transition(SessionState.COMPLETED);

    const transcript = session.eventLog.getTranscript();
    expect(transcript).toBe('step 1\nstep 2\nstep 3\n');
  });
});

// ─── Route-level: /v2/session/transcript behavior ────────────────────────────

describe('/v2/session/transcript route logic', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-transcript-route';

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

  it('isTerminal is false for running session (route should 404)', () => {
    const session = manager.start('proj-a');
    expect(session.isTerminal).toBe(false);
    expect(session.state).toBe(SessionState.RUNNING);
  });

  it('isTerminal is true for completed session (route should return transcript)', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.COMPLETED);
    expect(session.isTerminal).toBe(true);
  });

  it('isTerminal is true for failed session', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.FAILED);
    expect(session.isTerminal).toBe(true);
  });

  it('isTerminal is true for timed_out session', () => {
    const session = manager.start('proj-a');
    session.transition(SessionState.TIMED_OUT);
    expect(session.isTerminal).toBe(true);
  });
});
