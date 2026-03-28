import { describe, it, expect, afterEach } from 'vitest';

const { PtyProcess } = require('../pty');

// Use piped stdio fallback — node-pty requires PTY allocation which
// may not be available in sandboxed/CI environments.
const OPTS = { usePipes: true };

describe('PtyProcess', () => {
  const ptys = [];

  /** Helper to track PTYs for cleanup */
  function createPty(cmd, args, opts = {}) {
    const p = new PtyProcess(cmd, args, { ...OPTS, ...opts });
    ptys.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of ptys) {
      p.destroy();
    }
    ptys.length = 0;
  });

  it('spawns a process and captures exit code 0', async () => {
    const p = createPty('/bin/echo', ['hello']);
    p.spawn();

    expect(p.pid).toBeGreaterThan(0);
    expect(p.exited).toBe(false);

    const result = await new Promise((resolve) => {
      p.on('exit', resolve);
    });

    expect(result.exitCode).toBe(0);
    expect(p.exited).toBe(true);
    expect(p.exitCode).toBe(0);
  });

  it('captures data from process stdout', async () => {
    const chunks = [];
    const p = createPty('/bin/echo', ['test-data-123']);
    p.on('data', (data) => chunks.push(data));
    p.spawn();

    await new Promise((resolve) => p.on('exit', resolve));

    const output = chunks.join('');
    expect(output).toContain('test-data-123');
  });

  it('writes to stdin of a process', async () => {
    const chunks = [];
    const p = createPty('/bin/cat', []);
    p.on('data', (data) => chunks.push(data));
    p.spawn();

    p.write('hello from stdin\n');

    // Wait a bit for cat to echo
    await new Promise((resolve) => setTimeout(resolve, 200));

    const output = chunks.join('');
    expect(output).toContain('hello from stdin');

    // Close cat's stdin to let it exit
    p._process.stdin.end();

    await new Promise((resolve) => {
      if (p.exited) return resolve();
      p.on('exit', resolve);
    });

    expect(p.exited).toBe(true);
  });

  it('handles process exit with non-zero code', async () => {
    const p = createPty('/bin/sh', ['-c', 'exit 42']);
    p.spawn();

    const result = await new Promise((resolve) => {
      p.on('exit', resolve);
    });

    expect(result.exitCode).toBe(42);
    expect(p.exitCode).toBe(42);
  });

  it('handles kill signal', async () => {
    const p = createPty('/bin/cat', []);
    p.spawn();

    // Give it a moment to fully start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(p.exited).toBe(false);
    p.kill();

    await new Promise((resolve) => {
      if (p.exited) return resolve();
      p.on('exit', resolve);
    });

    expect(p.exited).toBe(true);
  });

  it('throws when writing to unspawned PTY', () => {
    const p = createPty('/bin/echo', ['test']);
    expect(() => p.write('data')).toThrow('PTY not spawned');
  });

  it('throws when spawning twice', () => {
    const p = createPty('/bin/cat', []);
    p.spawn();
    expect(() => p.spawn()).toThrow('PTY already spawned');
  });

  it('throws when writing to exited PTY', async () => {
    const p = createPty('/bin/echo', ['done']);
    p.spawn();

    await new Promise((resolve) => p.on('exit', resolve));

    expect(() => p.write('data')).toThrow('PTY already exited');
  });

  it('destroy kills running process and cleans up', async () => {
    const p = createPty('/bin/cat', []);
    p.spawn();

    const pid = p.pid;
    expect(pid).toBeGreaterThan(0);

    p.destroy();

    // After destroy, pid should be null
    expect(p.pid).toBeNull();
  });

  it('destroy is safe to call multiple times', () => {
    const p = createPty('/bin/echo', ['test']);
    p.spawn();
    p.destroy();
    p.destroy(); // Should not throw
  });

  it('destroy is safe on unspawned PTY', () => {
    const p = createPty('/bin/echo', ['test']);
    p.destroy(); // Should not throw
  });

  it('supports concurrent PTY processes', async () => {
    const p1 = createPty('/bin/echo', ['proc-1']);
    const p2 = createPty('/bin/echo', ['proc-2']);

    const chunks1 = [];
    const chunks2 = [];

    p1.on('data', (d) => chunks1.push(d));
    p2.on('data', (d) => chunks2.push(d));

    p1.spawn();
    p2.spawn();

    expect(p1.pid).not.toBe(p2.pid);

    await Promise.all([
      new Promise((resolve) => p1.on('exit', resolve)),
      new Promise((resolve) => p2.on('exit', resolve)),
    ]);

    expect(chunks1.join('')).toContain('proc-1');
    expect(chunks2.join('')).toContain('proc-2');
  });
});
