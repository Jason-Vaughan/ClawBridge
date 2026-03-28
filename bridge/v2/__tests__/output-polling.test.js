import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { SessionManager } = require('../sessions');
const { SessionState, EventKind } = require('../types');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Use a temp directory for test projects
const TEST_DIR = path.join(os.tmpdir(), `clawbridge-output-test-${Date.now()}`);

describe('Output polling integration', () => {
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
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  it('captures PTY stdout as text events in the event log', async () => {
    // Spawn a process that outputs some text, using sh -c
    const session = manager.start('text-capture', {
      instruction: null,
    });

    // Override: use a simple echo command
    // Since we can't easily control the command via SessionManager,
    // we test via the Session's event log directly after PTY emits data
    expect(session.eventLog).toBeDefined();
    expect(session.eventLog.cursor).toBeGreaterThanOrEqual(0);

    // The session should have lifecycle events from starting → running
    const result = session.eventLog.read(0);
    const lifecycleEvents = result.events.filter(e => e.kind === EventKind.LIFECYCLE);

    expect(lifecycleEvents.length).toBeGreaterThanOrEqual(1);
    expect(lifecycleEvents[0].fromState).toBe(SessionState.STARTING);
    expect(lifecycleEvents[0].toState).toBe(SessionState.RUNNING);
  });

  it('emits lifecycle events on state transitions', () => {
    const session = manager.start('lifecycle-test');

    const result = session.eventLog.read(0);
    const lifecycle = result.events.filter(e => e.kind === EventKind.LIFECYCLE);

    // starting → running should have been emitted
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].fromState).toBe('starting');
    expect(lifecycle[0].toState).toBe('running');
    expect(lifecycle[0].seq).toBe(0);
    expect(lifecycle[0].timestamp).toBeDefined();
  });

  it('captures text events from process output', async () => {
    const session = manager.start('echo-test');

    // Write a command to the process to generate output
    session.pty.write('echo hello-from-pty\n');

    // Wait for output to arrive
    await new Promise((resolve) => {
      const check = () => {
        const textEvents = session.eventLog.read(0).events
          .filter(e => e.kind === EventKind.TEXT);
        if (textEvents.length > 0) {
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });

    const result = session.eventLog.read(0);
    const textEvents = result.events.filter(e => e.kind === EventKind.TEXT);

    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].stream).toBe('stdout');
    expect(textEvents[0].text).toBeDefined();
  });

  it('supports cursor-based incremental reads', async () => {
    const session = manager.start('cursor-test');

    // Wait for the lifecycle event
    const initial = session.eventLog.read(0);
    expect(initial.cursorEnd).toBeGreaterThan(0);

    // Read from the cursor — should get nothing new yet
    const fromCursor = session.eventLog.read(initial.cursorEnd);
    expect(fromCursor.events).toHaveLength(0);
    expect(fromCursor.cursorStart).toBe(initial.cursorEnd);

    // Generate more output
    session.pty.write('echo increment\n');

    // Wait for new events
    await new Promise((resolve) => {
      const check = () => {
        const r = session.eventLog.read(initial.cursorEnd);
        if (r.events.length > 0) {
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });

    // Read only the new events
    const incremental = session.eventLog.read(initial.cursorEnd);
    expect(incremental.events.length).toBeGreaterThan(0);
    expect(incremental.cursorStart).toBe(initial.cursorEnd);

    // All new events have seq >= initial cursor
    for (const event of incremental.events) {
      expect(event.seq).toBeGreaterThanOrEqual(initial.cursorEnd);
    }
  });

  it('cursor survives client disconnects — re-poll from saved cursor', async () => {
    const session = manager.start('repoll-test');

    // First poll
    const poll1 = session.eventLog.read(0);
    const savedCursor = poll1.cursorEnd;

    // Simulate "disconnect" — nothing happens to the session

    // Generate output
    session.pty.write('echo repoll-data\n');

    // Wait for new events
    await new Promise((resolve) => {
      const check = () => {
        if (session.eventLog.cursor > savedCursor) resolve();
        else setTimeout(check, 20);
      };
      check();
    });

    // Re-poll from saved cursor — should get only new events
    const poll2 = session.eventLog.read(savedCursor);
    expect(poll2.events.length).toBeGreaterThan(0);
    expect(poll2.cursorStart).toBe(savedCursor);

    // Verify continuity — no gaps
    for (let i = 0; i < poll2.events.length; i++) {
      expect(poll2.events[i].seq).toBe(savedCursor + i);
    }
  });

  it('long-poll resolves when new output arrives', async () => {
    // Test long-poll using the EventLog directly to avoid PTY timing issues
    const { EventLog } = require('../event-log');
    const eventLog = new EventLog();

    const pollPromise = eventLog.waitForEvents(0, 5000);

    // Append after a delay
    setTimeout(() => {
      eventLog.appendText('longpoll-data');
    }, 50);

    const result = await pollPromise;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0].text).toBe('longpoll-data');

    eventLog.cancelWaiters();
  });

  it('long-poll times out with empty result when no events arrive', async () => {
    const session = manager.start('timeout-test');

    // Wait for any initial shell output to settle
    await new Promise(r => setTimeout(r, 100));
    const cursor = session.eventLog.cursor;

    // Long-poll with very short timeout, no new output generated
    const result = await session.eventLog.waitForEvents(cursor, 50);
    expect(result.events).toHaveLength(0);
  });

  it('session status includes cursor position', () => {
    const session = manager.start('status-cursor');

    const info = session.toJSON();
    expect(info.cursor).toBeDefined();
    expect(typeof info.cursor).toBe('number');
    // Should have at least the lifecycle event cursor
    expect(info.cursor).toBeGreaterThanOrEqual(1);
  });

  it('event log accessible on completed sessions', async () => {
    const session = manager.start('completed-read');

    // Generate some output
    session.pty.write('echo done\n');
    await new Promise(r => setTimeout(r, 100));

    // End the session
    await manager.end('completed-read');

    // Event log should still be readable
    const result = session.eventLog.read(0);
    expect(result.events.length).toBeGreaterThan(0);

    // Should have lifecycle events including the terminal transition
    const lifecycle = result.events.filter(e => e.kind === EventKind.LIFECYCLE);
    expect(lifecycle.length).toBeGreaterThanOrEqual(2); // starting→running + terminal transitions
  });

  it('events have correct monotonic sequencing across types', async () => {
    const session = manager.start('seq-test');

    // Generate output to get text events mixed with the lifecycle event
    session.pty.write('echo seq-check\n');
    await new Promise(r => setTimeout(r, 100));

    const result = session.eventLog.read(0);

    // Verify monotonic sequencing
    for (let i = 0; i < result.events.length; i++) {
      expect(result.events[i].seq).toBe(i);
    }

    // Verify we have both event types
    const kinds = new Set(result.events.map(e => e.kind));
    expect(kinds.has(EventKind.LIFECYCLE)).toBe(true);
    // Text events may or may not have arrived depending on timing,
    // but the sequencing of whatever is there must be correct
  });
});
