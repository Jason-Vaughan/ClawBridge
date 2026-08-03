# Data Model

**No persistent data model — there is no database, no ORM, no schema, and no migration
path, by design.** Nothing the bridge owns outlives the process (see `architecture.md`
§Persistence boundaries).

That is the coverage decision. What follows is the *in-memory* shape, recorded because it
is a real contract even though it never touches disk: these structures are serialized
straight onto the HTTP surface, so changing one is an API change.

**Canonical source: `bridge/v2/types.js`.** Enums and the state-machine graph live there;
this file is a reader's map, not a second definition.

## Entities

**Session** — keyed by `project` (not by id, from the caller's perspective). Carries
`sessionId`, `state`, `createdAt`, the approval envelope, the pending permission if any, and
its timers. Invariant: at most one non-terminal session per project. `isTerminal` is the
only sanctioned liveness check — bugs #7 and #8 both came from comparing against specific
states instead.

**Event** — append-only, cursor-indexed. Five kinds, each with a fixed payload:

| Kind | Payload |
|---|---|
| `text` | `{ text, stream }` — raw PTY output, unfiltered |
| `lifecycle` | `{ fromState, toState }` |
| `permission` | `{ event }` — the full structured permission |
| `decision` | `{ permissionId, decision, actor, reason }` |
| `error` | `{ code, message, details }` |

The cursor is the read contract: callers poll from a position, and positions must remain
stable and monotonic. Inserting or reordering events retroactively would corrupt every
in-flight consumer.

**Permission** — `permissionId`, type, risk level, target, timeout. The id is what
`/v2/session/respond` matches on; responding with a stale id is a 409, not a silent no-op.

**Approval envelope** — caller-supplied policy, validated in `bridge/v2/policy.js`.
Structure documented in `README.md` and the maintainer guide. Evaluation order is specific
rule → risk default → `require_review`. Absent envelope means everything requires review.

## Sensitive content

`text` events and the transcript derived from them hold **raw, unfiltered PTY output**. No
redaction exists anywhere. Recorded in `security-model.md` and filed as `SEC-PZ50`.
