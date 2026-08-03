# Change Log — ClawBridge

<!-- Append new entries at the top. Each entry is a ## section.
     This file is separate from project-state.yaml to reduce merge conflicts
     when multiple branches add entries simultaneously.

     # Tagged entries (enabled by default; set `views_enabled: false` in project-state.yaml to opt out)

     With views enabled (the default), add a tag-line directly under each ##
     header to mark which build-plan chunks the entry shipped and which
     release it belongs to. `prawduct-hook regen-views` uses these tags to
     regenerate three derived views:
       * build-plan `## Status` block — checkboxes flip from `status=shipped`
       * `.prawduct/release-notes.md` — sections grouped by `release=`
       * `scope_rollups:` block in project-state.yaml — grouped by `scope=`
     Untagged entries are ignored by all three views.

     Format:

         ## YYYY-MM-DD: title (vN.M.P)

         <!-- prawduct: chunks=00,01,02 | release=v1.3.18 | status=shipped | scope=v1.4 -->

         **Why:** ...

     Recognized keys:
       chunks   - comma-separated chunk IDs (zero-padded, must match
                  build-plan.md ## Status headers exactly: `Chunk 00:`)
       release  - version string (used by the release-notes view)
       status   - shipped | merged (legacy). Write a new entry with NO
                  status= on the feature branch: a statusless tagged entry
                  is the release-pending state, and it becomes "merged" by
                  construction when its PR lands — no stamp, no post-merge
                  bookkeeping commit (protected branches take commits only
                  by PR). Flip to `shipped` as part of release-prep when
                  the integration branch is released (gitflow), or write
                  `status=shipped` directly in the closing PR when the
                  PR's base IS the release surface (trunk; include
                  `release=vN.M.P` when the product tracks versions —
                  release-notes groups by it) — either way the tag merges
                  atomically with the work it describes.
                  `merged` is a legacy stamp some logs carry; it is treated
                  as statusless. Any other value (including a typo) is a
                  fatal regen-views error — fix it, don't invent states.
       scope    - rollup identifier (e.g., v1.4)

     With `views_enabled: true`, the Status checkboxes in build-plan.md are a
     derived view. Don't hand-edit them — add/update a tagged entry here and
     run `prawduct-hook regen-views`. -->

## 2026-08-03: Stop a destructive operation from answering GET

<!-- prawduct: chunks=01 | status=shipped | release=v2.0.0 | scope=safe-get -->

**Why:** `GET /v2/session/file?consume=true` unlinked the file it returned. The origin gate
shipped alongside this cannot see the callers that matter here, and the reason is not CSRF:
RFC 9110 §9.2.1 defines `GET` as safe, and link unfurlers, browser prefetch, proxies, scanners
and crawlers all rely on that. None of them sends `Origin` or `Sec-Fetch-Site`; none is a
browser driven by a hostile page. Anything that ever *saw* such a URL — a log, a chat message,
a bookmark, a bug report — could destroy the file by merely following it. It also explains the
gate's residual: `GET` is precisely the method browsers do not tag with `Origin`.

**What:** `GET` is a pure read; the consuming form moves to `POST`. `consume=true` on a `GET`
is refused with `405` and `Allow: POST` rather than downgraded to a plain read — a caller that
asked to consume and got `200` would believe the file was gone when it is not, and the
duplicate capture would surface much later somewhere else. `/v2/api-docs` describes both forms,
so the change is discoverable from the API itself.

**Norm position:** third recorded departure from the api-contract compatibility norm, second
narrowing of `/v2`, all three inside 2.0.0. Recorded in `api-contract.md` with the count stated
explicitly, plus a line saying a fourth should be read as evidence the norm needs amending
rather than departing from again. An earlier draft called this the "second" departure — the
miscount is corrected in the build plan rather than quietly fixed, since a wrong count in the
paragraph arguing the count matters is the tell that nobody was counting.

**Known consumer:** TangleClaw's degraded-wrap capture-back, the feature `consume` shipped for
in 1.9.0. Migration is one method. Not tracked as its own backlog item — it lands in another
repo and is recorded in `SEC-K4RD`.

## 2026-08-03: Gate cross-origin requests when the bridge runs without a token

<!-- prawduct: chunks=01,02 | status=shipped | release=v2.0.0 | scope=cors-origin -->

**Why:** `CRS-4T8K` proposed narrowing the wildcard CORS origin, and narrowing it would not
have closed the hole. CORS decides whether a page may *read* a response, not whether the
request is delivered — and `parseBody` ignores `Content-Type`, so a `text/plain` POST is a
CORS-safelisted simple request that no preflight ever gates. A bare cross-origin GET is
easier still, and `GET /v2/session/file?consume=true` unlinks the file it returns. A page the
operator merely visited could therefore spawn agents and delete files on the host.

**What:** while `BRIDGE_TOKEN` is empty, refuse before routing — and echo the allowed origin
instead of `*`. The set is loopback plus whatever `CLAWBRIDGE_ALLOWED_ORIGINS` names exactly;
absent, it widens nothing. Callers that send neither browser header — curl, containers, the
packaged client — are untouched, and with a token set nothing changes.

Two signals, not one. The first pass keyed only on `Origin`, and Critic caught that browsers
append it only when the request mode is CORS or the method is not GET/HEAD: a no-cors GET
(`<img src>`, `<script src>`, `<iframe>`, navigation) carries none and would have driven the
consume-on-read route straight through, which was this change's own headline scenario. The
test passed only because it set `Origin` by hand — `fetch()` does, an `<img>` tag never does.
`Sec-Fetch-Site` now covers that case; `Origin` still decides when present, so a loopback dev
UI on another port is not caught by its own `same-site` report.

**Made the posture observable (chunk 02).** `/health` now carries `cors`, reporting `gated` vs
`wildcard`, whether loopback is allowed, and which additional origins are in force — because a
security control nobody can see is one that regresses unnoticed, and nobody reads stdout on a
launchd service at 3am. Building that surfaced a second defect of the same kind: an entry with
a trailing slash fails closed *silently*, so `/health` would have listed a configured-but-inert
origin as active and answered the operator's question with the opposite of the truth.
Malformed entries are now split into `cors.invalidOrigins` with a warning, and named at boot.

**Records reconciled (chunk 02).** The precondition "and no browser runs on this host" was
enforceable nowhere and stated in five places; it is now enforced instead of requested, so the
FATAL startup message, README Security Posture, the README env table and the operational-spec
triage row all drop it. Three `## [2.0.0]` CHANGELOG entries were corrected rather than
appended to — that version has not shipped, so entries claiming the origin narrowing was "left
as a separate decision" described 2.0.0 wrongly. The departure from the api-contract
compatibility norm is recorded in `api-contract.md` beside its `BRIDGE_TOKEN` sibling, with the
norm re-affirmed rather than weakened.

**Deviation from the plan:** the plan called for a `docs/bridge-v2-bug-index.md` row mapping
this defect to its regression test. That index covers the numbered v2 broker bugs whose tests
live in `regression.test.js`; the two prior security defects are recorded in the security
model instead. Rather than misfile a server-level security control as a broker bug, the index
gained a pointer to where security defects and their guards are recorded, and its stale
"bugs #1–12" header (13 rows) became an invariant.

## 2026-08-03: Close the documented install path around the auth guard

<!-- prawduct: chunks=01 | status=shipped | release=v2.0.0 -->

**Why:** the `SEC-UTP4` guard checks that `BRIDGE_TOKEN` is *present*. `.env.example`
shipped `BRIDGE_TOKEN=changeme`, and README Quickstart step 2 says to copy that file — so
the documented install produced a running bridge on a guessable credential, `0.0.0.0` bind,
wildcard CORS, and no complaint from the guard. Shipping the weak value ourselves defeated
the control we had just added.

**What:** `.env.example` ships the value empty, so copying it leads *into* the refusal;
both it and the FATAL block name `openssl rand -base64 32`; the README separates the
invented secret from the issued one, which is the setup confusion behind the operator's
question that surfaced this.

**Two shipped samples, not one.** `main`'s README already shipped
`BRIDGE_TOKEN=replace-me` in its own paste-able env block — the same released defect in the
second documented install path. The first fix attempt replaced that literal with an
*inline* comment, which the loader (it skips only lines that *start* with `#`) takes as the
value: non-empty, guard silent, bridge running on a string published in this repo. So that
round changed the mechanism without closing the hole — it did not reopen a closed one.
Verified against a running bridge before fixing.

**Coverage:** 6 cases over every documented sample — `.env.example` plus each `env`-fenced
block in the README — asserting each yields no usable token and that a bridge configured
from it refuses to start, plus a meta-assertion that the scan found at least two samples so
a changed fence syntax cannot leave it checking nothing. The first version of this test
pinned `.env.example` alone, which is exactly why it missed the README.

**Not done:** runtime token-strength validation. Real feature, real false-positive risk, and
not what made this a defect — the defect was shipping the weak value.

## 2026-08-02: Close two unauthenticated remote-kill paths and the fail-open auth default

<!-- prawduct: chunks=01,02 | status=shipped | release=v2.0.0 -->

<!-- DISCHARGED 2026-08-03 — this note asked for a release= tag at release-prep, and
     release-prep added one (see the tag line above), so the two no longer disagree.
     Kept as the record of why the tag was withheld at the time: the BREAKING marker
     computed a major bump, but the version was the owner's decision and nothing in
     that bundle shipped it — package.json was still 1.9.1 with everything under
     [Unreleased]. Since /health reports the package version, asserting v2.0.0 then
     would have had an operator reading 1.9.1 from a build whose release notes claimed
     otherwise. That reasoning still governs the NEXT unreleased bundle. -->

**Why:** the bridge treated an unset `BRIDGE_TOKEN` as "authentication optional" and served
every route on a `0.0.0.0` bind while `/health` reported healthy — the auth layer resolving
absent configuration to *allow* while `policy.js` had always resolved it to
`require_review`. Closing that surfaced two separate unauthenticated ways to kill the daemon
outright, both found by self-review or Critic rather than by any test.

**Chunk 01 — fail-open auth.** Refuses to start without a token; exact-match
`CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` escape hatch, declared on `/health` as
`auth.required: false` + `insecure: true`; `checkAuth` returns the opt-in rather than a bare
`true`; `crypto.timingSafeEqual` behind a length guard; 401s now logged with method, path
and peer but never the presented credential.

**Chunk 02 — the crash class.** `/exports` computed a header from an undefined variable, and
those handlers run before the auth check and outside the request `try`, so an uncaught throw
ended the process rather than returning 500. Fixing that one throw left the shape intact:
`EACCES` on an unreadable file killed it the same way, and so did `new URL(req.url, ...)` —
the *first* statement of the handler — on a target like `//`. The whole request callback is
now wrapped. Three iterations of the same lesson: guard the boundary, not the statement that
most recently threw.

**Cost:** the startup change is BREAKING for any deployment currently running tokenless, and
is marked as such so the version bump matches its impact on published consumers.

**Coverage:** 47 new tests across `auth.test.js` and `exports.test.js`; `/exports` had none
at all, which is how a crash on its happy path survived. Each guard verified by
reintroducing the defect it guards.


## 2026-08-02: Prawduct onboarding + discovery reconciliation

**Why:** ClawBridge had no `.prawduct/` at all. Onboarded onto the plugin
distribution and ran discovery in reconciliation mode — the product is at v1.9.1
with a rich README, maintainer guide, PTY broker spec, and tools-extension
contract already written, so discovery read the existing material rather than
re-interviewing.

**What landed:**

- `prawduct-hook init-product --apply` — product-owned state plus the plugin
  install reference. No framework files committed.
- `project-state.yaml` backfilled: classification (developer-tool/automation,
  medium risk with a high-severity permission path), four domain
  characteristics, six risk factors, three personas, seven core flows, scope
  including five explicit `never` boundaries, twenty technical decisions, and the
  design decisions for versioning, error model, observability, and
  infrastructure.
- `risk_surfaces` declared (parser, policy, path-safety, sessions, server) so
  small diffs to the permission path still get the deeper Critic roster.
- `test_command` / `tests_dirs` declared — the defaults would have run
  `python -m pytest` against a `tests/` directory, neither of which exists here.
  Verified: 565 total across 22 files — 551 executed, 14 e2e skipped by default,
  0 failures.
- Nine artifacts authored, seven from `coverage-scaffold`. They point at
  `docs/` where it is already canonical rather than duplicating it; the security
  model is genuinely new.
- Seven backlog items filed from findings.

**Findings worth naming (none introduced by this work):**

- `SEC-UTP4` — auth fails **open** when `BRIDGE_TOKEN` is unset, on a `0.0.0.0`
  bind. The policy engine resolves absent configuration to `require_review`;
  the auth layer resolves it to *allow*. Not fixed here: every fix is a behavior
  change for anyone running tokenless, so it is the owner's call.
- `SEC-PZ50` — transcripts and `text` events store raw PTY output with no
  redaction, on a product recorded as handling credentials.
- `DOC-QNX6` — the 1.6.0 CHANGELOG entry claims the examples are covered by
  in-repo CI. No CI exists and no test references `examples/`.
- `TST-RYHK` — no CI, no linter; every test level is manual.

**Parked, not decided:** the API deprecation policy is drafted as a norm
candidate (`API-T5ST`) and left unratified. Five open questions are recorded in
`project-state.yaml` for the owner.
