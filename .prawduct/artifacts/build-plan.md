# Build Plan — the documented install path routes around the auth guard

**Work type:** bugfix (security) · **Size:** small · **Critic mode:** final

Small by diff (one config file, one message block, README, one test file), but it touches
`bridge/server.js` — a declared risk surface — and it closes a hole in the control shipped
in 2.0.0-pending. Stakes, not size, set the rigor.

## Requirements Confidence: **High**

1. **What problem are we solving?** **Both** documented install paths ship a working token,
   and both are released. `bridge/.env.example` ships `BRIDGE_TOKEN=changeme` (README
   Quickstart step 2 says to copy it), and `README.md`'s own paste-able env block ships
   `BRIDGE_TOKEN=replace-me`. The startup guard added for `SEC-UTP4` checks that a token is
   **present**, and both literals are present. So either path produces a bridge that starts
   successfully, authenticated by a credential published verbatim in this repository, on a
   `0.0.0.0` bind with wildcard CORS — and nothing complains, because from the guard's
   perspective the install is correctly configured.

2. **What does success look like?** Copying `.env.example` and starting the bridge fails
   with the FATAL block rather than succeeding with a weak token, and that block tells the
   operator how to generate a real one. A test asserts the example cannot regress into
   shipping a guard-satisfying value.

3. **What's out of scope?** Token *strength* validation at runtime (rejecting short or
   low-entropy tokens) — that is a real feature with real false-positive risk, and it is not
   what makes the current state a defect. The defect is that we ship the weak value
   ourselves. Also out: CORS narrowing (`CRS-4T8K`), and any postinstall output — npm buries
   it, and the two moments an operator actually reads are the file they copy and the error
   that stops them.

**Requirement provenance:** raised as a Critic note during the `SEC-UTP4` review
("`.env.example` still ships `BRIDGE_TOKEN=changeme` — presence is now enforced, strength is
not") and not acted on then; re-surfaced by the operator asking how a new installer learns
they need a token.

## Design decisions

**D1 — Ship `BRIDGE_TOKEN=` empty rather than a placeholder.** Any placeholder that parses
as a value satisfies the guard. An empty value makes the documented path lead *into* the
FATAL message, which turns the guard into the onboarding step instead of an obstacle to
route around. Rejected: a value like `REPLACE_ME` — still starts the bridge.

**D2 — Put the generate command in both places.** In `.env.example` as a comment (read at
configure time) and in the FATAL block (read at failure time, possibly by a different person
at 3am). Duplication is correct here: they are different moments and different readers.

**D3 — Test the behavior, not the file's text.** Parse `.env.example`, feed its variables to
a spawned bridge as the process environment, and assert it refuses to start. A grep-for-
`changeme` test would pass against any future weak placeholder; this one asserts the
property that actually matters.

## Consumer impact

None for running deployments — `.env.example` is a template, not read at runtime. A fresh
installer following the README now hits a deliberate stop with instructions instead of an
accidental success.

### Chunk 01: Close the documented path around the auth guard

**Deliverables**

- `bridge/.env.example` — empty `BRIDGE_TOKEN`, generate-command comment, and the two
  token types distinguished
- `bridge/server.js` — FATAL block names how to generate a token
- `README.md` — Quickstart step 2 and the env table distinguish the invented secret
  (`BRIDGE_TOKEN`) from the issued one (`CLAUDE_CODE_OAUTH_TOKEN`)
- `bridge/__tests__/auth.test.js` — the example cannot ship a guard-satisfying value
- `CHANGELOG.md` — `### Security` entry

**Done when:** a bridge spawned from *any* documented sample's variables refuses to start,
and the test fails if `BRIDGE_TOKEN` in any of them is given a value — including one that is
only non-empty because of a trailing comment. Both released samples (`changeme` in the
example, `replace-me` in the README) are covered by the same enumeration, and the operator
is told to rotate if they configured from either.

## Status

- [x] Chunk 01: Close the documented path around the auth guard

## Done when

- Full suite green, including the new regression test
- The FATAL block and `.env.example` both carry a generate command
- `CHANGELOG.md` records it under `### Security`
- `/prawduct:critic` run and blocking findings resolved
