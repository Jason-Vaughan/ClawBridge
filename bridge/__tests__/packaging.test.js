/**
 * Guards for security-model.md § Known gaps G8 (`PKG-4R7T`): the published
 * tarball must not carry local session transcripts.
 *
 * Asserts against what `npm pack` actually produces, not against the `files`
 * array in package.json. That distinction is the whole point of this file:
 * `bridge/.session-history/` is **gitignored**, so a revert to the old
 * `files: ["bridge/"]` whitelist shows no diff in any tracked file, breaks no
 * other test, and silently republishes whatever transcripts happen to sit on
 * the publishing machine. Only the pack manifest sees it.
 *
 * Pinned in both directions on purpose. Asserting only "no transcripts" would
 * pass against a whitelist that shipped nothing at all, and the whitelist was
 * already narrowed once by hand in a way that silently dropped a directory
 * (`bridge/*.js` does not match `bridge/__tests__/`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HISTORY_DIR = path.join(REPO_ROOT, 'bridge', '.session-history');
const MARKER = path.join(HISTORY_DIR, '__packaging-guard__.json');

/** @type {string[]} Paths npm would publish, as the packer reports them. */
let packedPaths;
/** @type {boolean} Whether this run created the history dir and must remove it. */
let createdDir = false;

beforeAll(() => {
  // Plant a transcript-shaped file before packing.
  //
  // Without this the guard is a no-op on exactly the machines that matter.
  // `bridge/.session-history/` is gitignored and untracked, so a fresh clone or
  // a CI runner has no such directory: a reverted `files: ["bridge/"]` whitelist
  // would emit no transcript paths, both "does not ship" assertions would pass
  // green, and the defect would ship. The guard has to supply its own subject
  // rather than depend on the developer's machine happening to hold one.
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    createdDir = true;
  }
  fs.writeFileSync(MARKER, JSON.stringify({ project: '__packaging-guard__' }));

  // --dry-run writes no tarball; --json gives the manifest rather than a
  // human-readable notice stream we would have to parse loosely.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  packedPaths = JSON.parse(raw)[0].files.map(f => f.path);
}, 130000);

afterAll(() => {
  // Remove only what this run created — a developer's real session history
  // lives here and must survive the test.
  try { fs.rmSync(MARKER, { force: true }); } catch { /* already gone */ }
  if (createdDir) {
    try { fs.rmdirSync(HISTORY_DIR); } catch { /* non-empty: leave it */ }
  }
});

describe('the published tarball (G8)', () => {
  it('reports a non-empty file list, so the assertions below are not vacuous', () => {
    // Without this, a packer change that returned nothing would turn every
    // "does not contain" assertion green while checking nothing at all.
    expect(packedPaths.length).toBeGreaterThan(20);
  });

  it('carries no session transcripts', () => {
    // The defect: transcripts are unfiltered raw PTY output by this project's
    // own security model, so they may echo .env values and keys verbatim.
    const leaked = packedPaths.filter(p => p.includes('.session-history'));
    expect(leaked, `session transcripts must not ship: ${leaked.join(', ')}`).toEqual([]);
  });

  it('carries no dotted directory under bridge/, which is how the transcripts got in', () => {
    // Generalized past the one instance: any bridge/.<something>/ is local
    // state that happens to live beside the source, and the next one will not
    // be named .session-history.
    const dotted = packedPaths.filter(p => /^bridge\/\.[^/]+\//.test(p));
    expect(dotted, `local state must not ship: ${dotted.join(', ')}`).toEqual([]);
  });

  it.each([
    'bridge/server.js',
    'bridge/v2/routes.js',
    'bridge/v2/sessions.js',
    'bridge/.env.example',
    'bridge/com.clawbridge.builder.plist',
    'package.json',
    'README.md',
    'CHANGELOG.md',
  ])('still ships %s', (required) => {
    // The other direction. A whitelist narrow enough to exclude transcripts can
    // just as easily exclude something the package needs to run, and that
    // failure is invisible until an operator installs it.
    expect(packedPaths).toContain(required);
  });

  it('still ships the broker test suites, which the previous whitelist included', () => {
    // Not a judgment that tests belong in a tarball — a record that removing
    // them is a deliberate packaging decision, not a side effect of editing
    // `files` for an unrelated reason.
    expect(packedPaths.some(p => p.startsWith('bridge/v2/__tests__/'))).toBe(true);
    expect(packedPaths.some(p => p.startsWith('bridge/__tests__/'))).toBe(true);
  });
});
