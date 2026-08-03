# Security Model

Authored 2026-08-02 during discovery reconciliation. This is the first time ClawBridge's
security posture has been written down in one place — the README states a *position* (what
the safety model is not), and the code implements *mechanisms*, but nothing reconciled the
two. Doing so surfaced three gaps; a fourth was found later while self-reviewing the
`SEC-UTP4` fix. All four are recorded below.

## What this product is defending

ClawBridge lets a remote caller drive an AI agent that has **shell and filesystem access on
the operator's host machine**. The permission broker is the defense. Everything else here
is in service of the property that a caller cannot cause an action the operator did not
authorize.

## Trust boundaries

| # | Boundary | Crossing | Control |
|---|---|---|---|
| 1 | Network → bridge | Orchestrator HTTP request | Bearer token on every route except those in 1a |
| 1a | Network → bridge, **unauthenticated** | `GET /health`, `GET /exports`, `GET /exports/*` | **None, by design.** Path/symlink containment on `/exports/*` only |
| 2 | Caller → host actions | A permission Claude Code raises | Approval envelope, evaluated fail-closed |
| 3 | Caller → host filesystem | `/projects/*/files/*`, `/v2/session/file` | `bridge/v2/path-safety.js` — traversal / realpath / NUL |
| 4 | Bridge → extension | `/tools/*` request | Bridge auth is **ordered** first, always; no per-route opt-out. Ordered ≠ enforcing — in the unauthenticated mode there is nothing to check and the extension is exposed |
| 5 | Bridge → Claude Code | Spawn + keystrokes | `CLAUDE_BIN`, `isAllowedDir`, headless token auth |

Boundary 2 is the product. Boundaries 1, 3, and 4 exist to make it meaningful.

## Authentication & authorization

- **AuthN**: a single shared bearer token (`BRIDGE_TOKEN`) checked in
  `bridge/server.js:checkAuth`. The bridge refuses to start without it (G1). `/health` is
  deliberately unauthenticated so an orchestrator can discover the bridge before holding
  credentials; `/exports` and `/exports/*` are too, which is less obviously deliberate — see
  boundary 1a and G4.
- **AuthZ**: **none.** There is one privilege tier. Any holder of the token can do anything
  the API allows, to any project. This is why
  `classification.structural.has_multiple_party_types` is recorded as null — recording it
  would imply isolation the product does not have.
- **Agent auth**: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Never keychain
  (GUI-session-scoped, fails under launchd/SSH) and never subscription credentials (banned
  for third-party tools by Anthropic in Jan 2026; `setup-token` is the permitted developer
  path). Both a functional and a compliance constraint — see `project-state.yaml` scope
  `never`.

## The stated non-goal, restated so it is not misread

Per `README.md`: ClawBridge's safety model is **structured permission review of one CLI
tool's actions**, not network-level isolation. It is not a sandbox, not a jail, and not a
security boundary between an untrusted orchestrator and the host. An operator who needs
that must supply it at the network layer. Anyone deploying ClawBridge as if it were a
containment boundary has misread it.

## Known gaps

G1-G3 came from reconciling the code against the stated posture; G4 came from self-review
during the G1 fix. None were introduced by this onboarding. G1 and G3 are fixed, G2 is an
owner-accepted risk, and G4 is filed and open.

### G1 — Auth fails OPEN when the token is unset · **FIXED 2026-08-02** · `SEC-UTP4`

**Resolved.** The bridge now refuses to start without `BRIDGE_TOKEN`, exiting non-zero
before `listen()` with a message naming both the required variable and the escape hatch.
`CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` — exact match only, so no truthy spelling enables
it by accident — starts it anyway, but `/health` then reports `insecure: true` with
`auth.required: false`, and every boot logs a warning. `checkAuth` returns the opt-in flag
rather than a bare `true`, so an unset token cannot widen authority on its own even if the
startup guard were ever bypassed. Token comparison is now `crypto.timingSafeEqual` behind a
length guard (closes G3). Regression coverage: `bridge/__tests__/auth.test.js`, 20 tests.

The description below is retained as the record of what was wrong and why it mattered.

---

`bridge/server.js:375` (pre-fix):

```js
if (!TOKEN) return true; // no token = open (dev mode)
```

`TOKEN` is `process.env.BRIDGE_TOKEN || ''` (`bridge/server.js:45`). A missing `.env`, a
typo'd variable name, or a process started without its environment yields `''` → falsy →
**every route is unauthenticated**. Nothing warns, nothing refuses to start, and `/health`
reports a perfectly healthy bridge.

Compounding it, `bridge/server.js:854` binds `0.0.0.0` — all interfaces, not loopback. A
bridge started without its token is an unauthenticated command-execution surface reachable
from the local network.

This contradicts the fail-closed discipline the rest of the product is built on: the policy
layer resolves every unmatched case to `require_review`, while the auth layer resolves an
unconfigured case to *allow*. The stricter half guards a door the outer half leaves open.
`README.md` marks `BRIDGE_TOKEN` "Required", but nothing enforces it.

### G2 — No sensitive-data filtering · **RESOLVED 2026-08-02: accepted, documented** · `SEC-PZ50`

`text` events and transcripts store raw PTY output verbatim. Anything the agent prints — a
`cat .env`, an echoed key, a token in a stack trace — is held in memory and returned in full
to any token holder. See `data-model.md`.

**Owner decision: accept, and say so.** The behavior is unchanged; its governance status is
not. The reasoning, recorded so a future session does not relitigate it from scratch:

- This is a single-operator host daemon. Anyone holding the bearer token already has an API
  that spawns an agent with shell access to the machine those secrets live on — redaction
  would guard the window while the door stands open.
- A transcript's value is being a **faithful record of what actually happened**. Redaction
  makes it a lossy one, and lossy exactly where an incident investigation needs fidelity.
- Pattern-matched redaction on arbitrary terminal output is unreliable in both directions:
  it misses novel secret shapes and mangles legitimate output. A half-working filter invites
  more trust than none at all.

Now stated in `README.md` § Security Posture, so an integrator meets it before deploying
rather than after. **This acceptance is scoped to the current deployment model** — it does
not survive multiple mutually-untrusting callers, or transcripts crossing the trust boundary
they were produced in. Either of those flips
`classification.structural.has_multiple_party_types` and re-opens this entry.

### G3 — Token comparison is not constant-time · **FIXED 2026-08-02** · folded into `SEC-UTP4`

Was `auth === \`Bearer ${TOKEN}\``, an ordinary string comparison. Now
`crypto.timingSafeEqual` over byte buffers, behind a length guard (the primitive throws on
unequal lengths). The guard leaks only the header's length, which its own transmission
already reveals; the byte comparison is what must not leak a prefix match.

### G4 — `/exports/*` unauthenticated + process crash · **crash FIXED 2026-08-02** · `EXP-9WQ2`

Found while self-reviewing the `SEC-UTP4` fix, then fixed in the same changeset rather than
shipped as a written-up open vulnerability on a public repo — the rule this changeset itself
records in `learnings.md`. Item 3 is closed; items 1 and 2 stand as recorded design facts.

**Item 3 resolution, in two parts.** The first fixed the instance: `const disposition =
'inline'` — the ternary was dead (both branches identical) over an undefined variable.

The second closed the **class**, after Critic pointed out that removing one deterministic
throw left the structural property intact. Both `/exports` handlers run before the auth
check, so they cannot sit inside the main request `try` (that opens after auth, and moving
them there would make the routes private) — and every fs call in them is synchronous. An
uncaught throw in an `http.createServer` callback is not a 500; it ends the process. Other
reachable triggers survived: `EACCES` on an unreadable file (**verified**: `PROCESS DEAD`,
the port stopped answering) and TOCTOU `ENOENT` on a file rotated away mid-request. Both
handlers now carry their own `try/catch` returning 500, and the listing tolerates a single
unstattable entry rather than failing wholesale.

Coverage: `bridge/__tests__/exports.test.js`, 16 tests. Both guards verified by
reintroducing the respective defect — 3 tests fail without the `ext` fix, 1 without the
EACCES guard.

The three problems as found:

1. **It is unauthenticated by design** (`bridge/server.js:628`, "no auth — read-only,
   public"), serving files from `EXPORTS_DIR` (default `$HOME/exports`). `GET /exports`,
   also public, lists the filenames. This artifact previously implied `/health` was the only
   unauthenticated route; that was wrong, and boundary 1a now records it.
2. **`EXPORTS_DIR` was undocumented** *(fixed)* — read at `bridge/server.js:90`, absent from
   the README env table. An operator cannot restrict what they do not know is being served.
   Now documented, with the warning that the routes serving it require no token.
3. **A successful download crashed the whole bridge.** *(fixed)* `bridge/server.js:653` references an
   undefined `ext`; the statement sits before the auth check and outside the request
   `try/catch`, so the `ReferenceError` is an uncaught exception that terminates the
   process. Verified: `http_code=000`, `ReferenceError: ext is not defined`, daemon dead.
   Unauthenticated, self-service (the listing supplies the filename), and it destroys every
   live session because session state is in-memory. Under `KeepAlive` it is a repeatable
   remote DoS. It survived because it fires only on a *successful* download — an empty
   `EXPORTS_DIR` 404s first.

Containment that does hold: traversal, absolute-path, NUL, and symlink-escape checks are all
present and correct on the route.

## Accepted risk — pre-fix disclosure residue (2026-08-02)

While `SEC-UTP4` was still unfixed, a branch documenting it in exploit-grade detail
(file:line refs, the literal fail-open line) was pushed to this public repo and the branch
deleted about a minute later. **The deletion removed the ref, not the objects.** All three
commits remain fetchable by SHA from GitHub, and no git operation available to this project
can withdraw them; only a GitHub Support purge could, and the operator declined it.

**Accepted knowingly.** The acceptance rests on two independently verified facts, and on
neither the deletion nor the short window:

1. **The objects are still reachable** — `gh api repos/Jason-Vaughan/ClawBridge/commits/<sha>`
   returns 200 for each. Assume the content is retrievable indefinitely.
2. **The SHAs were never published** — the repo's public events feed carries no `PushEvent`
   for that push, so retrieval requires knowing a 40-hex value that was never advertised.
   The repo also has zero watchers. Limits of that check, stated so it is not oversold: the
   events API is a recent-window feed rather than a complete record, third-party archives
   mirror events independently, and anyone who fetched during the window keeps their copy.

Discoverability is therefore low but non-zero, and it does not self-heal. What makes the
residue acceptable is that **the vulnerability is now fixed** — a reachable writeup of a
closed bug is documentation, not disclosure. That is the same standard applied to G2: an
examined acceptance, with its reasoning recorded, rather than an unexamined one.

**Revisit if either fact changes.** Do not let this be remembered as "the branch was
deleted, so it was fine" — that sentence was believed for an hour and it was false.

The generalizable rule is recorded in `learnings.md`: on a public repo, fix before
documenting, or write findings at severity-without-reproduction and keep the reproduction
local until the fix ships.

## What is done well (so it does not get regressed)

- **Fail-closed policy evaluation.** No envelope ⇒ everything requires review. Unmatched
  rule ⇒ `require_review`. Never approval.
- **One path-validation implementation**, shared by the v1 and v2 file surfaces
  specifically so the rules cannot drift (1.9.0).
- **Auth precedes extension dispatch**, without exception — an extension cannot declare a
  public sub-route in v1.
- **`isAllowedDir`** constrains session working directories to `PROJECTS_DIR`,
  `PRAWDUCT_DIR`, or the bridge directory.
- **Parser biased to false negatives** — a missed prompt stalls visibly rather than firing a
  keystroke into the wrong context.

## Review triggers

Re-read this artifact when: a file in `risk_surfaces` changes; a new route reads the
filesystem; the extension contract gains per-route auth; or a second privilege tier is
introduced (which would flip `has_multiple_party_types` and re-open authorization design
entirely).
