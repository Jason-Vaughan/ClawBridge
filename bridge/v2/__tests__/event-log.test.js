import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { EventLog } = require('../event-log');
const { EventKind } = require('../types');

describe('EventLog', () => {
  let log;

  beforeEach(() => {
    log = new EventLog();
  });

  afterEach(() => {
    log.cancelWaiters();
  });

  // ── Basic append and read ──

  describe('append', () => {
    it('starts empty', () => {
      expect(log.length).toBe(0);
      expect(log.cursor).toBe(0);
    });

    it('appends events with monotonic seq', () => {
      const e0 = log.append(EventKind.TEXT, { text: 'hello' });
      const e1 = log.append(EventKind.TEXT, { text: 'world' });

      expect(e0.seq).toBe(0);
      expect(e1.seq).toBe(1);
      expect(log.length).toBe(2);
      expect(log.cursor).toBe(2);
    });

    it('includes kind and timestamp in appended events', () => {
      const event = log.append(EventKind.LIFECYCLE, { fromState: 'starting', toState: 'running' });

      expect(event.kind).toBe('lifecycle');
      expect(event.timestamp).toBeDefined();
      expect(typeof event.timestamp).toBe('string');
      expect(event.fromState).toBe('starting');
      expect(event.toState).toBe('running');
    });
  });

  describe('appendText', () => {
    it('creates text events with stream field', () => {
      const event = log.appendText('some output');

      expect(event.kind).toBe('text');
      expect(event.text).toBe('some output');
      expect(event.stream).toBe('stdout');
    });

    it('allows custom stream name', () => {
      const event = log.appendText('error output', 'stderr');

      expect(event.stream).toBe('stderr');
    });
  });

  describe('appendLifecycle', () => {
    it('creates lifecycle events with state fields', () => {
      const event = log.appendLifecycle('starting', 'running');

      expect(event.kind).toBe('lifecycle');
      expect(event.fromState).toBe('starting');
      expect(event.toState).toBe('running');
    });
  });

  // ── Cursor-based reads ──

  describe('read', () => {
    beforeEach(() => {
      log.appendText('line 1');
      log.appendText('line 2');
      log.appendText('line 3');
      log.appendText('line 4');
      log.appendText('line 5');
    });

    it('reads all events from cursor 0', () => {
      const result = log.read(0);

      expect(result.events).toHaveLength(5);
      expect(result.cursorStart).toBe(0);
      expect(result.cursorEnd).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('reads events after a cursor position', () => {
      const result = log.read(3);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].seq).toBe(3);
      expect(result.events[1].seq).toBe(4);
      expect(result.cursorStart).toBe(3);
      expect(result.cursorEnd).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('returns empty array when cursor is at end', () => {
      const result = log.read(5);

      expect(result.events).toHaveLength(0);
      expect(result.cursorStart).toBe(5);
      expect(result.cursorEnd).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('clamps negative cursor to 0', () => {
      const result = log.read(-5);

      expect(result.events).toHaveLength(5);
      expect(result.cursorStart).toBe(0);
    });

    it('clamps cursor beyond end to length', () => {
      const result = log.read(100);

      expect(result.events).toHaveLength(0);
      expect(result.cursorStart).toBe(5);
      expect(result.cursorEnd).toBe(5);
    });

    it('defaults cursor to 0 when not provided', () => {
      const result = log.read();

      expect(result.events).toHaveLength(5);
      expect(result.cursorStart).toBe(0);
    });
  });

  // ── maxEvents limiting ──

  describe('maxEvents', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        log.appendText(`line ${i}`);
      }
    });

    it('limits the number of events returned', () => {
      const result = log.read(0, { maxEvents: 3 });

      expect(result.events).toHaveLength(3);
      expect(result.events[0].seq).toBe(0);
      expect(result.events[2].seq).toBe(2);
      expect(result.cursorEnd).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    it('returns hasMore=false when maxEvents >= available', () => {
      const result = log.read(0, { maxEvents: 100 });

      expect(result.events).toHaveLength(10);
      expect(result.hasMore).toBe(false);
    });

    it('works with cursor offset and maxEvents together', () => {
      const result = log.read(7, { maxEvents: 2 });

      expect(result.events).toHaveLength(2);
      expect(result.events[0].seq).toBe(7);
      expect(result.events[1].seq).toBe(8);
      expect(result.cursorStart).toBe(7);
      expect(result.cursorEnd).toBe(9);
      expect(result.hasMore).toBe(true);
    });

    it('pages through the full log with maxEvents', () => {
      const all = [];
      let cursor = 0;
      while (true) {
        const result = log.read(cursor, { maxEvents: 3 });
        all.push(...result.events);
        cursor = result.cursorEnd;
        if (!result.hasMore) break;
      }

      expect(all).toHaveLength(10);
      expect(all[0].seq).toBe(0);
      expect(all[9].seq).toBe(9);
    });
  });

  // ── Empty log behavior ──

  describe('empty log', () => {
    it('read returns empty result', () => {
      const result = log.read(0);

      expect(result.events).toHaveLength(0);
      expect(result.cursorStart).toBe(0);
      expect(result.cursorEnd).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('read with maxEvents returns empty result', () => {
      const result = log.read(0, { maxEvents: 10 });

      expect(result.events).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  // ── Long-poll (waitForEvents) ──

  describe('waitForEvents', () => {
    it('resolves immediately when events already exist past cursor', async () => {
      log.appendText('already here');

      const result = await log.waitForEvents(0, 5000);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].text).toBe('already here');
    });

    it('resolves when new event arrives during wait', async () => {
      const promise = log.waitForEvents(0, 5000);

      // Append after a short delay
      setTimeout(() => log.appendText('arrived'), 20);

      const result = await promise;

      expect(result.events.length).toBeGreaterThanOrEqual(1);
      expect(result.events[0].text).toBe('arrived');
    });

    it('resolves with empty result on timeout when no events arrive', async () => {
      const result = await log.waitForEvents(0, 50);

      expect(result.events).toHaveLength(0);
      expect(result.cursorStart).toBe(0);
      expect(result.cursorEnd).toBe(0);
    });

    it('respects maxEvents in long-poll', async () => {
      // Pre-populate with 3 events, then wait from cursor 0 with maxEvents 2
      log.appendText('one');
      log.appendText('two');
      log.appendText('three');

      const result = await log.waitForEvents(0, 5000, { maxEvents: 2 });

      expect(result.events).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('supports multiple concurrent waiters', async () => {
      const p1 = log.waitForEvents(0, 5000);
      const p2 = log.waitForEvents(0, 5000);

      setTimeout(() => log.appendText('shared event'), 20);

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.events).toHaveLength(1);
      expect(r2.events).toHaveLength(1);
    });

    it('waiter with cursor past existing events waits for new ones', async () => {
      log.appendText('old event');

      const promise = log.waitForEvents(1, 5000);

      setTimeout(() => log.appendText('new event'), 20);

      const result = await promise;

      expect(result.events).toHaveLength(1);
      expect(result.events[0].text).toBe('new event');
      expect(result.cursorStart).toBe(1);
    });
  });

  // ── cancelWaiters ──

  describe('cancelWaiters', () => {
    it('resolves pending waiters with current state', async () => {
      const promise = log.waitForEvents(0, 60000);

      // Cancel immediately
      log.cancelWaiters();

      const result = await promise;
      expect(result.events).toHaveLength(0);
    });
  });

  // ── toArray ──

  describe('toArray', () => {
    it('returns a copy of all events', () => {
      log.appendText('one');
      log.appendText('two');

      const arr = log.toArray();

      expect(arr).toHaveLength(2);
      // Verify it's a copy
      arr.push({ fake: true });
      expect(log.length).toBe(2);
    });
  });
});
