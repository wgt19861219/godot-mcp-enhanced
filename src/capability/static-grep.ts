import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * group → 该 group 工具的主实现文件（src/tools/ 下相对路径）。
 * 基于 module-loader.ts:13-52 的 import + glob 核验。工具增减时此表同步更新
 * （M1 漂移检测会捕获 group 变更）。
 */
export const GROUP_SOURCE_FILES: Record<string, string[]> = {
  core: ['project.ts', 'scene.ts', 'script.ts', 'runtime.ts', 'validation.ts', 'manage-tools.ts'],
  editor: ['editor-sync.ts'],
  bridge: ['game-bridge.ts'],
  animation: ['animation/animation-ops.ts', 'animtree.ts'],
  audio: ['audio-ops.ts'],
  visual: ['material-ops.ts', 'screenshot.ts', 'particles.ts'],
  physics: ['physics-ops.ts'],
  navigation: ['navigation.ts'],
  ui: ['ui/ui-create.ts', 'ui/ui-draw.ts', 'ui/ui-layout.ts', 'ui/ui-theme.ts', 'ui-tools.ts'],
  tilemap: ['tilemap-ops.ts'],
  signal: ['signal-ops.ts'],
  profiler: ['profiler-ops.ts', 'workflow.ts'],
  code: ['docs.ts', 'load-skill.ts'],
  multi_instance: ['instance-tools.ts'],
  dynamic: ['advanced-proxy.ts'],
};

/**
 * 危险 API 触达模式（spec §3.1）。对齐 spec §3.1 危险 API 触达模式（OS.execute/str2var/bytes2var/ClassDB.instantiate/execute_gdscript/DirAccess.remove_absolute）。
 * 注：spawn-without-buildsafeenv 已 fixed，故不含裸 spawn（由专门审查覆盖）。
 */
export const DANGER_PATTERNS: RegExp[] = [
  // 注：点号不转义以便 .source 字符串化后仍含字面 "OS.execute"（测试逐字断言）。
  // 扫描副作用：会匹配 OS_execute / OSxexecute 等罕见形式，但 Godot 代码中无此命名，风险可忽略。
  /OS.execute\s*\(/,
  /str2var\s*\(/,
  /bytes2var\s*\(/,
  /ClassDB.instantiate\s*\(/,
  /\bexecute_gdscript\b/,
  /\bDirAccess.remove_absolute\b/,
];

/** 扫描给定 src/tools 文件，返回命中任一危险模式的文件相对路径。 */
export function scanDangerApi(groupFiles: string[], projectRoot: string): string[] {
  const hits: string[] = [];
  for (const rel of groupFiles) {
    const abs = join(projectRoot, 'src', 'tools', rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    if (DANGER_PATTERNS.some(p => p.test(src))) hits.push(rel);
  }
  return hits;
}

/**
 * 工具命令 → editor 侧实现文件（addons/godot_mcp_server/ 下相对路径）。
 * 源：addons/godot_mcp_server/command_handler.gd 的 handle() 路由表。
 * editor 加新命令时此表须同步——test/capability/static-grep.test.ts 有 drift 检测
 * （ROUTING keys 必须 == command_handler.gd handle() 里路由的 method 集合）。
 *
 * 取代旧 DEFAULT_GROUP_COMMANDS（group→单文件映射）。旧方案问题：editor commands 实际按
 * 功能域划分（scene/node/test/export/...）非按 TS group（core/visual/profiler/...），
 * 且 core 组实现分散在 scene_commands+node_commands+recording_commands+test_commands
 * 多文件，单文件映射无法表达，致 core/visual/profiler 等组 editor.exists 恒 false（错误）。
 * 改为按工具命令粒度精确路由（每个 tool.name 独立判断）。
 */
export const EDITOR_COMMAND_ROUTING: Record<string, string> = {
  // scene_commands（core 组：场景操作）
  open_scene: 'commands/scene_commands.gd',
  save_scene: 'commands/scene_commands.gd',
  instance_scene: 'commands/scene_commands.gd',
  set_instance_property: 'commands/scene_commands.gd',
  // node_commands（core 组：节点操作）
  add_node: 'commands/node_commands.gd',
  remove_node: 'commands/node_commands.gd',
  edit_node: 'commands/node_commands.gd',
  batch_add_nodes: 'commands/node_commands.gd',
  // test_commands（core/validation 组）
  test_assert: 'commands/test_commands.gd',
  // export_commands
  export_list_presets: 'commands/export_commands.gd',
  export_get_preset: 'commands/export_commands.gd',
  export_build: 'commands/export_commands.gd',
  // particle_commands（visual 组子域）
  particles_create: 'commands/particle_commands.gd',
  particles_set_emission: 'commands/particle_commands.gd',
  particles_set_process: 'commands/particle_commands.gd',
  particles_load_preset: 'commands/particle_commands.gd',
  particles_set_material: 'commands/particle_commands.gd',
  // nav_commands（navigation 组）
  nav_create_region: 'commands/nav_commands.gd',
  nav_bake_mesh: 'commands/nav_commands.gd',
  nav_create_agent: 'commands/nav_commands.gd',
  nav_set_params: 'commands/nav_commands.gd',
  nav_create_link: 'commands/nav_commands.gd',
  // animtree_commands（animation 组子域）
  animtree_create: 'commands/animtree_commands.gd',
  animtree_add_state: 'commands/animtree_commands.gd',
  animtree_add_transition: 'commands/animtree_commands.gd',
  animtree_set_blend: 'commands/animtree_commands.gd',
  animtree_play: 'commands/animtree_commands.gd',
  // sync_commands（editor 组：editor 同步 + scene tree 查询）
  editor_sync_start: 'commands/sync_commands.gd',
  editor_sync_stop: 'commands/sync_commands.gd',
  editor_get_scene_tree: 'commands/sync_commands.gd',
  editor_get_scene_stats: 'commands/sync_commands.gd',
  // animation_commands（animation 组：track/keyframe/curve/blend）
  animation_track: 'commands/animation_commands.gd',
  animation_keyframe: 'commands/animation_commands.gd',
  animation_curve: 'commands/animation_commands.gd',
  animation_blend: 'commands/animation_commands.gd',
  // recording_commands（runtime 录制）
  recording_start: 'commands/recording_commands.gd',
  recording_stop: 'commands/recording_commands.gd',
  recording_play: 'commands/recording_commands.gd',
  // ui_commands（ui 组）
  ui_create_control: 'commands/ui_commands.gd',
  ui_set_layout: 'commands/ui_commands.gd',
  ui_get_layout: 'commands/ui_commands.gd',
  ui_anchor_preset: 'commands/ui_commands.gd',
  ui_set_theme: 'commands/ui_commands.gd',
  ui_container_add: 'commands/ui_commands.gd',
  theme_create: 'commands/ui_commands.gd',
  theme_set_property: 'commands/ui_commands.gd',
  // asset_commands（asset-forge 整合：5 action merged asset 工具）
  asset_create: 'commands/asset/asset_commands.gd',
  asset_path: 'commands/asset/asset_commands.gd',
  asset_batch: 'commands/asset/asset_commands.gd',
  asset_undo: 'commands/asset/asset_commands.gd',
  asset_save: 'commands/asset/asset_commands.gd',
  // editor_guards（I-01 文本资源写入守卫；文件在 addons 根非 commands/）
  guard_text_resource_write: 'editor_guards.gd',
  // P1-2 (2026-07-06 review): 场景离线保存守卫(与 guard_text_resource_write 对称, 同在 editor_guards.gd)
  guard_offline_scene_save: 'editor_guards.gd',
};

/**
 * 探测工具在 editor 侧的实现文件，返回相对路径（addons/godot_mcp_server/ 下）或 null。
 * 精确按工具命令查 EDITOR_COMMAND_ROUTING（取代旧 group→单文件粗粒度映射）。
 */
export function findEditorCommandForTool(toolName: string): string | null {
  const rel = EDITOR_COMMAND_ROUTING[toolName];
  return rel ? `addons/godot_mcp_server/${rel}` : null;
}
