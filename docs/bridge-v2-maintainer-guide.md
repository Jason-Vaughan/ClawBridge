# Bridge v2 Maintainer Guide

This guide is for anyone maintaining the bridge v2 PTY broker. It covers architecture, data flow, known fragility, and operational norms.

## What the bridge does

ClawBridge is an HTTP server (default port 3201) that lets an orchestrator drive Claude Code sessions via the v2 PTY broker API.

- **v2 (PTY broker):** Interactive. Spawns Claude Code in a real PTY, detects permission prompts from the TUI output, and lets the orchestrator approve/deny each one. Routes: `/v2/session/*`.

## File map

```
bridge/
  server.js              ← HTTP server, auth, routing, v1 endpoints, v2 delegation
  v2/
    types.js             ← Enums: SessionState, EventKind, PermissionType, RiskLevel, etc.
    pty.js               ← PTY process wrapper (node-pty or child_process fallback)
    permission-parser.js ← Detects permission prompts from raw PTY output
    policy.js            ← Evaluates permissions against approval envelopes
    event-log.js         ← Append-only event log with cursor-based reads and long-poll
    sessions.js          ← Session + SessionManager: lifecycle, timers, permission flow
    routes.js            ← v2 HTTP route handlers
    __tests__/           ← 15 test files, 405+ tests
```

### Module responsibilities

| Module | Owns | Depends on |
|--------|------|-----------|
| `types.js` | All enums, state machine graph, terminal state set | Nothing |
| `pty.js` | Process spawning, stdin/stdout, kill/destroy | node-pty (optional) |
| `permission-parser.js` | ANSI stripping, prompt detection, risk assignment | `types.js` |
| `policy.js` | Envelope validation, rule matching, decision logic | `types.js`, `permission-parser.js` (for `isDestructiveGit`) |
| `event-log.js` | Event storage, cursor reads, long-poll, transcript | `types.js` |
| `sessions.js` | Session state machine, PTY lifecycle, timers, trust prompt, permission flow, send/end | Everything above |
| `routes.js` | HTTP request handling, validation, error codes | `sessions.js` |
| `server.js` | Glue: HTTP server, auth, v2 delegation, shutdown | `sessions.js`, `routes.js` |

## Data flow: permission detection pipeline

This is the core of v2. Understanding this flow is essential for any maintenance work.

```
Claude Code PTY
       │
       ▼ raw output (ANSI codes, cursor moves, redraws)
┌──────────────────────────────────────────────────────────────┐
│  sessions.js: ptyProc.on('data', ...)                        │
│                                                              │
│  1. Always: append raw text to EventLog (appendText)         │
│                                                              │
│  2. Trust prompt handling (first few KB only):               │
│     - Buffer data until trust prompt detected OR             │
│       tool-call text detected (Write/Edit/Bash/Cooking) OR   │
│       buffer exceeds 2KB safety valve                        │
│     - If trust prompt: send \r after 500ms, discard buffer   │
│     - If tool-call or overflow: FLUSH buffer to parser       ���
│                                                              │
│  3. After trust handled: feed every chunk to parser          │
│     (skip if session is terminal or WAITING_FOR_PERMISSION)  │
└─────────────────────────────────────���────────────────────────┘
       │
       ▼ clean text (ANSI stripped)
┌──────��─────────────────────���─────────────────────────────────┐
│  permission-parser.js: PermissionParser.feed()               │
│                                                              │
│  1. If _pendingDetection is true → return null (one at a     │
│     time)                                                    │
│                                                              │
│  2. Strip ANSI from incoming chunk:                          │
│     a. Replace \x1b[\d*C (cursor-right) with SPACE           │
│     b. Strip all other CSI/OSC/escape sequences to empty     │
│     c. Strip \r (carriage returns)                           │
│                                                              │
│  3. Append cleaned text to buffer (8KB max, keeps tail)      │
│                                                              │
│  4. _scan():                                                 │
│     a. Check CONFIRMATION_PATTERN against full buffer         │
│        - Must match: "Allow?", "Do you want to...",          │
│          "(y/n)", "[Y/N]", "1. Yes", "Esc to cancel"        │
│        - If no confirmation → return null (no permission)    │
│     b. Split buffer into lines, scan BOTTOM-UP               │
│     c. Match each line against PROMPT_PATTERNS:              │
│        - "Claude wants to write/create/edit/delete <path>"   │
��        - "Claude wants to run/execute: <command>"            │
│        - "Write(<path>)", "Edit(<path>)", "Bash(<command>)"  │
│     d. First match (from bottom) → build permission event    │
│     e. No match but confirmation exists → check cooldown:    │
│        - Within 2s of last reset → suppress (menu remnants)  │
│        - Past cooldown + confirmation in last 200 chars →    │
│          emit UNKNOWN permission                             │
│                                                              │
│  5. Set _pendingDetection = true, fire onPermission callback │
└──────────────���───────────────────────────────────────────────┘
       │
       ▼ structured permission event
┌──────���───────────────────────────────────────────────────────┐
│  sessions.js: onPermission callback                          │
│                                                              │
│  1. Evaluate against approval envelope (policy.js)           │
│     → returns: auto_approve | deny | require_review          │
│                                                              │
│  2a. AUTO_APPROVE:                                           │
│      - Log DECISION event (actor: 'policy')                  │
│      - Reset parser                                          │
│      - setTimeout(500ms) → write \r to PTY (Enter)           │
│                                                              │
│  2b. DENY:                                                   │
│      - Log DECISION event (actor: 'policy')                  │
│      - Reset parser                                          │
│      - setTimeout(500ms) → write \x1b to PTY (Escape)        │
│                                                              │
│  2c. REQUIRE_REVIEW:                                         │
│      - Set pendingPermission on session                      │
│      - Transition to WAITING_FOR_PERMISSION                  │
│      - Start prompt timer (5 min default)                    │
│      - Wait for respond() call from orchestrator              │
└───────────────────────────────────────────────���──────────────┘
       │
       ▼ (if require_review) orchestrator calls POST /v2/session/respond
┌─────────────────────────────────────��────────────────────���───┐
│  sessions.js: SessionManager.respond()                       │
│                                                              │
│  1. Validate: correct session, correct permission ID,        │
│     valid decision (approve_once | deny | abort_session)     │
│  2. Clear prompt timer                                       │
│  3. Log DECISION event                                       │
│  4. Clear pendingPermission, reset parser                    │
│  5. Write to PTY:                                            │
│     - approve_once → \r (Enter)                              │
│     - deny → \x1b (Escape)                                   │
│     - abort_session → kill PTY, transition to FAILED         │
│  6. Transition back to RUNNING                               │
└────────────────���─────────────────────────────────────────────┘
```

## Session state machine

```
                    ┌──────────┐
                    │ STARTING │
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         ┌─────────┐          ┌────────┐
    ┌───▶│ RUNNING │◀────────▶│ WAITING│ (for permission)
    │    └────┬────┘          └───┬────┘
    │         │                   │
    │    ┌────┴────┬──────┐  ┌───┴───┬─────��┐
    │    ▼         ▼      ▼  ▼       ▼      │
    │ COMPLETED  FAILED  TIMED_OUT          │
    │    │         │       │                │
    │    └────┬────┴───────┘                │
    │         ▼                             │
    │      ENDED                            │
    └───────────────────────────────────────┘
         (respond → back to RUNNING)
```

**Rules:**
- Only one active (non-terminal) session per project
- Terminal states: COMPLETED, FAILED, TIMED_OUT, ENDED
- Starting a new session on a project with a terminal session overwrites it
- ENDED is the final state — all terminal states can transition to ENDED
- ENDED has no outbound transitions

## Approval envelope structure

The envelope is the orchestrator's way of telling the bridge which permissions to auto-handle vs. pause for review.

```json
{
  "mode": "scoped",
  "projectRoot": "/path/to/project",
  "rules": {
    "fileWrites": { "withinProject": "auto_approve", "outsideProject": "deny" },
    "fileDeletes": { "withinProject": "require_review", "outsideProject": "deny" },
    "shellCommands": {
      "allowlist": ["npm test", "npm run build", "node"],
      "allowlistPolicy": "auto_approve",
      "otherPolicy": "require_review"
    },
    "gitOperations": { "safe": "auto_approve", "destructive": "deny" },
    "dependencyChanges": "require_review",
    "networkAccess": "deny",
    "configChanges": "require_review",
    "unknown": "require_review"
  },
  "defaults": {
    "lowRisk": "auto_approve",
    "mediumRisk": "require_review",
    "highRisk": "deny"
  }
}
```

**Evaluation order:** specific rule match → risk-based default → require_review (fail-closed).

No envelope at all = everything requires review.

## Where ANSI normalization happens

All in `permission-parser.js:stripAnsi()`. One function, two stages:

1. **Cursor-right** (`\x1b[\d*C`) → replaced with **space** (preserves token boundaries)
2. **Everything else** (CSI, OSC, charset switches, `\r`) → replaced with **empty string**

This is called in two places:
- `PermissionParser.feed()` — before buffering for prompt detection
- Trust prompt detection in `sessions.js` — inline strip for matching, not via `stripAnsi()` export (uses same regex patterns)

**Critical lesson from Bug #11:** cursor-right MUST become a space, not empty. Claude Code uses `\x1b[1C` as a visual gap between tokens (e.g., between `node` and `src/add.test.js`). Stripping to empty concatenates them → approval logic fails.

## Where input injection happens

Every place the bridge writes to the PTY stdin:

| Location | What | Character | Why |
|----------|------|-----------|-----|
| `sessions.js` onPermission (auto-approve) | Confirm "Yes" menu selection | `\r` (Enter) | Pre-selected option, just confirm |
| `sessions.js` onPermission (auto-deny) | Cancel permission menu | `\x1b` (Escape) | Dismiss the menu |
| `sessions.js` trust prompt handler | Confirm workspace trust | `\r` (Enter) | "Yes" is pre-selected |
| `sessions.js` respond() (approve_once) | Confirm after human review | `\r` (Enter) | Same as auto-approve |
| `sessions.js` respond() (deny) | Cancel after human review | `\x1b` (Escape) | Same as auto-deny |
| `sessions.js` respond() (abort_session) | Kill PTY | `pty.kill()` | Hard stop |
| `sessions.js` send() | Send message to running session | `message + \r` | \r submits in TUI |
| `sessions.js` end() | Send wrap-up message | `wrapMessage + \r` | Same as send |
| `sessions.js` prompt timeout | Auto-deny on timeout | `\x1b` (Escape) | Same as deny |

**Critical lesson from Bug #9:** Claude Code's TUI requires `\r` (carriage return / Enter), not `\n` (newline). Newline doesn't submit — it just inserts into the input buffer.

**Critical lesson from Bug #6:** All auto-approve/deny writes use `setTimeout(500ms)` to let the interactive menu finish rendering before the keystroke is sent.

## Known fragility

These areas are inherently coupled to Claude Code's TUI behavior and may break when Claude Code updates:

### 1. Permission prompt format
The parser matches specific text patterns. If Claude Code changes how it announces permissions (wording, structure, tool-call format), detection will fail silently — no permission event emitted, session stays in RUNNING, and Claude blocks waiting for input.

**Signal:** Session appears stuck in RUNNING with no permission events.

### 2. Interactive menu format
The CONFIRMATION_PATTERN matches specific menu patterns ("1. Yes", "Esc to cancel"). If the menu format changes, the parser won't recognize the confirmation and won't emit the permission event even though it sees the Write/Edit/Bash line.

**Signal:** Same as above — stuck RUNNING.

### 3. Keystroke semantics
`\r` for approve, `\x1b` for deny/cancel. If Claude Code changes which keys do what in permission menus, the bridge sends the wrong response.

**Signal:** Approvals get denied or vice versa. "Error writing file" after apparent approval.

### 4. Trust prompt detection
Matches "one you trust" / "trust this project" / "safety check". If the wording changes, trust won't auto-confirm, and the trust buffer safety valve (2KB) will flush all that text into the permission parser — which may cause false detections.

**Signal:** First few seconds of session are chaotic. False permission events or missed early permissions.

### 5. PTY chunk boundaries
Real PTY output arrives in arbitrary-sized chunks. A permission prompt can be split across chunks, arrive interleaved with ANSI redraws, or be partially overwritten by cursor movement. The 8KB buffer and bottom-up scan handle most cases, but novel chunk patterns can still fool the parser.

**Signal:** Intermittent — works sometimes, fails other times, depending on chunk timing.

### 6. Idle/completion inference
Claude Code does not terminate after completing a task — it stays RUNNING, waiting for more input. "Done" must be inferred from summary text, quiet output, or idle signals. If Claude Code changes its summary wording, adds post-task chatter, or alters idle behavior, the caller's completion detection breaks even though the bridge and parser are working correctly.

**Signal:** Session stays RUNNING indefinitely after task appears complete. Caller can't tell if Claude is still working or waiting for input.

### Design principle: false negatives are safer than false positives

The permission parser is intentionally conservative. It will miss a novel permission prompt (false negative — session blocks, caller notices) rather than fire on a tool-call announcement or UI fragment (false positive — sends keystroke into wrong context, causes "Error writing file" or silent corruption). When maintaining the parser, preserve this bias. Overeager matching was the root cause of bugs #5, #6, and #10.

## Event kinds reference

The event log uses these event kinds (defined in `types.js`):

| Kind | Emitted by | Contains |
|------|-----------|----------|
| `text` | `sessions.js` (PTY data handler) | `{ text, stream }` — raw PTY output |
| `lifecycle` | `Session.transition()` | `{ fromState, toState }` — state changes |
| `permission` | `sessions.js` (onPermission callback) | `{ event }` — full structured permission event |
| `decision` | `sessions.js` (onPermission / respond / timeout) | `{ permissionId, decision, actor, reason }` |
| `error` | `sessions.js` (PTY exit / timeout handlers) | `{ code, message, details }` |

## Implementation note: terminal state checks

All logic that reasons about session liveness must use `session.isTerminal` (which checks against the `TERMINAL_STATES` set), not ad-hoc comparisons like `state !== 'ended'`. Bugs #7 and #8 were both caused by checking for specific states instead of using the terminal-state helper. Any new code that needs to know "is this session still alive" should use `isTerminal`.

## API reference (v2 routes)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v2/session/start` | Spawn new PTY session for a project |
| `POST` | `/v2/session/end` | Graceful shutdown with optional wrap message |
| `GET` | `/v2/session/output` | Poll events (cursor-based, long-poll via `waitMs`) |
| `POST` | `/v2/session/respond` | Submit permission decision |
| `POST` | `/v2/session/send` | Send follow-up message to running session |
| `POST` | `/v2/session/policy` | Update approval envelope mid-session |
| `GET` | `/v2/session/transcript` | Export raw transcript (terminal sessions only) **— secondary; prefer `includeTranscript: true` on end, since this route fails if bridge restarts and loses in-memory state** |
| `GET` | `/v2/session/status` | Check session state |
| `GET` | `/v2/sessions` | List sessions (active-only by default, `?all=true` for all) |

## Test structure

405+ tests across 15 files in `bridge/v2/__tests__/`:

| File | What it covers |
|------|---------------|
| `permission-parser.test.js` | stripAnsi, isWithinProject, classifyCommand, assignRisk, PermissionParser |
| `policy.test.js` | Envelope validation, rule matching, defaults, edge cases |
| `sessions.test.js` | State machine, SessionManager start/end/list, PTY integration |
| `permission-integration.test.js` | Full pipeline: parser → policy → decision |
| `permission-respond.test.js` | respond() flow: approve/deny/abort |
| `send.test.js` | send() input injection, error cases |
| `event-log.test.js` | Append, read, cursor, long-poll, transcript |
| `output-polling.test.js` | Long-poll mechanics, timeout, event delivery |
| `timeouts.test.js` | Prompt timeout, session timeout, graceful shutdown |
| `error-paths.test.js` | Unexpected PTY exit, error events, state transitions |
| `transcript.test.js` | Transcript generation and export |
| `coexistence.test.js` | v1/v2 route coexistence, v2 route handling |
| `pty.test.js` | PTY spawn, write, kill, events |
| `regression.test.js` | All 11 E2E bugs (target misattribution, cooldown, \r vs \n, etc.) |
| `e2e.test.js` | Live PTY E2E (gated: `RUN_E2E=1`, needs real Claude binary) |

**Running tests:** `npm test`

**Running E2E:** `RUN_E2E=1 npm test` (requires Claude Code installed, will spawn real sessions)

## Operational reference

### Deployment

- **Bridge location:** `<deploy-dir>/` (e.g., `~/clawbridge/`)
- **Port:** Configured via `BRIDGE_PORT` in `.env` (default: 3201)
- **Process manager:** launchd on macOS (`com.clawbridge.builder`), systemd on Linux
- **Auth token:** `<deploy-dir>/.env` (`BRIDGE_TOKEN`)
- **Projects directory:** Configured via `PROJECTS_DIR` env var

### Common operations

```bash
# Restart bridge (macOS — KeepAlive auto-restarts it)
launchctl stop com.clawbridge.builder

# Check health
curl -s http://localhost:3201/health | jq .

# Deploy updated files
scp bridge/v2/*.js <host>:<deploy-dir>/bridge/v2/
ssh <host> "launchctl stop com.clawbridge.builder"

# Check active v2 sessions
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3201/v2/sessions | jq .

# Clean up test project
rm -rf $PROJECTS_DIR/bridge-v2-smoke
```

### Circuit breaker

The bridge has a circuit breaker (v1 only) that trips after 3 consecutive build failures. It does not affect v2 sessions.

```bash
# Check status
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3201/circuit-breaker | jq .

# Reset
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3201/circuit-breaker/reset | jq .
```

## Rollback norms

Any maintenance run on the bridge should follow these rules:

1. **Test first.** Run `npm test` locally before deploying. All 405+ tests must pass.
2. **Regression check.** `regression.test.js` specifically covers the 11 known fragile areas — if any fail, do not deploy.
3. **Deploy incrementally.** SCP changed files only, restart bridge. Don't replace the whole directory.
4. **Verify health.** `curl http://localhost:3201/health` after restart — confirm `v2ActiveSessions: 0` and Claude version present.
5. **Easy rollback.** Keep the previous version of any changed file. If something breaks:
   ```bash
   scp bridge/v2/permission-parser.js.bak <host>:<deploy-dir>/bridge/v2/permission-parser.js
   ssh <host> "launchctl stop com.clawbridge.builder"
   ```
6. **Human-visible summary.** Before any deployment, produce a summary of what changed and why. The reviewer should be able to understand the change without reading the diff.
7. **Don't change ANSI stripping or input injection casually.** These are the two areas where "works in tests, fails in live PTY" is most likely. Changes to `stripAnsi()`, `CONFIRMATION_PATTERN`, `PROMPT_PATTERNS`, or any `pty.write()` call should be accompanied by a live E2E smoke run.
8. **Live E2E smoke run for any parser/timing change.** Any change touching parser logic, ANSI normalization, trust buffering, or PTY input timing must get one live E2E smoke run before being considered done. Unit tests are necessary but not sufficient for these areas — the E2E campaign proved this repeatedly across 9 rounds.
