import { expect } from 'vitest';
import {
  TOOL_NAMES as ANIM_TOOL_NAMES,
  getToolDefinitions as getAnimDefs,
  genAnimationBlend,
} from '../src/tools/animation-ops.js';
import {
  TOOL_NAMES as TRACK_TOOL_NAMES,
  getToolDefinitions as getTrackDefs,
  genAnimationTrackAdd,
  genAnimationTrackRemove,
  genAnimationKeyframeAdd,
  genAnimationKeyframeRemove,
  genAnimationKeyframeUpdate,
  genAnimationCurve,
} from '../src/tools/animation-track.js';
import {
  TOOL_NAMES as ANIMTREE_TOOL_NAMES,
  getToolDefinitions as getAnimtreeDefs,
  genStateSetPosition,
  genStateSetBlend,
} from '../src/tools/animtree.js';

// ─── animation-ops TOOL_NAMES ────────────────────────────────────────────

describe('animation-ops TOOL_NAMES', () => {
  it('contains 2 tool names (animation + animation_blend)', () => {
    expect(ANIM_TOOL_NAMES.length).toBe(2);
  });
  it('includes animation', () => {
    expect(ANIM_TOOL_NAMES.includes('animation')).toBeTruthy();
  });
  it('includes animation_blend', () => {
    expect(ANIM_TOOL_NAMES.includes('animation_blend')).toBeTruthy();
  });
});

// ─── animation-track TOOL_NAMES ──────────────────────────────────────────

describe('animation-track TOOL_NAMES', () => {
  it('contains 3 tool names', () => {
    expect(TRACK_TOOL_NAMES.length).toBe(3);
  });
  it('includes animation_track', () => {
    expect(TRACK_TOOL_NAMES.includes('animation_track')).toBeTruthy();
  });
  it('includes animation_keyframe', () => {
    expect(TRACK_TOOL_NAMES.includes('animation_keyframe')).toBeTruthy();
  });
  it('includes animation_curve', () => {
    expect(TRACK_TOOL_NAMES.includes('animation_curve')).toBeTruthy();
  });
});

// ─── getToolDefinitions (animation-ops) ───────────────────────────────────

describe('animation-ops getToolDefinitions', () => {
  it('returns 2 tool definitions', () => {
    const defs = getAnimDefs();
    expect(defs.length).toBe(2);
  });
  it('each definition has inputSchema with required fields', () => {
    const defs = getAnimDefs();
    for (const def of defs) {
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.required).toBeTruthy();
    }
  });
});

// ─── getToolDefinitions (animation-track) ─────────────────────────────────

describe('animation-track getToolDefinitions', () => {
  it('returns 3 tool definitions', () => {
    const defs = getTrackDefs();
    expect(defs.length).toBe(3);
  });
  it('animation_track has action enum with add and remove', () => {
    const defs = getTrackDefs();
    const track = defs.find(d => d.name === 'animation_track');
    expect(track).toBeTruthy();
    const actionEnum = track.inputSchema.properties.action.enum;
    expect(actionEnum.includes('add')).toBeTruthy();
    expect(actionEnum.includes('remove')).toBeTruthy();
  });
  it('animation_keyframe has action enum with add, remove, update', () => {
    const defs = getTrackDefs();
    const kf = defs.find(d => d.name === 'animation_keyframe');
    expect(kf).toBeTruthy();
    const actionEnum = kf.inputSchema.properties.action.enum;
    expect(actionEnum.includes('add')).toBeTruthy();
    expect(actionEnum.includes('remove')).toBeTruthy();
    expect(actionEnum.includes('update')).toBeTruthy();
  });
});

// ─── genAnimationTrackAdd ────────────────────────────────────────────────

describe('genAnimationTrackAdd', () => {
  it('generates GDScript with add_track call (value type)', () => {
    const script = genAnimationTrackAdd('/root/Player/AnimPlayer', 'walk', 'value', 'Sprite2D:frame', undefined);
    expect(script.includes('_anim.add_track(0')).toBeTruthy();
    expect(script.includes('track_set_path')).toBeTruthy();
    expect(script.includes('Sprite2D:frame')).toBeTruthy();
  });
  it('generates GDScript with insert_at position', () => {
    const script = genAnimationTrackAdd('/root/A', 'idle', 'position_3d', 'Player', 2);
    expect(script.includes('_anim.add_track(1, 2)')).toBeTruthy();
  });
  it('generates GDScript without track_path when undefined', () => {
    const script = genAnimationTrackAdd('/root/A', 'idle', 'bezier', undefined, undefined);
    expect(script.includes('_anim.add_track(6)')).toBeTruthy();
    expect(script.includes('track_set_path')).toBeFalsy();
  });
});

// ─── genAnimationTrackRemove ─────────────────────────────────────────────

describe('genAnimationTrackRemove', () => {
  it('generates GDScript with remove_track call', () => {
    const script = genAnimationTrackRemove('/root/Player/AnimPlayer', 'walk', 0);
    expect(script.includes('_anim.remove_track(0)')).toBeTruthy();
    expect(script.includes('removed_track')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeAdd ─────────────────────────────────────────────

describe('genAnimationKeyframeAdd', () => {
  it('generates GDScript with track_insert_key for value type', () => {
    const script = genAnimationKeyframeAdd('/root/A', 'walk', 0, 0.5, 42, undefined);
    expect(script.includes('track_insert_key')).toBeTruthy();
    expect(script.includes('42')).toBeTruthy();
  });
  it('includes transition value when provided', () => {
    const script = genAnimationKeyframeAdd('/root/A', 'walk', 0, 0.0, 0, 0.5);
    expect(script.includes('0.5')).toBeTruthy();
  });
  it('handles Vector3 values for position_3d tracks', () => {
    const script = genAnimationKeyframeAdd('/root/A', 'walk', 0, 0.0, [1, 2, 3], undefined);
    expect(script.includes('Vector3(1, 2, 3)')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeRemove ──────────────────────────────────────────

describe('genAnimationKeyframeRemove', () => {
  it('generates GDScript with track_remove_key', () => {
    const script = genAnimationKeyframeRemove('/root/A', 'walk', 0, 1);
    expect(script.includes('track_remove_key(0, 1)')).toBeTruthy();
    expect(script.includes('removed_keyframe')).toBeTruthy();
  });
});

// ─── genAnimationKeyframeUpdate ──────────────────────────────────────────

describe('genAnimationKeyframeUpdate', () => {
  it('generates GDScript with track_set_key_value', () => {
    const script = genAnimationKeyframeUpdate('/root/A', 'walk', 0, 0, 100, undefined);
    expect(script.includes('track_set_key_value')).toBeTruthy();
    expect(script.includes('100')).toBeTruthy();
  });
  it('includes transition update when provided', () => {
    const script = genAnimationKeyframeUpdate('/root/A', 'walk', 0, 0, undefined, 0.8);
    expect(script.includes('track_set_key_transition(0, 0, 0.8)')).toBeTruthy();
  });
  it('includes both value and transition', () => {
    const script = genAnimationKeyframeUpdate('/root/A', 'walk', 0, 0, 50, 0.3);
    expect(script.includes('track_set_key_value')).toBeTruthy();
    expect(script.includes('track_set_key_transition')).toBeTruthy();
  });
});

// ─── genAnimationCurve ───────────────────────────────────────────────────

describe('genAnimationCurve', () => {
  it('generates GDScript with in_handle and out_handle', () => {
    const script = genAnimationCurve('/root/A', 'walk', 0, 0, { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 });
    expect(script.includes('track_set_key_in_handle')).toBeTruthy();
    expect(script.includes('track_set_key_out_handle')).toBeTruthy();
    expect(script.includes('Vector2(0.1, 0.5)')).toBeTruthy();
    expect(script.includes('Vector2(0.9, 0.5)')).toBeTruthy();
  });
  it('generates GDScript with only in_handle', () => {
    const script = genAnimationCurve('/root/A', 'walk', 0, 0, { x: 0.2, y: 0.3 }, undefined);
    expect(script.includes('track_set_key_in_handle')).toBeTruthy();
    expect(script.includes('track_set_key_out_handle')).toBeFalsy();
  });
  it('generates GDScript with only out_handle', () => {
    const script = genAnimationCurve('/root/A', 'walk', 0, 0, undefined, { x: 0.8, y: 0.7 });
    expect(script.includes('track_set_key_in_handle')).toBeFalsy();
    expect(script.includes('track_set_key_out_handle')).toBeTruthy();
  });
});

// ─── genAnimationBlend ───────────────────────────────────────────────────

describe('genAnimationBlend', () => {
  it('generates GDScript with play call including blend time and speed', () => {
    const script = genAnimationBlend('/root/Player/AnimPlayer', 'run', 0.3, 1.5);
    expect(script.includes('_ap.play("run", 0.3, 1.5, false)')).toBeTruthy();
    expect(script.includes('blend_time')).toBeTruthy();
    expect(script.includes('speed')).toBeTruthy();
  });
  it('uses default speed 1.0', () => {
    const script = genAnimationBlend('/root/A', 'idle', 0.5, 1.0);
    expect(script.includes('1')).toBeTruthy();
  });
});

// ─── animtree TOOL_NAMES ─────────────────────────────────────────────────

describe('animtree TOOL_NAMES (with P2 addition)', () => {
  it('contains 6 tool names (5 original + animtree_state_edit)', () => {
    expect(ANIMTREE_TOOL_NAMES.length).toBe(6);
  });
  it('includes animtree_state_edit', () => {
    expect(ANIMTREE_TOOL_NAMES.includes('animtree_state_edit')).toBeTruthy();
  });
});

// ─── animtree getToolDefinitions ──────────────────────────────────────────

describe('animtree getToolDefinitions', () => {
  it('returns 6 tool definitions', () => {
    const defs = getAnimtreeDefs();
    expect(defs.length).toBe(6);
  });
  it('animtree_state_edit definition exists with correct actions', () => {
    const defs = getAnimtreeDefs();
    const edit = defs.find(d => d.name === 'animtree_state_edit');
    expect(edit).toBeTruthy();
    const actionEnum = edit.inputSchema.properties.action.enum;
    expect(actionEnum.includes('set_position')).toBeTruthy();
    expect(actionEnum.includes('set_blend')).toBeTruthy();
  });
});

// ─── genStateSetPosition ─────────────────────────────────────────────────

describe('genStateSetPosition', () => {
  it('generates GDScript with set_node_position', () => {
    const script = genStateSetPosition('/root/Tree', 'idle', 100, 200);
    expect(script.includes('set_node_position')).toBeTruthy();
    expect(script.includes('Vector2(100, 200)')).toBeTruthy();
    expect(script.includes('has_node("idle")')).toBeTruthy();
  });
});

// ─── genStateSetBlend ────────────────────────────────────────────────────

describe('genStateSetBlend', () => {
  it('generates GDScript with set for numeric value', () => {
    const script = genStateSetBlend('/root/Tree', 'blend/amount', '0.5');
    expect(script.includes('_tree.set("blend/amount", 0.5)')).toBeTruthy();
  });
  it('generates GDScript with set for Vector2 value', () => {
    const script = genStateSetBlend('/root/Tree', 'blend/pos', 'Vector2(1, 2)');
    expect(script.includes('Vector2(1, 2)')).toBeTruthy();
  });
});
