---
artifact: build-plan
version: 2
scope: safe-get
depends_on:
  - artifact: security-model
  - artifact: api-contract
  - artifact: project-preferences
governed_by:
  - artifact: api-contract
    dispositions:
      - "/v2/* changes are additive and backward-compatible; narrowing requires /v3 → exception (recorded below and in api-contract.md § Recorded departure)"
      - "additive capability ships as an optional field/export defaulting to prior behavior → inapplicable because this plan adds no capability; it moves an existing one to a different method"
      - "error model: { error: '<message>' } with the HTTP status carrying semantics → conforms — the refusal is a 405 with that body shape, adding no new error field"
      - "cursor positions stay stable and monotonic → inapplicable because this plan touches no event-log or cursor code"
      - "extension guarantees are contract, not implementation → inapplicable because /v2/session/file is a broker route, not the extension surface"
      - "reserved namespaces (/v2, /api/*, /health, /projects) → conforms — no namespace is claimed; an existing path gains a method"
      - "versioning: path-major on /v2/*, npm semver the finer channel → conforms via the recorded departure; the 2.0.0 major is the carrier"
      - "/health additions are additive → inapplicable because /health is unchanged"
      - "GET /exports shape (size: number|null) → inapplicable because /exports is untouched"
  - artifact: project-preferences
    dispositions:
      - "named regression test for every known bug → conforms — G7's guard lands in bridge/v2/__tests__/session-file.test.js, the home for this route, and is named from security-model G7"
      - "security code wants one implementation → conforms — the method check lives at the one route handler; no second dispatch path"
      - "tests assert observable behavior through the public surface → conforms"
      - "every change updates CHANGELOG.md → conforms, under [2.0.0] (this branch already promoted [Unreleased])"
last_validated: 2026-08-03
---

## Requirements Confidence

**Level:** High

**Why:** One route, one method, one refusal. The problem was verified by reading the handler
(`bridge/v2/routes.js:519` unlinks on `consume=true`), the remedy was chosen by the operator
from four framed options, and the governing rule is a stable, long-settled spec (RFC 9110
§9.2.1, `GET` is a safe method) rather than anything fast-moving.

- **Problem:** a destructive operation answers `GET`, so any intermediary that follows a URL —
  link unfurler, prefetcher, proxy, scanner, crawler — deletes the file by merely looking at
  it. None of them send `Origin` or `Sec-Fetch-Site`, so the `CRS-4T8K` gate cannot see them.
- **Success:** `GET /v2/session/file` never has a side effect; the consuming form is reachable
  only by `POST`; a `GET` carrying `consume=true` is refused rather than quietly downgraded.
- **Out of scope:** the read path's behavior, path-safety validation, and the `consumed:false`
  semantics on a failed unlink — all unchanged. No other route is audited for method safety in
  this plan (see the note under Chunk 01 for why that is bounded, not ignored).

**Open assumptions / unknowns:**

- `[ASSUMPTION: refusing GET+consume with 405 rather than 400 | LOW impact | user can
  override — 405 is the method-semantics answer and lets the response name POST in Allow,
  which is the migration hint a caller most needs]`

**What would raise confidence:** N/A — High.

## Recorded norm departure

`[DECISION: move the consuming form of /v2/session/file from GET to POST inside the 2.0.0
major, rather than deferring to /v3 | This narrows /v2/*, so the api-contract Direction norm
applies and this is a departure, not an exemption. It is the THIRD departure recorded against
this norm and the SECOND narrowing of /v2 — all three inside the 2.0.0 major. That count is the
thing worth justifying rather than the change itself: a norm departed from repeatedly is on its
way to not binding, and "it was a security fix" excuses almost anything if nobody is counting.
What makes this one hold up beyond judgment is RFC 9110 §9.2.1 — GET is defined as safe, so the
previous behavior violated a guarantee every HTTP intermediary is entitled to rely on. No
consumer could correctly depend on it, and several classes of software that never consented to
being consumers (unfurlers, prefetchers, crawlers) could trigger it. That is narrower and more
checkable than the judgment call the other two rest on. TangleClaw is the known consumer and
the migration is one method. | user can veto — the alternative is shipping 2.0.0 without it and
opening /v3, which the operator declined after seeing four framed options]`

An earlier draft of this block said "SECOND departure". It was wrong: `api-contract.md` already
recorded two (`BRIDGE_TOKEN` 2026-08-02, `CRS-4T8K` 2026-08-03). Corrected rather than quietly
fixed, because a miscount in the paragraph arguing that the count matters is the tell that
nobody was counting.

Recorded in `api-contract.md` beside its two siblings, because build plans are retired at
merge and a norm whose exceptions live only in deleted files is a norm that will be misread.

## Status

- [x] Chunk 01: `GET` stops deleting; `POST` starts
Context: Plan written 2026-08-03 after discovery on `SEC-K4RD` reframed it from a CSRF residue
to an HTTP-safety defect. Chunk built and committed; guards falsified by running both mutations
and the red tests named in G7's coverage table. Verified on a real bridge with a bare `curl`
`GET` — the shape a prefetcher issues — and the file survived.

One cross-plan interaction worth knowing: this change turned a `cors-origin` test red. That
test used `GET …&consume=true` to prove the origin gate was not blanket-refusing non-browser
callers. Its claim was untouched by this work; only the method carrying it moved, so it was
migrated to `POST` rather than relaxed.

Remaining: the single `/prawduct:critic cumulative` this `Type: cumulative-final` calls for
(it covers both plans on this branch), then `/prawduct:pr`.

## Scaffolding

None. Existing repo, existing runner, no new dependency.

### Build & Test Configuration

`npm test` (`vitest run`). This route's tests live in `bridge/v2/__tests__/session-file.test.js`.

### Verification Strategy

Falsify each guard before trusting it — break it, watch the *named* tests go red, restore.
Name the tests rather than counting them, and re-derive by running the mutation rather than
reasoning about it: this repo has now produced five claims whose scope exceeded what was
checked, two of them inside falsification records themselves.

Beyond tests, the case that motivated the change is not a browser one, so verify it the way it
would actually happen: `curl` the consuming URL as a bare `GET`, the way a prefetcher or an
unfurler would, and confirm the file is still there afterward.

## Project Structure

The method check lives in the existing `/v2/session/file` handler in `bridge/v2/routes.js`.
One handler, one decision — no second dispatch path, per the one-implementation preference.

## Build Chunks

### Chunk 01: `GET` stops deleting; `POST` starts

- **Description:** Make `GET /v2/session/file` a pure read and move the consuming form to
  `POST`. A `GET` carrying `consume=true` is **refused with 405**, not served without the
  unlink — silently downgrading would hand the caller a file it believes it consumed and a
  bug that only shows up as a duplicate capture much later.

  **Bounded, not exhaustive:** this chunk fixes the one route known to violate `GET` safety.
  It does not audit every route for side effects. That is a real gap and it is recorded here
  rather than left implied — if the sweep is wanted it is its own work, because "check every
  handler for side effects" is a different task from "fix this one."

- **Depends on:** none
- **Artifacts consumed:** `security-model.md` § Known gaps G7, `api-contract.md` § Direction
- **Deliverables:**
  - `bridge/v2/routes.js`: the existing `GET` branch ignores `consume` entirely; a new `POST`
    branch on the same path performs read-then-unlink with the current semantics preserved,
    including `consumed:false` on a failed unlink so bytes are never lost.
  - `GET` + `consume=true` → `405` with `Allow: POST` and `{ error: … }` naming the new
    method, so the migration hint is in the response rather than only in the changelog.
  - `/v2/api-docs`: the self-describing entry updated — it is the contract a consumer reads at
    runtime, so leaving it stale would document the removed behavior as current.
  - `CHANGELOG.md` under `## [2.0.0]`, marked `BREAKING`, naming TangleClaw's capture-back as
    the known affected caller and the one-line migration.
  - `api-contract.md`: the recorded departure above, as a third sibling.
- **Tests:** `bridge/v2/__tests__/session-file.test.js`, named from G7. Enumerated over
  **request shape**, which is the axis this defect lives on:
  1. **The prefetcher case** — a bare `GET` with `consume=true` is refused, *and the file still
     exists*. Status alone would pass against a handler that unlinked and then refused.
  2. **The plain read is untouched** — `GET` without `consume` still returns the bytes and
     leaves the file, exactly as before.
  3. **`POST` consumes** — returns the bytes, `consumed: true`, and the file is gone.
  4. **`POST` preserves the failed-unlink contract** — `consumed:false` with the bytes still
     returned, since "bytes are never lost" is the property that made `consume` safe to ship.
  5. **The refusal is actionable** — `405` carries `Allow: POST`.
- **Acceptance criteria:** `npm test` passes; each guard above individually falsified and the
  red tests named in G7's coverage table by running the mutation, not by reasoning about it;
  the bare-`curl` check leaves the file in place.
- **Type:** cumulative-final
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. Committed, then `/prawduct:critic cumulative` run once and blocking findings resolved
  3. Chunk marked `[x]` in Status
