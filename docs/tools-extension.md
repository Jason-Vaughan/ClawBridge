# ClawBridge Tools Extension Point

**Status:** v1 (implemented)
**Env var:** `CLAWBRIDGE_TOOLS_MODULE`

## Purpose

ClawBridge is a PTY permission broker for Claude Code sessions. Some consumers (e.g., RentalClaw) embed an additional HTTP service inside the bridge process, mounted under the `/tools/*` prefix. Historically this was done by vendoring a `tools-router.js` file directly into `bridge/`. That approach coupled the public bridge to one specific consumer.

The **tools extension point** replaces vendoring with a documented interface. Set `CLAWBRIDGE_TOOLS_MODULE` to the path of a Node module implementing the interface below, and ClawBridge will lazy-load it at startup, dispatch `/tools/*` requests to it, merge its health into `/health`, and shut it down cleanly on exit.

Absent `CLAWBRIDGE_TOOLS_MODULE`, ClawBridge runs as a pure PTY broker — no `/tools/*` routes, no `tools` block in `/health`. This is the default.

## Interface

The module referenced by `CLAWBRIDGE_TOOLS_MODULE` must export four async functions via CommonJS or ESM default:

```js
module.exports = {
  init,
  handleToolsRoute,
  getToolsHealth,
  close,
};
```

### `init() → Promise<void>`

Called once at bridge startup, before `server.listen()`. Initialize your embedded service, build routes, connect to databases, etc. The bridge **waits** for this promise before it begins accepting connections.

- Throw or reject if initialization fails. ClawBridge will log the failure and continue starting **without** `/tools/*` support (graceful degradation — the broker stays usable).
- Do **not** `listen()` on a port. You are a request handler, not a server.

### `handleToolsRoute({ pathname, req, res }) → Promise<boolean>`

Called for every incoming HTTP request whose pathname is `/tools` or starts with `/tools/`. Dispatch the request through your internal router and write the response to `res`.

Arguments:
- `pathname` — the full request pathname (already determined to be under `/tools`).
- `req` — Node `http.IncomingMessage`. The module is permitted to **mutate `req.url`** to strip the `/tools` prefix before forwarding to its internal router (see reference implementation).
- `res` — Node `http.ServerResponse`.

Return `true` if the request was handled (response written — this is the normal case; the extension's internal router is responsible for writing a 404 for its own unknown routes). Return `false` to decline the request entirely — ClawBridge will then send its top-level 404. The false-return path exists for extensions that want to claim only a subset of `/tools/*` and defer the rest; for most extensions (including the reference impl) this branch is never taken. Rejecting the promise is treated as an internal error; ClawBridge will send a 500.

### `getToolsHealth() → Promise<object>`

Called whenever ClawBridge's `/health` endpoint is hit. Return a JSON-serializable object describing your extension's health. ClawBridge embeds the return value under `tools` in its `/health` response:

```json
{
  "ok": true,
  "version": "1.5.0",
  "tools": { "ok": true, "endpoints": 62, "db": "connected" }
}
```

**Layering:** the extension returns whatever health object makes sense for its domain — it should not worry about representing its own absence. ClawBridge wraps the call: if the extension's `getToolsHealth` rejects or throws, ClawBridge substitutes `{ ok: false, error: "<message>" }` under `tools`. If the extension returns normally, ClawBridge embeds the return value verbatim. Tools failure never flips `ok: true → false` on the root payload.

### `close() → Promise<void>`

Called during graceful shutdown (SIGINT, SIGTERM). Close connections, flush buffers, stop timers. ClawBridge **awaits** this before exiting.

## Configuration

### Env var

```
CLAWBRIDGE_TOOLS_MODULE=/absolute/path/to/your-extension.js
```

The path must be absolute. **Path validation is ClawBridge's responsibility** — it reads the env var, checks `path.isAbsolute()`, and rejects relative paths with a startup warning (the extension is not consulted). If the path does not exist, ClawBridge logs a warning and starts without the extension. The extension itself never sees this env var.

### Additional env vars (extension's own)

Your extension may define its own env vars. ClawBridge passes the entire `process.env` through without filtering. Document them in your extension's README. Example from RentalClaw's extension:

```
TOOLS_DIST=/absolute/path/to/tools/dist/server.js    # RC-specific: where to find compiled Fastify app
```

## Reference Implementation

RentalClaw's extension is the reference implementation (lives in RentalClaw's `tools/` package after extraction). It wraps a Fastify app via `inject()`:

```js
'use strict';
let _app = null;

async function init() {
  const distPath = process.env.TOOLS_DIST;
  if (!distPath) throw new Error('TOOLS_DIST env var required');
  const { buildApp } = await import(distPath);
  _app = buildApp({ skipAuth: true });
  await _app.ready();
}

async function handleToolsRoute({ pathname, req, res }) {
  if (!_app) return false;
  req.url = req.url.replace(/^\/tools/, '') || '/';
  if (req.url.startsWith('?')) req.url = '/' + req.url;
  _app.routing(req, res);
  return true;
}

async function getToolsHealth() {
  if (!_app) return { ok: false, error: 'not initialized' };
  const r = await _app.inject({ method: 'GET', url: '/health' });
  return r.statusCode === 200 ? JSON.parse(r.body) : { ok: false, error: `HTTP ${r.statusCode}` };
}

async function close() {
  if (_app) { await _app.close(); _app = null; }
}

module.exports = { init, handleToolsRoute, getToolsHealth, close };
```

This is ~30 non-blank lines. If your extension is a plain Express or raw-http handler, it is even simpler — your `handleToolsRoute` just calls your own listener's request dispatcher.

## Guarantees from ClawBridge

1. **Lazy load.** `require(CLAWBRIDGE_TOOLS_MODULE)` only happens if the env var is set.
2. **Single init.** `init()` is called exactly once before `server.listen()`.
3. **Single close.** `close()` is called exactly once during shutdown.
4. **Prefix routing.** Only requests under `/tools` are sent to `handleToolsRoute`. Everything else (broker routes, `/health`, `/v2/*`, `/api/processes`, etc.) is served by ClawBridge directly.
5. **Isolation of failure.** If `init()` or any call throws, ClawBridge logs and continues — the broker never crashes because of the extension.
6. **No implicit resolution.** ClawBridge does not search for `tools/dist/server.js` or similar. The extension path must be explicit.

## Non-goals (v1)

- **Multiple extensions.** ClawBridge mounts at most one tools module. Multi-extension is a v2 concern.
- **Custom prefix.** The mount prefix is always `/tools`. Extensions may not claim `/v2`, `/api/*`, or other bridge-reserved namespaces.
- **Auth delegation mechanism.** ClawBridge's bearer-token auth runs **before** `handleToolsRoute` is invoked — for every request under `/tools/*` without exception. The extension receives only authenticated requests. Extensions **cannot** opt specific routes out of bridge-level auth in v1 (e.g., there is no public `/tools/health` equivalent to the bridge's unauthenticated `/health`). Extensions may implement additional in-extension auth on top if needed. Per-route auth opt-out is a v2 concern.
- **Hot reload.** Changing `CLAWBRIDGE_TOOLS_MODULE` requires a bridge restart.

## Migration

For consumers currently vendoring `tools-router.js` into their fork of `bridge/`:

1. Move the file out of `bridge/` into your own package.
2. Ensure the file exports `{ init, handleToolsRoute, getToolsHealth, close }` (this is already the shape in the reference impl).
3. Install ClawBridge from npm; delete your vendored `bridge/` directory.
4. Set `CLAWBRIDGE_TOOLS_MODULE=/absolute/path/to/your/extension.js` in your runtime environment (plist, systemd unit, docker-compose, etc.).
5. Set any extension-specific env vars your module reads.
6. Restart the bridge.

## Testing

The repo ships a fixture extension at `bridge/__tests__/fixtures/mock-tools-extension.js` that toggles behavior via env vars (`MOCK_TOOLS_INIT_THROW`, `MOCK_TOOLS_ROUTE_THROW`, `MOCK_TOOLS_HEALTH_THROW`, `MOCK_TOOLS_CLOSE_THROW`) and records lifecycle events to the file at `MOCK_TOOLS_LOG`. The companion test file `bridge/__tests__/tools-extension.test.js` spawns real bridge subprocesses against the fixture and covers:

- `/tools/*` dispatch and prefix matching (including the `/tools/decline → false → 404` branch)
- `/health` merge semantics (success, extension throw → `{ ok: false, error }`, extension absent → no `tools` key)
- bridge-level auth running before `handleToolsRoute`
- non-`/tools` paths bypassing the extension entirely
- error paths in `handleToolsRoute` (500), `getToolsHealth` (substituted), and `close` (logged, shutdown continues)
- graceful degradation when the env var is unset, relative, a missing file, or points at a module missing a required export
- `close()` invoked after `init-ok` during SIGTERM shutdown (ordering asserted via the log file)

Run with `npm test`.

## Deferred for v2

1. Pre-stripped URLs in `handleToolsRoute`. Reference implementation strips internally; keeping the current shape means simpler extensions must do the same. Consider an opt-in flag via `init()` if a third-party consumer requests it.
2. Configurable `/health` key. v1 hardcodes `tools`. Revisit if another consumer wants a different name.
3. Per-route auth opt-out. Bridge-level bearer-token auth runs for every `/tools/*` request. Extensions may layer their own sub-auth today but cannot declare a public sub-route.
4. Multiple extensions mounted under distinct prefixes.
