# Changelog

All notable changes to ClawBridge are documented in this file.

## [Unreleased]

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
