import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_RESULT, SCENE_TREE_HEADER, NON_PERSIST,
  opsSuccess, opsError, opsErrorResult, parseGdscriptResult,
  validateIdentifier,
  validateTimeout,
} from '../build/tools/shared.js';

describe('shared constants', () => {
  it('MARKER_RESULT is a non-empty string', () => {
    assert.ok(typeof MARKER_RESULT === 'string' && MARKER_RESULT.length > 0);
  });
  it('SCENE_TREE_HEADER contains extends SceneTree', () => {
    assert.ok(SCENE_TREE_HEADER.includes('extends SceneTree'));
    assert.ok(SCENE_TREE_HEADER.includes('_mcp_done'));
  });
  it('NON_PERSIST is a non-empty string', () => {
    assert.ok(typeof NON_PERSIST === 'string' && NON_PERSIST.length > 0);
  });
});

describe('opsSuccess', () => {
  it('returns success result with data', () => {
    const r = opsSuccess({ x: 1 });
    assert.deepStrictEqual(r, { success: true, data: { x: 1 }, warnings: [] });
  });
  it('includes warnings', () => {
    const r = opsSuccess(null, ['w1']);
    assert.deepStrictEqual(r.warnings, ['w1']);
  });
});

describe('opsError', () => {
  it('returns error result with code and message', () => {
    const r = opsError('TEST_CODE', 'test msg');
    assert.deepStrictEqual(r, { success: false, error: 'test msg', error_code: 'TEST_CODE', warnings: [] });
  });
});

describe('opsErrorResult', () => {
  it('returns a ToolResult with error JSON', () => {
    const r = opsErrorResult('CODE', 'msg');
    assert.strictEqual(r.content[0].type, 'text');
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error_code, 'CODE');
  });
});

describe('parseGdscriptResult', () => {
  it('returns compile error as SCRIPT_EXEC_FAILED', () => {
    const r = parseGdscriptResult({
      compile_success: false, compile_error: 'syntax error',
      run_success: false, run_error: '', outputs: [],
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.error_code, 'SCRIPT_EXEC_FAILED');
  });
  it('returns run error as SCRIPT_EXEC_FAILED', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: false, run_error: 'crashed', outputs: [],
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.error_code, 'SCRIPT_EXEC_FAILED');
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
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.hit, true);
    assert.deepStrictEqual(parsed.data.position, { x: 1, y: 2 });
  });
  it('uses errorMapper for error outputs', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: true, run_error: '',
      outputs: [{ key: 'error', value: 'Node not found: /root/X' }],
    }, [], (msg) => msg.includes('Node not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED');
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.error_code, 'NODE_NOT_FOUND');
  });
  it('merges paramWarnings with output warnings', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: true, run_error: '',
      outputs: [{ key: 'warning', value: 'clamped' }],
    }, ['param_warn']);
    const parsed = JSON.parse(r.content[0].text);
    assert.deepStrictEqual(parsed.warnings, ['param_warn', 'clamped']);
  });
});

describe('validateIdentifier', () => {
  it('accepts valid GDScript identifiers', () => {
    assert.doesNotThrow(() => validateIdentifier('Node3D', 'test'));
    assert.doesNotThrow(() => validateIdentifier('Camera3D', 'test'));
    assert.doesNotThrow(() => validateIdentifier('_private', 'test'));
    assert.doesNotThrow(() => validateIdentifier('StandardMaterial3D', 'test'));
  });
  it('rejects identifiers starting with a digit', () => {
    assert.throws(() => validateIdentifier('3DNode', 'test'), /not a valid GDScript identifier/);
  });
  it('rejects identifiers with special characters', () => {
    assert.throws(() => validateIdentifier('Node;rm -rf', 'test'), /not a valid GDScript identifier/);
  });
  it('rejects identifiers with spaces', () => {
    assert.throws(() => validateIdentifier('My Node', 'test'), /not a valid GDScript identifier/);
  });
  it('rejects empty string', () => {
    assert.throws(() => validateIdentifier('', 'test'), /not a valid GDScript identifier/);
  });
  it('rejects identifiers with dots', () => {
    assert.throws(() => validateIdentifier('Node3D.new()', 'test'), /not a valid GDScript identifier/);
  });
  it('rejects names longer than 64 characters', () => {
    const longName = 'a'.repeat(65);
    assert.throws(() => validateIdentifier(longName, 'test'), /64 characters/);
  });
  it('accepts names exactly 64 characters', () => {
    const maxName = 'a'.repeat(64);
    assert.doesNotThrow(() => validateIdentifier(maxName, 'test'));
  });
});

describe('validateTimeout', () => {
  it('clamps timeout to [5, 120] range', () => {
    assert.strictEqual(validateTimeout(0), 5);
    assert.strictEqual(validateTimeout(200), 120);
    assert.strictEqual(validateTimeout(30), 30);
  });
  it('returns default for undefined', () => {
    assert.strictEqual(validateTimeout(undefined), 30);
  });
  it('returns default for null', () => {
    assert.strictEqual(validateTimeout(null), 30);
  });
  it('returns default for NaN string', () => {
    assert.strictEqual(validateTimeout('abc'), 30);
  });
  it('rounds fractional values', () => {
    assert.strictEqual(validateTimeout(10.7), 11);
  });
});
