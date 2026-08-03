# Observability Strategy

Expected of every product, and deeper here because ClawBridge is `runs_unattended`,
`exposes_programmatic_interface`, and `multi_process_distributed` at once.

## The governing lesson

`ptyAvailable: true` masked a total-failure mode for an entire release (#16): the native
binding loaded fine, so the bridge reported healthy, while every session died with
`posix_spawnp failed`. The fix was not only the exec-bit heal — it was **adding a signal
that distinguishes the two states** (`ptySpawnable`), and re-checking it per request so it
reflects on-disk reality rather than boot-time reality.

That is the strategy in one line: *a degraded state must be distinguishable from a healthy
one without shell access to the host.* Every signal below earns its place against that test.

## Two audiences, two channels

### For the orchestrator — the event log

The machine-readable signal. Append-only, cursor-indexed, five kinds (`text`, `lifecycle`,
`permission`, `decision`, `error`); payloads in `data-model.md`. Read via
`/v2/session/output` (cursor + optional `waitMs` long-poll) or summarized by
`/v2/session/peek`.

`decision` events carry an `actor` (`policy` vs. the orchestrator) — so the record of *who
authorized what* is queryable after the fact, not merely inferable. On a product that
adjudicates host actions, that is the audit trail.

`/api/processes` serves fleet-level polling with no registration required.

### For the host operator — `/health` and stdout

`/health` is the liveness *and capability* probe. Its fields exist to separate states that
otherwise look identical:

| Field | Answers |
|---|---|
| `claude` | Is Claude Code present, and which version? |
| `bridge` | **Which build am I actually running?** (1.9.1 — a semver-ranged host had no way to verify a deploy landed) |
| `ptyAvailable` | Did the native binding load? |
| `ptySpawnable` | Can it *actually spawn*? Helper present **and** executable, re-checked per request |
| `ptyMode` | `pty` or the useless-but-alive `pipes-fallback` |
| `v2ActiveSessions` | Is anything in flight? |
| `auth.required` | Is authentication being enforced at all? |
| `insecure` | Present and `true` **only** when the bridge is serving every route unauthenticated. This is the field to alert on — `ok` stays `true` because the broker is in fact serving |
| `tools` | Extension health, or `{ ok: false, error }` — and never flips the root `ok` |

`auth` and `insecure` were added with the `SEC-UTP4` fix, for the same reason `ptySpawnable`
was added after #16: the payload could not distinguish a healthy bridge from one with its
front door open, so an operator reading `/health` was told "fine" either way.

Console output (stderr for warnings, stdout otherwise) carries what `/health` cannot: **rejected authentication attempts**
(`[bridge] 401 <method> <path> from <peer>`, added 2026-08-02) — the only signal that
someone is probing a daemon that binds `0.0.0.0` and whose authenticated routes spawn host
shells. **This is a control that only works if someone watches it**: there is no alerting,
so it is worth a log filter on `[bridge] 401`. A burst from an unexpected peer is the event
worth caring about; a steady trickle is usually a client that missed a token rotation. The
presented credential is deliberately never logged — that would move a would-be secret from
the wire into a file that outlives the request (regression-pinned in `auth.test.js`).

Stdout also carries session spawn failures with exit code and last output,
node-pty load failure with exact fix instructions, extension load/close failures. Added in
1.6.0 after event-log-only reporting was found to leave unattended operators blind — the
defect was the invisibility, not just the crash.

## Correlation

`project` is the primary key an operator reasons in; `sessionId` identifies the run;
`permissionId` ties a `permission` event to its `decision`; the cursor orders everything
within a session. That chain is sufficient to reconstruct any single session end to end.

There is no cross-session or cross-request correlation id — with one session per project and
one bridge per host, there is nothing to correlate across.

## Deliberately not implemented

Metrics, traces, alerting, log levels, structured (JSON) stdout, log rotation. Console
output is the accepted floor for a single-host daemon. Recorded as a decision, not an
oversight — revisit if the bridge ever runs somewhere nobody reads its stdout.

## Known gap — no sensitive-data filtering

`text` events and transcripts carry raw PTY output verbatim. Any secret the agent prints is
stored and served to any token holder. This is the one place where the observability design
is actively *unsafe* rather than merely minimal. See `security-model.md` G2 and `SEC-PZ50`.

## Agent-accessible debugging

A future maintainer session can drive `/health`, `/v2/sessions`, `/v2/session/peek`, and
`/v2/session/output` directly over HTTP — the debugging surface is the product surface, and
no special tooling is required to inspect a live bridge.
