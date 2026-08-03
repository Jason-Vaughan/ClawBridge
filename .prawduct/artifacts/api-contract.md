# API Contract

Required because `classification.structural.exposes_programmatic_interface` is recorded
(`consumers: both`). **Two** surfaces, both public contracts.

## Direction

- **Changes to `/v2/*` and to the tools-extension module interface are additive and
  backward-compatible.** New capability ships as an optional field or export whose default
  preserves existing behavior. Removing or narrowing either surface requires a new
  path-major version (`/v3`) or a new interface version — never a minor or patch release.
  Why: the package is published to npm and consumed by deployments the author cannot see,
  update, or roll back, so a breaking change is unrecoverable from this side. Ratified
  2026-08-02 from candidate `API-T5ST`.
  Status: steady-state
  Retroactivity: retroactive to 1.5.0 — the guarantee covers every release from the one
  that introduced the extension contract onward. Complete at birth: a sweep of
  `CHANGELOG.md` 1.5.0→1.9.1 found no `### Removed`, no `### Deprecated`, and no breaking
  marker, so the norm codifies existing practice with zero violations to migrate or
  grandfather. Precedent it now binds: `permissionMode` (1.6.0), `attachIfExists` (1.7.0),
  `ptySpawnable` (1.8.0), `consume` (1.9.0), `bridge` (1.9.1) — each an optional addition
  defaulting to prior behavior.

### Recorded departure — 2026-08-02, the `BRIDGE_TOKEN` startup requirement

The norm above governs the **API surface contract**. Refusing to start without
`BRIDGE_TOKEN` is a breaking change for a tokenless deployment and does **not** comply with
it. That is a deliberate, recorded exception, not an oversight and not grounds for editing
the norm:

- The norm exists to protect consumers from *surprise*. It does not exist to preserve a
  state that endangers them — the prior behavior served every route unauthenticated on a
  `0.0.0.0` bind.
- A fail-open default is a defect, and `README.md` had documented `BRIDGE_TOKEN` as
  **Required** since before the code existed; the code was the side that disagreed.
- The escape hatch (`CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true`) is what keeps this honest: no
  deployment is left without a path forward, it just has to say so out loud.
- It ships marked `BREAKING`, so the version bump carries the cost visibly rather than
  arriving in a patch.

Recorded here rather than in the build plan, because plans are retired at merge and a norm
whose only recorded exception lives in a deleted file is a norm that will be misread next
time.

### Recorded departure — 2026-08-03, the cross-origin gate (`CRS-4T8K`)

Refusing cross-origin browser requests while the bridge runs without a token **narrows** what
a caller can do to `/v2/*`, so the norm above applies and this is a departure. Naming it
transport-level rather than contract-level would be the laundering move; it is recorded
instead.

Affected population: a browser page at a non-loopback origin driving an *unauthenticated*
bridge. Non-browser callers send neither `Origin` nor `Sec-Fetch-Site` and see no change at
all, and nothing changes when a token is set — so this narrows a real capability, but a
narrow one.

It meets the same four conditions that made the `BRIDGE_TOKEN` departure honest:

- The norm protects consumers from surprise, not from losing a state that endangers them. The
  prior behavior let a page the operator merely visited spawn agents and delete files on the
  host — `GET /v2/session/file?consume=true` unlinks, and a no-cors `GET` needs no preflight,
  no script, and no `Origin` header.
- The precondition the product *documented* for this mode ("no browser runs on this host")
  was never satisfiable by an operator. The docs were the side making a promise the code could
  not keep.
- `CLAWBRIDGE_ALLOWED_ORIGINS` is the path forward: any deployment that genuinely serves a
  browser UI against an open bridge names its origin and keeps working.
- It ships marked `BREAKING` in a major, so the cost is visible in the version rather than
  arriving in a patch.

**The norm itself is re-affirmed, not weakened.** Every recorded departure is a security fix
to a state that endangered consumers, each with an explicit escape hatch or migration and a
major version carrying the cost. None licenses a *feature* removal in anything but a
path-major — that remains the rule, and the next narrowing that is not a security fix does
not get to cite these.

`SEC-K4RD` — a destructive operation answering `GET` — was open at this point and is now
recorded below.

### Recorded departure — 2026-08-03, consuming reads move to `POST` (`SEC-K4RD`)

`GET /v2/session/file?consume=true` unlinked the file it returned. The consuming form now
requires `POST`; `consume=true` on a `GET` is refused with `405` and `Allow: POST`. This
narrows `/v2/*`, so the norm applies and this is a departure.

**This is the third recorded departure from this norm, and the second narrowing of `/v2`.**
That count is the thing worth justifying, not the change: a norm departed from repeatedly is
a norm on its way to not binding, and "it was a security fix" is available as an excuse to
almost anything if nobody is counting.

What makes this one hold up beyond judgment: **RFC 9110 §9.2.1 defines `GET` as safe.** The
prior behavior violated a guarantee every HTTP intermediary is entitled to rely on — link
unfurlers, prefetchers, proxies, scanners and crawlers all issue bare `GET`s — so no consumer
could *correctly* have depended on it, and several classes of software that never consented to
being consumers could trigger it. That is a narrower and more checkable claim than "we judged
the old behavior unsafe", which is what the other two departures rest on.

Known consumer: TangleClaw's degraded-wrap capture-back, the feature `consume` shipped for in
1.9.0. The migration is changing one method. `/v2/api-docs` describes both forms at runtime,
so a consumer discovers the change from the API itself rather than only from this file.

**Where the line now sits.** Three departures, all security, all in one major. A fourth should
be read as evidence the norm needs amending rather than departing from again — and amending it
is a decision to record deliberately, not something to arrive at by accumulating exceptions.

**Owner ruling, 2026-08-03.** All three departures were put to the owner together with the
alternative of amending the norm now to carve out security fixes, and the alternative of
pulling one back to `/v3`. The ruling is: **ratify the three as departures, leave the norm
unamended, and treat a fourth as the trigger to amend.** The carve-out was declined for the
reason that makes it tempting — it would remove the friction that forced each of these three to
be argued, and "is this a security fix?" is a judgment an author makes about their own change.
So the count stays the pressure gauge, and it is now a ratified position rather than three
unanswered `user can veto` notes.

## Canonical sources — do not duplicate them here

| Surface | Canonical spec |
|---|---|
| HTTP JSON API | `GET /v2/api-docs` — self-describing, treated as contract not documentation |
| Tools-extension module | `docs/tools-extension.md` — interface, six guarantees, non-goals |
| Route inventory (human) | `README.md` API Reference; `docs/bridge-v2-maintainer-guide.md` |

`README.md` is a *mirror* of api-docs and has drifted before — it was corrected against
api-docs in 1.6.0. When the two disagree, api-docs wins and the README is the bug.

## The three recorded decisions

Discovery requires versioning, deprecation, and error model to be *recorded decisions*,
because adding any of them later is breaking for every consumer.

### 1. Versioning — **decided**

Path-major on the broker surface (`/v2/*`), with v1 infrastructure routes (`/health`,
`/projects/*`, `/api/processes`) coexisting unversioned at the root; coexistence is tested
(`coexistence.test.js`). npm semver is the finer channel: additive → minor, fixes → patch,
each release explained in `CHANGELOG.md`.

Recorded in `project-state.yaml` as `api_versioning_decided` and
`design_decisions.api_versioning_approach`.

### 2. Deprecation / compatibility — **RATIFIED 2026-08-02**

See § Direction above. Ratified by the owner from candidate `API-T5ST`, retroactive to
1.5.0, as a `steady-state` norm: additive-only, backward-compatible defaults, and a
path-major bump for anything that removes or narrows either surface.

It stayed unratified through onboarding on purpose — inferring a policy from a consistent
pattern is how an unowned habit becomes canon. The pattern was evidence for the norm, never
the norm itself; the owner's declaration is what binds.

### 3. Error model — **decided, and weak**

`{ error: "<human-readable message>" }`, with the HTTP status carrying the semantics:

| Status | Meaning |
|---|---|
| 400 | Validation — missing/invalid `project`, `cursor`, `permissionId`, `decision`, `approvalEnvelope` |
| 404 | No such session, project, file, or permission |
| 409 | Conflict — `SESSION_EXISTS`, or a `permissionId` that is not the pending one |
| 410 | Gone — session is terminal |
| 500 | Internal, including a rejected `handleToolsRoute` |

Internal codes exist and select the status but are **not surfaced in the body**, so a
consumer distinguishing two different 409s has only prose to match on. Recorded as the
current state, not endorsed — see `API-QRV3`.

## Compatibility rules in force

- New capability ships as an **optional field with a default preserving today's behavior**.
  Precedent: `permissionMode` (1.6.0), `attachIfExists` (1.7.0), `consume` (1.9.0),
  `ptySpawnable` (1.8.0), `bridge` (1.9.1).
- **Cursor positions are a contract.** Consumers poll from a position; positions must stay
  stable and monotonic. Reordering or retroactively inserting events corrupts every
  in-flight reader.
- **Extension guarantees are contract, not implementation.** Changing *when* `init` runs
  relative to `listen()`, or letting an extension error reach the broker, breaks the
  contract without changing a signature.
- **Reserved namespaces.** An extension may not claim `/v2`, `/api/*`, `/health`, or
  `/projects`. The mount prefix is always `/tools` in v1.

### `GET /exports` shape change, 2026-08-02 (`EXP-9WQ2`)

`exports[].size` is now `number | null`; it is `null` when the entry could not be stat-ed.

**Assessed against § Direction, since a widened type looks like a narrowing for consumers.**
It is not one: before this change, every case that now returns `null` instead terminated the
process mid-request, so no consumer ever received a number there — or a response at all. The
norm protects behavior consumers could depend on, and there was none to depend on. Recorded
rather than waved through, because this is the first change tested against the norm since it
was ratified, and "obviously fine" is how a compatibility rule erodes.

### `/health` additions, 2026-08-02 (`SEC-UTP4`)

Additive, per § Direction — no existing field renamed, removed, or retyped:

- `auth: { required: boolean }` — always present.
- `auth.warning: string` and top-level `insecure: true` — present **only** when the bridge
  is running without authentication.

`ok` deliberately stays `true` in the open mode. `ok` means "the broker is serving", and the
repo already holds that line: the tools-extension contract states an extension failure never
flips root `ok`. Flipping it for an opt-in state would also page an operator about something
they explicitly asked for. Monitor on `insecure`, which exists to be alerted on.

### `/health` additions, 2026-08-03 (`CRS-4T8K`)

Additive, per § Direction — no existing field renamed, removed, or retyped:

- `cors: { mode: 'gated' | 'wildcard' }` — always present. `wildcard` carries a `reason`;
  `gated` carries `loopbackAllowed: boolean` and `additionalOrigins: string[]`.
- `cors.invalidOrigins: string[]` and `cors.warning: string` — present **only** when
  `CLAWBRIDGE_ALLOWED_ORIGINS` holds entries that are not serialized origins.

Reported in **both** modes on purpose. An absent key and a key reading `wildcard` are
different facts, and only one of them answers an operator asking whether this bridge is
gated — an inference from absence is exactly what this field exists to remove.

`additionalOrigins` lists only origins the gate will actually honour; anything unmatchable
appears under `invalidOrigins` instead. The two are disjoint, and the gate matches against the
same effective set it reports here — a health report that disagreed with the gate about who is
allowed in would be worse than no report, since an operator would act on it.

## OWASP API design review

The surface carries authentication and returns sensitive data, so the *design*-level checks
apply. Recorded honestly:

| Risk | Status |
|---|---|
| **Broken object-level authz (BOLA)** | **Not applicable as designed, by absence.** There is one privilege tier — any token holder may address any `project`. There are no per-object owners to confuse, because there are no owners. If a second tier is ever introduced this becomes the first thing to design. |
| **Broken authentication** | **Closed for the authenticated surface, 2026-08-02 (`SEC-UTP4`).** The bridge refuses to start without `BRIDGE_TOKEN`; the open mode requires an exact-match opt-in and is declared on `/health`. Comparison is constant-time. **Scope of that claim:** `/health`, `GET /exports`, and `GET /exports/*` are unauthenticated by design and are unaffected — see `security-model.md` boundary 1a. `/exports/*` additionally carried a process-killing crash, fixed 2026-08-02 (`EXP-9WQ2`). |
| **Excessive data exposure** | **Gap — `SEC-PZ50`.** Transcripts and `text` events return raw PTY output with no filtering. |
| **Mass assignment** | Low risk — request bodies are read field-by-field with explicit validation; no object merge into internal state. `attachIfExists` deliberately ignores the attaching call's `instruction`, `permissionMode`, `approvalEnvelope`, and timeouts rather than merging them. |
| **Lack of resources / rate limiting** | No rate limiting. Bounded instead by one-session-per-project, the prompt (5 min) and session (30 min) timeouts, and host capacity. Claude API spend is unmetered — noted in `project-state.yaml` cost estimates. |
| **Security misconfiguration** | This is `SEC-UTP4`'s actual class: the insecure state is the *default* when configuration is absent. |

## Foreign API

The Claude Code TUI is consumed, not exposed, and is not versionable from this side. Any
chunk touching it carries `**Foreign API:** Claude Code TUI` so the Critic's `verify-api`
check engages. See `boundary-patterns.md` §3.
