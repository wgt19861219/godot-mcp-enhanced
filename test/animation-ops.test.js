import { expect, it, beforeEach, describe, vi } from 'vitest';

vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [], raw_output: '', duration_ms: 100,
  })),
}));

vi.mock('../src/helpers.js', () => ({
  requireProjectPath: vi.fn((args) => args.project_path || '/fake/project'),
}));

import { executeGdscript } from '../src/gdscript-executor.js';
import { requireProjectPath } from '../src/helpers.js';
import { TOOL_NAMES, getToolDefinitions, handleTool, TOOL_META } from '../src/tools/animation/animation-ops.js';

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn().mockResolvedValue('/fake/godot'),
    runningProcess: null, setRunningProcess: vi.fn(),
    outputBuffer: [], setOutputBuffer: vi.fn(),
    processStartTime: 0, setProcessStartTime: vi.fn(),
    projectDir: '/fake/project', setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
  };
}
const BASE_ARGS = { project_path: '/fake/project' };

describe('animation-ops exports', () => {
  it('TOOL_NAMES contains animation', () => { expect(TOOL_NAMES).toContain('animation'); });
  it('getToolDefinitions returns valid definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('animation');
    expect(defs[0].inputSchema.required).toContain('action');
  });
  it('TOOL_META marks animation as writable', () => {
    expect(TOOL_META.animation.readonly).toBe(false);
    expect(TOOL_META.animation.long_running).toBe(false);
  });
});

describe('animation-ops routing', () => {
  it('returns null for unknown tool name', async () => {
    const result = await handleTool('unknown_tool', BASE_ARGS, createMockCtx());
    expect(result).toBeNull();
  });
  it('returns error when project_path is missing', async () => {
    vi.mocked(requireProjectPath).mockImplementationOnce(() => { throw new Error('project_path required'); });
    const result = await handleTool('animation', { action: 'list_players' }, createMockCtx());
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
  });
});

describe('animation-ops parameter validation', () => {
  beforeEach(() => { vi.mocked(executeGdscript).mockReset(); });
  it('get_info requires node_path', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'get_info' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('get_details requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'get_details', node_path: 'root/Player' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('get_keyframes requires track_index', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'get_keyframes', node_path: 'root/P', animation_name: 'idle' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('play requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'play', node_path: 'root/P' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('stop requires node_path', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'stop' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('seek requires seconds', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'seek', node_path: 'root/P' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('create requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'create' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('delete requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'delete' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('update_props requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'update_props' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('add_track requires track_type and track_path', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'add_track', node_path: 'root/P', animation_name: 'i' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('remove_track requires track_index', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'remove_track', node_path: 'root/P', animation_name: 'i' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('add_keyframe requires track_index and time', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'add_keyframe', node_path: 'root/P', animation_name: 'i' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('remove_keyframe requires track_index and keyframe_index', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'remove_keyframe', node_path: 'root/P', animation_name: 'i', track_index: 0 }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('update_keyframe requires track_index and keyframe_index', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'update_keyframe', node_path: 'root/P', animation_name: 'i', track_index: 0 }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  // v0.25.0: set_curve 从 animation_track 合并进来
  it('set_curve requires track_index and keyframe_index', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'set_curve', node_path: 'root/P', animation_name: 'i', track_index: 0 }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('set_curve requires node_path and animation_name', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'set_curve', track_index: 0, keyframe_index: 0 }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
  it('blend requires blend_time', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'blend', node_path: 'root/P', animation_name: 'i' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_PARAMS');
  });
});

describe('animation-ops GDScript generation', () => {
  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    vi.mocked(executeGdscript).mockResolvedValue({
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [], raw_output: '', duration_ms: 100,
    });
  });
  function getCode() { return vi.mocked(executeGdscript).mock.calls[0][0].code; }

  it('list_players generates AnimationPlayer search', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'list_players' }, createMockCtx());
    expect(executeGdscript).toHaveBeenCalledOnce();
    expect(getCode()).toContain('AnimationPlayer');
  });
  it('get_info generates current_animation', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'get_info', node_path: 'root/P/A' }, createMockCtx());
    expect(getCode()).toContain('current_animation');
  });
  it('get_details generates track_count', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'get_details', node_path: 'root/P', animation_name: 'walk' }, createMockCtx());
    expect(getCode()).toContain('track_count');
  });
  it('get_keyframes generates track_get_key', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'get_keyframes', node_path: 'root/P', animation_name: 'idle', track_index: 0 }, createMockCtx());
    expect(getCode()).toContain('track_get_key');
  });
  it('play generates .play() call', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'play', node_path: 'root/P', animation_name: 'run' }, createMockCtx());
    expect(getCode()).toContain('.play(');
  });
  it('stop generates .stop() call', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'stop', node_path: 'root/P' }, createMockCtx());
    expect(getCode()).toContain('.stop(');
  });
  it('seek generates .seek() with seconds', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'seek', node_path: 'root/P', seconds: 1.5 }, createMockCtx());
    expect(getCode()).toContain('.seek(');
    expect(getCode()).toContain('1.5');
  });
  it('create generates add_animation', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'create', node_path: 'root/P', animation_name: 'jump' }, createMockCtx());
    expect(getCode()).toContain('add_animation');
  });
  it('delete generates remove_animation', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'delete', node_path: 'root/P', animation_name: 'old' }, createMockCtx());
    expect(getCode()).toContain('remove_animation');
  });
  it('update_props sets length', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'update_props', node_path: 'root/P', animation_name: 'w', length: 2.0 }, createMockCtx());
    expect(getCode()).toContain('length');
  });
  it('add_track generates add_track call', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'add_track', node_path: 'root/P', animation_name: 'i', track_type: 'value', track_path: 'S:f' }, createMockCtx());
    expect(getCode()).toContain('add_track');
  });
  it('add_keyframe generates track_insert_key', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'add_keyframe', node_path: 'root/P', animation_name: 'w', track_index: 0, time: 0.5, value: 42 }, createMockCtx());
    expect(getCode()).toContain('track_insert_key');
  });
  it('blend generates animation name', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'blend', node_path: 'root/P', animation_name: 'idle', blend_time: 0.3 }, createMockCtx());
    expect(getCode()).toContain('idle');
  });
});

describe('animation-ops edge cases', () => {
  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    vi.mocked(executeGdscript).mockResolvedValue({
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [], raw_output: '', duration_ms: 100,
    });
  });
  it('unknown action returns INVALID_ACTION', async () => {
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'nonexistent', node_path: 'root/P' }, createMockCtx());
    expect(r.content[0].text).toContain('INVALID_ACTION');
  });
  it('load_autoloads defaults to true', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'list_players' }, createMockCtx());
    expect(vi.mocked(executeGdscript).mock.calls[0][0].loadAutoloads).toBe(true);
  });
  it('load_autoloads=false is respected', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'list_players', load_autoloads: false }, createMockCtx());
    expect(vi.mocked(executeGdscript).mock.calls[0][0].loadAutoloads).toBe(false);
  });
  it('normalizes node_path with leading slash', async () => {
    await handleTool('animation', { ...BASE_ARGS, action: 'get_info', node_path: '/root/P/A' }, createMockCtx());
    expect(vi.mocked(executeGdscript).mock.calls[0][0].code).toContain('root/P/A');
  });
  it('executeGdscript failure returns error', async () => {
    vi.mocked(executeGdscript).mockResolvedValueOnce({
      success: false, compile_success: false, compile_error: 'err',
      errors: ['err'], run_success: false, run_error: '',
      outputs: [], raw_output: '', duration_ms: 0,
    });
    const r = await handleTool('animation', { ...BASE_ARGS, action: 'list_players' }, createMockCtx());
    expect(r.isError).toBe(true);
  });
});