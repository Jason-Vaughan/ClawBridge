import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { handleV2Route } = require('../routes');
const { SessionManager } = require('../sessions');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal route context that handleV2Route expects.
 * @param {string} method
 * @param {string} pathname
 * @param {object} [body]
 * @returns {{ method, pathname, url, req, res, parseBody, json, sessionManager, response }}
 */
function makeCtx(method, pathname, body = {}, sessionManager = null) {
  const url = new URL(`http://localhost:3201${pathname}`);
  const response = { status: null, data: null };
  return {
    method,
    pathname,
    url,
    req: {},
    res: {},
    parseBody: vi.fn().mockResolvedValue(body),
    json: vi.fn((res, status, data) => {
      response.status = status;
      response.data = data;
    }),
    sessionManager: sessionManager || new SessionManager({
      projectsDir: '/tmp/coexistence-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    }),
    response,
  };
}

// ─── v2 Route Handler Does Not Consume v1 Paths ─────────────────────────────

describe('v2 route handler passes through v1 paths', () => {
  const v1Routes = [
    ['GET',  '/health'],
    ['POST', '/claude/run'],
    ['POST', '/session/send'],
    ['POST', '/session/end'],
    ['GET',  '/session/status'],
    ['GET',  '/sessions'],
    ['POST', '/prawduct/run'],
    ['GET',  '/projects'],
    ['GET',  '/exports'],
    ['GET',  '/exports/report.md'],
    ['POST', '/circuit-breaker/reset'],
    ['GET',  '/circuit-breaker'],
  ];

  for (const [method, path] of v1Routes) {
    it(`returns false for ${method} ${path}`, async () => {
      const ctx = makeCtx(method, path);
      const handled = await handleV2Route(ctx);
      expect(handled).toBe(false);
    });
  }

  it('returns false for unknown paths', async () => {
    const ctx = makeCtx('GET', '/nonexistent');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });

  it('returns false for partial v2 prefix without matching route', async () => {
    const ctx = makeCtx('GET', '/v2/nonexistent');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });
});

// ─── v2 Route Handler Claims v2 Paths ───────────────────────────────────────

describe('v2 route handler claims v2 paths', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/coexistence-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  const v2Routes = [
    ['POST', '/v2/session/start'],
    ['POST', '/v2/session/end'],
    ['GET',  '/v2/session/output?project=x&cursor=0'],
    ['POST', '/v2/session/respond'],
    ['POST', '/v2/session/policy'],
    ['POST', '/v2/session/send'],
    ['GET',  '/v2/session/transcript?project=x'],
    ['GET',  '/v2/session/status?project=x'],
    ['GET',  '/v2/sessions'],
  ];

  for (const [method, pathWithQuery] of v2Routes) {
    const pathOnly = pathWithQuery.split('?')[0];
    it(`returns true for ${method} ${pathOnly}`, async () => {
      const ctx = makeCtx(method, pathOnly, {}, manager);
      // Override url to include query params
      ctx.url = new URL(`http://localhost:3201${pathWithQuery}`);
      const handled = await handleV2Route(ctx);
      expect(handled).toBe(true);
    });
  }
});

// ─── Session State Independence ─────────────────────────────────────────────

describe('v1 and v2 session state independence', () => {
  let v2Manager;

  beforeEach(() => {
    v2Manager = new SessionManager({
      projectsDir: '/tmp/coexistence-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    v2Manager.destroyAll();
  });

  it('v2 SessionManager does not share state with v1 session map', () => {
    // v1 sessions are a plain Map in server.js — simulate one
    const v1Sessions = new Map();
    v1Sessions.set('my-project', {
      sessionId: 'v1-sess-abc',
      projectDir: '/tmp/projects/my-project',
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    // Start a v2 session for the same project
    const v2Session = v2Manager.start('my-project');

    // v2 session exists
    expect(v2Manager.get('my-project')).toBeTruthy();
    expect(v2Session.sessionId).toBeTruthy();

    // v1 session still exists independently
    expect(v1Sessions.has('my-project')).toBe(true);
    expect(v1Sessions.get('my-project').sessionId).toBe('v1-sess-abc');

    // They have different session IDs
    expect(v2Session.sessionId).not.toBe('v1-sess-abc');
  });

  it('v2 destroyAll does not affect v1 session state', () => {
    const v1Sessions = new Map();
    v1Sessions.set('proj-a', { sessionId: 'v1-1' });

    v2Manager.start('proj-a');
    v2Manager.destroyAll();

    // v2 is cleared
    expect(v2Manager.get('proj-a')).toBeUndefined();

    // v1 is untouched
    expect(v1Sessions.has('proj-a')).toBe(true);
  });

  it('v2 session count is independent of v1 session count', () => {
    // Simulate v1 has 3 sessions
    const v1Sessions = new Map();
    v1Sessions.set('proj-a', { sessionId: 'v1-1' });
    v1Sessions.set('proj-b', { sessionId: 'v1-2' });
    v1Sessions.set('proj-c', { sessionId: 'v1-3' });

    // v2 has 1 session
    v2Manager.start('proj-a');

    expect(v1Sessions.size).toBe(3);
    expect(v2Manager.activeCount).toBe(1);
  });
});

// ─── v2 Route Response Verification ─────────────────────────────────────────

describe('v2 route response shapes', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({
      projectsDir: '/tmp/coexistence-test',
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('GET /v2/sessions returns ok:true and sessions array', async () => {
    manager.start('route-test-a');
    manager.start('route-test-b');

    const ctx = makeCtx('GET', '/v2/sessions', {}, manager);
    await handleV2Route(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.data.ok).toBe(true);
    expect(ctx.response.data.sessions).toBeInstanceOf(Array);
    expect(ctx.response.data.sessions.length).toBe(2);

    const projects = ctx.response.data.sessions.map(s => s.project).sort();
    expect(projects).toEqual(['route-test-a', 'route-test-b']);

    // Each session has expected fields
    for (const s of ctx.response.data.sessions) {
      expect(s.sessionId).toMatch(/^sess_/);
      expect(s.state).toBeDefined();
      expect(s.createdAt).toBeDefined();
      expect(s.updatedAt).toBeDefined();
    }
  });

  it('POST /v2/session/start returns ok:true and cursor:0', async () => {
    const ctx = makeCtx('POST', '/v2/session/start', { project: 'start-shape' }, manager);
    await handleV2Route(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.data.ok).toBe(true);
    expect(ctx.response.data.cursor).toBe(0);
    expect(ctx.response.data.sessionId).toMatch(/^sess_/);
    expect(ctx.response.data.state).toBe('running');
    expect(ctx.response.data.createdAt).toBeDefined();
  });

  it('POST /v2/session/end returns ok:true and finalCursor', async () => {
    manager.start('end-shape');

    const ctx = makeCtx('POST', '/v2/session/end', { project: 'end-shape' }, manager);
    await handleV2Route(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.data.ok).toBe(true);
    expect(typeof ctx.response.data.finalCursor).toBe('number');
    expect(ctx.response.data.state).toBe('ended');
  });

  it('GET /v2/session/output includes pendingPermission when present', async () => {
    const session = manager.start('output-perm');
    session.permissionParser.feed('Claude wants to write to /tmp/coexistence-test/output-perm/f.js\nAllow? [Y/n]');

    expect(session.state).toBe('waiting_for_permission');

    const ctx = makeCtx('GET', '/v2/session/output', {}, manager);
    ctx.url = new URL('http://localhost:3201/v2/session/output?project=output-perm&cursor=0');
    await handleV2Route(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.data.pendingPermission).toBeDefined();
    expect(ctx.response.data.pendingPermission.id).toBe(session.pendingPermission.id);
    expect(ctx.response.data.pendingPermission.permissionType).toBe('file_write');
    expect(ctx.response.data.pendingPermission.risk).toBeDefined();
  });

  it('GET /v2/session/output omits pendingPermission when none pending', async () => {
    manager.start('output-no-perm');

    const ctx = makeCtx('GET', '/v2/session/output', {}, manager);
    ctx.url = new URL('http://localhost:3201/v2/session/output?project=output-no-perm&cursor=0');
    await handleV2Route(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.data.pendingPermission).toBeUndefined();
  });
});

// ─── Route Method Mismatch ──────────────────────────────────────────────────

describe('v2 routes reject wrong HTTP methods', () => {
  it('GET /v2/session/start is not handled', async () => {
    const ctx = makeCtx('GET', '/v2/session/start');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });

  it('POST /v2/sessions is not handled', async () => {
    const ctx = makeCtx('POST', '/v2/sessions');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });

  it('POST /v2/session/output is not handled', async () => {
    const ctx = makeCtx('POST', '/v2/session/output');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });

  it('POST /v2/session/status is not handled', async () => {
    const ctx = makeCtx('POST', '/v2/session/status');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });

  it('POST /v2/session/transcript is not handled', async () => {
    const ctx = makeCtx('POST', '/v2/session/transcript');
    const handled = await handleV2Route(ctx);
    expect(handled).toBe(false);
  });
});
