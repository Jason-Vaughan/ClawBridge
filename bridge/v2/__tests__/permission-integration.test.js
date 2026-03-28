import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Session } = require('../sessions');
const { SessionState, EventKind, PermissionType, RiskLevel } = require('../types');
const { PermissionParser } = require('../permission-parser');

/**
 * Integration tests for permission detection through the full session pipeline.
 *
 * These tests wire a PermissionParser into a Session (the same way SessionManager does)
 * and simulate PTY data events to verify the complete flow:
 *   PTY data → parser detection → event log entry → session state transition
 */
describe('Permission detection integration', () => {
  const projectDir = '/home/user/projects/myapp';
  let session;

  /**
   * Helper: set up a session in RUNNING state with a wired permission parser,
   * simulating what SessionManager.start() does.
   */
  function createWiredSession(project = 'test-project') {
    const sess = new Session('sess_integ123', project, projectDir);
    sess.transition(SessionState.RUNNING);

    sess.permissionParser = new PermissionParser({
      projectRoot: projectDir,
      sessionId: sess.sessionId,
      project,
      onPermission: (permEvent) => {
        sess.eventLog.append(EventKind.PERMISSION, { event: permEvent });
        sess.pendingPermission = permEvent;
        if (sess.state === SessionState.RUNNING) {
          sess.transition(SessionState.WAITING_FOR_PERMISSION);
        }
      },
    });

    return sess;
  }

  /**
   * Simulate PTY data arriving at the session — feeds text to event log and parser,
   * mirroring the pty 'data' handler in SessionManager.start().
   */
  function simulatePtyData(sess, data) {
    sess.eventLog.appendText(data);
    if (!sess.isTerminal && sess.state !== SessionState.WAITING_FOR_PERMISSION) {
      sess.permissionParser.feed(data);
    }
  }

  beforeEach(() => {
    session = createWiredSession();
  });

  it('detects file write permission and transitions to waiting_for_permission', () => {
    simulatePtyData(session, 'Claude wants to write to src/index.js\nAllow? (y/n)\n');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission).not.toBeNull();
    expect(session.pendingPermission.permissionType).toBe(PermissionType.FILE_WRITE);
    expect(session.pendingPermission.target.path).toBe('src/index.js');
    expect(session.pendingPermission.withinProject).toBe(true);
    expect(session.pendingPermission.risk).toBe(RiskLevel.LOW);
    expect(session.pendingPermission.sessionId).toBe('sess_integ123');
    expect(session.pendingPermission.project).toBe('test-project');
  });

  it('detects file delete permission', () => {
    simulatePtyData(session, 'Claude wants to delete src/old-file.js\nAllow? (y/n)\n');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission.permissionType).toBe(PermissionType.FILE_DELETE);
    expect(session.pendingPermission.target.path).toBe('src/old-file.js');
    expect(session.pendingPermission.risk).toBe(RiskLevel.MEDIUM);
  });

  it('detects shell command permission', () => {
    simulatePtyData(session, 'Claude wants to run: npm test\nAllow? (y/n)\n');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission.permissionType).toBe(PermissionType.SHELL_COMMAND);
    expect(session.pendingPermission.target.command).toBe('npm test');
    expect(session.pendingPermission.risk).toBe(RiskLevel.MEDIUM);
  });

  it('detects git operation and assigns correct risk', () => {
    simulatePtyData(session, 'Claude wants to run: git push --force\nAllow? (y/n)\n');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission.permissionType).toBe(PermissionType.GIT_OPERATION);
    expect(session.pendingPermission.risk).toBe(RiskLevel.HIGH);
  });

  it('detects dependency change from npm install', () => {
    simulatePtyData(session, 'Claude wants to run: npm install better-sqlite3\nAllow? (y/n)\n');

    expect(session.pendingPermission.permissionType).toBe(PermissionType.DEPENDENCY_CHANGE);
    expect(session.pendingPermission.risk).toBe(RiskLevel.MEDIUM);
  });

  it('detects network access from curl', () => {
    simulatePtyData(session, 'Claude wants to run: curl https://api.example.com\nAllow? (y/n)\n');

    expect(session.pendingPermission.permissionType).toBe(PermissionType.NETWORK_ACCESS);
  });

  it('includes pendingPermissionId in session JSON', () => {
    simulatePtyData(session, 'Claude wants to write to src/f.js\nAllow? (y/n)\n');

    const json = session.toJSON();
    expect(json.pendingPermissionId).toBe(session.pendingPermission.id);
  });

  it('permission event appears in event log with correct structure', () => {
    simulatePtyData(session, 'Claude wants to write to src/a.js\nAllow? (y/n)\n');

    const allEvents = session.eventLog.read(0).events;
    const permEvent = allEvents.find(e => e.kind === EventKind.PERMISSION);

    expect(permEvent).toBeDefined();
    expect(permEvent.seq).toBeGreaterThan(0); // After lifecycle events + text event
    expect(permEvent.timestamp).toBeDefined();
    expect(permEvent.event.permissionType).toBe(PermissionType.FILE_WRITE);
    expect(permEvent.event.id).toMatch(/^perm_/);
  });

  it('lifecycle events show starting→running→waiting_for_permission transitions', () => {
    simulatePtyData(session, 'Claude wants to edit src/routes.js\nAllow? (y/n)\n');

    const allEvents = session.eventLog.read(0).events;
    const lifecycles = allEvents.filter(e => e.kind === EventKind.LIFECYCLE);

    // starting→running (from createWiredSession), running→waiting_for_permission (from detection)
    expect(lifecycles.length).toBeGreaterThanOrEqual(2);

    const waitTransition = lifecycles.find(e => e.toState === SessionState.WAITING_FOR_PERMISSION);
    expect(waitTransition).toBeDefined();
    expect(waitTransition.fromState).toBe(SessionState.RUNNING);
  });

  it('does not detect permission from normal output', () => {
    simulatePtyData(session, 'Running tests...\nAll 42 tests passed.\nDone.\n');

    const allEvents = session.eventLog.read(0).events;
    const permEvents = allEvents.filter(e => e.kind === EventKind.PERMISSION);
    expect(permEvents).toHaveLength(0);
    expect(session.state).toBe(SessionState.RUNNING);
    expect(session.pendingPermission).toBeNull();
  });

  it('does not fire parser while in waiting_for_permission state', () => {
    // Trigger first permission
    simulatePtyData(session, 'Claude wants to write to src/a.js\nAllow? (y/n)\n');
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);

    const countBefore = session.eventLog.read(0).events
      .filter(e => e.kind === EventKind.PERMISSION).length;

    // More data arrives while waiting — parser guard should skip it
    simulatePtyData(session, 'Claude wants to write to src/b.js\nAllow? (y/n)\n');

    const countAfter = session.eventLog.read(0).events
      .filter(e => e.kind === EventKind.PERMISSION).length;

    expect(countAfter).toBe(countBefore);
  });

  it('does not fire parser in terminal state', () => {
    session.transition(SessionState.COMPLETED);

    simulatePtyData(session, 'Claude wants to write to src/a.js\nAllow? (y/n)\n');

    const permEvents = session.eventLog.read(0).events
      .filter(e => e.kind === EventKind.PERMISSION);
    expect(permEvents).toHaveLength(0);
    expect(session.pendingPermission).toBeNull();
  });

  it('detects permission split across multiple data chunks', () => {
    simulatePtyData(session, 'Claude wants to write to src/index.js\n');
    expect(session.state).toBe(SessionState.RUNNING);

    simulatePtyData(session, 'Allow? (y/n)\n');
    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission.permissionType).toBe(PermissionType.FILE_WRITE);
  });

  it('detects file write outside project as high risk', () => {
    simulatePtyData(session, 'Claude wants to write to /etc/config.json\nAllow? (y/n)\n');

    expect(session.pendingPermission.withinProject).toBe(false);
    expect(session.pendingPermission.risk).toBe(RiskLevel.HIGH);
  });

  it('handles ANSI-encoded output from PTY', () => {
    simulatePtyData(session, '\x1b[1m\x1b[33mClaude wants to write to\x1b[0m src/f.js\nAllow? (y/n)\n');

    expect(session.state).toBe(SessionState.WAITING_FOR_PERMISSION);
    expect(session.pendingPermission.permissionType).toBe(PermissionType.FILE_WRITE);
    expect(session.pendingPermission.target.path).toBe('src/f.js');
  });

  it('event ordering: text event before permission event', () => {
    simulatePtyData(session, 'Claude wants to write to src/f.js\nAllow? (y/n)\n');

    const allEvents = session.eventLog.read(0).events;
    const textEvent = allEvents.find(e => e.kind === EventKind.TEXT);
    const permEvent = allEvents.find(e => e.kind === EventKind.PERMISSION);

    expect(textEvent).toBeDefined();
    expect(permEvent).toBeDefined();
    expect(textEvent.seq).toBeLessThan(permEvent.seq);
  });
});
