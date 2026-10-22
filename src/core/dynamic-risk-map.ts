// src/core/dynamic-risk-map.ts — CMP-16-B 动态工具 method → 静态 (tool, action) 反查表
//
// A1 (2026-08-11 审查 P1:CMP-16-B 动态工具绕过 confirm gate):动态注册的平铺工具
// (live schema 从 editor addon 拉取,如 `engine_call_method`)名字不在静态 metaRegistry →
// getActionRisk 返 undefined → requiresConfirmation 放行;isActionGated 也永不命中。
// 等价静态调用(engine + action=call_method,risk=write 要确认令牌)经动态通道绕过双层门。
//
// 修复:ToolDispatcher.executeToolCall 对动态工具名经本表反查回静态 (tool, action),
// confirm/action-gate 两道门用解析后的名字判定;执行仍用原平铺名(editor 转发需要)。
//
// ⚠️ 双副本同步约束:本表与 scripts/check-command-docs-drift.mjs 的 METHOD_TO_TOOL 是
// 两份独立副本(mjs 无法 import TS)。contract 测试 test/dynamic-risk-map.test.ts 逐条
// 比对两份表,drift 即红。GD command_handler 新增 method 时两处同步登记。

/** 动态 method → 静态工具映射。actions 仅在 method 含内部 action 参数（GD 短名）时登记。 */
export interface DynamicToolMapping {
  readonly tool: string;
  /** 默认静态 action（无 actions 表，或 actualAction 未传时使用） */
  readonly action: string;
  /** GD 内部短 action → 静态全名 action。有此表的 method：actualAction 不在表中 = fail-closed。 */
  readonly actions?: Readonly<Record<string, string>>;
}

/** GD command_handler 扁平 method 名 → 静态 (tool, action)。与 check-command-docs-drift.mjs METHOD_TO_TOOL 同步维护。 */
export const METHOD_TO_TOOL: Readonly<Record<string, DynamicToolMapping>> = {
  // ─── debug (CMP-3 + CMP-14):tool=debug, 10 action ───────────────────────
  debug_set_breakpoint: { tool: 'debug', action: 'set_breakpoint' },
  debug_clear_breakpoint: { tool: 'debug', action: 'clear_breakpoint' },
  debug_list_breakpoints: { tool: 'debug', action: 'list_breakpoints' },
  debug_stack_trace: { tool: 'debug', action: 'stack_trace' },
  debug_inspect_frame: { tool: 'debug', action: 'inspect_frame' },
  debug_evaluate: { tool: 'debug', action: 'evaluate' },
  debug_step: { tool: 'debug', action: 'step' },
  debug_continue: { tool: 'debug', action: 'continue' },
  debug_pause: { tool: 'debug', action: 'pause' },
  debug_reload_scripts: { tool: 'debug', action: 'reload_scripts' },
  // ─── engine (CMP-4 + CMP-9-A):tool=engine, 4 action ─────────────────────
  engine_class_info: { tool: 'engine', action: 'class_info' },
  engine_search: { tool: 'engine', action: 'search' },
  engine_get_inheritance: { tool: 'engine', action: 'get_inheritance' },
  engine_call_method: { tool: 'engine', action: 'call_method' },
  // ─── scene_commands + node_commands:tool=scene(node 归 scene 非 node)──
  open_scene: { tool: 'scene', action: 'open_scene' },
  save_scene: { tool: 'scene', action: 'save_scene' },
  instance_scene: { tool: 'scene', action: 'instance_scene' },
  set_instance_property: { tool: 'scene', action: 'set_instance_property' },
  add_node: { tool: 'scene', action: 'add_node' },
  remove_node: { tool: 'scene', action: 'remove_node' },
  edit_node: { tool: 'scene', action: 'edit_node' },
  batch_add_nodes: { tool: 'scene', action: 'batch_add_nodes' },
  // ─── sync_commands:tool=editor(editor-sync.ts) ──────────────────────────
  // editor_get_scene_stats 无对应 TS action(走 GodotServer 直调),不登记
  editor_sync_start: { tool: 'editor', action: 'sync_start' },
  editor_sync_stop: { tool: 'editor', action: 'sync_stop' },
  editor_get_scene_tree: { tool: 'editor', action: 'get_scene_tree' },
  // ─── animation_commands:split(3 个→animation_track,1 个→animation) ────
  // C-1(2026-10-22 审查):animation_track/animation_keyframe 的 GD method 含内部短 action
  // 参数(add/remove/update),风险必须按真实 action 解析;actions 表缺该 action → fail-closed。
  animation_track:    { tool: 'animation_track', action: 'add_track', actions: { add: 'add_track', remove: 'remove_track' } },
  animation_keyframe: { tool: 'animation_track', action: 'add_keyframe', actions: { add: 'add_keyframe', remove: 'remove_keyframe', update: 'update_keyframe' } },
  animation_curve:    { tool: 'animation_track', action: 'set_curve' },
  animation_blend: { tool: 'animation', action: 'blend' },
  // ─── animtree_commands:tool=animtree, action 扁平 ───────────────────────
  animtree_create: { tool: 'animtree', action: 'animtree_create' },
  animtree_add_state: { tool: 'animtree', action: 'animtree_add_state' },
  animtree_add_transition: { tool: 'animtree', action: 'animtree_add_transition' },
  animtree_set_blend: { tool: 'animtree', action: 'animtree_set_blend' },
  animtree_play: { tool: 'animtree', action: 'animtree_play' },
  // ─── particle_commands:tool=particles, action 扁平 ──────────────────────
  particles_create: { tool: 'particles', action: 'particles_create' },
  particles_set_emission: { tool: 'particles', action: 'particles_set_emission' },
  particles_set_process: { tool: 'particles', action: 'particles_set_process' },
  particles_load_preset: { tool: 'particles', action: 'particles_load_preset' },
  particles_set_material: { tool: 'particles', action: 'particles_set_material' },
  // ─── nav_commands:tool=nav, action 去 nav_ 前缀 ─────────────────────────
  nav_create_region: { tool: 'nav', action: 'create_region' },
  nav_bake_mesh: { tool: 'nav', action: 'bake_mesh' },
  nav_create_agent: { tool: 'nav', action: 'create_agent' },
  nav_set_params: { tool: 'nav', action: 'set_params' },
  nav_create_link: { tool: 'nav', action: 'create_link' },
  // ─── test_commands:split(assert→validation, run/manage→testing) ────────
  test_assert: { tool: 'validation', action: 'assert' },
  test_run: { tool: 'testing', action: 'run' },
  test_manage: { tool: 'testing', action: 'manage' },
  // ─── export_commands:tool=validation, action 扁平 ───────────────────────
  export_list_presets: { tool: 'validation', action: 'export_list_presets' },
  export_get_preset: { tool: 'validation', action: 'export_get_preset' },
  export_build: { tool: 'validation', action: 'export_build' },
  // ─── ui_commands:tool=ui, action 扁平 ───────────────────────────────────
  ui_create_control: { tool: 'ui', action: 'ui_create_control' },
  ui_set_layout: { tool: 'ui', action: 'ui_set_layout' },
  ui_get_layout: { tool: 'ui', action: 'ui_get_layout' },
  ui_anchor_preset: { tool: 'ui', action: 'ui_anchor_preset' },
  ui_set_theme: { tool: 'ui', action: 'ui_set_theme' },
  ui_container_add: { tool: 'ui', action: 'ui_container_add' },
  theme_create: { tool: 'ui', action: 'theme_create' },
  theme_set_property: { tool: 'ui', action: 'theme_set_property' },
  // ─── asset_commands:tool=asset, action 去 asset_ 前缀 ───────────────────
  asset_create: { tool: 'asset', action: 'create' },
  asset_path: { tool: 'asset', action: 'path' },
  asset_batch: { tool: 'asset', action: 'batch' },
  asset_undo: { tool: 'asset', action: 'undo' },
  asset_save: { tool: 'asset', action: 'save' },
};

/**
 * 动态工具名(= GD 扁平 method 名,methodToToolName 对本表 method 是恒等变换)→ 静态 (tool, action)。
 * 未映射返 undefined —— 调用方(ToolDispatcher)对未映射动态工具按 fail-closed 处理(风险未知 → 需确认)。
 * C-1(2026-10-22 审查): 含 actions 表的 method 按 actualAction(GD 内部短名)解析真实静态
 * action;actualAction 不在表中同样返 undefined(fail-closed,防新增 action 漏登记静默绕门)。
 */
export function resolveDynamicTool(toolName: string, actualAction?: string): { tool: string; action: string } | undefined {
  const m = METHOD_TO_TOOL[toolName];
  if (!m) return undefined;
  if (m.actions) {
    if (actualAction === undefined) return { tool: m.tool, action: m.action };
    const mapped = m.actions[actualAction];
    return mapped !== undefined ? { tool: m.tool, action: mapped } : undefined; // fail-closed
  }
  return { tool: m.tool, action: m.action };
}
