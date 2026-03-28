# Bridge v2 Regression Checklist

Use this as a quick regression reference after any bridge v2 PTY broker change.

## Test Scope Guidance

**Can be covered well by unit/integration tests:**
- PTY text normalization and ANSI stripping
- permission prompt parsing/classification
- target extraction/path attribution
- session state accounting/filtering (`/v2/sessions`, health active counts, terminal-state overwrite rules)
- send/end input encoding (`\r` vs `\n`)
- parser reset/cooldown behavior

**Still needs live PTY E2E confirmation:**
- timing-sensitive approval delivery into Claude Code’s interactive UI
- trust/startup buffering interactions with real PTY chunking
- send/submit behavior against the live Claude prompt
- full multi-turn lifecycle: scaffold -> idle -> send -> manual review -> approve -> test run -> end

---

## 1) Permission target misattribution
- **What broke:** Permission events pointed at the wrong file.
- **How it manifested:** A write to `src/add.js` or `src/add.test.js` was reported as targeting `package.json`.
- **Root cause:** Parser reused stale buffer/context and matched the wrong target from older PTY content.
- **What to check:** Consecutive file-write prompts emit the correct `target.path` for each file, especially when multiple writes happen back-to-back.

## 2) `/v2/sessions` returning ended sessions
- **What broke:** Active-session listing included ended sessions by default.
- **How it manifested:** Preflight check expected an empty list, but `/v2/sessions` returned historical ended sessions.
- **Root cause:** Session listing endpoint was not filtering to active sessions by default.
- **What to check:** `GET /v2/sessions` returns only active sessions; ended/completed sessions appear only via explicit opt-in such as `all=true` if supported.

## 3) Trust buffer swallowing early permission prompts
- **What broke:** Early permission prompts were buffered and discarded before the parser saw them.
- **How it manifested:** Claude reported `Error writing file` for early writes like `package.json` / `src/add.js`; no actionable permission event appeared.
- **Root cause:** Startup trust-prompt buffering stayed active too long when no trust prompt actually appeared, swallowing early PTY output.
- **What to check:** If Claude starts directly in a trusted workspace, early file-write permissions are still parsed and acted on; startup buffering flushes into the parser instead of discarding content.

## 4) Confirmation pattern too narrow for interactive menus
- **What broke:** Parser only recognized old-style confirmation prompts.
- **How it manifested:** Visible Claude menu prompts with numbered options were not detected as permissions.
- **Root cause:** Confirmation matcher only handled patterns like `Allow?`, `Do you want to allow`, or `(y/n)`, but not modern interactive menus.
- **What to check:** Parser recognizes Claude menu-style prompts such as numbered `1. Yes / 2. Yes, allow all / 3. No`, `Do you want to create/edit/delete`, and `Esc to cancel` variants.

## 5) Duplicate unknown permission from menu remnants after reset
- **What broke:** One real permission was followed by a bogus second permission classified as `unknown`.
- **How it manifested:** A valid file-write prompt was auto-approved, then trailing menu remnants were parsed again and denied as `unknown`, causing Claude to say `User rejected write...`.
- **Root cause:** Parser reset cleared the main prompt state, then trailing fragments from the same menu re-entered parsing and hit the unknown fallback.
- **What to check:** After resolving a permission, trailing menu redraw/remnant text does not emit a second permission event; cooldown or equivalent suppression prevents false reparse.

## 6) Auto-approve sent before interactive menu rendered
- **What broke:** Approval keystroke arrived before Claude’s menu was ready.
- **How it manifested:** Permission looked auto-approved, but Claude stalled or failed to proceed after writes/commands.
- **Root cause:** Bridge sent `Enter`/`Esc` immediately on detection, before the interactive PTY menu was fully rendered and able to receive input.
- **What to check:** Auto-approve/deny paths include enough delay for the live menu to render; file writes and git commands actually proceed after the decision event.

## 7) `start()` blocking on completed sessions
- **What broke:** New runs were blocked even though the prior session was terminal.
- **How it manifested:** `POST /v2/session/start` returned `409 Conflict` for a project whose prior session had already completed.
- **Root cause:** `start()` only allowed overwrite/restart from `ENDED`, not other terminal states like `COMPLETED`.
- **What to check:** Starting a session on a project with a prior terminal session works for all terminal states, not just `ENDED`.

## 8) `activeCount` counting completed sessions as active
- **What broke:** Health/status said there was an active session when there was not.
- **How it manifested:** `/v2/sessions` returned no active sessions, but `/health` still reported `v2ActiveSessions: 1`.
- **Root cause:** Active-count logic used `state != ENDED` instead of a proper terminal-state check.
- **What to check:** Health/session counts treat `COMPLETED`, `ENDED`, `FAILED`, and other terminal states as inactive; `/health` and `/v2/sessions` agree.

## 9) `send()` / `end()` using `\n` instead of `\r`
- **What broke:** Messages were inserted into Claude’s prompt but not submitted.
- **How it manifested:** Follow-up text appeared in the PTY input area, but Claude did not act on it; end message also failed to submit reliably.
- **Root cause:** Bridge wrote newline (`\n`) instead of carriage return (`\r`), but Claude’s TUI requires Enter semantics.
- **What to check:** `send()` and `end()` submit input into the live PTY prompt so Claude actually processes the message, not just displays it in the editor/input box.

## 10) False permission detection on tool-call announcements
- **What broke:** Parser treated Claude’s tool-call announcement as if it were the real permission prompt.
- **How it manifested:** Bridge auto-confirmed too early and Claude responded with `Error writing file` before any real confirmation menu appeared.
- **Root cause:** Parser triggered on `Write(...)` / tool-call text plus cursor/menu-like fragments even when no actual confirmation prompt was present yet.
- **What to check:** Tool-call announcements alone do not emit permission events; parser waits for an actual confirmation pattern before acting.

## 11) ANSI cursor-right stripping eating spaces in command arguments
- **What broke:** Parsed shell command lost spaces between tokens.
- **How it manifested:** `node src/add.test.js` became `nodesrc/add.test.js`, causing approval logic to deny what should have been approved.
- **Root cause:** ANSI cursor-right sequences like `\x1b[1C` were stripped to empty string instead of being converted into spaces before normalization.
- **What to check:** Command normalization preserves token boundaries; `node src/add.test.js` and similar commands survive ANSI cleanup with spaces intact.

## 12) Trust prompt misclassified as unknown permission after safety valve
- **What broke:** Starting a v2 session on a new/untrusted project triggered immediate session interruption.
- **How it manifested:** OpenClaw's supervised maintenance trial was blocked at startup — the trust prompt ("Yes, I trust this folder" / "Esc to cancel") was treated as an unknown permission and auto-denied.
- **Root cause:** Claude Code's startup ANSI output exceeded the 2KB safety valve threshold before the trust prompt rendered. Safety valve fired, set `trustPromptHandled=true`, flushed buffer to permission parser. When the trust prompt arrived, "Esc to cancel" matched `CONFIRMATION_PATTERN`, no `PROMPT_PATTERNS` matched → emitted `unknown` → policy denied.
- **What to check:** Starting a v2 session on a new/untrusted project directory auto-confirms the trust prompt without triggering a permission event; the safety valve threshold (now 8KB) + grace period (5s) handles late-arriving trust prompts.

---

## Minimum Live Smoke Expectations

After bridge changes, a live PTY E2E smoke run should still prove all of the following:
- scaffold file writes auto-approve and succeed
- git init/add/commit auto-approves and succeeds
- scaffold completion is detectable from idle/summary signals
- follow-up `send()` is actually submitted to Claude
- `node src/add.test.js` triggers `waiting_for_permission`
- manual approval succeeds and tests run
- Claude reports `All tests passed.`
- `end(includeTranscript: true)` exits cleanly and returns transcript
