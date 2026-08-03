<p align="center">
  <img src="https://raw.githubusercontent.com/Jason-Vaughan/project-assets/main/clawbridge_logo.png" alt="ClawBridge" width="400">
</p>

# ClawBridge

A host-side HTTP bridge that exposes [Claude Code](https://claude.ai/claude-code) as a supervised build tool for automation systems. It runs on the host machine and provides a JSON API for spawning, managing, and interacting with Claude Code sessions — with structured permission review, live output streaming, and test result detection.

## What Problem It Solves

AI orchestrators (running inside Docker containers, remote servers, etc.) often need a **builder** that can write code, run tests, and interact with the host filesystem. Claude Code is an excellent builder, but it runs on the host as a CLI tool — not inside the container.

ClawBridge sits on the host as a lightweight HTTP service that bridges the gap, letting any orchestrator invoke Claude Code as a build tool while maintaining structured permission oversight.

**Secondary capability — embedded tools extension.** Some deployments also need to expose a small HTTP service alongside the Claude Code broker (for example, a domain-specific tools API consumed by the same orchestrator). ClawBridge supports this via a single, in-process extension slot mounted under `/tools/*` (set `CLAWBRIDGE_TOOLS_MODULE`). This is **single-tenant** by design — the bridge hosts at most one embedded handler, and does **not** proxy to other host-side services. It is not a general-purpose reverse proxy or multi-service docker_host bridge. See the [tools extension contract](docs/tools-extension.md).

> **Note on Anthropic's third-party policy:** In January 2026, Anthropic [banned the use of Claude subscription OAuth tokens (Pro/Max) in third-party tools](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) — this was about token arbitrage, where third-party harnesses routed through cheaper subscription auth instead of API pricing. ClawBridge does **not** do this. It invokes Claude Code on the host as a build tool using proper API key authentication (`claude setup-token`), which is the [explicitly permitted path](https://code.claude.com/docs/en/legal-and-compliance) for developers building products that interact with Claude. ClawBridge does not spoof Claude Code's harness or use subscription credentials — it's a tool invocation bridge, not an engine substitution.

## How It Works

ClawBridge spawns Claude Code in a real PTY (pseudo-terminal), detects permission prompts from TUI output, and lets the orchestrator approve or deny each one through a structured API. The orchestrator gets live output streaming, test result detection, and full session control.

```
+----------------------------------------------+
|  Orchestrator                                |
|  Role: Architect / Reviewer                  |
|                                              |
|  Drives builds via HTTP calls to ClawBridge  |
+------------------------+---------------------+
                         | HTTP (JSON API, Bearer token)
                         | http://host.docker.internal:<port>
                         v
+----------------------------------------------+
|  ClawBridge (host machine)                   |
|  Node.js HTTP service                        |
|  launchd/systemd managed                     |
|                                              |
|  +----------------------+  +---------------+ |
|  | PTY broker (core)    |  | Tools         | |
|  | always on            |  | extension     | |
|  |                      |  | (optional,    | |
|  | /v2/session/*        |  |  single-      | |
|  | /v2/sessions         |  |  tenant)      | |
|  | /v2/api-docs         |  |               | |
|  | /health, /projects   |  | /tools/*      | |
|  +----------+-----------+  +-------+-------+ |
+-------------|----------------------|---------+
              | PTY / child process  | in-process HTTP
              v                      v
+--------------------------+  +--------------------------+
|  Claude Code             |  |  Embedded HTTP handler   |
|  Interactive TUI session |  |  (e.g., a Fastify or     |
|  Permission prompts      |  |   Express app supplied   |
|  surfaced via the        |  |   by the consumer; one   |
|  bridge's event stream   |  |   per bridge process)    |
+--------------------------+  +--------------------------+
```

The right-hand column is mounted only when `CLAWBRIDGE_TOOLS_MODULE` points at a module implementing the [tools extension interface](docs/tools-extension.md). Absent that env var, the bridge runs as a pure PTY broker — no `/tools/*` routes, no `tools` block in `/health`.

### Session Flow

1. Orchestrator starts a session via `POST /v2/session/start` with an `approvalEnvelope` and a `permissionMode` (set to `default` to engage the bridge's parser; see note below)
2. ClawBridge spawns Claude Code in a PTY with `--permission-mode <value>`
3. Claude Code works, triggering permission prompts for file writes, shell commands, etc.
4. The bridge's permission parser detects prompts from raw PTY output
5. The policy engine evaluates each permission against the approval envelope:
   - **auto_approve:** Bridge sends Enter after 500ms delay
   - **deny:** Bridge sends Escape after 500ms delay
   - **require_review:** Bridge pauses and surfaces the permission via the event stream
6. Orchestrator polls `GET /v2/session/peek` for a quick snapshot or `GET /v2/session/output` for full events
7. For permissions requiring review, orchestrator responds via `POST /v2/session/respond` with `{ project, permissionId, decision }` where `decision` is one of `approve_once`, `deny`, or `abort_session`
8. Session ends via `POST /v2/session/end` with optional transcript export

> **Heads-up on `permissionMode`.** Claude Code 2.1.x defaults to *auto mode*, where it
> classifies and auto-handles permission prompts internally — the bridge's TUI parser
> never sees them, and `approvalEnvelope` has no effect. To engage the bridge's
> structured permission review, set `permissionMode: "default"` (or any non-`auto`
> value: `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`) on `/v2/session/start`.
> Omitting the field falls back to Claude's default (auto mode) for backward
> compatibility with existing deployments.

## When to Use ClawBridge

**Use ClawBridge if you need:**

- **A Claude Code PTY broker on the host machine.** The bridge spawns Claude Code in a real PTY, parses permission prompts from TUI output, and exposes a structured HTTP API so a container-side orchestrator can approve, deny, or pause each one. This is the primary use case — the broker is what 100% of `bridge/v2/` is built for.
- *(Optional, advanced)* **A place to co-locate one additional HTTP service inside the bridge process.** Set `CLAWBRIDGE_TOOLS_MODULE` to mount an embedded handler under `/tools/*`. The extension shares the bridge's auth, port, and lifecycle — note that "shares the auth" means it inherits whatever the bridge is enforcing, which is nothing when `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true`. v1 is **single-tenant**: one extension per bridge process, no multi-mount. Documented contract in [docs/tools-extension.md](docs/tools-extension.md).

**ClawBridge is *not* the right tool if:**

- You only need Claude Code on the host and have direct shell/SSH access — invoke `claude` directly, no bridge required.
- You need to fan out to **multiple** host-side services from a container — ClawBridge mounts at most one embedded extension and does not proxy to external services. Use a general-purpose reverse proxy (Caddy, Traefik, nginx) instead.
- You want to run Claude Code **inside** a container — that is a different deployment model (sandboxed Claude Code), not what ClawBridge addresses.
- You need a security boundary between orchestrator and host beyond bearer-token auth + the permission envelope. ClawBridge's safety model is *structured permission review of a single CLI tool's actions*, not network-level isolation.

**For OpenClaw deployments specifically:** recommend ClawBridge when the deployment uses Claude Code as a builder behind a containerized orchestrator. If a deployment also needs an embedded tools API (RentalClaw-style), point at `CLAWBRIDGE_TOOLS_MODULE`. If a deployment needs multiple distinct host-side services bridged, ClawBridge alone is insufficient — pair it with a reverse proxy.

## Security Posture

ClawBridge's safety model is **structured permission review of one CLI tool's actions**, plus bearer-token auth. It is not a sandbox, not a jail, and not a network boundary between an untrusted orchestrator and the host. Deploy it as though the caller can do anything the API allows.

**Authentication is mandatory.** The bridge refuses to start without `BRIDGE_TOKEN` and exits non-zero naming the fix. It previously treated an unset token as "authentication optional" and served every route openly — a misconfigured daemon was an unauthenticated command-execution surface on the local network, while `/health` reported a healthy service. If you genuinely need the open mode, `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` enables it; `/health` then reports `insecure: true` with `auth.required: false`, and every boot logs a warning. Monitor on `insecure`.

Two further properties are worth stating outright, because both are deliberate:

- **One privilege tier.** There is a single shared `BRIDGE_TOKEN` and no per-caller authorization. Any token holder can act on any project.
- **Transcripts are unfiltered.** The event log and `/v2/session/transcript` store raw PTY output verbatim, so anything Claude Code prints — the contents of a `.env`, an echoed key, a token in a stack trace — is held in memory and returned in full to any token holder. There is no redaction, by decision rather than by omission: this is a single-operator host daemon, and anyone who can read a transcript already has access to the host those secrets live on. Adding redaction would buy little and would make the transcript a less faithful record of what actually happened.

**CORS depends on whether a token is set.** With `BRIDGE_TOKEN` set, `Access-Control-Allow-Origin` is `*`. For every *authenticated* route that is a nuisance rather than a hole — a web page has no credential to send, and cannot attach `Authorization` without tripping a preflight.

**But three routes are unauthenticated by design** — `GET /health`, `GET /exports`, and `GET /exports/*` — so "no credential" does not protect them. With the wildcard, a page the operator visits can read the export listing and the contents of every file under `EXPORTS_DIR` cross-origin, in the default token-holding configuration. Point `EXPORTS_DIR` at a directory you are content to publish (the environment table says the same), and treat the wildcard as the reason that instruction is not advisory. Tracked as `CRS-8N3P`.

**Without a token, cross-origin browser requests are refused before routing.** Loopback origins are allowed, as is anything named exactly in `CLAWBRIDGE_ALLOWED_ORIGINS`; everything else gets a `403`. This is what makes `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` safe to state as "nothing else can reach the port" — previously it also required that no browser run on the host, which was not a condition an operator could actually satisfy.

The check reads two headers, because one is not enough: `Origin` when the browser sends it, and `Sec-Fetch-Site` when it does not. A no-cors `GET` — an `<img src>`, a `<script src>`, an `<iframe>`, a typed URL — carries no `Origin` at all, so keying on `Origin` alone would miss the easiest request there is to forge.

**Destructive operations do not answer `GET` at all.** That is a separate guarantee, and it holds even where the gate cannot see: `GET` is a *safe* method (RFC 9110 §9.2.1), and link unfurlers, prefetchers, proxies and crawlers all rely on that while sending neither header. Consuming a file therefore requires `POST` — see the 2.0.0 breaking changes.

Non-browser callers send neither header and are unaffected: `curl`, containers, and orchestrators behave exactly as before. Two consequences worth knowing: a browser page cannot read `/health` cross-origin unless its origin is allowed, and this defends against *browsers* — a direct attacker who can reach an unauthenticated port needs no CSRF, since every route is already open to them. Check the live posture at `/health` under `cors`.

If your deployment breaks either assumption — multiple mutually-untrusting callers, or transcripts leaving the trust boundary they were produced in — supply the missing control at the network layer. ClawBridge will not do it for you.

The full model, including known gaps, is in [`.prawduct/artifacts/security-model.md`](.prawduct/artifacts/security-model.md).

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
```

`npm install` runs the bundled `scripts/postinstall.js`, which restores the
exec bit on node-pty's prebuilt `spawn-helper` binaries on macOS (a common
silent failure on fresh installs). If you ever see `posix_spawnp failed`
errors at runtime, rerun `npm rebuild node-pty` from the project root and
make sure `node_modules/node-pty/prebuilds/darwin-*/spawn-helper` is
executable.

### 2. Configure environment

```bash
cp bridge/.env.example bridge/.env
```

Edit `bridge/.env` and set at minimum:

```env
BRIDGE_PORT=3201

# A secret you invent — see below. Note that comments must be on their own line:
# the loader takes everything after `=` verbatim, so a trailing comment would
# become part of the token.
BRIDGE_TOKEN=

# Issued by `claude setup-token`.
CLAUDE_CODE_OAUTH_TOKEN=

# Directory containing the projects the bridge may operate on.
PROJECTS_DIR=/path/to/your/projects
```

**These two tokens come from different places, which is the most common setup confusion:**

- **`BRIDGE_TOKEN` is a secret you invent.** Nothing issues it. Callers present it as
  `Authorization: Bearer <token>`. Generate one with `openssl rand -base64 32`.
  The bridge **refuses to start** without it — deliberately, since running without a token
  serves every route unauthenticated on a `0.0.0.0` bind. `.env.example` ships it empty for
  the same reason: a placeholder would satisfy that check and leave you running on a
  guessable credential.
- **`CLAUDE_CODE_OAUTH_TOKEN` is issued to you** by `claude setup-token` (see
  [Claude Code Headless Auth](#claude-code-headless-auth) below).

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
| `BRIDGE_TOKEN` | Yes | Bearer token for API authentication — **a secret you invent**, not one that is issued. `openssl rand -base64 32`. **The bridge refuses to start without it.** |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | Token from `claude setup-token` for headless auth |
| `CLAUDE_BIN` | No | Path to Claude Code binary (default: `/usr/local/bin/claude`) |
| `PYTHON_BIN` | No | Path to Python 3 binary (auto-detected) |
| `PROJECTS_DIR` | No | Directory containing projects the bridge may operate on (default: `$HOME/projects`). Sessions run here, and it scopes `/projects/*` and `/v2/session/file`. |
| `EXPORTS_DIR` | No | Directory served by `GET /exports` and `GET /exports/*` (default: `$HOME/exports`). **These two routes are unauthenticated by design** — the listing exposes every filename and the download serves every file. Point it at a directory you are content to publish to anyone who can reach the port. |
| `CLAWBRIDGE_ALLOW_UNAUTHENTICATED` | No | Set to exactly `true` to start without `BRIDGE_TOKEN`, serving every route unauthenticated. Only where nothing else can reach the port (see [Security Posture](#security-posture)). Any other value — including `1`, `yes`, or `TRUE` — is not accepted. |
| `CLAWBRIDGE_ALLOWED_ORIGINS` | No | Comma-separated browser origins permitted to call the bridge **while it runs without a token**; loopback is always permitted. Entries must be serialized origins (`https://ui.example` — no trailing slash, no path); anything else never matches, and is warned about at boot and listed under `cors.invalidOrigins` on `/health` rather than being silently ignored. Unset permits nothing beyond loopback. Ignored when `BRIDGE_TOKEN` is set. |
| `CLAWBRIDGE_TOOLS_MODULE` | No | Absolute path to a Node module implementing the [tools extension interface](docs/tools-extension.md). When set, the bridge mounts the module under `/tools/*` and merges its health into `/health`. Absent, the bridge runs as a pure PTY broker. |

### Claude Code Headless Auth

Claude Code must be authenticated for non-interactive use (launchd/SSH):

```bash
claude setup-token
```

This generates the `CLAUDE_CODE_OAUTH_TOKEN`. **Do not rely on keychain auth** — it is GUI-session-scoped and will not work from launchd or SSH contexts.

## API Reference

All endpoints require `Authorization: Bearer <token>` except `/health`, `GET /exports`, and `GET /exports/*`, which are unauthenticated by design. (And note that in the `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` mode there is no token to check, so *nothing* is authenticated — see [Security Posture](#security-posture).)

`GET /v2/api-docs` returns the full self-describing reference — use it as the entry point for automation.

### Session Lifecycle

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v2/session/start` | Spawn new PTY session for a project |
| `POST` | `/v2/session/end` | Graceful shutdown with optional wrap message |
| `GET` | `/v2/session/output` | Poll events (cursor-based, long-poll via `waitMs`) |
| `GET` | `/v2/session/peek` | Quick snapshot — state, tail output, test results, pending permissions |
| `POST` | `/v2/session/respond` | Submit permission decision (`approve_once`, `deny`, or `abort_session`) — requires `permissionId` from a pending permission |
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
| `GET` | `/api/processes` | Process visibility for external orchestrators |
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

The envelope tells ClawBridge which permissions to auto-handle vs. pause for review. **Important:** the envelope only governs behavior when `permissionMode` is set to a non-`auto` value (e.g. `default`) on `/v2/session/start`. Auto mode bypasses the bridge's permission parser entirely and Claude makes its own decisions; the envelope is ignored. See the [Session Flow](#session-flow) note above.

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

### Orchestrator polling

External orchestrators can poll `GET /api/processes` to monitor active and recently completed sessions. This provides a lightweight sidecar integration point — no registration required, just poll the endpoint. ClawBridge works standalone or as part of a larger multi-project orchestration platform.

### Governance tools

If a governance tool (e.g., [prawduct](https://github.com/brookst/prawduct)) is installed on the host, ClawBridge can expose lifecycle commands (setup, sync, validate) via the `/prawduct/run` endpoint. This integration is optional.

### Tools extension

Set `CLAWBRIDGE_TOOLS_MODULE` to the absolute path of a Node module that exports `{ init, handleToolsRoute, getToolsHealth, close }` and the bridge will mount it under `/tools/*`, merge its health into `/health`, and close it on shutdown. Bridge auth runs before your handler, but it enforces nothing in the unauthenticated mode — see the auth caveat in the contract. See [docs/tools-extension.md](docs/tools-extension.md) for the full interface contract, guarantees, and reference implementation.

## Testing

```bash
# Run all tests (the 14 live-PTY e2e tests are skipped unless RUN_E2E=1)
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
      __tests__/           # broker suites (the 14-test live-PTY e2e file is skipped unless RUN_E2E=1)
  docs/
    bridge-v2-maintainer-guide.md
    bridge-v2-pty-broker-spec.md
    bridge-v2-bug-index.md
    bridge-v2-regression-checklist.md
```

## Documentation

| Document | Purpose |
|----------|---------|
| [Maintainer Guide](docs/bridge-v2-maintainer-guide.md) | Architecture, data flow, known fragility, operational reference |
| [PTY Broker Spec](docs/bridge-v2-pty-broker-spec.md) | Design spec for the permission broker |
| [Bug Index](docs/bridge-v2-bug-index.md) | Every numbered v2 broker bug, mapped to the regression test that guards it |
| [Regression Checklist](docs/bridge-v2-regression-checklist.md) | What to verify after any change |

## Related Projects

- **[OpenClaw](https://github.com/openclaw/openclaw)** — AI agent platform. ClawBridge was built to let OpenClaw drive Claude Code sessions on a remote host.
- **[TangleClaw](https://github.com/Jason-Vaughan/TangleClaw)** — Multi-engine session orchestrator with persistent tmux sessions, mobile access, and sidecar polling via ClawBridge's `/api/processes` endpoint.
- **[PortHub](https://github.com/Jason-Vaughan/PortHub)** — Port registry for development environments. Prevents port conflicts when running ClawBridge alongside other services.
- **[prawduct](https://github.com/brookst/prawduct)** — Project governance framework. ClawBridge can optionally expose prawduct lifecycle commands via `/prawduct/run`.

## License

MIT. See [LICENSE](LICENSE).
