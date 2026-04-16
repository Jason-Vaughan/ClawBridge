# Changelog

All notable changes to ClawBridge are documented in this file.

## [Unreleased]

### Added
- Tools extension point: optional `CLAWBRIDGE_TOOLS_MODULE` env var points at a Node module implementing `{ init, handleToolsRoute, getToolsHealth, close }`. The bridge lazy-loads it at startup, dispatches `/tools/*` requests to it, merges its health under the `tools` key of `/health`, and closes it on SIGTERM/SIGINT. Absent the env var the bridge runs as a pure PTY broker (no `/tools/*` routes, no `tools` block in `/health`). See [docs/tools-extension.md](docs/tools-extension.md) for the full contract.
- Fixture `bridge/__tests__/fixtures/mock-tools-extension.js` and end-to-end test `bridge/__tests__/tools-extension.test.js` covering mount, prefix routing, health merging, auth, decline semantics, handler/health/close error paths, graceful-degradation on init failure, and all four invalid-path branches (unset, relative, missing file, missing export).

### Changed
- Server startup is now async (`startServer()`) so `toolsExtension.init()` resolves before `server.listen()`. If init rejects, the extension is disabled and the bridge starts anyway.
- Shutdown now awaits `toolsExtension.close()` after destroying v2 sessions.
