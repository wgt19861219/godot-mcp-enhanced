import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock gdscript-executor before importing the module under test
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => ({
    success: true,
    compile_success: true,
    compile_error: '',
    errors: [],
    run_success: true,
    run_error: '',
    outputs: [
      { key: 'snapshot', value: '{"fps":60,"memory_static_mb":50}' },
    ],
    raw_output: '',
    duration_ms: 100,
  })),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/profiler-ops.js';
import { executeGdscript } from '../src/gdscript-executor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(),
  };
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('profiler-ops getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has exactly 1 tool definition named profiler', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('profiler');
  });

  it('profiler definition has action enum with all sub-actions', () => {
    const defs = getToolDefinitions();
    const schema = defs[0].inputSchema;
    const actionEnum = schema.properties.action.enum;
    expect(actionEnum).toContain('snapshot');
    expect(actionEnum).toContain('start');
    expect(actionEnum).toContain('stop');
    expect(actionEnum).toContain('get_data');
    expect(actionEnum).toContain('get_active_processes');
    expect(actionEnum).toContain('get_signal_connections');
  });

  it('requires project_path and action', () => {
    const defs = getToolDefinitions();
    const required = defs[0].inputSchema.required;
    expect(required).toContain('project_path');
    expect(required).toContain('action');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('profiler-ops TOOL_META', () => {
  it('has entry for profiler', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.profiler).toBeDefined();
  });

  it('profiler is marked non-readonly and non-long-running', () => {
    expect(TOOL_META.profiler.readonly).toBe(false);
    expect(TOOL_META.profiler.long_running).toBe(false);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('profiler-ops handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — profiler snapshot ─────────────────────────────────────────

describe('profiler-ops handleTool — profiler snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript and returns result for snapshot action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'snapshot',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Performance.get_monitor');
    expect(callArgs.code).toContain('snapshot');
  });
});

// ─── handleTool — profiler start ────────────────────────────────────────────

describe('profiler-ops handleTool — profiler start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for start action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'start',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('profiling_started');
  });
});

// ─── handleTool — profiler stop ─────────────────────────────────────────────

describe('profiler-ops handleTool — profiler stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for stop action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'stop',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('profiling_stopped');
  });
});

// ─── handleTool — profiler get_data ─────────────────────────────────────────

describe('profiler-ops handleTool — profiler get_data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript with frame collection code', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      target_fps: 60,
      frame_count: 30,
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_frame_count');
    expect(callArgs.code).toContain('_mcp_target_fps');
    expect(callArgs.timeout).toBe(45);
  });

  it('uses default target_fps and frame_count when not specified', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_target_fps: float = 60');
    expect(callArgs.code).toContain('_mcp_frame_count: int = 60');
  });
});

// ─── handleTool — profiler get_active_processes ─────────────────────────────

describe('profiler-ops handleTool — profiler get_active_processes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for get_active_processes action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_active_processes',
      node_path: 'root/Player',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('active_processes');
    expect(callArgs.code).toContain('has_method');
  });
});

// ─── handleTool — profiler get_signal_connections ───────────────────────────

describe('profiler-ops handleTool — profiler get_signal_connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for get_signal_connections action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_signal_connections',
      node_path: 'root/Player',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('signal_connections');
    expect(callArgs.code).toContain('get_signal_connection_list');
  });
});

// ─── handleTool — invalid action ────────────────────────────────────────────

describe('profiler-ops handleTool — invalid action', () => {
  it('returns error for unknown action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'nonexistent',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_ACTION');
  });

  it('returns error for out-of-range target_fps', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      target_fps: 9999,
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });
});
