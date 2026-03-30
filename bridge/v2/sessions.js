'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { PtyProcess } = require('./pty');
const { SessionState, VALID_TRANSITIONS, TERMINAL_STATES, EventKind, DecisionType, PolicyAction, ErrorCode } = require('./types');
const { EventLog } = require('./event-log');
const { PermissionParser } = require('./permission-parser');
const { validateEnvelope, evaluatePermission } = require('./policy');

/** Default prompt-wait timeout: 5 minutes */
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** Default session runtime timeout: 30 minutes */
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Grace period for graceful shutdown before SIGKILL: 5 seconds */
const GRACEFUL_SHUTDOWN_MS = 5000;

/**
 * A single v2 session — PTY-backed Claude Code process for one project.
 */
class Session {
  /**
   * @param {string} sessionId
   * @param {string} project - Project name
   * @param {string} projectDir - Absolute path to project directory
   */
  constructor(sessionId, project, projectDir) {
    this.sessionId = sessionId;
    this.project = project;
    this.projectDir = projectDir;
    this.state = SessionState.STARTING;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.pty = null;
    this.exitCode = null;
    /** @type {EventLog} */
    this.eventLog = new EventLog();
    /** @type {PermissionParser|null} */
    this.permissionParser = null;
    /** @type {object|null} Currently pending permission event */
    this.pendingPermission = null;
    /** @type {object|null} Approval envelope for policy evaluation */
    this.approvalEnvelope = null;

    // Timeout configuration
    /** @type {number} Prompt-wait timeout in ms (default 5 min) */
    this.promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS;
    /** @type {number} Session runtime timeout in ms (default 30 min) */
    this.sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;

    // Timer handles
    /** @type {NodeJS.Timeout|null} */
    this._promptTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._sessionTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._killTimer = null;
  }

  /**
   * Start the prompt-wait timer. Auto-denies pending permission on expiry.
   * @param {function} onTimeout - Callback invoked when timer fires
   */
  startPromptTimer(onTimeout) {
    this.clearPromptTimer();
    this._promptTimer = setTimeout(() => {
      this._promptTimer = null;
      onTimeout();
    }, this.promptTimeoutMs);
  }

  /**
   * Clear the prompt-wait timer.
   */
  clearPromptTimer() {
    if (this._promptTimer) {
      clearTimeout(this._promptTimer);
      this._promptTimer = null;
    }
  }

  /**
   * Start the session runtime timer. Fires when session exceeds runtime limit.
   * @param {function} onTimeout - Callback invoked when timer fires
   */
  startSessionTimer(onTimeout) {
    this.clearSessionTimer();
    this._sessionTimer = setTimeout(() => {
      this._sessionTimer = null;
      onTimeout();
    }, this.sessionTimeoutMs);
  }

  /**
   * Clear the session runtime timer.
   */
  clearSessionTimer() {
    if (this._sessionTimer) {
      clearTimeout(this._sessionTimer);
      this._sessionTimer = null;
    }
  }

  /**
   * Clear all timers (prompt, session, kill).
   */
  clearAllTimers() {
    this.clearPromptTimer();
    this.clearSessionTimer();
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
  }

  /**
   * Transition session to a new state. Throws if the transition is invalid.
   * @param {string} newState - Target state from SessionState
   * @returns {string} The new state
   */
  transition(newState) {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.has(newState)) {
      throw new Error(`Invalid transition: ${this.state} -> ${newState}`);
    }
    const fromState = this.state;
    this.state = newState;
    this.updatedAt = new Date().toISOString();
    this.eventLog.appendLifecycle(fromState, newState);
    return this.state;
  }

  /**
   * Whether this session is in a terminal state.
   * @returns {boolean}
   */
  get isTerminal() {
    return TERMINAL_STATES.has(this.state);
  }

  /**
   * Serialize session to a plain object (for API responses).
   * @returns {object}
   */
  toJSON() {
    const obj = {
      sessionId: this.sessionId,
      project: this.project,
      state: this.state,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      exitCode: this.exitCode,
      cursor: this.eventLog.cursor,
      pendingPermissionId: this.pendingPermission ? this.pendingPermission.id : null,
    };
    if (this.pendingPermission && this.pendingPermission.timeoutAt) {
      obj.permissionTimeoutAt = this.pendingPermission.timeoutAt;
    }
    return obj;
  }
}

/**
 * Manages v2 PTY-backed sessions. Enforces one active session per project.
 */
class SessionManager {
  /**
   * @param {object} options
   * @param {string} options.projectsDir - Base directory for projects
   * @param {string} options.claudeBin - Path to Claude Code binary
   * @param {boolean} [options.usePipes] - Use piped stdio instead of PTY (for testing)
   * @param {number} [options.promptTimeoutMs] - Default prompt-wait timeout (ms)
   * @param {number} [options.sessionTimeoutMs] - Default session runtime timeout (ms)
   */
  constructor(options) {
    this._projectsDir = options.projectsDir;
    this._claudeBin = options.claudeBin;
    this._usePipes = options.usePipes || false;
    this._defaultPromptTimeoutMs = options.promptTimeoutMs || DEFAULT_PROMPT_TIMEOUT_MS;
    this._defaultSessionTimeoutMs = options.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;
    /** @type {Map<string, Session>} keyed by project name */
    this._sessions = new Map();
    /** @type {string|null} Directory for persisting session history */
    this._historyDir = options.historyDir || null;
    /** @type {Map<string, object>} Last completed session snapshot per project */
    this._history = new Map();
    /** Maximum history entries to keep per project (only last N are on disk) */
    this._maxHistory = options.maxHistory || 1;

    // Load history from disk on startup
    if (this._historyDir) {
      this._loadHistory();
    }
  }

  /**
   * Load session history from disk.
   * @private
   */
  _loadHistory() {
    if (!this._historyDir) return;
    try {
      if (!fs.existsSync(this._historyDir)) return;
      const files = fs.readdirSync(this._historyDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this._historyDir, file), 'utf8'));
          if (data.project) {
            this._history.set(data.project, data);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* directory unreadable */ }
  }

  /**
   * Snapshot a completed session and persist to disk.
   * @param {Session} session
   */
  _snapshotSession(session) {
    const { detectTestResult } = require('./routes');
    const snapshot = {
      sessionId: session.sessionId,
      project: session.project,
      state: session.state,
      exitCode: session.exitCode,
      startedAt: session.createdAt,
      endedAt: session.updatedAt,
      cursor: session.eventLog.cursor,
      transcript: session.eventLog.getTranscript(),
      testResult: detectTestResult(session.eventLog),
      eventCount: session.eventLog.length,
    };
    this._history.set(session.project, snapshot);

    // Persist to disk
    if (this._historyDir) {
      try {
        if (!fs.existsSync(this._historyDir)) {
          fs.mkdirSync(this._historyDir, { recursive: true });
        }
        const filename = `${session.project}.json`;
        fs.writeFileSync(
          path.join(this._historyDir, filename),
          JSON.stringify(snapshot, null, 2)
        );
      } catch (err) {
        console.error(`[v2/history] Failed to persist snapshot for ${session.project}:`, err.message);
      }
    }
  }

  /**
   * Get the last completed session snapshot for a project.
   * @param {string} project
   * @returns {object|null}
   */
  getLastCompleted(project) {
    return this._history.get(project) || null;
  }

  /**
   * List all projects with completed session history.
   * @returns {string[]}
   */
  listHistory() {
    return Array.from(this._history.keys());
  }

  /**
   * Start a new PTY-backed session for a project.
   * @param {string} project - Project name
   * @param {object} [options]
   * @param {string} [options.instruction] - Initial instruction to send after spawn
   * @param {object} [options.approvalEnvelope] - Approval envelope for policy evaluation
   * @param {number} [options.timeout] - Session runtime timeout (ms)
   * @param {number} [options.promptTimeout] - Prompt-wait timeout (ms)
   * @returns {Session}
   */
  start(project, options = {}) {
    if (this._sessions.has(project)) {
      const existing = this._sessions.get(project);
      // Allow starting a new session if previous one is in any terminal state
      // (completed, failed, timed_out, ended). Only block if actively running.
      if (!existing.isTerminal) {
        const err = new Error(`Session already exists for project '${project}' (state: ${existing.state})`);
        err.code = 'SESSION_EXISTS';
        throw err;
      }
    }

    const claudeSessionId = crypto.randomUUID();
    const sessionId = `sess_${claudeSessionId.replace(/-/g, '').slice(0, 12)}`;
    const projectDir = path.join(this._projectsDir, project);

    // Ensure project directory exists
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const session = new Session(sessionId, project, projectDir);
    session.claudeSessionId = claudeSessionId;

    // Configure timeouts
    session.promptTimeoutMs = options.promptTimeout || this._defaultPromptTimeoutMs;
    session.sessionTimeoutMs = options.timeout || this._defaultSessionTimeoutMs;

    // Store approval envelope if provided and valid
    if (options.approvalEnvelope) {
      const validation = validateEnvelope(options.approvalEnvelope);
      if (!validation.valid) {
        const err = new Error(`Invalid approval envelope: ${validation.error}`);
        err.code = 'INVALID_ENVELOPE';
        throw err;
      }
      session.approvalEnvelope = options.approvalEnvelope;
    }

    // Spawn Claude Code in PTY — use the real UUID for --session-id
    const args = ['--session-id', claudeSessionId];
    if (options.instruction) {
      args.push(options.instruction);
    }

    const ptyProc = new PtyProcess(this._claudeBin, args, {
      cwd: projectDir,
      usePipes: this._usePipes,
    });

    session.pty = ptyProc;

    // Create permission parser for this session
    session.permissionParser = new PermissionParser({
      projectRoot: projectDir,
      sessionId: session.sessionId,
      project,
      onPermission: (permEvent) => {
        // Evaluate permission against approval envelope
        const policyResult = evaluatePermission(permEvent, session.approvalEnvelope);
        permEvent.policyEvaluation = {
          matchedRule: policyResult.matchedRule,
          suggestedDecision: policyResult.action === PolicyAction.AUTO_APPROVE ? 'approve_once'
            : policyResult.action === PolicyAction.DENY ? 'deny' : null,
          reason: policyResult.reason,
        };

        // Append permission event to the event log
        session.eventLog.append(EventKind.PERMISSION, { event: permEvent });

        if (policyResult.action === PolicyAction.AUTO_APPROVE) {
          // Auto-approve: log decision, reset parser, then send Enter after
          // a short delay to let the interactive menu finish rendering.
          // Claude Code's TUI renders permission menus asynchronously —
          // sending \r immediately can arrive before the menu is ready.
          session.eventLog.append(EventKind.DECISION, {
            permissionId: permEvent.id,
            decision: DecisionType.APPROVE_ONCE,
            actor: 'policy',
            reason: policyResult.reason,
          });
          session.permissionParser.reset();
          setTimeout(() => {
            try {
              if (session.pty && !session.pty.exited) {
                session.pty.write('\r'); // Enter to confirm pre-selected "Yes"
              }
            } catch { /* PTY may have exited */ }
          }, 500);
        } else if (policyResult.action === PolicyAction.DENY) {
          // Auto-deny: send Escape after a short delay (same reason as above)
          session.eventLog.append(EventKind.DECISION, {
            permissionId: permEvent.id,
            decision: DecisionType.DENY,
            actor: 'policy',
            reason: policyResult.reason,
          });
          session.permissionParser.reset();
          setTimeout(() => {
            try {
              if (session.pty && !session.pty.exited) {
                session.pty.write('\x1b'); // Escape to cancel
              }
            } catch { /* PTY may have exited */ }
          }, 500);
        } else {
          // Require review: pause for human/NHE-ITL decision
          permEvent.timeoutAt = new Date(Date.now() + session.promptTimeoutMs).toISOString();
          session.pendingPermission = permEvent;
          if (session.state === SessionState.RUNNING) {
            session.transition(SessionState.WAITING_FOR_PERMISSION);
          }

          // Start prompt-wait timer
          session.startPromptTimer(() => {
            this._handlePromptTimeout(session);
          });
        }
      },
    });

    // Track whether the workspace trust prompt has been handled
    let trustPromptHandled = false;
    let trustBuffer = '';
    // Secondary trust detection: after the safety valve fires, keep checking
    // incoming data for trust prompt text for a grace period. Without this,
    // if startup ANSI output exceeds the safety valve threshold before the
    // trust prompt renders, the prompt goes to the permission parser and gets
    // misclassified as "unknown" (because "Esc to cancel" matches CONFIRMATION_PATTERN).
    let trustGraceActive = false;
    let trustGraceTimeout = null;
    const TRUST_GRACE_MS = 5000;
    const TRUST_PATTERN = /(?:one you trust|trust this (?:project|folder)|I trust this folder|safety check)/i;

    /**
     * Strip ANSI codes from a string for trust prompt matching.
     * @param {string} str
     * @returns {string}
     */
    const stripForTrust = (str) => str
      .replace(/\x1b\[\d*C/g, ' ')
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r/g, '');

    /**
     * Auto-confirm the trust prompt and suppress it from the parser.
     */
    const confirmTrust = () => {
      if (trustGraceTimeout) {
        clearTimeout(trustGraceTimeout);
        trustGraceTimeout = null;
      }
      trustGraceActive = false;
      setTimeout(() => {
        try {
          if (!ptyProc.exited) {
            ptyProc.write('\r');
          }
        } catch { /* PTY may have exited */ }
      }, 500);
    };

    // Wire PTY stdout into event log as text events and permission parser
    ptyProc.on('data', (data) => {
      session.eventLog.appendText(data);

      // Auto-confirm Claude Code's workspace trust prompt
      // Prompt text: "Is this a project you created or one you trust?"
      // Data may arrive in chunks, so accumulate into a buffer for the first few seconds.
      // If the trust prompt never appears (project already trusted), the safety valve
      // flushes accumulated data to the permission parser so no prompts are missed.
      if (!trustPromptHandled) {
        trustBuffer += data;
        const clean = stripForTrust(trustBuffer);
        // Also detect that startup is complete: if we see the instruction echo,
        // a Write/Edit/Bash tool call, or "Cooking"/"thinking" — trust was skipped
        if (/(?:Write\(|Edit\(|Bash\(|Cooking|thinking)/i.test(clean)) {
          trustPromptHandled = true;
          const flushed = trustBuffer;
          trustBuffer = '';
          // Feed the accumulated buffer to the permission parser
          if (!session.isTerminal && session.state !== SessionState.WAITING_FOR_PERMISSION) {
            session.permissionParser.feed(flushed);
          }
          return; // Current chunk already included in flushed buffer
        }
        if (TRUST_PATTERN.test(clean)) {
          trustPromptHandled = true;
          trustBuffer = '';
          // Trust prompt is an interactive menu with "Yes" pre-selected (❯).
          // Just press Enter to confirm — do NOT send "1\n" which types into the menu.
          confirmTrust();
          return; // Don't feed trust prompt to permission parser
        }
        // Safety valve: stop buffering after 8KB if trust prompt never appears.
        // Increased from 2KB because Claude Code's startup ANSI output (status bars,
        // cursor positioning, etc.) can exceed 2KB before the trust prompt renders,
        // causing the trust prompt to be misclassified as an unknown permission.
        // After the valve fires, a grace period continues watching for the trust prompt
        // in subsequent chunks — if it arrives, we auto-confirm and suppress it.
        if (trustBuffer.length > 8192) {
          trustPromptHandled = true;
          trustGraceActive = true;
          const flushed = trustBuffer;
          trustBuffer = '';
          // Feed the accumulated buffer to the permission parser
          if (!session.isTerminal && session.state !== SessionState.WAITING_FOR_PERMISSION) {
            session.permissionParser.feed(flushed);
          }
          // Start grace timer — stop checking for trust after TRUST_GRACE_MS
          trustGraceTimeout = setTimeout(() => {
            trustGraceActive = false;
            trustGraceTimeout = null;
          }, TRUST_GRACE_MS);
          return; // Current chunk already included in flushed buffer
        }
        return; // Still buffering for trust prompt detection
      }

      // Secondary trust detection: if the safety valve fired but we're still
      // in the grace period, check incoming data for trust prompt text.
      // This catches the case where startup ANSI output exceeded the valve
      // but the trust prompt hadn't rendered yet.
      if (trustGraceActive) {
        const clean = stripForTrust(data);
        if (TRUST_PATTERN.test(clean)) {
          trustGraceActive = false;
          // Reset the permission parser — it may have buffered trust prompt
          // fragments that would trigger a false unknown detection
          session.permissionParser.reset();
          confirmTrust();
          return; // Don't feed trust prompt to permission parser
        }
      }

      // Feed data to permission parser for prompt detection
      if (!session.isTerminal && session.state !== SessionState.WAITING_FOR_PERMISSION) {
        session.permissionParser.feed(data);
      }
    });

    // Wire PTY events to session state — emit error events on unexpected death
    ptyProc.on('exit', ({ exitCode, signal }) => {
      session.exitCode = exitCode;
      session.clearAllTimers();

      if (session.state === SessionState.RUNNING || session.state === SessionState.STARTING) {
        if (exitCode === 0) {
          session.transition(SessionState.COMPLETED);
        } else {
          // Unexpected exit — emit error event before transitioning
          session.eventLog.append(EventKind.ERROR, {
            code: ErrorCode.PTY_EXIT_UNEXPECTED,
            message: `Claude Code PTY exited unexpectedly (exit code: ${exitCode}${signal ? ', signal: ' + signal : ''})`,
            details: { exitCode, signal: signal || null },
          });
          session.transition(SessionState.FAILED);
        }
      } else if (session.state === SessionState.WAITING_FOR_PERMISSION) {
        // PTY died while waiting for permission — emit error event
        session.eventLog.append(EventKind.ERROR, {
          code: ErrorCode.PTY_EXIT_UNEXPECTED,
          message: `Claude Code PTY exited while waiting for permission (exit code: ${exitCode}${signal ? ', signal: ' + signal : ''})`,
          details: { exitCode, signal: signal || null },
        });
        session.pendingPermission = null;
        session.transition(SessionState.FAILED);
      }

      // Snapshot completed session for post-run retrieval
      if (session.isTerminal) {
        this._snapshotSession(session);
      }
    });

    ptyProc.on('error', (err) => {
      session.clearAllTimers();
      if (!session.isTerminal) {
        session.eventLog.append(EventKind.ERROR, {
          code: ErrorCode.PTY_EXIT_UNEXPECTED,
          message: `PTY error: ${err.message}`,
          details: { error: err.message },
        });
        try {
          session.transition(SessionState.FAILED);
        } catch {
          // Already in a terminal state
        }
      }
    });

    // Transition from starting → running BEFORE spawning PTY.
    // This ensures the lifecycle event is always the first event (seq 0)
    // in the output stream — PTY data events won't race ahead of it.
    session.transition(SessionState.RUNNING);

    ptyProc.spawn();

    // Start session runtime timer
    session.startSessionTimer(() => {
      this._handleSessionTimeout(session);
    });

    this._sessions.set(project, session);
    return session;
  }

  /**
   * Handle prompt-wait timeout: auto-deny and emit error event.
   * @private
   * @param {Session} session
   */
  _handlePromptTimeout(session) {
    if (session.isTerminal || session.state !== SessionState.WAITING_FOR_PERMISSION) {
      return;
    }

    const pendingId = session.pendingPermission ? session.pendingPermission.id : null;

    // Emit error event
    session.eventLog.append(EventKind.ERROR, {
      code: ErrorCode.PERMISSION_TIMEOUT,
      message: `Permission prompt timed out after ${session.promptTimeoutMs}ms — auto-denying`,
      details: { permissionId: pendingId, timeoutMs: session.promptTimeoutMs },
    });

    // Log the denial decision
    session.eventLog.append(EventKind.DECISION, {
      permissionId: pendingId,
      decision: DecisionType.DENY,
      actor: 'timeout',
      reason: 'Prompt-wait timeout exceeded — auto-denied',
    });

    // Clear pending permission and reset parser
    session.pendingPermission = null;
    if (session.permissionParser) {
      session.permissionParser.reset();
    }

    // Send denial to PTY stdin (Escape to cancel the interactive menu)
    try {
      if (session.pty && !session.pty.exited) {
        session.pty.write('\x1b');
      }
    } catch { /* PTY may have exited */ }

    // Transition back to running (Claude Code may continue after denial)
    try {
      session.transition(SessionState.RUNNING);
    } catch {
      // May already be in a different state if PTY exited concurrently
    }
  }

  /**
   * Handle session runtime timeout: graceful interruption then kill.
   * @private
   * @param {Session} session
   */
  _handleSessionTimeout(session) {
    if (session.isTerminal) {
      return;
    }

    // Clear prompt timer if active
    session.clearPromptTimer();

    // Emit error event
    session.eventLog.append(EventKind.ERROR, {
      code: ErrorCode.SESSION_RUNTIME_TIMEOUT,
      message: `Session exceeded runtime timeout of ${session.sessionTimeoutMs}ms`,
      details: { timeoutMs: session.sessionTimeoutMs },
    });

    // Attempt graceful interruption (SIGINT)
    if (session.pty && !session.pty.exited) {
      try {
        session.pty.kill('SIGINT');
      } catch { /* ignore */ }

      // Set a kill timer — force kill if not exited after grace period
      session._killTimer = setTimeout(() => {
        session._killTimer = null;
        if (session.pty && !session.pty.exited) {
          try {
            session.pty.kill('SIGKILL');
          } catch { /* ignore */ }
        }
        // Transition to timed_out if still not in a terminal state
        if (!session.isTerminal) {
          session.pendingPermission = null;
          try {
            session.transition(SessionState.TIMED_OUT);
          } catch { /* ignore */ }
        }
      }, GRACEFUL_SHUTDOWN_MS);
    } else {
      // PTY already exited — just transition
      session.pendingPermission = null;
      if (!session.isTerminal) {
        try {
          session.transition(SessionState.TIMED_OUT);
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Get a session by project name.
   * @param {string} project
   * @returns {Session|undefined}
   */
  get(project) {
    return this._sessions.get(project);
  }

  /**
   * List all sessions.
   * @returns {Session[]}
   */
  list() {
    return Array.from(this._sessions.values());
  }

  /**
   * Send a message/instruction to a running session's PTY stdin.
   * Does NOT auto-start sessions — returns 404 if none exists.
   * @param {string} project - Project name
   * @param {string} message - Message to write to PTY stdin
   * @returns {{ accepted: boolean, cursor: number, sessionId: string, state: string }}
   */
  send(project, message) {
    const session = this._sessions.get(project);
    if (!session) {
      const err = new Error(`No session for project '${project}'`);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Session already ended
    if (session.state === SessionState.ENDED) {
      const err = new Error(`Session for project '${project}' has already ended`);
      err.code = 'SESSION_ENDED';
      throw err;
    }

    // Session in a terminal state but not yet ended
    if (TERMINAL_STATES.has(session.state)) {
      const err = new Error(`Session for project '${project}' is in terminal state '${session.state}'`);
      err.code = 'SESSION_ENDED';
      throw err;
    }

    // Cannot send while waiting for permission
    if (session.state === SessionState.WAITING_FOR_PERMISSION) {
      const err = new Error(`Session for project '${project}' is waiting for a permission response — cannot send`);
      err.code = 'SESSION_NOT_WRITABLE';
      throw err;
    }

    // Write message to PTY stdin.
    // Use \r (Enter/Return) to submit in Claude Code's interactive TUI,
    // not \n (newline) which doesn't trigger form submission.
    if (session.pty && !session.pty.exited) {
      session.pty.write(message + '\r');
    }

    return {
      accepted: true,
      cursor: session.eventLog.cursor,
      sessionId: session.sessionId,
      state: session.state,
    };
  }

  /**
   * Respond to a pending permission prompt.
   * Writes the decision to PTY stdin and transitions the session back to running.
   * @param {string} project - Project name
   * @param {string} permissionId - ID of the pending permission event
   * @param {string} decision - Decision from DecisionType (approve_once, deny, abort_session)
   * @param {object} [options]
   * @param {string} [options.reason] - Optional reason for the decision
   * @param {string} [options.actor] - Who made the decision (default: 'nhe-itl')
   * @returns {object} The decision event
   */
  respond(project, permissionId, decision, options = {}) {
    const session = this._sessions.get(project);
    if (!session) {
      const err = new Error(`No session for project '${project}'`);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Session already ended
    if (session.state === SessionState.ENDED) {
      const err = new Error(`Session for project '${project}' has already ended`);
      err.code = 'SESSION_ENDED';
      throw err;
    }

    // Session in a terminal state but not yet ended
    if (TERMINAL_STATES.has(session.state) && session.state !== SessionState.ENDED) {
      const err = new Error(`Session for project '${project}' is in terminal state '${session.state}'`);
      err.code = 'SESSION_ENDED';
      throw err;
    }

    // Session not waiting for permission
    if (session.state !== SessionState.WAITING_FOR_PERMISSION) {
      const err = new Error(`Session for project '${project}' is not waiting for a permission response (state: ${session.state})`);
      err.code = 'PERMISSION_ALREADY_RESOLVED';
      throw err;
    }

    // Verify permission ID matches
    if (!session.pendingPermission || session.pendingPermission.id !== permissionId) {
      const err = new Error(`Permission '${permissionId}' does not match pending permission`);
      err.code = 'PERMISSION_NOT_FOUND';
      throw err;
    }

    // Validate decision
    const validDecisions = new Set(Object.values(DecisionType));
    if (!validDecisions.has(decision)) {
      const err = new Error(`Invalid decision '${decision}'. Must be one of: ${[...validDecisions].join(', ')}`);
      err.code = 'INVALID_DECISION';
      throw err;
    }

    const actor = options.actor || 'nhe-itl';
    const reason = options.reason || null;

    // Clear prompt timer — response received in time
    session.clearPromptTimer();

    // Handle abort_session — kill the PTY
    if (decision === DecisionType.ABORT_SESSION) {
      const decisionEvent = session.eventLog.append(EventKind.DECISION, {
        permissionId,
        decision,
        actor,
        reason,
      });

      session.pendingPermission = null;
      session.permissionParser.reset();

      // Kill the PTY process
      if (session.pty && !session.pty.exited) {
        session.pty.kill();
      }

      // Transition to failed
      try {
        session.transition(SessionState.FAILED);
      } catch {
        // Already transitioned via exit handler
      }

      return decisionEvent;
    }

    // Handle approve_once / deny — Claude Code v2.1.81+ uses interactive menus
    // for permission prompts (not y/n text input). Send Enter (\r) for the
    // pre-selected option, or navigate with arrow keys first if needed.
    // "Yes, allow this once" is typically pre-selected for approve.
    // For deny, press Escape to cancel the prompt.
    const decisionEvent = session.eventLog.append(EventKind.DECISION, {
      permissionId,
      decision,
      actor,
      reason,
    });

    // Clear pending permission and reset parser before writing to PTY
    // so new output can be parsed for the next permission prompt
    session.pendingPermission = null;
    session.permissionParser.reset();

    // Write response to PTY stdin
    if (session.pty && !session.pty.exited) {
      if (decision === DecisionType.APPROVE_ONCE) {
        // "Yes" is pre-selected — press Enter to confirm
        session.pty.write('\r');
      } else {
        // Deny — press Escape to cancel the permission prompt
        session.pty.write('\x1b');
      }
    }

    // Transition back to running
    session.transition(SessionState.RUNNING);

    return decisionEvent;
  }

  /**
   * Update the approval envelope for an active session.
   * Takes effect on the next permission prompt.
   * @param {string} project - Project name
   * @param {object} envelope - New approval envelope
   * @returns {Session}
   */
  updatePolicy(project, envelope) {
    const session = this._sessions.get(project);
    if (!session) {
      const err = new Error(`No session for project '${project}'`);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    if (session.isTerminal) {
      const err = new Error(`Session for project '${project}' is in terminal state '${session.state}'`);
      err.code = 'SESSION_ENDED';
      throw err;
    }

    const validation = validateEnvelope(envelope);
    if (!validation.valid) {
      const err = new Error(`Invalid approval envelope: ${validation.error}`);
      err.code = 'INVALID_ENVELOPE';
      throw err;
    }

    session.approvalEnvelope = envelope;
    return session;
  }

  /**
   * End a session — send wrap message, transition to ended, and clean up.
   * @param {string} project
   * @param {object} [options]
   * @param {string} [options.message] - Wrap-up message to send before ending
   * @returns {Promise<Session>}
   */
  async end(project, options = {}) {
    const session = this._sessions.get(project);
    if (!session) {
      const err = new Error(`No session for project '${project}'`);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    const wrapMessage = options.message ||
      'Session is ending. Complete any pending reflection, critic review, or governance tasks now. Write a session handoff to .prawduct/.session-handoff.md summarizing what was done and what remains.';

    // If session is still running, send wrap message and wait for exit
    if (session.state === SessionState.RUNNING && session.pty && !session.pty.exited) {
      session.pty.write(wrapMessage + '\r');

      // Wait for PTY to exit (with a timeout)
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!session.pty.exited) {
            session.pty.kill();
          }
          resolve();
        }, 30000);

        session.pty.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        // Already exited
        if (session.pty.exited) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    // Transition to ended from whatever terminal state we're in
    if (!TERMINAL_STATES.has(session.state) || session.state === SessionState.ENDED) {
      // Force to failed if somehow still in a non-terminal state
      if (!session.isTerminal) {
        session.transition(SessionState.FAILED);
      }
    }

    if (session.state !== SessionState.ENDED) {
      session.transition(SessionState.ENDED);
    }

    // Snapshot before cleanup destroys the PTY and event log
    this._snapshotSession(session);

    // Clean up timers, PTY, and event log waiters
    session.clearAllTimers();
    if (session.pty) {
      session.pty.destroy();
    }
    session.eventLog.cancelWaiters();

    return session;
  }

  /**
   * Remove a session from the manager (after it's ended).
   * @param {string} project
   * @returns {boolean} Whether a session was removed
   */
  remove(project) {
    return this._sessions.delete(project);
  }

  /**
   * Destroy all sessions. Used during bridge shutdown.
   */
  destroyAll() {
    for (const [project, session] of this._sessions) {
      session.clearAllTimers();
      if (session.pty) {
        session.pty.destroy();
      }
    }
    this._sessions.clear();
  }

  /**
   * Number of active (non-terminal) sessions.
   * @returns {number}
   */
  get activeCount() {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (!session.isTerminal) count++;
    }
    return count;
  }
}

module.exports = {
  Session,
  SessionManager,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_MS,
};
