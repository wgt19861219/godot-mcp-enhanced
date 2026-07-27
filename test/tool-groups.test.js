import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  PROFILES,
  expandGroups,
  resolveProfile,
  LITE_TOOLS,
  MINIMAL_TOOLS,
} from '../src/core/tool-registry.js';

describe('tool-registry groups and profiles', () => {
  describe('TOOL_GROUPS', () => {
    it('should define 20 tool groups', () => {
      // v0.18.0: recording→runtime, ik→animation removed as independent groups
      // blender 加入 TOOL_GROUPS（Task 4 注册接线）
      // self-update Task 4: selfupdate 组加入 TOOL_GROUPS
      expect(Object.keys(TOOL_GROUPS)).toHaveLength(20);
    });

    it('should have each group contain valid tool names as non-empty string arrays', () => {
      for (const [name, group] of Object.entries(TOOL_GROUPS)) {
        expect(Array.isArray(group.tools), `Group ${name} should have tools array`).toBe(true);
        // v0.18.0: merged groups may have empty tools array (tools absorbed into other modules)
        for (const t of group.tools) {
          expect(typeof t, `Tool in ${name} should be string`).toBe('string');
        }
      }
    });

    it('should have core group with essential tools', () => {
      expect(TOOL_GROUPS.core.tools).toContain('project');
      expect(TOOL_GROUPS.core.tools).toContain('scene');
      expect(TOOL_GROUPS.core.tools).toContain('script');
      expect(TOOL_GROUPS.core.tools).toContain('runtime');
      expect(TOOL_GROUPS.core.tools).toContain('validation');
      expect(TOOL_GROUPS.core.tools).toContain('confirm_and_execute');
    });

    it('should have bridge group with game tool', () => {
      expect(TOOL_GROUPS.bridge.tools).toContain('game');
    });

    it('should have visual group with material+screenshot+particles', () => {
      expect(TOOL_GROUPS.visual.tools).toContain('material');
      expect(TOOL_GROUPS.visual.tools).toContain('screenshot');
      expect(TOOL_GROUPS.visual.tools).toContain('particles');
    });

    it('should have physics group with physics only (node_create_3d merged to scene, v0.18.0)', () => {
      expect(TOOL_GROUPS.physics.tools).toContain('physics');
      expect(TOOL_GROUPS.physics.tools).not.toContain('node_create_3d');
    });

    it('should have navigation group with nav (not navigation)', () => {
      expect(TOOL_GROUPS.navigation.tools).toContain('nav');
    });

    it('should have test group empty (test+verify_delivery merged to validation, v0.18.0)', () => {
      expect(TOOL_GROUPS.test.tools).toEqual([]);
    });

    it('should have code group with docs only (batch→workflow, game_design→validation, v0.18.0)', () => {
      expect(TOOL_GROUPS.code.tools).toContain('docs');
      expect(TOOL_GROUPS.code.tools).not.toContain('batch');
      expect(TOOL_GROUPS.code.tools).not.toContain('game_design');
    });

    // v0.25.0: animation_track 已合并进 animation 工具，group 现含 animation+animtree
    it('should have animation group with animation+animtree (v0.25.0 merged animation_track)', () => {
      expect(TOOL_GROUPS.animation.tools).toContain('animation');
      expect(TOOL_GROUPS.animation.tools).toContain('animtree');
      expect(TOOL_GROUPS.animation.tools).not.toContain('animation_track');
    });

    it('should not have overlapping tool names across groups', () => {
      const allTools = Object.values(TOOL_GROUPS).flatMap(g => g.tools);
      const uniqueTools = [...new Set(allTools)];
      expect(allTools.length, 'No duplicate tool names across groups').toBe(uniqueTools.length);
    });
  });

  describe('PROFILES', () => {
    it('should define 6 profiles', () => {
      expect(Object.keys(PROFILES)).toHaveLength(6);
    });

    it('should have full profile include all 20 groups', () => {
      expect(PROFILES.full).toHaveLength(20);
    });

    it('should have minimal profile only include core', () => {
      expect(PROFILES.minimal).toEqual(['core']);
    });

    it('should have lite profile use group names not tool names', () => {
      const groupNames = Object.keys(TOOL_GROUPS);
      for (const g of PROFILES.lite) {
        expect(groupNames, `${g} should be a valid group name`).toContain(g);
      }
    });

    it('should have 3d_dev profile use only valid group names', () => {
      const groupNames = Object.keys(TOOL_GROUPS);
      for (const g of PROFILES['3d_dev']) {
        expect(groupNames, `${g} should be a valid group name`).toContain(g);
      }
    });
  });

  describe('expandGroups', () => {
    it('should expand group names to tool names', () => {
      const tools = expandGroups(['core', 'audio']);
      expect(tools.has('project')).toBe(true);
      expect(tools.has('audio')).toBe(true);
      expect(tools.has('animation')).toBe(false);
    });

    it('should return empty set for unknown groups', () => {
      const tools = expandGroups(['nonexistent_group']);
      expect(tools.size).toBe(0);
    });

    it('should skip unknown groups and expand valid ones', () => {
      const tools = expandGroups(['core', 'nonexistent', 'audio']);
      expect(tools.has('project')).toBe(true);
      expect(tools.has('audio')).toBe(true);
    });
  });

  describe('resolveProfile', () => {
    it('should resolve minimal profile to core tools only', () => {
      const tools = resolveProfile('minimal');
      expect(tools.has('project')).toBe(true);
      expect(tools.has('scene')).toBe(true);
      expect(tools.has('animation')).toBe(false);
      expect(tools.has('game')).toBe(false);
    });

    it('should resolve full profile to all tools', () => {
      const tools = resolveProfile('full');
      const allGroupTools = Object.values(TOOL_GROUPS).flatMap(g => g.tools);
      expect(tools.size).toBe(allGroupTools.length);
    });

    it('should resolve bridge_dev profile', () => {
      const tools = resolveProfile('bridge_dev');
      expect(tools.has('project')).toBe(true);     // core
      expect(tools.has('game')).toBe(true);         // bridge
      expect(tools.has('profiler')).toBe(true);     // profiler
      expect(tools.has('animation')).toBe(false);   // not included
    });

    it('should resolve 3d_dev profile', () => {
      const tools = resolveProfile('3d_dev');
      expect(tools.has('project')).toBe(true);      // core
      expect(tools.has('animation')).toBe(true);    // animation
      expect(tools.has('material')).toBe(true);     // visual
      expect(tools.has('game')).toBe(false);        // bridge not included
    });

    it('should support comma-separated group override', () => {
      const tools = resolveProfile('core,bridge');
      expect(tools.has('project')).toBe(true);
      expect(tools.has('game')).toBe(true);
      expect(tools.has('audio')).toBe(false);
    });

    it('should return empty set for unknown profile that has no valid groups', () => {
      const tools = resolveProfile('totally_invalid_profile');
      expect(tools.size).toBe(0);
    });
  });

  describe('backward compatibility', () => {
    it('LITE_TOOLS should match resolveProfile(lite)', () => {
      const expected = resolveProfile('lite');
      expect(LITE_TOOLS).toEqual(expected);
    });

    it('MINIMAL_TOOLS should match resolveProfile(minimal)', () => {
      const expected = resolveProfile('minimal');
      expect(MINIMAL_TOOLS).toEqual(expected);
    });

    it('LITE_TOOLS should contain expected tools from old manual set + new group expansions', () => {
      expect(LITE_TOOLS.has('project')).toBe(true);
      expect(LITE_TOOLS.has('scene')).toBe(true);
      expect(LITE_TOOLS.has('script')).toBe(true);
      expect(LITE_TOOLS.has('game')).toBe(true);
      expect(LITE_TOOLS.has('animation')).toBe(true);
      expect(LITE_TOOLS.has('animtree')).toBe(true);
      expect(LITE_TOOLS.has('audio')).toBe(true);
      expect(LITE_TOOLS.has('signal')).toBe(true);
      // visual group
      expect(LITE_TOOLS.has('material')).toBe(true);
      expect(LITE_TOOLS.has('screenshot')).toBe(true);
      expect(LITE_TOOLS.has('particles')).toBe(true);
      // code group (docs only, batch→workflow, game_design→validation v0.18.0)
      expect(LITE_TOOLS.has('docs')).toBe(true);
      // test group absorbed into validation (v0.18.0)
      expect(LITE_TOOLS.has('validation')).toBe(true);
    });

    it('MINIMAL_TOOLS should contain only core 7 tools', () => {
      expect(MINIMAL_TOOLS.has('project')).toBe(true);
      expect(MINIMAL_TOOLS.has('scene')).toBe(true);
      expect(MINIMAL_TOOLS.has('script')).toBe(true);
      expect(MINIMAL_TOOLS.has('runtime')).toBe(true);
      expect(MINIMAL_TOOLS.has('validation')).toBe(true);
      expect(MINIMAL_TOOLS.has('confirm_and_execute')).toBe(true);
      expect(MINIMAL_TOOLS.has('godot_get_context')).toBe(true);
      expect(MINIMAL_TOOLS.size).toBe(7);
    });
  });
});
