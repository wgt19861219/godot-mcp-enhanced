import { expect } from 'vitest';
import {
  MARKER_RESULT, SCENE_TREE_HEADER, NON_PERSIST,
  opsSuccess, opsError, opsErrorResult, parseGdscriptResult,
  validateIdentifier,
  validateTimeout,
} from '../src/tools/shared.js';

describe('shared constants', () => {
  it('MARKER_RESULT is a non-empty string', () => {
    expect(typeof MARKER_RESULT).toBe('string');
    expect(MARKER_RESULT.length).toBeGreaterThan(0);
  });
  it('SCENE_TREE_HEADER contains extends SceneTree', () => {
    expect(SCENE_TREE_HEADER).toContain('extends SceneTree');
    expect(SCENE_TREE_HEADER).toContain('_mcp_done');
  });
  it('NON_PERSIST is a non-empty string', () => {
    expect(typeof NON_PERSIST).toBe('string');
    expect(NON_PERSIST.length).toBeGreaterThan(0);
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
    // 批 A/A1 (2026-11-13): 未登记码自动补 retryable:false(保守,不拒调用)——
    // 详见 test/core/error-codes.test.ts 与 docs/error-codes.md。
    const r = opsError('TEST_CODE', 'test msg');
    expect(r).toEqual({ success: false, error: 'test msg', error_code: 'TEST_CODE', warnings: [], retryable: false });
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
  // 内存治理一期 Task 5:看门狗杀归因优先——executor 命中 wasMemKilled 时结果带
  // mem_budget_exceeded 标志,此处改报 MEM_BUDGET_EXCEEDED(retryable:false + resource),
  // 优先于 compile/run 两分支的 SCRIPT_EXEC_FAILED(超预算非脚本自身失败)。
  it('mem_budget_exceeded 优先改报 MEM_BUDGET_EXCEEDED(注册表补全 retryable/category)', () => {
    const r = parseGdscriptResult({
      compile_success: true, compile_error: '',
      run_success: false,
      run_error: '内存预算超限被看门狗终止: 峰值 5.0 GB / 声明 1024MB×2。若为合法重负载,调 GODOT_MCP_DECLARED_MB_HEADLESS 上调档位',
      outputs: [], mem_budget_exceeded: true,
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_code).toBe('MEM_BUDGET_EXCEEDED');
    expect(parsed.error).toContain('内存预算超限被看门狗终止');
    expect(parsed.retryable).toBe(false);
    expect(parsed.error_category).toBe('resource');
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
