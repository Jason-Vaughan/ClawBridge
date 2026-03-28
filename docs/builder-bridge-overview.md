# ClawBridge — OpenClaw ↔ Claude Code

**Created:** 2026-03-23
**Status:** Deployed and verified (v1: 2026-03-23, v2 PTY broker: 2026-03-24)
**Purpose:** Allow the OpenClaw agent (inside Docker) to invoke Claude Code + prawduct on the host for autonomous tool-building.

---

## The Problem

OpenClaw runs inside a Docker container (`/home/node/`). Claude Code and prawduct are installed on the habitat host (`/Users/habitat-admin/`). There is no mechanism for the container to execute commands on the host.

Port 18790 (`OPENCLAW_BRIDGE_PORT`) is OpenClaw's internal RPC — it is **not** a general-purpose command bridge.

## Scope

This bridge lives **entirely on the host machine**. It is a localhost service that the Docker container talks to.

## Architecture

```
┌──────────────────────────────────┐
│  OpenClaw Container (Docker)     │
│  Agent: Codex (gpt-5.4)         │
│  Role: Architect — decides what  │
│        to build and why          │
│                                  │
│  Calls builder-bridge via HTTP   │
│  http://host.docker.internal:3201│
└──────────────┬───────────────────┘
               │ HTTP (JSON API)
               ▼
┌──────────────────────────────────┐
│  Builder Bridge (habitat host)   │
│  Lightweight HTTP service        │
│  Port: 3201 (localhost only)     │
│                                  │
│  Accepts build commands from     │
│  OpenClaw, executes Claude Code  │
│  or prawduct on host, returns    │
│  results.                        │
└──────────────┬───────────────────┘
               │ subprocess
               ▼
┌──────────────────────────────────┐
│  Claude Code / prawduct          │
│  /usr/local/bin/claude           │
│  ~/prawduct/tools/prawduct-setup │
│  Working dir: project root       │
└──────────────────────────────────┘
```

## Host Environment (Verified 2026-03-23)

| Component | Location | Version |
|-----------|----------|---------|
| Claude Code | `/usr/local/bin/claude` | 2.1.81 |
| Node.js | `/usr/local/bin/node` | v22.14.0 |
| npm | `/usr/local/bin/npm` | 10.9.2 |
| Python 3 | `/usr/bin/python3` | 3.9.6 |
| prawduct | `~/prawduct` | v1.2.0 |
| PATH fix | `~/.zshrc` exports `/usr/local/bin` | Applied 2026-03-23 |

**SSH access from Cursatory:** `ssh habitat` (uses `~/.ssh/config` entry: user `habitat-admin`, key `~/.ssh/genesis_habitat`)

## Bridge Service Design

A minimal Node.js service on the habitat host that:

1. **Listens** on port 3201 (or any free port on habitat — just pick one and use it)
2. **Authenticates** requests via Bearer token (shared secret)
3. **Accepts** JSON command payloads:
   - `claude` — run Claude Code with given prompt/flags in a specified working directory
   - `prawduct` — run prawduct-setup commands (setup, sync, validate)
   - `status` — health check, report what's available
4. **Executes** the command as a child process on the host
5. **Streams or returns** stdout/stderr back to caller
6. **Enforces** an allowlist of commands (only `claude`, `python3 ~/prawduct/tools/prawduct-setup.py`, and approved scripts)

### Endpoints

```
GET  /health              → { ok: true, claude: "2.1.81", node: "22.14.0" }

POST /claude/run
  { "prompt": "...", "workDir": "/path/to/project", "flags": ["--print", "--dangerously-skip-permissions"], "timeout": 300000 }
  → { exitCode: 0, stdout: "...", stderr: "...", durationMs: 12345 }

POST /prawduct/run
  { "command": "setup", "workDir": "/path/to/project", "args": [] }
  → { exitCode: 0, stdout: "...", stderr: "..." }

GET  /projects
  → list of projects in ~/.openclaw/projects/
```

### Security

- Bearer token auth (token stored in `.env`, shared with OpenClaw config)
- Command allowlist — cannot run arbitrary shell commands
- Working directory must be under `~/.openclaw/projects/` or `~/prawduct/`
- Timeouts enforced (default 5 min for claude, 2 min for prawduct)
- Bind to `0.0.0.0` on habitat (container reaches host via `host.docker.internal`)

### Docker Access

For the container to reach the host:
- **macOS Docker Desktop:** `host.docker.internal` resolves to the host automatically
- If needed, add to OpenClaw's docker-compose.yml:
  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

### Process Management

- Run as a launchd service (`com.clawbridge.builder`)
- Auto-restart on failure
- Log to `~/logs/builder-bridge.log`

## Container-Side Integration

OpenClaw needs to know the bridge exists. Add to its workspace SOUL.md or TOOLS.md:

```markdown
## Builder Bridge
- URL: http://host.docker.internal:3201
- Auth: Bearer token (in environment)
- Use this to run Claude Code and prawduct on the host for building tools
```

OpenClaw (Codex) can then make HTTP calls to the bridge just like any other tool/skill.

## What This Enables

1. **OpenClaw** decides what to build (architect role)
2. **OpenClaw** sends a build command to the bridge
3. **Bridge** runs Claude Code on the host with the prompt
4. **Claude Code** does the actual coding (builder role)
5. **Results** flow back to OpenClaw for review

This creates the architect→builder loop that was designed in the tools-architecture doc.

---

## v2 PTY Broker API Reference

Bridge v2 runs Claude Code in interactive PTY-backed sessions instead of one-shot `--print` execution. The NHE-ITL reviews each permission request individually. All v2 routes are prefixed with `/v2/`. v1 routes continue to work alongside v2.

See [bridge-v2-pty-broker-spec.md](bridge-v2-pty-broker-spec.md) for full design rationale.

### Session Lifecycle

```
start → running → [waiting_for_permission ↔ running] → completed/failed/timed_out → ended
```

### Endpoints

#### POST /v2/session/start

Start a PTY-backed Claude Code session for a project. One active session per project.

```json
{
  "project": "my-project",
  "instruction": "Build the login page",
  "approvalEnvelope": { "mode": "scoped", "rules": { "fileWrites": { "withinProject": "auto_approve", "outsideProject": "require_review" } }, "defaults": { "low": "auto_approve", "medium": "require_review", "high": "require_review" } },
  "timeout": 1800000,
  "promptTimeout": 300000
}
```

Response: `200` with `{ ok, sessionId, project, state, createdAt, cursor }`
Errors: `400` (missing project), `409` (session already exists), `400` (invalid envelope)

#### POST /v2/session/end

End a session. Sends a wrap-up message, waits for PTY exit, transitions to `ended`.

```json
{ "project": "my-project", "message": "optional wrap-up message" }
```

Response: `200` with `{ ok, sessionId, project, state, exitCode, createdAt, updatedAt, finalCursor }`
Errors: `404` (no session)

#### GET /v2/session/output

Poll session output events using cursor-based pagination.

```
GET /v2/session/output?project=my-project&cursor=0&maxEvents=50&waitMs=5000
```

- `cursor` (required): Start position (0 for beginning)
- `maxEvents` (optional): Maximum events to return
- `waitMs` (optional): Long-poll duration — waits up to this many ms for new events

Response: `200` with `{ ok, project, sessionId, state, cursorStart, cursorEnd, hasMore, events[], pendingPermission? }`

When a permission is pending, `pendingPermission` includes `{ id, permissionType, risk, target, timeoutAt }`.

Errors: `400` (missing params), `404` (no session)

#### GET /v2/session/status

Check session status and metadata.

```
GET /v2/session/status?project=my-project
```

Response: `200` with `{ ok, project, active, sessionId, state, startedAt, lastActivity, cursor, pendingPermissionId?, permissionTimeoutAt? }`

#### POST /v2/session/respond

Respond to a pending permission prompt. Writes the decision to PTY stdin.

```json
{
  "project": "my-project",
  "permissionId": "perm_abc123",
  "decision": "approve_once",
  "reason": "File write is within project scope",
  "actor": "nhe-itl"
}
```

Decisions: `approve_once`, `deny`, `abort_session`

Response: `200` with `{ ok, project, sessionId, state, cursor, decision }`
Errors: `400` (missing fields / invalid decision), `404` (no session / permission not found), `409` (already resolved), `410` (session ended)

#### POST /v2/session/policy

Update the approval envelope for a running session. Takes effect on the next permission prompt.

```json
{
  "project": "my-project",
  "approvalEnvelope": { "mode": "restrictive", "defaults": { "low": "require_review", "medium": "deny", "high": "deny" } }
}
```

Response: `200` with `{ ok, project, sessionId, state, policyUpdated }`
Errors: `400` (missing/invalid envelope), `404` (no session), `410` (session ended)

#### POST /v2/session/send

Send a follow-up message into a running session's PTY stdin. Does NOT auto-start sessions.

```json
{ "project": "my-project", "message": "Now add unit tests." }
```

Response: `200` with `{ ok, accepted, cursor, project, sessionId, state }`
Errors: `400` (missing fields), `404` (no session), `409` (waiting for permission — not writable), `410` (session ended)

#### GET /v2/session/transcript

Export raw PTY output after a session ends. Only available for terminal/ended sessions.

```
GET /v2/session/transcript?project=my-project
```

Response: `200` with `{ ok, project, sessionId, state, transcript }`
Errors: `400` (missing project), `404` (no session or still active)

#### GET /v2/sessions

List all sessions (active and ended).

Response: `200` with `{ ok, sessions[] }` where each session has `{ sessionId, project, state, createdAt, updatedAt, exitCode, cursor, pendingPermissionId }`

### Event Types

Events in the output stream have a `kind` field:

| Kind | Description |
|------|-------------|
| `text` | Raw PTY output chunk |
| `lifecycle` | State transition (e.g., `running` → `waiting_for_permission`) |
| `permission` | Structured permission request detected from Claude Code output |
| `decision` | Response to a permission (approve/deny/abort, with actor and reason) |
| `error` | Error event (timeout, unexpected PTY death, spawn failure) |

### Approval Envelope

Session-level policy that auto-resolves safe permissions without NHE-ITL review:

```json
{
  "mode": "scoped",
  "rules": {
    "fileWrites": { "withinProject": "auto_approve", "outsideProject": "deny" },
    "shellCommands": { "allowlist": ["npm test", "npm run build"], "allowlistPolicy": "auto_approve", "otherPolicy": "require_review" },
    "gitOperations": { "safe": "auto_approve", "destructive": "require_review" }
  },
  "defaults": { "low": "auto_approve", "medium": "require_review", "high": "require_review" }
}
```

Policy actions: `auto_approve`, `require_review`, `deny`

### Timeout Behavior

- **Prompt timeout** (default 5 min): Auto-denies pending permission and resumes session
- **Session timeout** (default 30 min): Sends SIGINT, then SIGKILL after 5s grace period, transitions to `timed_out`

---

## v1 API Reference (Legacy)

v1 routes use one-shot `--print` execution with `bypassPermissions`. They continue to work alongside v2.

### Endpoints

```
GET  /health              → { ok, claude, prawduct, projectsDir, circuitBreaker, activeSessions, v2ActiveSessions }

POST /claude/run
  { "prompt": "...", "workDir": "/path/to/project", "flags": ["--print"], "timeout": 300000 }
  → { exitCode, stdout, stderr, durationMs }

POST /session/send
  { "project": "my-project", "message": "...", "timeout": 300000 }
  → { sessionId, isNew, exitCode, stdout, stderr, durationMs }

POST /session/end
  { "project": "my-project", "message": "optional wrap message" }
  → { sessionId, isNew, exitCode, stdout, stderr, durationMs, sessionEnded, previousSessionId }

GET  /session/status?project=my-project
  → { project, active, sessionId?, startedAt?, lastActivity? }

GET  /sessions             → { sessions[] }

POST /prawduct/run
  { "command": "setup|sync|validate", "workDir": "/path", "args": [] }
  → { exitCode, stdout, stderr }

GET  /projects             → { projectsDir, projects[] }

GET  /exports              → { exports[] }
GET  /exports/:filename    → file content

GET  /circuit-breaker      → { open, consecutiveFailures, threshold, openedAt }
POST /circuit-breaker/reset → { ok, previous }
```

---

## Next Steps

1. Run E2E tests on habitat: `RUN_E2E=1 npx vitest run bridge/v2/__tests__/e2e.test.js`
2. Restart launchd service to pick up latest code
3. Verify NHE-ITL can drive the full permission review lifecycle via v2 routes
