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
