import { expect } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveWithinRoot } from '../src/helpers.js';
import { sanitizeResPath, gdEscape } from '../src/tools/shared.js';

// ─── sanitizeResPath ──────────────────────────────────────────────────────────

describe('sanitizeResPath', () => {
  it('accepts valid res:// path', () => {
    expect(sanitizeResPath('res://scenes/main.tscn', 'path')).toBe('res://scenes/main.tscn');
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeResPath(123, 'path')).toThrow(/must be a string/);
    expect(() => sanitizeResPath(null, 'path')).toThrow(/must be a string/);
  });

  it('rejects missing res:// prefix', () => {
    expect(() => sanitizeResPath('scenes/main.tscn', 'path')).toThrow(/must be a string starting with res:\/\//);
  });

  it('blocks single-encoded traversal (%2e%2e)', () => {
    expect(() => sanitizeResPath('res://scenes/%2e%2e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks double-encoded traversal (%252e)', () => {
    expect(() => sanitizeResPath('res://scenes/%252e%252e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks triple-encoded traversal (%25252e)', () => {
    expect(() => sanitizeResPath('res://scenes/%25252e%25252e/secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('blocks backslash traversal', () => {
    expect(() => sanitizeResPath('res://scenes\\..\\secret.txt', 'path')).toThrow(/path traversal/);
  });

  it('accepts encoded spaces in legitimate path', () => {
    expect(sanitizeResPath('res://assets/my%20file.png', 'path')).toBe('res://assets/my file.png');
  });

  it('accepts unicode in path', () => {
    expect(sanitizeResPath('res://素材/图片.png', 'path')).toBe('res://素材/图片.png');
  });

  it('accepts res:// root path', () => {
    expect(sanitizeResPath('res://', 'path')).toBe('res://');
  });

  it('blocks suffix traversal (res://scenes/..)', () => {
    expect(() => sanitizeResPath('res://scenes/..', 'path')).toThrow(/path traversal/);
  });
});

// ─── resolveWithinRoot iterative decoding ──────────────────────────────────────

describe('resolveWithinRoot iterative decoding', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-security-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks double-encoded traversal (%252e%252e)', () => {
    // %252e%252e → %2e%2e → .. → escapes root
    expect(() => resolveWithinRoot(root, '%252e%252e/secret.txt')).toThrow(/traversal/i);
  });

  it('blocks triple-encoded traversal (%25252e%25252e)', () => {
    expect(() => resolveWithinRoot(root, '%25252e%25252e/secret.txt')).toThrow(/traversal/i);
  });

  it('blocks percent-encoded parent traversal', () => {
    expect(() => resolveWithinRoot(root, '%2e%2e/secret.txt')).toThrow(/traversal/i);
  });

  it('resolves encoded spaces in legitimate path', () => {
    // Just verifying no throw for a legit encoded path
    // The actual resolved path may not exist, but traversal check should pass
    const result = resolveWithinRoot(root, 'my%20file.txt');
    expect(result.includes('my file.txt')).toBeTruthy();
  });
});

// ─── gdEscape edge cases ──────────────────────────────────────────────────────

describe('gdEscape edge cases', () => {
  it('escapes standalone CR (\\r without \\n)', () => {
    // \r alone becomes \n (normalized to LF, then escaped as \\n)
    expect(gdEscape('hello\rworld')).toBe('hello\\nworld');
  });

  it('handles mixed CR and CRLF', () => {
    // CRLF → LF → \\n, standalone CR → LF → \\n
    expect(gdEscape('a\r\nb\rc')).toBe('a\\nb\\nc');
  });

  it('escapes tabs', () => {
    expect(gdEscape('a\tb')).toBe('a\\tb');
  });

  it('handles string with only special characters', () => {
    expect(gdEscape('\t\r\n')).toBe('\\t\\n');
  });

  it('escapes percent sign', () => {
    expect(gdEscape('100%')).toBe('100%%');
  });

  it('escapes dollar sign', () => {
    expect(gdEscape('$var')).toBe('\\$var');
  });

  it('escapes double quote', () => {
    expect(gdEscape('say "hi"')).toBe('say \\"hi\\"');
  });

  it('removes null bytes', () => {
    expect(gdEscape('a\0b')).toBe('ab');
  });

  it('escapes single quote', () => {
    expect(gdEscape("it's")).toBe("it\\'s");
  });

  it('passes through \\uXXXX unchanged (GDScript does not interpret \\u escapes)', () => {
    // GDScript has no \uXXXX escape sequences, so A is literal text.
    // The backslash is still escaped by the general \\ rule.
    expect(gdEscape('\\u0041')).toBe('\\\\u0041');
  });
});
