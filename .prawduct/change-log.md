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

## 2026-08-03: Close the documented install path around the auth guard

<!-- prawduct: chunks=01 | status=shipped -->

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

<!-- prawduct: chunks=01,02 | status=shipped -->

<!-- No release= tag on purpose: the BREAKING marker computes a major bump, but the
     version is the owner's decision and nothing in this bundle ships it — package.json
     is still 1.9.1 and CHANGELOG keeps everything under [Unreleased]. Since /health
     reports the package version, asserting v2.0.0 here would have an operator reading
     1.9.1 from a build whose release notes claimed otherwise. Add release=vX.Y.Z at
     release-prep and re-run regen-views. -->

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
