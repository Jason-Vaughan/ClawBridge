# Nonfunctional Requirements

Recorded 2026-08-02 during discovery reconciliation.

**Honest framing first:** the owner has never written performance or availability targets,
and none of the numbers below are measured SLOs. They are the operating characteristics the
code and docs *commit to* — the constants, limits, and invariants a change would have to
justify breaking. Treat them as constraints, not promises.

## Performance

This is an interactive-loop product, not a throughput product. The thing that matters is
that a permission is detected, surfaced, and answered correctly — not quickly.

| Constraint | Value | Why it is what it is |
|---|---|---|
| Pre-keystroke render delay | **500 ms**, non-negotiable | The interactive menu must finish rendering before a keystroke lands. Removing it re-opens Bug #6. This is a correctness constant that happens to look like a latency cost. |
| Parser buffer | 8 KB, tail-retained | Enough for a prompt split across arbitrary PTY chunks; bounded so a long session cannot grow it without limit. |
| Trust-prompt buffer safety valve | 2 KB | Bounds how long startup output is withheld from the parser before flushing. |
| Unknown-permission cooldown | 2 s after a parser reset | Suppresses menu remnants that would otherwise register as a fresh prompt. |
| Prompt timeout | 5 min default | Then auto-**deny** and resume — fail-closed, not fail-open. |
| Session timeout | 30 min default | SIGINT, then SIGKILL after a 5 s grace period. |
| Full test suite | ~9 s; **every test executed except the 14-test live-PTY e2e file** | Fast enough that "run the tests" is never the reason a change skipped them. The 14 skipped are the live-PTY e2e file, gated behind `RUN_E2E=1` — counted separately on purpose, because a skipped suite that gets reported as a passing one is how a gate quietly becomes permanent. |

`peek` is designed to be polled frequently and cheaply; `output` supports `waitMs` long-poll
so a caller need not busy-wait.

## Scalability

- **One active session per project.** Concurrency equals the number of distinct projects.
- Bounded by host CPU/RAM — each session is a real Claude Code process, not a lightweight
  handle.
- **Explicitly not horizontally scalable.** A single host-local daemon with in-memory state
  is the design, not a limitation to be lifted later. Scaling out would mean a different
  product.

## Availability

- Expected always-on under launchd `KeepAlive` / systemd `Restart=always`.
- **Restart is lossy and known to be**: live sessions and prior transcripts do not survive
  (`architecture.md` §Persistence boundaries). The documented mitigation is
  `includeTranscript` on `end` rather than relying on `/v2/session/transcript` afterward.
- No redundancy, no failover, no health-based orchestration beyond process supervision.

## Operability

These are requirements here, not niceties — the product runs unattended, so anything that
fails silently fails invisibly.

- A degraded state must be **distinguishable from a healthy one via `/health` alone**:
  `ptyAvailable` vs `ptySpawnable` vs `ptyMode` exist precisely because a single
  "available" flag masked a total-failure mode for an entire release (#16).
- Which build is running must be answerable remotely — `bridge` version on `/health` (1.9.1).
- A session failure must produce an actionable stdout line, not only an event-log entry
  (1.6.0).

## Resource cost

Zero infrastructure cost — self-hosted on the operator's own machine. The real cost is
Claude API usage driven by whatever sessions the orchestrator starts, billed to the
operator's own credentials and **unmetered by the bridge**. Recorded as a known gap, not a
defect, in `project-state.yaml` cost estimates.

## Not specified, deliberately

No uptime percentage, no latency percentile, no throughput floor, no capacity plan. For a
single-operator host daemon those would be invented numbers, and an invented SLO is worse
than none — it gets cited later as if it had been measured.
