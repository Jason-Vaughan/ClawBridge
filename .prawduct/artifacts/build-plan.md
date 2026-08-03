# Build Plan — SEC-UTP4: close the fail-open auth path

**Work type:** bugfix (security) · **Size:** medium · **Critic mode:** final

Medium rather than small despite the small diff: it changes startup behavior for
existing deployments, touches four of the five declared `risk_surfaces`-adjacent
concerns in `bridge/server.js`, and modifies `/health`, a published contract surface.
Size heuristics are a proxy; stakes are the real driver.

## Requirements Confidence: **High**

1. **What problem are we solving?** `bridge/server.js:375` returns `true` from
   `checkAuth` whenever `BRIDGE_TOKEN` is empty, and `TOKEN` defaults to `''` at line
   45. A bridge started without its environment therefore authenticates nothing, on a
   `0.0.0.0` bind (line 854), while `/health` reports a healthy service. Anyone on the
   local network can spawn an agent with shell access to the host.

2. **What does success look like?** Starting the bridge with no `BRIDGE_TOKEN` exits
   non-zero before `listen()` with a message naming the fix. Setting
   `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` starts it anyway, but `/health` then
   declares the exposure instead of reporting plain health, and every boot logs a
   warning. Token comparison is constant-time. Each behavior has a regression test.

3. **What's out of scope?** Scoped/multi tokens (issue #15 — a classification flip,
   not this fix). Changing the `0.0.0.0` bind default (that was option (b), rejected
   by the operator in favor of (a)). Transcript redaction (`SEC-PZ50`, accepted).
   CI (`TST-RYHK`). Rate limiting.

**Requirement provenance:** `README.md:176` has documented `BRIDGE_TOKEN` as
**Required** since before the code existed. This closes a gap between the stated and
actual contract rather than inventing a new constraint — the parent requirement is
pre-existing, not authored here.

## Governing norms

- **`api-contract.md` § Direction** — additive, backward-compatible public contract
  changes. The `/health` additions comply (new fields, existing fields untouched).
  **The startup change does NOT**, and that is a deliberate, recorded departure:
  refusing to boot is a breaking change for a tokenless deployment. `[DECISION:` the
  norm governs the *API surface contract*, not the security posture of an
  unconfigured process. A fail-open default is a defect, and the norm exists to
  protect consumers from surprise — not to preserve a state that endangers them. The
  escape hatch is what keeps this honest: no deployment is left without a path
  forward, it just has to say so out loud. `]`
- **Fail-closed** (`policy.js` precedent) — the rule this change extends to auth.
- **Boundary: `/health`** (`boundary-patterns.md` §1) — consumer impact assessed below.

## Design decisions

**D1 — Escape hatch: `CLAWBRIDGE_ALLOW_UNAUTHENTICATED`, exact value `true`.**
Named so a deployment audit finds it with one grep and nobody sets it by accident.
Rejected: accepting `1`/`yes`/any-truthy — multiple spellings make it easy to enable
absent-mindedly, and the point is deliberateness. Rejected: a magic passphrase value —
cute, and it reads as unserious in a security control.

**D2 — Refuse to start, don't warn-and-continue.** Option (c) was rejected by the
operator. A warning on an unattended daemon is read by nobody; that is the same
invisibility that let #16 hide for a release.

**D3 — `/health` gains `auth` and, when open, `insecure: true`. `ok` stays `true`.**
`ok` means "the broker is serving", and the repo already holds that line — the
tools-extension contract states that an extension failure never flips root `ok`.
Flipping it here would also page an operator about a state they explicitly opted into.
`insecure: true` is the unmissable, alertable signal instead. This is the one decision
where I would most welcome a challenge.

**D4 — `crypto.timingSafeEqual` with a length guard.** `node:crypto` is already
imported (line 333). Compare byte buffers, and guard length first since
`timingSafeEqual` throws on mismatched lengths — the guard leaks only the length,
which the header size already reveals.

**D5 — `/health` stays unauthenticated even while advertising `insecure: true`.**
It reveals to an unauthenticated caller that auth is off. Accepted: one unauthenticated
request to any other route reveals the same thing, so this leaks nothing new — while
being the only channel that tells the *operator*. The alternative (hiding the field)
would keep the operator blind to protect a secret an attacker already has.

## Consumer impact (boundary investigation)

- `/health` — additive only; no field renamed, removed, or retyped. Existing consumers
  (TangleClaw sidecar polling, deploy verification) are unaffected.
- Startup — breaking for any deployment currently running tokenless. Mitigated by D1
  and by the message naming the exact fix. `README.md:176` already promised this
  behavior, so no *documented* contract breaks.
- Tests — verified before designing: `tools-extension.test.js` is the only suite that
  spawns a real bridge subprocess, and it already sets `BRIDGE_TOKEN`. No existing
  test depends on the fail-open path.

### Chunk 01: Close the fail-open auth path

Refuse tokenless startup, add the explicit opt-in, make token comparison constant-time, and
declare the auth posture on `/health`.

**Deliverables**

- `bridge/server.js` — startup guard, `ALLOW_UNAUTHENTICATED`, `checkAuth` rewrite, `/health` `auth` block
- `bridge/__tests__/auth.test.js` — regression coverage for every behavior above
- `README.md` — env table (`CLAWBRIDGE_ALLOW_UNAUTHENTICATED`, `PROJECTS_DIR`) and Security Posture
- `docs/tools-extension.md` — qualify the "auth without exception" guarantee
- `.prawduct/artifacts/security-model.md` — G1/G3 resolved
- `.prawduct/artifacts/api-contract.md` — `/health` additions
- `.prawduct/artifacts/operational-spec.md` — preconditions, triage, respawn-loop note
- `.prawduct/artifacts/observability-strategy.md` — `/health` field table
- `CHANGELOG.md` — `### Security` entries

**Done when:** the criteria below are met.

### Chunk 02: Fix the unauthenticated `/exports/*` process crash

Found by self-review during Chunk 01. Pulled into this plan rather than deferred: Critic
blocked on the contradiction between filing it as an open, fully-detailed vulnerability and
the rule this same changeset records in `learnings.md` — on a public repo, fix before
documenting. Fixing it is what makes the writeup documentation of a closed bug.

**Deliverables**

- `bridge/server.js` — remove the dead ternary over an undefined `ext`
- `bridge/__tests__/exports.test.js` — first coverage this route has ever had
- `README.md` — document `EXPORTS_DIR` and that its routes are unauthenticated
- `.prawduct/artifacts/security-model.md` — G4, boundary 1a
- `CHANGELOG.md` — `### Security` entry

**Done when:** a successful download returns the file body *and the process is still
serving afterward* (verified by reintroducing the defect); **no reachable filesystem error
in either handler can end the process** — pinned by an `EACCES` test, not just the happy
path; and the traversal / absolute-path / NUL / symlink-escape rules are covered.

**Scope correction after Critic:** the first pass fixed the one deterministic throw and
left the class open. Fixing an instance of a crash shape is not fixing the crash.

## Status

- [ ] Chunk 01: Close the fail-open auth path
- [ ] Chunk 02: Fix the unauthenticated `/exports/*` process crash

## Done when

- Full suite green, including new regression tests for: tokenless exit, opt-in boot,
  `/health` shape in both modes, and constant-time comparison behavior.
- `README.md` env table documents `CLAWBRIDGE_ALLOW_UNAUTHENTICATED`; `PROJECTS_DIR`
  added while in the table (`DOC-8B84`, item 3).
- `security-model.md` G1 marked resolved; `api-contract.md` records the `/health`
  additions; `CHANGELOG.md` gains a `### Security` entry under `[Unreleased]`.
- `/prawduct:critic` run and blocking findings resolved.
