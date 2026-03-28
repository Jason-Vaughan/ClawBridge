import { describe, it, expect, beforeEach } from 'vitest';

const {
  PermissionParser,
  stripAnsi,
  isWithinProject,
  classifyCommand,
  assignRisk,
  isDestructiveGit,
} = require('../permission-parser');
const { PermissionType, RiskLevel } = require('../types');

// ─── stripAnsi ───────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('removes cursor movement codes', () => {
    expect(stripAnsi('\x1b[2Jhello\x1b[H')).toBe('hello');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07content')).toBe('content');
  });

  it('strips carriage returns', () => {
    expect(stripAnsi('line1\r\nline2')).toBe('line1\nline2');
  });

  it('passes through clean text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles complex mixed ANSI sequences', () => {
    const input = '\x1b[1m\x1b[34mClaude\x1b[0m wants to \x1b[33mwrite\x1b[0m';
    expect(stripAnsi(input)).toBe('Claude wants to write');
  });
});

// ─── isWithinProject ─────────────────────────────────────────────────────────

describe('isWithinProject', () => {
  const projectRoot = '/home/user/projects/myapp';

  it('returns true for paths inside project root', () => {
    expect(isWithinProject('/home/user/projects/myapp/src/index.js', projectRoot)).toBe(true);
  });

  it('returns true for project root itself', () => {
    expect(isWithinProject('/home/user/projects/myapp', projectRoot)).toBe(true);
  });

  it('returns true for relative paths within project', () => {
    expect(isWithinProject('src/index.js', projectRoot)).toBe(true);
  });

  it('returns false for paths outside project root', () => {
    expect(isWithinProject('/home/user/projects/other/file.js', projectRoot)).toBe(false);
  });

  it('returns false for parent traversal attacks', () => {
    expect(isWithinProject('/home/user/projects/myapp/../other/secret.txt', projectRoot)).toBe(false);
  });

  it('returns false for prefix-matching traps (myapp-extra)', () => {
    expect(isWithinProject('/home/user/projects/myapp-extra/file.js', projectRoot)).toBe(false);
  });

  it('returns false when projectRoot is empty', () => {
    expect(isWithinProject('/any/path', '')).toBe(false);
  });

  it('handles trailing slashes on project root', () => {
    expect(isWithinProject('/home/user/projects/myapp/src/f.js', '/home/user/projects/myapp/')).toBe(true);
  });
});

// ─── classifyCommand ─────────────────────────────────────────────────────────

describe('classifyCommand', () => {
  it('classifies git commands as GIT_OPERATION', () => {
    expect(classifyCommand('git status')).toBe(PermissionType.GIT_OPERATION);
    expect(classifyCommand('git push --force')).toBe(PermissionType.GIT_OPERATION);
  });

  it('classifies npm install as DEPENDENCY_CHANGE', () => {
    expect(classifyCommand('npm install better-sqlite3')).toBe(PermissionType.DEPENDENCY_CHANGE);
  });

  it('classifies yarn add as DEPENDENCY_CHANGE', () => {
    expect(classifyCommand('yarn add express')).toBe(PermissionType.DEPENDENCY_CHANGE);
  });

  it('classifies pip install as DEPENDENCY_CHANGE', () => {
    expect(classifyCommand('pip install requests')).toBe(PermissionType.DEPENDENCY_CHANGE);
  });

  it('classifies curl as NETWORK_ACCESS', () => {
    expect(classifyCommand('curl https://example.com')).toBe(PermissionType.NETWORK_ACCESS);
  });

  it('classifies wget as NETWORK_ACCESS', () => {
    expect(classifyCommand('wget https://example.com/file.tar.gz')).toBe(PermissionType.NETWORK_ACCESS);
  });

  it('classifies ssh as NETWORK_ACCESS', () => {
    expect(classifyCommand('ssh user@host')).toBe(PermissionType.NETWORK_ACCESS);
  });

  it('classifies generic commands as SHELL_COMMAND', () => {
    expect(classifyCommand('npm test')).toBe(PermissionType.SHELL_COMMAND);
    expect(classifyCommand('ls -la')).toBe(PermissionType.SHELL_COMMAND);
    expect(classifyCommand('cat /etc/hosts')).toBe(PermissionType.SHELL_COMMAND);
  });
});

// ─── isDestructiveGit ────────────────────────────────────────────────────────

describe('isDestructiveGit', () => {
  it('flags git push --force', () => {
    expect(isDestructiveGit('git push --force')).toBe(true);
  });

  it('flags git reset --hard', () => {
    expect(isDestructiveGit('git reset --hard HEAD~1')).toBe(true);
  });

  it('flags git clean -fd', () => {
    expect(isDestructiveGit('git clean -fd')).toBe(true);
  });

  it('flags git branch -D', () => {
    expect(isDestructiveGit('git branch -D feature')).toBe(true);
  });

  it('flags git rebase', () => {
    expect(isDestructiveGit('git rebase main')).toBe(true);
  });

  it('does not flag git status', () => {
    expect(isDestructiveGit('git status')).toBe(false);
  });

  it('does not flag git add', () => {
    expect(isDestructiveGit('git add -A')).toBe(false);
  });

  it('does not flag git commit', () => {
    expect(isDestructiveGit('git commit -m "msg"')).toBe(false);
  });
});

// ─── assignRisk ──────────────────────────────────────────────────────────────

describe('assignRisk', () => {
  it('assigns LOW for file_write within project', () => {
    expect(assignRisk(PermissionType.FILE_WRITE, { path: 'src/f.js' }, true)).toBe(RiskLevel.LOW);
  });

  it('assigns HIGH for file_write outside project', () => {
    expect(assignRisk(PermissionType.FILE_WRITE, { path: '/etc/passwd' }, false)).toBe(RiskLevel.HIGH);
  });

  it('assigns MEDIUM for file_delete within project', () => {
    expect(assignRisk(PermissionType.FILE_DELETE, { path: 'src/f.js' }, true)).toBe(RiskLevel.MEDIUM);
  });

  it('assigns HIGH for file_delete outside project', () => {
    expect(assignRisk(PermissionType.FILE_DELETE, { path: '/etc/hosts' }, false)).toBe(RiskLevel.HIGH);
  });

  it('assigns MEDIUM for shell_command', () => {
    expect(assignRisk(PermissionType.SHELL_COMMAND, { command: 'npm test' }, true)).toBe(RiskLevel.MEDIUM);
  });

  it('assigns LOW for safe git commands', () => {
    expect(assignRisk(PermissionType.GIT_OPERATION, { command: 'git status' }, true)).toBe(RiskLevel.LOW);
  });

  it('assigns HIGH for destructive git commands', () => {
    expect(assignRisk(PermissionType.GIT_OPERATION, { command: 'git push --force' }, true)).toBe(RiskLevel.HIGH);
  });

  it('assigns MEDIUM for dependency_change', () => {
    expect(assignRisk(PermissionType.DEPENDENCY_CHANGE, {}, true)).toBe(RiskLevel.MEDIUM);
  });

  it('assigns MEDIUM for network_access', () => {
    expect(assignRisk(PermissionType.NETWORK_ACCESS, {}, true)).toBe(RiskLevel.MEDIUM);
  });

  it('assigns HIGH for unknown', () => {
    expect(assignRisk(PermissionType.UNKNOWN, {}, false)).toBe(RiskLevel.HIGH);
  });

  it('assigns MEDIUM for config_change', () => {
    expect(assignRisk(PermissionType.CONFIG_CHANGE, {}, true)).toBe(RiskLevel.MEDIUM);
  });
});

// ─── PermissionParser ────────────────────────────────────────────────────────

describe('PermissionParser', () => {
  const projectRoot = '/home/user/projects/myapp';
  let parser;
  let detected;

  beforeEach(() => {
    detected = [];
    parser = new PermissionParser({
      projectRoot,
      sessionId: 'sess_test123',
      project: 'myapp',
      onPermission: (event) => detected.push(event),
    });
  });

  describe('file write detection', () => {
    it('detects "Claude wants to write to <path>"', () => {
      parser.feed('Claude wants to write to src/index.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/index.js');
      expect(detected[0].withinProject).toBe(true);
      expect(detected[0].risk).toBe(RiskLevel.LOW);
    });

    it('detects "Claude wants to create <path>"', () => {
      parser.feed('Claude wants to create src/new-file.ts\nAllow this action? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/new-file.ts');
    });

    it('detects "Claude wants to edit <path>"', () => {
      parser.feed('Claude wants to edit src/routes/jobs.ts\nAllow? [y/n/a]\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/routes/jobs.ts');
      expect(detected[0].action.summary).toContain('Edit file');
    });

    it('detects file write outside project as HIGH risk', () => {
      parser.feed('Claude wants to write to /etc/config.json\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].withinProject).toBe(false);
      expect(detected[0].risk).toBe(RiskLevel.HIGH);
    });

    it('detects Write(path) tool-style pattern', () => {
      parser.feed('Using Write(src/utils.js) to create file\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/utils.js');
    });

    it('detects Edit(path) tool-style pattern', () => {
      parser.feed('Using Edit(src/main.js) to modify file\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/main.js');
    });
  });

  describe('file delete detection', () => {
    it('detects "Claude wants to delete <path>"', () => {
      parser.feed('Claude wants to delete src/old-file.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_DELETE);
      expect(detected[0].target.path).toBe('src/old-file.js');
      expect(detected[0].withinProject).toBe(true);
      expect(detected[0].risk).toBe(RiskLevel.MEDIUM);
    });

    it('assigns HIGH risk for delete outside project', () => {
      parser.feed('Claude wants to delete /tmp/important.db\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].risk).toBe(RiskLevel.HIGH);
      expect(detected[0].withinProject).toBe(false);
    });
  });

  describe('shell command detection', () => {
    it('detects "Claude wants to run: <command>"', () => {
      parser.feed('Claude wants to run: npm test\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.SHELL_COMMAND);
      expect(detected[0].target.command).toBe('npm test');
      expect(detected[0].risk).toBe(RiskLevel.MEDIUM);
    });

    it('detects "Claude wants to execute: <command>"', () => {
      parser.feed('Claude wants to execute: ls -la\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.SHELL_COMMAND);
      expect(detected[0].target.command).toBe('ls -la');
    });

    it('detects Bash(command) tool-style pattern', () => {
      parser.feed('Using Bash(npm run build) to build project\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.SHELL_COMMAND);
      expect(detected[0].target.command).toBe('npm run build');
    });

    it('classifies git commands via run pattern', () => {
      parser.feed('Claude wants to run: git status\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.GIT_OPERATION);
    });

    it('classifies npm install via run pattern', () => {
      parser.feed('Claude wants to run: npm install lodash\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.DEPENDENCY_CHANGE);
    });

    it('classifies curl as network access', () => {
      parser.feed('Claude wants to run: curl https://api.example.com\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.NETWORK_ACCESS);
    });
  });

  describe('ANSI handling', () => {
    it('detects prompts with ANSI color codes', () => {
      parser.feed('\x1b[1m\x1b[33mClaude wants to write to\x1b[0m src/index.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
      expect(detected[0].target.path).toBe('src/index.js');
    });

    it('detects prompts with cursor movement codes', () => {
      parser.feed('\x1b[2K\x1b[1GClaude wants to run: npm test\r\n\x1b[2K\x1b[1GAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.SHELL_COMMAND);
    });
  });

  describe('multi-chunk buffering', () => {
    it('detects prompt split across two feeds', () => {
      parser.feed('Claude wants to write to src/index.js\n');
      expect(detected).toHaveLength(0);
      parser.feed('Allow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.FILE_WRITE);
    });

    it('detects prompt split across many small chunks', () => {
      parser.feed('Claude wants');
      expect(detected).toHaveLength(0);
      parser.feed(' to write to');
      expect(detected).toHaveLength(0);
      parser.feed(' src/app.js\n');
      expect(detected).toHaveLength(0);
      // "Allow?" contains confirmation pattern, and buffer already has the full prompt
      parser.feed('Allow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].target.path).toBe('src/app.js');
    });
  });

  describe('unknown/ambiguous prompts', () => {
    it('emits unknown for unrecognized prompt with confirmation line', () => {
      parser.feed('Something unexpected happened\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      expect(detected[0].permissionType).toBe(PermissionType.UNKNOWN);
      expect(detected[0].risk).toBe(RiskLevel.HIGH);
      expect(detected[0].withinProject).toBe(false);
    });
  });

  describe('parser state management', () => {
    it('does not double-detect after first detection', () => {
      parser.feed('Claude wants to write to src/index.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      // Feeding more data while pending should not trigger again
      parser.feed('More output\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
    });

    it('detects again after reset', () => {
      parser.feed('Claude wants to write to src/a.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(1);
      parser.reset();
      parser.feed('Claude wants to write to src/b.js\nAllow? (y/n)\n');
      expect(detected).toHaveLength(2);
      expect(detected[1].target.path).toBe('src/b.js');
    });

    it('returns the detected event from feed()', () => {
      const result = parser.feed('Claude wants to write to src/f.js\nAllow? (y/n)\n');
      expect(result).not.toBeNull();
      expect(result.permissionType).toBe(PermissionType.FILE_WRITE);
    });

    it('returns null when no prompt detected', () => {
      const result = parser.feed('Just some regular output\n');
      expect(result).toBeNull();
    });
  });

  describe('permission event structure', () => {
    it('includes all required fields per spec', () => {
      parser.feed('Claude wants to write to src/index.js\nAllow? (y/n)\n');
      const event = detected[0];

      expect(event.id).toMatch(/^perm_[a-f0-9]{12}$/);
      expect(event.kind).toBe('permission');
      expect(event.createdAt).toBeTruthy();
      expect(event.sessionId).toBe('sess_test123');
      expect(event.project).toBe('myapp');
      expect(event.rawPrompt).toBeTruthy();
      expect(event.permissionType).toBe(PermissionType.FILE_WRITE);
      expect(event.risk).toBe(RiskLevel.LOW);
      expect(event.requiresResponse).toBe(true);
      expect(event.withinProject).toBe(true);
      expect(event.target).toEqual({ path: 'src/index.js' });
      expect(event.action).toEqual({ summary: 'Write file src/index.js', details: null });
      expect(event.policyEvaluation).toEqual({
        matchedRule: null,
        suggestedDecision: null,
        reason: null,
      });
      expect(event).toHaveProperty('timeoutAt');
    });

    it('generates unique IDs for each permission', () => {
      parser.feed('Claude wants to write to src/a.js\nAllow? (y/n)\n');
      parser.reset();
      parser.feed('Claude wants to write to src/b.js\nAllow? (y/n)\n');
      expect(detected[0].id).not.toBe(detected[1].id);
    });
  });

  describe('confirmation pattern variants', () => {
    it('matches "Allow?"', () => {
      parser.feed('Claude wants to delete src/old.js\nAllow?\n');
      expect(detected).toHaveLength(1);
    });

    it('matches "Allow this action?"', () => {
      parser.feed('Claude wants to write to src/f.js\nAllow this action?\n');
      expect(detected).toHaveLength(1);
    });

    it('matches "Do you want to allow"', () => {
      parser.feed('Claude wants to run: npm test\nDo you want to allow this?\n');
      expect(detected).toHaveLength(1);
    });

    it('matches "[Y/N]" style', () => {
      parser.feed('Claude wants to edit src/f.js\n[Y/N]\n');
      expect(detected).toHaveLength(1);
    });

    it('matches "(y/n)" style', () => {
      parser.feed('Claude wants to write to src/f.js\n(y/n)\n');
      expect(detected).toHaveLength(1);
    });

    it('matches "(y/n/a)" style', () => {
      parser.feed('Claude wants to write to src/f.js\n(y/n/a)\n');
      expect(detected).toHaveLength(1);
    });
  });

  describe('does not false-positive', () => {
    it('does not trigger on normal text without confirmation', () => {
      parser.feed('Working on updating src/index.js\nRunning tests...\nAll 42 tests passed.\n');
      expect(detected).toHaveLength(0);
    });

    it('does not trigger on text mentioning "write" without prompt structure', () => {
      parser.feed('I will write the implementation for the new feature.\n');
      expect(detected).toHaveLength(0);
    });
  });
});
