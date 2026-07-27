import { expect } from 'vitest';
import fc from 'fast-check';
import {
  requiresConfirmation, createPendingToken, consumeToken, pendingCount, resetState,
  TOKEN_TTL_MS,
} from '../src/guard.js';
import { registerAllModules } from '../src/core/module-loader.js';

// 注册所有模块的 actionRisks，供 requiresConfirmation 派生判定
registerAllModules();

// ─── requiresConfirmation (merged-tool guard) ────────────────────────────

describe('requiresConfirmation', () => {
  it('returns true for scene.remove_node', () => {
    expect(requiresConfirmation('scene', { action: 'remove_node' })).toBe(true);
  });
  it('returns true for scene.save_scene', () => {
    expect(requiresConfirmation('scene', { action: 'save_scene' })).toBe(true);
  });
  it('returns true for scene.detach_instance', () => {
    expect(requiresConfirmation('scene', { action: 'detach_instance' })).toBe(true);
  });
  it('returns false for script without action (read_script is exempt)', () => {
    expect(requiresConfirmation('script')).toBe(false);
  });
  it('returns true for script write actions', () => {
    expect(requiresConfirmation('script', { action: 'execute_gdscript' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'write_script' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'edit_script' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'project_replace' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'generate_test' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'create_test_scene' })).toBe(true);
  });
  it('returns false for script read_script', () => {
    expect(requiresConfirmation('script', { action: 'read_script' })).toBe(false);
  });
  it('CRITICAL RCE-chain fix: search_and_replace mode requires confirmation (was falsely exempt)', () => {
    // 2026-07-12: dynamicRiskOverride 已删除。search_and_replace 能写盘任意内容
    // （含 class_name 注入）+ 触发 ensureClassNameImport 注册全局类，不再是"非破坏性"。
    // 降级为 read 的注释假设已被 RCE 复合链证伪。
    expect(requiresConfirmation('script', { action: 'edit_script', search_and_replace: { search: 'old', replace: 'new' } })).toBe(true);
  });
  it('still requires confirmation for edit_script with line range mode', () => {
    expect(requiresConfirmation('script', { action: 'edit_script', start_line: 10, end_line: 15 })).toBe(true);
  });
  it('still requires confirmation for edit_script with empty search_and_replace', () => {
    expect(requiresConfirmation('script', { action: 'edit_script', search_and_replace: {} })).toBe(true);
  });
  it('CRITICAL-1: scene write actions guarded, read not', () => {
    expect(requiresConfirmation('scene', { action: 'add_node' })).toBe(true);
    expect(requiresConfirmation('scene', { action: 'edit_node' })).toBe(true);
    expect(requiresConfirmation('scene', { action: 'create_3d_node' })).toBe(true);
    expect(requiresConfirmation('scene', { action: 'commit' })).toBe(true);
    expect(requiresConfirmation('scene', { action: 'read_scene' })).toBe(false);
  });
  it('returns true for animation.delete', () => {
    expect(requiresConfirmation('animation', { action: 'delete' })).toBe(true);
  });
  it('returns false for animation.get_info', () => {
    expect(requiresConfirmation('animation', { action: 'get_info' })).toBe(false);
    expect(requiresConfirmation('animation', { action: 'play' })).toBe(false);
  });
  it('returns true for tilemap.tilemap_clear', () => {
    expect(requiresConfirmation('tilemap', { action: 'tilemap_clear' })).toBe(true);
  });
  it('CRITICAL-1: tilemap write actions guarded, read/copy not', () => {
    expect(requiresConfirmation('tilemap', { action: 'tilemap_read' })).toBe(false);
    expect(requiresConfirmation('tilemap', { action: 'tilemap_copy' })).toBe(false);
    expect(requiresConfirmation('tilemap', { action: 'tilemap_set_cell' })).toBe(true);
    expect(requiresConfirmation('tilemap', { action: 'tilemap_fill_rect' })).toBe(true);
  });
  it('returns true for game.game_bridge_install', () => {
    expect(requiresConfirmation('game', { action: 'game_bridge_install' })).toBe(true);
    expect(requiresConfirmation('game', { action: 'game_bridge_uninstall' })).toBe(true);
  });
  it('returns false for game.game_query', () => {
    expect(requiresConfirmation('game', { action: 'game_query' })).toBe(false);
    expect(requiresConfirmation('game', { action: 'game_input' })).toBe(false);
  });
  it('returns true for runtime.run_project', () => {
    expect(requiresConfirmation('runtime', { action: 'run_project' })).toBe(true);
  });
  it('returns true for runtime.launch_editor', () => {
    expect(requiresConfirmation('runtime', { action: 'launch_editor' })).toBe(true);
  });
  it('returns true for runtime.stop_project', () => {
    expect(requiresConfirmation('runtime', { action: 'stop_project' })).toBe(true);
  });
  it('CRITICAL-1: runtime execute guarded, read not', () => {
    expect(requiresConfirmation('runtime', { action: 'get_godot_version' })).toBe(false);
    expect(requiresConfirmation('runtime', { action: 'get_debug_output' })).toBe(false);
    expect(requiresConfirmation('runtime', { action: 'run_tests' })).toBe(true);
    expect(requiresConfirmation('runtime', { action: 'record_play' })).toBe(true);
  });
  it('CRITICAL-1: guards high-risk write/execute across tools (game_write/material/particles/nav/signal/ui/physics)', () => {
    expect(requiresConfirmation('game', { action: 'game_write', method: 'call_method' })).toBe(true);
    expect(requiresConfirmation('material', { action: 'set_params' })).toBe(true);
    expect(requiresConfirmation('material', { action: 'shader_write' })).toBe(true);
    expect(requiresConfirmation('particles', { action: 'particles_create' })).toBe(true);
    expect(requiresConfirmation('nav', { action: 'create_region' })).toBe(true);
    expect(requiresConfirmation('signal', { action: 'signal_emit' })).toBe(true);
    expect(requiresConfirmation('ui', { action: 'ui_create_control' })).toBe(true);
    expect(requiresConfirmation('physics', { action: 'collision_overlay' })).toBe(true);
  });

  it('CRITICAL-1: does not guard read/boundary actions (game_input/signal_connect/audio_play)', () => {
    expect(requiresConfirmation('game', { action: 'game_query' })).toBe(false);
    expect(requiresConfirmation('game', { action: 'game_input' })).toBe(false);
    expect(requiresConfirmation('signal', { action: 'signal_list' })).toBe(false);
    expect(requiresConfirmation('signal', { action: 'signal_connect' })).toBe(false);
    expect(requiresConfirmation('audio', { action: 'audio_play' })).toBe(false);
    expect(requiresConfirmation('audio', { action: 'audio_query' })).toBe(false);
    expect(requiresConfirmation('physics', { action: 'raycast' })).toBe(false);
    expect(requiresConfirmation('material', { action: 'read' })).toBe(false);
    expect(requiresConfirmation('nav', { action: 'query_path' })).toBe(false);
  });

  it('returns false for non-guarded tools', () => {
    expect(requiresConfirmation('validation')).toBe(false);
    expect(requiresConfirmation('workflow')).toBe(false);
    expect(requiresConfirmation('screenshot')).toBe(false);
  });

  // 非 GUARDED 工具零行为改变（Task 7 修复）：这些工具原不在 GUARDED 表中 →
  // requiresConfirmation 此前对所有 action 返回 false → 迁移后必须保持 false。
  // 锁定 spec §4.1：当前在 GUARDED 外的 action 一律标 read。
  // v0.25.0: animation_track 已合并进 animation。set_curve 标 read 不确认。
  // 注：add_track/add_keyframe 在 animation 工具中标 'write'（保留 animation 原标注，比 animation_track 的 read 更严），
  // 会触发确认，不在此「保持 false」列表。
  it.each([
    ['animation', 'set_curve'],
    ['editor', 'sync_start'],
    ['editor', 'sync_stop'],
    ['animtree', 'animtree_create'],
    ['animtree', 'animtree_add_state'],
    ['animtree', 'animtree_add_transition'],
    ['animtree', 'animtree_set_blend'],
    ['animtree', 'animtree_play'],
    ['animtree', 'animtree_state_edit'],
    ['profiler', 'start'],
    ['profiler', 'stop'],
    ['screenshot', 'capture'],
    ['screenshot', 'analyze'],
    ['docs', 'get_class_info'],
    ['docs', 'search_classes'],
  ])('非 GUARDED 工具 %s.%s 保持不确认 (false)', (tool, action) => {
    expect(requiresConfirmation(tool, { action })).toBe(false);
  });

  // v0.25.0: animation_track 已合并进 animation。破坏性操作（删轨道/关键帧/改值）现属 animation 工具，
  // 标 destructive 触发确认（animation-ops.ts TOOL_META.actionRisks）。
  // 注意 update_keyframe 从原 animation 的 'write' 修正为 'destructive'（修复风险等级不一致 bug）。
  it('v0.25.0: animation 破坏性 action（原 animation_track）需确认', () => {
    expect(requiresConfirmation('animation', { action: 'remove_track' })).toBe(true);
    expect(requiresConfirmation('animation', { action: 'remove_keyframe' })).toBe(true);
    expect(requiresConfirmation('animation', { action: 'update_keyframe' })).toBe(true);
  });

  // H-1: project 现为 GUARDED 工具——有真实副作用的 action 标 'write' 触发确认；
  // 纯查询 action 保持 'read' 不确认。（反向证明 H-1 修复生效）
  it('H-1: project 副作用 action 需确认，查询 action 不确认', () => {
    expect(requiresConfirmation('project', { action: 'create_project' })).toBe(true);
    expect(requiresConfirmation('project', { action: 'setup_project_rules' })).toBe(true);
    expect(requiresConfirmation('project', { action: 'write_config' })).toBe(true);
    expect(requiresConfirmation('project', { action: 'apply_template' })).toBe(true);
    expect(requiresConfirmation('project', { action: 'list_projects' })).toBe(false);
    expect(requiresConfirmation('project', { action: 'get_project_info' })).toBe(false);
    expect(requiresConfirmation('project', { action: 'list_files' })).toBe(false);
    expect(requiresConfirmation('project', { action: 'read_project_config' })).toBe(false);
    expect(requiresConfirmation('project', { action: 'list_templates' })).toBe(false);
  });
});

// ─── createPendingToken + consumeToken ──────────────────────────────────

describe('createPendingToken + consumeToken', () => {
  beforeEach(() => { resetState(); });

  it('creates and consumes a valid token', () => {
    const token = createPendingToken('scene', { action: 'remove_node', node_path: '/root/Player' });
    expect(typeof token === 'string' && token.length > 10).toBeTruthy();
    expect(pendingCount()).toBe(1);

    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.toolName).toBe('scene');
    expect(result.args).toEqual({ action: 'remove_node', node_path: '/root/Player' });
    expect(pendingCount()).toBe(0);
  });

  it('token is single-use', () => {
    const token = createPendingToken('script', { action: 'write_script', path: 'test.gd' });
    const first = consumeToken(token);
    expect(first).toBeTruthy();
    const second = consumeToken(token);
    expect(second).toBe(null);
  });

  it('unknown token returns null', () => {
    const result = consumeToken('nonexistent_token_12345');
    expect(result).toBe(null);
  });

  // S2: 截断(>10KB)的 execute_gdscript code 必须被标记,confirm 消费时据此拒绝执行
  it('marks wasTruncated when an arg exceeds 10KB (S2)', () => {
    const hugeCode = 'a'.repeat(11_000);
    const token = createPendingToken('script', { action: 'execute_gdscript', code: hugeCode });
    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.wasTruncated).toBe(true);
    // 截断后的 code 含 [truncated N chars] 标记,不再是原始完整内容
    expect(typeof result.args.code).toBe('string');
    expect(result.args.code.length).toBeLessThan(hugeCode.length);
    expect(result.args.code).toMatch(/\[truncated \d+ chars\]/);
  });

  it('does NOT mark wasTruncated for small args (S2)', () => {
    const token = createPendingToken('script', { action: 'execute_gdscript', code: 'print("hi")' });
    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.wasTruncated).toBeUndefined();
    expect(result.args.code).toBe('print("hi")');
  });
});

// ─── Property-based tests ───────────────────────────────────────────────

describe('Property: guard', () => {
  it('requiresConfirmation is deterministic for any string', () => {
    fc.assert(
      fc.property(fc.string(), (toolName) => {
        const result = requiresConfirmation(toolName);
        expect(requiresConfirmation(toolName)).toBe(result);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('consumeToken with random string always returns null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (token) => {
        expect(consumeToken(token)).toBe(null);
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('createPendingToken + consumeToken roundtrip preserves toolName', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.anything()),
        (toolName, args) => {
          resetState();
          const token = createPendingToken(toolName, args);
          const consumed = consumeToken(token);
          expect(consumed).not.toBeNull();
          expect(consumed.toolName).toBe(toolName);
        }
      ),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });
});

// ─── TOKEN_TTL_MS (CRITICAL-3 子项1) ───────────────────────────────────────

describe('TOKEN_TTL_MS', () => {
  it('CRITICAL-3: TTL tightened to 60s (from 180s)', () => {
    expect(TOKEN_TTL_MS).toBe(60_000);
  });
});

// ─── workflow/validation/manage_tools 守卫 (CRITICAL-3 子项4) ───────────

describe('workflow/validation/manage_tools 守卫', () => {
  it('workflow: dev_loop/create_files/run_verify guarded; read not', () => {
    expect(requiresConfirmation('workflow', { action: 'dev_loop' })).toBe(true);
    expect(requiresConfirmation('workflow', { action: 'create_files' })).toBe(true);
    expect(requiresConfirmation('workflow', { action: 'run_verify' })).toBe(true);
    expect(requiresConfirmation('workflow', { action: 'scene_snapshot' })).toBe(false);
    expect(requiresConfirmation('workflow', { action: 'batch_validate' })).toBe(false);
    expect(requiresConfirmation('workflow', { action: 'diff_scenes' })).toBe(false);
  });
  it('validation: assert/stress/export_build guarded; read not', () => {
    expect(requiresConfirmation('validation', { action: 'assert' })).toBe(true);
    expect(requiresConfirmation('validation', { action: 'stress' })).toBe(true);
    expect(requiresConfirmation('validation', { action: 'export_build' })).toBe(true);
    expect(requiresConfirmation('validation', { action: 'validate_scripts' })).toBe(false);
    expect(requiresConfirmation('validation', { action: 'analyze_error' })).toBe(false);
    expect(requiresConfirmation('validation', { action: 'import_resources' })).toBe(false);
  });
  it('manage_tools: activate/deactivate guarded; read/migrate not', () => {
    expect(requiresConfirmation('manage_tools', { action: 'activate' })).toBe(true);
    expect(requiresConfirmation('manage_tools', { action: 'deactivate' })).toBe(true);
    expect(requiresConfirmation('manage_tools', { action: 'list_groups' })).toBe(false);
    expect(requiresConfirmation('manage_tools', { action: 'sync' })).toBe(false);
    expect(requiresConfirmation('manage_tools', { action: 'reconnect' })).toBe(false);
    expect(requiresConfirmation('manage_tools', { action: 'migrate' })).toBe(false);  // 只读(返回迁移映射)
  });
});

// ─── requiresConfirmation 零行为改变契约（Task 6）──────────────────────
// 此测试锁定：requiresConfirmation 从 GUARDED 切换到 actionRisks 判定后，行为零改变。
// 切换前（GUARDED 驱动）应 PASS，切换后（actionRisks 驱动）仍应 PASS。
describe('requiresConfirmation 零行为改变', () => {
  // 抽样覆盖 4 级（read/write/destructive/process）+ 动态豁免 + 边界 read
  it.each([
    ['scene', 'remove_node', true],        // destructive
    ['scene', 'read_scene', false],        // read
    ['scene', 'add_node', true],           // write
    ['script', 'execute_gdscript', true],  // process
    ['script', 'read_script', false],
    ['game', 'game_write', true],          // process（任意方法 RPC）
    ['game', 'game_query', false],
    ['validation', 'run_and_verify', false], // trusted-nonread
    ['validation', 'export_build', true],    // process
    ['runtime', 'run_project', true],
    ['runtime', 'get_godot_version', false],
    ['particles', 'particles_create', true],
    ['signal', 'signal_emit', true],
    ['signal', 'signal_connect', false],
    ['unknown_tool', 'x', false],          // 未注册工具
  ])('%s.%s 确认=%s', (tool, action, expected) => {
    expect(requiresConfirmation(tool, { action })).toBe(expected);
  });

  it('script.edit_script + search_and_replace 需确认 → true（RCE 链修复）', () => {
    expect(requiresConfirmation('script', { action: 'edit_script', search_and_replace: { search: 'a', replace: 'b' } })).toBe(true);
  });
  it('script.edit_script 无 search_and_replace → true', () => {
    expect(requiresConfirmation('script', { action: 'edit_script' })).toBe(true);
  });
  it('无 action 参数 → false', () => {
    expect(requiresConfirmation('scene', {})).toBe(false);
  });
});
