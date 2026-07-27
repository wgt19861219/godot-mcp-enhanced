import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tryLegacyMapping, LEGACY_TOOL_MAP } from '../../src/core/tool-registry.js';

describe('LEGACY_TOOL_MAP', () => {
  it('包含所有 9 个被吸收工具的映射', () => {
    const expected = [
      'node_create_3d', 'scene_commit', 'recording',
      'verify_delivery', 'test', 'ik',
      'templates', 'batch', 'game_design',
    ];
    for (const name of expected) {
      expect(LEGACY_TOOL_MAP[name]).toBeDefined();
      expect(LEGACY_TOOL_MAP[name]).toHaveProperty('tool');
      expect(LEGACY_TOOL_MAP[name]).toHaveProperty('action');
    }
  });

  it('映射的目标工具名是有效工具', () => {
    const validTargets = new Set([
      'project', 'scene', 'script', 'runtime', 'validation', 'editor', 'game',
      'animation', 'animtree', 'audio', 'material', 'screenshot',
      'particles', 'physics', 'nav', 'ui', 'tilemap', 'signal', 'profiler',
      'workflow', 'docs', 'manage_tools',
    ]);
    for (const [, mapping] of Object.entries(LEGACY_TOOL_MAP)) {
      expect(validTargets.has(mapping.tool)).toBe(true);
    }
  });
});

describe('tryLegacyMapping', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_WARN_LEGACY;
  });

  it('GODOT_MCP_WARN_LEGACY 未设置时返回 null', () => {
    delete process.env.GODOT_MCP_WARN_LEGACY;
    expect(tryLegacyMapping('node_create_3d')).toBeNull();
  });

  it('GODOT_MCP_WARN_LEGACY=1 时返回映射', () => {
    process.env.GODOT_MCP_WARN_LEGACY = '1';
    const result = tryLegacyMapping('node_create_3d');
    expect(result).toEqual({ tool: 'scene', action: 'create_3d_node' });
  });

  it('未知工具名返回 null', () => {
    process.env.GODOT_MCP_WARN_LEGACY = '1';
    expect(tryLegacyMapping('totally_unknown_tool')).toBeNull();
  });
});
