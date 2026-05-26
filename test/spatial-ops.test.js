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
      { key: 'nodes', value: '[{"path":"Player","type":"CharacterBody3D"}]' },
      { key: 'count', value: '1' },
    ],
    raw_output: '',
    duration_ms: 100,
  })),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/spatial-ops.js';
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

describe('spatial-ops getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has exactly 1 tool definition named spatial_info', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('spatial_info');
  });

  it('spatial_info definition has action enum with 3 sub-actions', () => {
    const defs = getToolDefinitions();
    const schema = defs[0].inputSchema;
    const actionEnum = schema.properties.action.enum;
    expect(actionEnum).toContain('get_node_info');
    expect(actionEnum).toContain('get_bounds');
    expect(actionEnum).toContain('find_in_aabb');
  });

  it('requires project_path and action', () => {
    const defs = getToolDefinitions();
    const required = defs[0].inputSchema.required;
    expect(required).toContain('project_path');
    expect(required).toContain('action');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('spatial-ops TOOL_META', () => {
  it('has entry for spatial_info', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.spatial_info).toBeDefined();
  });

  it('spatial_info is marked readonly and non-long-running', () => {
    expect(TOOL_META.spatial_info.readonly).toBe(true);
    expect(TOOL_META.spatial_info.long_running).toBe(false);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('spatial-ops handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — get_node_info ─────────────────────────────────────────────

describe('spatial-ops handleTool — get_node_info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript and returns result', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_node_info',
      node_path: 'root/Player',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_get_node');
    expect(callArgs.code).toContain('Node3D');
  });

  it('returns error when node_path is missing', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_node_info',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('node_path required');
  });

  it('generates code with include_children logic when set', async () => {
    const ctx = createMockCtx();
    await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_node_info',
      node_path: 'root/Level',
      include_children: true,
      type_filter: 'MeshInstance3D',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('get_children');
    expect(callArgs.code).toContain('MeshInstance3D');
  });
});

// ─── handleTool — get_bounds ────────────────────────────────────────────────

describe('spatial-ops handleTool — get_bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for get_bounds action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_bounds',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('combined_aabb');
    expect(callArgs.code).toContain('VisualInstance3D');
  });

  it('generates code with root_path when specified', async () => {
    const ctx = createMockCtx();
    await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_bounds',
      root_path: 'root/Level',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_get_node');
    expect(callArgs.code).toContain('root/Level');
  });
});

// ─── handleTool — find_in_aabb ──────────────────────────────────────────────

describe('spatial-ops handleTool — find_in_aabb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for find_in_aabb action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'find_in_aabb',
      aabb_min: { x: 0, y: 0, z: 0 },
      aabb_size: { x: 10, y: 10, z: 10 },
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('AABB');
    expect(callArgs.code).toContain('has_point');
  });

  it('returns error when aabb_min is missing', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'find_in_aabb',
      aabb_size: { x: 10, y: 10, z: 10 },
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('aabb_min');
  });

  it('returns error when aabb_size is missing', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'find_in_aabb',
      aabb_min: { x: 0, y: 0, z: 0 },
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('aabb_size');
  });

  it('returns error for invalid aabb_min values', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'find_in_aabb',
      aabb_min: { x: 'bad', y: 0, z: 0 },
      aabb_size: { x: 10, y: 10, z: 10 },
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });
});

// ─── handleTool — invalid action ────────────────────────────────────────────

describe('spatial-ops handleTool — invalid action', () => {
  it('returns error for unknown action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'nonexistent',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_ACTION');
  });
});
