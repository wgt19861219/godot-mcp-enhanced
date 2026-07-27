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
} from '../src/tools/animation/animation-track.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── TOOL_NAMES ──────────────────────────────────────────────────────────────

describe('animation-track TOOL_NAMES', () => {
  // v0.25.0：animation_track 工具已合并进 animation，TOOL_NAMES 为空数组
  it('is empty after merge into animation (v0.25.0)', () => {
    expect(TOOL_NAMES.length).toBe(0);
  });
});

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('animation-track getToolDefinitions', () => {
  // v0.25.0：合并后不再暴露工具，返回空数组
  it('returns empty array after merge (v0.25.0)', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBe(0);
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('animation-track TOOL_META', () => {
  // v0.25.0：合并后 TOOL_META 为空对象（risk 标注已迁入 animation-ops.ts）
  it('is empty object after merge (v0.25.0)', () => {
    expect(Object.keys(TOOL_META).length).toBe(0);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('animation-track handleTool', () => {
  // v0.25.0：合并后 handleTool 是 deprecated 空壳，永远返回 null
  it('returns null for any input (deprecated shim, v0.25.0)', async () => {
    expect(await handleTool('unknown_tool', {}, fakeCtx)).toBe(null);
    expect(await handleTool('animation_track', { action: 'add_track' }, fakeCtx)).toBe(null);
    expect(await handleTool('run_project', {}, fakeCtx)).toBe(null);
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
    // transition=undefined → 默认 1.0（animation-track.ts:127 `transition ?? 1.0`），JS Number 字符串化为 "1"
    // 定位 track_insert_key 第 4 参 transition 的实际默认值，而非恒真的 includes('1')
    expect(script.includes('track_insert_key(0, 1, Vector3(1, 2, 3), 1)')).toBeTruthy();
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
