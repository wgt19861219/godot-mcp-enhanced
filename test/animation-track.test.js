import { expect, it, describe } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  TOOL_META,
  handleTool,
  genAnimationTrackAdd,
  genAnimationTrackRemove,
  genAnimationKeyframeAdd,
  genAnimationKeyframeRemove,
  genAnimationKeyframeUpdate,
  genAnimationCurve,
} from '../build/tools/animation-track.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── TOOL_NAMES ──────────────────────────────────────────────────────────────

describe('animation-track TOOL_NAMES', () => {
  it('contains 3 tool names', () => {
    expect(TOOL_NAMES.length).toBe(3);
  });
  const expected = ['animation_track', 'animation_keyframe', 'animation_curve'];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(TOOL_NAMES.includes(name)).toBeTruthy();
    });
  }
});

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('animation-track getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBeGreaterThan(0);
  });
  it('returns 3 definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(3);
  });
  it('each definition has name and inputSchema', () => {
    for (const def of getToolDefinitions()) {
      expect(def.name).toBeTruthy();
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('animation-track TOOL_META', () => {
  it('has entries for all tool names', () => {
    for (const name of TOOL_NAMES) {
      expect(name in TOOL_META).toBeTruthy();
    }
  });
  it('all tools are non-readonly and non-long-running', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_META[name].readonly).toBe(false);
      expect(TOOL_META[name].long_running).toBe(false);
    }
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('animation-track handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('animation_track rejects missing node_path', async () => {
    const result = await handleTool('animation_track', {
      project_path: '/fake/project',
      animation_name: 'idle',
      action: 'add',
      track_type: 'value',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animation_track rejects missing track_type for add', async () => {
    const result = await handleTool('animation_track', {
      project_path: '/fake/project',
      node_path: 'root/AP',
      animation_name: 'idle',
      action: 'add',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animation_track rejects missing track_index for remove', async () => {
    const result = await handleTool('animation_track', {
      project_path: '/fake/project',
      node_path: 'root/AP',
      animation_name: 'idle',
      action: 'remove',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animation_keyframe rejects missing time for add', async () => {
    const result = await handleTool('animation_keyframe', {
      project_path: '/fake/project',
      node_path: 'root/AP',
      animation_name: 'idle',
      action: 'add',
      track_index: 0,
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animation_keyframe rejects missing keyframe_index for remove', async () => {
    const result = await handleTool('animation_keyframe', {
      project_path: '/fake/project',
      node_path: 'root/AP',
      animation_name: 'idle',
      action: 'remove',
      track_index: 0,
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animation_curve rejects missing track_index', async () => {
    const result = await handleTool('animation_curve', {
      project_path: '/fake/project',
      node_path: 'root/AP',
      animation_name: 'idle',
      keyframe_index: 0,
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// ─── genAnimationTrackAdd ────────────────────────────────────────────────────

describe('genAnimationTrackAdd', () => {
  it('generates script with track type and path', () => {
    const script = genAnimationTrackAdd('root/AP', 'idle', 'value', 'Sprite2D:frame', undefined);
    expect(script.includes('add_track(0)')).toBeTruthy();
    expect(script.includes('Sprite2D:frame')).toBeTruthy();
    expect(script.includes('idle')).toBeTruthy();
  });

  it('generates script with insert_at position', () => {
    const script = genAnimationTrackAdd('root/AP', 'walk', 'position_3d', undefined, 2);
    expect(script.includes('add_track(1, 2)')).toBeTruthy();
  });

  it('generates script without track path when not provided', () => {
    const script = genAnimationTrackAdd('root/AP', 'idle', 'value', undefined, undefined);
    expect(script.includes('track_set_path')).toBeFalsy();
  });
});

// ─── genAnimationTrackRemove ─────────────────────────────────────────────────

describe('genAnimationTrackRemove', () => {
  it('generates script with track index', () => {
    const script = genAnimationTrackRemove('root/AP', 'idle', 3);
    expect(script.includes('remove_track(3)')).toBeTruthy();
    expect(script.includes('idle')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeAdd ─────────────────────────────────────────────────

describe('genAnimationKeyframeAdd', () => {
  it('generates script with time and value', () => {
    const script = genAnimationKeyframeAdd('root/AP', 'idle', 0, 0.5, 100, 1.0);
    expect(script.includes('track_insert_key(0, 0.5, 100, 1)')).toBeTruthy();
  });

  it('generates script with default transition', () => {
    const script = genAnimationKeyframeAdd('root/AP', 'idle', 0, 1.0, [1, 2, 3], undefined);
    expect(script.includes('1')).toBeTruthy();
    expect(script.includes('Vector3(1, 2, 3)')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeRemove ──────────────────────────────────────────────

describe('genAnimationKeyframeRemove', () => {
  it('generates script with track and keyframe index', () => {
    const script = genAnimationKeyframeRemove('root/AP', 'idle', 0, 2);
    expect(script.includes('track_remove_key(0, 2)')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeUpdate ──────────────────────────────────────────────

describe('genAnimationKeyframeUpdate', () => {
  it('generates script with value update', () => {
    const script = genAnimationKeyframeUpdate('root/AP', 'idle', 0, 1, 200, undefined);
    expect(script.includes('track_set_key_value(0, 1, 200)')).toBeTruthy();
  });

  it('generates script with transition update', () => {
    const script = genAnimationKeyframeUpdate('root/AP', 'idle', 0, 1, undefined, 0.5);
    expect(script.includes('track_set_key_transition(0, 1, 0.5)')).toBeTruthy();
  });
});

// ─── genAnimationCurve ───────────────────────────────────────────────────────

describe('genAnimationCurve', () => {
  it('generates script with in_handle', () => {
    const script = genAnimationCurve('root/AP', 'idle', 0, 0, { x: 0.1, y: 0.2 }, undefined);
    expect(script.includes('track_set_key_in_handle(0, 0, Vector2(0.1, 0.2))')).toBeTruthy();
  });

  it('generates script with out_handle', () => {
    const script = genAnimationCurve('root/AP', 'idle', 0, 0, undefined, { x: 0.3, y: 0.4 });
    expect(script.includes('track_set_key_out_handle(0, 0, Vector2(0.3, 0.4))')).toBeTruthy();
  });

  it('generates script with both handles', () => {
    const script = genAnimationCurve('root/AP', 'idle', 0, 0, { x: 1, y: 2 }, { x: 3, y: 4 });
    expect(script.includes('track_set_key_in_handle')).toBeTruthy();
    expect(script.includes('track_set_key_out_handle')).toBeTruthy();
  });
});
