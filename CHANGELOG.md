# Changelog

All notable changes to ClawBridge are documented in this file.

## [Unreleased]

## [1.5.0] — 2026-04-16

### Added
- **Tools extension point.** Optional `CLAWBRIDGE_TOOLS_MODULE` env var points at a Node module implementing `{ init, handleToolsRoute, getToolsHealth, close }`. When set, the bridge lazy-loads the module, dispatches `/tools/*` requests to it, merges its health under the `tools` key of `/health`, and awaits `close()` on SIGTERM/SIGINT. Absent the env var the bridge runs as a pure PTY broker (no `/tools/*` routes, no `tools` block in `/health`). Full contract, guarantees, and reference implementation in [docs/tools-extension.md](docs/tools-extension.md).
- Fixture `bridge/__tests__/fixtures/mock-tools-extension.js` and end-to-end test suite `bridge/__tests__/tools-extension.test.js` (21 tests) covering mount, exact-`/tools` path, `/health` merge, bridge-level auth, decline → canonical 404, non-`/tools` bypass, init-delay race (TCP refused during init), single-`close()` on repeated signals, all three error paths (handler/health/close), and graceful degradation for every invalid-loader branch (unset, relative, missing file, require-time throw, each missing required export).

### Changed
- Server startup is now async (`startServer()`) — the bridge awaits `toolsExtension.init()` before `server.listen()`. If init rejects, the extension is disabled and the bridge starts anyway.
- `shutdown()` is now idempotent and async — guarded against repeated SIGTERM/SIGINT so `toolsExtension.close()` runs exactly once per the v1 contract. The extension reference is nulled before the awaited close so late `/tools/*` requests fall through to 404 rather than hitting a closing extension.
