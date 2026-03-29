# Bridge v2 PTY Permission-Broker Spec

**Status:** Implemented (2026-03-24)
**Audience:** ClawBridge implementers, OpenClaw orchestration layer, NHE-ITL reviewer
**Goal:** Replace blanket `bypassPermissions` execution with interactive Claude Code PTY mediation, structured permission review, and resumable polling.

---

## 1. Overview

Bridge v2 runs Claude Code in an interactive PTY-backed session on the host instead of using one-shot non-interactive `--print` execution. The bridge becomes a broker between:

- **Claude Code** running on the host in a PTY
- **The NHE-ITL** (the reviewing agent) making permission decisions
- **The project workspace** managed under prawduct governance

Primary objectives:

1. Remove blanket permission bypass for builder sessions
2. Allow the NHE-ITL to review permission requests at the action level
3. Preserve persistent session memory and governance lifecycle
4. Support resumable polling without requiring inbound callbacks
5. Allow safe session-level policy envelopes to reduce unnecessary review churn

This spec assumes **polling-first** operation. Callback delivery is explicitly out of scope for v2.

---

## 2. Design Principles

1. **Polling over callback:** avoid inbound reachability, webhook auth, retry semantics, and callback delivery state.
2. **Structured events over raw prompt text:** the bridge may parse Claude output internally, but external consumers receive normalized event objects.
3. **Session-local approval policy:** safe actions within the approved project scope should be auto-resolved when covered by the approval envelope.
4. **Human/agent review for medium/high-risk actions:** actions outside envelope or outside approved scope pause execution pending review.
5. **Cursor-based output retrieval:** clients can recover from disconnects and resume reading session output.
6. **Fail closed on ambiguous writes outside project scope:** when the bridge cannot classify an action confidently, require explicit review.

---

## 3. Core Concepts

### 3.1 Session
A PTY-backed Claude Code process associated with exactly one project.

### 3.2 Output Event Log
An append-only, cursor-addressable event stream containing text chunks, lifecycle markers, permission events, decisions, and terminal status.

### 3.3 Pending Permission Event
A single unresolved permission request that blocks PTY progress until resolved, timed out, or the session dies.

### 3.4 Approval Envelope
A session-level default policy describing which action classes may be auto-approved, escalated, or denied.

---

## 4. Session Lifecycle State Machine

### 4.1 States

- `starting` — bridge is spawning PTY and launching Claude Code
- `running` — Claude Code is executing normally
- `waiting_for_permission` — bridge detected a permission request that requires review
- `completed` — Claude Code exited normally
- `failed` — Claude Code or bridge session failed unexpectedly
- `ended` — bridge performed explicit shutdown / governance wrap-up and cleaned session state
- `timed_out` — session exceeded configured runtime timeout

### 4.2 Transitions

```text
starting -> running
starting -> failed

running -> waiting_for_permission
running -> completed
running -> failed
running -> timed_out

waiting_for_permission -> running        (decision submitted)
waiting_for_permission -> failed         (PTY dies / broker error)
waiting_for_permission -> timed_out      (prompt wait timeout or session timeout)

completed -> ended                       (cleanup performed)
failed -> ended                          (cleanup performed)
timed_out -> ended                       (cleanup performed)
```

### 4.3 Behavioral Notes

- Only one unresolved permission event may block the session at a time.
- The bridge MUST store enough state to recover polling after transient client disconnects.
- `ended` means session resources are released and no further PTY interaction is possible.

---

## 5. Structured Permission Model

### 5.1 Permission Event Format

```json
{
  "id": "perm_017",
  "kind": "permission",
  "createdAt": "2026-03-25T00:16:00Z",
  "sessionId": "sess_abc123",
  "project": "my-project",
  "rawPrompt": "Allow write to src/routes/jobs.ts? [1/2/3]",
  "permissionType": "file_write",
  "risk": "low",
  "requiresResponse": true,
  "withinProject": true,
  "target": {
    "path": "src/routes/jobs.ts"
  },
  "action": {
    "summary": "Write file src/routes/jobs.ts",
    "details": null
  },
  "policyEvaluation": {
    "matchedRule": null,
    "suggestedDecision": "approve_once",
    "reason": "Project-local file write within approved root"
  },
  "timeoutAt": "2026-03-25T00:21:00Z"
}
```

### 5.2 Supported `permissionType` Values

- `file_write`
- `file_delete`
- `shell_command`
- `network_access`
- `dependency_change`
- `git_operation`
- `config_change`
- `unknown`

### 5.3 Risk Levels

- `low`
- `medium`
- `high`

### 5.4 Target Object by Type

#### File write/delete
```json
{ "path": "src/jobs/executor.ts" }
```

#### Shell command
```json
{ "command": "npm install better-sqlite3", "cwd": "~/.openclaw/projects/my-project" }
```

#### Network access
```json
{ "host": "registry.npmjs.org", "port": 443, "protocol": "https" }
```

#### Dependency change
```json
{ "manifest": "package.json", "packages": ["better-sqlite3"] }
```

### 5.5 Classification Rules

The bridge SHOULD normalize Claude Code prompts into structured types when possible. If exact classification is impossible, emit:

```json
{
  "permissionType": "unknown",
  "risk": "high",
  "withinProject": false
}
```

and require explicit review.

---

## 6. Approval Envelope Format

The client may attach a session-level approval envelope when starting a session or updating policy mid-session.

### 6.1 Envelope Schema

```json
{
  "mode": "scoped",
  "projectRoot": "~/.openclaw/projects/my-project",
  "rules": {
    "fileWrites": {
      "withinProject": "auto_approve",
      "outsideProject": "require_review"
    },
    "fileDeletes": {
      "withinProject": "require_review",
      "outsideProject": "deny"
    },
    "shellCommands": {
      "allowlist": [
        "npm test",
        "npm run test",
        "npm run build",
        "npm run lint",
        "npm run typecheck",
        "vitest",
        "vitest run",
        "git status",
        "git diff",
        "git add -A",
        "git commit"
      ],
      "allowlistPolicy": "auto_approve",
      "otherPolicy": "require_review"
    },
    "dependencyChanges": "require_review",
    "networkAccess": "require_review",
    "gitOperations": {
      "safe": "auto_approve",
      "destructive": "require_review"
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
```

### 6.2 Policy Actions

- `auto_approve`
- `require_review`
- `deny`

### 6.3 Recommended Default Envelope

For chunk-based builds, recommended defaults are:

- auto-approve project-local file writes
- auto-approve allowlisted test/build/git inspection commands
- require review for deletes, dependency changes, config changes, non-allowlisted shell commands, and all writes outside project root
- deny unknown high-risk actions by default

---

## 7. Endpoints

All endpoints require:

```http
Authorization: Bearer <token>
```

All JSON responses SHOULD include:
- `ok` boolean
- `project`
- `sessionId` when applicable

### 7.1 POST /session/start

Start a fresh PTY-backed Claude Code session for a project.

#### Request
```json
{
  "project": "my-project",
  "cwd": "~/.openclaw/projects/my-project",
  "timeout": 1800000,
  "approvalEnvelope": {
    "mode": "scoped",
    "projectRoot": "~/.openclaw/projects/my-project",
    "rules": {
      "fileWrites": {
        "withinProject": "auto_approve",
        "outsideProject": "require_review"
      },
      "fileDeletes": {
        "withinProject": "require_review",
        "outsideProject": "deny"
      },
      "shellCommands": {
        "allowlist": ["npm test", "npm run build", "git status", "git diff", "git add -A", "git commit"],
        "allowlistPolicy": "auto_approve",
        "otherPolicy": "require_review"
      },
      "dependencyChanges": "require_review",
      "networkAccess": "require_review",
      "gitOperations": { "safe": "auto_approve", "destructive": "require_review" },
      "configChanges": "require_review",
      "unknown": "deny"
    },
    "defaults": {
      "lowRisk": "require_review",
      "mediumRisk": "require_review",
      "highRisk": "deny"
    }
  },
  "instruction": "Re-verify chunk 1 and report status."
}
```

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "running",
  "createdAt": "2026-03-25T00:16:00Z",
  "cursor": 0
}
```

#### Errors
- `409` if an active session already exists for the project
- `400` invalid request
- `500` PTY spawn failure

---

### 7.2 POST /session/send

Send a normal instruction into an existing running session. Does NOT auto-start sessions — returns 404 if none exists.

#### Request
```json
{
  "project": "my-project",
  "message": "Execute chunk 2 from project-state.yaml. Run tests before stopping."
}
```

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "running",
  "accepted": true,
  "cursor": 12
}
```

#### Errors
- `404` no active session
- `409` session not in a writable state (e.g. waiting for permission)
- `410` session already ended

---

### 7.3 GET /session/status?project=NAME

Return current session metadata.

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "active": true,
  "sessionId": "sess_abc123",
  "state": "waiting_for_permission",
  "startedAt": "2026-03-25T00:16:00Z",
  "lastActivity": "2026-03-25T00:18:42Z",
  "cursor": 27,
  "pendingPermissionId": "perm_017",
  "timeoutAt": "2026-03-25T00:46:00Z"
}
```

---

### 7.4 GET /session/output?project=NAME&cursor=N

Cursor-based polling endpoint for incremental output and structured events.

#### Request Parameters
- `project` (required)
- `cursor` (required, integer, 0-based event offset)
- `waitMs` (optional, long-poll max wait)
- `maxEvents` (optional)

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "waiting_for_permission",
  "cursorStart": 20,
  "cursorEnd": 24,
  "hasMore": false,
  "events": [
    {
      "seq": 21,
      "kind": "text",
      "timestamp": "2026-03-25T00:18:38Z",
      "stream": "stdout",
      "text": "Need to update src/routes/jobs.ts\n"
    },
    {
      "seq": 22,
      "kind": "permission",
      "timestamp": "2026-03-25T00:18:39Z",
      "event": {
        "id": "perm_017",
        "kind": "permission",
        "createdAt": "2026-03-25T00:18:39Z",
        "sessionId": "sess_abc123",
        "project": "my-project",
        "rawPrompt": "Allow write to src/routes/jobs.ts? [1/2/3]",
        "permissionType": "file_write",
        "risk": "low",
        "requiresResponse": true,
        "withinProject": true,
        "target": { "path": "src/routes/jobs.ts" },
        "action": {
          "summary": "Write file src/routes/jobs.ts",
          "details": null
        },
        "policyEvaluation": {
          "matchedRule": null,
          "suggestedDecision": "approve_once",
          "reason": "Project-local file write within approved root"
        },
        "timeoutAt": "2026-03-25T00:23:39Z"
      }
    }
  ],
  "pendingPermission": {
    "id": "perm_017",
    "permissionType": "file_write",
    "risk": "low",
    "target": { "path": "src/routes/jobs.ts" },
    "timeoutAt": "2026-03-25T00:23:39Z"
  }
}
```

#### Semantics
- The event log is append-only for the life of the session.
- Clients resume from the last seen cursor.
- Long-polling SHOULD return early when new events arrive.

---

### 7.5 POST /session/respond

Respond to the currently pending permission request.

#### Request
```json
{
  "project": "my-project",
  "permissionId": "perm_017",
  "decision": "approve_once",
  "reason": "Project-local source edit within approved chunk scope"
}
```

#### Supported `decision` values
- `approve_once`
- `deny`
- `abort_session`

Optional future extensions:
- `approve_for_session`
- `approve_for_path_prefix`

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "running",
  "cursor": 25,
  "decision": {
    "seq": 23,
    "kind": "decision",
    "timestamp": "2026-03-25T00:18:55Z",
    "data": {
      "permissionId": "perm_017",
      "decision": "approve_once",
      "actor": "nhe-itl",
      "reason": "Project-local source edit within approved chunk scope"
    }
  }
}
```

#### Errors
- `404` no active session or no such permission
- `409` permission already resolved or session not waiting
- `410` session ended before response applied

---

### 7.6 POST /session/policy

Update the approval envelope for an active session.

#### Request
```json
{
  "project": "my-project",
  "approvalEnvelope": {
    "mode": "scoped",
    "projectRoot": "~/.openclaw/projects/my-project",
    "rules": {
      "fileWrites": {
        "withinProject": "auto_approve",
        "outsideProject": "require_review"
      },
      "dependencyChanges": "require_review",
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

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "running",
  "policyUpdated": true
}
```

---

### 7.7 POST /session/end

Request graceful wrap-up and session termination.

#### Request
```json
{
  "project": "my-project",
  "message": "Wrap up, write handoff, and end session."
}
```

#### Response
```json
{
  "ok": true,
  "project": "my-project",
  "sessionId": "sess_abc123",
  "state": "ended",
  "exitCode": 0,
  "createdAt": "2026-03-25T00:16:00Z",
  "updatedAt": "2026-03-25T00:25:14Z",
  "finalCursor": 41
}
```

#### Errors
- `404` no active session
- `409` session already ending

---

### 7.8 GET /sessions

List all active PTY sessions.

#### Response
```json
{
  "ok": true,
  "sessions": [
    {
      "project": "my-project",
      "sessionId": "sess_abc123",
      "state": "running",
      "createdAt": "2026-03-25T00:16:00Z",
      "updatedAt": "2026-03-25T00:22:41Z"
    }
  ]
}
```

---

## 8. Output Streaming Model

### 8.1 Event Types

Each event in `/session/output` MUST include:
- `seq` monotonic integer
- `kind`
- `timestamp`

Supported `kind` values:
- `text`
- `permission`
- `decision`
- `lifecycle`
- `error`

### 8.2 `text` Event
```json
{
  "seq": 12,
  "kind": "text",
  "timestamp": "2026-03-25T00:18:01Z",
  "stream": "stdout",
  "text": "Running tests...\n"
}
```

### 8.3 `decision` Event
```json
{
  "seq": 23,
  "kind": "decision",
  "timestamp": "2026-03-25T00:18:55Z",
  "permissionId": "perm_017",
  "decision": "approve_once",
  "actor": "nhe-itl"
}
```

### 8.4 `lifecycle` Event
```json
{
  "seq": 1,
  "kind": "lifecycle",
  "timestamp": "2026-03-25T00:16:00Z",
  "fromState": "starting",
  "toState": "running"
}
```

### 8.5 `error` Event
```json
{
  "seq": 40,
  "kind": "error",
  "timestamp": "2026-03-25T00:24:58Z",
  "code": "pty_exit_unexpected",
  "message": "Claude Code PTY exited while waiting for permission",
  "details": null
}
```

---

## 9. Error Handling

### 9.1 Permission Prompt Timeout

If a session is in `waiting_for_permission` and no response is received by `timeoutAt`:

1. The bridge MUST append an `error` event:
   - `code: "permission_timeout"`
2. The bridge MUST resolve the pending request according to the configured timeout policy.
3. Default timeout policy for v2:
   - `deny` the pending action
   - send the denial to Claude Code stdin if possible
4. If Claude Code remains interactive after denial:
   - transition back to `running`
5. If Claude Code exits or cannot continue:
   - transition to `timed_out` or `failed`

Recommended default prompt wait timeout: **5 minutes**.

### 9.2 PTY Dies Unexpectedly

If the underlying PTY exits while session state is `starting`, `running`, or `waiting_for_permission`:

1. Append `error` event with `code: "pty_exit_unexpected"`
2. Record process exit code/signal if known
3. Transition state to `failed`
4. Preserve event log for postmortem polling
5. Allow `/session/end` to perform cleanup and finalize as `ended`

### 9.3 Session Runtime Timeout

If the full session exceeds configured runtime timeout:

1. Append `error` event with `code: "session_runtime_timeout"`
2. Attempt graceful interruption to Claude Code
3. If graceful interruption fails, terminate PTY
4. Transition to `timed_out`
5. Allow explicit cleanup/end

### 9.4 Policy Evaluation Failure

If the bridge cannot classify a permission request or policy evaluation throws:

1. Emit permission event with:
   - `permissionType: "unknown"`
   - `risk: "high"`
2. Set `suggestedDecision: "deny"`
3. Require explicit response unless session policy says unknown → deny automatically

### 9.5 Stale Permission Response

If `/session/respond` references a permission that is already resolved or no longer pending:
- return `409 conflict`
- include current session state and pending permission (if any)

---

## 10. Security Model

### 10.1 Approved Scope

The approval envelope MUST define the approved project root. The bridge SHOULD normalize paths before comparison and reject path traversal.

### 10.2 Fail Closed

When path classification, command classification, or policy evaluation is ambiguous:
- treat as `unknown`
- require review or deny

### 10.3 Auditability

The event log is the canonical audit trail and MUST contain:
- all lifecycle transitions
- all permission events
- all reviewer decisions
- terminal exit status

### 10.4 Token and Transport

- Bearer auth remains required
- bridge remains host-local unless explicitly exposed
- callback delivery is excluded from v2

---

## 11. Suggested Default Approval Envelope for my-project

```json
{
  "mode": "scoped",
  "projectRoot": "~/.openclaw/projects/my-project",
  "rules": {
    "fileWrites": {
      "withinProject": "auto_approve",
      "outsideProject": "require_review"
    },
    "fileDeletes": {
      "withinProject": "require_review",
      "outsideProject": "deny"
    },
    "shellCommands": {
      "allowlist": [
        "npm test",
        "npm run test",
        "npm run build",
        "npm run lint",
        "npm run typecheck",
        "vitest",
        "vitest run",
        "git status",
        "git diff",
        "git add -A",
        "git commit"
      ],
      "allowlistPolicy": "auto_approve",
      "otherPolicy": "require_review"
    },
    "dependencyChanges": "require_review",
    "networkAccess": "require_review",
    "gitOperations": {
      "safe": "auto_approve",
      "destructive": "require_review"
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
```

---

## 12. Minimal Implementation Sequence

Recommended implementation order:

1. PTY-backed `/session/start`, `/session/send`, `/session/end`
2. Cursor-based `/session/output`
3. Detection and normalization of permission prompts into structured permission events
4. `/session/respond`
5. Approval envelope evaluation and auto-resolution for safe actions
6. Robust timeout/error handling and audit events

---

## 13. Open Questions for Review

1. Should `/session/send` auto-start sessions when missing, or require explicit `/session/start`?
2. Should `approve_for_session` be included in v2, or deferred to v2.1?
3. Should denial on prompt-timeout be configurable per session?
4. Should the bridge expose raw PTY transcript export endpoints for debugging?
5. Should we maintain backward compatibility with the current `/session/send` semantics or version the API under `/v2/...`?

---

## 14. Recommendation

Implement this as **Bridge v2 polling-first PTY broker** with:
- explicit `/session/start`
- cursor-based `/session/output`
- structured permission events
- `/session/respond`
- session-level approval envelope
- fail-closed handling for unknown/high-risk actions

This gives the NHE-ITL real review authority without requiring a blanket bypass flag, while preserving persistent session workflows and governance handoff.
