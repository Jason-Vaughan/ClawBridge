'use strict';

const { PermissionType, RiskLevel, PolicyAction } = require('./types');
const { isDestructiveGit } = require('./permission-parser');

/**
 * Valid policy action values.
 * @type {Set<string>}
 */
const VALID_ACTIONS = new Set(Object.values(PolicyAction));

/**
 * Validate an approval envelope schema.
 * Returns { valid: true } or { valid: false, error: string }.
 * @param {object} envelope - The approval envelope to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, error: 'Envelope must be a non-null object' };
  }

  if (envelope.mode !== 'scoped') {
    return { valid: false, error: `Invalid mode '${envelope.mode}'. Must be 'scoped'` };
  }

  if (!envelope.rules || typeof envelope.rules !== 'object') {
    return { valid: false, error: 'Envelope must have a rules object' };
  }

  // Validate individual rule sections
  const { rules } = envelope;

  // fileWrites: string action or { withinProject, outsideProject }
  const fwErr = _validateLocationRule(rules.fileWrites, 'fileWrites');
  if (fwErr) return { valid: false, error: fwErr };

  // fileDeletes: string action or { withinProject, outsideProject }
  const fdErr = _validateLocationRule(rules.fileDeletes, 'fileDeletes');
  if (fdErr) return { valid: false, error: fdErr };

  // shellCommands: { allowlist, allowlistPolicy, otherPolicy }
  if (rules.shellCommands !== undefined) {
    if (typeof rules.shellCommands === 'string') {
      if (!VALID_ACTIONS.has(rules.shellCommands)) {
        return { valid: false, error: `Invalid action '${rules.shellCommands}' for shellCommands` };
      }
    } else if (typeof rules.shellCommands === 'object') {
      if (rules.shellCommands.allowlist && !Array.isArray(rules.shellCommands.allowlist)) {
        return { valid: false, error: 'shellCommands.allowlist must be an array' };
      }
      if (rules.shellCommands.allowlistPolicy && !VALID_ACTIONS.has(rules.shellCommands.allowlistPolicy)) {
        return { valid: false, error: `Invalid action '${rules.shellCommands.allowlistPolicy}' for shellCommands.allowlistPolicy` };
      }
      if (rules.shellCommands.otherPolicy && !VALID_ACTIONS.has(rules.shellCommands.otherPolicy)) {
        return { valid: false, error: `Invalid action '${rules.shellCommands.otherPolicy}' for shellCommands.otherPolicy` };
      }
    } else {
      return { valid: false, error: 'shellCommands must be a string action or an object' };
    }
  }

  // Simple string rules
  for (const key of ['dependencyChanges', 'networkAccess', 'configChanges', 'unknown']) {
    if (rules[key] !== undefined) {
      if (typeof rules[key] !== 'string' || !VALID_ACTIONS.has(rules[key])) {
        return { valid: false, error: `Invalid action '${rules[key]}' for ${key}` };
      }
    }
  }

  // gitOperations: string action or { safe, destructive }
  if (rules.gitOperations !== undefined) {
    if (typeof rules.gitOperations === 'string') {
      if (!VALID_ACTIONS.has(rules.gitOperations)) {
        return { valid: false, error: `Invalid action '${rules.gitOperations}' for gitOperations` };
      }
    } else if (typeof rules.gitOperations === 'object') {
      if (rules.gitOperations.safe && !VALID_ACTIONS.has(rules.gitOperations.safe)) {
        return { valid: false, error: `Invalid action '${rules.gitOperations.safe}' for gitOperations.safe` };
      }
      if (rules.gitOperations.destructive && !VALID_ACTIONS.has(rules.gitOperations.destructive)) {
        return { valid: false, error: `Invalid action '${rules.gitOperations.destructive}' for gitOperations.destructive` };
      }
    } else {
      return { valid: false, error: 'gitOperations must be a string action or an object' };
    }
  }

  // Validate defaults section
  if (envelope.defaults !== undefined) {
    if (typeof envelope.defaults !== 'object') {
      return { valid: false, error: 'defaults must be an object' };
    }
    for (const key of ['lowRisk', 'mediumRisk', 'highRisk']) {
      if (envelope.defaults[key] !== undefined && !VALID_ACTIONS.has(envelope.defaults[key])) {
        return { valid: false, error: `Invalid action '${envelope.defaults[key]}' for defaults.${key}` };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate a location-based rule (fileWrites/fileDeletes).
 * @private
 * @param {*} rule - The rule value
 * @param {string} name - Rule name for error messages
 * @returns {string|null} Error message or null if valid
 */
function _validateLocationRule(rule, name) {
  if (rule === undefined) return null;
  if (typeof rule === 'string') {
    if (!VALID_ACTIONS.has(rule)) {
      return `Invalid action '${rule}' for ${name}`;
    }
    return null;
  }
  if (typeof rule === 'object' && rule !== null) {
    if (rule.withinProject && !VALID_ACTIONS.has(rule.withinProject)) {
      return `Invalid action '${rule.withinProject}' for ${name}.withinProject`;
    }
    if (rule.outsideProject && !VALID_ACTIONS.has(rule.outsideProject)) {
      return `Invalid action '${rule.outsideProject}' for ${name}.outsideProject`;
    }
    return null;
  }
  return `${name} must be a string action or an object`;
}

/**
 * Evaluate a permission event against an approval envelope.
 * Returns the policy decision with matched rule info.
 *
 * @param {object} permEvent - Structured permission event from PermissionParser
 * @param {object|null} envelope - Approval envelope (null = no envelope = all require_review)
 * @returns {{ action: string, matchedRule: string|null, reason: string }}
 */
function evaluatePermission(permEvent, envelope) {
  // No envelope = fail-closed: everything requires review
  if (!envelope) {
    return {
      action: PolicyAction.REQUIRE_REVIEW,
      matchedRule: null,
      reason: 'No approval envelope — all permissions require review',
    };
  }

  const { permissionType, risk, withinProject, target } = permEvent;
  const { rules, defaults } = envelope;

  // Try to match a specific rule for this permission type
  const result = _matchRule(permissionType, withinProject, target, rules);
  if (result) {
    return result;
  }

  // Fall back to defaults by risk level
  if (defaults) {
    const riskKey = risk === RiskLevel.LOW ? 'lowRisk'
      : risk === RiskLevel.MEDIUM ? 'mediumRisk'
        : 'highRisk';
    if (defaults[riskKey]) {
      return {
        action: defaults[riskKey],
        matchedRule: `defaults.${riskKey}`,
        reason: `Default policy for ${risk}-risk permissions`,
      };
    }
  }

  // Ultimate fallback: require review
  return {
    action: PolicyAction.REQUIRE_REVIEW,
    matchedRule: null,
    reason: 'No matching rule or default — requires review',
  };
}

/**
 * Match a permission against the rules section of an envelope.
 * @private
 * @param {string} permissionType - From PermissionType enum
 * @param {boolean} withinProject - Whether target is within project
 * @param {object} target - Target object from permission event
 * @param {object} rules - Rules section of the envelope
 * @returns {{ action: string, matchedRule: string, reason: string }|null}
 */
function _matchRule(permissionType, withinProject, target, rules) {
  switch (permissionType) {
    case PermissionType.FILE_WRITE:
      return _evaluateLocationRule(rules.fileWrites, 'fileWrites', withinProject, 'file write');

    case PermissionType.FILE_DELETE:
      return _evaluateLocationRule(rules.fileDeletes, 'fileDeletes', withinProject, 'file delete');

    case PermissionType.SHELL_COMMAND:
      return _evaluateShellCommand(rules.shellCommands, target);

    case PermissionType.DEPENDENCY_CHANGE:
      return _evaluateSimpleRule(rules.dependencyChanges, 'dependencyChanges', 'dependency change');

    case PermissionType.NETWORK_ACCESS:
      return _evaluateSimpleRule(rules.networkAccess, 'networkAccess', 'network access');

    case PermissionType.GIT_OPERATION:
      return _evaluateGitOperation(rules.gitOperations, target);

    case PermissionType.CONFIG_CHANGE:
      return _evaluateSimpleRule(rules.configChanges, 'configChanges', 'config change');

    case PermissionType.UNKNOWN:
      return _evaluateSimpleRule(rules.unknown, 'unknown', 'unknown permission type');

    default:
      return null;
  }
}

/**
 * Evaluate a location-based rule (fileWrites/fileDeletes).
 * @private
 */
function _evaluateLocationRule(rule, ruleName, withinProject, description) {
  if (!rule) return null;

  if (typeof rule === 'string') {
    return {
      action: rule,
      matchedRule: ruleName,
      reason: `${description} matched rule '${ruleName}': ${rule}`,
    };
  }

  const location = withinProject ? 'withinProject' : 'outsideProject';
  const action = rule[location];
  if (action) {
    return {
      action,
      matchedRule: `${ruleName}.${location}`,
      reason: `${withinProject ? 'Project-local' : 'External'} ${description}: ${action}`,
    };
  }

  return null;
}

/**
 * Evaluate a shell command against the allowlist rules.
 * @private
 */
function _evaluateShellCommand(rule, target) {
  if (!rule) return null;

  if (typeof rule === 'string') {
    return {
      action: rule,
      matchedRule: 'shellCommands',
      reason: `Shell command matched rule 'shellCommands': ${rule}`,
    };
  }

  const command = target?.command?.trim() || '';

  // Check allowlist — exact match or prefix match (command starts with allowlisted entry)
  if (rule.allowlist && Array.isArray(rule.allowlist)) {
    const isAllowlisted = rule.allowlist.some(
      (allowed) => command === allowed || command.startsWith(allowed + ' ')
    );
    if (isAllowlisted) {
      return {
        action: rule.allowlistPolicy || PolicyAction.AUTO_APPROVE,
        matchedRule: 'shellCommands.allowlist',
        reason: `Command '${command}' matches allowlist`,
      };
    }
  }

  // Not in allowlist — use otherPolicy
  if (rule.otherPolicy) {
    return {
      action: rule.otherPolicy,
      matchedRule: 'shellCommands.otherPolicy',
      reason: `Command '${command}' not in allowlist`,
    };
  }

  return null;
}

/**
 * Evaluate a git operation against safe/destructive rules.
 * @private
 */
function _evaluateGitOperation(rule, target) {
  if (!rule) return null;

  if (typeof rule === 'string') {
    return {
      action: rule,
      matchedRule: 'gitOperations',
      reason: `Git operation matched rule 'gitOperations': ${rule}`,
    };
  }

  const command = target?.command?.trim() || '';
  const destructive = isDestructiveGit(command);

  if (destructive && rule.destructive) {
    return {
      action: rule.destructive,
      matchedRule: 'gitOperations.destructive',
      reason: `Destructive git command '${command}': ${rule.destructive}`,
    };
  }

  if (!destructive && rule.safe) {
    return {
      action: rule.safe,
      matchedRule: 'gitOperations.safe',
      reason: `Safe git command '${command}': ${rule.safe}`,
    };
  }

  return null;
}

/**
 * Evaluate a simple string rule (dependencyChanges, networkAccess, etc.).
 * @private
 */
function _evaluateSimpleRule(rule, ruleName, description) {
  if (!rule) return null;
  return {
    action: rule,
    matchedRule: ruleName,
    reason: `${description} matched rule '${ruleName}': ${rule}`,
  };
}

module.exports = {
  validateEnvelope,
  evaluatePermission,
  VALID_ACTIONS,
};
