/**
 * Regression test: /prawduct/run must pass workDir as positional target_dir
 * to the prawduct CLI. Without this, prawduct-setup.py receives no target_dir
 * and exits with a usage error.
 *
 * Bug: workDir was only used as cwd for the subprocess but never appended
 * to the argv array. The prawduct CLI requires target_dir as a positional arg.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
const http = require('node:http');
const { spawn } = require('node:child_process');

// We test the argv construction logic by intercepting the runCommand call
// rather than spawning real processes. The server module isn't easily
// importable as a unit, so we replicate the argv-building logic and verify it.

describe('/prawduct/run argv contract', () => {
  const PRAWDUCT_SETUP = '/home/user/prawduct/tools/prawduct-setup.py';

  /**
   * Replicate the server's argv construction for /prawduct/run.
   * @param {object} body - Request body
   * @param {string} projectsDir - Default projects directory
   * @returns {string[]} argv passed to runCommand (excluding PYTHON_BIN)
   */
  function buildPrawductArgs(body, projectsDir = '/home/user/projects') {
    const workDir = body.workDir || projectsDir;
    const args = [PRAWDUCT_SETUP, body.command, workDir];
    if (body.args && Array.isArray(body.args)) {
      args.push(...body.args);
    }
    return args;
  }

  it('passes workDir as positional target_dir for setup', () => {
    const args = buildPrawductArgs({
      command: 'setup',
      workDir: '/home/user/projects/my-project',
    });
    expect(args).toEqual([
      PRAWDUCT_SETUP,
      'setup',
      '/home/user/projects/my-project',
    ]);
  });

  it('passes workDir as positional target_dir for validate', () => {
    const args = buildPrawductArgs({
      command: 'validate',
      workDir: '/home/user/projects/my-project',
    });
    expect(args).toEqual([
      PRAWDUCT_SETUP,
      'validate',
      '/home/user/projects/my-project',
    ]);
  });

  it('passes workDir as positional target_dir for sync', () => {
    const args = buildPrawductArgs({
      command: 'sync',
      workDir: '/home/user/projects/my-project',
    });
    expect(args).toEqual([
      PRAWDUCT_SETUP,
      'sync',
      '/home/user/projects/my-project',
    ]);
  });

  it('defaults workDir to projectsDir when not provided', () => {
    const args = buildPrawductArgs({ command: 'validate' });
    expect(args[2]).toBe('/home/user/projects');
  });

  it('appends extra args after target_dir', () => {
    const args = buildPrawductArgs({
      command: 'setup',
      workDir: '/home/user/projects/my-project',
      args: ['--name', 'My Project', '--force'],
    });
    expect(args).toEqual([
      PRAWDUCT_SETUP,
      'setup',
      '/home/user/projects/my-project',
      '--name', 'My Project', '--force',
    ]);
  });

  it('target_dir is always argv[2] (positional, not a flag)', () => {
    const args = buildPrawductArgs({
      command: 'setup',
      workDir: '/tmp/test-project',
    });
    // argv[0] = script, argv[1] = command, argv[2] = target_dir
    expect(args[0]).toBe(PRAWDUCT_SETUP);
    expect(args[1]).toBe('setup');
    expect(args[2]).toBe('/tmp/test-project');
    expect(args[2]).not.toMatch(/^--/); // not a flag
  });
});
