import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for project file helpers: getContentType, validateProjectPath, listProjectFiles.
 *
 * These are extracted from server.js logic and tested via re-implementation
 * since server.js doesn't export them. The implementations here mirror the
 * server.js code exactly.
 */

// ── Mirror of server.js helpers (for unit testing) ──

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
};

/** @param {string} filename */
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.claude']);

/**
 * @param {string} projectsDir
 * @param {string} project
 * @param {string} [subPath]
 */
function validateProjectPath(projectsDir, project, subPath) {
  if (!project || project.includes('..') || project.includes('\0') || project.includes('/')) {
    return { valid: false, projectDir: '', resolvedPath: '', error: 'Invalid project name' };
  }
  const projectDir = path.join(projectsDir, project);
  if (!subPath) {
    return { valid: true, projectDir, resolvedPath: projectDir };
  }
  if (subPath.includes('\0') || path.isAbsolute(subPath)) {
    return { valid: false, projectDir, resolvedPath: '', error: 'Invalid path' };
  }
  const resolvedPath = path.resolve(projectDir, subPath);
  const resolvedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(resolvedProjectDir + path.sep) && resolvedPath !== resolvedProjectDir) {
    return { valid: false, projectDir, resolvedPath, error: 'Path escapes project directory' };
  }
  try {
    const real = fs.realpathSync(resolvedPath);
    const realProjectsDir = fs.realpathSync(projectsDir);
    if (!real.startsWith(realProjectsDir + path.sep) && !real.startsWith(realProjectsDir)) {
      return { valid: false, projectDir, resolvedPath, error: 'Symlink escapes allowed directory' };
    }
  } catch { /* file doesn't exist */ }
  return { valid: true, projectDir, resolvedPath };
}

/**
 * @param {string} baseDir
 * @param {object} [options]
 */
function listProjectFiles(baseDir, options = {}) {
  const recursive = options.recursive || false;
  const maxDepth = options.maxDepth ?? 10;
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const project = options.project || '';
  const startDir = options.subPath ? path.join(baseDir, options.subPath) : baseDir;
  if (!fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) {
    return [];
  }
  const files = [];
  function walk(dir, relPrefix, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (recursive) {
          walk(path.join(dir, entry.name), relPath, depth + 1);
        } else {
          let children = 0;
          try { children = fs.readdirSync(path.join(dir, entry.name)).filter(n => !excludeDirs.has(n)).length; } catch {}
          files.push({ name: entry.name, path: relPath, type: 'directory', children });
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            name: entry.name,
            path: relPath,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            type: 'file',
            url: project ? `/projects/${project}/files/${relPath}` : undefined
          });
        } catch {}
      }
    }
  }
  walk(startDir, options.subPath || '', 0);
  return files;
}

// ── Test fixtures ──

let tmpDir;
let projectsDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-files-test-'));
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsDir);

  // Create a test project structure:
  // projects/demo/
  //   index.js (20 bytes)
  //   README.md (10 bytes)
  //   src/
  //     app.js (15 bytes)
  //     utils/
  //       helper.js (8 bytes)
  //   node_modules/
  //     pkg.js (5 bytes)
  //   .git/
  //     config (3 bytes)
  const demo = path.join(projectsDir, 'demo');
  fs.mkdirSync(path.join(demo, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(demo, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(demo, '.git'), { recursive: true });

  fs.writeFileSync(path.join(demo, 'index.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(demo, 'README.md'), '# Demo\n\n');
  fs.writeFileSync(path.join(demo, 'src', 'app.js'), 'export default 1;');
  fs.writeFileSync(path.join(demo, 'src', 'utils', 'helper.js'), 'fn() {}');
  fs.writeFileSync(path.join(demo, 'node_modules', 'pkg.js'), 'mod()');
  fs.writeFileSync(path.join(demo, '.git', 'config'), 'cfg');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──

describe('getContentType', () => {
  it('returns correct type for known extensions', () => {
    expect(getContentType('app.js')).toBe('text/javascript; charset=utf-8');
    expect(getContentType('style.css')).toBe('text/css; charset=utf-8');
    expect(getContentType('data.json')).toBe('application/json; charset=utf-8');
    expect(getContentType('image.png')).toBe('image/png');
    expect(getContentType('doc.md')).toBe('text/markdown; charset=utf-8');
    expect(getContentType('photo.JPG')).toBe('image/jpeg');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getContentType('file.xyz')).toBe('application/octet-stream');
    expect(getContentType('binary.wasm')).toBe('application/octet-stream');
  });

  it('handles files with no extension', () => {
    expect(getContentType('Makefile')).toBe('application/octet-stream');
  });
});

describe('validateProjectPath', () => {
  it('accepts a valid project name', () => {
    const r = validateProjectPath(projectsDir, 'demo');
    expect(r.valid).toBe(true);
    expect(r.projectDir).toBe(path.join(projectsDir, 'demo'));
  });

  it('accepts a valid project + subpath', () => {
    const r = validateProjectPath(projectsDir, 'demo', 'src/app.js');
    expect(r.valid).toBe(true);
    expect(r.resolvedPath).toBe(path.join(projectsDir, 'demo', 'src', 'app.js'));
  });

  it('rejects .. in project name', () => {
    const r = validateProjectPath(projectsDir, '..', 'etc/passwd');
    expect(r.valid).toBe(false);
  });

  it('rejects .. traversal in subpath', () => {
    const r = validateProjectPath(projectsDir, 'demo', '../../etc/passwd');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/escapes/i);
  });

  it('rejects null bytes in project name', () => {
    const r = validateProjectPath(projectsDir, 'demo\0evil');
    expect(r.valid).toBe(false);
  });

  it('rejects null bytes in subpath', () => {
    const r = validateProjectPath(projectsDir, 'demo', 'file\0.js');
    expect(r.valid).toBe(false);
  });

  it('rejects absolute paths in subpath', () => {
    const r = validateProjectPath(projectsDir, 'demo', '/etc/passwd');
    expect(r.valid).toBe(false);
  });

  it('rejects slash in project name', () => {
    const r = validateProjectPath(projectsDir, 'demo/evil');
    expect(r.valid).toBe(false);
  });

  it('rejects empty project name', () => {
    const r = validateProjectPath(projectsDir, '');
    expect(r.valid).toBe(false);
  });
});

describe('listProjectFiles', () => {
  it('lists files and directories non-recursively', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'));
    const names = files.map(f => f.name);
    expect(names).toContain('index.js');
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    // Excluded by default
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('directories show type and children count', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'));
    const src = files.find(f => f.name === 'src');
    expect(src.type).toBe('directory');
    expect(src.children).toBe(2); // app.js and utils
  });

  it('files show size, mtime, and type', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'));
    const idx = files.find(f => f.name === 'index.js');
    expect(idx.type).toBe('file');
    expect(idx.size).toBeGreaterThan(0);
    expect(idx.mtime).toBeTruthy();
  });

  it('generates URLs when project is provided', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), { project: 'demo' });
    const idx = files.find(f => f.name === 'index.js');
    expect(idx.url).toBe('/projects/demo/files/index.js');
  });

  it('lists files recursively', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), { recursive: true, project: 'demo' });
    const paths = files.map(f => f.path);
    expect(paths).toContain('index.js');
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/app.js');
    expect(paths).toContain('src/utils/helper.js');
    // No directories in recursive mode
    expect(files.every(f => f.type === 'file')).toBe(true);
    // Excluded dirs' contents not included
    expect(paths).not.toContain('node_modules/pkg.js');
    expect(paths).not.toContain('.git/config');
  });

  it('scopes listing to subPath', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), { subPath: 'src', project: 'demo' });
    const names = files.map(f => f.name);
    expect(names).toContain('app.js');
    expect(names).toContain('utils');
    expect(names).not.toContain('index.js');
  });

  it('recursive + subPath lists nested files', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), {
      subPath: 'src', recursive: true, project: 'demo'
    });
    const paths = files.map(f => f.path);
    expect(paths).toContain('src/app.js');
    expect(paths).toContain('src/utils/helper.js');
  });

  it('returns empty for nonexistent directory', () => {
    const files = listProjectFiles(path.join(projectsDir, 'nope'));
    expect(files).toEqual([]);
  });

  it('returns empty for nonexistent subPath', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), { subPath: 'nonexistent' });
    expect(files).toEqual([]);
  });

  it('respects maxDepth', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), {
      recursive: true, maxDepth: 0
    });
    const paths = files.map(f => f.path);
    // Depth 0 = only root level files
    expect(paths).toContain('index.js');
    expect(paths).not.toContain('src/app.js');
  });

  it('excludes custom directories', () => {
    const files = listProjectFiles(path.join(projectsDir, 'demo'), {
      excludeDirs: new Set(['src'])
    });
    const names = files.map(f => f.name);
    expect(names).not.toContain('src');
    // Default exclusions no longer apply
    expect(names).toContain('node_modules');
  });
});
