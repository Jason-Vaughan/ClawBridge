'use strict';

const { EventKind } = require('./types');

/**
 * Append-only event log for a single v2 session.
 *
 * Events are stored with monotonically increasing sequence numbers (0-based).
 * Supports cursor-based reads, max-event limiting, and long-poll waiting.
 */
class EventLog {
  constructor() {
    /** @type {Array<object>} */
    this._events = [];
    /** @type {Array<{resolve: function, timer: NodeJS.Timeout|null}>} */
    this._waiters = [];
  }

  /**
   * Number of events in the log.
   * @returns {number}
   */
  get length() {
    return this._events.length;
  }

  /**
   * Current cursor position (sequence number of the next event that will be appended).
   * @returns {number}
   */
  get cursor() {
    return this._events.length;
  }

  /**
   * Append an event to the log. Assigns seq and timestamp automatically.
   * @param {string} kind - Event kind from EventKind
   * @param {object} data - Event payload (merged into the event object)
   * @returns {object} The appended event
   */
  append(kind, data = {}) {
    const event = {
      seq: this._events.length,
      kind,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this._events.push(event);
    this._notifyWaiters();
    return event;
  }

  /**
   * Append a text event (PTY stdout output).
   * @param {string} text - Raw text output
   * @param {string} [stream='stdout'] - Stream name
   * @returns {object} The appended event
   */
  appendText(text, stream = 'stdout') {
    return this.append(EventKind.TEXT, { text, stream });
  }

  /**
   * Append a lifecycle event (state transition).
   * @param {string} fromState - Previous state
   * @param {string} toState - New state
   * @returns {object} The appended event
   */
  appendLifecycle(fromState, toState) {
    return this.append(EventKind.LIFECYCLE, { fromState, toState });
  }

  /**
   * Read events from the log starting at the given cursor.
   * @param {number} [cursor=0] - Start position (inclusive)
   * @param {object} [options]
   * @param {number} [options.maxEvents] - Maximum number of events to return
   * @returns {{ events: object[], cursorStart: number, cursorEnd: number, hasMore: boolean }}
   */
  read(cursor = 0, options = {}) {
    const { maxEvents } = options;

    // Clamp cursor to valid range
    const start = Math.max(0, Math.min(cursor, this._events.length));

    let events = this._events.slice(start);
    let hasMore = false;

    if (maxEvents != null && maxEvents > 0 && events.length > maxEvents) {
      events = events.slice(0, maxEvents);
      hasMore = true;
    }

    const cursorEnd = start + events.length;

    return {
      events,
      cursorStart: start,
      cursorEnd,
      hasMore,
    };
  }

  /**
   * Wait for new events after the given cursor position, with a timeout.
   * Resolves immediately if events already exist past the cursor.
   * @param {number} cursor - Cursor position to wait from
   * @param {number} waitMs - Maximum time to wait in milliseconds
   * @param {object} [options]
   * @param {number} [options.maxEvents] - Maximum events to return
   * @returns {Promise<{ events: object[], cursorStart: number, cursorEnd: number, hasMore: boolean }>}
   */
  waitForEvents(cursor, waitMs, options = {}) {
    // If events already exist past the cursor, return immediately
    if (cursor < this._events.length) {
      return Promise.resolve(this.read(cursor, options));
    }

    return new Promise((resolve) => {
      const waiter = { resolve: null, timer: null };

      const done = () => {
        // Remove from waiters list
        const idx = this._waiters.indexOf(waiter);
        if (idx !== -1) this._waiters.splice(idx, 1);
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        resolve(this.read(cursor, options));
      };

      waiter.resolve = done;

      // Set timeout for long-poll
      waiter.timer = setTimeout(done, waitMs);

      this._waiters.push(waiter);
    });
  }

  /**
   * Notify all waiters that new events are available.
   * @private
   */
  _notifyWaiters() {
    const waiters = this._waiters.slice();
    for (const waiter of waiters) {
      if (waiter.resolve) {
        waiter.resolve();
      }
    }
  }

  /**
   * Get all events as a plain array (for serialization/debugging).
   * @returns {object[]}
   */
  toArray() {
    return this._events.slice();
  }

  /**
   * Reconstruct raw transcript from all text events.
   * Concatenates text fields from text events in sequence order.
   * @returns {string} Raw PTY output as a single string
   */
  getTranscript() {
    const parts = [];
    for (const event of this._events) {
      if (event.kind === EventKind.TEXT && event.text != null) {
        parts.push(event.text);
      }
    }
    return parts.join('');
  }

  /**
   * Cancel all pending waiters. Used during session cleanup.
   */
  cancelWaiters() {
    const waiters = this._waiters.slice();
    this._waiters.length = 0;
    for (const waiter of waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
      }
      // Resolve with current state so promises don't hang
      if (waiter.resolve) {
        waiter.resolve();
      }
    }
  }
}

module.exports = { EventLog };
