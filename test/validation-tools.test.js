import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KNOWN_BASE_METHODS,
  isErrorFalsePositive,
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/validation.js';

// ─── Mock executor ──────────────────────────────────────────────────────────

vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => ({
    success: true,
    compile_success: true,
    compile_error: '',
    errors: [],
    run_success: true,
    run_error: '',
    outputs: [{ key: 'result', value: '{"ok":true}' }],
    raw_output: '',
    duration_ms: 100,
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/usr/bin/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('validation-tools: KNOWN_BASE_METHODS', () => {
  it('is non-empty', () => {
    expect(KNOWN_BASE_METHODS.size).toBeGreaterThan(0);
  });

  it('contains common lifecycle methods', () => {
    expect(KNOWN_BASE_METHODS.has('_ready')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('_process')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('_physics_process')).toBe(true);
  });

  it('contains common node methods', () => {
    expect(KNOWN_BASE_METHODS.has('add_child')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('queue_free')).toBe(true);
    expect(KNOWN_BASE_METHODS.has('get_tree')).toBe(true);
  });
});

describe('validation-tools: getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('includes validate_scripts tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('validate_scripts');
  });

  it('includes validate_project tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('validate_project');
  });

  it('includes run_and_verify tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toContain('run_and_verify');
  });
});

describe('validation-tools: TOOL_META', () => {
  it('has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThan(0);
  });

  it('has readonly flag on validate_project', () => {
    expect(TOOL_META.validate_project).toBeDefined();
    expect(TOOL_META.validate_project.readonly).toBe(true);
  });

  it('has long_running flag on run_and_verify', () => {
    expect(TOOL_META.run_and_verify).toBeDefined();
    expect(TOOL_META.run_and_verify.long_running).toBe(true);
  });
});

describe('validation-tools: handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool_xyz', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns null for empty tool name', async () => {
    const result = await handleTool('', {}, makeCtx());
    expect(result).toBeNull();
  });
});

describe('validation-tools: isErrorFalsePositive additional cases', () => {
  it('returns true for Condition "is true" engine noise', () => {
    const line = 'Condition "!editor_preview" is true.';
    expect(isErrorFalsePositive(line)).toBe(true);
  });

  it('returns true for ScriptBus internal error', () => {
    const line = 'SCRIPT ERROR: Parse Error: Function "ScriptBus" not found in base self.';
    expect(isErrorFalsePositive(line)).toBe(true);
  });

  it('returns false for real syntax error', () => {
    const line = 'SCRIPT ERROR: Parse Error: Unexpected indent.';
    expect(isErrorFalsePositive(line)).toBe(false);
  });

  it('returns false for real identifier not found', () => {
    const line = 'SCRIPT ERROR: Parse Error: Identifier "my_custom_func" not found in the current scope.';
    expect(isErrorFalsePositive(line)).toBe(false);
  });
});
