<p align="center">
  <img src="https://raw.githubusercontent.com/Jason-Vaughan/puberty-labs-assets/main/clawbridge_logo.png" alt="ClawBridge" width="400">
</p>

# ClawBridge

A host-side HTTP bridge that exposes [Claude Code](https://claude.ai/claude-code) as a supervised build tool for automation systems like [OpenClaw](https://github.com/openclaw). It runs on the host machine and provides a JSON API for spawning, managing, and interacting with Claude Code sessions — with structured permission review, live output streaming, and test result detection.

## What Problem It Solves

OpenClaw runs its own AI engine inside a Docker container. It acts as the **architect** — deciding what to build and why. But it needs a **builder** that can write code, run tests, and interact with the filesystem on the host.

Claude Code is an excellent builder, but it runs on the host as a CLI tool — not inside the container. ClawBridge sits on the host as a lightweight HTTP service that bridges the gap, letting the orchestrator invoke Claude Code as a build tool while maintaining structured permission oversight.

> **Note on Anthropic's third-party policy:** In January 2026, Anthropic [banned the use of Claude subscription OAuth tokens (Pro/Max) in third-party tools](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) — this was about token arbitrage, where third-party harnesses routed through cheaper subscription auth instead of API pricing. ClawBridge does **not** do this. It invokes Claude Code on the host as a build tool using proper API key authentication (`claude setup-token`), which is the [explicitly permitted path](https://code.claude.com/docs/en/legal-and-compliance) for developers building products that interact with Claude. ClawBridge does not replace OpenClaw's engine, spoof Claude Code's harness, or use subscription credentials — it's a tool invocation bridge, not an engine substitution.

## How It Works

ClawBridge spawns Claude Code in a real PTY (pseudo-terminal), detects permission prompts from TUI output, and lets the orchestrator approve or deny each one through a structured API. The orchestrator gets live output streaming, test result detection, and full session control.

```
+--------------------------------------+
|  Orchestrator (e.g. OpenClaw)        |
|  Role: Architect / Reviewer          |
|                                      |
|  Drives builds via HTTP calls        |
|  to ClawBridge                       |
+----------------+---------------------+
                 | HTTP (JSON API, Bearer token)
                 | http://host.docker.internal:<port>
                 v
+--------------------------------------+
|  ClawBridge (host machine)           |
|  Node.js HTTP service                |
|  launchd/systemd managed             |
|                                      |
|  PTY broker with permission          |
|  detection, policy evaluation,       |
|  and structured event stream         |
+----------------+---------------------+
                 | PTY / child process
                 v
+--------------------------------------+
|  Claude Code                         |
|  Interactive TUI session             |
|  Permission prompts surfaced via     |
|  the bridge's event stream           |
+--------------------------------------+
```

### Session Flow

1. Orchestrator starts a session via `POST /v2/session/start` with an approval envelope
2. ClawBridge spawns Claude Code in a PTY
3. Claude Code works, triggering permission prompts for file writes, shell commands, etc.
4. The bridge's permission parser detects prompts from raw PTY output
5. The policy engine evaluates each permission against the approval envelope:
   - **auto_approve:** Bridge sends Enter after 500ms delay
   - **deny:** Bridge sends Escape after 500ms delay
   - **require_review:** Bridge pauses and surfaces the permission via the event stream
6. Orchestrator polls `GET /v2/session/peek` for a quick snapshot or `GET /v2/session/output` for full events
7. For permissions requiring review, orchestrator responds via `POST /v2/session/respond`
8. Session ends via `POST /v2/session/end` with optional transcript export

## Quickstart

### Requirements

- Node.js 18+ (tested on v22)
- Claude Code CLI installed on the host
- A valid Claude Code auth token configured via `claude setup-token`
- Build tooling needed by `node-pty` on your host

### 1. Clone and install

```bash
git clone https://github.com/Jason-Vaughan/ClawBridge.git
cd ClawBridge
npm install
npx node-gyp rebuild
```

### 2. Configure environment

```bash
cp bridge/.env.example bridge/.env
```

Edit `bridge/.env` and set at minimum:

```env
BRIDGE_PORT=3201
BRIDGE_TOKEN=replace-me
CLAUDE_CODE_OAUTH_TOKEN=replace-me
```

### 3. Start the bridge

```bash
cd bridge
node server.js
```

### 4. Discover the API

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:3201/v2/api-docs
```

This returns the full self-describing API reference with every endpoint, parameter types, and a quickstart workflow guide.

### 5. Start a session

```bash
curl -X POST http://localhost:3201/v2/session/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -d '{
    "project": "my-project",
    "instruction": "Build the login page"
  }'
```

### 6. Monitor with peek

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "http://localhost:3201/v2/session/peek?project=my-project&clean=true"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BRIDGE_PORT` | Yes | Port to listen on (default: 3201) |
| `BRIDGE_TOKEN` | Yes | Bearer token for API authentication |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | Token from `claude setup-token` for headless auth |
| `CLAUDE_BIN` | No | Path to Claude Code binary (default: `/usr/local/bin/claude`) |
| `PYTHON_BIN` | No | Path to Python 3 binary (auto-detected) |

### Claude Code Headless Auth

Claude Code must be authenticated for non-interactive use (launchd/SSH):

```bash
claude setup-token
```

This generates the `CLAUDE_CODE_OAUTH_TOKEN`. **Do not rely on keychain auth** — it is GUI-session-scoped and will not work from launchd or SSH contexts.

## API Reference

All endpoints require `Authorization: Bearer <token>` except `/health`.

`GET /v2/api-docs` returns the full self-describing reference — use it as the entry point for automation.

### Session Lifecycle

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v2/session/start` | Spawn new PTY session for a project |
| `POST` | `/v2/session/end` | Graceful shutdown with optional wrap message |
| `GET` | `/v2/session/output` | Poll events (cursor-based, long-poll via `waitMs`) |
| `GET` | `/v2/session/peek` | Quick snapshot — state, tail output, test results, pending permissions |
| `POST` | `/v2/session/respond` | Submit permission decision (approve, deny, abort) |
| `POST` | `/v2/session/send` | Send follow-up message to running session |
| `POST` | `/v2/session/policy` | Update approval envelope mid-session |
| `GET` | `/v2/session/transcript` | Full PTY transcript (live during session or after completion) |
| `GET` | `/v2/session/status` | Check session state and `inputReady` flag |
| `GET` | `/v2/sessions` | List sessions (active-only default, `?all=true` for all) |
| `GET` | `/v2/api-docs` | Self-describing API reference |

### Infrastructure

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Bridge status, Claude version |
| `GET` | `/api/processes` | Sidecar process visibility (for TangleClaw polling) |
| `GET` | `/projects` | List projects |
| `GET` | `/projects/:project/files` | List project files (`?recursive=true`, `?path=subdir`) |
| `GET` | `/projects/:project/files/*` | Serve a specific file |
| `POST` | `/prawduct/run` | Run prawduct governance commands (optional) |

### Peek Endpoint

`GET /v2/session/peek?project=my-project&lines=30&clean=true`

Returns a single operational snapshot without cursor management:

```json
{
  "ok": true,
  "state": "running",
  "active": true,
  "inputReady": true,
  "tail": "...last 30 lines of output (ANSI-stripped with ?clean=true)...",
  "testResult": {
    "runner": "vitest",
    "passed": 42,
    "failed": 0,
    "total": 42,
    "summary": "Tests  42 passed (42)",
    "command": "npx vitest run"
  },
  "pendingPermission": null
}
```

- **`inputReady`** — `true` when `POST /v2/session/send` will succeed (session running + PTY alive)
- **`testResult`** — auto-detected from PTY output (supports vitest, pytest, jest, mocha)
- **`?clean=true`** — strips ANSI escape codes from `tail` (also available on `/v2/session/transcript`)
- **`pendingPermission`** — surfaced as first-class data with type, risk, target, and timeout

### Approval Envelope

The envelope tells ClawBridge which permissions to auto-handle vs. pause for review:

```json
{
  "mode": "scoped",
  "rules": {
    "fileWrites": { "withinProject": "auto_approve", "outsideProject": "deny" },
    "fileDeletes": { "withinProject": "require_review", "outsideProject": "deny" },
    "shellCommands": {
      "allowlist": ["npm test", "npm run build", "git status", "git diff"],
      "allowlistPolicy": "auto_approve",
      "otherPolicy": "require_review"
    },
    "gitOperations": { "safe": "auto_approve", "destructive": "deny" },
    "dependencyChanges": "require_review",
    "networkAccess": "deny",
    "unknown": "require_review"
  },
  "defaults": {
    "lowRisk": "auto_approve",
    "mediumRisk": "require_review",
    "highRisk": "deny"
  }
}
```

No envelope = everything requires review (fail-closed).

### Timeout Behavior

- **Prompt timeout** (default 5 min): Auto-denies pending permission and resumes session
- **Session timeout** (default 30 min): Sends SIGINT, then SIGKILL after 5s grace period

## Deployment

### macOS (launchd)

```bash
cp bridge/com.clawbridge.builder.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.clawbridge.builder.plist
launchctl stop com.clawbridge.builder  # KeepAlive auto-relaunches
```

### Linux (systemd)

Create `/etc/systemd/system/clawbridge.service`:

```ini
[Unit]
Description=ClawBridge host-side Claude Code bridge
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/ClawBridge/bridge
EnvironmentFile=/home/YOUR_USER/ClawBridge/bridge/.env
Environment=HOME=/home/YOUR_USER
ExecStart=/usr/bin/node /home/YOUR_USER/ClawBridge/bridge/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable clawbridge
sudo systemctl start clawbridge
```

### Docker Access

For the container to reach the host:

```yaml
# docker-compose.yml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

On macOS Docker Desktop, `host.docker.internal` resolves automatically.

## Integrations

### TangleClaw orchestrator

ClawBridge integrates with [TangleClaw](https://github.com/Jason-Vaughan/TangleClaw) — a multi-project orchestration platform that manages sessions, port assignments, shared documents, and project governance across multiple AI-powered projects. When TangleClaw is running, ClawBridge registers its port lease and reports active session state for sidecar polling via `GET /api/processes`. TangleClaw integration is optional — ClawBridge works standalone.

### prawduct governance

If [prawduct](https://github.com/brookst/prawduct) is installed on the host, ClawBridge exposes prawduct lifecycle commands (setup, sync, validate) via the `/prawduct/run` endpoint. This powers structured build governance (discovery, planning, building, Critic review) for projects managed through TangleClaw. This integration is optional.

## Testing

```bash
# Run all tests (475 across 18 files)
npm test

# Run with live E2E (requires Claude Code installed)
RUN_E2E=1 npm test

# Watch mode
npm run test:watch
```

## File Structure

```
ClawBridge/
  LICENSE
  package.json
  bridge/
    server.js              # HTTP server, auth, routing
    .env.example           # Environment template
    com.clawbridge.builder.plist  # launchd service definition
    v2/
      types.js             # Enums: SessionState, EventKind, PermissionType, etc.
      pty.js               # PTY process wrapper (node-pty + child_process fallback)
      permission-parser.js # Detects permission prompts from raw PTY output
      policy.js            # Evaluates permissions against approval envelopes
      event-log.js         # Append-only event log with cursor reads and long-poll
      sessions.js          # Session + SessionManager: lifecycle, timers, permissions
      routes.js            # HTTP route handlers (includes api-docs, peek, test detection)
      __tests__/           # 18 test files, 469 tests
  docs/
    bridge-v2-maintainer-guide.md
    bridge-v2-pty-broker-spec.md
    bridge-v2-bug-index.md
    bridge-v2-regression-checklist.md
    clawbridge-overview.md
```

## Documentation

| Document | Purpose |
|----------|---------|
| [Maintainer Guide](docs/bridge-v2-maintainer-guide.md) | Architecture, data flow, known fragility, operational reference |
| [PTY Broker Spec](docs/bridge-v2-pty-broker-spec.md) | Design spec for the permission broker |
| [Bug Index](docs/bridge-v2-bug-index.md) | All 13 known bugs with regression test mappings |
| [Regression Checklist](docs/bridge-v2-regression-checklist.md) | What to verify after any change |
| [ClawBridge Overview](docs/clawbridge-overview.md) | Architecture overview and full API reference |

## License

MIT. See [LICENSE](LICENSE).
