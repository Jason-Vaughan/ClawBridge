# Architecture

Required because `classification.structural.multi_process_distributed` is recorded
(`topology: client-server`).

**`docs/bridge-v2-maintainer-guide.md` is canonical** for the module map, the permission
detection pipeline, the session state machine, and the event-kind reference. This artifact
records process topology, concurrency, and persistence boundaries; it does not restate the
guide.

## Process topology

Three tiers, only the middle one owned by this repo:

```
Orchestrator (container)  ──HTTP/JSON, bearer──▶  ClawBridge (host daemon)  ──PTY──▶  Claude Code (child, 1 per project)
                                                          │
                                                          └── tools extension (in-process, optional, ≤1)
```

- **Orchestrator ⇄ bridge** — HTTP over `host.docker.internal`. Request/response plus
  long-poll; no inbound connection to the container is ever required. See
  `boundary-patterns.md` §1.
- **Bridge ⇄ Claude Code** — one PTY per project, bidirectional byte stream. Output is
  parsed; input is individual keystrokes (`\r`, `\x1b`) and message text. The child never
  terminates on its own — it idles awaiting input, which is why completion is inferred
  rather than signalled.
- **Bridge ⇄ tools extension** — *not* a process boundary. The extension is `require`d into
  the bridge process and invoked as a function. Deliberate: it shares the port, the auth,
  and the lifecycle, and needs no service discovery.

## Concurrency model

Single-threaded Node event loop. Concurrency is I/O interleaving, not parallelism.

- One active (non-terminal) session per project; parallelism across projects is bounded by
  host CPU/RAM, since each session is a real Claude Code process.
- The permission parser handles **one detection at a time** (`_pendingDetection`) — a second
  prompt is not considered until the first resolves. This is a correctness constraint, not a
  throughput choice: two in-flight permissions would make a keystroke ambiguous.
- All timers (prompt timeout 5 min, session timeout 30 min, the 500 ms pre-keystroke render
  delay) are per-session and cleared on state transition.

## Persistence boundaries

**Nothing the bridge owns is durable.**

| State | Lives in | Survives restart |
|---|---|---|
| Session + state machine | `SessionManager` map | No |
| Event log (text / lifecycle / permission / decision / error) | in-memory, cursor-indexed | No |
| Transcript | derived from the event log | No — hence `includeTranscript` on `end` |
| Pending permission | on the session | No |
| Project files | host filesystem under `PROJECTS_DIR` | Yes (not owned by the bridge) |
| Config | `bridge/.env` + process env, read once at boot | Yes |

The consequence is deliberate and documented: a restart loses live sessions and makes
`/v2/session/transcript` unavailable for prior ones, which is why the maintainer guide
recommends `includeTranscript` on `end` as the primary export path. Whether that is an
accepted cost or a defect to fix is an open question in `project-state.yaml`.

## Failure isolation

Ordered by what must survive what:

1. **A tools-extension failure must never stop the broker.** `init`, `handleToolsRoute`,
   `getToolsHealth`, and `close` are each wrapped; the failure is logged and the extension
   disabled, or its error substituted into `/health`. Contract guarantee 5.
2. **A session failure must never stop the bridge.** A dead PTY produces an `error` event, a
   stdout log line, and a terminal state — not a process exit.
3. **A `node-pty` load failure degrades loudly.** The pipes fallback keeps the process alive
   but cannot drive a TUI, so it is announced via `ptyMode` rather than silently accepted.
4. **The process itself is supervised** — launchd `KeepAlive` / systemd `Restart=always`.

**Decision: no process-level `uncaughtException` handler** (2026-08-02, prompted by
`EXP-9WQ2`). It is tempting after a crash caused by an uncaught throw, and it is the wrong
instrument. Node's own guidance holds: after an uncaught exception the process is in an
undefined state, so continuing to serve risks answering requests from corrupted state —
worse than dying on a product whose job is adjudicating what an agent may do to the host.
It would also mask exactly the class of defect that produced `EXP-9WQ2`, converting a loud
remote kill into a silent wrong answer.

The alternative in force: **guard at the boundaries**. Handlers that run outside the main
request `try/catch` — today only the two pre-auth `/exports` handlers — carry their own,
returning 500. Any future route added before the auth check inherits that obligation, and
that is the rule to check in review rather than a global net to fall back on.

Module dependency order (`types` ← `pty` / `permission-parser` / `policy` / `event-log` ←
`sessions` ← `routes` ← `server`) is acyclic and enforced by convention; the module
responsibility table in the maintainer guide is the reference.
