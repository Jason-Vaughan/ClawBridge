'use strict';

const { SessionManager } = require('./sessions');
const { stripAnsi } = require('./permission-parser');

/**
 * Handle v2 API routes. Returns true if the route was handled, false otherwise.
 *
 * @param {object} params
 * @param {string} params.method - HTTP method
 * @param {string} params.pathname - URL pathname
 * @param {URL} params.url - Parsed URL
 * @param {import('http').IncomingMessage} params.req
 * @param {import('http').ServerResponse} params.res
 * @param {function} params.parseBody - Body parser
 * @param {function} params.json - JSON response helper
 * @param {SessionManager} params.sessionManager - V2 session manager
 * @returns {Promise<boolean>} Whether the route was handled
 */
async function handleV2Route({ method, pathname, url, req, res, parseBody, json, sessionManager }) {
  // POST /v2/session/start
  if (method === 'POST' && pathname === '/v2/session/start') {
    const body = await parseBody(req);
    if (!body.project) {
      json(res, 400, { error: 'project is required' });
      return true;
    }

    try {
      const session = sessionManager.start(body.project, {
        instruction: body.instruction,
        approvalEnvelope: body.approvalEnvelope,
        timeout: body.timeout,
        promptTimeout: body.promptTimeout,
      });
      json(res, 200, {
        ok: true,
        sessionId: session.sessionId,
        project: session.project,
        state: session.state,
        createdAt: session.createdAt,
        cursor: 0,
      });
    } catch (err) {
      if (err.code === 'SESSION_EXISTS') {
        json(res, 409, { error: err.message });
      } else if (err.code === 'INVALID_ENVELOPE') {
        json(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // POST /v2/session/end
  if (method === 'POST' && pathname === '/v2/session/end') {
    const body = await parseBody(req);
    if (!body.project) {
      json(res, 400, { error: 'project is required' });
      return true;
    }

    try {
      const session = await sessionManager.end(body.project, {
        message: body.message,
      });
      const response = {
        ok: true,
        sessionId: session.sessionId,
        project: session.project,
        state: session.state,
        exitCode: session.exitCode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        finalCursor: session.eventLog.cursor,
      };
      // Include transcript in end response — avoids needing a separate
      // GET /v2/session/transcript call that can fail if the bridge restarts
      // (in-memory session state doesn't survive restarts).
      if (body.includeTranscript) {
        response.transcript = session.eventLog.getTranscript();
      }
      json(res, 200, response);
    } catch (err) {
      if (err.code === 'SESSION_NOT_FOUND') {
        json(res, 404, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // GET /v2/session/output
  if (method === 'GET' && pathname === '/v2/session/output') {
    const project = url.searchParams.get('project');
    if (!project) {
      json(res, 400, { error: 'project query parameter is required' });
      return true;
    }

    const cursorParam = url.searchParams.get('cursor');
    if (cursorParam == null) {
      json(res, 400, { error: 'cursor query parameter is required' });
      return true;
    }

    const cursor = parseInt(cursorParam, 10);
    if (isNaN(cursor) || cursor < 0) {
      json(res, 400, { error: 'cursor must be a non-negative integer' });
      return true;
    }

    const session = sessionManager.get(project);
    if (!session) {
      json(res, 404, { error: `No session for project '${project}'` });
      return true;
    }

    const waitMs = parseInt(url.searchParams.get('waitMs') || '0', 10);
    const maxEventsParam = url.searchParams.get('maxEvents');
    const maxEvents = maxEventsParam ? parseInt(maxEventsParam, 10) : undefined;

    let result;
    if (waitMs > 0) {
      result = await session.eventLog.waitForEvents(cursor, waitMs, { maxEvents });
    } else {
      result = session.eventLog.read(cursor, { maxEvents });
    }

    const outputResponse = {
      ok: true,
      project: session.project,
      sessionId: session.sessionId,
      state: session.state,
      cursorStart: result.cursorStart,
      cursorEnd: result.cursorEnd,
      hasMore: result.hasMore,
      events: result.events,
    };
    if (session.pendingPermission) {
      outputResponse.pendingPermission = {
        id: session.pendingPermission.id,
        permissionType: session.pendingPermission.permissionType,
        risk: session.pendingPermission.risk,
        target: session.pendingPermission.target,
        timeoutAt: session.pendingPermission.timeoutAt || null,
      };
    }
    json(res, 200, outputResponse);
    return true;
  }

  // POST /v2/session/respond
  if (method === 'POST' && pathname === '/v2/session/respond') {
    const body = await parseBody(req);
    if (!body.project) {
      json(res, 400, { error: 'project is required' });
      return true;
    }
    if (!body.permissionId) {
      json(res, 400, { error: 'permissionId is required' });
      return true;
    }
    if (!body.decision) {
      json(res, 400, { error: 'decision is required' });
      return true;
    }

    try {
      const decisionEvent = sessionManager.respond(body.project, body.permissionId, body.decision, {
        reason: body.reason,
        actor: body.actor,
      });

      const session = sessionManager.get(body.project);
      json(res, 200, {
        ok: true,
        project: body.project,
        sessionId: session ? session.sessionId : null,
        state: session ? session.state : null,
        cursor: session ? session.eventLog.cursor : null,
        decision: decisionEvent,
      });
    } catch (err) {
      if (err.code === 'SESSION_NOT_FOUND') {
        json(res, 404, { error: err.message });
      } else if (err.code === 'SESSION_ENDED') {
        json(res, 410, { error: err.message });
      } else if (err.code === 'PERMISSION_ALREADY_RESOLVED') {
        json(res, 409, { error: err.message });
      } else if (err.code === 'PERMISSION_NOT_FOUND') {
        json(res, 404, { error: err.message });
      } else if (err.code === 'INVALID_DECISION') {
        json(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // POST /v2/session/policy
  if (method === 'POST' && pathname === '/v2/session/policy') {
    const body = await parseBody(req);
    if (!body.project) {
      json(res, 400, { error: 'project is required' });
      return true;
    }
    if (!body.approvalEnvelope) {
      json(res, 400, { error: 'approvalEnvelope is required' });
      return true;
    }

    try {
      const session = sessionManager.updatePolicy(body.project, body.approvalEnvelope);
      json(res, 200, {
        ok: true,
        project: session.project,
        sessionId: session.sessionId,
        state: session.state,
        policyUpdated: true,
      });
    } catch (err) {
      if (err.code === 'SESSION_NOT_FOUND') {
        json(res, 404, { error: err.message });
      } else if (err.code === 'SESSION_ENDED') {
        json(res, 410, { error: err.message });
      } else if (err.code === 'INVALID_ENVELOPE') {
        json(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // POST /v2/session/send
  if (method === 'POST' && pathname === '/v2/session/send') {
    const body = await parseBody(req);
    if (!body.project) {
      json(res, 400, { error: 'project is required' });
      return true;
    }
    if (!body.message) {
      json(res, 400, { error: 'message is required' });
      return true;
    }

    try {
      const result = sessionManager.send(body.project, body.message);
      json(res, 200, {
        ok: true,
        accepted: result.accepted,
        cursor: result.cursor,
        project: body.project,
        sessionId: result.sessionId,
        state: result.state,
      });
    } catch (err) {
      if (err.code === 'SESSION_NOT_FOUND') {
        json(res, 404, { error: err.message });
      } else if (err.code === 'SESSION_ENDED') {
        json(res, 410, { error: err.message });
      } else if (err.code === 'SESSION_NOT_WRITABLE') {
        json(res, 409, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // GET /v2/session/status
  if (method === 'GET' && pathname === '/v2/session/status') {
    const project = url.searchParams.get('project');
    if (!project) {
      json(res, 400, { error: 'project query parameter is required' });
      return true;
    }

    const session = sessionManager.get(project);
    if (!session) {
      json(res, 200, { ok: true, project, active: false });
    } else {
      const inputReady = session.state === 'running' && !!session.pty && !session.pty.exited;
      const statusObj = {
        ok: true,
        project,
        active: !session.isTerminal,
        inputReady,
        sessionId: session.sessionId,
        state: session.state,
        startedAt: session.createdAt,
        lastActivity: session.updatedAt,
        cursor: session.eventLog.cursor,
      };
      if (session.pendingPermission) {
        statusObj.pendingPermissionId = session.pendingPermission.id;
        if (session.pendingPermission.timeoutAt) {
          statusObj.permissionTimeoutAt = session.pendingPermission.timeoutAt;
        }
      }
      json(res, 200, statusObj);
    }
    return true;
  }

  // GET /v2/sessions
  // By default returns only active (non-terminal) sessions.
  // Use ?all=true to include ended/completed/failed/timed_out sessions.
  if (method === 'GET' && pathname === '/v2/sessions') {
    const showAll = url.searchParams.get('all') === 'true';
    let sessions = sessionManager.list();
    if (!showAll) {
      sessions = sessions.filter(s => !s.isTerminal);
    }
    json(res, 200, { ok: true, sessions: sessions.map(s => s.toJSON()) });
    return true;
  }

  // GET /v2/session/peek — convenience snapshot of a running session
  // Returns state, pending permission, last N lines of output, and test detection.
  // No cursor management needed — designed for operators checking in.
  if (method === 'GET' && pathname === '/v2/session/peek') {
    const project = url.searchParams.get('project');
    if (!project) {
      json(res, 400, { error: 'project query parameter is required' });
      return true;
    }

    const session = sessionManager.get(project);
    if (!session) {
      json(res, 200, { ok: true, project, active: false });
      return true;
    }

    const tailLines = parseInt(url.searchParams.get('lines') || '30', 10);
    const clean = url.searchParams.get('clean') === 'true';

    // Build the raw transcript and extract tail lines
    const rawTranscript = session.eventLog.getTranscript();
    const transcript = clean ? stripAnsi(rawTranscript) : rawTranscript;
    const allLines = transcript.split('\n');
    const tail = allLines.slice(-Math.max(1, tailLines)).join('\n');

    // Scan text events for test runner output patterns
    const testResult = detectTestResult(session.eventLog);

    // inputReady: can POST /v2/session/send succeed right now?
    // true only when running + PTY alive + not waiting for permission
    const inputReady = session.state === 'running' && !!session.pty && !session.pty.exited;

    const peekResponse = {
      ok: true,
      project: session.project,
      sessionId: session.sessionId,
      state: session.state,
      active: !session.isTerminal,
      inputReady,
      startedAt: session.createdAt,
      lastActivity: session.updatedAt,
      cursor: session.eventLog.cursor,
      tail,
      tailLineCount: Math.min(tailLines, allLines.length),
      totalLines: allLines.length,
      testResult,
    };

    if (session.pendingPermission) {
      peekResponse.pendingPermission = {
        id: session.pendingPermission.id,
        permissionType: session.pendingPermission.permissionType,
        risk: session.pendingPermission.risk,
        target: session.pendingPermission.target,
        timeoutAt: session.pendingPermission.timeoutAt || null,
      };
    }

    json(res, 200, peekResponse);
    return true;
  }

  // GET /v2/session/transcript — available for both active and ended sessions
  if (method === 'GET' && pathname === '/v2/session/transcript') {
    const project = url.searchParams.get('project');
    if (!project) {
      json(res, 400, { error: 'project query parameter is required' });
      return true;
    }

    const session = sessionManager.get(project);
    if (!session) {
      const known = sessionManager.list().map(s => s.project);
      console.error(`[v2/transcript] No session for '${project}' — known projects: [${known.join(', ')}]`);
      json(res, 404, { error: `No session for project '${project}'` });
      return true;
    }

    const clean = url.searchParams.get('clean') === 'true';
    const rawTranscript = session.eventLog.getTranscript();
    const transcript = clean ? stripAnsi(rawTranscript) : rawTranscript;
    json(res, 200, {
      ok: true,
      project: session.project,
      sessionId: session.sessionId,
      state: session.state,
      active: !session.isTerminal,
      transcript,
    });
    return true;
  }

  // GET /v2/session/last — most recent completed session for a project
  // Survives bridge restarts (persisted to disk). Returns transcript, test result, timing.
  if (method === 'GET' && pathname === '/v2/session/last') {
    const project = url.searchParams.get('project');
    if (!project) {
      json(res, 400, { error: 'project query parameter is required' });
      return true;
    }

    const snapshot = sessionManager.getLastCompleted(project);
    if (!snapshot) {
      json(res, 200, { ok: true, project, found: false });
      return true;
    }

    const clean = url.searchParams.get('clean') === 'true';
    const response = { ...snapshot, ok: true, found: true };
    if (clean && response.transcript) {
      response.transcript = stripAnsi(response.transcript);
    }

    json(res, 200, response);
    return true;
  }

  // GET /v2/api-docs — self-describing API reference for all v2 endpoints
  if (method === 'GET' && pathname === '/v2/api-docs') {
    json(res, 200, getApiDocs());
    return true;
  }

  return false;
}

/**
 * Detect test runner results from session event log text.
 * Scans for vitest, pytest, jest, and mocha output patterns.
 * Returns null if no test output detected.
 * @param {import('./event-log').EventLog} eventLog
 * @returns {object|null} { runner, passed, failed, total, summary, command }
 */
function detectTestResult(eventLog) {
  const transcript = eventLog.getTranscript();
  // Strip ANSI codes for reliable matching
  const clean = transcript.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');

  // Detect the test command used (common patterns)
  let command = null;
  const cmdPatterns = [
    /(?:npx |pnpm |yarn |bunx )?vitest\s+run[^\n]*/,
    /(?:npx |pnpm |yarn |bunx )?jest[^\n]*/,
    /(?:python[3]?\s+-m\s+)?pytest[^\n]*/,
    /(?:npx |pnpm |yarn |bunx )?mocha[^\n]*/,
  ];
  for (const p of cmdPatterns) {
    const m = clean.match(p);
    if (m) { command = m[0].trim(); break; }
  }

  // vitest: "Tests  42 passed (42)" or "Tests  3 failed | 39 passed (42)"
  const vitestMatch = clean.match(/Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(\d+)\s+passed\s*\((\d+)\)/);
  if (vitestMatch) {
    const failed = parseInt(vitestMatch[1] || '0', 10);
    const passed = parseInt(vitestMatch[2], 10);
    const total = parseInt(vitestMatch[3], 10);
    return { runner: 'vitest', passed, failed, total, summary: vitestMatch[0].trim(), command };
  }

  // pytest: "42 passed" or "3 failed, 39 passed"
  const pytestMatch = clean.match(/=+\s*((?:\d+\s+\w+,?\s*)+)\s*in\s+[\d.]+s\s*=+/);
  if (pytestMatch) {
    const summary = pytestMatch[1].trim();
    const passedM = summary.match(/(\d+)\s+passed/);
    const failedM = summary.match(/(\d+)\s+failed/);
    const passed = passedM ? parseInt(passedM[1], 10) : 0;
    const failed = failedM ? parseInt(failedM[1], 10) : 0;
    return { runner: 'pytest', passed, failed, total: passed + failed, summary, command };
  }

  // jest: "Tests:  3 failed, 39 passed, 42 total"
  const jestMatch = clean.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/);
  if (jestMatch) {
    const failed = parseInt(jestMatch[1] || '0', 10);
    const passed = parseInt(jestMatch[2], 10);
    const total = parseInt(jestMatch[3], 10);
    return { runner: 'jest', passed, failed, total, summary: jestMatch[0].trim(), command };
  }

  // mocha: "42 passing" or "3 failing"
  const mochaPassMatch = clean.match(/(\d+)\s+passing/);
  const mochaFailMatch = clean.match(/(\d+)\s+failing/);
  if (mochaPassMatch) {
    const passed = parseInt(mochaPassMatch[1], 10);
    const failed = mochaFailMatch ? parseInt(mochaFailMatch[1], 10) : 0;
    return { runner: 'mocha', passed, failed, total: passed + failed, summary: `${passed} passing${failed ? `, ${failed} failing` : ''}`, command };
  }

  return null;
}

/**
 * Return the full v2 API documentation object.
 * @returns {object}
 */
function getApiDocs() {
  return {
    ok: true,
    name: 'ClawBridge v2 API',
    description: 'PTY-backed Claude Code session management. Replaces v1 fire-and-forget /claude/run with persistent sessions, live output streaming, permission handling, and interactive control.',
    endpoints: [
      {
        method: 'POST',
        path: '/v2/session/start',
        description: 'Start a new PTY-backed Claude Code session for a project.',
        body: {
          project: { type: 'string', required: true, description: 'Project name (maps to directory under ~/.openclaw/projects/)' },
          instruction: { type: 'string', required: false, description: 'Initial instruction/prompt to send to Claude Code' },
          approvalEnvelope: { type: 'object', required: false, description: 'Policy rules for auto-approving/denying permission prompts' },
          timeout: { type: 'number', required: false, description: 'Session runtime timeout in ms (default: 30 min)' },
          promptTimeout: { type: 'number', required: false, description: 'Prompt-wait timeout in ms (default: 5 min)' },
        },
        returns: 'sessionId, project, state, createdAt, cursor',
      },
      {
        method: 'GET',
        path: '/v2/session/output',
        description: 'Stream session events using cursor-based pagination. Supports long-polling via waitMs.',
        query: {
          project: { type: 'string', required: true },
          cursor: { type: 'number', required: true, description: 'Start reading from this event sequence number (0-based)' },
          waitMs: { type: 'number', required: false, description: 'Long-poll: wait up to this many ms for new events (default: 0 = immediate)' },
          maxEvents: { type: 'number', required: false, description: 'Max events to return per call' },
        },
        returns: 'events[], cursorStart, cursorEnd, hasMore, state, pendingPermission (if any)',
      },
      {
        method: 'GET',
        path: '/v2/session/peek',
        description: 'Quick operational snapshot — state, pending permission, last N lines of output, test results. No cursor management needed.',
        query: {
          project: { type: 'string', required: true },
          lines: { type: 'number', required: false, description: 'Number of tail lines to return (default: 30)' },
          clean: { type: 'string', required: false, description: 'Set to "true" to strip ANSI escape codes from tail output (default: raw)' },
        },
        returns: 'state, active, inputReady, tail (last N lines), pendingPermission, testResult { runner, passed, failed, total, summary, command }',
      },
      {
        method: 'POST',
        path: '/v2/session/respond',
        description: 'Respond to a pending permission prompt (approve, deny, or abort session).',
        body: {
          project: { type: 'string', required: true },
          permissionId: { type: 'string', required: true, description: 'ID from pendingPermission in output/peek/status' },
          decision: { type: 'string', required: true, description: 'One of: approve_once, deny, abort_session' },
          reason: { type: 'string', required: false },
          actor: { type: 'string', required: false, description: 'Who made the decision (default: nhe-itl)' },
        },
        returns: 'decision event, session state, cursor',
      },
      {
        method: 'POST',
        path: '/v2/session/send',
        description: 'Send a follow-up message/instruction to a running session.',
        body: {
          project: { type: 'string', required: true },
          message: { type: 'string', required: true, description: 'Text to write to Claude Code stdin' },
        },
        returns: 'accepted, cursor, state',
      },
      {
        method: 'GET',
        path: '/v2/session/status',
        description: 'Quick status check for a project session — is it active, what state, any pending permission.',
        query: {
          project: { type: 'string', required: true },
        },
        returns: 'active, inputReady, state, sessionId, cursor, pendingPermissionId',
      },
      {
        method: 'GET',
        path: '/v2/session/transcript',
        description: 'Full reconstructed PTY output as a single string. Available during active sessions and after completion.',
        query: {
          project: { type: 'string', required: true },
          clean: { type: 'string', required: false, description: 'Set to "true" to strip ANSI escape codes (default: raw)' },
        },
        returns: 'transcript (raw or cleaned text), state, active',
      },
      {
        method: 'GET',
        path: '/v2/session/last',
        description: 'Most recent completed session for a project. Survives bridge restarts (persisted to disk).',
        query: {
          project: { type: 'string', required: true },
          clean: { type: 'string', required: false, description: 'Set to "true" to strip ANSI escape codes from transcript' },
        },
        returns: 'found, sessionId, state, exitCode, startedAt, endedAt, transcript, testResult, eventCount',
      },
      {
        method: 'POST',
        path: '/v2/session/end',
        description: 'End a session — sends wrap message, waits for PTY exit, transitions to ended state.',
        body: {
          project: { type: 'string', required: true },
          message: { type: 'string', required: false, description: 'Custom wrap-up message (default: governance/handoff prompt)' },
          includeTranscript: { type: 'boolean', required: false, description: 'Include full transcript in response' },
        },
        returns: 'sessionId, state, exitCode, finalCursor, transcript (if requested)',
      },
      {
        method: 'POST',
        path: '/v2/session/policy',
        description: 'Update the approval envelope for an active session. Takes effect on the next permission prompt.',
        body: {
          project: { type: 'string', required: true },
          approvalEnvelope: { type: 'object', required: true },
        },
        returns: 'project, sessionId, state, policyUpdated',
      },
      {
        method: 'GET',
        path: '/v2/sessions',
        description: 'List all sessions. By default returns only active (non-terminal) sessions.',
        query: {
          all: { type: 'string', required: false, description: 'Set to "true" to include ended/completed/failed/timed_out sessions' },
        },
        returns: 'sessions[] (each with sessionId, project, state, cursor, etc.)',
      },
      {
        method: 'GET',
        path: '/v2/api-docs',
        description: 'This endpoint. Returns self-describing API reference for all v2 endpoints.',
        query: {},
        returns: 'This documentation object',
      },
    ],
    quickstart: {
      description: 'Typical workflow for an OpenClaw assistant session:',
      steps: [
        '1. POST /v2/session/start { project, instruction, approvalEnvelope }',
        '2. Poll GET /v2/session/peek?project=X to monitor progress',
        '3. If pendingPermission appears → POST /v2/session/respond to approve/deny',
        '4. Send follow-up instructions via POST /v2/session/send',
        '5. When done → POST /v2/session/end (or session completes on its own)',
        '6. GET /v2/session/transcript for full output history',
      ],
    },
    notes: [
      'All endpoints require Authorization: Bearer <token> header.',
      'One active session per project at a time. Start returns 409 if session already running.',
      'Permission prompts auto-timeout after promptTimeout ms (default 5 min) if not responded to.',
      'Sessions auto-timeout after timeout ms (default 30 min).',
      '/prawduct/run still available for governance lifecycle commands (setup, sync, validate).',
    ],
  };
}

module.exports = { handleV2Route, detectTestResult, getApiDocs };
