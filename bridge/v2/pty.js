'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

/**
 * Try to load node-pty. Falls back to null if unavailable (e.g. sandbox).
 * @returns {object|null}
 */
function loadNodePty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

const nodePty = loadNodePty();

/**
 * Wrapper around node-pty (or child_process fallback) that provides a clean
 * event interface for spawning and interacting with PTY processes.
 *
 * In production (habitat), uses node-pty for full PTY semantics.
 * When node-pty is unavailable or usePipes option is set, falls back to
 * child_process.spawn with piped stdio.
 *
 * Events:
 *   'data'  — (data: string) raw process output
 *   'exit'  — ({ exitCode: number, signal?: number }) process exited
 *   'error' — (err: Error) spawn or runtime error
 */
class PtyProcess extends EventEmitter {
  /**
   * @param {string} command - Binary to spawn
   * @param {string[]} args - Arguments
   * @param {object} options
   * @param {string} [options.cwd] - Working directory
   * @param {Record<string, string>} [options.env] - Environment variables
   * @param {number} [options.cols] - Terminal columns (default 120)
   * @param {number} [options.rows] - Terminal rows (default 40)
   * @param {boolean} [options.usePipes] - Force child_process fallback (for testing)
   */
  constructor(command, args, options = {}) {
    super();
    this._command = command;
    this._args = args;
    this._options = options;
    this._process = null;
    this._exited = false;
    this._exitCode = null;
    this._usePty = !options.usePipes && nodePty !== null;
  }

  /**
   * Spawn the process.
   * @returns {PtyProcess} this (for chaining)
   */
  spawn() {
    if (this._process) {
      throw new Error('PTY already spawned');
    }

    const env = this._options.env || {
      ...process.env,
      PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    };
    const cwd = this._options.cwd || process.cwd();

    if (this._usePty) {
      this._spawnPty(env, cwd);
    } else {
      this._spawnPipes(env, cwd);
    }

    return this;
  }

  /**
   * Spawn using node-pty (full PTY semantics).
   * @private
   */
  _spawnPty(env, cwd) {
    try {
      const proc = nodePty.spawn(this._command, this._args, {
        name: 'xterm-256color',
        cols: this._options.cols || 120,
        rows: this._options.rows || 40,
        cwd,
        env,
      });

      this._process = proc;
      this._pid = proc.pid;

      proc.onData((data) => {
        this.emit('data', data);
      });

      proc.onExit(({ exitCode, signal }) => {
        this._exited = true;
        this._exitCode = exitCode;
        this.emit('exit', { exitCode, signal });
      });
    } catch (err) {
      this._exited = true;
      this._exitCode = 1;
      process.nextTick(() => this.emit('error', err));
    }
  }

  /**
   * Spawn using child_process (piped stdio fallback).
   * @private
   */
  _spawnPipes(env, cwd) {
    try {
      const child = spawn(this._command, this._args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._process = child;
      this._pid = child.pid;

      child.stdout.on('data', (data) => {
        this.emit('data', data.toString());
      });

      child.stderr.on('data', (data) => {
        this.emit('data', data.toString());
      });

      child.on('close', (code, signal) => {
        this._exited = true;
        this._exitCode = code ?? 1;
        this.emit('exit', { exitCode: code ?? 1, signal: signal ? 1 : undefined });
      });

      child.on('error', (err) => {
        this._exited = true;
        this._exitCode = 1;
        this.emit('error', err);
      });

      child.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
          this.emit('error', err);
        }
      });
    } catch (err) {
      this._exited = true;
      this._exitCode = 1;
      process.nextTick(() => this.emit('error', err));
    }
  }

  /**
   * Write data to the process stdin.
   * @param {string} data - Data to write
   */
  write(data) {
    if (!this._process) {
      throw new Error('PTY not spawned');
    }
    if (this._exited) {
      throw new Error('PTY already exited');
    }

    if (this._usePty) {
      this._process.write(data);
    } else {
      const stdin = this._process.stdin;
      if (!stdin || stdin.destroyed || stdin.closed) {
        return;
      }
      try {
        stdin.write(data);
      } catch (err) {
        if (err.code !== 'EPIPE') {
          throw err;
        }
      }
    }
  }

  /**
   * Send a kill signal to the process.
   * @param {string} [signal] - Signal name (default: SIGTERM)
   */
  kill(signal) {
    if (!this._process || this._exited) return;
    if (this._usePty) {
      this._process.kill(signal);
    } else {
      this._process.kill(signal || 'SIGTERM');
    }
  }

  /**
   * Destroy the process and release resources.
   * Kills the process if still running.
   */
  destroy() {
    if (!this._process) return;
    if (!this._exited) {
      try {
        if (this._usePty) {
          this._process.kill();
        } else {
          this._process.kill('SIGKILL');
        }
      } catch {
        // Process may already be dead
      }
    }
    this._process = null;
  }

  /**
   * Whether the process has exited.
   * @returns {boolean}
   */
  get exited() {
    return this._exited;
  }

  /**
   * The exit code (null if still running).
   * @returns {number|null}
   */
  get exitCode() {
    return this._exitCode;
  }

  /**
   * The PID of the underlying process (null if not spawned or destroyed).
   * @returns {number|null}
   */
  get pid() {
    if (this._process) {
      return this._pid || null;
    }
    return null;
  }
}

module.exports = { PtyProcess };
