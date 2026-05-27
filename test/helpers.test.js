import { expect, describe, it, beforeEach, afterAll } from 'vitest';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { validatePath, resolveWithinRoot, ensureDir, normalizeUserProjectPath, allowOutsideProjectPaths, parseConfigValue, isPathInAllowedRoots } from '../src/helpers.js';

describe('validatePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = validatePath('some/relative/path');
    expect(result).toBe(resolve('some/relative/path'));
  });

  it('passes through absolute paths unchanged', () => {
    const abs = resolve('/tmp/test');
    expect(validatePath(abs)).toBe(abs);
  });
});

describe('resolveWithinRoot', () => {
  const root = resolve('/tmp/test-project');

  it('resolves a simple relative path within root', () => {
    const result = resolveWithinRoot(root, 'scripts/player.gd');
    expect(result).toBe(resolve(root, 'scripts/player.gd'));
  });

  it('rejects parent traversal with ..', () => {
    expect(() => resolveWithinRoot(root, '../../../etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects absolute path outside root', () => {
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('accepts paths after stripping res:// prefix', () => {
    const result = resolveWithinRoot(root, 'res://scenes/main.tscn'.replace('res://', ''));
    expect(result.startsWith(root)).toBeTruthy();
  });

  it('handles deep relative paths within root', () => {
    const result = resolveWithinRoot(root, 'a/b/c/d/file.gd');
    expect(result.startsWith(root + sep)).toBeTruthy();
  });

  it('rejects path with .. on Windows-style traversal', () => {
    expect(() => resolveWithinRoot(root, '..\\..\\etc\\passwd')).toThrow(/Path traversal detected/);
  });

  it('rejects mixed slash traversal', () => {
    expect(() => resolveWithinRoot(root, 'valid/../../etc/passwd')).toThrow(/Path traversal detected/);
  });
});

describe('ensureDir', () => {
  const testBase = resolve('/tmp/godot-mcp-test-ensuredir');

  it('creates parent directories if missing', () => {
    const target = `${testBase}/a/b/c/file.gd`;
    ensureDir(target);
    expect(existsSync(`${testBase}/a/b/c`)).toBeTruthy();
    // cleanup
    rmSync(testBase, { recursive: true, force: true });
  });

  it('does not throw when directory already exists', () => {
    mkdirSync(`${testBase}/existing`, { recursive: true });
    writeFileSync(`${testBase}/existing/file.txt`, 'test');
    expect(() => ensureDir(`${testBase}/existing/other.txt`)).not.toThrow();
    rmSync(testBase, { recursive: true, force: true });
  });
});

describe('normalizeUserProjectPath', () => {
  it('strips res:// prefix', () => {
    expect(normalizeUserProjectPath('res://scenes/main.tscn')).toBe('scenes/main.tscn');
  });

  it('returns plain relative path unchanged', () => {
    expect(normalizeUserProjectPath('assets/ui')).toBe('assets/ui');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeUserProjectPath('')).toBe('');
    expect(normalizeUserProjectPath(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(normalizeUserProjectPath(null)).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeUserProjectPath('   ')).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeUserProjectPath('  res://foo  ')).toBe('foo');
  });

  it('does not strip nested res:// in path body', () => {
    expect(normalizeUserProjectPath('res://res://foo')).toBe('res://foo');
  });
});

describe('allowOutsideProjectPaths', () => {
  it('returns false by default', () => {
    expect(allowOutsideProjectPaths()).toBe(false);
  });

  it('returns true when env var is exactly "true"', () => {
    const orig = process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = 'true';
    expect(allowOutsideProjectPaths()).toBe(true);
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = orig;
  });

  it('returns false for case-insensitive variants', () => {
    const orig = process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
    for (const val of ['TRUE', 'True', '1', 'yes']) {
      process.env.ALLOW_OUTSIDE_PROJECT_PATHS = val;
      expect(allowOutsideProjectPaths()).toBe(false);
    }
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = orig;
  });
});

// ─── parseConfigValue ──────────────────────────────────────────────────────────

describe('parseConfigValue (I-06)', () => {
  it('parses integers', () => {
    expect(parseConfigValue('42')).toBe(42);
  });

  it('parses floats', () => {
    expect(parseConfigValue('3.14')).toBe(3.14);
  });

  it('parses negative numbers', () => {
    expect(parseConfigValue('-1')).toBe(-1);
  });

  it('parses zero', () => {
    expect(parseConfigValue('0')).toBe(0);
  });

  it('returns string for non-numeric text', () => {
    expect(parseConfigValue('hello')).toBe('hello');
  });

  it('returns string for whitespace-only input (I-06 fix)', () => {
    expect(parseConfigValue(' ')).toBe(' ');
    expect(parseConfigValue('  ')).toBe('  ');
    expect(parseConfigValue('\t')).toBe('\t');
  });

  it('parses booleans', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('false')).toBe(false);
  });

  it('parses null', () => {
    expect(parseConfigValue('null')).toBe(null);
  });

  it('strips double quotes', () => {
    expect(parseConfigValue('"hello"')).toBe('hello');
  });

  it('parses empty array', () => {
    expect(parseConfigValue('[]')).toEqual([]);
  });
});

// ─── isPathInAllowedRoots deny-by-default ────────────────────────────────────

describe('isPathInAllowedRoots deny-by-default', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    delete process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should allow cwd when no whitelist set', () => {
    const cwd = process.cwd();
    expect(isPathInAllowedRoots(cwd)).toBe(true);
  });

  it('should deny paths outside cwd when no whitelist set', () => {
    expect(isPathInAllowedRoots('/definitely/outside/path')).toBe(false);
  });

  it('should allow GODOT_MCP_UNRESTRICTED to bypass', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect(isPathInAllowedRoots('/any/path')).toBe(true);
  });

  it('should respect ALLOWED_PROJECT_PATHS whitelist', () => {
    const tmp = tmpdir();
    process.env.ALLOWED_PROJECT_PATHS = tmp;
    expect(isPathInAllowedRoots(tmp)).toBe(true);
    expect(isPathInAllowedRoots('/not/in/whitelist')).toBe(false);
  });

  it('should allow subdirectories of cwd when no whitelist set', () => {
    const cwd = process.cwd();
    expect(isPathInAllowedRoots(resolve(cwd, 'subdir'))).toBe(true);
  });
});
