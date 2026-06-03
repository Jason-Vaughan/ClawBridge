# ClawBridge host-tools mount fix — builder-session priming

**Role:** Builder session for `Jason-Vaughan/ClawBridge`, fixing the OpenClaw agent's lost
host-exec / ClawBridge tool access on habitat.

**Tracking issue:** [Jason-Vaughan/ClawBridge#8](https://github.com/Jason-Vaughan/ClawBridge/issues/8) (filed 2026-06-02).

---

## Paste this to launch the session

> You are the ClawBridge builder session. The OpenClaw agent running on habitat
> (`openclaw-openclaw-gateway-1`, RentalClaw deployment) has **lost host-tool access**: its
> autonomous cron jobs can no longer run shell commands or make authenticated HTTP calls to
> ClawBridge, so all host-side monitoring (VRBO/Airbnb/WhatsApp checks) is down. Read the
> tracking issue Jason-Vaughan/ClawBridge#8 and the diagnostic below, then design + implement
> the fix in the ClawBridge repo and/or the habitat `~/openclaw` deployment. Do **not** assume —
> verify current state on habitat first (`ssh habitat`). Coordinator session has the full
> history; this brief is the cold-start.

---

## Diagnostic (verified 2026-06-02, by the coordinator session)

Root symptom: the gateway's embedded/cron agent runtime exposes **no exec/shell tool and no
authenticated-HTTP tool**, so cron payloads that shell out or `curl http://host.docker.internal:3201`
(ClawBridge) fail with *"this runtime does not expose a callable exec/shell tool"* /
*"tool_search found no callable terminal/PTY alternative."*

Verified facts:
- `CLAWBRIDGE_TOOLS_MODULE` is **unset** in the `openclaw-openclaw-gateway-1` container env.
- Agent's 12 loaded plugins contain **no exec/shell/host-tools plugin**:
  `browser, canvas, codex, device-pair, discord, file-transfer, github-copilot, memory-core,
  phone-control, talk-voice, tangleclaw-google-oauth, whatsapp`.
- ClawBridge **is alive and reachable** from the container:
  `docker exec openclaw-openclaw-gateway-1 curl -s -o /dev/null -w '%{http_code}'
  http://host.docker.internal:3201/` → **401** (up, token-gated).
- `~/openclaw/docker-compose.yml` and `~/openclaw/.env` contain **no** reference to ClawBridge,
  a tools module, or `CLAWBRIDGE_TOOLS_MODULE`. So either the mount was never in this stack's
  compose, or a prior container had the env set out-of-band and tonight's
  `docker compose up -d` (OpenClaw 2026.5.6 → 2026.5.28 update) recreated it without the env.
- `~/.openclaw/exec-approvals.json` exists and `openclaw approvals` is a real command — relevant
  to how host-exec is gated.
- Per project memory, ClawBridge host-tools are meant to mount into OpenClaw via
  `CLAWBRIDGE_TOOLS_MODULE` (`@jason-vaughan/clawbridge` npm; tools mount via that env).

Likely fix direction (validate, don't assume):
1. Restore `CLAWBRIDGE_TOOLS_MODULE` (pointing at the clawbridge tools module) into the
   habitat `~/openclaw` compose/.env **and** ensure the module file is present/mounted in the
   container, **or** load the equivalent OpenClaw plugin that brokers ClawBridge calls.
2. Confirm the agent then has a callable tool to reach `host.docker.internal:3201` with the
   ClawBridge auth token (the 401 means a token is required — wire it).
3. Re-validate against `openclaw 2026.5.28` tool/plugin model (the version may have changed how
   external tool modules or exec approvals load; `plugins.allow` is currently empty).

Acceptance criteria:
- An autonomous cron run (e.g. re-enable `gabby-vrbo-daily-booking`) can authenticate to
  ClawBridge `:3201` and execute its host check without the "no exec tool" error.

## What the coordinator changed tonight (REVERT/re-enable after the fix)
- **Disabled 5 cron jobs** to stop Discord error-spam — re-enable once tools work:
  - `bc874630` jaq-whatsapp-health (every 15m)
  - `bbc3714f` gabby-airbnb-daily-booking
  - `fbc48af9` gabby-vrbo-daily-booking
  - `4b2c55bd` airbnb-session-heartbeat (every 7h)
  - `e2e09d2e` Booking/message check (every 2h)
  - Re-enable with: `docker exec openclaw-openclaw-gateway-1 openclaw cron enable <id>`
- Unrelated changes made same session (context, not yours to touch): codex re-auth + stale
  profile cleanup, OpenClaw update to 2026.5.28, session model-pins flipped back to
  `openai-codex/gpt-5.4`, fallback changed to `openai-codex/gpt-5.5`. Codex is healthy.

## Boundaries
- This is the ClawBridge builder session — own the ClawBridge repo. The habitat `~/openclaw`
  deployment is RentalClaw turf; coordinate via paste-back if a deployment-config change is
  needed there rather than committing into RentalClaw from here.

## How to use
Paste the block under "Paste this to launch the session" into a fresh ClawBridge session. The
tracking issue (ClawBridge#8) carries the same diagnostic in GitHub.

## Update history
- 2026-06-02 — created by coordinator session after the codex-outage marathon; ClawBridge
  host-tool access found missing post-update. Stopgaps applied (crons disabled, fallback fixed).
