'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve the on-disk location of the installed node-pty package.
 *
 * Returns null if node-pty cannot be resolved from this process (e.g. it was
 * never installed, or the dependency tree is broken). Callers treat null as
 * "not spawnable" rather than throwing.
 *
 * @returns {string|null} Absolute path to node-pty package directory, or null
 */
function resolveNodePtyDir() {
  try {
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/**
 * Candidate filesystem locations for node-pty's `spawn-helper` binary for a
 * given platform/arch combo. node-pty 1.x ships prebuilt binaries under
 * `prebuilds/<plat-arch>/`; locally rebuilt copies land in `build/Release/`.
 * The runtime tries `posix_spawn(spawn-helper)` from one of these — whichever
 * resolves first against the loaded native binding.
 *
 * @param {string} nodePtyDir - Absolute path to node-pty package dir
 * @param {string} platform - e.g. 'darwin'
 * @param {string} arch - e.g. 'arm64'
 * @returns {string[]} Absolute candidate paths, in lookup order
 */
function candidatePaths(nodePtyDir, platform, arch) {
  return [
    path.join(nodePtyDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(nodePtyDir, 'build', 'Release', 'spawn-helper'),
  ];
}

/**
 * Find the first existing candidate spawn-helper path.
 *
 * @param {string} nodePtyDir
 * @param {string} platform
 * @param {string} arch
 * @returns {{ path: string, stat: fs.Stats }|null}
 */
function findHelper(nodePtyDir, platform, arch) {
  for (const p of candidatePaths(nodePtyDir, platform, arch)) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) return { path: p, stat };
    } catch {
      // Not present at this candidate, try next.
    }
  }
  return null;
}

/**
 * Ensure node-pty's spawn-helper for the running platform/arch is executable.
 *
 * Idempotent: an already-executable helper is left untouched (no chmod, no
 * log). A helper with no exec bits gets `chmod +x` applied non-destructively
 * (existing perms are preserved; we OR in `0o755`), and a single warning is
 * logged. A missing helper logs an error and reports not-spawnable but does
 * not throw — the bridge can still serve `/health` and surface the diagnostic
 * to the operator. This is the durable counterpart to `scripts/postinstall.js`:
 * postinstall runs once at `npm install` time, this runs every boot and
 * survives reinstalls, filesystem syncs, and perm resets.
 *
 * @param {object} [opts]
 * @param {string} [opts.nodePtyDir] - Override the node-pty location (test injection)
 * @param {string} [opts.platform] - Override `process.platform` (test injection)
 * @param {string} [opts.arch] - Override `process.arch` (test injection)
 * @param {{ warn: Function, error: Function }} [opts.logger] - Logger sink (default `console`)
 * @returns {{ helper: string|null, spawnable: boolean, fixed: boolean, reason?: string }}
 */
function ensureSpawnHelperExecutable(opts = {}) {
  const logger = opts.logger || console;
  const nodePtyDir = opts.nodePtyDir || resolveNodePtyDir();
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;

  if (!nodePtyDir) {
    return {
      helper: null,
      spawnable: false,
      fixed: false,
      reason: 'node-pty not resolvable',
    };
  }

  const found = findHelper(nodePtyDir, platform, arch);
  if (!found) {
    const tried = candidatePaths(nodePtyDir, platform, arch).join(', ');
    logger.error(
      `[bridge] node-pty spawn-helper not found for ${platform}-${arch}. ` +
        `Sessions will fail with posix_spawnp errors. Tried: ${tried}`
    );
    return {
      helper: null,
      spawnable: false,
      fixed: false,
      reason: `helper missing for ${platform}-${arch}`,
    };
  }

  const { path: helperPath, stat } = found;
  if ((stat.mode & 0o111) === 0) {
    try {
      fs.chmodSync(helperPath, stat.mode | 0o755);
      logger.warn(
        `[bridge] node-pty spawn-helper was not executable; fixed (${helperPath})`
      );
      return { helper: helperPath, spawnable: true, fixed: true };
    } catch (err) {
      logger.error(
        `[bridge] failed to restore exec bit on node-pty spawn-helper at ${helperPath}: ${err.message}`
      );
      return {
        helper: helperPath,
        spawnable: false,
        fixed: false,
        reason: `chmod failed: ${err.message}`,
      };
    }
  }

  return { helper: helperPath, spawnable: true, fixed: false };
}

/**
 * Non-mutating check of spawn-helper status — used by `/health` so each
 * request reflects the *current* on-disk state (perms can drift between the
 * boot-time self-heal and any given request, e.g. after a `cp -p` restore or
 * a filesystem sync).
 *
 * `spawnable: true` iff a helper exists AND has at least one exec bit set.
 *
 * @param {object} [opts]
 * @param {string} [opts.nodePtyDir]
 * @param {string} [opts.platform]
 * @param {string} [opts.arch]
 * @returns {boolean}
 */
function checkSpawnable(opts = {}) {
  const nodePtyDir = opts.nodePtyDir || resolveNodePtyDir();
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  if (!nodePtyDir) return false;
  const found = findHelper(nodePtyDir, platform, arch);
  if (!found) return false;
  return (found.stat.mode & 0o111) !== 0;
}

module.exports = {
  ensureSpawnHelperExecutable,
  checkSpawnable,
  resolveNodePtyDir,
  candidatePaths,
};
