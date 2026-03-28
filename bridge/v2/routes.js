'use strict';

const { SessionManager } = require('./sessions');

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

  // GET /v2/session/transcript
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

    // Only allow transcript export for terminal/ended sessions
    if (!session.isTerminal) {
      json(res, 404, { error: `Session for project '${project}' is still active (state: ${session.state}) — transcript only available after session ends` });
      return true;
    }

    const transcript = session.eventLog.getTranscript();
    json(res, 200, {
      ok: true,
      project: session.project,
      sessionId: session.sessionId,
      state: session.state,
      transcript,
    });
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
      const statusObj = {
        ok: true,
        project,
        active: !session.isTerminal,
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

  return false;
}

module.exports = { handleV2Route };
