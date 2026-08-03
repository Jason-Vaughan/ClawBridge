# Operational Spec

Required because `classification.structural.runs_unattended` is recorded
(`trigger: always-on`).

**Canonical sources — not duplicated here:**
- `README.md` → Deployment (launchd plist, systemd unit, Docker access), Environment Variables
- `docs/bridge-v2-maintainer-guide.md` → Operational reference, common operations, **rollback norms**
- `docs/bridge-v2-regression-checklist.md` → what to verify after any change

This artifact records the operational *contract*: what must be true, and what must happen
when it isn't.

## Deployment model

Long-lived Node process on the host, supervised by launchd (`com.clawbridge.builder`,
`KeepAlive`) on macOS or systemd (`Restart=always`) on Linux. Config from `bridge/.env`,
read once at boot. Binds `0.0.0.0:$BRIDGE_PORT` (default 3201).

Deploy is **incremental by norm**: scp changed files, restart, verify — never replace the
whole directory, and always keep the previous copy of any changed file for rollback
(maintainer guide rollback norms 3 and 5).

## Preconditions that must hold before it works

Each of these has failed in production at least once, which is why each is checkable:

| Precondition | How to verify | Failure signature |
|---|---|---|
| Claude Code installed and reachable at `CLAUDE_BIN` | `claude` field on `/health` | Session spawn fails; stdout logs exit code + last output |
| Headless auth configured (`claude setup-token`) | session actually starts | Keychain auth silently unavailable under launchd/SSH |
| `node-pty` loaded | `ptyMode: "pty"` (not `pipes-fallback`) | Sessions start then fail immediately; pipes cannot drive a TUI |
| `spawn-helper` present **and executable** | `ptySpawnable: true` | `posix_spawnp failed` — this is #16, self-healed at boot since 1.8.0 |
| `BRIDGE_TOKEN` set | `auth.required` on `/health`; the process refuses to start otherwise | Exit 1 before `listen()` with a message naming the variable and the override |
| Running authenticated | `insecure` absent from `/health` | `insecure: true` means the bridge is serving every route openly |
| Correct build deployed | `bridge` field on `/health` | Fixes appear not to land |

Every precondition above is now observable on `/health`, including the one guarding the
security boundary — that row used to read "nothing verifies this" (`SEC-UTP4`, fixed
2026-08-02).

**New failure mode to recognize: a respawn loop.** Because the bridge now exits rather than
starting unauthenticated, a deployment whose environment lost `BRIDGE_TOKEN` will be
restarted forever by launchd `KeepAlive` / systemd `Restart=always`. The signature is a
service that never reaches "listening" and a log full of the `FATAL: BRIDGE_TOKEN is not
set.` block. That is the intended behavior — loud and stopped beats quiet and open — but it
looks like a crash loop, so triage should read the message rather than assume a bad build.

## Release procedure

1. `npm test` — all 598 executed must pass (612 total; 14 e2e skipped). A failure blocks
   the deploy, full stop.
   **On a host with a real `bridge/.env`:** the auth suite refuses to run if that file
   defines `BRIDGE_TOKEN` or `CLAWBRIDGE_ALLOW_UNAUTHENTICATED`, because the loader would
   backfill them into deliberately-tokenless test cases (`CFG-3QK7`). Move the file aside
   for the run. The failure message says so.
2. If the change touches parser / ANSI / trust buffering / PTY timing: **one live E2E smoke
   run** (`RUN_E2E=1 npm test`). Rollback norm 8 — unit tests are declared insufficient
   here, and that was earned across nine E2E rounds.
3. Walk `docs/bridge-v2-regression-checklist.md`.
4. Update `CHANGELOG.md` under the subsection matching user-visible impact (it drives the
   version bump).
5. Write the human-visible summary — a reviewer should understand the change without reading
   the diff (rollback norm 6).
6. Deploy incrementally; restart via `launchctl stop com.clawbridge.builder` (KeepAlive
   relaunches).
7. Verify `/health`: `bridge` version is the new one, `ptySpawnable: true`,
   `v2ActiveSessions: 0`, `auth.required: true`, and **no `insecure` key**. The last two
   are the ones a deploy can silently get wrong — an environment that lost `BRIDGE_TOKEN`
   now refuses to start, but one carrying `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` starts
   wide open and looks otherwise healthy.
8. Tag `vX.Y.Z`, push, and cut a GitHub Release from the CHANGELOG.

## Rollback

Keep the prior copy of every changed file. To roll back: scp the `.bak` back, restart, and
re-verify `/health`. Because state is entirely in-memory there is no data migration to undo
— rollback is a file swap and a restart, which is the one upside of having no persistence.

## Routine operations

```bash
launchctl stop com.clawbridge.builder                 # restart (KeepAlive relaunches)
curl -s http://localhost:3201/health | jq .           # health + version + pty status
curl -s -H "Authorization: Bearer $TOKEN" \
     http://localhost:3201/v2/sessions | jq .         # active sessions
npm rebuild node-pty                                  # after a posix_spawnp failure
```

## Incident triage

Start from the signal, not the code. Every entry maps to a documented failure mode:

| Symptom | First check | Likely cause |
|---|---|---|
| Session stuck `RUNNING`, no permission event | Was Claude Code updated? | Prompt or menu format changed — fragility #1/#2 |
| Approvals behave as denials | Keystroke semantics upstream | Fragility #3 |
| Chaotic first seconds, false permissions | Trust-prompt wording changed | Fragility #4 — the 2 KB valve flushed into the parser |
| Intermittent detection failures | PTY chunk boundaries | Fragility #5 — reproduce before changing the parser |
| Session never completes | Nothing is broken | Claude Code does not self-terminate — fragility #6 |
| `posix_spawnp failed` | `ptySpawnable` on `/health` | Exec bit lost after boot-time heal |
| Sessions start then die instantly | `ptyMode` | Running in `pipes-fallback` |
| Everything works without a token | `insecure` on `/health` | `CLAWBRIDGE_ALLOW_UNAUTHENTICATED=true` is set. A deliberate opt-in, not a breach — but confirm it was deliberate *here*, and that the port is genuinely unreachable by others |
| Service restarts forever, never listens | the `FATAL:` block in the log | `BRIDGE_TOKEN` missing from the service environment. Set it; do not reach for the override to stop the loop |
| Bridge dies on an `/exports` request | the stack trace in the log, then the bridge version | `EXP-9WQ2` fixed the `ext` ReferenceError **and** wrapped both handlers, so a recurrence is a *new* uncaught throw in pre-auth code, not the old bug. Do not stop at "must be a pre-fix build" — read the trace. These two handlers run outside the main request try/catch, so anything that throws there ends the process |

**When in doubt on the parser, do not "fix" it from a hypothesis.** The bias to false
negatives is deliberate; overeager matching caused bugs #5, #6, and #10. Reproduce, add a
regression test, then change.

## Not implemented

No alerting, no metrics backend, no log rotation, no automated restart-on-health-failure
beyond process supervision, no CI (`TST-RYHK`). For a single-host operator daemon this is
the accepted floor — recorded so it is a decision rather than an oversight.
