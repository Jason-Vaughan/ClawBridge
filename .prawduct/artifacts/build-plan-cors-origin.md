---
artifact: build-plan
version: 2
scope: cors-origin
depends_on:
  - artifact: security-model
  - artifact: api-contract
  - artifact: operational-spec
  - artifact: project-preferences
governed_by:
  - artifact: api-contract
    dispositions:
      - "/v2/* changes are additive and backward-compatible; narrowing requires /v3 → exception (recorded below and in api-contract.md § Recorded departure)"
      - "additive capability ships as an optional field/export defaulting to prior behavior → conforms — CLAWBRIDGE_ALLOWED_ORIGINS is optional and its absence changes nothing about the pre-existing allowed set"
      - "cursor positions stay stable and monotonic → inapplicable because this plan touches no event-log or cursor code; the gate runs ahead of routing and returns before any reader is reached"
      - "extension guarantees are contract, not implementation (init timing, error isolation) → inapplicable because the gate neither changes when init runs relative to listen() nor sits between the extension and the broker"
      - "reserved namespaces (/v2, /api/*, /health, /projects) → conforms — no route is added, moved, or claimed; the gate is a pre-routing filter"
      - "versioning: path-major on /v2/*, unversioned v1 infrastructure routes, npm semver as the finer channel → conforms — no new route and no path-major; the npm bump is the major this narrowing rides, per the recorded departure"
      - "error model: { error: '<human-readable message>' } with the HTTP status carrying semantics → conforms — refusals return 403 with 'Origin not allowed' / 'Cross-site request not allowed' in that exact shape, adding no new error field"
      - "/health additions are additive, no field renamed, removed or retyped → conforms — `cors` is new and every pre-existing field keeps its name and type; recorded in api-contract.md § /health additions, 2026-08-03"
      - "GET /exports shape (size: number|null) → inapplicable because this plan changes no response body; the gate returns before any handler builds one"
  - artifact: project-preferences
    dispositions:
      - "named regression test for every known bug → conforms; the index the norm named was split by defect kind under a recorded, vetoable decision in project-preferences.md — numbered broker bugs stay in docs/bridge-v2-bug-index.md, security defects map from security-model.md § Known gaps, and this one names bridge/__tests__/auth.test.js"
      - "security code wants one implementation → conforms — one origin gate, no second check path"
      - "tests assert observable behavior through the public surface → conforms — real bridge subprocess over HTTP"
      - "every change updates CHANGELOG.md → conforms, but under [2.0.0], not [Unreleased] (see Chunk 02)"
last_validated: 2026-08-03
---

## Requirements Confidence

**Level:** High

**Why:** The problem, the success criterion, and the scope are each statable in one sentence,
and the two facts the design turns on were read out of the code rather than recalled:
`parseBody` (`bridge/server.js:354`) ignores `Content-Type`, and `GET /v2/session/file`
unlinks the file when `consume=true` (`bridge/v2/routes.js:519`).

- **Problem:** under `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true`, any page the operator visits can
  drive the bridge cross-origin — spawning agents and deleting files — because CORS governs
  response *readability*, not request *delivery*.
- **Success:** a cross-origin browser request from a disallowed origin cannot reach a route
  handler at all, including via paths that never trigger a preflight; non-browser callers are
  bit-for-bit unaffected.
- **Out of scope:** anything that changes behavior when `BRIDGE_TOKEN` is set; `CFG-3QK7`
  (the `.env` empty-vs-absent bug) even though the work passes next to it — a correct
  drive-by fix in a security change is still an unplanned behavior change (learnings,
  "Absent configuration must never widen authority").

**Open assumptions / unknowns:**

- `[ASSUMPTION: a browser UI served from a non-loopback origin against an unauthenticated
  bridge is a real enough deployment to deserve an escape hatch, rather than being told to
  set a token | MED impact | user can override — striking CLAWBRIDGE_ALLOWED_ORIGINS makes
  the change smaller and stricter]`
- `[ASSUMPTION: loopback origins stay allowed by default, since a page cannot hold a loopback
  origin without something already executing on the host | LOW impact | user can override
  toward same-origin-only]`

**What would raise confidence:** N/A — High.

## Recorded norm departure

`[DECISION: narrow CORS/Origin behavior in the 2.0.0 major rather than deferring it to a /v3
path-major | The api-contract Direction norm reads "removing or narrowing either surface
requires a new path-major version (/v3) ... never a minor or patch release." This narrows what
a browser caller can do to /v2/* when the bridge runs unauthenticated, so the norm applies and
this is a departure, not an exemption — calling it "transport-level, not the API contract"
would be the laundering tell. It follows the norm's own recorded precedent (the BRIDGE_TOKEN
startup requirement, 2026-08-02) on all four counts that made that departure honest: the norm
protects consumers from surprise and does not exist to preserve a state that endangers them;
the prior behavior let a visited web page delete files on the host; an explicit escape hatch
(CLAWBRIDGE_ALLOWED_ORIGINS) leaves no deployment without a path forward; and it ships marked
BREAKING so the version carries the cost visibly. | user can veto — the alternative is
shipping 2.0.0 without this and opening /v3]`

The departure is recorded in `.prawduct/artifacts/api-contract.md`, not only here, because
build plans are retired at merge and a norm whose only recorded exception lives in a deleted
file is a norm that will be misread next time.

## Status

- [x] Chunk 01: The origin gate — reject disallowed origins, echo the allowed one
- [x] Chunk 02: Make the posture visible and reconcile the governing artifacts
Context: Plan written 2026-08-03 after a discovery pass corrected `CRS-4T8K`'s stated remedy;
both chunks built and committed on `release/2.0.0`. The design grew one signal under review —
keying on `Origin` alone missed the no-cors GET, which carries none, so `Sec-Fetch-Site` backs
it up — and chunk 02 found the same defect class again in its own work: a malformed allowlist
entry failed closed silently, so `/health` would have reported it as active. Both are fixed and
falsified. The suite started this plan at 604; `.prawduct/.test-evidence.json` carries the
current figure — restating it here is what produced a wrong `629` that outlived two commits.

**Plan complete.** The `cumulative` review that `Type: cumulative-final` calls for has run
(0 blocking, 7 warnings), its findings are fixed, and a `verify-resolutions` pass confirmed all
seven. `CRS-4T8K` is archived. Remaining: `/prawduct:pr`, then the release itself.

The cumulative pass caught a real one — the gate matched the raw allowlist while `/health`
reported the filtered set, so a `null` entry was honoured and simultaneously reported inert.
Third instance in this plan of a check narrower than its claim; the distilled rule is mechanic
4 under "Verify against the claim, not against the change" in `learnings.md`.

The `565`-test figures in `backlog.md` and `change-log.md` were
deliberately left: each is a dated verification record, and rewriting a dated fact falsifies
history rather than fixing staleness. Only the `project-state.yaml` one was touched, because it
read as a claim about the current suite rather than about the invocation it was recording.

Open past this plan: `SEC-K4RD` — the destructive route should not answer `GET` at all. Filed
rather than built, because it surfaced mid-build; free inside 2.0.0 and expensive after, so it
is a decision the release should not pass silently.

## Scaffolding

No new scaffolding. Existing repo, existing runner.

### Dependencies

None added. The gate is Node stdlib string comparison; adding a CORS library for this would
be a dependency taken on to avoid writing ten lines.

### Build & Test Configuration

`npm test` (`vitest run`). Server-surface tests live in `bridge/__tests__/`, several spawning a
real bridge subprocess over HTTP; the auth-guard sentinel is `bridge/__tests__/auth.test.js`.

### Verification Strategy

Tests are necessary but not sufficient here, because the defect class is "the check was
narrower than the claim" (learnings, "Verify against the claim, not against the change"). So
each guard is **falsified before it is trusted**: break the guard, watch the specific test go
red, restore it. And because a green too-narrow check is exactly the failure this project has
already shipped once, the tests **enumerate** the bypass paths rather than naming one — with a
meta-assertion that the enumeration is non-empty, so a renamed constant cannot leave the suite
green while checking nothing.

Beyond tests: start a real bridge with `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` and drive it
with `curl` twice — once with no `Origin` header (must behave exactly as today) and once with
`-H 'Origin: https://evil.example'` (must be refused before routing).

## Project Structure

No new files in `bridge/`. The gate lands in `bridge/server.js` alongside the existing CORS
header block, because `project-preferences.md` holds that security code wants one
implementation — a second origin-checking path is the thing to avoid, not a module boundary to
gain.

## Build Chunks

### Chunk 01: The origin gate — reject disallowed origins, echo the allowed one

- **Description:** Close the browser vector in unauthenticated mode. Resolve an allowed-origin
  set; refuse any request carrying an `Origin` outside it before routing; echo the allowed
  origin instead of `*`. All three are inert when `BRIDGE_TOKEN` is set.

  **Why the gate covers every request, not just non-GET ones:** `GET /v2/session/file?
  consume=true` unlinks the file after reading (`bridge/v2/routes.js:519`), and a bare
  cross-origin `GET` needs no preflight and no custom header — it is the *easiest* request to
  forge, not the safest. Classifying routes by method would have left a destructive one
  outside the gate, and every future route would re-open the question. One gate, no
  per-route judgment.

  **Why an `Origin` check is safe for existing callers:** browsers set `Origin` and page
  script cannot forge it; non-browser callers (curl, containers, the RentalClaw client) send
  no `Origin` at all. The gate keys on *presence* — absent means untouched.

- **Depends on:** none
- **Artifacts consumed:** `security-model.md` § Known gaps G5 ("The header alone does not
  close it"), `project-preferences.md` (test homes, one-implementation rule)
- **Deliverables:**
  - Allowed-origin resolution in `bridge/server.js`: loopback (`localhost`, `127.0.0.1`,
    `[::1]`, over either `http` or `https` — what makes loopback safe is that a page cannot
    hold such an origin without local execution, and a local dev server holding a certificate
    does not weaken that) by default, widened only by an exact-match, comma-separated
    `CLAWBRIDGE_ALLOWED_ORIGINS`. **Absence resolves to the most restrictive set, never to
    wildcard** — the rule from "Absent configuration must never widen authority", which this
    product already violated once via `BRIDGE_TOKEN`.
  - Rejection: when `TOKEN` is empty, respond `403` and return before any routing — including
    before the `/exports/*` handlers that deliberately run ahead of the auth check — for a
    request carrying either an `Origin` outside the set, or (when `Origin` is absent) a
    `Sec-Fetch-Site` that is neither `same-origin` nor `none`.

    **Both signals are required.** Browsers append `Origin` only when the request mode is
    CORS or the method is not GET/HEAD, so a no-cors GET — `<img src>`, `<script src>`, an
    `<iframe>`, a top-level navigation — carries none and would drive the consume-on-read
    route straight through an `Origin`-only gate, needing no preflight and no script at all.
    `Origin` decides when present, because it is the more precise signal and because a
    loopback dev UI on another port legitimately reports `Sec-Fetch-Site: same-site`.
  - Header: echo the request's origin when allowed; omit the header entirely when refused.
    Wildcard is retained unchanged when `TOKEN` is set.
  - Entry in `docs/bridge-v2-bug-index.md` mapping `CRS-4T8K` to its named regression test.
- **Tests:** `bridge/__tests__/auth.test.js` (the auth-guard sentinel — the gate is an
  authorization boundary, so it belongs with the other one rather than in a new file), plus
  the named regression test in its mapped home. Enumerated, not named:
  1. **The no-preflight path** — `POST /v2/session/start` with `Content-Type: text/plain` and
     a disallowed `Origin` is refused. This is the case a header-only fix leaves open, so it
     is the test that must exist.
  2. **The destructive GET** — `GET /v2/session/file?consume=true` with a disallowed `Origin`
     is refused *and the file still exists afterward*. Asserting the status alone would pass
     against a gate that refuses after unlinking.
  3. **The preflight path** — `OPTIONS` from a disallowed origin does not return
     `Access-Control-Allow-Origin`.
  4. **Non-browser callers unaffected** — no `Origin` header, unauthenticated: every route
     behaves exactly as before. Enumerate the routes; assert the enumeration is non-empty.
  5. **Token set means no change** — with `BRIDGE_TOKEN`, a disallowed `Origin` still gets
     wildcard and the pre-existing behavior.
  6. **Allowlist opt-in** — an origin named in `CLAWBRIDGE_ALLOWED_ORIGINS` is allowed;
     absence of the variable does not widen anything.
- **Acceptance criteria:** `npm test` passes; each of the six above has been individually
  falsified (guard broken → that test red → guard restored) rather than only observed green;
  the manual two-`curl` check behaves as described in Verification Strategy.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. Committed and chunk marked `[x]` in Status

### Chunk 02: Make the posture visible and reconcile the governing artifacts

- **Description:** A security control nobody can observe is a control that silently regresses.
  Surface the CORS posture on `/health` — the rule this product learned twice is that a
  degraded state must be distinguishable from a healthy one *through `/health` alone*, because
  nobody reads stdout on a launchd service at 3am. Then correct every place that documents the
  now-obsolete precondition, and record the norm departure where it will outlive this plan.
- **Depends on:** Chunk 01
- **Artifacts consumed:** `api-contract.md` § Direction, `operational-spec.md` (triage row),
  `security-model.md` § Known gaps G5
- **Deliverables:**
  - `/health` reports the effective CORS posture alongside the existing `auth.required` /
    `insecure` signals, so a remote operator can tell a gated bridge from a wildcard one
    without shell access. A widened `CLAWBRIDGE_ALLOWED_ORIGINS` must be visible here — an
    operator who widened it six months ago should not have to remember.
  - The FATAL startup message in `bridge/server.js` loses "AND no browser runs on this host
    (CORS is wildcard, so a visited page could call the API)" — that precondition is now
    enforced rather than requested, and leaving the text would misdescribe the product.
  - README Security Posture and the `operational-spec.md` triage row updated for the same
    reason.
  - `CHANGELOG.md` entry marked `BREAKING`, **under `## [2.0.0]`, not `## [Unreleased]`** —
    this branch already promoted `[Unreleased]`, so the usual "add under `[Unreleased]`"
    preference would file the entry into a version that ships *after* the change it describes.
  - `api-contract.md`: the recorded departure from this plan's "Recorded norm departure"
    section, written as a sibling of the existing `BRIDGE_TOKEN` one. While editing that
    Direction section, re-affirm the norm and clear the outstanding `norm-lifecycle` advisory
    — its rationale still cites candidate `API-T5ST`, which has since been ratified and
    archived, so the citation dangles.
  - `security-model.md` G5 flipped from OPEN to fixed, with the residual browser-only bound
    preserved rather than dropped.
- **Tests:** assert `/health` reports the gated posture unauthenticated, and that a widened
  allowlist is reflected there. Docs changes carry no tests; the Critic reviews them as prose
  deliverables.
- **Acceptance criteria:** `npm test` passes; `grep` finds no surviving copy of the "no
  browser runs on this host" precondition anywhere in the repo — enumerate the hits before
  and after, because "I fixed the one I was thinking about" is this project's recorded
  failure mode.
- **Type:** cumulative-final
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. Committed, then `/prawduct:critic cumulative` run once and blocking findings resolved
  3. Chunk marked `[x]` in Status
