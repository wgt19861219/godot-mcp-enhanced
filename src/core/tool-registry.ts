import type { Tool, Server } from "@modelcontextprotocol/server";

// src/core/tool-registry.ts
import type { ToolResult, ToolContext } from '../types.js';
import { getLogger } from './logger.js';

// ─── Tool metadata ──────────────────────────────────────────────────────────

export type RiskLevel = 'read' | 'write' | 'destructive' | 'process';

export interface ToolMeta {
  name: string;
  readonly: boolean;
  long_running: boolean;
  actionRisks?: Record<string, RiskLevel>;
}

// ─── Tool module interface ───────────────────────────────────────────────────

export interface ToolModule {
  TOOL_META?: Record<string, {
    readonly?: boolean;
    long_running?: boolean;
    actionRisks?: Record<string, RiskLevel>;
  }>;
  getToolDefinitions(): Tool[];
  handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null>;
}

// ─── Internal state ─────────────────────────────────────────────────────────

const metaRegistry = new Map<string, ToolMeta>();
const moduleRegistry = new Map<string, ToolModule>();
const modules: ToolModule[] = [];

// ─── Module registration ────────────────────────────────────────────────────

/** Register a tool module. Called once per module at import time. */
export function registerModule(mod: ToolModule): void {
  if (modules.includes(mod)) return; // idempotent
  modules.push(mod);
  const meta = mod.TOOL_META;
  if (meta) {
    for (const [name, m] of Object.entries(meta)) {
      const actionRisks = m.actionRisks;
      const derivedReadonly = actionRisks
        ? Object.values(actionRisks).every(r => r === 'read')
        : false;
      const entry: ToolMeta = {
        name,
        readonly: m.readonly ?? derivedReadonly,
        long_running: m.long_running ?? false,
        actionRisks,
      };
      metaRegistry.set(name, entry);
      moduleRegistry.set(name, mod);
    }
  } else {
    // A-10: Auto-register default TOOL_META from getToolDefinitions() when
    // the module doesn't provide one. This eliminates the manual sync burden
    // (tool name written 3 times: definitions, TOOL_META, handleTool).
    // Default: readonly=false, long_running=false.
    const toolNames = mod.getToolDefinitions().map(t => t.name);
    for (const name of toolNames) {
      const entry: ToolMeta = { name, readonly: false, long_running: false };
      metaRegistry.set(name, entry);
      moduleRegistry.set(name, mod);
    }
  }
}

// ─── Inline tool registration ────────────────────────────────────────────────

/** Register an inline tool's metadata (for tools not in a ToolModule). */
export function registerInlineTool(name: string, meta: Omit<ToolMeta, 'name'>): void {
  metaRegistry.set(name, { name, ...meta });
}

// ─── Query functions ─────────────────────────────────────────────────────────

/** Check whether a tool name is registered in the meta registry. */
export function isKnownTool(name: string): boolean {
  return metaRegistry.has(name);
}

export function isReadOnly(name: string): boolean {
  return metaRegistry.get(name)?.readonly ?? false;
}

export function isLongRunning(name: string): boolean {
  return metaRegistry.get(name)?.long_running ?? false;
}

export function getReadOnlyTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => m.readonly).map(([n]) => n);
}

export function getWriteTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => !m.readonly).map(([n]) => n);
}

export function getAllToolNames(): string[] {
  return [...metaRegistry.keys()];
}

export function getToolMeta(name: string): ToolMeta | undefined {
  return metaRegistry.get(name);
}

export function getActionRisks(name: string): Record<string, RiskLevel> | undefined {
  return metaRegistry.get(name)?.actionRisks;
}

export function getActionRisk(toolName: string, action: string): RiskLevel | undefined {
  return getActionRisks(toolName)?.[action];
}

export function getModuleForTool(name: string): ToolModule | undefined {
  return moduleRegistry.get(name);
}

/** 找某 tool 的定义(含 inputSchema);inline tool(只进 metaRegistry)返 undefined。 */
export function getToolDefinition(name: string): Tool | undefined {
  for (const m of modules) {
    const def = m.getToolDefinitions().find((t) => t.name === name);
    if (def) return def;
  }
  return undefined;
}

export function getAllToolDefinitions(): Tool[] {
  return modules.flatMap(m => m.getToolDefinitions());
}

export function getModules(): readonly ToolModule[] {
  return modules;
}

// ─── Legacy API (backward compat) ───────────────────────────────────────────

/** Register tools from flat array (legacy, used by tests). */
export function registerTools(tools: ToolMeta[]): void {
  for (const t of tools) {
    metaRegistry.set(t.name, t);
  }
}

/** Clear all registered tools and modules (test-only). */
export function clearRegistry(): void {
  metaRegistry.clear();
  moduleRegistry.clear();
  modules.length = 0;
}

// ─── Tool groups ─────────────────────────────────────────────────────────────

/** Tool group definition with connection requirements and protection. */
export interface ToolGroupDef {
  description: string;
  tools: string[];
  requires: ('bridge' | 'editor' | 'headless')[];
  protected?: boolean;
}

/** Tool groups for fine-grained profile configuration. Count verified by test/tool-groups.test.js (number omitted here to avoid drift as groups are added). */
export const TOOL_GROUPS: Record<string, ToolGroupDef> = {
  core:       { description: '核心工具', tools: ['project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute', 'godot_get_context', 'runtime_assert', 'help', 'audit'], requires: [], protected: true },
  editor:     { description: '编辑器', tools: ['editor'], requires: ['editor'] },
  bridge:     { description: 'Game Bridge', tools: ['game', 'qa'], requires: ['bridge'] },
  animation:  { description: '动画系统', tools: ['animation', 'animtree', 'animation_track'], requires: [] },
  audio:      { description: '音频', tools: ['audio'], requires: [] },
  visual:     { description: '视觉', tools: ['material', 'screenshot', 'particles'], requires: [] },
  physics:    { description: '物理', tools: ['physics'], requires: [] },
  navigation: { description: '导航', tools: ['nav'], requires: [] },
  ui:         { description: 'UI', tools: ['ui'], requires: [] },
  tilemap:    { description: 'TileMap', tools: ['tilemap'], requires: [] },
  signal:     { description: '信号', tools: ['signal'], requires: [] },
  profiler:   { description: '性能分析', tools: ['profiler', 'workflow'], requires: [] },
  test:       { description: '测试（已并入 validation）', tools: [], requires: [] },
  code:       { description: '代码工具', tools: ['docs', 'load_skill', 'cpp', 'analysis'], requires: [] },
  // v0.18.0 合并说明:
  // ik → animation (ik_modifier_create/get/set/list_bones)
  // recording → runtime (record_start/stop/save/load/play)
  // node_create_3d → scene (create_3d_node)
  // scene_commit → scene (commit)
  // test/verify_delivery → validation (assert/stress/verify_delivery)
  // batch → workflow (create_files/run_verify/diff_scenes)
  // game_design → validation (validate_gdd/chain_verify)
  // templates → project (list/apply)
  blender:     { description: 'Blender 建模', tools: ['blender'], requires: [] },
  multi_instance: { description: '多实例', tools: ['godot_list_instances', 'godot_select_instance'], requires: [] },
  asset: { description: '资源操作（asset-forge）', tools: ['asset'], requires: ['editor'] },
  debug: { description: '调试器（断点管理 + DAP 协议调试）', tools: ['debug', 'dap'], requires: ['editor'] },
  engine: { description: '引擎内省（实时 ClassDB）', tools: ['engine'], requires: ['editor'] },
  android: { description: 'Android deploy', tools: ['android'], requires: [] },
  selfupdate: { description: '自更新', tools: ['self_update'], requires: [] },
  resources: { description: '资源管理(UID/翻译)', tools: ['uid', 'translation'], requires: [] },
  dynamic: { description: '动态工具（Godot 端注册但 MCP 侧未定义）', tools: ['godot_advanced_tool', 'godot_list_dynamic_routes'], requires: [] },
};

/** 7 preset profiles. Each maps to an array of group names. */
export const PROFILES: Record<string, string[]> = {
  full:        Object.keys(TOOL_GROUPS),
  // BREAKING CHANGE: lite now uses group-based expansion (matches current LITE_TOOLS content)
  lite:        ['core', 'bridge', 'animation', 'audio', 'signal', 'visual', 'code', 'test', 'profiler'],
  // G7 (2026-08-13): basic = 默认 profile(BREAKING from full)。对齐 GoPeak compact 默认小暴露,
  // 省 ~60% context(79KB→~30KB)。组清单 = lite(basic 语义名,lite 保留 --lite 兼容)。
  // RCE action(execute_gdscript 等)经 action-gate 默认全 gate 兜底,需 GODOT_MCP_PRIVILEGED_GROUPS 解锁。
  basic:       ['core', 'bridge', 'animation', 'audio', 'signal', 'visual', 'code', 'test', 'profiler'],
  minimal:     ['core'],
  slim:        ['core'],  // intentional alias of minimal - proxy tool is in core group,
  bridge_dev:  ['core', 'bridge', 'profiler', 'test', 'dynamic'],
  '3d_dev':    ['core', 'animation', 'visual', 'physics', 'navigation'],  // physics includes node_create_3d; ik actions via animation
};

/** Expand an array of group names to a deduplicated set of tool names. */
export function expandGroups(groups: string[]): Set<string> {
  const tools = new Set<string>();
  for (const g of groups) {
    const groupDef = TOOL_GROUPS[g];
    if (groupDef) {
      for (const t of groupDef.tools) tools.add(t);
    }
  }
  return tools;
}

/** Resolve a profile name (or comma-separated group list) to a Set of tool names. */
export function resolveProfile(profile: string): Set<string> {
  // Check if it's a known profile name
  const profileGroups = PROFILES[profile];
  if (profileGroups) {
    return expandGroups(profileGroups);
  }
  // Treat as comma-separated group names
  const groups = profile.split(',').map(g => g.trim()).filter(Boolean);
  return expandGroups(groups);
}

// ─── Active groups (connection-level, not persisted) ──────────────────────────

/** Currently active tool groups. Copy-on-write for read consistency. */
let activeGroups: Set<string> = new Set(Object.keys(TOOL_GROUPS));

/** Reverse mapping: tool name → group name. Built once from TOOL_GROUPS. */
const toolToGroup = new Map<string, string>();
for (const [group, def] of Object.entries(TOOL_GROUPS)) {
  for (const tool of def.tools) {
    toolToGroup.set(tool, group);
  }
}

/** Tools that are always allowed regardless of group state. */
export const ALWAYS_ALLOWED = new Set(['manage_tools', 'confirm_and_execute', 'godot_advanced_tool', 'godot_get_context', 'testing', 'csv_to_resources']);

/** Set active groups (copy-on-write). Returns previous set for comparison. */
export function setActiveGroups(groups: Set<string>): Set<string> {
  const prev = activeGroups;
  activeGroups = new Set(groups); // Copy-on-write
  return prev;
}

/** Get current active groups (read-only snapshot). */
export function getActiveGroups(): ReadonlySet<string> {
  return activeGroups;
}

// ─── Dynamic tool registration (CMP-16-B live schema) ────────────────────────

/** 动态注册的工具名集合(live schema 从 editor addon 拉取的工具)。
 *  registerDynamicTools 注入,getDynamicToolNames 查询。
 *  这些工具归入 'dynamic' 组(toolToGroup 映射),isToolAllowed 在 dynamic 组激活时放行。
 *  不进静态 TOOL_GROUPS 字面量(check-tool-groups.mjs 正则扫不到,天然安全)。 */
const dynamicToolNames = new Set<string>();

/** 注册一批动态工具(live schema 从 editor 拉取后调用)。
 *  完全替换之前的动态工具集(增量更新由调用方先 diff 再调)。
 *  同时更新 toolToGroup 映射,让 isToolAllowed 放行。 */
export function registerDynamicTools(names: string[]): void {
  // 清除旧映射
  for (const old of dynamicToolNames) {
    toolToGroup.delete(old);
  }
  dynamicToolNames.clear();
  // 注入新映射(归入 dynamic 组)
  for (const name of names) {
    dynamicToolNames.add(name);
    toolToGroup.set(name, 'dynamic');
  }
}

/** 获取当前动态注册的工具名集合(只读快照) */
export function getDynamicToolNames(): readonly string[] {
  return [...dynamicToolNames];
}

/** A1 (2026-08-11 审查): 判断某工具名是否动态注册(供 confirm/action-gate 反查静态 risk 用)。 */
export function isDynamicToolName(name: string): boolean {
  return dynamicToolNames.has(name);
}

/** Check if a tool is allowed under current active groups. */
export function isToolAllowed(toolName: string): boolean {
  if (ALWAYS_ALLOWED.has(toolName)) return true;
  const group = toolToGroup.get(toolName);
  if (!group) return false; // Unknown tool
  return activeGroups.has(group);
}

/** Get the group name for a tool. Returns undefined if tool not in any group. */
export function getGroupForTool(toolName: string): string | undefined {
  return toolToGroup.get(toolName);
}

// ─── Mode filters ────────────────────────────────────────────────────────────

// LITE/MINIMAL mode tool sets — now derived from PROFILES to avoid manual drift.
// BREAKING CHANGE: LITE_TOOLS expanded to include visual (material,screenshot,particles)
// and code (docs,templates,batch,game_design) groups. Previously these were listed
// individually as 'material', 'docs', 'screenshot' etc.
export const LITE_TOOLS: Set<string> = resolveProfile('lite');

export const MINIMAL_TOOLS: Set<string> = resolveProfile('minimal');

// ─── Offline-capable tools (Phase 4d) ──────────────────────────────────────────

/** Tools that can run without an active Godot connection. */
export const OFFLINE_TOOLS = new Set([
  'project', 'script', 'validation', 'confirm_and_execute',
  'manage_tools', 'godot_advanced_tool', 'load_skill', 'cpp',
  'analysis',  // v0.30 C 批：纯静态分析（tscn parser + .gd 扫描），零 Godot 依赖
]);

/** Check if a tool can run in offline mode. */
export function isOfflineCapable(toolName: string): boolean {
  return OFFLINE_TOOLS.has(toolName);
}

// ─── Tools that don't require project_path ────────────────────────────────

/** Tools that operate globally and should not require project_path.
 *
 * 与 ALWAYS_ALLOWED 的交集：manage_tools, confirm_and_execute, godot_advanced_tool
 * — 这三个工具既是"始终允许"也是"无需项目路径"，因它们操作全局注册表/内存状态。
 *
 * 其余 4 个（docs, godot_list_instances, godot_list_dynamic_routes, godot_select_instance）
 * 不在 ALWAYS_ALLOWED 中（可能被 profile 过滤掉），但同样不操作文件系统。
 */
export const NO_PROJECT_PATH_TOOLS = new Set([
  'docs',                // Godot class documentation lookup — 纯内存操作
  'manage_tools',        // Tool group management — 操作 tool-registry 内存状态
  'confirm_and_execute', // Confirmation token executor — 只需 token，内部用 pending.args
  'godot_advanced_tool', // Dynamic route proxy — 目标工具自身会获取路径
  'godot_list_instances', // Multi-instance listing — 读注册表数据
  'godot_list_dynamic_routes', // Dynamic route discovery — 读内存注册表
  'godot_select_instance', // Multi-instance selection — 可用 instance_id 代替 project_path
  'load_skill',          // 读用户本地知识库路径(libraries 参数),不操作 Godot 项目
  'godot_get_context',   // 会话全景元工具 — project_path 可选，字段降级（r3 修正 r2-N1）
  'help',                // 工具自文档——读包内 docs/tools,不操作 Godot 项目(反馈 2026-11-18)
  'debug',               // 断点管理——handler 与 editor 转发都不读 project_path(与 help 同类击穿)
  'engine',              // ClassDB 内省——同上
]);

/** Check if a tool should skip project_path validation. */
export function skipProjectPath(toolName: string): boolean {
  return NO_PROJECT_PATH_TOOLS.has(toolName);
}

// ─── Legacy tool mapping (v0.18.0 migration) ────────────────────────────────

/** 类型 A — 独立工具吸收的迁移映射。仅 GODOT_MCP_WARN_LEGACY 模式下生效。 */
export const LEGACY_TOOL_MAP: Record<string, { tool: string; action: string }> = {
  node_create_3d:  { tool: 'scene',      action: 'create_3d_node' },
  scene_commit:    { tool: 'scene',      action: 'commit' },
  recording:       { tool: 'runtime',    action: 'record_start' },
  verify_delivery: { tool: 'validation', action: 'verify_delivery' },
  test:            { tool: 'validation', action: 'assert' },
  ik:              { tool: 'animation',  action: 'ik_modifier_create' },
  templates:       { tool: 'project',    action: 'list' },
  batch:           { tool: 'workflow',   action: 'create_files' },
  game_design:     { tool: 'validation', action: 'validate_gdd' },
};

const WARN_LEGACY = () => !!process.env.GODOT_MCP_WARN_LEGACY;

/** 尝试将旧工具名映射到新 (tool, action)。仅 WARN_LEGACY 模式下生效。 */
export function tryLegacyMapping(toolName: string): { tool: string; action: string } | null {
  if (!WARN_LEGACY()) return null;
  const mapped = LEGACY_TOOL_MAP[toolName];
  if (mapped) {
    getLogger().warn('legacy', `"${toolName}" → ${mapped.tool}(action="${mapped.action}")`);
    return mapped;
  }
  return null;
}

// ─── listChanged notification ────────────────────────────────────────────────
let mcpServer: Server | null = null;

/** 注入 MCP Server 实例（GodotServer 启动时调用一次）。 */
export function setMcpServer(server: Server): void {
  mcpServer = server;
}

/** 清理 MCP Server 引用（GodotServer.close 时调用）。 */
export function clearMcpServer(): void {
  mcpServer = null;
}

/** 通知客户端工具列表已变更。不支持时静默忽略。 */
export function notifyToolsChanged(): void {
  if (!mcpServer) return;
  try {
    mcpServer.notification({ method: 'notifications/tools/list_changed' });
  } catch {
    // 客户端不支持此通知
  }
}
