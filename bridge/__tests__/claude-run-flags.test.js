import { describe, it, expect } from 'vitest';

/**
 * Tests the flag-filtering logic used by /claude/run.
 * Extracted here to validate behavior without hitting the HTTP server.
 */

/**
 * Replicate the flag-filtering logic from server.js /claude/run handler.
 * @param {string[]} flags - Raw flags from request body
 * @returns {string[]} Filtered args array (after --print --dangerously-skip-permissions)
 */
function filterFlags(flags) {
  const args = ['--print', '--dangerously-skip-permissions'];
  const booleanFlags = new Set(['--print', '--dangerously-skip-permissions', '--verbose']);
  const valueFlags = new Set(['--model', '--max-turns']);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (booleanFlags.has(flag)) {
      if (!args.includes(flag)) args.push(flag);
    } else if (valueFlags.has(flag)) {
      args.push(flag);
      if (i + 1 < flags.length) {
        args.push(flags[++i]);
      }
    } else if (valueFlags.has(flag.split('=')[0])) {
      args.push(flag);
    }
  }
  return args;
}

describe('/claude/run flag filtering', () => {
  it('passes --max-turns with its value as separate args', () => {
    const result = filterFlags(['--max-turns', '1']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--max-turns', '1']);
  });

  it('passes --model with its value as separate args', () => {
    const result = filterFlags(['--model', 'sonnet']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--model', 'sonnet']);
  });

  it('handles --flag=value form', () => {
    const result = filterFlags(['--max-turns=3']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--max-turns=3']);
  });

  it('handles --model=value form', () => {
    const result = filterFlags(['--model=opus']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--model=opus']);
  });

  it('does not duplicate --print if already in defaults', () => {
    const result = filterFlags(['--print']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('adds --verbose boolean flag', () => {
    const result = filterFlags(['--verbose']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--verbose']);
  });

  it('rejects unknown flags', () => {
    const result = filterFlags(['--unknown', '--evil-flag', 'value']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('handles mixed boolean and value flags', () => {
    const result = filterFlags(['--verbose', '--max-turns', '5', '--model', 'haiku']);
    expect(result).toEqual([
      '--print', '--dangerously-skip-permissions',
      '--verbose', '--max-turns', '5', '--model', 'haiku'
    ]);
  });

  it('handles value flag at end of array with no value (edge case)', () => {
    // --max-turns with no following value — flag is added but no value consumed
    const result = filterFlags(['--max-turns']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--max-turns']);
  });

  it('does not let unknown values slip through after a value flag', () => {
    // Ensures the value after --max-turns is consumed, and the next unknown is rejected
    const result = filterFlags(['--max-turns', '3', '--evil']);
    expect(result).toEqual(['--print', '--dangerously-skip-permissions', '--max-turns', '3']);
  });
});
