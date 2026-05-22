import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveWithinRoot } from '../build/helpers.js';
import { sanitizeResPath, gdEscape } from '../build/tools/shared.js';

// ─── sanitizeResPath ──────────────────────────────────────────────────────────

describe('sanitizeResPath', () => {
  it('accepts valid res:// path', () => {
    assert.equal(sanitizeResPath('res://scenes/main.tscn', 'path'), 'res://scenes/main.tscn');
  });

  it('rejects non-string input', () => {
    assert.throws(() => sanitizeResPath(123, 'path'), /must be a string/);
    assert.throws(() => sanitizeResPath(null, 'path'), /must be a string/);
  });

  it('rejects missing res:// prefix', () => {
    assert.throws(() => sanitizeResPath('scenes/main.tscn', 'path'), /must be a string starting with res:\/\//);
  });

  it('blocks single-encoded traversal (%2e%2e)', () => {
    assert.throws(
      () => sanitizeResPath('res://scenes/%2e%2e/secret.txt', 'path'),
      /path traversal/,
    );
  });

  it('blocks double-encoded traversal (%252e)', () => {
    assert.throws(
      () => sanitizeResPath('res://scenes/%252e%252e/secret.txt', 'path'),
      /path traversal/,
    );
  });

  it('blocks triple-encoded traversal (%25252e)', () => {
    assert.throws(
      () => sanitizeResPath('res://scenes/%25252e%25252e/secret.txt', 'path'),
      /path traversal/,
    );
  });

  it('blocks backslash traversal', () => {
    assert.throws(
      () => sanitizeResPath('res://scenes\\..\\secret.txt', 'path'),
      /path traversal/,
    );
  });

  it('accepts encoded spaces in legitimate path', () => {
    assert.equal(
      sanitizeResPath('res://assets/my%20file.png', 'path'),
      'res://assets/my file.png',
    );
  });

  it('accepts unicode in path', () => {
    assert.equal(
      sanitizeResPath('res://素材/图片.png', 'path'),
      'res://素材/图片.png',
    );
  });

  it('accepts res:// root path', () => {
    assert.equal(sanitizeResPath('res://', 'path'), 'res://');
  });

  it('blocks suffix traversal (res://scenes/..)', () => {
    assert.throws(
      () => sanitizeResPath('res://scenes/..', 'path'),
      /path traversal/,
    );
  });
});

// ─── resolveWithinRoot iterative decoding ──────────────────────────────────────

describe('resolveWithinRoot iterative decoding', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-security-test-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks double-encoded traversal (%252e%252e)', () => {
    // %252e%252e → %2e%2e → .. → escapes root
    assert.throws(
      () => resolveWithinRoot(root, '%252e%252e/secret.txt'),
      /traversal/i,
    );
  });

  it('blocks triple-encoded traversal (%25252e%25252e)', () => {
    assert.throws(
      () => resolveWithinRoot(root, '%25252e%25252e/secret.txt'),
      /traversal/i,
    );
  });

  it('blocks percent-encoded parent traversal', () => {
    assert.throws(
      () => resolveWithinRoot(root, '%2e%2e/secret.txt'),
      /traversal/i,
    );
  });

  it('resolves encoded spaces in legitimate path', () => {
    // Just verifying no throw for a legit encoded path
    // The actual resolved path may not exist, but traversal check should pass
    const result = resolveWithinRoot(root, 'my%20file.txt');
    assert.ok(result.includes('my file.txt'));
  });
});

// ─── gdEscape edge cases ──────────────────────────────────────────────────────

describe('gdEscape edge cases', () => {
  it('escapes standalone CR (\\r without \\n)', () => {
    // \r alone becomes \n (normalized to LF, then escaped as \\n)
    assert.equal(gdEscape('hello\rworld'), 'hello\\nworld');
  });

  it('handles mixed CR and CRLF', () => {
    // CRLF → LF → \\n, standalone CR → LF → \\n
    assert.equal(gdEscape('a\r\nb\rc'), 'a\\nb\\nc');
  });

  it('escapes tabs', () => {
    assert.equal(gdEscape('a\tb'), 'a\\tb');
  });

  it('handles string with only special characters', () => {
    assert.equal(gdEscape('\t\r\n'), '\\t\\n');
  });

  it('escapes percent sign', () => {
    assert.equal(gdEscape('100%'), '100%%');
  });

  it('escapes dollar sign', () => {
    assert.equal(gdEscape('$var'), '\\$var');
  });

  it('escapes double quote', () => {
    assert.equal(gdEscape('say "hi"'), 'say \\"hi\\"');
  });

  it('removes null bytes', () => {
    assert.equal(gdEscape('a\0b'), 'ab');
  });

  it('escapes single quote', () => {
    assert.equal(gdEscape("it's"), "it\\'s");
  });

  it('escapes unicode escape sequence (\\uXXXX)', () => {
    // A → step3: \\u0041 → step11: \\A (backslash escaped then \u pattern escaped)
    assert.equal(gdEscape('\\u0041'), '\\\\\\u0041');
  });
});
