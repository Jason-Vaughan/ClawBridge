# Learnings

Accumulated wisdom from building this product.

## On a public repo, fix before documenting a vulnerability
<!-- prawduct-learning: confirmations=1; created=2026-08-02 -->

Writing a finding into a tracked file is itself a publication step on a public repo. It
does not become public at push time — it becomes *reachable by one routine command* at
commit time, and `git push` is the most reflexive command there is.

**Rule:** while a vulnerability is unfixed in a public repo, either fix it before
documenting it, or write the finding at **severity-without-reproduction** level (what class
of defect, how bad, where it is tracked) and keep file:line refs and the exploitable
mechanism in a local note until the fix ships.

**The rule attaches to writing the mechanism down, not to the release checklist.** Added
2026-08-03 after breaking this rule *one commit after deliberately applying it*. The release
sequence was reordered on purpose — `npm publish` before `git push`, so the fix for the 1.9.1
defects was available before their recipes went public — and then, minutes later, a newly-found
defect (`CRS-8N3P`, unfixed in both published versions) was written into `.prawduct/backlog.md`
with file:line refs and its mechanism, and pushed to the same public repo.

The rule was salient while making a big, obviously-security-shaped decision, and invisible
during a routine backlog write. So the trigger cannot be "when releasing" — it has to be **at
the moment you type a mechanism or a file:line for a defect that is not yet fixed in what
users can install**, whatever file you are typing it into. Backlog entries, plan bodies and
review findings all reach the public repo the same way source does. Ask: *is this fixed in
what npm serves right now?* If not, severity-without-reproduction, and the mechanism goes in a
local note.

**And: branch deletion is not redaction.** Deleting a remote branch removes the ref, not
the objects. Commits stay fetchable by SHA on GitHub until a server-side GC you cannot
trigger and that has no published schedule. Once pushed, no git operation available to you
withdraws it. The commit is the point of no return; the push is only when it becomes
someone else's copy.

**How this was learned:** during the 2026-08-02 Prawduct onboarding, `SEC-UTP4` (a
fail-open auth path) was written up with file:line detail and pushed to this public repo
while still unfixed. A subagent had already flagged that importing the same text into
public GitHub Issues would be unsafe; the same reasoning was not applied to the branch. The
branch was deleted, which was believed to close the exposure and did not. See the accepted-
risk record in `artifacts/security-model.md`.

## Absent configuration must never widen authority
<!-- prawduct-learning: confirmations=1; created=2026-08-02; sentinel=bridge/__tests__/auth.test.js -->

`bridge/v2/policy.js` has always resolved an absent approval envelope to `require_review`.
`bridge/server.js` resolved an absent `BRIDGE_TOKEN` to *allow*. Both are "what do we do
when the operator told us nothing", and only one of them was answered correctly — the
stricter half was guarding a door the outer half left open.

**Rule:** when adding any configuration that gates authority, ask what happens when it is
absent, and make absence the *most* restrictive outcome. If an unconfigured state must
remain usable, it takes an explicit, exact-match opt-in that reads as a decision in a
deployment audit — never a truthy default.

**Corollary — `!x` is not `x === undefined`.** The same empty-vs-absent conflation appears
twice in `bridge/server.js`: in `checkAuth` (fixed), and in the `.env` loader, where
`if (!process.env[key])` silently overrides a variable a caller deliberately set to the
empty string (still open — `CFG-3QK7`). Empty is a statement; absent is a question.

The loader instance was fixed in the same commit and then **reverted** on Critic review: it
changes precedence for every key, it was outside the chunk's stated scope, and the line
cannot execute in CI (the `.env` it reads is gitignored), so no test could guard it. A
correct drive-by fix in a security change is still an unplanned behavior change — the
second lesson is about scope, not about `!x`.

## An unattended daemon must make degraded states visible, not just survive them
<!-- prawduct-learning: confirmations=2; created=2026-08-02 -->

This product keeps relearning one lesson. `ptyAvailable: true` masked a total-failure mode
for an entire release (#16) because the native binding loaded fine while every session died
— the fix was not only the exec-bit heal but *adding a signal that distinguishes the two
states* (`ptySpawnable`). Session spawn failures were logged only to the event log until
1.6.0, "leaving operators blind". And `/health` reported a healthy service while
authentication was disabled entirely.

**Rule:** nobody reads stdout on a launchd service at 3am. A degraded state must be
distinguishable from a healthy one **through `/health` alone**, and a state that endangers
the host must prevent startup rather than warn. When adding a capability, ask what its
absence looks like to a remote operator — if the answer is "the same as working", add the
signal in the same change.

Applied in `SEC-UTP4`: refuse to start rather than warn, and surface `insecure: true` /
`auth.required: false` on `/health` for the opt-in case.

## Verify against the claim, not against the change

<!-- prawduct-learning: confirmations=1; created=2026-08-02 -->

A check derived from the same understanding that produced the change cannot detect that the
understanding was too narrow. Both come out narrow together, and green means nothing. This
is not a "remember to be thorough" rule — it is a rule about *where the check comes from*.

**Three mechanics, in order of how much they caught:**

1. **Falsify, don't confirm.** Whenever you claim a guard exists, break the thing it guards
   and watch the check go red. A test that has never failed has never been tested. This is
   one command and it is the highest-yield habit on this list.

   **But falsifying a too-narrow check only proves the check is narrow.** On 2026-08-03 a
   test was written for the `.env.example` sample, watched to fail, watched to pass — and
   the identical defect shipped in the README's env block, because the test pinned the file
   in mind rather than the property. So after the red-green step, ask the second question:
   *does the scope of what I just falsified match the scope of what I am about to claim?*
   If the claim is "no documented sample hands out a token" then the check enumerates the
   samples; if it is "this file is clean" then say only that. The fix is usually to
   enumerate rather than to name — and to add a meta-assertion that the enumeration found
   something, so a changed filename or fence tag cannot leave it green while checking
   nothing.
2. **Check the sentence you are about to write, not the action you took.** "The branch is
   deleted" and "the content is unreachable" are different claims needing different probes.
   Take the literal words of the report and ask what would falsify *them*.
3. **After finding one instance, grep for the shape before declaring the class closed.** A
   reproduction that reproduces feels like completeness. It is evidence about one path.
4. **Enumeration has an axis, and aiming it wrong feels identical to aiming it right.** Added
   2026-08-03 after three instances in a single work cycle. Building the cross-origin gate I
   enumerated *routes* and checked each was still reachable — a real enumeration, non-empty
   meta-assertion, properly falsified, six tests red on demand. Worthless: the defect lived on
   **request shape**, and every one of those six sent an `Origin` header. The shape that
   mattered was the no-cors `GET` (`<img src>`), which sends none, and which was the easiest
   attack in the threat model the change was named for. Later the same cycle, the
   malformed-allowlist check enumerated one spelling — a trailing slash — that no browser can
   send, and so missed `null`, which browsers really do send; that entry was reported to
   operators as inert while the gate honored it.

   So after "did I enumerate?" ask **"over what?"** — and take the axis from the *claim*, not
   from the code in front of you. "No cross-origin browser request can reach a handler" ranges
   over the ways a browser can issue a request, not over which routes exist. If the axis can't
   be named in one phrase, the claim is still too vague to test.

**How this was learned:** four times in the 2026-08-02 session, an independent reviewer
caught the same failure — the specific thing done and reported as the general thing.
Deleted a remote branch and called the exposure closed (deletion removes the ref, not the
objects — still fetchable by SHA). Wrote a learning forbidding exploit-grade writeups of
unfixed bugs on public repos, then wrote one into the same changeset. Fixed the one
`ReferenceError` in `/exports` and called the crash fixed, leaving `EACCES` and TOCTOU
reachable through the identical uncaught-throw path. Wrote a test named for a stat-failure
guard that never made a stat fail.

The tell in all four: empirical verification *was* run each time. Mechanic 1 was applied on
two of the fixes and proved them; the one place it was skipped is exactly where the
worthless test survived. That is the control working when used and the defect appearing when
not.

**The moment of highest risk is the moment something passes** — the pull to report
completion peaks exactly where checking stops. Treat a clean independent review as the
surprising outcome, not the expected one. See "On a public repo, fix before
documenting a vulnerability" above for the incident that produced the first instance.
