# Project Preferences

Developer preferences for how code is written in this project. Captured during discovery, updated as preferences evolve. Every session should read this before writing code.

> **Provenance.** Backfilled 2026-08-02 during discovery reconciliation by reading the
> existing codebase, `CLAUDE.md`, and `docs/bridge-v2-maintainer-guide.md` — not from an
> owner interview. Everything below is *observed practice* promoted to a stated preference.
> Where the observation was ambiguous it is marked **[INFERRED]** and is fair game to
> overrule.

## Language & Runtime

- **Language**: JavaScript (CommonJS, `'use strict'` at the top of every module). No TypeScript.
- **Version**: Node.js >= 18 (`engines` in package.json); developed and tested on v22.
- **Package manager**: npm (`package-lock.json` is committed).

## Code Style

- **Naming**: `camelCase` for functions and variables, `PascalCase` for classes (`Session`, `SessionManager`, `PermissionParser`), `SCREAMING_SNAKE_CASE` for module-level constants and regex patterns (`PROMPT_PATTERNS`, `CONFIRMATION_PATTERN`, `TERMINAL_STATES`). A leading underscore marks internal state (`_pendingDetection`, `_scan`).
- **Formatting**: No formatter configured. Observed house style: 2-space indent, semicolons, single quotes. **[INFERRED]** — match surrounding code rather than reformatting.
- **Linting**: None configured. See Enforcement below — this is why several preferences fall through to Critic instead of a linter.
- **Type annotations**: Not used. JSDoc carries the type information instead.
- **Imports**: `require` with the `node:` prefix for builtins (`node:http`, `node:path`), then local modules. Optional/native dependencies are loaded in a `try`/`catch` so a failure degrades loudly instead of crashing the process (`node-pty` in `bridge/v2/pty.js`).

## Testing

- **Framework**: vitest 3 (`npm test` → `vitest run`).
- **Style**: `describe`/`it` with full-sentence behavioral names. Tests assert observable behavior through the public surface — several suites spawn a real bridge subprocess and drive it over HTTP rather than reaching into internals.
- **Coverage expectations**: Happy path *and* error paths, and — non-negotiable here — **a named regression test for every known bug**. A fixed bug without a regression test is not fixed. Two indexes, by defect kind: `docs/bridge-v2-bug-index.md` maps every numbered v2 broker bug to its test, homed in `regression.test.js`; security defects carry an id rather than a number and are mapped from `.prawduct/artifacts/security-model.md` § Known gaps, each naming the guard that lives with the boundary it defends.

  `[DECISION: split the index by defect kind rather than routing security defects into the v2 broker bug index | 2026-08-03. The "every known bug is mapped" rule is unchanged and still binds — what changed is that it is now satisfied by two indexes instead of one. The prior wording named the broker index as the sole map, but the two security defects fixed before it (SEC-UTP4, EXP-9WQ2) were already recorded in the security model and never got numbers or rows, so the single-index wording described a practice the project was not following. Filing a server-level origin gate as numbered broker bug #14, with its test in regression.test.js rather than beside the auth boundary it guards, would have made the index less useful to the person it exists for. | RATIFIED by the owner 2026-08-03, put alongside the alternative of one index for everything; the split stands]`
- **Testing strategies**: Contract/subprocess testing for the HTTP and tools-extension surfaces; fixture-driven parsing tests that replay recorded PTY output; live end-to-end against a real Claude Code binary, gated behind `RUN_E2E=1`.
- **Test location**: Colocated `__tests__/` beside the code — `bridge/__tests__/` for the server surface, `bridge/v2/__tests__/` for the broker. Fixtures in `bridge/__tests__/fixtures/`.
- **Parallelization**: vitest defaults (no custom pool config). Full suite runs in ~6s.

### The rule that outranks the others

**Unit tests are necessary but not sufficient for the PTY surface.** Any change touching
parser logic, ANSI normalization, trust buffering, or PTY input timing requires **one live
E2E smoke run** before it is considered done. This is rollback norm 8 in the maintainer
guide, and it was earned across nine rounds of E2E where green unit tests hid live failures.

## Architecture Patterns

- **Data modeling**: Plain objects plus frozen enum objects in `bridge/v2/types.js`. No schema library, no ORM, no persistence.
- **Error handling**: Three layers, deliberately different — HTTP `{ error: "<message>" }` with the status carrying the semantics; structured `error` events on the session event log *plus* a stdout log line; and graceful degradation for optional subsystems. On the permission path specifically, every error and every unmatched case resolves to `require_review` — **fail-closed, always**.
- **Async**: `async`/`await` for lifecycle (startup, shutdown, extension calls); event callbacks for PTY data. Deliberate `setTimeout(500ms)` before any keystroke written in response to a permission — this is a correctness requirement, not a nicety (Bug #6).
- **File organization**: Layer modules under `bridge/v2/`, one responsibility each, with an explicit dependency order documented in the maintainer guide's module table (`types` ← `pty`/`parser`/`policy`/`event-log` ← `sessions` ← `routes` ← `server`). Keep it acyclic.

## Tooling

- **Key libraries**: `node-pty` is the only runtime dependency — keep it that way unless there is a strong reason; the dependency tree is a feature for a package operators install on their own machines. `vitest` is the only dev dependency.
- **Dev commands**:
  - `npm test` — full suite (E2E skipped)
  - `RUN_E2E=1 npm test` — includes live E2E; spawns real Claude Code sessions
  - `npm run test:watch` — watch mode
  - `npm start` — run the bridge (`node bridge/server.js`)
  - `curl -s http://localhost:3201/health | jq .` — verify a running bridge

## Workflow

- **Branching**: feature-branches — `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` prefixes. Direct commits to `main` only for trivial doc edits or incident hot-fixes.
- **Protected branches**: main
- **PR creation**: wait_for_user
- **PR merge**: wait_for_user
- **PR merge strategy**: squash — **overrides the prawduct default of merge-commit.** The operator's standing rules mandate `--squash` to keep `main` linear and CHANGELOG-friendly. Consequence, per prawduct's own warning: **branches are single-use.** Delete after merge, never reuse — a rewritten history strands a reused branch's merge-base and breaks the review gates.
- **Commit attribution**: co-authored — **overrides the prawduct default of none.** The operator's harness mandates a `Co-Authored-By` trailer on commits and a "Generated with Claude Code" line on PR bodies.
- **Issues**: GitHub Issues are the canonical home for deferred work. Link from PRs with `Fixes #N`. Note the open question in `project-state.yaml` about whether `.prawduct/backlog.md` or GitHub Issues is the single queue — running both is the failure mode to avoid.
- **Changelog**: every change updates `CHANGELOG.md` under `[Unreleased]`, in Keep a Changelog format. The subsection chosen drives the release bump, so pick it by user-visible impact.
- **Releases**: semver tag + GitHub Release with CHANGELOG-driven notes after a substantive merge.

---

**What belongs here**: How you want code written. Conventions, tools, style preferences, workflow preferences.

**What doesn't belong here**: What to build (product-brief), system design (data-model, architecture), performance targets (nonfunctional-requirements), or deployment (operational-spec).

## Enforcement

Each preference above should be enforced by one of three mechanisms — assign the mechanism when you add the preference so it doesn't quietly become aspirational.

| Mechanism | Where it lives | What it catches | Trade-off |
|---|---|---|---|
| **Linter** | Project's configured linter (ruff, eslint, swiftlint, etc.) | Mechanical style/naming rules | Best tool when configured. If no linter, preferences in this category fall through to Critic. |
| **Test** | `tests/preferences/test_*.py` (or equivalent) | Structural rules with named exceptions (AST checks, config-presence checks) | Bakes the rule into CI; refuses to be silent. Cost: re-validate when the rule's shape changes. |
| **Critic** | `/critic` review (Goal 4: Norms) | Judgment-required rules (semantic naming, "appropriate" anything, what counts as a "boundary") | No false-confidence test. Cost: requires reviewer per chunk; misses violations between reviews. |

> **This repo has no linter and no CI.** Every mechanical rule below therefore falls through
> to Critic, which catches violations only when a review runs. That is a real weakness, not a
> stylistic choice — it is filed as `TST-RYHK` in the backlog.

This per-preference table is the product's **norm index** (`/prawduct:methodology norms`): each row assigns a norm its **mechanism** (linter / test / Critic) and its **audit home** — `janitor` (only the deep sweep sees it) or `advisory` (a mechanical probe fires on it). A row may be a **pointer** to a `## Direction` section instead of restating the norm, and every norm carries its **why** (a whyless norm is unenforceable at its edges).

| Preference / norm | Mechanism | Enforcement artifact | Audit home | Why |
|---|---|---|---|---|
| Fail-closed permission evaluation — errors and unmatched cases resolve to `require_review`, never approval | Test | `bridge/v2/__tests__/policy.test.js` | advisory | Absent or broken configuration must never widen authority. A convenient failure mode on the safety mechanism defeats the product. |
| Every fixed bug gets a named regression test — numbered broker bugs mapped in `docs/bridge-v2-bug-index.md`, security defects in `security-model.md` § Known gaps | Test | `bridge/v2/__tests__/regression.test.js`, `bridge/__tests__/auth.test.js` | janitor | This surface regresses on someone else's release schedule. The index is the memory; without it, the same TUI change costs the same debugging twice. Split by kind so each guard sits with the boundary it defends. |
| Live E2E smoke run required for any parser / ANSI / trust-buffer / PTY-timing change | Critic | — (`RUN_E2E=1 npm test`, evidenced in the PR) | janitor | Proven across nine E2E rounds: green unit tests do not imply a working live PTY. Rollback norm 8. |
| Parser stays biased to false negatives — never widen matching for recall | Critic | — | janitor | A missed prompt stalls visibly; a spurious one injects a keystroke into the wrong context and corrupts silently. Root cause of bugs #5, #6, #10. |
| Cursor-right (`\x1b[\d*C`) strips to a **space**, never to empty | Test | `bridge/v2/__tests__/permission-parser.test.js` | janitor | Claude Code uses it as a token separator; stripping to empty concatenates tokens and breaks approval matching. Bug #11. |
| Liveness checks use `session.isTerminal`, never ad-hoc state comparison | Critic | — | janitor | Bugs #7 and #8 were both caused by checking for specific states instead of the terminal-state set. |
| Path access goes through `bridge/v2/path-safety.js` — no second implementation | Critic | — | janitor | Traversal/realpath/NUL rules must not drift between the v1 and v2 file surfaces. Security code wants one implementation. |
| A tools-extension failure never takes the broker down | Test | `bridge/__tests__/tools-extension.test.js` | janitor | The broker is the product; an optional add-on must not be able to degrade the primary capability. |
| norm lives in `api-contract.md` § Direction — additive, backward-compatible public contract changes | Critic | — | advisory | *(pointer row — the why lives in the Direction entry.)* Ratified 2026-08-02 from `API-T5ST`, retroactive to 1.5.0, steady-state. |
| Transcript exposure is an accepted, documented risk — not to be "fixed" by adding redaction without re-deciding | Critic | — | janitor | A transcript's value is being a faithful record; pattern-matched redaction on arbitrary terminal output is unreliable in both directions. Scoped to the current single-operator model — see `security-model.md` G2. |
| Every function carries a JSDoc comment | Critic | — | janitor | Stated as an enforced core rule in `CLAUDE.md`. No linter configured to check it, so it is Critic-only today. |
| `CHANGELOG.md` updated with every change | Critic | — | advisory | Stated as an enforced core rule in `CLAUDE.md`; also drives the release bump level. |
| Runtime dependencies stay minimal (`node-pty` only) | Critic | — | janitor | Operators install this on their own machines, and the process must not fail to boot. Every added dependency is a new way to fail at startup. |

**Rule for adding a new preference:** assign a mechanism. If the preference can be expressed as "every file/function/config matches pattern X with named exceptions" → write a test. If a linter rule already exists for it → configure the linter. If it requires understanding intent → assign to Critic. Never leave a preference unassigned.

**False-confidence guardrail:** if a generated test would pass on conforming code but couldn't reliably catch a real violation (e.g., greppy heuristics for semantic rules), prefer Critic over a weak test. A green test that doesn't actually check the rule is worse than no test.
