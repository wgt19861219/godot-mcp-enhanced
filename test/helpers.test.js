import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { validatePath, resolveWithinRoot, ensureDir, normalizeUserProjectPath, allowOutsideProjectPaths } from '../build/helpers.js';

describe('validatePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = validatePath('some/relative/path');
    assert.strictEqual(result, resolve('some/relative/path'));
  });

  it('passes through absolute paths unchanged', () => {
    const abs = resolve('/tmp/test');
    assert.strictEqual(validatePath(abs), abs);
  });
});

describe('resolveWithinRoot', () => {
  const root = resolve('/tmp/test-project');

  it('resolves a simple relative path within root', () => {
    const result = resolveWithinRoot(root, 'scripts/player.gd');
    assert.strictEqual(result, resolve(root, 'scripts/player.gd'));
  });

  it('rejects parent traversal with ..', () => {
    assert.throws(
      () => resolveWithinRoot(root, '../../../etc/passwd'),
      { message: /Path traversal detected/ }
    );
  });

  it('rejects absolute path outside root', () => {
    assert.throws(
      () => resolveWithinRoot(root, '/etc/passwd'),
      { message: /Path traversal detected/ }
    );
  });

  it('accepts paths after stripping res:// prefix', () => {
    const result = resolveWithinRoot(root, 'res://scenes/main.tscn'.replace('res://', ''));
    assert.ok(result.startsWith(root));
  });

  it('handles deep relative paths within root', () => {
    const result = resolveWithinRoot(root, 'a/b/c/d/file.gd');
    assert.ok(result.startsWith(root + sep));
  });

  it('rejects path with .. on Windows-style traversal', () => {
    assert.throws(
      () => resolveWithinRoot(root, '..\\\\..\\\\etc\\\\passwd'),
      { message: /Path traversal detected/ }
    );
  });


  it('rejects repeated backslash traversal segments', () => {
    assert.throws(
      () => resolveWithinRoot(root, '..\\..\\etc\\passwd'),
      { message: /Path traversal detected/ }
    );
  });

  it('accepts normal Windows-style separators within root', () => {
    const result = resolveWithinRoot(root, 'scripts\\player.gd');
    assert.strictEqual(result, resolve(root, 'scripts/player.gd'));
  });
  it('rejects mixed slash traversal', () => {
    assert.throws(
      () => resolveWithinRoot(root, 'valid/../../etc/passwd'),
      { message: /Path traversal detected/ }
    );
  });
});

describe('ensureDir', () => {
  const testBase = resolve('/tmp/godot-mcp-test-ensuredir');

  it('creates parent directories if missing', () => {
    const target = `${testBase}/a/b/c/file.gd`;
    ensureDir(target);
    assert.ok(existsSync(`${testBase}/a/b/c`));
    // cleanup
    rmSync(testBase, { recursive: true, force: true });
  });

  it('does not throw when directory already exists', () => {
    mkdirSync(`${testBase}/existing`, { recursive: true });
    writeFileSync(`${testBase}/existing/file.txt`, 'test');
    assert.doesNotThrow(() => ensureDir(`${testBase}/existing/other.txt`));
    rmSync(testBase, { recursive: true, force: true });
  });
});

describe('normalizeUserProjectPath', () => {
  it('strips res:// prefix', () => {
    assert.strictEqual(normalizeUserProjectPath('res://scenes/main.tscn'), 'scenes/main.tscn');
  });

  it('returns plain relative path unchanged', () => {
    assert.strictEqual(normalizeUserProjectPath('assets/ui'), 'assets/ui');
  });

  it('returns empty string for empty input', () => {
    assert.strictEqual(normalizeUserProjectPath(''), '');
    assert.strictEqual(normalizeUserProjectPath(undefined), '');
  });

  it('returns empty string for null', () => {
    assert.strictEqual(normalizeUserProjectPath(null), '');
  });

  it('returns empty string for whitespace-only input', () => {
    assert.strictEqual(normalizeUserProjectPath('   '), '');
  });

  it('trims whitespace', () => {
    assert.strictEqual(normalizeUserProjectPath('  res://foo  '), 'foo');
  });

  it('does not strip nested res:// in path body', () => {
    assert.strictEqual(normalizeUserProjectPath('res://res://foo'), 'res://foo');
  });
});

describe('allowOutsideProjectPaths', () => {
  it('returns false by default', () => {
    assert.strictEqual(allowOutsideProjectPaths(), false);
  });

  it('returns true when env var is exactly "true"', () => {
    const orig = process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = 'true';
    assert.strictEqual(allowOutsideProjectPaths(), true);
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = orig;
  });

  it('returns false for case-insensitive variants', () => {
    const orig = process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
    for (const val of ['TRUE', 'True', '1', 'yes']) {
      process.env.ALLOW_OUTSIDE_PROJECT_PATHS = val;
      assert.strictEqual(allowOutsideProjectPaths(), false, `should reject "${val}"`);
    }
    process.env.ALLOW_OUTSIDE_PROJECT_PATHS = orig;
  });
});