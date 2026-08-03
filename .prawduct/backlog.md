# Backlog — ClawBridge

<!-- Structured backlog (Prawduct v1.7+). Managed with the `/backlog` skill:
     /backlog            summary + menu
     /backlog pick       what to work on next (filters + natural language)
     /backlog add        file a new item (searches for duplicates first)
     /backlog find <q>   search title/metadata/body
     /backlog list       tabular view (default: open, added within 90d)
     /backlog update ID  change metadata or status
     /backlog migrate    convert legacy unstructured items to this format

     Items move between the three sections below via `/backlog update ID status=...`.
     The framework never infers status from build plans or change logs — an agent
     or human makes the call explicitly (see backlog-system-requirements.md D4/§5).

== Item shape ==

  - **[PFX-XXXX]** One-line title
    `effort: M · impact: M · area: stop-hook · source: reflection · added: 2026-05-29 · status: open`

    Free-form body of any length — a single sentence or multi-paragraph analysis
    with file refs, fix-shape, and open questions. The author chooses what fits.

  ID format `[PFX-XXXX]`:
    PFX = 2–3 uppercase letters naming the work-space the item was filed from.
          Derive a sensible prefix from the item's area; reuse existing ones so
          related items share a prefix. Starter vocabulary (extend freely):
            STH stop-hook · CRT critic · SYN sync · LLM prompt/LLM · BKL backlog
            MIG migration · JNT janitor · MET methodology · DOC docs · TST tests
          A project may optionally declare its prefix vocabulary as
          `backlog_prefixes:` in project-state.yaml for validation — not required.
    XXXX = 4-char random alphanumeric (base36). Random IDs avoid cross-branch
           collisions; ~1.7M combinations per prefix.

  Metadata bar (one backticked, dot-separated line; required on new items):
    effort: S | M | L     S = <30 min · M = hours · L = multi-chunk
    impact: S | M | L     S = cosmetic · M = quality-of-life · L = user-felt/structural
    area:   <tag>         free-form topic tag; reuse existing tags to enable grouping
    source: builder | critic | reflection | janitor | user
    added:  YYYY-MM-DD
    status: open | promoted | shipped | dropped
  Optional, on the same line (distinct concepts — keep them straight):
    related:   PFX-XXXX, PFX-XXXX   cross-references to related items
    closes:    PFX-XXXX             this item supersedes another backlog item (item → item)
    closed-by: <chunk-id | scope/branch | tag>  what shipped this item (item → release), set on
                                    status=shipped; a handle that exists before the commit —
                                    never a bare commit SHA (dangles on --amend) or unassigned PR#
    reviewed:  YYYY-MM-DD           last-touched timestamp (auto-set on any update)
    accepted-by: @actor             soft claim "someone is on this" so others don't
                                    double-pick; pick/list exclude claimed items.
                                    Does NOT auto-expire; auto-cleared on ship/drop.
                                    Not a lock (backlog.md is eventually-consistent).
    stage: <lifecycle>              idea | research | requirements | design | ready.
                                    Where the item sits in the feature lifecycle;
                                    only `ready` is implementable. Absent/early =>
                                    pick routes to discovery/planning, not code.
    refs: <doc#section>, <doc>      links to governing artifacts (requirements /
                                    arch / design docs). Distinct from `related:`
                                    (which is item -> item).

  Legacy items (no metadata) remain valid — tools treat them as
  `effort: ? · impact: ? · area: untagged · status: open` and rank them lower.
  Run `/backlog migrate` to add structure at your own pace; nothing is forced. -->

## Open

<!-- Items available to pick up. -->

<!-- ⚠ BACKEND CUTOVER DEFERRED — 2026-08-02.
     The move to GitHub Issues was ruled in, and `/prawduct:backlog scrub` ran
     its read-only prep cleanly (7/7 items parse, 0 collisions, no stale or
     duplicate items). It stopped before mutating anything, on a blocker that
     outranks the cutover:

     `Jason-Vaughan/ClawBridge` is a PUBLIC repo and `@jason-vaughan/clawbridge`
     v1.9.1 is live on npm. At the time the scrub ran, SEC-UTP4 was unfixed and
     its body carried file:line refs and explicit exploitation framing, so
     importing it verbatim would have published a working auth bypass.

     RESOLVED as of 2026-08-02: SEC-UTP4 and EXP-9WQ2 both shipped, so the
     writeups now document closed bugs and the disclosure objection is gone.
     The cutover is unblocked and simply has not been run — the remaining
     precondition is that the fixes are released, not merely merged, since npm
     still serves 1.9.1.

     Nothing has been created on GitHub. `backlog_service_repo` stays unset, so
     this file remains the live backlog until the cutover runs. -->


<!-- The six items below were filed 2026-08-02 by discovery reconciliation during
     Prawduct onboarding. They are findings from reading the repo against its own
     docs — none were introduced by the onboarding itself. -->

- **[CRS-4T8K]** Wildcard CORS makes the unauthenticated escape hatch unsafe on any host with a browser
  `effort: S · impact: M · area: security · source: critic · added: 2026-08-02 · status: open · stage: design`

  `bridge/server.js` sets `Access-Control-Allow-Origin: *` on every response, and
  the preflight allows `POST` with an `Authorization` header. With `BRIDGE_TOKEN`
  set this is a nuisance rather than a hole — a random page has no credential to
  send. **Under `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` it is a hole**: any page
  the operator visits can cross-origin `POST /v2/session/start` against
  `localhost` and spawn an agent with shell access to the host.

  Raised three times by Critic before being acted on, because each pass I treated
  it as a security-behavior decision belonging to the owner and therefore not
  mine to touch. That was half right: changing the header is the owner's, but the
  *precondition I had written into the startup warning and the README* — "only if
  this port is genuinely unreachable by anyone else" — was mine, and it was
  unsatisfiable as stated. Documented now in both places plus a comment at the
  header, so an operator can at least evaluate the risk.

  **Remaining decision (the reason this stays open):** narrow the origin when
  running open — e.g. echo only `localhost`/`127.0.0.1` origins, or drop the
  wildcard entirely when `TOKEN` is empty. Cheap, and it would make the
  precondition satisfiable rather than merely documented. Not done here because
  it changes CORS behavior for existing container callers, which is exactly the
  kind of thing that should not ride along in someone else's PR.

- **[CFG-3QK7]** `.env` loader treats an explicitly-empty variable as absent
  `effort: S · impact: S · area: config · source: critic · added: 2026-08-02 · status: open · stage: ready`

  `bridge/server.js` loads `bridge/.env` with `if (!process.env[key]) process.env[key] = val`.
  A variable a caller deliberately set to `''` is falsy, so `.env` silently overrides it —
  the same empty-vs-absent conflation that made an unset `BRIDGE_TOKEN` mean "authentication
  optional" (`SEC-UTP4`).

  **This was fixed during the `SEC-UTP4` cycle and then deliberately reverted** on Critic
  review. The finding was correct: the change was outside that chunk's stated scope, it
  alters precedence for *every* key (a `PROJECTS_DIR=""` in a plist would newly fall through
  to the default instead of the `.env` value) and was undocumented as such, and the line
  cannot execute in CI because the `.env` it reads is gitignored and absent — so no test
  could guard it and a silent revert would not have failed the suite. A correct drive-by fix
  is still an unplanned behavior change in a security PR.

  Fix here, properly: `if (process.env[key] === undefined)`, a CHANGELOG note about the
  precedence change, and a test that actually exercises the loader — which needs a fixture
  `.env` with backup/restore, since the path (`bridge/.env`) is not redirectable.

  Consequence while open: `bridge/__tests__/auth.test.js` throws a diagnostic error at load
  if a real `bridge/.env` defines `BRIDGE_TOKEN`, because the loader would backfill a token
  into the deliberately-tokenless cases and they would fail inexplicably.

- **[DOC-I9MN]** `.claude/priming/clawbridge-toolmount-fix.md` publishes habitat operational detail
  `effort: S · impact: M · area: docs · source: critic · added: 2026-08-02 · status: open · stage: design`

  Already public — added to `main` by `0897b79` (PR #8), not by the onboarding
  branch. Found during the pre-push disclosure sweep. It names the habitat host,
  the `~/openclaw` deployment path, five paused cron jobs with an id, the
  `docker exec` invocation to re-enable them, and the `CLAWBRIDGE_TOKEN` /
  `OPENCLAW_EXTENSIONS` env vars. **No secret values** — names and paths only, so
  this is reconnaissance detail rather than a credential leak.

  Owner decision, and deletion is not the obvious answer: removing it from `main`
  does not unpublish it (the 2026-08-02 lesson — a ref is not the objects), and
  it is a genuinely useful priming brief. The real options are (a) accept it as
  published and leave it, (b) keep it but strip the host/cron specifics to
  generic placeholders so future edits stop adding detail, or (c) move priming
  briefs out of the public repo entirely, which is the durable fix if more of
  them will carry deployment specifics.

  Note the operator's own convention already points at (c): TangleClaw's global
  rules put priming prompts at `<project>/.tangleclaw/priming/`, which is now
  gitignored here — this file predates that and sits in `.claude/priming/`.

- **[API-QRV3]** HTTP error bodies carry no stable machine-readable code
  `effort: M · impact: M · area: api-contract · source: reflection · added: 2026-08-02 · status: open · stage: design`

  Every error response is `{ error: "<human-readable message>" }` with the HTTP
  status carrying the semantics. Internal codes already exist and select the
  status — `SESSION_EXISTS` and the codes mapped to 404/409/410 in
  `bridge/v2/routes.js` — but they are dropped before the body is written. A
  third-party consumer that needs to distinguish two 409s (session already
  exists vs. wrong permission id) has nothing to branch on but prose, and is one
  message rewording away from breaking.

  Adding a `code` field is additive and safe today. It gets expensive later:
  every consumer that string-matches a message in the meantime makes any future
  rewording a breaking change. Cheap now, not cheap in a year.

- **[TST-RYHK]** No CI — every test level is manual
  `effort: M · impact: L · area: tooling · source: reflection · added: 2026-08-02 · status: open · stage: ready`

  There is no `.github/workflows/` directory. The only workflow this repo ever
  had was a stats counter, removed in `0c0a025`. So the 565-test suite, the
  regression suite guarding all 13 known bugs, and the contract tests all run
  only when a human remembers to run them — on a project whose primary fragility
  is that an upstream release can break it with no change on this side.

  There is also no linter and no formatter, which is why nearly every row in
  `project-preferences.md`'s norm index falls through to Critic rather than to a
  mechanical check.

  Fix shape: a workflow running `npm test` on push and PR (Node 18 + 22).
  `RUN_E2E=1` stays out of CI — it needs a real authenticated Claude Code
  binary. Optionally add eslint with a minimal ruleset to move the mechanical
  norms off Critic.

## Promoted

<!-- Items currently being addressed in an active build plan. /backlog pick
     skips these by default (work is already in flight). -->

## Archive

<!-- Shipped and dropped items, kept for searchability. Never deleted. -->

- **[SEC-PZ50]** No sensitive-data filtering on transcripts or text events
  `effort: L · impact: L · area: security · source: reflection · added: 2026-08-02 · status: shipped · closed-by: clean/prawduct-onboarding · reviewed: 2026-08-02`

  **RESOLVED 2026-08-02 (operator) — accept and document. No code change.**
  The behavior is unchanged; its governance status is not. Reasoning recorded in
  `security-model.md` G2 and stated for integrators in `README.md` § Security
  Posture: single-operator host daemon, anyone who can read a transcript already
  has host access, and a lossy transcript is worse than an unfiltered one at
  exactly the moment an incident investigation needs fidelity.

  The acceptance is **scoped** — it does not survive multiple mutually-untrusting
  callers or transcripts leaving the trust boundary they were produced in. Either
  flips `has_multiple_party_types` and re-opens this. Original finding below.

  `project-state.yaml` now records `handles_sensitive_data` with categories
  `credentials`, `source-code`, and `session-transcripts` — but nothing anywhere
  filters, redacts, or scopes that data. The event log stores raw PTY output
  verbatim, so any secret Claude Code prints (a `cat .env`, an echoed token, a
  key in an error message) is held in memory and returned in full to any holder
  of the single shared bearer token, via `/v2/session/transcript`, the
  `includeTranscript` export, and `/v2/session/output`.

  This is the largest gap between what the product handles and what it does
  about it. Not necessarily a defect — a single-operator host daemon may
  reasonably accept it — but it is currently an *unexamined* acceptance rather
  than a decision. Tracked as a high-priority open question in
  `project-state.yaml`.

  Fix shape (needs an owner decision first): decide whether to (a) accept and
  document the exposure explicitly in the README's security posture, (b) redact
  on read for known secret shapes, or (c) scope transcript access behind a
  second capability. Option (a) is free and may well be correct.

- **[API-T5ST]** Deprecation / compatibility policy — RATIFIED as a norm
  `effort: S · impact: M · area: api-contract · source: reflection · added: 2026-08-02 · status: shipped · closed-by: clean/prawduct-onboarding · reviewed: 2026-08-02`

  **RATIFIED 2026-08-02 by the operator**, as worded, **retroactive to 1.5.0**
  (the retroactive form was chosen over from-today-forward). Born `steady-state`,
  complete at birth: a sweep of `CHANGELOG.md` 1.5.0→1.9.1 found no `### Removed`,
  no `### Deprecated`, and no breaking marker — zero violations to migrate or
  grandfather.

  Home: `.prawduct/artifacts/api-contract.md` § Direction, with a pointer row in
  `project-preferences.md`'s Enforcement table (mechanism: Critic; audit home:
  advisory). `norm_registry_ratified` set in `project-state.yaml`. Original
  candidate and its drafting rationale below.

  Observed practice since 1.5.0 is consistent: every public-contract change has
  been additive with a backward-compatible default (`permissionMode`,
  `attachIfExists`, `consume`, `ptySpawnable`, `bridge`). Nothing has been
  removed or narrowed. That is a *pattern*, not a policy — no document says what
  a consumer can rely on, or what would happen if a breaking change became
  necessary.

  **Drafted, deliberately NOT self-ratified.** Norm ratification belongs to the
  owner. The candidate, for ratification or rejection as written:

  > *Statement:* Changes to `/v2/*` and to the tools-extension module interface
  > are additive and backward-compatible. New capability ships as an optional
  > field or export whose default preserves existing behavior. Removing or
  > narrowing either surface requires a new path-major version (`/v3`) or a new
  > interface version, never a minor or patch release.
  >
  > *Why:* the package is published to npm and consumed by deployments the
  > author cannot see, update, or roll back. A breaking change is unrecoverable
  > from this side.
  >
  > *Retroactivity:* describes existing practice — no existing code changes if
  > ratified.

  If ratified, it lands in `project-preferences.md` (the row is already present
  and flagged unratified) and in `design_decisions.api_versioning_approach`,
  whose `deprecation_policy` currently records the honest "not formally decided".

- **[DOC-QNX6]** CHANGELOG claims examples are covered by CI; nothing covers them
  `effort: S · impact: M · area: docs · source: reflection · added: 2026-08-02 · status: shipped · closed-by: clean/prawduct-onboarding · related: TST-RYHK · reviewed: 2026-08-02`

  **RESOLVED 2026-08-02 (steward ruling) — corrected the claim; the CI is
  separate work.** A changelog asserting CI that never existed is a false
  *description*, and descriptions track reality rather than binding it, so
  correcting it is maintenance and needed no operator ruling. Building the CI is
  genuinely different work — fixing a sentence must not turn into adopting a
  pipeline. Tracked at `TST-RYHK`.

  The claim is **struck in place with a dated correction** rather than deleted,
  so the record of what was asserted survives; a new `[Unreleased] ### Fixed`
  entry explains it. Original finding below.

  The 1.6.0 entry for `examples/orchestrator-driver.js` states the recipes
  "Track the bridge contract via in-repo CI (recipes break the build if the API
  drifts)." No CI exists (see TST-RYHK), and no test file references `examples/`
  at all — the directory appears only in `package.json`'s `files` array. The
  stated safety property is not merely unimplemented; it is asserted as fact in
  a shipped changelog.

  Two honest fixes, and the choice is the owner's: implement it (a test that
  executes the example against a live bridge and fails on drift — which would
  also give TST-RYHK something worth running), or correct the claim. Leaving a
  false safety claim in the changelog is the one option that is not acceptable,
  because a reader of `examples/README.md` is entitled to trust it.

- **[SEC-UTP4]** Auth fails OPEN when `BRIDGE_TOKEN` is unset, on a `0.0.0.0` bind
  `effort: S · impact: L · area: security · source: reflection · added: 2026-08-02 · status: shipped · closed-by: chunk-01-auth · related: EXP-9WQ2, CFG-3QK7 · reviewed: 2026-08-02`

  **FIXED 2026-08-02.** Startup refuses a tokenless configuration; the opt-in is
  exact-match `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true`; `checkAuth` returns the
  opt-in rather than a bare `true` so an unset token cannot widen authority even
  if the guard were bypassed; comparison is `crypto.timingSafeEqual` behind a
  length guard; `/health` reports `auth.required` and `insecure`. 20 regression
  tests in `bridge/__tests__/auth.test.js`. Critic `rev-20260803T000133Z-1918ce28`
  traced every path and found no defect in the security substance.

  `bridge/server.js:375` — `if (!TOKEN) return true; // no token = open (dev mode)`.
  `TOKEN` is `process.env.BRIDGE_TOKEN || ''` (line 45), so a missing `.env`, a
  typo'd variable, or a process launched without its environment silently
  disables authentication on **every** route. Nothing warns; nothing refuses to
  start; `/health` reports a healthy bridge.

  `bridge/server.js:854` binds `0.0.0.0`, not loopback. Together these mean a
  misconfigured bridge is an unauthenticated command-execution surface on the
  local network — on a product whose entire purpose is supervising what an agent
  is allowed to do to the host.

  The asymmetry is the point: `bridge/v2/policy.js` resolves every unmatched
  case to `require_review` because absent configuration must never widen
  authority. The auth layer resolves absent configuration to *allow*. One of
  these two is wrong, and it is not the policy engine. `README.md` already
  documents `BRIDGE_TOKEN` as "Required" — the code just does not enforce it.

  Also folded in: the token compare at line 378 is a plain `===` rather than
  `crypto.timingSafeEqual`, despite `node:crypto` already being imported at line
  333. Low severity on its own; free to fix while in the file.

  **DECIDED 2026-08-02 (operator) — option (a).** Refuse to start without a
  token unless an explicit, greppable env-var opt-in is set. Rejected: (b)
  loopback-only bind when tokenless, (c) warn and continue.

  Operator's reasoning, carried forward into the change: this makes the auth
  layer obey the rule the policy engine already follows — absent configuration
  must never widen authority — and `README.md:176` has listed `BRIDGE_TOKEN` as
  **Required** since before the code existed. So this closes a gap between the
  stated and actual contract rather than adding a new constraint.

  Implementation notes:
  - Name the opt-in so it cannot be set by accident and is trivial to grep for
    in a deployment audit. It must read as a deliberate choice, not a tuning knob.
  - Fold in the constant-time compare while in the file
    (`crypto.timingSafeEqual`; `node:crypto` is already imported at line 333).
  - Regression test alongside — this is a permanent invariant, so it belongs in
    the suite the way every other fixed bug does.

  **Treat as real work, not scaffolding**: read `/prawduct:methodology building`
  first, and run `/prawduct:critic` when done. A fail-open auth fix is exactly
  the shape of change where an independent pass earns its cost. Lands as its own
  cycle, separate from the onboarding PR.

  **Related: GitHub issue #15** — "[feature] Scoped bearer tokens — read vs write
  separation", still OPEN, and adjacent to this. Two notes on sequencing. First,
  this item is the smaller, unambiguous fix and should not wait on #15 — a token
  that fails open is broken regardless of how many scopes it eventually has.
  Second, #15 is not just a feature: shipping it flips
  `classification.structural.has_multiple_party_types`, which re-opens the
  single-privilege-tier reasoning in `security-model.md` and the scoped
  acceptance in `SEC-PZ50`. Both are recorded as resting on that characteristic
  being null.

  **Blocks the GitHub Issues cutover** — see the disclosure note at the top of
  this file. This repo is public and `@jason-vaughan/clawbridge` v1.9.1 is live on
  npm, so importing this item verbatim would publish an unpatched auth bypass.
  Fix first, migrate after.

- **[EXP-9WQ2]** `/exports/*` crashes the whole bridge on any successful download
  `effort: S · impact: L · area: security · source: critic · added: 2026-08-02 · status: shipped · closed-by: chunk-02-exports · related: SEC-UTP4 · reviewed: 2026-08-02`

  **FIXED 2026-08-02, in the same changeset that found it.** Not deferred: writing
  an unfixed vulnerability up in exploit-grade detail on a public repo is exactly
  what this changeset's own learning forbids, and Critic blocked on the
  contradiction. Fixing it turned the writeup into documentation of a closed bug.

  `const disposition = 'inline'` — the ternary was dead (both branches identical)
  and its condition referenced an undefined variable. New
  `bridge/__tests__/exports.test.js` (25 tests) covers the download, the listing,
  and the containment rules that were already correct. Verified the guard by
  reintroducing the defect: 3 tests fail, including the process-still-alive one.

  Both related gaps also closed: `EXPORTS_DIR` is now in the README env table,
  documented with the warning that the routes serving it are unauthenticated; and
  `/exports*` being public is recorded as a design fact in `security-model.md`
  boundary 1a rather than left implied. Original finding below.

  `bridge/server.js:653` references an undefined `ext`:

  ```js
  const disposition = ['.pdf','.png','.jpg','.jpeg','.svg'].includes(ext) ? 'inline' : 'inline';
  ```

  The only other `ext` bindings are local to `getContentType` (line 448) and the shutdown
  handler (line 954). The statement sits **before the auth check and outside the request
  `try/catch`**, so the `ReferenceError` is an uncaught exception in the HTTP server
  callback — it does not 500, it **terminates the process**.

  Verified: `GET /exports/report.txt` → `http_code=000`, log shows
  `ReferenceError: ext is not defined at bridge/server.js:653:76` and the daemon exits.

  Severity comes from the combination: `/exports/*` is unauthenticated by design, `GET
  /exports` (also unauthenticated) lists the filenames so discovery is self-service, and
  session state is in-memory so every live PTY session dies with the process. Under launchd
  `KeepAlive` it is a repeatable remote DoS rather than a one-shot.

  Why it survived: it fires only on a *successful* download. An empty or missing
  `EXPORTS_DIR` makes `realpathSync` throw first and the handler 404s.

  Fix: the ternary is dead — both branches are `'inline'` — so delete the expression:
  `const disposition = 'inline';`. Needs `bridge/__tests__/exports.test.js`, which does not
  exist; the route has **no coverage at all** today, which is why a crash on its happy path
  went unnoticed. Cover the download, the traversal/symlink rejections, and the listing.

  Two related gaps, same route: `EXPORTS_DIR` is undocumented (read at
  `bridge/server.js:90`, absent from the README env table — same class as `DOC-8B84`), and
  the unauthenticated `/exports*` surface was missing from `security-model.md`'s boundary
  table. The boundary table is fixed; the doc and the crash are this item.

- **[DOC-8B84]** README drift — stale test counts and an undocumented env var
  `effort: S · impact: S · area: docs · source: reflection · added: 2026-08-02 · status: shipped · closed-by: chunk-01-auth · related: EXP-9WQ2 · reviewed: 2026-08-02`

  **FIXED 2026-08-02.** Counts corrected and made mutually consistent across
  `README.md` and the maintainer guide (612 total across 24 files; 598 executed,
  14 e2e skipped; `bridge/v2/__tests__` is 512 across 18). `PROJECTS_DIR` added to
  the README env table alongside `CLAWBRIDGE_ALLOW_UNAUTHENTICATED`. A first pass
  introduced *new* contradictions between the two docs — caught by Critic; the
  numbers are now derived from the JUnit report per directory rather than eyeballed.
  `EXPORTS_DIR` was undocumented; it landed in the env table with `EXP-9WQ2`.

  Three small factual drifts found while reconciling:

  1. `README.md` Testing section says "516 across 20 files"; the actual suite is
     **565 total across 22 files — 551 executed, 14 e2e skipped by default, 0
     failures** (verified 2026-08-02 via a JUnit run, independently reproduced).
     Keep the existing "…skipped by default" framing when updating the numbers:
     a bare total reads as executed, and a skipped file is exactly the kind of
     thing that quietly becomes permanent.
  2. The File Structure block says `__tests__/  # 18 test files, 469 tests`, and
     `docs/bridge-v2-maintainer-guide.md` says "15 test files, 405+ tests" in two
     places. Both are stale by the same drift.
  3. `PROJECTS_DIR` is read by `bridge/server.js` and documented in the
     maintainer guide's operational section, but is **missing from the README's
     Environment Variables table** — the table a new operator actually reads.

  (3) is the one that costs someone an hour. Per `boundary-patterns.md`, the
  config interface has a standing rule: a documented variable must be read, and
  a read variable must be documented. `CLAUDE_BIN` failed the first half of that
  rule until 1.6.0; `PROJECTS_DIR` fails the second half now.

