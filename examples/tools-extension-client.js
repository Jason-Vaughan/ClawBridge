#!/usr/bin/env node
'use strict';

/**
 * Reference client for ClawBridge's `/tools/*` extension surface.
 *
 * The bridge accepts an optional in-process tools extension via the
 * `CLAWBRIDGE_TOOLS_MODULE` env var (see `docs/tools-extension.md` for the
 * author-side contract). When mounted, the extension's routes are exposed
 * under `/tools/*`. This recipe shows the **client side**: how a container
 * agent, orchestrator, CI script, or any HTTP caller talks to those routes.
 *
 * Dependency-free (Node stdlib only) so the patterns translate to any
 * language with an HTTP client and a JSON parser.
 *
 * What it demonstrates:
 *   1. Discover whether a tools extension is mounted, and what its health
 *      reports, by reading `/health` (unauthenticated — no token needed).
 *   2. Call a representative `/tools/<path>` endpoint with bearer-token auth.
 *   3. Handle the documented error cases: 401 (auth), 404 (path declined or
 *      extension absent), 5xx (transient server error → retry with backoff),
 *      network errors (retry).
 *
 * Run against any bridge:
 *   BRIDGE_TOKEN=<token> BRIDGE_URL=http://localhost:3201 \
 *     TOOLS_PATH=/tools/health TOOLS_METHOD=GET \
 *     node examples/tools-extension-client.js
 *
 * Env knobs (all optional except BRIDGE_TOKEN):
 *   BRIDGE_URL        default: http://localhost:3201
 *   BRIDGE_TOKEN      required — the bearer token configured on the bridge
 *   TOOLS_PATH        default: /tools/health — the extension endpoint to call
 *   TOOLS_METHOD      default: GET — HTTP method
 *   TOOLS_BODY        optional JSON body for POST/PUT/PATCH (string,
 *                     parsed and re-serialized to validate it's JSON)
 *   MAX_RETRIES       default: 3 — for transient (5xx, network) failures
 *   BASE_BACKOFF_MS   default: 500 — first retry sleeps this long; doubles
 *
 * Smoke-verify against the bundled mock-tools-extension fixture:
 *   See examples/README.md for the spin-up steps. The mock responds to any
 *   /tools/* request (except /tools/decline) with 200 { mock: true, ... },
 *   so the recipe runs end-to-end against it with TOOLS_PATH=/tools/health.
 */

const http = require('node:http');
const https = require('node:https');

const CONFIG = {
  bridgeUrl: process.env.BRIDGE_URL || 'http://localhost:3201',
  token: process.env.BRIDGE_TOKEN || '',
  toolsPath: process.env.TOOLS_PATH || '/tools/health',
  toolsMethod: (process.env.TOOLS_METHOD || 'GET').toUpperCase(),
  toolsBody: process.env.TOOLS_BODY || null,
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  baseBackoffMs: parseInt(process.env.BASE_BACKOFF_MS || '500', 10),
  requestTimeoutMs: 15000,
};

/** Timestamped log helper. */
function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  console.log(`[${ts}]`, ...args);
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make one HTTP request against the bridge. Returns { status, headers, body }
 * where body is the parsed JSON object (or `{ raw: '<text>' }` if the response
 * wasn't valid JSON). Rejects only on transport errors (refused, timeout,
 * DNS) — non-2xx responses resolve normally so the caller can branch on status.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.pathname  Must start with '/'
 * @param {object} [opts.body]    Optional JSON body
 * @param {boolean} [opts.auth]   When true, send `Authorization: Bearer <token>`
 * @returns {Promise<{status:number, headers:object, body:object}>}
 */
function request({ method, pathname, body, auth }) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, CONFIG.bridgeUrl);
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${CONFIG.token}`;
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: CONFIG.requestTimeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Retry wrapper. Retries on network errors and 5xx responses with exponential
 * backoff. Does NOT retry on 4xx — those are caller-fixable (bad token, bad
 * path, bad body) and retrying just amplifies the problem.
 *
 * @param {() => Promise<{status:number, headers:object, body:object}>} fn
 * @returns {Promise<{status:number, headers:object, body:object}>}
 */
async function withRetry(fn) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fn();
      if (res.status >= 500 && attempt < CONFIG.maxRetries) {
        const wait = CONFIG.baseBackoffMs * Math.pow(2, attempt);
        log(`  → ${res.status} (transient), retry ${attempt + 1}/${CONFIG.maxRetries} after ${wait}ms`);
        await sleep(wait);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < CONFIG.maxRetries) {
        const wait = CONFIG.baseBackoffMs * Math.pow(2, attempt);
        log(`  → network error: ${err.message} — retry ${attempt + 1}/${CONFIG.maxRetries} after ${wait}ms`);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Discover whether the bridge has a tools extension mounted, and report what
 * `/health` says about it. `/health` is unauthenticated by design (operators
 * tail it without credentials), so this works before any token is configured.
 *
 * Returns the `tools` sub-object from /health if present, or null if the bridge
 * is running without an extension.
 *
 * @returns {Promise<object|null>}
 */
async function discoverToolsExtension() {
  log('GET /health (unauthenticated)');
  const res = await withRetry(() => request({ method: 'GET', pathname: '/health' }));
  if (res.status !== 200) {
    throw new Error(`/health returned ${res.status} — bridge unreachable or misconfigured`);
  }
  log(`  bridge ok=${res.body.ok} claude=${res.body.claude || '?'} ptyMode=${res.body.ptyMode || '?'}`);
  const tools = res.body.tools;
  if (!tools) {
    log('  no `tools` block in /health — bridge is running without a tools extension');
    return null;
  }
  log(`  tools extension present: ${JSON.stringify(tools).slice(0, 240)}`);
  return tools;
}

/**
 * Call a single endpoint exposed by the tools extension. Returns the parsed
 * response on 2xx; throws on 4xx (caller-fixable) or repeated 5xx (transient
 * after retries).
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function callToolsEndpoint() {
  log(`${CONFIG.toolsMethod} ${CONFIG.toolsPath}`);
  let body = null;
  if (CONFIG.toolsBody) {
    try {
      body = JSON.parse(CONFIG.toolsBody);
    } catch (e) {
      throw new Error(`TOOLS_BODY is not valid JSON: ${e.message}`);
    }
  }
  const res = await withRetry(() =>
    request({ method: CONFIG.toolsMethod, pathname: CONFIG.toolsPath, body, auth: true })
  );
  log(`  → status=${res.status} body=${JSON.stringify(res.body).slice(0, 240)}`);

  // Translate the documented status codes into actionable errors.
  if (res.status === 401) {
    throw new Error(
      `401 from ${CONFIG.toolsPath} — check BRIDGE_TOKEN matches the bridge's configured token`
    );
  }
  if (res.status === 404) {
    // 404 can mean: (a) no tools extension mounted (no /tools/* routes), or
    // (b) the extension's internal router doesn't recognize this path, or
    // (c) the extension's handler returned false to decline this request.
    // discoverToolsExtension() above disambiguates (a). For (b) and (c) the
    // recipe just surfaces the 404 — the caller knows their own path layout.
    throw new Error(
      `404 from ${CONFIG.toolsPath} — extension either declined this path or the path is not exposed`
    );
  }
  if (res.status >= 400) {
    throw new Error(`${res.status} from ${CONFIG.toolsPath} — ${JSON.stringify(res.body)}`);
  }
  return res;
}

async function main() {
  if (!CONFIG.token) {
    console.error('BRIDGE_TOKEN env var required. See examples/README.md.');
    process.exit(2);
  }

  log('=== ClawBridge tools-extension client recipe ===');
  log(`bridge=${CONFIG.bridgeUrl}  path=${CONFIG.toolsPath} method=${CONFIG.toolsMethod}`);

  const tools = await discoverToolsExtension();
  if (!tools) {
    log('Nothing to call — bridge has no tools extension mounted. Exiting.');
    process.exit(0);
  }

  const res = await callToolsEndpoint();
  log('=== success ===');
  log(`response body: ${JSON.stringify(res.body, null, 2)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('client error:', err.message);
  process.exit(1);
});
