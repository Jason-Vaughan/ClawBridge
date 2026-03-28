# Bridge v2 Supervised Maintenance Trial

This is your first real maintenance run on the bridge v2 codebase. The goal is to prove the full supervised maintenance cycle end-to-end: inspect, patch, test, summarize.

## The task

**Fix the unhandled EPIPE errors in the bridge v2 test suite.**

When running `npm test`, the suite reports 2-4 "Uncaught Exception: Error: write EPIPE" errors. These come from writing to PTY stdin pipes after the child process has already exited. All 405+ tests pass, but Vitest treats unhandled exceptions as a test run failure (exit code 1).

### What you need to do

1. **Read the maintainer guide** at `docs/BRIDGE_V2_MAINTAINER_GUIDE.md` in your workspace — it has the full codebase map.

2. **Inspect the code.** The EPIPE errors originate from `bridge/v2/pty.js:write()` — it checks `this._exited` but the pipe can close before the exit event fires. Trace the callers:
   - `sessions.js` auto-approve/deny `setTimeout(500ms)` writes
   - `sessions.js` send() and end()
   - Test files that write to PTY after process exits

3. **Propose a fix.** The fix should:
   - Guard PTY writes against EPIPE (the pipe can close before `_exited` is set)
   - Not change the external API behavior
   - Not suppress errors that indicate real problems (only EPIPE on already-dead processes)
   - Preserve all existing test assertions

4. **Implement the fix.** Make the code changes.

5. **Run the test suite.** `npm test` must:
   - Still pass all 405+ tests
   - No longer report unhandled EPIPE exceptions
   - Exit code 0

6. **Write a change summary.** Before finishing, produce a summary of:
   - What you changed and why
   - Which files were modified
   - Test results (pass count, any regressions)
   - Your confidence that this is safe to deploy

### Constraints

- **Scope:** Only fix the EPIPE issue. Don't refactor, add features, or clean up unrelated code.
- **Files you may modify:** `bridge/v2/pty.js`, `bridge/v2/sessions.js`, and test files in `bridge/v2/__tests__/` if needed.
- **Files you must NOT modify:** `bridge/v2/permission-parser.js`, `bridge/v2/policy.js`, `bridge/v2/types.js` — these are not involved.
- **Rollback norm #1:** Run `npm test` before considering yourself done.
- **Rollback norm #6:** Produce a human-visible summary.

### What success looks like

- `npm test` exits 0 with 405+ tests passing and 0 unhandled errors
- The fix is minimal and obviously correct
- The change summary explains the reasoning clearly
- No regressions in any existing test

### What we're evaluating

This trial proves whether you can:
- Navigate the codebase using the maintainer guide
- Diagnose a real (not synthetic) issue
- Make a targeted fix without collateral damage
- Run and interpret the test suite
- Produce a deployable summary

This is a supervised trial. After you finish, we'll review the changes before deploying to habitat.

## How this works

This trial runs through the bridge v2 API on habitat. Start a v2 session for project `bridge-maintenance` — it contains a working copy of the bridge codebase with all tests. The bridge code is in `bridge/v2/` within that project directory.

**Important:** You MUST include the approval envelope below in your `POST /v2/session/start` request. Without it, all permissions default to `require_review` and file edits will be rejected if you don't respond to the review prompt in time.

```json
{
  "project": "bridge-maintenance",
  "timeout": 600000,
  "instruction": "Read docs/BRIDGE_V2_MAINTAINER_GUIDE.md first if it exists in the project, then fix the unhandled EPIPE errors in the test suite. The EPIPE comes from bridge/v2/pty.js write() — the pipe can close before _exited is set. Guard writes against EPIPE. Run npm test to verify 0 unhandled errors. Write a change summary when done.",
  "approvalEnvelope": {
    "mode": "scoped",
    "projectRoot": "/Users/habitat-admin/.openclaw/projects/bridge-maintenance",
    "rules": {
      "fileWrites": {
        "withinProject": "auto_approve",
        "outsideProject": "deny"
      },
      "fileDeletes": {
        "withinProject": "require_review",
        "outsideProject": "deny"
      },
      "shellCommands": {
        "allowlist": ["npm test", "npm run test", "node", "git status", "git diff", "git add", "git commit"],
        "allowlistPolicy": "auto_approve",
        "otherPolicy": "require_review"
      },
      "dependencyChanges": "deny",
      "networkAccess": "deny",
      "gitOperations": {
        "safe": "auto_approve",
        "destructive": "deny"
      },
      "configChanges": "require_review",
      "unknown": "require_review"
    },
    "defaults": {
      "lowRisk": "auto_approve",
      "mediumRisk": "require_review",
      "highRisk": "deny"
    }
  }
}
```

After you finish, we'll review the diff against the working copy, and if it looks good, apply it to the live bridge and mark the maintenance handoff as complete.

## Reference docs in your workspace

- `docs/BRIDGE_V2_MAINTAINER_GUIDE.md` — full codebase map
- `docs/BRIDGE_V2_REGRESSION_CHECKLIST.md` — the 12 bugs and what to check
