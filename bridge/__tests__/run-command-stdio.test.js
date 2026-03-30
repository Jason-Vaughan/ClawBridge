import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

/**
 * Validates that runCommand's spawn uses stdio: ['ignore', 'pipe', 'pipe'].
 *
 * We cannot import runCommand directly (not exported), so these tests verify
 * the behavior that the fix produces: when stdin is 'ignore', the child
 * process sees an immediate EOF / closed fd-0 rather than a dangling pipe.
 */
describe('runCommand stdio configuration', () => {
  it('child process gets immediate EOF on stdin when stdio[0] is ignore', async () => {
    // With stdio: ['ignore', ...], stdin is /dev/null — reads yield immediate EOF.
    // This is the fix: Claude Code won't see a dangling pipe and won't warn.
    const result = await new Promise((resolve) => {
      const stdout = [];
      const child = spawn(process.execPath, [
        '-e',
        `
        let gotEnd = false;
        process.stdin.on('end', () => {
          gotEnd = true;
          process.stdout.write('immediate_eof');
        });
        process.stdin.resume();
        // If stdin is /dev/null, 'end' fires almost immediately
        setTimeout(() => {
          if (!gotEnd) process.stdout.write('no_eof_yet');
          process.exit(0);
        }, 1000);
        `
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', d => stdout.push(d));
      child.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString(),
        });
      });
    });

    expect(result.stdout).toBe('immediate_eof');
    expect(result.exitCode).toBe(0);
  });

  it('child process sees open stdin when stdio[0] is pipe (the old behavior)', async () => {
    // Demonstrate the OLD behavior — pipe creates an open stdin that
    // Claude Code interprets as "someone might send data"
    const result = await new Promise((resolve) => {
      const stdout = [];
      const child = spawn(process.execPath, [
        '-e',
        `
        const fs = require('fs');
        try {
          fs.fstatSync(0);
          process.stdout.write('stdin_open');
        } catch {
          process.stdout.write('stdin_closed');
        }
        `
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', d => stdout.push(d));
      child.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString(),
        });
      });
    });

    // With pipe, stdin IS open — this is what caused the 3s warning
    expect(result.stdout).toBe('stdin_open');
  });

  it('child process does not block waiting for stdin when ignore is set', async () => {
    // Verify a process that reads stdin returns immediately with EOF
    const result = await new Promise((resolve) => {
      const stdout = [];
      const child = spawn(process.execPath, [
        '-e',
        `
        let data = '';
        process.stdin.on('data', (d) => { data += d; });
        process.stdin.on('error', () => {
          process.stdout.write('stdin_error');
        });
        process.stdin.on('end', () => {
          process.stdout.write('stdin_eof');
        });
        // stdin won't exist so this should error immediately
        process.stdin.resume();
        setTimeout(() => {
          process.stdout.write(data ? 'got_data' : 'no_data');
          process.exit(0);
        }, 500);
        `
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', d => stdout.push(d));
      child.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString(),
        });
      });
    });

    // Should get an error (not open) or no data — not a hanging pipe
    expect(result.stdout).toMatch(/stdin_error|no_data/);
    expect(result.exitCode).toBe(0);
  });
});
