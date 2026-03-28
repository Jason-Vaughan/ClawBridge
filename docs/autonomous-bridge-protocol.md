# Autonomous prawduct Builds via ClawBridge

**Date:** 2026-03-24
**Status:** Working — proven end-to-end on a real project

---

## What We Built

An infrastructure layer that allows an AI agent (OpenClaw, running in a Docker container) to autonomously drive prawduct-governed projects through Claude Code on a remote host — with no human in the loop during execution.

The AI agent acts as the **architect** (NHE-ITL — Non-Human Entity In The Loop). Claude Code acts as the **builder**. prawduct provides the project governance. ClawBridge connects them.

---

## Why

OpenClaw runs inside a Docker container. It can reason about what to build, but it needs Claude Code + prawduct for code execution and project governance. Claude Code runs on the **host**, and the agent runs **inside a Docker container**. They can't talk to each other directly.

---

## Architecture

```
┌──────────────────────────────────────┐
│  OpenClaw Container (Docker)         │
│  Agent: Codex (gpt-5.4)             │
│  Role: Architect / NHE-ITL          │
│                                      │
│  Drives builds via HTTP calls        │
│  to the builder bridge               │
└──────────────┬───────────────────────┘
               │ HTTP (JSON API, Bearer token)
               │ http://host.docker.internal:3201
               ▼
┌──────────────────────────────────────┐
│  Builder Bridge (habitat host)       │
│  Node.js HTTP service, port 3201    │
│  launchd managed, auto-restart       │
│                                      │
│  Manages Claude Code sessions        │
│  per project via --resume            │
│  Enforces: auth, circuit breaker,    │
│  directory allowlist, timeouts       │
└──────────────┬───────────────────────┘
               │ child process
               ▼
┌──────────────────────────────────────┐
│  Claude Code 2.1.81                  │
│  --print --permission-mode           │
│    bypassPermissions                 │
│  --session-id / --resume             │
│                                      │
│  Working dir: project root           │
│  Reads CLAUDE.md (prawduct-managed)  │
│  Hooks fire on session lifecycle     │
└──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│  prawduct-governed project           │
│  .prawduct/ governance artifacts     │
│  CLAUDE.md (framework-managed)       │
│  project-state.yaml                  │
│  product-hook (session hooks)        │
└──────────────────────────────────────┘
```

---

## The Bridge

~600 lines of Node.js. Source: `bridge/server.js`.

### Key Design Decisions

**Persistent sessions via `--resume`:** Each `/session/send` call either starts a new Claude Code session (with `--session-id <uuid>`) or resumes an existing one (with `--resume <uuid>`). This gives us multi-turn conversations within a single prawduct session — Claude Code remembers context between calls, CLAUDE.md is read once at session start, and hooks fire naturally at session end.

**`--print` mode with `--permission-mode bypassPermissions`:** Claude Code runs non-interactively. No TTY, no permission prompts. Output is captured as stdout/stderr. This is what makes autonomous operation possible — without it, Claude Code blocks waiting for human approval on every file write.

**Circuit breaker:** After 3 consecutive non-zero exit codes from Claude Code, the bridge refuses further `/session/send` calls until manually reset. Prevents runaway API burn if something is fundamentally broken.

**Bearer token auth:** Shared secret between OpenClaw and the bridge. Simple but effective — the bridge only accepts requests with the correct token.

**Directory allowlist:** Claude Code can only operate on projects under `~/.openclaw/projects/` or `~/prawduct/`. Prevents accidental writes to the host system.

**Static exports:** `GET /exports/<file>` serves files from a designated exports directory. The AI agent can write artifacts there for human review via browser.

### Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | No | Bridge status, Claude version, circuit breaker state |
| `/session/send` | POST | Yes | Start or resume a Claude Code session, send a message |
| `/session/end` | POST | Yes | End a session (triggers governance wrap-up) |
| `/session/status` | GET | Yes | Check if a project has an active session |
| `/sessions` | GET | Yes | List all active sessions |
| `/claude/run` | POST | Yes | Legacy fire-and-forget (single-shot, no session) |
| `/prawduct/run` | POST | Yes | Run prawduct CLI (setup, sync, validate) |
| `/circuit-breaker` | GET | Yes | Check breaker status |
| `/circuit-breaker/reset` | POST | Yes | Reset after investigation |
| `/exports` | GET | No | List exported files |
| `/exports/<file>` | GET | No | Serve an exported file |

---

## The Autonomous Build Protocol

This is how the AI agent drives a full prawduct lifecycle through the bridge.

### Phase 1: Scaffold (new projects only)
```
POST /prawduct/run  →  { command: "setup", args: ["/path/to/project", "--name", "Name"] }
POST /session/send  →  Write project-preferences.md
POST /prawduct/run  →  { command: "validate" }
POST /session/send  →  git init + initial commit
POST /session/end
```

### Phase 2: Discovery
The AI agent already knows what it wants to build. It feeds the answers proactively instead of waiting for Claude Code to ask questions.

```
POST /session/send  →  "Here's what this project is: [vision, scope, stack, constraints...]
                        Populate project-state.yaml with these discovery findings."
POST /session/send  →  (follow-ups if needed)
POST /session/end
```

### Phase 3: Planning
```
POST /session/send  →  "Generate the build plan. Break into chunks."
POST /session/send  →  (review chunks, adjust if needed)
POST /session/send  →  "Commit the planning checkpoint"
POST /session/end
```

### Phase 4: Chunked Build (one session per chunk)
```
# Pre-build checkpoint
POST /session/send  →  "Commit any uncommitted changes as a checkpoint"

# Execute
POST /session/send  →  "Execute chunk N: [description]. Follow acceptance criteria."

# Verify
POST /session/send  →  "Report: files changed, test results, acceptance criteria status"

# Agent reviews the response, decides if acceptable

# Commit + governance
POST /session/send  →  "Commit all changes. Write reflection. Run critic review."

# End session (hooks fire)
POST /session/end
```

### Phase 5: Completion
```
POST /session/send  →  "Run all tests. Verify all chunks. Mark complete."
POST /session/send  →  "Commit release checkpoint"
POST /session/end
POST /prawduct/run  →  { command: "validate" }
```

---

## What We Proved

### Working
- **prawduct scaffold + validate** through the bridge ✓
- **Discovery phase** — AI agent fed answers, project-state.yaml populated ✓
- **Planning phase** — build plan with chunks generated ✓
- **Autonomous file writes** — `--permission-mode bypassPermissions` allows Claude Code to create/modify files without prompts ✓
- **Persistent sessions** — Claude Code remembers context across multiple `/session/send` calls via `--resume` ✓
- **Session end with governance** — stop hook fires, handoff written, no "Hook cancelled" errors ✓
- **Real project build** — first project chunk (Fastify + SQLite + Drizzle + Vitest, 19 files, 11 tests) built and verified ✓
- **Re-verification via persistent session** — existing project inspected, tests run, acceptance criteria checked ✓
- **Circuit breaker** — trips after 3 failures, resets on success ✓

### Issues Encountered and Resolved

| Issue | Cause | Fix |
|-------|-------|-----|
| `claude` not found via SSH | `/usr/local/bin` not in non-login shell PATH | Updated `~/.zshrc` on habitat |
| Permission prompts blocking writes | Claude Code default requires interactive approval | Added `--permission-mode bypassPermissions` to bridge |
| "Hook cancelled" on session end | prawduct stop hook requires reflection + critic before exit; single-shot `--print` didn't complete governance | Switched to persistent sessions via `--resume`; Claude Code completes governance steps within the session |
| Wrong project directory | Agent sent `project: "templog"` but code was in `prawduct-test` | Bridge maps project name to directory — must match exactly |
| Timeout on long builds | Default 2-minute timeout too short | Increased max timeout to 30 minutes |
| pytest not available on host | PyPI blocked by pfSense, host Python is 3.9 | Not resolved for Python projects; Node.js/Vitest works fine for the real project |

### Not Yet Proven
- Full multi-chunk build where each chunk is a separate session with visible chunk-status progression in project-state.yaml
- prawduct interview as a real multi-turn conversation (we fed answers proactively instead)
- Long-running builds (>10 minutes) through the bridge

---

## Key Insight: `--print` + `--permission-mode bypassPermissions` + `--resume`

This combination is what makes autonomous prawduct builds possible:

- `--print` — non-interactive output mode, no TTY needed
- `--permission-mode bypassPermissions` — skips all file/command approval prompts
- `--resume <session-id>` — preserves conversation context between calls

Without `--resume`, each call was a cold start. prawduct's session hooks expected a warm session with state, and the governance gates (reflection, critic review) couldn't be satisfied in a single-shot call. With `--resume`, the bridge maintains a real Claude Code session that prawduct's lifecycle hooks work with naturally.

The earlier attempt without `--permission-mode bypassPermissions` failed with:
```
"The write permission for .prawduct/artifacts/project-preferences.md keeps getting denied."
```

After adding the flag, Claude Code autonomously wrote 19 files (5,019 lines) including TypeScript source, tests, config, and package-lock.json. No permission errors, no human approval needed.

---

## Infrastructure Context

- **Host:** Mac Studio M2 Ultra ("habitat"), macOS, DMZ network
- **Firewall:** pfSense, default deny outbound. Only whitelisted destinations accessible.
- **Claude Code:** 2.1.81, installed at `/usr/local/bin/claude`
- **prawduct:** v1.2.0, at `~/prawduct`
- **Node.js:** v22.14.0
- **Bridge:** port 3201, launchd managed (`com.clawbridge.builder`)
- **Docker:** OpenClaw container with Codex, gateway on port 18789
- **Port registry:** External port registry (if available)

---

## What This Means for prawduct

prawduct was designed for interactive Claude Code sessions with a human at the keyboard. This setup replaces the human with an AI agent that:

1. Knows what it wants to build (architect role)
2. Feeds discovery answers proactively (no interview Q&A needed)
3. Reviews build output programmatically
4. Drives the chunk-per-session workflow via HTTP
5. Respects prawduct's governance (hooks, critic, reflection) by using persistent sessions

The key enabler was Claude Code's `--resume` flag, which lets the bridge maintain session continuity across multiple HTTP calls. Without it, prawduct's session lifecycle model breaks down in non-interactive mode.

**Nothing in prawduct was modified.** The autonomy layer is entirely external — the bridge, the AI agent, and the session management. prawduct runs exactly as designed, just with a non-human driving it.

---

## Source Code

Bridge source: `bridge/server.js` in the ClawBridge repository. v2 PTY broker modules in `bridge/v2/`.
