#!/usr/bin/env node
'use strict';

/**
 * Reference orchestrator driver for ClawBridge.
 *
 * Demonstrates how a containerized orchestrator (OpenClaw, a custom build
 * service, or any caller that wants to drive Claude Code via HTTP) talks to
 * the bridge: starts a session, polls /v2/session/peek, responds to
 * permission prompts, sends follow-up nudges if the session goes idle, and
 * ends cleanly when a completion marker is detected.
 *
 * This file is intentionally dependency-free (Node built-ins only) so the
 * patterns translate to any language with an HTTP client.
 *
 * Usage:
 *   BRIDGE_TOKEN=<token> node examples/orchestrator-driver.js
 *
 * Environment:
 *   BRIDGE_URL          (default: http://localhost:3201)
 *   BRIDGE_TOKEN        (required) — bearer token configured on the bridge
 *   SMOKE_PROJECT       (default: orchestrator-demo) — project name; maps to
 *                       a directory under the bridge's PROJECTS_DIR
 *   PERMISSION_MODE     (default: default) — Claude Code permission mode.
 *                       Use `default` to engage the bridge's structured
 *                       permission review; `auto` to let Claude self-classify
 *                       (and bypass the bridge's parser entirely).
 *   COMPLETION_MARKER   (default: ORCHESTRATOR_DEMO_COMPLETE)
 *   MAX_RUNTIME_MS      (default: 25 min)
 */

const http = require('http');

const CONFIG = {
  bridgeUrl: process.env.BRIDGE_URL || 'http://localhost:3201',
  token: process.env.BRIDGE_TOKEN || '',
  project: process.env.SMOKE_PROJECT || 'orchestrator-demo',
  permissionMode: process.env.PERMISSION_MODE || 'default',
  pollIntervalMs: 3000,
  maxRuntimeMs: parseInt(process.env.MAX_RUNTIME_MS || `${25 * 60 * 1000}`, 10),
  completionMarker: process.env.COMPLETION_MARKER || 'ORCHESTRATOR_DEMO_COMPLETE',
  idlePollsBeforeNudge: 10,
  maxNudges: 3,
};

const INSTRUCTION = `Build a Python 3 CLI tic-tac-toe game in the current directory:

REQUIREMENTS:
- File "tictactoe.py": implements the full game — a 3x3 board, win/draw detection, a computer opponent (any reasonable strategy is fine, minimax not required), and a main() that lets a human play against the computer.
- File "test_tictactoe.py": uses Python's stdlib unittest to test the win-detection logic (rows, columns, both diagonals, and the draw case) AND at least one test that the computer makes a legal move on an empty board.
- Stdlib only — do NOT pip install anything.
- Do NOT create any files other than tictactoe.py and test_tictactoe.py.
- Do NOT run git commands.

WORKFLOW:
1. Write tictactoe.py first.
2. Write test_tictactoe.py.
3. Run: python3 -m unittest test_tictactoe.py -v
4. If any test fails, fix the code and re-run until all pass.

COMPLETION:
When all tests pass, print EXACTLY this line on its own:
${CONFIG.completionMarker}: PASS

If tests fail and you cannot fix them, print:
${CONFIG.completionMarker}: FAIL`;

/**
 * Sample approval envelope. Auto-approves common safe operations within the
 * project, denies network and dependency changes, requires review for the
 * grey areas. Without permissionMode='default' set on session/start, this
 * envelope has no effect — Claude's auto mode bypasses the bridge's parser.
 */
const ENVELOPE = {
  mode: 'scoped',
  rules: {
    fileWrites: { withinProject: 'auto_approve', outsideProject: 'deny' },
    fileDeletes: { withinProject: 'require_review', outsideProject: 'deny' },
    shellCommands: {
      allowlist: ['python3 -m unittest', 'python3', 'python', 'ls', 'cat', 'pwd', 'echo', 'which python3'],
      allowlistPolicy: 'auto_approve',
      otherPolicy: 'require_review',
    },
    gitOperations: { safe: 'deny', destructive: 'deny' },
    dependencyChanges: 'deny',
    networkAccess: 'deny',
    unknown: 'require_review',
  },
  defaults: {
    lowRisk: 'auto_approve',
    mediumRisk: 'require_review',
    highRisk: 'deny',
  },
};

/** Timestamp helper for log lines. */
function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Log a line with timestamp prefix. */
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

/**
 * Perform an HTTP request against the bridge. Adds the bearer token,
 * serializes JSON bodies, returns { status, body }.
 *
 * @param {string} method - HTTP method
 * @param {string} pathname - Request path (e.g. /v2/session/start)
 * @param {object} [body] - Optional JSON body
 * @returns {Promise<{status:number, body:object}>}
 */
function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, CONFIG.bridgeUrl);
    const headers = { Authorization: `Bearer ${CONFIG.token}` };
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode, body: { raw: data } });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide whether to approve, deny, or abort a pending permission prompt.
 *
 * **This demo always approves.** It's intentionally permissive so the smoke
 * test runs to completion and shows the bridge's permission machinery in
 * action (see the `permission` events in `/v2/session/output` after a run).
 *
 * **Production orchestrators should replace this with real policy** based on
 * the permission shape. The pendingPermission object from /v2/session/peek is:
 *
 *   {
 *     id: "perm_<hex>",            // pass to /v2/session/respond
 *     permissionType: "file_write" | "shell" | "unknown" | ...,
 *     risk: "low" | "medium" | "high",
 *     target: <object>,            // shape depends on permissionType:
 *                                  //   file_write → { path: "..." }
 *                                  //   shell      → { command: "..." }
 *                                  //   unknown    → { type, description }
 *     timeoutAt: <ISO date>|null
 *   }
 *
 * A real policy might:
 *   - approve_once for file_write where target.path is inside the project
 *   - deny shell commands matching a denylist regex
 *   - require human review (return null and surface to a UI) for high-risk
 *   - abort_session if multiple denials accumulate
 *
 * @param {object} p - pendingPermission from /v2/session/peek
 * @returns {string} one of: approve_once, deny, abort_session
 */
function decidePermission(p) {
  // Demo: blanket approve so the smoke test completes. The `permission` and
  // `decision` events in /v2/session/output are the demonstration — they
  // wouldn't appear at all if `permissionMode=auto` (Claude's default).
  return 'approve_once';
}

async function startSession() {
  log(`POST /v2/session/start project=${CONFIG.project} permissionMode=${CONFIG.permissionMode}`);
  const r = await request('POST', '/v2/session/start', {
    project: CONFIG.project,
    instruction: INSTRUCTION,
    approvalEnvelope: ENVELOPE,
    permissionMode: CONFIG.permissionMode,
  });
  log(`  → status=${r.status} body=${JSON.stringify(r.body).slice(0, 240)}`);
  if (r.status !== 200) throw new Error(`session/start failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function peek() {
  const r = await request(
    'GET',
    `/v2/session/peek?project=${encodeURIComponent(CONFIG.project)}&lines=80&clean=true`
  );
  return r.body;
}

async function respond(permissionId, decision) {
  log(`POST /v2/session/respond permissionId=${permissionId} decision=${decision}`);
  const r = await request('POST', '/v2/session/respond', {
    project: CONFIG.project,
    permissionId,
    decision,
    actor: 'orchestrator-driver',
  });
  log(`  → status=${r.status}`);
  return r;
}

async function send(message) {
  log(`POST /v2/session/send message="${message.slice(0, 80)}..."`);
  const r = await request('POST', '/v2/session/send', {
    project: CONFIG.project,
    message,
  });
  log(`  → status=${r.status}`);
  return r;
}

async function endSession() {
  log('POST /v2/session/end');
  const r = await request('POST', '/v2/session/end', { project: CONFIG.project });
  log(`  → status=${r.status}`);
  return r;
}

async function main() {
  if (!CONFIG.token) {
    console.error('BRIDGE_TOKEN env var required. See examples/README.md.');
    process.exit(2);
  }

  log('=== ClawBridge orchestrator driver starting ===');
  log(`bridge=${CONFIG.bridgeUrl}  project=${CONFIG.project}  permissionMode=${CONFIG.permissionMode}`);

  await startSession();

  const startedAt = Date.now();
  let idleCount = 0;
  let nudgeCount = 0;
  let lastTailHash = '';
  let outcome = 'timeout';

  while (Date.now() - startedAt < CONFIG.maxRuntimeMs) {
    const snap = await peek();
    if (!snap || !snap.ok) {
      log('peek not ok:', JSON.stringify(snap).slice(0, 240));
      await sleep(CONFIG.pollIntervalMs);
      continue;
    }

    const tail = snap.tail || '';
    const tailHash = require('crypto').createHash('sha1').update(tail).digest('hex').slice(0, 8);
    const changed = tailHash !== lastTailHash;
    lastTailHash = tailHash;

    const pendingType = snap.pendingPermission
      ? snap.pendingPermission.permissionType || snap.pendingPermission.type || 'unknown'
      : 'none';
    log(
      `state=${snap.state} inputReady=${snap.inputReady} pending=${pendingType} tail_hash=${tailHash} changed=${changed}`
    );

    if (snap.pendingPermission) {
      const p = snap.pendingPermission;
      const decision = decidePermission(p);
      // target is a structured object (file_write → {path}, shell → {command},
      // unknown → {type, description}). Stringify for log readability.
      const targetStr =
        p.target == null
          ? ''
          : typeof p.target === 'string'
            ? p.target.slice(0, 80)
            : JSON.stringify(p.target).slice(0, 120);
      log(
        `  perm: id=${p.id || p.permissionId} type=${p.permissionType || p.type || 'unknown'} risk=${p.risk || '?'} target=${targetStr} → ${decision}`
      );
      const pid = p.id || p.permissionId;
      if (pid) {
        await respond(pid, decision);
      } else {
        log('  WARNING: no permission id present; cannot respond.');
      }
      idleCount = 0;
      await sleep(1000);
      continue;
    }

    if (tail.includes(`${CONFIG.completionMarker}: PASS`)) {
      log('=== completion marker PASS detected ===');
      outcome = 'pass';
      break;
    }
    if (tail.includes(`${CONFIG.completionMarker}: FAIL`)) {
      log('=== completion marker FAIL detected ===');
      outcome = 'fail';
      break;
    }

    if (snap.state === 'ended' || snap.state === 'errored' || snap.state === 'failed') {
      log(`=== session ${snap.state}, exiting loop ===`);
      outcome = snap.state;
      break;
    }

    if (snap.inputReady && !changed) {
      idleCount++;
      if (idleCount >= CONFIG.idlePollsBeforeNudge) {
        if (nudgeCount < CONFIG.maxNudges) {
          nudgeCount++;
          log(`=== session idle for ${idleCount} polls, sending nudge #${nudgeCount} ===`);
          await send(
            `Status check #${nudgeCount}: have the tests run? If they passed, print "${CONFIG.completionMarker}: PASS" exactly. If they failed, print "${CONFIG.completionMarker}: FAIL". Otherwise continue.`
          );
          idleCount = 0;
        } else {
          log(`=== max nudges (${CONFIG.maxNudges}) reached without completion, giving up ===`);
          outcome = 'gave_up';
          break;
        }
      }
    } else {
      idleCount = 0;
    }

    await sleep(CONFIG.pollIntervalMs);
  }

  log(`=== outcome: ${outcome} — ending session ===`);
  await endSession();
  log('=== driver exit ===');
  process.exit(outcome === 'pass' ? 0 : 1);
}

main().catch((e) => {
  console.error('driver error:', e);
  process.exit(2);
});
