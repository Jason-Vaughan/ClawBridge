import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { validateEnvelope, evaluatePermission } = require('../policy');
const { SessionManager } = require('../sessions');
const { SessionState, EventKind, DecisionType, PolicyAction, PermissionType, RiskLevel } = require('../types');

// ─── Helper: build a standard scoped envelope ────────────────────────────────

/**
 * Build a standard test envelope with sensible defaults.
 * @param {object} [overrides] - Partial rules/defaults to override
 * @returns {object}
 */
function makeEnvelope(overrides = {}) {
  return {
    mode: 'scoped',
    projectRoot: '/tmp/bridge-v2-test-policy/test-proj',
    rules: {
      fileWrites: {
        withinProject: 'auto_approve',
        outsideProject: 'require_review',
      },
      fileDeletes: {
        withinProject: 'require_review',
        outsideProject: 'deny',
      },
      shellCommands: {
        allowlist: ['npm test', 'npm run build', 'vitest run', 'git status', 'git diff'],
        allowlistPolicy: 'auto_approve',
        otherPolicy: 'require_review',
      },
      dependencyChanges: 'require_review',
      networkAccess: 'require_review',
      gitOperations: {
        safe: 'auto_approve',
        destructive: 'require_review',
      },
      configChanges: 'require_review',
      unknown: 'deny',
      ...overrides.rules,
    },
    defaults: {
      lowRisk: 'require_review',
      mediumRisk: 'require_review',
      highRisk: 'deny',
      ...overrides.defaults,
    },
    ...overrides,
  };
}

/**
 * Build a minimal permission event for testing.
 * @param {object} fields - Override fields
 * @returns {object}
 */
function makePermEvent(fields = {}) {
  return {
    id: fields.id || 'perm_test123',
    kind: 'permission',
    permissionType: fields.permissionType || PermissionType.FILE_WRITE,
    risk: fields.risk || RiskLevel.LOW,
    withinProject: fields.withinProject !== undefined ? fields.withinProject : true,
    target: fields.target || { path: '/tmp/bridge-v2-test-policy/test-proj/src/foo.js' },
    action: fields.action || { summary: 'Write file', details: null },
    policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Envelope Validation
// ═════════════════════════════════════════════════════════════════════════════

describe('validateEnvelope()', () => {
  it('accepts a valid scoped envelope', () => {
    const result = validateEnvelope(makeEnvelope());
    expect(result).toEqual({ valid: true });
  });

  it('rejects null', () => {
    const result = validateEnvelope(null);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-null object/);
  });

  it('rejects non-object', () => {
    const result = validateEnvelope('bad');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid mode', () => {
    const result = validateEnvelope({ mode: 'relaxed', rules: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/mode/);
  });

  it('rejects missing rules', () => {
    const result = validateEnvelope({ mode: 'scoped' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/rules/);
  });

  it('rejects invalid fileWrites action', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { fileWrites: 'yolo' },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/fileWrites/);
  });

  it('rejects invalid fileWrites.withinProject action', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { fileWrites: { withinProject: 'invalid' } },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/fileWrites\.withinProject/);
  });

  it('rejects invalid fileDeletes action', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { fileDeletes: 'bad' },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects non-array shellCommands.allowlist', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { shellCommands: { allowlist: 'not-array' } },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/allowlist.*array/);
  });

  it('rejects invalid shellCommands.allowlistPolicy', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { shellCommands: { allowlistPolicy: 'invalid' } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid shellCommands.otherPolicy', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { shellCommands: { otherPolicy: 'invalid' } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects non-string non-object shellCommands', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { shellCommands: 42 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid simple rule actions', () => {
    for (const key of ['dependencyChanges', 'networkAccess', 'configChanges', 'unknown']) {
      const result = validateEnvelope({
        mode: 'scoped',
        rules: { [key]: 'bad' },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(new RegExp(key));
    }
  });

  it('rejects invalid gitOperations.safe', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { gitOperations: { safe: 'bad' } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid gitOperations.destructive', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { gitOperations: { destructive: 'bad' } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects non-string non-object gitOperations', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { gitOperations: true },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid defaults actions', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: {},
      defaults: { lowRisk: 'bad' },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/defaults\.lowRisk/);
  });

  it('accepts envelope with only partial rules', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { fileWrites: 'auto_approve' },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts string-form gitOperations', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { gitOperations: 'require_review' },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts string-form shellCommands', () => {
    const result = validateEnvelope({
      mode: 'scoped',
      rules: { shellCommands: 'deny' },
    });
    expect(result.valid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Policy Evaluation
// ═════════════════════════════════════════════════════════════════════════════

describe('evaluatePermission()', () => {
  const envelope = makeEnvelope();

  // ─── No envelope ────────────────────────────────────────────────────────────

  describe('no envelope (fail-closed)', () => {
    it('returns require_review for any permission', () => {
      const result = evaluatePermission(makePermEvent(), null);
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBeNull();
      expect(result.reason).toMatch(/no approval envelope/i);
    });
  });

  // ─── fileWrites ─────────────────────────────────────────────────────────────

  describe('fileWrites', () => {
    it('auto-approves within project', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.FILE_WRITE, withinProject: true }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('fileWrites.withinProject');
    });

    it('requires review outside project', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.FILE_WRITE, withinProject: false, risk: RiskLevel.HIGH }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('fileWrites.outsideProject');
    });
  });

  // ─── fileDeletes ────────────────────────────────────────────────────────────

  describe('fileDeletes', () => {
    it('requires review within project', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.FILE_DELETE, withinProject: true, risk: RiskLevel.MEDIUM }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('fileDeletes.withinProject');
    });

    it('denies outside project', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.FILE_DELETE, withinProject: false, risk: RiskLevel.HIGH }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.DENY);
      expect(result.matchedRule).toBe('fileDeletes.outsideProject');
    });
  });

  // ─── shellCommands ──────────────────────────────────────────────────────────

  describe('shellCommands', () => {
    it('auto-approves allowlisted command (exact match)', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.SHELL_COMMAND,
          risk: RiskLevel.MEDIUM,
          target: { command: 'npm test' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('shellCommands.allowlist');
    });

    it('auto-approves allowlisted command (prefix match)', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.SHELL_COMMAND,
          risk: RiskLevel.MEDIUM,
          target: { command: 'npm run build --production' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('shellCommands.allowlist');
    });

    it('requires review for non-allowlisted command', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.SHELL_COMMAND,
          risk: RiskLevel.MEDIUM,
          target: { command: 'rm -rf /important' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('shellCommands.otherPolicy');
    });

    it('handles string-form shellCommands rule', () => {
      const env = makeEnvelope({ rules: { shellCommands: 'deny' } });
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.SHELL_COMMAND,
          risk: RiskLevel.MEDIUM,
          target: { command: 'npm test' },
        }),
        env
      );
      expect(result.action).toBe(PolicyAction.DENY);
    });
  });

  // ─── dependencyChanges ──────────────────────────────────────────────────────

  describe('dependencyChanges', () => {
    it('requires review', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.DEPENDENCY_CHANGE,
          risk: RiskLevel.MEDIUM,
          target: { command: 'npm install lodash' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('dependencyChanges');
    });
  });

  // ─── networkAccess ──────────────────────────────────────────────────────────

  describe('networkAccess', () => {
    it('requires review', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.NETWORK_ACCESS,
          risk: RiskLevel.MEDIUM,
          target: { command: 'curl https://example.com' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('networkAccess');
    });
  });

  // ─── gitOperations ──────────────────────────────────────────────────────────

  describe('gitOperations', () => {
    it('auto-approves safe git command', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.GIT_OPERATION,
          risk: RiskLevel.LOW,
          target: { command: 'git status' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('gitOperations.safe');
    });

    it('requires review for destructive git command', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.GIT_OPERATION,
          risk: RiskLevel.HIGH,
          target: { command: 'git push --force' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('gitOperations.destructive');
    });

    it('auto-approves git add (safe)', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.GIT_OPERATION,
          risk: RiskLevel.LOW,
          target: { command: 'git add -A' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('gitOperations.safe');
    });

    it('requires review for git reset --hard (destructive)', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.GIT_OPERATION,
          risk: RiskLevel.HIGH,
          target: { command: 'git reset --hard HEAD~1' },
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('gitOperations.destructive');
    });

    it('handles string-form gitOperations rule', () => {
      const env = makeEnvelope({ rules: { gitOperations: 'deny' } });
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.GIT_OPERATION,
          risk: RiskLevel.LOW,
          target: { command: 'git status' },
        }),
        env
      );
      expect(result.action).toBe(PolicyAction.DENY);
    });
  });

  // ─── configChanges ──────────────────────────────────────────────────────────

  describe('configChanges', () => {
    it('requires review', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.CONFIG_CHANGE,
          risk: RiskLevel.MEDIUM,
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('configChanges');
    });
  });

  // ─── unknown ────────────────────────────────────────────────────────────────

  describe('unknown permission type', () => {
    it('denies unknown permissions', () => {
      const result = evaluatePermission(
        makePermEvent({
          permissionType: PermissionType.UNKNOWN,
          risk: RiskLevel.HIGH,
        }),
        envelope
      );
      expect(result.action).toBe(PolicyAction.DENY);
      expect(result.matchedRule).toBe('unknown');
    });
  });

  // ─── defaults fallback ─────────────────────────────────────────────────────

  describe('defaults fallback', () => {
    const emptyRulesEnvelope = {
      mode: 'scoped',
      rules: {},
      defaults: {
        lowRisk: 'auto_approve',
        mediumRisk: 'require_review',
        highRisk: 'deny',
      },
    };

    it('falls back to lowRisk default for low-risk unmatched permission', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.FILE_WRITE, risk: RiskLevel.LOW }),
        emptyRulesEnvelope
      );
      expect(result.action).toBe(PolicyAction.AUTO_APPROVE);
      expect(result.matchedRule).toBe('defaults.lowRisk');
    });

    it('falls back to mediumRisk default for medium-risk unmatched permission', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.SHELL_COMMAND, risk: RiskLevel.MEDIUM }),
        emptyRulesEnvelope
      );
      expect(result.action).toBe(PolicyAction.REQUIRE_REVIEW);
      expect(result.matchedRule).toBe('defaults.mediumRisk');
    });

    it('falls back to highRisk default for high-risk unmatched permission', () => {
      const result = evaluatePermission(
        makePermEvent({ permissionType: PermissionType.UNKNOWN, risk: RiskLevel.HIGH }),
        emptyRulesEnvelope
      );
      expect(result.action).toBe(PolicyAction.DENY);
      expect(result.matchedRule).toBe('defaults.highRisk');
    });
  });

  // ─── policyEvaluation field ─────────────────────────────────────────────────

  describe('policyEvaluation result structure', () => {
    it('always returns action, matchedRule, and reason', () => {
      const result = evaluatePermission(makePermEvent(), envelope);
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('matchedRule');
      expect(result).toHaveProperty('reason');
      expect(typeof result.reason).toBe('string');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Policy wired into SessionManager
// ═════════════════════════════════════════════════════════════════════════════

describe('Policy integration with SessionManager', () => {
  let manager;
  const projectsDir = '/tmp/bridge-v2-test-policy';

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      projectsDir,
      claudeBin: '/bin/cat',
      usePipes: true,
    });
  });

  afterEach(() => {
    manager.destroyAll();
    vi.useRealTimers();
  });

  // ─── Envelope on start ──────────────────────────────────────────────────────

  describe('envelope at session start', () => {
    it('stores the envelope on the session', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-a', { approvalEnvelope: envelope });
      expect(session.approvalEnvelope).toEqual(envelope);
    });

    it('rejects invalid envelope at start', () => {
      try {
        manager.start('proj-a', { approvalEnvelope: { mode: 'bad', rules: {} } });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('INVALID_ENVELOPE');
      }
    });

    it('starts without envelope (all require_review)', () => {
      const session = manager.start('proj-a');
      expect(session.approvalEnvelope).toBeNull();
    });
  });

  // ─── Auto-approve flow ─────────────────────────────────────────────────────

  describe('auto-approve flow', () => {
    it('auto-approves in-policy file write without pausing', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-a', { approvalEnvelope: envelope });

      // Spy on PTY write
      const writeSpy = vi.spyOn(session.pty, 'write');

      // Simulate permission prompt for within-project file write
      const promptData = 'Claude wants to write to /tmp/bridge-v2-test-policy/proj-a/src/foo.js\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      // Session should NOT be waiting_for_permission — auto-approved
      expect(session.state).toBe(SessionState.RUNNING);
      expect(session.pendingPermission).toBeNull();

      // PTY write is delayed 500ms to let the interactive menu render
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\r');

      // Event log should have permission + decision events
      const events = session.eventLog.toArray();
      const permEvents = events.filter(e => e.kind === EventKind.PERMISSION);
      const decEvents = events.filter(e => e.kind === EventKind.DECISION);
      expect(permEvents.length).toBeGreaterThanOrEqual(1);
      expect(decEvents.length).toBeGreaterThanOrEqual(1);

      // Decision should be from 'policy' actor
      const lastDecision = decEvents[decEvents.length - 1];
      expect(lastDecision.actor).toBe('policy');
      expect(lastDecision.decision).toBe(DecisionType.APPROVE_ONCE);

      // Permission event should have policyEvaluation populated
      const lastPerm = permEvents[permEvents.length - 1];
      expect(lastPerm.event.policyEvaluation.matchedRule).toBeTruthy();
      expect(lastPerm.event.policyEvaluation.suggestedDecision).toBe('approve_once');
    });

    it('auto-approves allowlisted shell command without pausing', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-b', { approvalEnvelope: envelope });
      const writeSpy = vi.spyOn(session.pty, 'write');

      const promptData = 'Claude wants to run: npm test\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\r');
    });

    it('auto-approves safe git operation without pausing', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-c', { approvalEnvelope: envelope });
      const writeSpy = vi.spyOn(session.pty, 'write');

      const promptData = 'Claude wants to run: git status\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\r');
    });
  });

  // ─── Auto-deny flow ────────────────────────────────────────────────────────

  describe('auto-deny flow', () => {
    it('auto-denies unknown permission type without pausing', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-d', { approvalEnvelope: envelope });
      const writeSpy = vi.spyOn(session.pty, 'write');

      // Trigger an unknown permission (confirmation line with no recognizable prompt)
      // We need to directly invoke the onPermission callback with an unknown event
      // since feeding unknown prompts to the parser requires specific buffer state.
      // Instead, simulate by creating a custom parser event.
      const permEvent = {
        id: 'perm_test_deny',
        kind: 'permission',
        permissionType: PermissionType.UNKNOWN,
        risk: RiskLevel.HIGH,
        withinProject: false,
        target: {},
        action: { summary: 'Unrecognized', details: null },
        policyEvaluation: { matchedRule: null, suggestedDecision: null, reason: null },
      };

      // Access the parser's onPermission callback directly
      session.permissionParser._onPermission(permEvent);

      expect(session.state).toBe(SessionState.RUNNING);
      expect(session.pendingPermission).toBeNull();
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\x1b');

      // Check decision event
      const decEvents = session.eventLog.toArray().filter(e => e.kind === EventKind.DECISION);
      const lastDecision = decEvents[decEvents.length - 1];
      expect(lastDecision.actor).toBe('policy');
      expect(lastDecision.decision).toBe(DecisionType.DENY);
    });

    it('auto-denies file delete outside project', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-e', { approvalEnvelope: envelope });
      const writeSpy = vi.spyOn(session.pty, 'write');

      const promptData = 'Claude wants to delete /etc/important.conf\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\x1b');
    });
  });

  // ─── Require-review flow ───────────────────────────────────────────────────

  describe('require-review flow', () => {
    it('pauses for non-allowlisted shell command', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-f', { approvalEnvelope: envelope });

      const promptData = 'Claude wants to run: rm -rf /tmp/stuff\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      // Should be waiting for review
      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
      expect(session.pendingPermission).toBeTruthy();
      expect(session.pendingPermission.policyEvaluation.suggestedDecision).toBeNull();
    });

    it('pauses for file delete within project', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-g', { approvalEnvelope: envelope });

      const promptData = 'Claude wants to delete /tmp/bridge-v2-test-policy/proj-g/old-file.js\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    });

    it('pauses for destructive git command', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-h', { approvalEnvelope: envelope });

      const promptData = 'Claude wants to run: git push --force origin main\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    });
  });

  // ─── No envelope = all require review ──────────────────────────────────────

  describe('no envelope (fail-closed)', () => {
    it('pauses for all permissions when no envelope', () => {
      const session = manager.start('proj-i');

      const promptData = 'Claude wants to write to /tmp/bridge-v2-test-policy/proj-i/safe.js\nAllow? (y/n)';
      session.permissionParser.feed(promptData);

      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
      expect(session.pendingPermission).toBeTruthy();
    });
  });

  // ─── Mid-session policy update ─────────────────────────────────────────────

  describe('mid-session policy update', () => {
    it('updatePolicy() stores new envelope on session', () => {
      manager.start('proj-j');
      const newEnvelope = makeEnvelope();
      const session = manager.updatePolicy('proj-j', newEnvelope);
      expect(session.approvalEnvelope).toEqual(newEnvelope);
    });

    it('updatePolicy() rejects invalid envelope', () => {
      manager.start('proj-k');
      try {
        manager.updatePolicy('proj-k', { mode: 'bad', rules: {} });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('INVALID_ENVELOPE');
      }
    });

    it('updatePolicy() rejects for nonexistent session', () => {
      try {
        manager.updatePolicy('ghost', makeEnvelope());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('updatePolicy() rejects for terminal session', () => {
      const session = manager.start('proj-l');
      session.transition(SessionState.FAILED);
      try {
        manager.updatePolicy('proj-l', makeEnvelope());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('SESSION_ENDED');
      }
    });

    it('new policy takes effect on next permission', () => {
      // Start with no envelope (all require review)
      const session = manager.start('proj-m');
      expect(session.approvalEnvelope).toBeNull();

      // First permission — should pause (no envelope)
      const promptData1 = 'Claude wants to write to /tmp/bridge-v2-test-policy/proj-m/file.js\nAllow? (y/n)';
      session.permissionParser.feed(promptData1);
      expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);

      // Manually respond to unblock
      manager.respond('proj-m', session.pendingPermission.id, DecisionType.APPROVE_ONCE);
      expect(session.state).toBe(SessionState.RUNNING);

      // Update policy to auto-approve file writes within project
      manager.updatePolicy('proj-m', makeEnvelope());

      // Second permission — should auto-approve now
      const writeSpy = vi.spyOn(session.pty, 'write');
      const promptData2 = 'Claude wants to write to /tmp/bridge-v2-test-policy/proj-m/other.js\nAllow? (y/n)';
      session.permissionParser.feed(promptData2);

      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);
      expect(writeSpy).toHaveBeenCalledWith('\r');
    });
  });

  // ─── Sequential auto-resolutions ──────────────────────────────────────────

  describe('sequential auto-resolutions', () => {
    it('handles multiple auto-approved permissions in sequence', () => {
      const envelope = makeEnvelope();
      const session = manager.start('proj-n', { approvalEnvelope: envelope });
      const writeSpy = vi.spyOn(session.pty, 'write');

      // First auto-approve
      session.permissionParser.feed('Claude wants to write to /tmp/bridge-v2-test-policy/proj-n/a.js\nAllow? (y/n)');
      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);

      // Second auto-approve
      session.permissionParser.feed('Claude wants to write to /tmp/bridge-v2-test-policy/proj-n/b.js\nAllow? (y/n)');
      expect(session.state).toBe(SessionState.RUNNING);
      vi.advanceTimersByTime(500);

      expect(writeSpy).toHaveBeenCalledTimes(2);

      // Event log should have 2 permission + 2 decision events
      const events = session.eventLog.toArray();
      const permEvents = events.filter(e => e.kind === EventKind.PERMISSION);
      const decEvents = events.filter(e => e.kind === EventKind.DECISION);
      expect(permEvents.length).toBe(2);
      expect(decEvents.length).toBe(2);
    });
  });
});
