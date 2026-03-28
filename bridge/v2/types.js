'use strict';

/**
 * Session lifecycle states.
 * @enum {string}
 */
const SessionState = {
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_FOR_PERMISSION: 'waiting_for_permission',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  ENDED: 'ended',
};

/**
 * Valid state transitions. Key = from state, value = set of allowed target states.
 * @type {Record<string, Set<string>>}
 */
const VALID_TRANSITIONS = {
  [SessionState.STARTING]: new Set([
    SessionState.RUNNING,
    SessionState.FAILED,
  ]),
  [SessionState.RUNNING]: new Set([
    SessionState.WAITING_FOR_PERMISSION,
    SessionState.COMPLETED,
    SessionState.FAILED,
    SessionState.TIMED_OUT,
  ]),
  [SessionState.WAITING_FOR_PERMISSION]: new Set([
    SessionState.RUNNING,
    SessionState.FAILED,
    SessionState.TIMED_OUT,
  ]),
  [SessionState.COMPLETED]: new Set([SessionState.ENDED]),
  [SessionState.FAILED]: new Set([SessionState.ENDED]),
  [SessionState.TIMED_OUT]: new Set([SessionState.ENDED]),
  [SessionState.ENDED]: new Set(),
};

/**
 * Terminal states — no further PTY interaction possible.
 * @type {Set<string>}
 */
const TERMINAL_STATES = new Set([
  SessionState.COMPLETED,
  SessionState.FAILED,
  SessionState.TIMED_OUT,
  SessionState.ENDED,
]);

/**
 * Event kinds in the append-only event log.
 * @enum {string}
 */
const EventKind = {
  TEXT: 'text',
  LIFECYCLE: 'lifecycle',
  PERMISSION: 'permission',
  DECISION: 'decision',
  ERROR: 'error',
};

/**
 * Permission types detected from Claude Code prompts.
 * @enum {string}
 */
const PermissionType = {
  FILE_WRITE: 'file_write',
  FILE_DELETE: 'file_delete',
  SHELL_COMMAND: 'shell_command',
  NETWORK_ACCESS: 'network_access',
  DEPENDENCY_CHANGE: 'dependency_change',
  GIT_OPERATION: 'git_operation',
  CONFIG_CHANGE: 'config_change',
  UNKNOWN: 'unknown',
};

/**
 * Risk levels for permission events.
 * @enum {string}
 */
const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

/**
 * Decision types for permission responses.
 * @enum {string}
 */
const DecisionType = {
  APPROVE_ONCE: 'approve_once',
  DENY: 'deny',
  ABORT_SESSION: 'abort_session',
};

/**
 * Policy actions for approval envelope rules.
 * @enum {string}
 */
const PolicyAction = {
  AUTO_APPROVE: 'auto_approve',
  REQUIRE_REVIEW: 'require_review',
  DENY: 'deny',
};

/**
 * Error codes for error events.
 * @enum {string}
 */
const ErrorCode = {
  PERMISSION_TIMEOUT: 'permission_timeout',
  PTY_EXIT_UNEXPECTED: 'pty_exit_unexpected',
  SESSION_RUNTIME_TIMEOUT: 'session_runtime_timeout',
};

module.exports = {
  SessionState,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  EventKind,
  PermissionType,
  RiskLevel,
  DecisionType,
  PolicyAction,
  ErrorCode,
};
