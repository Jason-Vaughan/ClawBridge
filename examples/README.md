# ClawBridge examples

Reference implementations showing how to consume and extend the bridge. Code
in this directory is meant to be read, copied, and adapted — it lives next to
the bridge in the same repository so it stays in version-parity with the
contract it demonstrates. If a recipe ever breaks because of a bridge change,
the change and the recipe land in the same PR.

## Recipes

### `orchestrator-driver.js` — drive the bridge from outside

A self-contained Node.js script (no external dependencies) showing the
end-to-end orchestrator side of a session:

- POST a session with an approval envelope and explicit `permissionMode`.
- Poll `/v2/session/peek` for state, output tail, and pending permissions.
- Respond to permission prompts (`approve_once`, `deny`, or `abort_session`).
- Send follow-up nudges when the session goes idle without producing the
  expected completion marker.
- End the session cleanly.

This is the same pattern an orchestrator like OpenClaw would implement,
ported from any language with an HTTP client. The example task is "build a
Python tic-tac-toe game with unit tests" — chosen because it exercises file
writes, shell commands, and a real end-to-end completion signal.

**Run it:**

```bash
# 1. Start a bridge (in another terminal):
cd ../bridge
BRIDGE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
PROJECTS_DIR=/tmp/clawbridge-demo \
node server.js

# 2. From the same shell, run the driver against that bridge:
BRIDGE_TOKEN=<the token from step 1> \
BRIDGE_URL=http://localhost:3201 \
node orchestrator-driver.js
```

The driver logs every state transition, every permission decision, and every
HTTP call. Inspect the artifact afterwards at
`/tmp/clawbridge-demo/orchestrator-demo/`.

**Knobs:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `BRIDGE_URL` | `http://localhost:3201` | Bridge base URL |
| `BRIDGE_TOKEN` | (required) | Bearer token configured on the bridge |
| `SMOKE_PROJECT` | `orchestrator-demo` | Project name (becomes a directory under `PROJECTS_DIR`) |
| `PERMISSION_MODE` | `default` | Claude Code permission mode. Use `default` to engage the bridge's structured permission review; `auto` to let Claude self-classify and bypass the bridge's parser entirely. |
| `COMPLETION_MARKER` | `ORCHESTRATOR_DEMO_COMPLETE` | Marker string the session prints to signal completion |
| `MAX_RUNTIME_MS` | `1500000` (25 min) | Driver gives up after this long |

**Why `permissionMode=default` matters:** Claude Code 2.1.x defaults to *auto
mode*, where it classifies and auto-handles permission prompts internally —
the bridge's TUI permission parser never fires and `approvalEnvelope` has no
effect. Setting `permissionMode=default` (or any non-`auto` value) on
`/v2/session/start` is what makes the bridge's structured permission review
do anything visible. The driver sets this explicitly so reviewers can see
permission events flow through the bridge.

### `tools-extension-client.js` — call the bridge's `/tools/*` extension

A self-contained Node.js script (no external dependencies) showing the
**client side** of the bridge's tools-extension contract — how a container
agent, orchestrator, CI script, or any HTTP caller talks to whatever
extension the bridge has mounted via `CLAWBRIDGE_TOOLS_MODULE`. Pairs with
[`../docs/tools-extension.md`](../docs/tools-extension.md), which documents
the author side (the module being mounted). Closes
[ClawBridge#9](https://github.com/Jason-Vaughan/ClawBridge/issues/9).

What it demonstrates:

- Discover whether a tools extension is mounted, and read its self-reported
  health, by hitting unauthenticated `GET /health` and inspecting the `tools`
  sub-object.
- Call a representative `/tools/<path>` endpoint with bearer-token auth.
- Translate the documented status codes into actionable errors:
  - **401** → caller should check `BRIDGE_TOKEN` matches the bridge's config.
  - **404** → either the extension declined this path, or no extension is
    mounted (use the `/health` discovery step to disambiguate).
  - **5xx + network errors** → retry with exponential backoff, capped.
  - **2xx** → return the parsed JSON.

**Run it against the bundled mock-tools-extension fixture (zero-setup smoke):**

```bash
# 1. Start a bridge with the mock extension loaded:
cd ../bridge
BRIDGE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
PROJECTS_DIR=/tmp/clawbridge-tools-demo \
CLAWBRIDGE_TOOLS_MODULE=$(pwd)/__tests__/fixtures/mock-tools-extension.js \
BRIDGE_PORT=3220 \
node server.js

# 2. From another shell, run the client against that bridge:
BRIDGE_TOKEN=<the token from step 1> \
BRIDGE_URL=http://localhost:3220 \
TOOLS_PATH=/tools/health \
node tools-extension-client.js
```

Expected output: `/health` shows `tools: { ok: true, mock: true, initialized: true }`; `/tools/health` responds 200 with `{ mock: true, pathname: '/tools/health', method: 'GET' }`.

**Run it against any production bridge:**

```bash
BRIDGE_TOKEN=<your token> \
BRIDGE_URL=http://your-bridge-host:3201 \
TOOLS_PATH=/tools/<your-extension-path> \
TOOLS_METHOD=GET \
node tools-extension-client.js
```

**Knobs:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `BRIDGE_URL` | `http://localhost:3201` | Bridge base URL |
| `BRIDGE_TOKEN` | (required) | Bearer token configured on the bridge |
| `TOOLS_PATH` | `/tools/health` | The extension endpoint to call (must start with `/tools/`) |
| `TOOLS_METHOD` | `GET` | HTTP method |
| `TOOLS_BODY` | (none) | Optional JSON body for `POST`/`PUT`/`PATCH` |
| `MAX_RETRIES` | `3` | Retries on transient (5xx, network) failures |
| `BASE_BACKOFF_MS` | `500` | First retry sleeps this long; doubles each attempt |

**Why the discovery step matters:** a 404 from `/tools/<path>` is ambiguous — it could mean "no extension mounted at all" or "extension is mounted but doesn't recognize this path." The recipe hits `/health` first (unauthenticated, no token required) so callers can distinguish the two cases before retrying or surfacing a misleading error to the user.

## Adding a recipe

When adding a new recipe:

1. Keep it dependency-free where reasonable (Node stdlib only). The recipes
   should translate cleanly to other languages.
2. JSDoc every function. Comments explain *why*, not *what*.
3. Add a section to this README describing what pattern the recipe
   demonstrates.
4. If the recipe uses an extension via `CLAWBRIDGE_TOOLS_MODULE`, link to
   `../docs/tools-extension.md`.
5. Recipes that talk to the bridge must accept `BRIDGE_URL`/`BRIDGE_TOKEN`
   from env — never hardcode.
