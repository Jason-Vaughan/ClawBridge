'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Validate a project name and optional project-relative subpath, returning
 * the resolved absolute path along with a verdict the caller acts on.
 *
 * This is the canonical security primitive for "the caller named a project
 * and possibly a path inside it; what's the safe absolute path I should
 * actually touch on disk?" — shared between the v1 `/projects/:project/files/*`
 * surface and v2's `/v2/session/file` so the rules don't drift.
 *
 * Validation layers (each rejects without touching disk):
 *   1. Project name: no `..`, no NUL, no path separator. Forces a single
 *      directory segment under `projectsDir`.
 *   2. Subpath (when supplied): no NUL, must be relative (not absolute).
 *   3. Lexical traversal: after resolving against the project dir, the result
 *      must still live under the project dir.
 *   4. Symlink traversal: after `realpath`, the result must still live under
 *      the real `projectsDir` (handles e.g. `/tmp` → `/private/tmp` on macOS).
 *      Missing files don't fail this check — callers handle 404 themselves.
 *
 * @param {string} projectsDir - Base directory containing all projects
 * @param {string} project - Project name from the request
 * @param {string} [subPath] - Optional project-relative path
 * @returns {{ valid: boolean, projectDir: string, resolvedPath: string, error?: string }}
 */
function validateProjectPath(projectsDir, project, subPath) {
  if (!project || project.includes('..') || project.includes('\0') || project.includes('/')) {
    return { valid: false, projectDir: '', resolvedPath: '', error: 'Invalid project name' };
  }

  const projectDir = path.join(projectsDir, project);

  if (!subPath) {
    return { valid: true, projectDir, resolvedPath: projectDir };
  }

  if (subPath.includes('\0') || path.isAbsolute(subPath)) {
    return { valid: false, projectDir, resolvedPath: '', error: 'Invalid path' };
  }

  const resolvedPath = path.resolve(projectDir, subPath);
  const resolvedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(resolvedProjectDir + path.sep) && resolvedPath !== resolvedProjectDir) {
    return { valid: false, projectDir, resolvedPath, error: 'Path escapes project directory' };
  }

  // Symlink escape: resolve both sides so `/tmp` vs `/private/tmp` style
  // platform aliasing doesn't false-positive. Missing target is fine — caller
  // distinguishes "validation passed but file is missing" via its own existence
  // check (returns 404), keeping the security verdict independent of presence.
  try {
    const real = fs.realpathSync(resolvedPath);
    const realProjectsDir = fs.realpathSync(projectsDir);
    if (!real.startsWith(realProjectsDir + path.sep) && !real.startsWith(realProjectsDir)) {
      return { valid: false, projectDir, resolvedPath, error: 'Symlink escapes allowed directory' };
    }
  } catch {
    // Target doesn't exist yet — that's OK.
  }

  return { valid: true, projectDir, resolvedPath };
}

module.exports = { validateProjectPath };
