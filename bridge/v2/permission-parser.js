'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { PermissionType, RiskLevel } = require('./types');

/**
 * Strip ANSI escape sequences from a string.
 * Handles CSI sequences, OSC sequences, and single-character escapes.
 * @param {string} str - Raw string with potential ANSI codes
 * @returns {string} Clean string
 */
function stripAnsi(str) {
  // First, replace cursor-right sequences (\x1b[NC where N is columns) with a space.
  // Claude Code's TUI uses these to position text with visual gaps (e.g., between
  // "node" and "src/add.test.js"). Stripping them to empty concatenates words.
  // Then strip all remaining ANSI sequences to empty (colors, cursor moves, etc.).
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[\d*C/g, ' ').replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[hlm]|\r/g, '');
}

/**
 * Normalize a path for comparison — resolve, strip trailing slashes.
 * @param {string} p - Path to normalize
 * @returns {string}
 */
function normalizePath(p) {
  return path.resolve(p).replace(/\/+$/, '');
}

/**
 * Check whether a target path is within the project root.
 * Rejects path traversal attempts.
 * @param {string} targetPath - Absolute or relative target path
 * @param {string} projectRoot - Absolute project root path
 * @returns {boolean}
 */
function isWithinProject(targetPath, projectRoot) {
  if (!projectRoot) return false;
  const resolved = normalizePath(path.resolve(projectRoot, targetPath));
  const root = normalizePath(projectRoot);
  return resolved === root || resolved.startsWith(root + '/');
}

// ─── Prompt detection patterns ───────────────────────────────────────────────
// Claude Code permission prompts generally follow these patterns in PTY output.
// We strip ANSI first, then match against cleaned text.
//
// File write/edit:
//   "Claude wants to write to <path>"
//   "Claude wants to edit <path>"
//   "Claude wants to create <path>"
//   "Write(<path>)"
//   "Edit(<path>)"
//
// File delete:
//   "Claude wants to delete <path>"
//
// Shell/Bash command:
//   "Claude wants to run: <command>"
//   "Claude wants to execute: <command>"
//   "Bash(<command>)"
//
// The confirmation line typically contains:
//   "Allow?" or "Do you want to" or "(y/n)" or "[Y/N]" or similar
//
// We detect on the confirmation line and look backwards for context.

/**
 * Pattern definitions for permission prompt detection.
 * Each pattern has: regex, permissionType extractor, target extractor, risk assigner.
 * @type {Array<{pattern: RegExp, extract: function}>}
 */
const PROMPT_PATTERNS = [
  // "Claude wants to write to <path>" / "Claude wants to create <path>"
  {
    pattern: /claude\s+wants\s+to\s+(?:write\s+to|create)\s+(.+)/i,
    extract: (match) => ({
      permissionType: PermissionType.FILE_WRITE,
      target: { path: match[1].trim() },
      action: { summary: `Write file ${match[1].trim()}`, details: null },
    }),
  },
  // "Claude wants to edit <path>"
  {
    pattern: /claude\s+wants\s+to\s+edit\s+(.+)/i,
    extract: (match) => ({
      permissionType: PermissionType.FILE_WRITE,
      target: { path: match[1].trim() },
      action: { summary: `Edit file ${match[1].trim()}`, details: null },
    }),
  },
  // "Claude wants to delete <path>"
  {
    pattern: /claude\s+wants\s+to\s+delete\s+(.+)/i,
    extract: (match) => ({
      permissionType: PermissionType.FILE_DELETE,
      target: { path: match[1].trim() },
      action: { summary: `Delete file ${match[1].trim()}`, details: null },
    }),
  },
  // "Claude wants to run: <command>" / "Claude wants to execute: <command>"
  {
    pattern: /claude\s+wants\s+to\s+(?:run|execute):\s*(.+)/i,
    extract: (match) => {
      const command = match[1].trim();
      return {
        permissionType: classifyCommand(command),
        target: classifyCommandTarget(command),
        action: { summary: `Run command: ${command}`, details: null },
      };
    },
  },
  // Tool-style: "Write(path)" — sometimes appears in structured output
  {
    pattern: /\bWrite\(([^)]+)\)/,
    extract: (match) => ({
      permissionType: PermissionType.FILE_WRITE,
      target: { path: match[1].trim() },
      action: { summary: `Write file ${match[1].trim()}`, details: null },
    }),
  },
  // Tool-style: "Edit(path)"
  {
    pattern: /\bEdit\(([^)]+)\)/,
    extract: (match) => ({
      permissionType: PermissionType.FILE_WRITE,
      target: { path: match[1].trim() },
      action: { summary: `Edit file ${match[1].trim()}`, details: null },
    }),
  },
  // Tool-style: "Bash(command)"
  {
    pattern: /\bBash\(([^)]+)\)/,
    extract: (match) => {
      const command = match[1].trim();
      return {
        permissionType: classifyCommand(command),
        target: classifyCommandTarget(command),
        action: { summary: `Run command: ${command}`, details: null },
      };
    },
  },
];

/**
 * Confirmation line pattern — indicates a permission prompt is present.
 * Matches lines like "Allow?", "Do you want to allow/create/edit/delete",
 * "(y/n)", "[Y/N]", or Claude Code's interactive menu format with numbered
 * options (❯ 1. Yes / 2. Yes, allow all / 3. No).
 *
 * Claude Code v2.1.81+ uses interactive menus for permissions. The menu may
 * arrive in the same PTY chunk as the Write() prompt or in a separate chunk.
 * We match both traditional and menu-style confirmation patterns.
 * @type {RegExp}
 */
const CONFIRMATION_PATTERN = /(?:allow\s*(?:this)?\s*(?:action|tool)?\s*\??|do\s+you\s+want\s+to\s+(?:allow|proceed|create|edit|delete|run)|(?:\[|\()(?:y|n|a)(?:\/|\]|\))|(?:❯\s*)?1\.\s*Yes|Esc\s*to\s*cancel)/i;

// ─── Command classification helpers ──────────────────────────────────────────

/** Git commands considered safe (read-only or staging). */
const SAFE_GIT_COMMANDS = new Set([
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'git stash list', 'git remote -v', 'git tag', 'git add',
  'git add -A', 'git add .', 'git commit',
]);

/** Git commands considered destructive. */
const DESTRUCTIVE_GIT_PATTERNS = [
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[fd]/,
  /git\s+branch\s+-[dD]/,
  /git\s+rebase/,
  /git\s+merge/,
  /git\s+checkout\s+--/,
  /git\s+restore\s+--/,
];

/** Dependency management commands. */
const DEPENDENCY_PATTERNS = [
  /^npm\s+install\b/,
  /^npm\s+uninstall\b/,
  /^npm\s+update\b/,
  /^yarn\s+add\b/,
  /^yarn\s+remove\b/,
  /^pnpm\s+add\b/,
  /^pnpm\s+remove\b/,
  /^pip\s+install\b/,
  /^pip\s+uninstall\b/,
];

/** Network access commands. */
const NETWORK_PATTERNS = [
  /^curl\b/,
  /^wget\b/,
  /^fetch\b/,
  /^ssh\b/,
  /^scp\b/,
  /^rsync\b/,
];

/**
 * Classify a shell command into a more specific permission type.
 * @param {string} command - The raw command string
 * @returns {string} PermissionType value
 */
function classifyCommand(command) {
  const trimmed = command.trim();

  // Git operations
  if (/^git\s/.test(trimmed)) {
    return PermissionType.GIT_OPERATION;
  }

  // Dependency management
  for (const pat of DEPENDENCY_PATTERNS) {
    if (pat.test(trimmed)) return PermissionType.DEPENDENCY_CHANGE;
  }

  // Network access
  for (const pat of NETWORK_PATTERNS) {
    if (pat.test(trimmed)) return PermissionType.NETWORK_ACCESS;
  }

  // Default: generic shell command
  return PermissionType.SHELL_COMMAND;
}

/**
 * Build a target object for a command.
 * @param {string} command - The raw command string
 * @returns {object} Target object with command field
 */
function classifyCommandTarget(command) {
  return { command: command.trim() };
}

/**
 * Determine if a git command is destructive.
 * @param {string} command - The raw git command
 * @returns {boolean}
 */
function isDestructiveGit(command) {
  for (const pat of DESTRUCTIVE_GIT_PATTERNS) {
    if (pat.test(command)) return true;
  }
  return false;
}

// ─── Risk assignment ─────────────────────────────────────────────────────────

/**
 * Assign a risk level to a permission event.
 * @param {string} permissionType - From PermissionType enum
 * @param {object} target - The target object
 * @param {boolean} withinProject - Whether target is within project root
 * @returns {string} RiskLevel value
 */
function assignRisk(permissionType, target, withinProject) {
  switch (permissionType) {
    case PermissionType.FILE_WRITE:
      return withinProject ? RiskLevel.LOW : RiskLevel.HIGH;

    case PermissionType.FILE_DELETE:
      return withinProject ? RiskLevel.MEDIUM : RiskLevel.HIGH;

    case PermissionType.SHELL_COMMAND:
      return RiskLevel.MEDIUM;

    case PermissionType.GIT_OPERATION:
      if (target && target.command && isDestructiveGit(target.command)) {
        return RiskLevel.HIGH;
      }
      return SAFE_GIT_COMMANDS.has(target?.command?.trim()) ? RiskLevel.LOW : RiskLevel.MEDIUM;

    case PermissionType.DEPENDENCY_CHANGE:
      return RiskLevel.MEDIUM;

    case PermissionType.NETWORK_ACCESS:
      return RiskLevel.MEDIUM;

    case PermissionType.CONFIG_CHANGE:
      return RiskLevel.MEDIUM;

    case PermissionType.UNKNOWN:
    default:
      return RiskLevel.HIGH;
  }
}

// ─── PermissionParser ────────────────────────────────────────────────────────

/**
 * Parses PTY output to detect Claude Code permission prompts and emits
 * structured permission events.
 *
 * Feed raw PTY data chunks via `feed()`. When a permission prompt is detected,
 * the `onPermission` callback fires with a structured permission event object.
 *
 * The parser buffers recent output lines to handle prompts that arrive across
 * multiple data events. The buffer is trimmed to keep only the last N lines.
 */
class PermissionParser {
  /**
   * @param {object} options
   * @param {string} options.projectRoot - Absolute path to project root (for withinProject checks)
   * @param {string} options.sessionId - Session ID for event metadata
   * @param {string} options.project - Project name for event metadata
   * @param {function} [options.onPermission] - Callback when a permission prompt is detected
   */
  constructor(options) {
    this._projectRoot = options.projectRoot;
    this._sessionId = options.sessionId;
    this._project = options.project;
    this._onPermission = options.onPermission || (() => {});
    /** @type {string} */
    this._buffer = '';
    /** Maximum number of characters to keep in the buffer */
    this._maxBufferSize = 8192;
    /** Whether we've already detected a prompt and are waiting for response */
    this._pendingDetection = false;
    /** Timestamp of last reset — used for cooldown after auto-approve/deny.
     *  Menu remnants (1. Yes / Esc to cancel) arrive in subsequent PTY chunks
     *  after the permission was already resolved. Without cooldown, the unknown
     *  fallback fires on these remnants and emits a bogus second permission. */
    this._lastResetAt = 0;
    /** Cooldown period in ms after reset — suppress unknown fallback detection */
    this._cooldownMs = 2000;
  }

  /**
   * Feed raw PTY output into the parser.
   * Strips ANSI codes, buffers text, and scans for permission prompts.
   * @param {string} data - Raw PTY output chunk
   * @returns {object|null} Detected permission event, or null
   */
  feed(data) {
    if (this._pendingDetection) return null;

    const clean = stripAnsi(data);
    this._buffer += clean;

    // Trim buffer if too large — keep the tail
    if (this._buffer.length > this._maxBufferSize) {
      this._buffer = this._buffer.slice(-this._maxBufferSize);
    }

    return this._scan();
  }

  /**
   * Reset the parser state. Call after a permission has been responded to.
   */
  reset() {
    this._buffer = '';
    this._pendingDetection = false;
    this._lastResetAt = Date.now();
  }

  /**
   * Scan the buffer for a permission prompt.
   * Scans from the end of the buffer to avoid matching stale UI fragments
   * from previous operations (Claude Code's TUI redraws status lines that
   * reference earlier file paths).
   * @private
   * @returns {object|null} Detected permission event, or null
   */
  _scan() {
    // Check for confirmation indicators. We MUST see an actual interactive menu
    // or traditional confirmation text — not just a tool call announcement.
    //
    // Claude Code shows "Write(file)" as a tool call announcement BEFORE the
    // interactive permission menu renders. If we trigger on the announcement alone,
    // we send \r before any menu exists, which either does nothing or causes
    // "Error writing file". The actual permission menu includes numbered options
    // ("1. Yes / 2. Yes, allow all / 3. No") or "Do you want to create/edit...".
    //
    // The ❯ character alone is NOT sufficient — it appears as the input cursor
    // throughout Claude Code's TUI, not just in permission menus.
    const hasConfirmation = CONFIRMATION_PATTERN.test(this._buffer);

    if (!hasConfirmation) {
      return null;
    }

    // Split buffer into lines and scan from the bottom up.
    // The most recent permission prompt is the relevant one — earlier lines
    // may contain stale file paths from Claude Code's UI status redraws.
    const lines = this._buffer.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const { pattern, extract } of PROMPT_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          const extracted = extract(match);
          const event = this._buildPermissionEvent(extracted);
          this._pendingDetection = true;
          this._onPermission(event);
          return event;
        }
      }
    }

    // Confirmation line present but no recognized action pattern → unknown
    // Only emit unknown if:
    //   1. The confirmation pattern is near the end of the buffer (within last 200 chars)
    //   2. We are NOT in the cooldown window after a recent reset (menu remnants
    //      from a just-resolved permission would trigger false unknown detections)
    const inCooldown = (Date.now() - this._lastResetAt) < this._cooldownMs;
    if (!inCooldown) {
      const lastChunk = this._buffer.slice(-200);
      if (CONFIRMATION_PATTERN.test(lastChunk)) {
        const event = this._buildPermissionEvent({
          permissionType: PermissionType.UNKNOWN,
          target: {},
          action: { summary: 'Unrecognized permission prompt', details: lastChunk.trim() },
        });
        this._pendingDetection = true;
        this._onPermission(event);
        return event;
      }
    }

    return null;
  }

  /**
   * Build a structured permission event from extracted data.
   * @private
   * @param {object} extracted - Data from pattern extraction
   * @param {string} extracted.permissionType
   * @param {object} extracted.target
   * @param {object} extracted.action
   * @returns {object} Structured permission event
   */
  _buildPermissionEvent(extracted) {
    const { permissionType, target, action } = extracted;

    // Determine withinProject for file operations
    let withinProject = false;
    if (target && target.path) {
      withinProject = isWithinProject(target.path, this._projectRoot);
    }

    const risk = assignRisk(permissionType, target, withinProject);
    const rawPrompt = this._buffer.slice(-500).trim();

    return {
      id: `perm_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: 'permission',
      createdAt: new Date().toISOString(),
      sessionId: this._sessionId,
      project: this._project,
      rawPrompt,
      permissionType,
      risk,
      requiresResponse: true,
      withinProject,
      target,
      action,
      policyEvaluation: {
        matchedRule: null,
        suggestedDecision: null,
        reason: null,
      },
      timeoutAt: null, // Set by session manager when timeout is configured
    };
  }
}

module.exports = {
  PermissionParser,
  stripAnsi,
  isWithinProject,
  classifyCommand,
  assignRisk,
  isDestructiveGit,
  // Exported for testing
  PROMPT_PATTERNS,
  CONFIRMATION_PATTERN,
};
