# Bridge v2 Full Prawduct E2E Test

**Purpose:** Validate the complete bridge v2 PTY broker workflow — from session start through permission handling to governance wrap-up. This exercises every phase of the autonomous prawduct build protocol through the v2 API.

**Cost warning:** Each run spawns real Claude Code sessions on habitat (Anthropic API spend). This is a **single deliberate invocation**, not an automated test. Run it once, review the results, done.

**Prerequisites:**
- Bridge v2 running on habitat port 3201
- No other active sessions (`GET /v2/sessions` returns empty array — ended sessions are filtered out by default)
- Auth token available (Bearer token from bridge `.env`)

---

## Instructions for OpenClaw

You are testing the bridge v2 PTY broker — the infrastructure that lets you drive Claude Code sessions with structured permission review. This test proves the full lifecycle works end-to-end.

**Bridge base URL:** `http://host.docker.internal:3201`
**Auth:** Include `Authorization: Bearer <your-token>` on all requests.
**Test project name:** `bridge-v2-smoke`
**Test project path on host:** `~/.openclaw/projects/bridge-v2-smoke`

### Before You Start

1. **Confirm no active sessions:**
```
GET /v2/sessions
```
Expected: `{ "ok": true, "sessions": [] }` (only active sessions are returned; ended sessions are filtered out by default)

If active sessions exist, stop. Do not proceed while another session is running.

2. **Confirm bridge health:**
```
GET /health
```
Expected: 200 with `claudeVersion` present.

---

## Phase 1: Session Start + Discovery

Start a PTY session. The approval envelope auto-approves file writes within the project and safe git operations, but requires your review for shell commands not in the allowlist. This is intentional — it tests both auto-approval and manual review paths.

```
POST /v2/session/start
{
  "project": "bridge-v2-smoke",
  "timeout": 600000,
  "instruction": "You are in a test project called bridge-v2-smoke. This is a minimal Node.js project to validate the bridge v2 PTY broker. Do the following:\n\n1. Initialize the project: create package.json with name 'bridge-v2-smoke', version '1.0.0', type 'module'\n2. Create src/add.js exporting a single function: add(a, b) that returns a + b\n3. Create src/add.test.js that tests add(2, 3) === 5 and add(-1, 1) === 0\n4. Run: git init && git add -A && git commit -m 'Initial scaffold'\n\nKeep it minimal. Do not install any npm packages. Use Node's built-in assert for tests.",
  "approvalEnvelope": {
    "mode": "scoped",
    "projectRoot": "/Users/habitat-admin/.openclaw/projects/bridge-v2-smoke",
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
        "allowlist": ["git init", "git status", "git diff", "git add -A", "git commit"],
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
      "unknown": "deny"
    },
    "defaults": {
      "lowRisk": "require_review",
      "mediumRisk": "require_review",
      "highRisk": "deny"
    }
  }
}
```

**Expected response:**
```json
{ "ok": true, "sessionId": "...", "state": "running", "cursor": 0 }
```

Save the `sessionId`. You will need it for reference but all subsequent calls use `project` not `sessionId`.

---

## Phase 2: Poll and Handle Permissions

Now enter a polling loop. Claude Code will start working and will trigger permission prompts for file writes (auto-approved) and possibly shell commands (require your review).

### Polling Loop

```
GET /v2/session/output?project=bridge-v2-smoke&cursor=0&waitMs=30000
```

**Process each response:**

1. **Read events.** Log them for your records. Text events show Claude Code's work. Lifecycle events show state transitions.

2. **Check for `pendingPermission` in the response.** If present and `state` is `waiting_for_permission`:

   - **If `permissionType` is `shell_command`:** Review the command. If it's a test runner (`node src/add.test.js`, `node --test`, etc.) or git command, approve it:
     ```
     POST /v2/session/respond
     {
       "project": "bridge-v2-smoke",
       "permissionId": "<id from pendingPermission>",
       "decision": "approve_once",
       "reason": "Test runner or safe project command"
     }
     ```
   - **If `permissionType` is `network_access` or `dependency_change`:** Deny it. The test project should not need external access.
     ```
     POST /v2/session/respond
     {
       "project": "bridge-v2-smoke",
       "permissionId": "<id from pendingPermission>",
       "decision": "deny",
       "reason": "Test project — no external access needed"
     }
     ```
   - **For anything else requiring review:** Use your judgment. Approve if it's clearly safe and project-local. Deny if uncertain.

3. **Advance cursor.** Use `cursorEnd` from the response as the next `cursor` value.

4. **Detect when Claude Code is done with the current task.** Claude Code runs in an interactive PTY — it does NOT exit after completing a task. It stays `running` at its prompt, waiting for more input. This is correct behavior.

   To detect task completion, look for these signals in the text events:
   - Claude summarizes what it did ("Created 3 files...", "Initialized git repository...")
   - The output stream goes quiet — consecutive polls return no new events or only UI refresh noise (spinner characters, status bar redraws)
   - You see the commit confirmation (`[main (root-commit) ...]`)

   **When you see these idle signals, move to Phase 3** — do NOT wait for a terminal state. Terminal states (`completed`/`failed`/`timed_out`) only occur when Claude Code exits, which doesn't happen during normal multi-turn use.

5. **If `state` is `waiting_for_permission`** — handle the permission (step 2 above), then continue polling.

6. **If `state` is `completed`, `failed`, or `timed_out`** — Claude Code exited unexpectedly. Skip to Phase 4 (session end) to clean up.

**Repeat** until Claude Code finishes its initial work (idle signals) or 5 minutes pass (whichever comes first).

---

## Phase 3: Verification Send

**Important:** Claude Code is still running in its interactive PTY — it did not exit. The session `state` is `running`. This is normal. You are now sending a follow-up instruction into the same session, just like a human would type at Claude Code's prompt.

Send a verification message:

```
POST /v2/session/send
{
  "project": "bridge-v2-smoke",
  "message": "Report what you created. List every file, its purpose, and confirm the tests pass. Run: node src/add.test.js"
}
```

**Expected:** `{ "ok": true, "accepted": true, "state": "running" }`

Then resume polling (same as Phase 2) from the cursor you left off at. Claude Code will:
1. Report the files it created
2. Try to run `node src/add.test.js` — this will trigger a `shell_command` permission prompt
3. The shell command `node src/add.test.js` is NOT in the approval envelope's allowlist, so the bridge will **pause** in `waiting_for_permission` state
4. You must approve it via `POST /v2/session/respond`
5. After approval, Claude Code runs the tests and reports results

This is the phase that exercises the **manual review** path. Watch for `state: "waiting_for_permission"` and `pendingPermission` in the output response.

Wait for Claude Code to go idle again (same signals as Phase 2 step 4) after reporting test results. Then proceed to Phase 4.

---

## Phase 4: Session End + Governance

Once Claude reports success (tests passed), end the session with transcript included:

```
POST /v2/session/end
{
  "project": "bridge-v2-smoke",
  "message": "Test complete. Commit any remaining changes and exit.",
  "includeTranscript": true
}
```

**Expected:** 200 with `state: "ended"` and a `transcript` field containing the full session output.

Save the transcript from the response. This is your audit trail.

**Note:** The transcript is included directly in the end response to avoid a separate `GET /v2/session/transcript` call. Session state is in-memory and doesn't survive bridge restarts, so fetching the transcript in the same call is more reliable.

Poll one final time to capture any remaining events (optional):
```
GET /v2/session/output?project=bridge-v2-smoke&cursor=<last-cursor>&waitMs=10000
```

---

## Phase 5: Transcript Export (Fallback)

If you didn't use `includeTranscript: true` in Phase 4, you can export the transcript separately — but only if the bridge hasn't restarted since the session ended:

```
GET /v2/session/transcript?project=bridge-v2-smoke
```

If this returns 404, the bridge likely restarted and the in-memory session was lost. This is expected — use `includeTranscript: true` in the end call to avoid this.

---

## Validation Checklist

After completing all phases, verify these outcomes:

### API Mechanics
- [ ] `POST /v2/session/start` returned 200 with sessionId and state `running`
- [ ] `GET /v2/session/output` returned events with sequential `seq` numbers
- [ ] Long-poll (`waitMs=30000`) worked — response waited for events rather than returning immediately empty
- [ ] `POST /v2/session/send` accepted a follow-up message mid-session
- [ ] `POST /v2/session/end` gracefully terminated the session and returned transcript (when `includeTranscript: true`)
- [ ] Transcript contains readable session output

### Permission Lifecycle
- [ ] At least one `permission` event appeared in the output stream
- [ ] File writes within project were auto-approved (no pause, no `waiting_for_permission` state)
- [ ] At least one permission required manual review (shell command not in allowlist)
- [ ] `POST /v2/session/respond` successfully resolved a pending permission
- [ ] After approval, session returned to `running` state

### State Machine
- [ ] Observed `starting` → `running` lifecycle transition
- [ ] Observed `running` → `waiting_for_permission` → `running` transition (if manual review occurred)
- [ ] Observed terminal state (`completed` or `ended`)

### Build Output
- [ ] `package.json` created in the test project directory
- [ ] `src/add.js` created with the add function
- [ ] `src/add.test.js` created with test cases
- [ ] Git repository initialized with at least one commit
- [ ] Tests passed (Claude Code reported success)

---

## Cleanup

After validation, the test project directory (`~/.openclaw/projects/bridge-v2-smoke`) can be deleted. It has no production value.

```bash
rm -rf ~/.openclaw/projects/bridge-v2-smoke
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| 409 on `/v2/session/start` | Session already exists for this project | End or wait for the existing session to finish |
| Polling returns empty events forever | Claude Code may be stuck on a permission prompt the bridge didn't detect | Check `/v2/session/status?project=bridge-v2-smoke` for state |
| `waiting_for_permission` but no `pendingPermission` in output | Cursor is behind the permission event | Poll from cursor 0 to catch up |
| Session times out | 10-minute timeout may be too short if Claude Code is slow | Restart with higher `timeout` |
| 403 on start | Project directory not under `~/.openclaw/projects/` | Verify project name matches |
| Permission auto-approved but you expected review | Approval envelope rule matched | Check which rule fired in the `policyEvaluation` field |
| 404 on `/v2/session/transcript` | Bridge restarted between end and transcript calls (in-memory state lost) | Use `includeTranscript: true` in the end request instead |
| `/v2/sessions` shows ended sessions | Use `?all=true` to see all sessions; default only shows active | Expected behavior — default filters to active sessions only |

---

## Results Template

After running, report results in this format:

```
## Bridge v2 E2E Test Results — [DATE]

**Session ID:** [id]
**Duration:** [start to end time]
**Final State:** [completed/failed/timed_out]

### Events Summary
- Total events: [N]
- Text events: [N]
- Permission events: [N] (auto-approved: [N], manual review: [N], denied: [N])
- Lifecycle transitions: [list]

### Validation Checklist
[Copy checklist above, mark each item pass/fail]

### Transcript
[Attach or summarize key sections]

### Issues Found
[Any problems encountered, with details]
```
