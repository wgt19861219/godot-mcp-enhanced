import { expect } from 'vitest';
import {
  MARKER_RESULT, SCENE_TREE_HEADER, NON_PERSIST,
  opsSuccess, opsError, opsErrorResult, parseGdscriptResult,
  validateIdentifier,
  validateTimeout,
} from '../src/tools/shared.js';

describe('shared constants', () => {
  it('MARKER_RESULT is a non-empty string', () => {
    expect(typeof MARKER_RESULT === 'string' && MARKER_RESULT.length > 0).toBeTruthy();
  });
  it('SCENE_TREE_HEADER contains extends SceneTree', () => {
    expect(SCENE_TREE_HEADER.includes('extends SceneTree')).toBeTruthy();
    expect(SCENE_TREE_HEADER.includes('_mcp_done')).toBeTruthy();
  });
  it('NON_PERSIST is a non-empty string', () => {
    expect(typeof NON_PERSIST === 'string' && NON_PERSIST.length > 0).toBeTruthy();
  });
});

describe('opsSuccess', () => {
  it('returns success result with data', () => {
    const r = opsSuccess({ x: 1 });
    expect(r).toEqual({ success: true, data: { x: 1 }, warnings: [] });
  });
  it('includes warnings', () => {
    const r = opsSuccess(null, ['w1']);
    expect(r.warnings).toEqual(['w1']);
  });
});

describe('opsError', () => {
  it('returns error result with code and message', () => {
    const r = opsError('TEST_CODE', 'test msg');
    expect(r).toEqual({ success: false, error: 'test msg', error_code: 'TEST_CODE', warnings: [] });
  });
});

describe('opsErrorResult', () => {
  it('returns a ToolResult with error JSON', () => {
    const r = opsErrorResult('CODE', 'msg');
    expect(r.content[0].type).toBe('text');
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('CODE');
  });
});

describe('parseGdscriptResult', () => {
  it('returns compile error as SCRIPT_EXEC_FAILED', () => {
    const r = parseGdscriptResult({
      compile_success: false, compile_error: 'syntax error',
      run_success: false, run_error: '', outputs: [],
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('SCRIPT_EXEC_FAILED');
  });
  it('returns run error as SCRIPT_EXEC_FAILED', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: false, run_error: 'crashed', outputs: [],
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('SCRIPT_EXEC_FAILED');
  });
  it('parses outputs into data', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: true, run_error: '',
      outputs: [
        { key: 'hit', value: 'true' },
        { key: 'position', value: '{"x":1,"y":2}' },
      ],
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.hit).toBe(true);
    expect(parsed.data.position).toEqual({ x: 1, y: 2 });
  });
  it('uses errorMapper for error outputs', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: true, run_error: '',
      outputs: [{ key: 'error', value: 'Node not found: /root/X' }],
    }, [], (msg) => msg.includes('Node not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED');
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('NODE_NOT_FOUND');
  });
  it('merges paramWarnings with output warnings', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: true, run_error: '',
      outputs: [{ key: 'warning', value: 'clamped' }],
    }, ['param_warn']);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.warnings).toEqual(['param_warn', 'clamped']);
  });
});

describe('validateIdentifier', () => {
  it('accepts valid GDScript identifiers', () => {
    expect(() => validateIdentifier('Node3D', 'test')).not.toThrow();
    expect(() => validateIdentifier('Camera3D', 'test')).not.toThrow();
    expect(() => validateIdentifier('_private', 'test')).not.toThrow();
    expect(() => validateIdentifier('StandardMaterial3D', 'test')).not.toThrow();
  });
  it('rejects identifiers starting with a digit', () => {
    expect(() => validateIdentifier('3DNode', 'test')).toThrow(/not a valid GDScript identifier/);
  });
  it('rejects identifiers with special characters', () => {
    expect(() => validateIdentifier('Node;rm -rf', 'test')).toThrow(/not a valid GDScript identifier/);
  });
  it('rejects identifiers with spaces', () => {
    expect(() => validateIdentifier('My Node', 'test')).toThrow(/not a valid GDScript identifier/);
  });
  it('rejects empty string', () => {
    expect(() => validateIdentifier('', 'test')).toThrow(/not a valid GDScript identifier/);
  });
  it('rejects identifiers with dots', () => {
    expect(() => validateIdentifier('Node3D.new()', 'test')).toThrow(/not a valid GDScript identifier/);
  });
  it('rejects names longer than 64 characters', () => {
    const longName = 'a'.repeat(65);
    expect(() => validateIdentifier(longName, 'test')).toThrow(/64 characters/);
  });
  it('accepts names exactly 64 characters', () => {
    const maxName = 'a'.repeat(64);
    expect(() => validateIdentifier(maxName, 'test')).not.toThrow();
  });
});

describe('validateTimeout', () => {
  it('clamps timeout to [5, 120] range', () => {
    expect(validateTimeout(0)).toBe(5);
    expect(validateTimeout(200)).toBe(120);
    expect(validateTimeout(30)).toBe(30);
  });
  it('returns default for undefined', () => {
    expect(validateTimeout(undefined)).toBe(30);
  });
  it('returns default for null', () => {
    expect(validateTimeout(null)).toBe(30);
  });
  it('returns default for NaN string', () => {
    expect(validateTimeout('abc')).toBe(30);
  });
  it('rounds fractional values', () => {
    expect(validateTimeout(10.7)).toBe(11);
  });
});
