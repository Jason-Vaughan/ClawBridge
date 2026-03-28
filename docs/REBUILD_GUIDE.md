# Claude Code + prawduct Builder Bridge Rebuild Guide

This document is the consolidated rebuild/deployment reference for the RentalClaw builder-bridge setup: what it is, what pieces exist, how they fit together, how to reproduce it on another OpenClaw system, and what was learned while getting it working.

It is intentionally written as an operator handoff, not a design sketch.

---

## 1. What this system is

The system has four layers:

1. **OpenClaw agent runtime** inside the container
   - This is where the assistant runs.
   - It cannot directly host Claude Code interactive sessions reliably inside the same OpenClaw tool loop for this use case.

2. **Host-side builder bridge** on the OpenClaw machine
   - An HTTP service running outside the container.
   - Exposes a narrow API for invoking **Claude Code** and **prawduct** on the host.
   - Current documented port: `3201`

3. **Claude Code** on the host
   - Used as the code-writing/building runtime.
   - Two execution styles exist:
     - **v1 / legacy** one-shot execution
     - **v2 PTY broker** interactive session mediation with permission review

4. **prawduct** on the host
   - Used as the project/governance framework around autonomous builds.
   - Provides setup/sync/validate lifecycle behavior and project-state conventions.

In short:
- **OpenClaw = architect/orchestrator**
- **Claude Code = builder**
- **prawduct = project/governance framework**
- **builder bridge = glue layer**

---

## 2. Current documented local environment

From `TOOLS.md` and bridge docs, the working system was documented as follows:

### Host service
- **Builder bridge URL:** `http://host.docker.internal:3201`
- **Auth:** Bearer token
- **Current token in workspace docs:** stored in `TOOLS.md`

### Host-side paths
- **Projects:** `/Users/habitat-admin/.openclaw/projects/`
- **Shared data:** `/Users/habitat-admin/.openclaw/data/rentalclaw/`
- **prawduct repo:** `/Users/habitat-admin/prawduct/`
- **Exports:** `/Users/habitat-admin/.openclaw/exports/`

### Documented host components
- Claude Code: `/usr/local/bin/claude`
- Node.js: `/usr/local/bin/node`
- Python 3: `/usr/bin/python3`
- prawduct: `~/prawduct`

### Documented bridge deployment details
Per `docs/bridge-v2-maintainer-guide.md`:
- **Bridge location:** `/Users/habitat-admin/builder-bridge/`
- **Process manager:** `launchd`
- **Launchd label:** `com.rentalclaw.builder-bridge`
- **Port:** `3201`
- **Token source:** `/Users/habitat-admin/builder-bridge/.env` via `BRIDGE_TOKEN`

---

## 3. API surfaces that matter

There are two bridge generations in the docs.

### 3.1 v1 / legacy bridge
Used for simpler one-shot execution.

Documented active endpoints include:
- `GET /health`
- `POST /claude/run`
- `POST /prawduct/run`
- `GET /sessions` or related session-listing routes depending on version
- legacy `/session/send` and `/session/end` in some docs

Characteristics:
- fire-and-forget style
- may use blanket permission bypass for Claude Code
- simpler to drive
- less safe / less reviewable

### 3.2 v2 PTY broker
Documented in:
- `docs/bridge-v2-pty-broker-spec.md`
- `docs/bridge-v2-maintainer-guide.md`
- `docs/openclaw-bridge-v2-e2e-prompt.md`

Key routes:
- `POST /v2/session/start`
- `POST /v2/session/send`
- `POST /v2/session/respond`
- `POST /v2/session/end`
- `GET /v2/session/output`
- `GET /v2/session/status`
- `GET /v2/sessions`
- `POST /v2/session/policy`
- optional `GET /v2/session/transcript`

Characteristics:
- launches Claude Code in a real PTY
- parses permission prompts from Claude’s TUI output
- can auto-approve low-risk actions within an approval envelope
- pauses for review on medium/high-risk actions
- supports resumable polling and multi-turn interaction

---

## 4. Why this setup exists

This exists because there are two conflicting needs:

1. We want autonomous tool/project building.
2. We do **not** want uncontrolled blanket permission bypass for everything.

The bridge architecture solves that by moving Claude Code onto the host and mediating it over HTTP. The v2 PTY broker goes further by introducing structured permission review.

That gives a practical architecture:
- OpenClaw can request work
- Claude Code can do real coding work on the host
- prawduct can preserve project structure/governance
- the bridge can enforce or mediate permissions

---

## 5. Rebuild target: what to recreate on another OpenClaw system

To reproduce this solution elsewhere, recreate these pieces:

### Required components
1. An OpenClaw installation
2. Claude Code installed on the host OS
3. prawduct installed on the host OS
4. A host-side builder bridge service
5. A host-visible projects root for Claude/prawduct work
6. A stable auth token shared between OpenClaw workspace docs/config and the bridge
7. A process manager entry to keep the bridge running across restarts

### Recommended shape
- Keep the bridge **outside** the OpenClaw container.
- Keep Claude Code and prawduct **host-local**.
- Expose only a minimal localhost/LAN HTTP API.
- Make the bridge stateless enough to restart cleanly, but preserve enough in-memory state for active PTY sessions if you need live transcript polling during a session.

---

## 6. Host-side rebuild procedure

This section is the practical reinstallation checklist.

### Step 1: Prepare the host
Install on the host machine:
- Node.js
- Claude Code CLI
- Python 3 if prawduct needs it
- Git
- prawduct

Create or confirm directories:
- `/Users/<user>/.openclaw/projects/`
- `/Users/<user>/.openclaw/data/<project>/`
- `/Users/<user>/.openclaw/exports/`
- bridge repo directory, e.g. `/Users/<user>/builder-bridge/`

If not using macOS, substitute equivalent host paths and service manager, but keep the same architecture.

### Step 2: Install the builder bridge code

**The complete bridge source is archived in the RentalClaw git repo** at `bridge/`. This is the canonical copy. On the host, it gets deployed to `/Users/<user>/builder-bridge/`.

Actual code layout (verified from RentalClaw repo):

```text
bridge/
  server.js                          # main server — v1 + v2 routes
  .env.example                       # env template (BRIDGE_PORT, BRIDGE_TOKEN, TANGLECLAW_URL)
  com.rentalclaw.builder-bridge.plist # launchd service definition
  v2/
    types.js
    pty.js                           # PTY lifecycle management
    permission-parser.js             # TUI output → structured permission events
    policy.js                        # auto-approve / review / deny tiering
    event-log.js                     # cursor-based event polling
    sessions.js                      # session state machine
    routes.js                        # v2 HTTP route handlers
    __tests__/
      pty.test.js
      event-log.test.js
      output-polling.test.js
      sessions.test.js
      permission-integration.test.js
      error-paths.test.js
      transcript.test.js
      permission-parser.test.js
      coexistence.test.js
      e2e.test.js
      permission-respond.test.js
      timeouts.test.js
      policy.test.js
      send.test.js
      regression.test.js
```

After copying the bridge source to the host, install dependencies:

```bash
cd /Users/<user>/builder-bridge
npm install
```

This installs `node-pty` (PTY management) and `vitest` (test runner). Then rebuild the native addon per Step 2b.

The bridge provides:
- v1 endpoints for one-shot Claude/prawduct execution
- v2 PTY broker endpoints for supervised interactive sessions
- bearer-token authentication
- session management
- event log / cursor polling for v2

### Step 2b: Rebuild node-pty native addon

**This is a blocking step.** After `npm install`, the `node-pty` native addon must be manually rebuilt on the host:

```bash
cd /Users/<user>/builder-bridge
npx node-gyp rebuild
```

Without this, PTY sessions will fail to spawn. This was a hard-won deployment lesson.

### Step 2c: Configure Claude Code auth for headless operation

Claude Code must be authenticated for non-interactive (launchd/SSH) use:

```bash
claude setup-token
```

This sets `CLAUDE_CODE_OAUTH_TOKEN` in the bridge's `.env`. **Do not rely on keychain auth** — it is GUI-session-scoped and will not work from launchd or SSH contexts.

### Step 3: Create bridge environment config

Copy `.env.example` from the repo and fill in real values:

```env
BRIDGE_PORT=3201
BRIDGE_TOKEN=<random strong token>
TANGLECLAW_URL=https://<tangleclaw-host>:3102
CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token — see Step 2c>
```

The `.env.example` template is in the repo at `bridge/.env.example`.

**Note:** The repo's `.env.example` currently omits `CLAUDE_CODE_OAUTH_TOKEN`. The deployed `.env` on habitat includes it. This is the token generated by `claude setup-token` for headless auth.

Do **not** reuse the current token blindly on a new system unless you intentionally want that.

### Step 4: Configure the bridge service manager

The launchd plist is in the repo at `bridge/com.rentalclaw.builder-bridge.plist`. Copy it to the host:

```bash
cp bridge/com.rentalclaw.builder-bridge.plist ~/Library/LaunchAgents/
```

Key plist settings (already configured in the repo copy):
- **Label:** `com.rentalclaw.builder-bridge`
- **ProgramArguments:** `/usr/local/bin/node /Users/<user>/builder-bridge/server.js`
- **WorkingDirectory:** `/Users/<user>/builder-bridge`
- **RunAtLoad:** true
- **KeepAlive:** true (auto-restart on crash)
- **Logs:** `/Users/<user>/logs/builder-bridge.log` (both stdout and stderr)
- **Environment:** PATH, HOME, BRIDGE_PORT, TANGLECLAW_URL baked into the plist

Load and start:
```bash
launchctl load ~/Library/LaunchAgents/com.rentalclaw.builder-bridge.plist
```

Restart (KeepAlive causes auto-relaunch):
```bash
launchctl stop com.rentalclaw.builder-bridge
```

If rebuilding on Linux, use systemd instead, but keep the same service semantics.

### Step 5: Expose the bridge to the OpenClaw container
The assistant expects to reach the host bridge via:
- `http://host.docker.internal:3201`

So the new system must ensure:
- the container can resolve `host.docker.internal`, or
- an equivalent host alias is supplied and documented

If that alias is unavailable on the target platform, document the replacement clearly in workspace docs and any calling code.

### Step 6: Add workspace/operator docs
At minimum, reproduce the documentation patterns currently spread across:
- `TOOLS.md`
- `docs/prawduct-autonomous-bridge.md`
- `docs/bridge-v2-maintainer-guide.md`
- `docs/bridge-v2-pty-broker-spec.md`
- `docs/openclaw-bridge-v2-e2e-prompt.md`
- `docs/bridge-v2-bug-index.md`
- `docs/bridge-v2-regression-checklist.md`

The critical thing is not just code recreation, but preserving the operator knowledge.

---

## 7. How OpenClaw uses it

There are two practical patterns.

### Pattern A: one-shot build actions via v1
Use when:
- task is simple
- no interactive review is needed
- fire-and-forget is enough

Examples:
- `/claude/run`
- `/prawduct/run`

### Pattern B: supervised interactive sessions via v2
Use when:
- the task spans multiple turns
- permission review matters
- you need polling/resume/auditability

The documented v2 lifecycle is:
1. `POST /v2/session/start`
2. poll `GET /v2/session/output`
3. if needed, `POST /v2/session/respond`
4. optionally `POST /v2/session/send`
5. `POST /v2/session/end`

This is the architecture to reproduce if the goal is “working again on another system” rather than merely “can call Claude somehow.”

---

## 8. Prawduct protocol currently documented

The current workspace already contains a good architect-level protocol in `docs/prawduct-autonomous-bridge.md`.

The core working model is:
- scaffold project
- perform discovery
- generate plan
- execute one chunk per Claude session
- commit before ending a session
- run prawduct validation
- review before moving on

That protocol should be copied forward largely intact.

Important documented endpoints in that protocol:
- `/prawduct/run`
- `/health`
- `/exports`

**Route version note:** Some older docs reference v1-era routes (`/session/send`, `/session/end`, `/session/status`, `/sessions`). These are legacy. **For any rebuild, use the `/v2/session/*` routes exclusively** — they are the validated, production-ready surface. The v1 routes exist for backward compatibility but lack permission review.

---

## 9. Code/behavior details that matter in the v2 broker

If reproducing the **interactive reviewed** version, these are the core implementation behaviors that matter.

### Session model
- one active session per project
- terminal states include `COMPLETED`, `FAILED`, `TIMED_OUT`, `ENDED`
- active listings should exclude ended/terminal sessions by default

### Permission parsing
The broker inspects raw PTY output and converts it into structured permission events.

Important parser lessons already learned:
- require a true confirmation pattern before emitting a permission
- scan bottom-up to avoid stale-target attribution
- preserve spaces when ANSI cursor-right codes are stripped
- suppress duplicate unknown prompts from menu remnants after reset

### Input injection
This was a critical live bug source.

Documented current rule:
- use `\r` for TUI submission, **not** `\n`

This applies to:
- auto-approve
- manual approve
- trust prompt confirm
- `send()`
- `end()`

### Timing behavior
Another critical live bug source.

Documented current rule:
- auto-approve/deny writes should be delayed by about `500ms` so the menu has time to render before the keystroke lands

### Trust prompt handling
The startup trust flow needs special buffering so the trust prompt is not mistaken for a permission prompt and early permission events are not swallowed.

---

## 10. Confirmed bug-fix history that should travel with the rebuild

From `memory/2026-03-27.md`, the bridge v2 E2E effort validated or fixed the following sequence:

1. transcript endpoint usage shifted toward inline transcript via `includeTranscript: true`
2. `/v2/sessions` now filters active sessions only
3. permission target attribution was fixed
4. trust-buffer swallowing of permission prompts was fixed
5. duplicate unknown fallback on menu remnants was mitigated
6. delayed auto-approve/deny keystrokes were added
7. completed sessions are treated as terminal for start overwrite / health counts
8. `send()` and `end()` switched from `\n` to `\r`

From `docs/bridge-v2-bug-index.md`, the broader known bug set includes:
- stale-buffer permission target misattribution
- ended sessions showing up in active lists
- trust buffering swallowing early prompts
- too-narrow confirmation detection
- duplicate unknown permissions after reset
- approval keystrokes landing too early
- incorrect terminal-state accounting
- wrong input submit character
- false permission detection on tool-call announcements
- ANSI cursor-right stripping that removed token boundaries
- trust prompt misclassified after safety valve
- unhandled EPIPE on dead stdin pipes

If rebuilding from source elsewhere, these are the failure modes to specifically guard against.

---

## 11. Tests and validation to carry forward

### Unit/integration coverage
Per `docs/bridge-v2-maintainer-guide.md`, the bridge v2 test suite covers 400+ tests across parser, policy, sessions, transcript, regressions, and live coexistence behaviors.

At minimum, preserve coverage for:
- ANSI stripping
- permission parsing
- path attribution
- policy evaluation
- session state machine
- send/end PTY submission behavior
- transcript/event log behavior
- regression tests for all fixed bugs

### Live PTY validation
This system had multiple issues that only showed up in the real Claude TUI, not unit tests.

So for any new deployment, keep a live smoke run similar to `docs/openclaw-bridge-v2-e2e-prompt.md`.

The minimum smoke should verify:
- project-local file writes auto-approve and succeed
- git init/add/commit succeeds
- idle completion is detectable while session remains interactive
- follow-up `send()` actually submits to Claude
- manual permission review path works
- test runner command can be approved and resume correctly
- `end(includeTranscript: true)` returns the transcript reliably

---

## 12. Important environment mismatch discovered during validation

This matters a lot for future reproducibility.

A recent OpenClaw-side validation attempt found that the **reachable host bridge service and the documented source-tree assumptions did not fully line up** from inside this container session.

Specifically, the subagent found:
- `GET /health` worked
- `GET /projects` worked
- `GET /sessions` worked
- `POST /claude/run` and `POST /prawduct/run` existed
- but the expected bridge source tree was **not** discoverable under the documented host project directories from the reachable surface
- and direct SSH from this container to `habitat-admin@192.168.20.10` failed due to auth constraints

The subagent also found:
- `rentalclaw-tools` was not the bridge repo
- no visible `bridge/v2/__tests__/e2e.test.js` under documented project roots
- broader discovery was constrained because the bridge only allowed workdirs under the projects dir or prawduct dir

### Why this matters
There are really two layers of “documentation truth” here:

1. **The intended/maintainer layout** in docs
2. **The actually reachable surface** from a given OpenClaw runtime context

For rebuilding on another OpenClaw system, document both:
- where the bridge code truly lives on the host
- how the container is allowed to see or not see that layout
- whether the assistant can restart/redeploy the bridge directly or only via another operator surface

Do not assume that because the bridge API is reachable, its source tree is also reachable from the same environment.

---

## 13. Host-side source archive location

**All host-side artifacts are already archived** in the RentalClaw git repo under `bridge/`:

| Artifact | Location in repo |
|---|---|
| Main server (v1 + v2) | `bridge/server.js` |
| v2 PTY broker modules | `bridge/v2/*.js` |
| v2 test suite (400+ tests) | `bridge/v2/__tests__/*.test.js` |
| launchd plist | `bridge/com.rentalclaw.builder-bridge.plist` |
| Environment template | `bridge/.env.example` |

The RentalClaw repo (`/Users/habitat-admin/.openclaw/projects/rentalclaw/`) is the canonical source. On habitat, the deployed copy lives at `/Users/habitat-admin/builder-bridge/`.

**Note for OpenClaw:** These files are not visible from inside the container via the bridge API — the bridge restricts workdir access to the projects and prawduct directories. To inspect or update bridge source, you need either: (a) an operator with host access, or (b) the files mirrored into a container-visible path.

---

## 14. Recommended documentation package to preserve this solution

For a durable handoff, preserve these artifacts together:

### A. Architecture / operator docs
- this file: `docs/CLAUDE_PRAWDUCT_REBUILD_GUIDE.md`
- `docs/prawduct-autonomous-bridge.md`
- `docs/bridge-v2-maintainer-guide.md`
- `docs/bridge-v2-pty-broker-spec.md`
- `docs/openclaw-bridge-v2-e2e-prompt.md`
- `docs/bridge-v2-bug-index.md`
- `docs/bridge-v2-regression-checklist.md`
- `docs/builder-bridge.md` (original v1 bridge docs)
- `docs/prawduct-autonomous-bridge.md` (autonomous build protocol)
- `docs/openclaw-bridge-v2-supervised-maintenance-trial.md` (supervised maintenance trial notes)

### B. Host source (already archived)
All of these are in the RentalClaw git repo at `bridge/`:
- `bridge/server.js` — main server
- `bridge/v2/` — full PTY broker implementation
- `bridge/v2/__tests__/` — 400+ test suite
- `bridge/com.rentalclaw.builder-bridge.plist` — launchd config
- `bridge/.env.example` — environment template (secrets redacted)

### C. Deployment notes
Capture:
- host OS version
- Node version
- Claude Code version
- prawduct version
- exact bind address/port
- how the container reaches the host bridge

---

## 15. Completeness status

This is a **validated deployment/rebuild guide**, with host source archived in the RentalClaw repo and the deployed copy cross-checked against habitat.

All host-side source, service config, environment templates, and test suites are version-controlled. The repo copy and deployed habitat copy were verified identical (MD5 match on `server.js`, zero diff on all v2 modules) as of 2026-03-28.

To reproduce on a new system, follow Section 6 using the code from `bridge/` in the repo. No additional host-side artifacts need to be collected.

**Note on drift:** If hot-fixes are applied directly on habitat between repo syncs, the deployed copy may temporarily lead the repo. Always verify the repo is current before using it as an archival source. As of this audit, they are in sync.

---

## 16. Quick rebuild checklist

Use this as the shortest practical summary.

### Recreate on a new OpenClaw system
- Install Claude Code on host
- Install prawduct on host
- Install Node/Git/Python as needed
- Deploy builder-bridge repo to host
- Configure `.env` with fresh `BRIDGE_TOKEN`
- Create host project/data/export roots
- Run bridge under launchd/systemd
- Expose bridge to container at a known host alias
- Add/update workspace docs (`TOOLS.md`, bridge docs)
- Validate `/health`, `/claude/run`, `/prawduct/run`
- Validate v2 session lifecycle with a smoke project
- Confirm transcript, review flow, and `\r` submission behavior
- Preserve regression coverage for the known bug set

### Do not forget
- interactive Claude PTY completion is detected by idle/summary, not process exit alone
- `\r` matters
- approval timing matters
- trust prompt handling matters
- active-vs-terminal session filtering matters
- source-tree visibility from OpenClaw may differ from API visibility

---

## 17. Status of this document

This is a **validated rebuild/handoff document** based on:
- current workspace docs
- recent memory notes
- recent OpenClaw-side validation findings
- verified host-side source and config (archived in RentalClaw repo at `bridge/`)

### Audit trail
- **Draft:** Written by OpenClaw from workspace docs and memory
- **First review (2026-03-28):** Builder session (Claude Code on Cursatory) corrected filenames, code layout, added missing deployment steps, confirmed artifacts exist
- **Accuracy audit (2026-03-28):** Builder session verified all file paths, MD5-matched repo vs deployed copies, confirmed launchd service running, confirmed OAuth token config. OpenClaw reviewed audit results and requested 3 final corrections.
- **Final corrections (2026-03-28):** Fixed `prawduct-builder-protocol.md` → `prawduct-autonomous-bridge.md`, added `CLAUDE_CODE_OAUTH_TOKEN` to `.env` section, added `npm install` step, softened completeness wording to reflect potential repo/habitat drift.
