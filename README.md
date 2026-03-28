# ClawBridge

A PTY permission-broker bridge that lets [OpenClaw](https://github.com/openclaw) drive [Claude Code](https://claude.ai/claude-code) sessions with structured permission review. It runs on the host machine and exposes an HTTP API that OpenClaw's Docker container calls to spawn, manage, and interact with Claude Code sessions.

## What Problem It Solves

OpenClaw runs inside a Docker container. Claude Code runs on the host. They can't talk directly. ClawBridge sits on the host as a lightweight HTTP service that bridges the gap:

- **v1 (legacy):** Fire-and-forget. Spawns Claude Code with `--print --dangerously-skip-permissions`, captures output, returns it. No permission review.
- **v2 (PTY broker):** Interactive. Spawns Claude Code in a real PTY, detects permission prompts from TUI output, and lets OpenClaw approve or deny each one as an intelligent reviewer (NHE-ITL).

v2 is the active system. v1 remains for simple one-shot tasks.

> **Historical note:** This was originally developed as the "builder bridge" inside the RentalClaw project. It has been extracted into a standalone repo for reuse across any OpenClaw deployment.

## Architecture

```
+--------------------------------------+
|  OpenClaw Container (Docker)         |
|  Role: Architect / NHE-ITL           |
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
|  v1: one-shot --print execution      |
|  v2: PTY broker with permission      |
|      detection, policy evaluation,   |
|      and structured event stream     |
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

### v2 PTY Broker Flow

1. OpenClaw starts a session via `POST /v2/session/start` with an approval envelope
2. ClawBridge spawns Claude Code in a PTY
3. Claude Code works, triggering permission prompts for file writes, shell commands, etc.
4. The bridge's permission parser detects prompts from raw PTY output
5. The policy engine evaluates each permission against the approval envelope:
   - **auto_approve:** Bridge sends Enter (`\r`) after 500ms delay
   - **deny:** Bridge sends Escape (`\x1b`) after 500ms delay
   - **require_review:** Bridge pauses and surfaces the permission via the event stream
6. OpenClaw polls `GET /v2/session/output` to see events and pending permissions
7. For permissions requiring review, OpenClaw responds via `POST /v2/session/respond`
8. Session ends via `POST /v2/session/end` with optional transcript export

## Dependencies

- **Node.js** >= 18 (tested on v22)
- **node-pty** — native PTY management (requires native addon rebuild)
- **vitest** — test runner (dev dependency)
- **Claude Code** — installed on the host at a known path
- **macOS** with launchd (or Linux with systemd)

## Installation

```bash
# Clone and install
git clone git@github.com:Jason-Vaughan/ClawBridge.git
cd ClawBridge
npm install

# Rebuild node-pty native addon (REQUIRED)
npx node-gyp rebuild

# Configure
cp bridge/.env.example bridge/.env
# Edit bridge/.env with real values
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BRIDGE_PORT` | Yes | Port to listen on (default: 3201) |
| `BRIDGE_TOKEN` | Yes | Bearer token for API authentication |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | Token from `claude setup-token` for headless auth |
| `CLAUDE_BIN` | No | Path to Claude Code binary (default: `/usr/local/bin/claude`) |
| `PYTHON_BIN` | No | Path to Python 3 binary (default: `/usr/bin/python3`) |
| `TANGLECLAW_URL` | No | TangleClaw API URL for port registration (default: disabled) |

### Claude Code Headless Auth

Claude Code must be authenticated for non-interactive use (launchd/SSH):

```bash
claude setup-token
```

This generates the `CLAUDE_CODE_OAUTH_TOKEN`. **Do not rely on keychain auth** — it is GUI-session-scoped and will not work from launchd or SSH contexts.

### macOS Deployment (launchd)

```bash
# Copy plist (edit paths inside to match your system)
cp bridge/com.rentalclaw.builder-bridge.plist ~/Library/LaunchAgents/

# Load and start
launchctl load ~/Library/LaunchAgents/com.rentalclaw.builder-bridge.plist

# Restart (KeepAlive auto-relaunches)
launchctl stop com.rentalclaw.builder-bridge
```

### Docker Access

For the OpenClaw container to reach the host:

```yaml
# docker-compose.yml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

On macOS Docker Desktop, `host.docker.internal` resolves automatically.

## API Reference

### v2 Routes (PTY Broker)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v2/session/start` | Spawn new PTY session for a project |
| `POST` | `/v2/session/end` | Graceful shutdown with optional wrap message |
| `GET` | `/v2/session/output` | Poll events (cursor-based, long-poll via `waitMs`) |
| `POST` | `/v2/session/respond` | Submit permission decision |
| `POST` | `/v2/session/send` | Send follow-up message to running session |
| `POST` | `/v2/session/policy` | Update approval envelope mid-session |
| `GET` | `/v2/session/transcript` | Export raw transcript (terminal sessions only) |
| `GET` | `/v2/session/status` | Check session state |
| `GET` | `/v2/sessions` | List sessions (active-only default, `?all=true` for all) |

### v1 Routes (Legacy)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Bridge status, Claude version |
| `POST` | `/claude/run` | One-shot Claude Code execution |
| `POST` | `/session/send` | Start/resume v1 session |
| `POST` | `/session/end` | End v1 session |
| `POST` | `/prawduct/run` | Run prawduct CLI commands |
| `GET` | `/projects` | List projects |
| `GET` | `/exports` | List/serve exported files |

### Common Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/circuit-breaker` | Check circuit breaker status |
| `POST` | `/circuit-breaker/reset` | Reset after investigation |

All authenticated routes require `Authorization: Bearer <token>`. `/health` and `/exports` are public.

## Approval Envelope

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

## Testing

```bash
# Run all tests (405+ across 15 files)
npm test

# Run with live E2E (requires Claude Code installed)
RUN_E2E=1 npm test

# Watch mode
npm run test:watch
```

## File Structure

```
ClawBridge/
  package.json
  .env.example             -> symlink to bridge/.env.example
  bridge/
    server.js              # HTTP server, auth, routing, v1+v2
    .env.example           # Environment template
    com.rentalclaw.builder-bridge.plist  # launchd service definition
    v2/
      types.js             # Enums: SessionState, EventKind, PermissionType, etc.
      pty.js               # PTY process wrapper (node-pty + child_process fallback)
      permission-parser.js # Detects permission prompts from raw PTY output
      policy.js            # Evaluates permissions against approval envelopes
      event-log.js         # Append-only event log with cursor reads and long-poll
      sessions.js          # Session + SessionManager: lifecycle, timers, permissions
      routes.js            # v2 HTTP route handlers
      __tests__/           # 15 test files, 405+ tests
  docs/
    bridge-v2-maintainer-guide.md
    bridge-v2-pty-broker-spec.md
    bridge-v2-bug-index.md
    bridge-v2-regression-checklist.md
    bridge-v2-e2e-test.md
    bridge-v2-supervised-maintenance-trial.md
    autonomous-bridge-protocol.md
    builder-bridge-overview.md
    REBUILD_GUIDE.md
```

## Documentation

| Document | Purpose |
|----------|---------|
| [Maintainer Guide](docs/bridge-v2-maintainer-guide.md) | Architecture, data flow, known fragility, operational reference |
| [PTY Broker Spec](docs/bridge-v2-pty-broker-spec.md) | Design spec for the v2 permission broker |
| [Bug Index](docs/bridge-v2-bug-index.md) | All 13 known bugs with regression test mappings |
| [Regression Checklist](docs/bridge-v2-regression-checklist.md) | What to verify after any change |
| [E2E Test Prompt](docs/bridge-v2-e2e-test.md) | Full E2E validation procedure for OpenClaw |
| [Supervised Maintenance Trial](docs/bridge-v2-supervised-maintenance-trial.md) | Template for NHE-ITL maintenance exercises |
| [Autonomous Bridge Protocol](docs/autonomous-bridge-protocol.md) | How OpenClaw drives prawduct builds via v1 |
| [Builder Bridge Overview](docs/builder-bridge-overview.md) | Original v1 design + v2 API reference |
| [Rebuild Guide](docs/REBUILD_GUIDE.md) | Complete deployment/rebuild manual |

## License

Private. Not licensed for external use.
