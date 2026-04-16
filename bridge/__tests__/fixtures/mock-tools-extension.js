'use strict';

/**
 * Mock tools extension for testing CLAWBRIDGE_TOOLS_MODULE.
 *
 * Loaded as a subprocess by the bridge during tests, so tests cannot observe
 * its in-memory state directly. Lifecycle events are appended to the file at
 * MOCK_TOOLS_LOG so tests can assert init/close ordering.
 *
 * Behavior toggles (env vars — all optional, all default to normal behavior):
 *   MOCK_TOOLS_LOG            — file path to append lifecycle events
 *   MOCK_TOOLS_INIT_THROW     — "1" → init() throws
 *   MOCK_TOOLS_INIT_DELAY_MS  — integer → init() waits this long before resolving
 *   MOCK_TOOLS_ROUTE_THROW    — "1" → handleToolsRoute() throws
 *   MOCK_TOOLS_HEALTH_THROW   — "1" → getToolsHealth() throws
 *   MOCK_TOOLS_CLOSE_THROW    — "1" → close() throws
 *
 * Route behavior:
 *   /tools/decline  → returns false (asks bridge to 404)
 *   /tools/*        → responds 200 { mock: true, pathname, method }
 */

const fs = require('node:fs');

const logPath = process.env.MOCK_TOOLS_LOG || '';

/**
 * Append a single-line event marker to the configured log file (no-op if unset).
 * @param {string} event
 */
function recordEvent(event) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${event}\n`);
  } catch { /* ignore — tests that don't care about lifecycle may not set a path */ }
}

let initialized = false;

/**
 * @returns {Promise<void>}
 */
async function init() {
  const delayMs = parseInt(process.env.MOCK_TOOLS_INIT_DELAY_MS || '0', 10);
  if (delayMs > 0) {
    recordEvent(`init-delay:${delayMs}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (process.env.MOCK_TOOLS_INIT_THROW === '1') {
    recordEvent('init-throw');
    throw new Error('mock init failure');
  }
  initialized = true;
  recordEvent('init-ok');
}

/**
 * @param {{ pathname: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse }} args
 * @returns {Promise<boolean>}
 */
async function handleToolsRoute({ pathname, req, res }) {
  if (!initialized) return false;
  if (process.env.MOCK_TOOLS_ROUTE_THROW === '1') {
    throw new Error('mock route failure');
  }
  if (pathname === '/tools/decline') {
    recordEvent(`decline:${pathname}`);
    return false;
  }
  const body = JSON.stringify({ mock: true, pathname, method: req.method });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

/**
 * @returns {Promise<object>}
 */
async function getToolsHealth() {
  if (process.env.MOCK_TOOLS_HEALTH_THROW === '1') {
    throw new Error('mock health failure');
  }
  return { ok: true, mock: true, initialized };
}

/**
 * @returns {Promise<void>}
 */
async function close() {
  recordEvent('close');
  initialized = false;
  if (process.env.MOCK_TOOLS_CLOSE_THROW === '1') {
    throw new Error('mock close failure');
  }
}

module.exports = { init, handleToolsRoute, getToolsHealth, close };
