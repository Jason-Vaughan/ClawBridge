# ClawBridge host-tools client extension — builder-session launch pointer

**Role:** Build session for `Jason-Vaughan/ClawBridge` — author the container-side `/tools/*`
client so the OpenClaw agent on habitat can reach ClawBridge (cron monitoring is down without it).

**Source of truth (read in this order):**
- **[ClawBridge#10](https://github.com/Jason-Vaughan/ClawBridge/issues/10) — CANONICAL** (corrected
  diagnosis + deliverable + acceptance). Start here.
- [ClawBridge#8](https://github.com/Jason-Vaughan/ClawBridge/issues/8) — prior investigation,
  CLOSED. Its "3 config edits" fix proposal was based on a **wrong premise** (no exec-approvals
  socket exists; `admin-http-rpc` is non-capability; `OPENCLAW_EXTENSIONS` was always empty;
  `clawbridge-extension.cjs` is bridge-side only). **#10 supersedes #8's fix direction.**

> ⚠️ The detailed "likely fix direction" that used to live in this file (socket mount, etc.) was
> the #8 premise and is **wrong** — deleted on 2026-06-03. Treat #10 as truth.

## Paste this to launch the session

```
You are the ClawBridge build session for Jason-Vaughan/ClawBridge.

Build task: author the missing CLIENT half of the /tools/* contract so a containerized
OpenClaw agent can call ClawBridge. ClawBridge already SERVES /tools/* (healthy, 14 caps);
nothing consumes it from inside the agent container.

Read first (in this repo):
- `gh issue view 10`  ← corrected canonical diagnosis + deliverable + acceptance criteria.
- `gh issue view 8`   ← prior investigation (CLOSED). Its "3 config edits" were a wrong premise;
  #10 supersedes it.

Deliverable (this repo):
1. A container-side OpenClaw *capability* extension implementing the /tools/* client: bearer
   auth via CLAWBRIDGE_TOKEN, discover the capability set via /v2/api-docs, expose as OpenClaw
   agent tool(s). (Contract: docs/tools-extension.md + /v2/api-docs.)
2. `examples/tools-extension-client.js` cookbook — the bearer-token request pattern from a
   container to host.docker.internal:3201/tools/*.
3. Package so RentalClaw can `openclaw plugins install` it and list it in OPENCLAW_EXTENSIONS.

Verified healthy — keep scope on the client, do NOT touch: ClawBridge process (/health 200,
:3201, 14 caps), auth gating (401 unauth), and the bridge plist (CLAWBRIDGE_TOOLS_MODULE correct).

Boundary: the habitat ~/openclaw deployment (install + wire OPENCLAW_EXTENSIONS + CLAWBRIDGE_TOKEN
env + restart + re-enable the 5 paused crons + rotate the 5 secrets from #8's security note) is
RentalClaw's to do — hand that back via paste-back, don't commit into RentalClaw.

Acceptance: the agent gets a callable tool that authenticates (200) to host.docker.internal:3201
/tools/*, and a re-enabled cron (gabby-vrbo-daily-booking fbc48af9-…) runs without the
"no callable exec/shell tool" error.
```

## RentalClaw-side follow-through (after the client ships)
Install + wire on habitat `~/openclaw`, restart, then re-enable the 5 paused crons:
`bc874630` whatsapp-health · `bbc3714f` airbnb-daily · `fbc48af9` vrbo-daily ·
`4b2c55bd` airbnb-heartbeat · `e2e09d2e` booking-check
(`docker exec openclaw-openclaw-gateway-1 openclaw cron enable <id>`).

## Update history
- 2026-06-02 — created after the codex-outage marathon.
- 2026-06-03 — rewritten to a launch pointer; #8 premise found wrong, superseded by #10.
