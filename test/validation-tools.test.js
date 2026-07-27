import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KNOWN_BASE_METHODS,
  isErrorFalsePositive,
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/validation.js';

// v0.25.0: validation 输出改为双轨（人类可读文本 + 尾部 ---JSON--- JSON）
function parseDualTrack(text) {
  const marker = '---JSON---\n';
  const idx = text.lastIndexOf(marker);
  return JSON.parse(idx >= 0 ? text.slice(idx + marker.length) : text);
}

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

vi.mock('../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(async () => ({
    stdout: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    stderr: '',
    output: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    exitCode: 0,
    timedOut: false,
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

  it('includes validation merged tool with all actions', () => {
    const defs = getToolDefinitions();
    const vd = defs.find(d => d.name === 'validation');
    expect(vd).toBeDefined();
    const actionEnum = vd.inputSchema.properties.action.enum;
    expect(actionEnum).toContain('validate_scripts');
    expect(actionEnum).toContain('validate_project');
    expect(actionEnum).toContain('run_and_verify');
    expect(actionEnum).toContain('analyze_error');
    expect(actionEnum).toContain('import_resources');
  });
});

describe('validation-tools: TOOL_META', () => {
  it('has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThan(0);
  });

  it('has validation entry with correct flags', () => {
    expect(TOOL_META.validation).toBeDefined();
    expect(TOOL_META.validation.readonly).toBe(false);
    expect(TOOL_META.validation.long_running).toBe(true);
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

// ─── run_and_verify: spawnGodot path (V-01 fix) ─────────────────────────────

describe('run_and_verify: spawnGodot path (V-01 fix)', () => {
  it('calls ctx.setProjectDir before spawnGodot', async () => {
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    await handleTool('validation', args, ctx);
    expect(ctx.setProjectDir).toHaveBeenCalledWith('/fake/project');
  });

  it('returns analysis with timed out message when spawnGodot times out', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: 'some output\n',
      stderr: '',
      output: 'some output\n',
      exitCode: null,
      timedOut: true,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project', timeout: 5 };
    const result = await handleTool('validation', args, ctx);
    const parsed = parseDualTrack(result.content[0].text);
    expect(parsed.summary).toContain('timed out');
  });

  it('returns analysis with exit code message when spawnGodot exits non-zero', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: '',
      stderr: 'SCRIPT ERROR: something broke\n',
      output: 'SCRIPT ERROR: something broke\n',
      exitCode: 1,
      timedOut: false,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    const result = await handleTool('validation', args, ctx);
    const parsed = parseDualTrack(result.content[0].text);
    expect(parsed.summary).toContain('exited with code 1');
  });
});
