# Bridge v2 Bug Index

Quick reference for bugs #1–12. Each links to the regression test that guards against it.

| # | Title | Fixed in | Regression test(s) |
|---|-------|----------|-------------------|
| 1 | Permission target misattribution (stale buffer) | `permission-parser.js` (bottom-up scan) | `regression.test.js` → "Bug #1" (2 tests) |
| 2 | `/v2/sessions` returning ended sessions | `routes.js` (active-only filter) | `regression.test.js` → "Bug #2" (2 tests) |
| 3 | Trust buffer swallowing early permission prompts | `sessions.js` (flush on tool-call detection) | `regression.test.js` → "Bug #3" (1 test) |
| 4 | Confirmation pattern too narrow for interactive menus | `permission-parser.js` (CONFIRMATION_PATTERN) | `regression.test.js` → "Bug #4" (8 tests) |
| 5 | Duplicate unknown permission from menu remnants | `permission-parser.js` (2s cooldown after reset) | `regression.test.js` → "Bug #5" (2 tests) |
| 6 | Auto-approve sent before menu rendered | `sessions.js` (500ms setTimeout) | `regression.test.js` → "Bug #6" (1 test) |
| 7 | `start()` blocking on completed sessions | `sessions.js` (isTerminal check) | `regression.test.js` → "Bug #7" (4 tests) |
| 8 | `activeCount` counting terminal sessions | `sessions.js` (isTerminal iteration) | `regression.test.js` → "Bug #8" (5 tests) |
| 9 | `send()`/`end()` using `\n` instead of `\r` | `sessions.js` (\r for TUI submission) | `regression.test.js` → "Bug #9" (2 tests) |
| 10 | False permission on tool-call announcements | `permission-parser.js` (require confirmation) | `regression.test.js` → "Bug #10" (5 tests) |
| 11 | ANSI cursor-right eating spaces in arguments | `permission-parser.js` (cursor-right → space) | `regression.test.js` → "Bug #11" (5 tests) |
| 12 | Trust prompt misclassified after safety valve | `sessions.js` (8KB valve + 5s grace period) | `regression.test.js` → "Bug #12" (3 tests) |
| 13 | Unhandled EPIPE on dead stdin pipe | `pty.js` (stdin error handler + write guard) | Verified by full suite: 0 unhandled errors |
