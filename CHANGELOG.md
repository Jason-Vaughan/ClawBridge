# Changelog

All notable changes to ClawBridge are documented in this file.

## [Unreleased]

### Added
- **`GET /v2/session/file` endpoint** (closes [#18](https://github.com/Jason-Vaughan/ClawBridge/issues/18)). Reads a project-relative file the AI wrote inside its working directory and returns the raw UTF-8 bytes verbatim — markdown intact, newlines preserved. Required because `/v2/session/output` is the rendered TUI paint stream: a 2026-06-20 spike against a live bridge confirmed it strips `##` headings, collapses newlines via cursor positioning, and mangles doubled delimiters like `<<TC:x>>`. Reconstructing structured AI judgment from that stream would need a full headless VT emulator; reading the AI's own file is robust and trivial. Query params: `project` (required), `path` (required, project-relative), `consume` (optional, default `false` — when `true`, unlinks the file after a successful read for one-shot wrap-capture semantics; a failed unlink returns `200` with `consumed:false` so bytes are never lost). Response: `{ ok, project, path, bytes, content, consumed }`. No active session required — resolved against `<projectsDir>/<project>`. Unblocks TangleClaw CC-7 "degraded wrap" capture-back for webui/gateway sessions.

### Changed
- **Path-safety primitive extracted to `bridge/v2/path-safety.js`** (`validateProjectPath(projectsDir, project, subPath)`). Shared between `server.js`'s `/projects/:project/files/*` surface and the new `/v2/session/file` so the traversal/realpath/NUL rules can't drift between v1 and v2 — security code wants one implementation. Behavior unchanged; the v1 `validateProjectPath` is now a thin shim that binds `PROJECTS_DIR`.

## [1.8.0] — 2026-06-20

### Added
- **`ptySpawnable` field on `GET /health`** (paired with the [#16](https://github.com/Jason-Vaughan/ClawBridge/issues/16) fix). `true` iff node-pty's `spawn-helper` exists for the running arch **and** has an exec bit. Re-checked per request so it reflects current on-disk state, not boot-time state. Crucially distinct from `ptyAvailable`: the native binding `dlopen`s without the helper needing `+x`, so the existing `ptyAvailable: true` masked the failure mode in #16. `ptyAvailable` is now also explicitly surfaced (previously only readable via `ptyMode`).

### Fixed
- **Boot-time self-heal for node-pty's `spawn-helper` exec bit** (closes [#16](https://github.com/Jason-Vaughan/ClawBridge/issues/16)). New `bridge/v2/spawn-helper.js` resolves the installed node-pty package and, for the running `${platform}-${arch}`, ensures `prebuilds/<plat-arch>/spawn-helper` (and any locally rebuilt `build/Release/spawn-helper`) has at least one exec bit set. Runs once at `bridge/v2/pty.js` load — before any `SessionManager` is constructed — so the first `/v2/session/start` cannot silently fail with `posix_spawnp failed`. Idempotent: already-executable helpers are left untouched; non-executable helpers are `chmod`ed with a single warning; a missing helper logs an error and reports not-spawnable without throwing. Durable across reinstalls in a way that `scripts/postinstall.js` alone is not — postinstall runs once at install time and won't catch later perm resets (filesystem sync, restore from a `cp` without `-p`).

## [1.7.1] — 2026-06-03

### Added
- **Cookbook recipe `examples/tools-extension-client.js`** (closes [#9](https://github.com/Jason-Vaughan/ClawBridge/issues/9)). Self-contained Node stdlib reference for the client side of the `/tools/*` contract — how a container agent, orchestrator, or any HTTP caller talks to whatever extension the bridge has mounted via `CLAWBRIDGE_TOOLS_MODULE`. Pairs with `docs/tools-extension.md` (which covers the author side). Demonstrates discovery via unauthenticated `GET /health`, bearer-token requests, retry/backoff for transient failures, and status-code-to-actionable-error translation (401/404/5xx). Surfaced by the ClawBridge#8 investigation, where the missing client-side documentation contributed to a misdiagnosis. `examples/README.md` updated with a matching recipe section.

## [1.7.0] — 2026-05-26

### Added
- **`attachIfExists` field on `POST /v2/session/start`** (closes [#5](https://github.com/Jason-Vaughan/ClawBridge/issues/5)). Optional boolean (default `false` — fully backward-compatible). When `true` and a non-terminal session already exists for the project, returns `200` with the existing session's `sessionId`, `state`, `createdAt`, and the current `cursor` (so the caller can resume polling from where the session stands) instead of `409 SESSION_EXISTS`. Response also includes `attached: true|false` so callers can tell create-from-attach. The existing session is **not** mutated on attach — `instruction`, `permissionMode`, `approvalEnvelope`, and timeouts from the attaching call are ignored (use `/v2/session/policy` or `/v2/session/send` for mid-session changes). Motivated by [TangleClaw#210](https://github.com/Jason-Vaughan/TangleClaw/issues/210) coordination: TC pre-creates a session via the SSH tunnel, then OpenClaw's chat UI calls `session/start` again on load — `attachIfExists` lets the chat UI always-call without 409 handling. Useful for any orchestrator that pre-creates sessions.

## [1.6.0] — 2026-05-26

### Added
- **`permissionMode` field on `POST /v2/session/start`** (closes [#2](https://github.com/Jason-Vaughan/ClawBridge/issues/2)). Accepts `default`, `acceptEdits`, `bypassPermissions`, `auto`, `plan`, or `dontAsk` and forwards as `--permission-mode <value>` to the claude spawn. Surfaced by a smoke test that found Claude Code 2.1.x's default auto mode bypasses the bridge's permission parser entirely — `approvalEnvelope` had no observable effect until callers could opt into a non-auto mode. Omitted = no flag = Claude's default (Option A: backward-compatible for existing deployments). Set `permissionMode: "default"` to engage the bridge's structured permission review.
- **`ptyMode` field in `/health`** — reports `pty` when node-pty loaded successfully, `pipes-fallback` when it didn't. Lets operators detect the degraded state (the pipes fallback cannot drive Claude Code's TUI; sessions appear to start but fail immediately).
- **`scripts/postinstall.js`** — restores the exec bit on node-pty's prebuilt `spawn-helper` binaries on macOS. Prevents the silent `posix_spawnp failed` crash on fresh installs (surfaced when a smoke test against a clean install showed all sessions failing with empty transcripts).
- **`examples/orchestrator-driver.js` + `examples/README.md`** — cookbook seed for the orchestrator side of the bridge. Self-contained Node.js reference for how to start a session with explicit `permissionMode`, poll `/v2/session/peek`, respond to permission prompts, send follow-up nudges, and end cleanly. Tracks the bridge contract via in-repo CI (recipes break the build if the API drifts).

### Fixed
- **`CLAUDE_BIN` env var now honored at `bridge/server.js:35`.** Was hardcoded to `/usr/local/bin/claude` despite the README documenting it as configurable. Bridges on hosts where `claude` lives elsewhere (e.g. `~/.local/bin/claude`) couldn't be pointed at the right binary.
- **Loud logging when node-pty fails to load** (`bridge/v2/pty.js`). Was silently falling back to pipes mode, which can't drive Claude Code's TUI — sessions would fail with no actionable error. Bridge now warns at startup with the exact fix instructions.
- **Session spawn-failure logging** (`bridge/v2/sessions.js`). Was emitting structured error events to the session's event log but logging nothing to bridge stdout, leaving operators blind. Now logs `[bridge] session <id> (<project>) FAILED: claude exited <code>. Last output: <snippet>` alongside the event-log entry.
- **README setup step.** Replaced incorrect `npx node-gyp rebuild` (fails — no `binding.gyp` in repo root) with `npm install` running the new postinstall script. Added a recovery note for the rare `posix_spawnp failed` case.
- **README API-field prose.** Tightened the Session Flow and Approval Envelope sections to match `/v2/api-docs` field names exactly: `approvalEnvelope` (not `envelope`), `permissionId` required on `/v2/session/respond`, decision values are `approve_once | deny | abort_session`.

### Changed
- **README scope refresh.** Clarified that ClawBridge is a Claude Code PTY permission broker with an optional, single-tenant embedded tools extension — *not* a general docker_host bridge to multiple host-side services. Added a "Secondary capability" paragraph to "What Problem It Solves" describing the `/tools/*` extension slot honestly. Updated the architecture diagram to show the optional `/tools/*` mount alongside the always-on PTY broker. Added a new "When to Use ClawBridge" section to help downstream deployments (OpenClaw stack docs, third-party integrators) make the right call about when the bridge fits and when a reverse proxy or different tool is needed.

## [1.5.0] — 2026-04-16

### Added
- **Tools extension point.** Optional `CLAWBRIDGE_TOOLS_MODULE` env var points at a Node module implementing `{ init, handleToolsRoute, getToolsHealth, close }`. When set, the bridge lazy-loads the module, dispatches `/tools/*` requests to it, merges its health under the `tools` key of `/health`, and awaits `close()` on SIGTERM/SIGINT. Absent the env var the bridge runs as a pure PTY broker (no `/tools/*` routes, no `tools` block in `/health`). Full contract, guarantees, and reference implementation in [docs/tools-extension.md](docs/tools-extension.md).
- Fixture `bridge/__tests__/fixtures/mock-tools-extension.js` and end-to-end test suite `bridge/__tests__/tools-extension.test.js` (21 tests) covering mount, exact-`/tools` path, `/health` merge, bridge-level auth, decline → canonical 404, non-`/tools` bypass, init-delay race (TCP refused during init), single-`close()` on repeated signals, all three error paths (handler/health/close), and graceful degradation for every invalid-loader branch (unset, relative, missing file, require-time throw, each missing required export).

### Changed
- Server startup is now async (`startServer()`) — the bridge awaits `toolsExtension.init()` before `server.listen()`. If init rejects, the extension is disabled and the bridge starts anyway.
- `shutdown()` is now idempotent and async — guarded against repeated SIGTERM/SIGINT so `toolsExtension.close()` runs exactly once per the v1 contract. The extension reference is nulled before the awaited close so late `/tools/*` requests fall through to 404 rather than hitting a closing extension.
