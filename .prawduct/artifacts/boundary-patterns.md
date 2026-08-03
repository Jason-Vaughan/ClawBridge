# Boundary Patterns — ClawBridge

<!-- Contract surfaces where components interact. When changes cross these
     boundaries, the builder investigates consumer impact before completing
     the chunk. The Critic verifies investigation occurred. -->

Backfilled 2026-08-02 during discovery reconciliation.

ClawBridge is unusually boundary-heavy for its size: it is *made of* contract surfaces.
Four of the five below are consumed by code this repo does not own and cannot update —
two published contracts, one foreign TUI, one native binary layout. That is why a small
diff here is not a small change.

## Contract Surfaces

### 1. HTTP JSON API — the published broker contract

- **Producer**: `bridge/v2/routes.js` (v2 surface), `bridge/server.js` (`/health`, `/projects/*`, `/api/processes`, `/prawduct/run`)
- **Consumer**: Any orchestrator over HTTP. Known: OpenClaw, TangleClaw (polls `/api/processes`; drove `attachIfExists` and `/v2/session/file`), plus unknown third parties — the package is public on npm.
- **Contract**: `GET /v2/api-docs` is the self-describing source of truth. Request/response field names and the error model (`{ error }` + HTTP status) are part of it. `README.md` prose is a mirror and has drifted before — it was corrected against api-docs in 1.6.0.
- **Consumer impact rule**: additive only. New capability arrives as an optional field whose default preserves today's behavior (`permissionMode`, `attachIfExists`, `consume`). Renaming or removing a field, or changing a status code, breaks deployments the author cannot see. If `/v2/api-docs` and the actual handler disagree, the handler is not the answer — they are both wrong until reconciled.
- **Tests**: `bridge/v2/__tests__/` broadly; `peek-and-docs.test.js` and `coexistence.test.js` guard the documented surface and v1/v2 coexistence.

### 2. Tools-extension module interface — the published in-process contract

- **Producer**: `bridge/server.js` (loader, dispatcher, health merge, shutdown)
- **Consumer**: A Node module supplied by the operator via `CLAWBRIDGE_TOOLS_MODULE`. RentalClaw's extension is the reference implementation and lives outside this repo.
- **Contract**: `docs/tools-extension.md` — `{ init, handleToolsRoute, getToolsHealth, close }`, plus six named guarantees (lazy load, single init, single close, prefix routing, failure isolation, no implicit resolution) and an explicit non-goals list.
- **Consumer impact rule**: the guarantees are the contract, not just the signatures. Changing *when* `init` is called relative to `listen()`, or letting an extension error escape and reach the broker, breaks the contract without changing a single type. The non-goals (one extension, fixed `/tools` prefix, no per-route auth opt-out) are v1 boundaries — moving one is a v2 decision, not a patch.
- **Tests**: `bridge/__tests__/tools-extension.test.js` — spawns real bridge subprocesses against `fixtures/mock-tools-extension.js` and asserts every error and degradation branch, including `close()` ordering during SIGTERM.

### 3. Claude Code TUI — the foreign contract this repo does not own

- **Producer**: Claude Code, upstream. Ships on its own schedule.
- **Consumer**: `bridge/v2/permission-parser.js` (prompt + confirmation patterns, ANSI normalization), `bridge/v2/sessions.js` (trust-prompt detection, keystroke injection).
- **Contract**: **Undocumented and unversioned** — rendered terminal output. The nearest thing to a spec is the "Known fragility" section of `docs/bridge-v2-maintainer-guide.md`, which names six ways this boundary breaks and the observable signal for each.
- **Consumer impact rule**: this boundary can break with **no change on this side**. Treat any chunk touching it as `**Foreign API:** Claude Code TUI`. Unit tests replay recorded output and therefore cannot detect that reality moved — a live E2E smoke run is mandatory (rollback norm 8). Keystroke semantics (`\r` approves, `\x1b` denies) and the 500ms render delay are part of this contract, not implementation detail.
- **Tests**: `regression.test.js` (every known bug), `permission-parser.test.js`, `permission-integration.test.js`; `e2e.test.js` behind `RUN_E2E=1` is the only test that touches the real boundary.

### 4. Host filesystem — project path boundary

- **Producer**: `bridge/v2/path-safety.js` — `validateProjectPath(projectsDir, project, subPath)`
- **Consumer**: `bridge/server.js` `/projects/:project/files/*` and `bridge/v2/routes.js` `/v2/session/file`.
- **Contract**: traversal, realpath and NUL rules. One implementation on purpose — extracted in 1.9.0 precisely so the v1 and v2 rules could not drift; the v1 function is now a thin shim.
- **Consumer impact rule**: never add a second path check. A new file-reading surface consumes this module or it does not ship.
- **Tests**: `bridge/v2/__tests__/session-file.test.js`, `bridge/__tests__/project-files.test.js`.

### 5. node-pty native layout — implicit dependency contract

- **Producer**: the installed `node-pty` package (`prebuilds/<platform>-<arch>/spawn-helper`, `build/Release/spawn-helper`).
- **Consumer**: `bridge/v2/spawn-helper.js` (boot-time exec-bit self-heal), `bridge/v2/pty.js`.
- **Contract**: an assumed on-disk path layout inside someone else's package. Upstream can move it without warning.
- **Consumer impact rule**: failure must stay observable rather than silent — `ptySpawnable` on `/health` exists because `ptyAvailable: true` masked a total-failure mode through an entire release (#16). Never let this degrade quietly.
- **Tests**: `bridge/v2/__tests__/spawn-helper.test.js`.

### Configuration interface

- **Producer**: `bridge/.env` / process env, read in `bridge/server.js`.
- **Consumer**: the whole process, at boot.
- **Contract**: the env-var table in `README.md` (`BRIDGE_PORT`, `BRIDGE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_BIN`, `PYTHON_BIN`, `PROJECTS_DIR`, `CLAWBRIDGE_TOOLS_MODULE`). Documented-but-unread is a real defect class here — `CLAUDE_BIN` was hardcoded despite being documented, and it took until 1.6.0 to catch.
- **Consumer impact rule**: a documented variable must actually be read; a read variable must be documented. `PROJECTS_DIR` and `EXPORTS_DIR` were both read by the code and missing from the README table; both were added 2026-08-02 (`DOC-8B84`, `EXP-9WQ2`). The rule is what matters going forward, not the two instances.

### Database schemas / IPC

Not applicable. No database and no persistence — session and event state are in-memory
only. The bridge↔Claude Code channel is the PTY, covered by surface 3 above; the tools
extension is in-process, not IPC.

## Test Levels

| Level | Exists | When to Run | Location |
|-------|--------|-------------|----------|
| Unit | Yes | Every change | `bridge/v2/__tests__/` (parser, policy, event-log, pty, types) |
| Integration | Yes | Changes crossing boundaries | `permission-integration.test.js`, `session-file.test.js`, `project-files.test.js` |
| Contract | Yes | API or extension-interface changes | `peek-and-docs.test.js`, `coexistence.test.js`, `tools-extension.test.js` (real subprocesses) |
| Regression | Yes | Every change to the PTY surface | `regression.test.js` — one named test per known bug, mapped in `docs/bridge-v2-bug-index.md` |
| End-to-end | Yes, gated | **Mandatory** for parser / ANSI / trust-buffer / PTY-timing changes; otherwise before release | `e2e.test.js`, run with `RUN_E2E=1 npm test` |

**Not automated:** none of these run in CI — there is no workflow in this repo. Every level
above is only as reliable as the human who remembered to run it. Filed as `TST-RYHK`.
