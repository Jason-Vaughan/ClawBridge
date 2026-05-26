'use strict';

/**
 * Ensure node-pty's spawn-helper binaries are executable.
 *
 * node-pty ships prebuilt helper binaries that get invoked via posix_spawnp.
 * On macOS the +x bit can be lost during the npm install tarball extraction
 * (or by certain filesystem/sync tools later), which causes posix_spawnp to
 * fail with no actionable error and ClawBridge sessions appear to start but
 * immediately transition to `failed` with an empty transcript. This script
 * restores the exec bit on the darwin helpers right after install so fresh
 * deployments work without a manual chmod step. No-op on other platforms or
 * when node-pty isn't present.
 */

const fs = require('node:fs');
const path = require('node:path');

try {
  const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
  const archs = ['darwin-arm64', 'darwin-x64'];
  for (const arch of archs) {
    const helper = path.join(nodePtyDir, 'prebuilds', arch, 'spawn-helper');
    try {
      fs.chmodSync(helper, 0o755);
    } catch {
      // Helper for this arch isn't present (e.g. running on linux), no-op.
    }
  }
} catch {
  // node-pty not resolvable from here — installer state is unusual but
  // not our problem; bridge startup will warn at runtime if node-pty is missing.
}
