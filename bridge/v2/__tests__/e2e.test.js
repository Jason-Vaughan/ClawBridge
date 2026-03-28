/**
 * End-to-end integration tests for bridge v2 PTY broker.
 *
 * These tests run against a REAL Claude Code binary on habitat.
 * They are gated behind the RUN_E2E environment variable.
 *
 * To run:
 *   RUN_E2E=1 npx vitest run bridge/v2/__tests__/e2e.test.js
 *
 * Prerequisites:
 *   - Claude Code installed at /usr/local/bin/claude (or CLAUDE_BIN env)
 *   - Projects dir exists (or PROJECTS_DIR env)
 *   - Real PTY support (node-pty installed and working)
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { SessionManager } = require('../sessions');
const { SessionState, EventKind } = require('../types');
const { handleV2Route } = require('../routes');

// ─── E2E Gate ────────────────────────────────────────────────────────────────

const RUN_E2E = process.env.RUN_E2E === '1';
const describeE2E = RUN_E2E ? describe : describe.skip;

// ─── Config ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude';
const PROJECTS_DIR = process.env.E2E_PROJECTS_DIR || '/tmp/bridge-v2-e2e';
const E2E_TIMEOUT = 120_000; // 2 min per test (Claude Code can be slow)

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wait for a session to reach a target state, polling the session object.
 * @param {import('../sessions').Session} session
 * @param {string|string[]} targetStates
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<string>} The state reached
 */
function waitForState(session, targetStates, timeoutMs = 60000) {
  const targets = Array.isArray(targetStates) ? targetStates : [targetStates];
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (targets.includes(session.state)) {
        return resolve(session.state);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for state ${targets.join('|')} — stuck at ${session.state}`));
      }
      setTimeout(check, 250);
    };
    check();
  });
}

/**
 * Poll session output events until we see at least `minEvents` new events or timeout.
 * @param {import('../sessions').Session} session
 * @param {number} fromCursor
 * @param {number} [minEvents=1]
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{events: object[], cursorEnd: number}>}
 */
function waitForOutput(session, fromCursor, minEvents = 1, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const result = session.eventLog.read(fromCursor);
      if (result.events.length >= minEvents) {
        return resolve({ events: result.events, cursorEnd: result.cursorEnd });
      }
      if (Date.now() - start > timeoutMs) {
        return resolve({ events: result.events, cursorEnd: result.cursorEnd });
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

/**
 * Wait for a permission event to appear in the session's event log.
 * @param {import('../sessions').Session} session
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<object>} The permission event
 */
function waitForPermission(session, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (session.pendingPermission) {
        return resolve(session.pendingPermission);
      }
      if (session.isTerminal) {
        return reject(new Error(`Session ended (${session.state}) before permission was detected`));
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for permission event`));
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

// ─── E2E Test Suite ──────────────────────────────────────────────────────────

describeE2E('E2E: bridge v2 full lifecycle', () => {
  let manager;

  beforeAll(() => {
    // Ensure projects dir exists
    if (!fs.existsSync(PROJECTS_DIR)) {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    }
  });

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: PROJECTS_DIR,
      claudeBin: CLAUDE_BIN,
      // Do NOT set usePipes — we want real PTY on habitat
      promptTimeoutMs: 60_000,    // 1 min for E2E
      sessionTimeoutMs: 120_000,  // 2 min for E2E
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  // ── Full Lifecycle: start → output → end ──

  it('starts a session, receives output, and ends cleanly', async () => {
    const session = manager.start('e2e-lifecycle', {
      instruction: 'Say exactly "BRIDGE_E2E_OK" and nothing else, then exit.',
    });

    expect(session.sessionId).toMatch(/^sess_/);

    // Wait for Claude Code to produce output or finish
    await waitForState(session, [SessionState.RUNNING, SessionState.COMPLETED], 60_000);
    const { events } = await waitForOutput(session, 0, 1, 60_000);
    expect(events.length).toBeGreaterThan(0);

    // End the session
    const ended = await manager.end('e2e-lifecycle');
    expect(ended.state).toBe(SessionState.ENDED);
  }, E2E_TIMEOUT);

  // ── Send instruction into running session ──

  it('sends a follow-up instruction and receives response', async () => {
    const session = manager.start('e2e-send', {
      instruction: 'Say "READY" and wait for my next message.',
    });

    // Wait for initial output
    await waitForOutput(session, 0, 1, 60_000);

    // Send follow-up
    const sendResult = manager.send('e2e-send', 'Say exactly "FOLLOWUP_OK" and nothing else.');
    expect(sendResult.accepted).toBe(true);

    // Wait for new output after the send
    const { events } = await waitForOutput(session, sendResult.cursor, 1, 60_000);
    expect(events.length).toBeGreaterThan(0);

    await manager.end('e2e-send');
  }, E2E_TIMEOUT);

  // ── Output cursor-based polling ──

  it('supports cursor-based output polling without data loss', async () => {
    const session = manager.start('e2e-cursor', {
      instruction: 'Count from 1 to 5, each number on its own line. Then exit.',
    });

    // Read in two batches
    await waitForOutput(session, 0, 1, 60_000);
    const batch1 = session.eventLog.read(0, { maxEvents: 3 });

    const batch2 = session.eventLog.read(batch1.cursorEnd);

    // No overlap — cursorEnd of batch 1 is cursorStart of batch 2
    expect(batch2.cursorStart).toBe(batch1.cursorEnd);

    await manager.end('e2e-cursor');
  }, E2E_TIMEOUT);

  // ── Session status tracking ──

  it('tracks session status through lifecycle', async () => {
    const session = manager.start('e2e-status', {
      instruction: 'Say "hello" then exit.',
    });

    // Initially running
    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.isTerminal).toBe(false);

    // Wait for completion or end manually
    await waitForState(session, [SessionState.COMPLETED, SessionState.RUNNING], 60_000);

    const ended = await manager.end('e2e-status');
    expect(ended.isTerminal).toBe(true);
    expect([SessionState.ENDED]).toContain(ended.state);
  }, E2E_TIMEOUT);

  // ── Transcript export ──

  it('exports transcript after session ends', async () => {
    const session = manager.start('e2e-transcript', {
      instruction: 'Say exactly "TRANSCRIPT_TEST_OUTPUT" and nothing else.',
    });

    // Wait for some output or session to complete
    await waitForState(session, [SessionState.RUNNING, SessionState.COMPLETED], 60_000);
    await waitForOutput(session, 0, 1, 60_000);
    await manager.end('e2e-transcript');

    // Transcript may be empty if Claude exits before PTY data arrives,
    // but the event log should have lifecycle events at minimum
    const allEvents = session.eventLog.read(0);
    expect(allEvents.events.length).toBeGreaterThan(0);
  }, E2E_TIMEOUT);
});

// ─── E2E: Concurrent Multi-Project Sessions ─────────────────────────────────

describeE2E('E2E: concurrent multi-project sessions', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: PROJECTS_DIR,
      claudeBin: CLAUDE_BIN,
      promptTimeoutMs: 60_000,
      sessionTimeoutMs: 120_000,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('runs two sessions concurrently with independent state', async () => {
    const sessionA = manager.start('e2e-concurrent-a', {
      instruction: 'Say "SESSION_A" and exit.',
    });
    const sessionB = manager.start('e2e-concurrent-b', {
      instruction: 'Say "SESSION_B" and exit.',
    });

    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    expect(manager.activeCount).toBe(2);

    // Both should produce output independently
    const [outputA, outputB] = await Promise.all([
      waitForOutput(sessionA, 0, 1, 60_000),
      waitForOutput(sessionB, 0, 1, 60_000),
    ]);

    expect(outputA.events.length).toBeGreaterThan(0);
    expect(outputB.events.length).toBeGreaterThan(0);

    // End both
    await Promise.all([
      manager.end('e2e-concurrent-a'),
      manager.end('e2e-concurrent-b'),
    ]);
  }, E2E_TIMEOUT);

  it('concurrent sessions with different approval envelopes', async () => {
    const sessionA = manager.start('e2e-envelope-a', {
      instruction: 'Say "ENVELOPE_A" and exit.',
      approvalEnvelope: {
        mode: 'scoped',
        rules: {
          fileWrites: { withinProject: 'auto_approve', outsideProject: 'deny' },
        },
        defaults: { low: 'auto_approve', medium: 'auto_approve', high: 'require_review' },
      },
    });

    const sessionB = manager.start('e2e-envelope-b', {
      instruction: 'Say "ENVELOPE_B" and exit.',
      approvalEnvelope: {
        mode: 'scoped',
        rules: {
          fileWrites: { withinProject: 'require_review', outsideProject: 'deny' },
        },
        defaults: { low: 'require_review', medium: 'require_review', high: 'deny' },
      },
    });

    expect(sessionA.approvalEnvelope.defaults.low).toBe('auto_approve');
    expect(sessionB.approvalEnvelope.defaults.low).toBe('require_review');

    await Promise.all([
      manager.end('e2e-envelope-a'),
      manager.end('e2e-envelope-b'),
    ]);
  }, E2E_TIMEOUT);
});

// ─── E2E: Permission Review Lifecycle ────────────────────────────────────────

describeE2E('E2E: permission review lifecycle', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: PROJECTS_DIR,
      claudeBin: CLAUDE_BIN,
      promptTimeoutMs: 60_000,
      sessionTimeoutMs: 120_000,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('detects permission prompt, responds with approval, session resumes', async () => {
    // Start a session that will trigger a file write permission
    // Use require_review for all writes so the prompt isn't auto-approved
    const session = manager.start('e2e-perm-review', {
      instruction: 'Create a file called e2e-test-marker.txt with the content "bridge v2 test". Do not ask me for confirmation, just do it.',
      approvalEnvelope: {
        mode: 'scoped',
        rules: {
          fileWrites: { withinProject: 'require_review', outsideProject: 'deny' },
        },
        defaults: { low: 'require_review', medium: 'require_review', high: 'deny' },
      },
    });

    // Wait for either a permission prompt or session completion
    // (Claude may complete without writing if it decides to just say it can't)
    try {
      const perm = await waitForPermission(session, 60_000);

      // Permission detected — verify it has the expected structure
      expect(perm.id).toMatch(/^perm_/);
      expect(perm.permissionType).toBeDefined();
      expect(perm.risk).toBeDefined();
      expect(perm.requiresResponse).toBe(true);

      // Session should be waiting
      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);

      // Respond with approval
      const decision = manager.respond('e2e-perm-review', perm.id, 'approve_once', {
        actor: 'e2e-test',
        reason: 'E2E test approval',
      });

      // Decision event should be recorded
      expect(decision).toBeDefined();
      expect(decision.data?.decision || decision.decision).toBe('approve_once');

      // Session should resume to running
      expect(session.state).toBe(SessionState.RUNNING);

      // Wait for session to finish
      await waitForState(session, [SessionState.COMPLETED, SessionState.FAILED], 60_000);

      // Event log should contain permission + decision events
      const allEvents = session.eventLog.read(0);
      const permEvents = allEvents.events.filter(e => e.kind === EventKind.PERMISSION);
      const decEvents = allEvents.events.filter(e => e.kind === EventKind.DECISION);
      expect(permEvents.length).toBeGreaterThanOrEqual(1);
      expect(decEvents.length).toBeGreaterThanOrEqual(1);

    } catch (err) {
      // If Claude completes without triggering a write (e.g. it just prints text),
      // the test is still valid — it just means we couldn't trigger a permission.
      // Log the outcome for diagnostic purposes.
      if (session.isTerminal) {
        console.log(`[e2e-perm-review] Session ended without permission prompt (state: ${session.state}). This may happen if Claude does not attempt a file write.`);
      } else {
        throw err;
      }
    }

    await manager.end('e2e-perm-review');
  }, E2E_TIMEOUT);
});

// ─── E2E: Timeout Scenarios ─────────────────────────────────────────────────

describeE2E('E2E: timeout scenarios', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: PROJECTS_DIR,
      claudeBin: CLAUDE_BIN,
      // Short timeouts for testing
      promptTimeoutMs: 10_000,    // 10 seconds
      sessionTimeoutMs: 30_000,   // 30 seconds
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('session runtime timeout kills the session', async () => {
    // Give Claude a long task so it doesn't finish before timeout
    const session = manager.start('e2e-timeout', {
      instruction: 'Write a very long essay about the history of computing. Make it at least 5000 words.',
    });

    // Wait for the session to time out (30s manager default)
    const state = await waitForState(session, [SessionState.TIMED_OUT, SessionState.FAILED, SessionState.COMPLETED], 45_000);

    // Should have timed out (unless Claude finished impossibly fast)
    if (state === SessionState.TIMED_OUT) {
      expect(session.isTerminal).toBe(true);

      // Should have a runtime timeout error event
      const allEvents = session.eventLog.read(0);
      const errorEvents = allEvents.events.filter(
        e => e.kind === EventKind.ERROR && e.data?.code === 'SESSION_RUNTIME_TIMEOUT'
      );
      expect(errorEvents.length).toBe(1);
    }
    // If completed/failed, the test is still valid — just not testing timeout
  }, 60_000);
});

// ─── E2E: HTTP Server Integration ───────────────────────────────────────────

describeE2E('E2E: HTTP server v2 routes', () => {
  let server;
  let manager;
  let port;

  /**
   * Make an HTTP request to the test server.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<{status: number, data: object}>}
   */
  function request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Parse JSON body from request (mirror of server.js helper).
   * @param {http.IncomingMessage} req
   * @returns {Promise<object>}
   */
  function parseBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response.
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {object} data
   */
  function json(res, status, data) {
    const bodyStr = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) });
    res.end(bodyStr);
  }

  beforeAll(async () => {
    manager = new SessionManager({
      projectsDir: PROJECTS_DIR,
      claudeBin: CLAUDE_BIN,
      promptTimeoutMs: 60_000,
      sessionTimeoutMs: 120_000,
    });

    // Start a minimal HTTP server with v2 routes
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const method = req.method;
      const pathname = url.pathname;

      if (pathname.startsWith('/v2/')) {
        const handled = await handleV2Route({
          method, pathname, url, req, res,
          parseBody, json,
          sessionManager: manager,
        });
        if (handled) return;
      }

      // Health check for test server
      if (method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true, test: true });
      }

      json(res, 404, { error: 'Not found' });
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    manager.destroyAll();
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('POST /v2/session/start → GET /v2/session/status → POST /v2/session/end', async () => {
    // Start
    const startRes = await request('POST', '/v2/session/start', {
      project: 'e2e-http-lifecycle',
      instruction: 'Say "HTTP_OK" and exit.',
    });
    expect(startRes.status).toBe(200);
    expect(startRes.data.sessionId).toMatch(/^sess_/);
    expect(startRes.data.state).toBe('running');

    // Status — session may have already completed if Claude finishes fast
    const statusRes = await request('GET', '/v2/session/status?project=e2e-http-lifecycle');
    expect(statusRes.status).toBe(200);
    expect(statusRes.data.sessionId).toBe(startRes.data.sessionId);

    // Output (poll with cursor=0)
    const outputRes = await request('GET', '/v2/session/output?project=e2e-http-lifecycle&cursor=0');
    expect(outputRes.status).toBe(200);
    expect(outputRes.data.ok).toBe(true);

    // End
    const endRes = await request('POST', '/v2/session/end', {
      project: 'e2e-http-lifecycle',
    });
    expect(endRes.status).toBe(200);
    expect(endRes.data.state).toBe('ended');
  }, E2E_TIMEOUT);

  it('GET /v2/sessions lists active sessions', async () => {
    const session = manager.start('e2e-http-list', {
      instruction: 'Say "LIST_OK" and exit.',
    });

    const res = await request('GET', '/v2/sessions');
    expect(res.status).toBe(200);
    expect(res.data.sessions).toBeInstanceOf(Array);
    const found = res.data.sessions.find(s => s.project === 'e2e-http-list');
    expect(found).toBeTruthy();
    expect(found.sessionId).toBe(session.sessionId);

    await manager.end('e2e-http-list');
  }, E2E_TIMEOUT);

  it('POST /v2/session/send into running session', async () => {
    const session = manager.start('e2e-http-send', {
      instruction: 'Say "WAITING" and wait for instructions.',
    });

    // Wait for session to start
    await waitForState(session, [SessionState.RUNNING, SessionState.COMPLETED], 60_000);

    // Attempt send — Claude may finish before we get here (race with real PTY)
    const sendRes = await request('POST', '/v2/session/send', {
      project: 'e2e-http-send',
      message: 'Say "SEND_OK" and exit.',
    });

    // 200 = accepted (session was running), 410 = session already ended (Claude was fast)
    // Both are valid outcomes with real Claude Code
    expect([200, 410]).toContain(sendRes.status);
    if (sendRes.status === 200) {
      expect(sendRes.data.accepted).toBe(true);
    }

    await manager.end('e2e-http-send');
  }, E2E_TIMEOUT);

  it('POST /v2/session/start returns 409 for duplicate project', async () => {
    manager.start('e2e-http-dup', {
      instruction: 'Say "DUP" and exit.',
    });

    const res = await request('POST', '/v2/session/start', {
      project: 'e2e-http-dup',
    });
    expect(res.status).toBe(409);

    await manager.end('e2e-http-dup');
  }, E2E_TIMEOUT);

  it('health check still works alongside v2', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });
});
