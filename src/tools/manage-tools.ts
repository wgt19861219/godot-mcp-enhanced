import type { Tool } from "@modelcontextprotocol/server";

// src/tools/manage-tools.ts — manage_tools meta-tool (Task 4)
//
// Always-available tool for dynamically managing tool group activation.
// Belongs to the protected 'core' group and cannot be deactivated.
import type { RiskLevel } from '../core/tool-registry.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import type { ConnectionState } from '../types.js';
import {
  TOOL_GROUPS,
  setActiveGroups,
  getActiveGroups,
  getGroupForTool,
  ALWAYS_ALLOWED as ALWAYS_ALLOWED_TOOLS,
  notifyToolsChanged,
  LEGACY_TOOL_MAP,
  PROFILES,
  getAllToolDefinitions,
} from '../core/tool-registry.js';
import { opsSuccess, opsError } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ACTIONS = ['list_groups', 'discover', 'activate', 'deactivate', 'sync', 'reconnect', 'migrate'] as const;

type ManageAction = (typeof ACTIONS)[number];

export interface ConnectionStatus {
  editor: { installed: boolean; connected: boolean; state: ConnectionState | null };
  bridge: { note: string };
}

/** Optional callback fired when groups change (set by GodotServer). */
let _onGroupsChanged: (() => void) | null = null;

/** Connection status provider (set by GodotServer). */
let _connectionStatusProvider: (() => ConnectionStatus) | null = null;

/** Reconnect editor handler (set by GodotServer). */
let _reconnectEditor: (() => Promise<{ connected: boolean; detail: string }>) | null = null;

/** Set notification callback (called by GodotServer). */
export function setOnGroupsChanged(fn: (() => void) | null): void {
  _onGroupsChanged = fn;
}

/** Set connection status provider (called by GodotServer). */
export function setConnectionStatusProvider(fn: (() => ConnectionStatus) | null): void {
  _connectionStatusProvider = fn;
}

/** Set reconnect editor handler (called by GodotServer). */
export function setReconnectEditor(fn: (() => Promise<{ connected: boolean; detail: string }>) | null): void {
  _reconnectEditor = fn;
}

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'manage_tools',
      description:
        '动态管理工具组的启用/停用状态。始终可用，不可被禁用。' +
        '支持 list_groups（列出所有组+profile 价格标签）、discover（关键词发现工具——全量 45 工具×action 搜索评分,返回匹配/所属组/激活态/激活指引,未激活组里的能力由此发现）、activate（启用组）、deactivate（停用组）、sync（同步连接状态）、reconnect（手动重连）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。list_groups=列工具组(含 per-profile 价格), discover=发现, activate/deactivate=启停工具, sync=同步, reconnect=重连, migrate=迁移',
          },
          groups: {
            type: 'array',
            items: { type: 'string' },
            description: '目标组名数组（activate/deactivate 时使用）',
          },
          query: {
            type: 'string',
            description: 'discover: 关键词(空格/逗号分词,大小写不敏感)。按工具名/action 名/组名/描述加权评分,返回 top 匹配与激活指引',
          },
          top: {
            type: 'number',
            description: 'discover: 返回条数上限(默认 8,最大 20)',
          },
        },
        required: ['action'],
      },
    },
  ];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'manage_tools') return null;

  const action = args.action as ManageAction;

  switch (action) {
    case 'list_groups': return handleListGroups();
    case 'discover': return handleDiscover(args);
    case 'activate': return handleActivate(args);
    case 'deactivate': return handleDeactivate(args);
    case 'sync': return handleSync();
    case 'reconnect': return await handleReconnect();
    case 'migrate': return handleMigrate();
    default:
      return textResult(JSON.stringify(opsError('INVALID_ACTION', `Unknown action: ${action}`)));
  }
}

/**
 * P5-1 (2026-09-11): discover 按需发现评分(上游报告 #9 / satellite discover_tools 模式)。
 * 默认 basic profile 只 ships 25 工具,未激活组(engine/blender/android/asset/debug 等)里
 * 的能力对 agent 不可见——discover 用关键词在全量 45 工具×action 名上搜索评分,返回匹配
 * +所属组+激活态+激活指引(activate hint),让"能力可见性"不依赖全量 ships(省 token 的
 * 另一半)。评分:工具名×5 > action 名×4 > 组名×3 > schema 属性描述×2 > 顶层描述×1,
 * 每词累计,大小写不敏感。属性描述维度承重:P4 瘦身后 action 级能力词(如 game 的
 * take_screenshot)只在 method/params 属性描述里,顶层描述用概览词("截图")。
 */
function handleDiscover(args: Record<string, unknown>): ToolResult {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return textResult(JSON.stringify(opsError('INVALID_PARAMS', 'discover requires a non-empty "query" (关键词,空格/逗号分词)')));
  }
  const top = Math.min(Math.max(Number(args.top) || 8, 1), 20);
  const terms = query.split(/[\s,，]+/).filter(Boolean).map(t => t.toLowerCase());
  const active = getActiveGroups();
  const scored: Array<{ tool: string; group: string; active: boolean; score: number; matched: string[]; description: string; hint: string }> = [];
  for (const def of getAllToolDefinitions()) {
    // N-2(审查): ALWAYS_ALLOWED 工具(manage_tools/testing 等)不在 TOOL_GROUPS 反向映射里,
    // 回填 'always-allowed'(它们常驻可用,无组概念)而非误导性的 'unknown'
    const group = getGroupForTool(def.name) ?? (ALWAYS_ALLOWED_TOOLS.has(def.name) ? 'always-allowed' : 'unknown');
    const actionEnum = extractActionEnum(def);
    const propsDesc = extractPropsDescription(def);
    let score = 0;
    const matched = new Set<string>();
    for (const term of terms) {
      if (def.name.toLowerCase().includes(term)) { score += 5; matched.add(term); }
      if (actionEnum.some(a => a.toLowerCase().includes(term))) { score += 4; matched.add(term); }
      if (group.toLowerCase().includes(term)) { score += 3; matched.add(term); }
      if (propsDesc.some(d => d.includes(term))) { score += 2; matched.add(term); }
      if ((def.description ?? '').toLowerCase().includes(term)) { score += 1; matched.add(term); }
    }
    if (score <= 0) continue;
    const isActive = active.has(group) || ALWAYS_ALLOWED_TOOLS.has(def.name);
    scored.push({
      tool: def.name,
      group,
      active: isActive,
      score,
      matched: [...matched],
      description: (def.description ?? '').slice(0, 120),
      hint: isActive ? '已激活,可直接调用' : `manage_tools activate ["${group}"] 后可用(再调用该工具)`,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));
  return textResult(JSON.stringify(opsSuccess({
    query: terms,
    total_matched: scored.length,
    results: scored.slice(0, top),
  })));
}

/** inputSchema 各属性 description 的小写集合(评分第五维度;P4 瘦身后 action 级能力词在此)。 */
function extractPropsDescription(def: Tool): string[] {
  const props = (def.inputSchema as { properties?: Record<string, { description?: unknown }> }).properties;
  if (!props) return [];
  const out: string[] = [];
  for (const p of Object.values(props)) {
    if (typeof p?.description === 'string') out.push(p.description.toLowerCase());
  }
  return out;
}

/** 从 inputSchema 提取 action enum(getToolDefinitions 统一 action 字段;无 enum 返空)。 */
function extractActionEnum(def: Tool): string[] {
  const props = (def.inputSchema as { properties?: Record<string, { enum?: unknown }> }).properties;
  const actionEnum = props?.action?.enum;
  return Array.isArray(actionEnum) ? actionEnum.map(String) : [];
}

function handleListGroups(): ToolResult {
  const active = getActiveGroups();
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => ({
    name,
    description: def.description,
    active: active.has(name),
    protected: def.protected ?? false,
    requires: def.requires,
    toolCount: def.tools.length,
  }));
  return textResult(JSON.stringify(opsSuccess({ groups, profiles: profilePriceTags() })));
}

/**
 * P3-4 (2026-09-11, beckett doctor 模式): 每 profile 的 tools/list payload 实测字节与
 * 近似 token——给 profile 选择加"价格标签"( BuildersGate 105k 基线的对照锚)。
 * 必须 Buffer.byteLength(JSON 字符串): string.length 数的是 UTF-16 code unit,对中文描述
 * (本 server 全量中文)少报 2/3 字节——beckett 实测 ~100 个非 ASCII 少报 ~200B 同款坑。
 * 口径 = name + description + inputSchema 的 JSON 序列化字节(getAllToolDefinitions 返回
 * registerAllModules 包装后的定义,即 slimSchema/injectTags 生效后的实际 ships 量)。
 */
export function profilePriceTags(): Array<{ name: string; tools: number; bytes: number; approxTokens: number }> {
  const allDefs = getAllToolDefinitions();
  return Object.entries(PROFILES).map(([name, groups]) => {
    const toolNames = new Set<string>();
    for (const g of groups) {
      for (const t of TOOL_GROUPS[g]?.tools ?? []) toolNames.add(t);
    }
    const defs = allDefs.filter(t => toolNames.has(t.name));
    const bytes = defs.reduce(
      (sum, t) => sum + Buffer.byteLength(
        JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
        'utf8',
      ),
      0,
    );
    return { name, tools: defs.length, bytes, approxTokens: Math.round(bytes / 4) };
  });
}

function handleActivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for activate')));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) {
    if (TOOL_GROUPS[g]) updated.add(g);
  }
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    activated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleDeactivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for deactivate')));
  }
  // Reject attempts to deactivate protected groups
  const protectedNames = targetGroups.filter(g => TOOL_GROUPS[g]?.protected);
  if (protectedNames.length > 0) {
    return textResult(JSON.stringify(opsError(
      'PROTECTED_GROUP',
      `Cannot deactivate protected groups: ${protectedNames.join(', ')}`,
    )));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) updated.delete(g);
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    deactivated: targetGroups,
    activeGroups: [...updated],
  })));
}

async function handleReconnect(): Promise<ToolResult> {
  let editor: { reconnected: boolean; detail: string } | null;
  if (_reconnectEditor) {
    const r = await _reconnectEditor();
    editor = { reconnected: r.connected, detail: r.detail };
  } else {
    editor = null;
  }
  return textResult(JSON.stringify(opsSuccess({
    editor,
    bridge: { reconnected: false, detail: 'bridge 每请求建连,无需重连;用 game_query(method=ping) 探测' },
  })));
}

function handleSync(): ToolResult {
  const provider = _connectionStatusProvider;
  // M1: provider() 提循环外。原 groups.map 内每 group 调一次 + editor/bridge 各一次(N+2),
  // provider=buildConnectionStatus 同步无 I/O 故无害,但单次调用更清晰且避免重复构造。
  const cs = provider ? provider() : null;
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => {
    const requires = def.requires ?? [];
    let status: string;
    if (!cs) {
      status = 'unknown (no provider)';
    } else {
      if (requires.includes('editor')) status = cs.editor.connected ? 'connected' : 'disconnected';
      else if (requires.includes('bridge')) status = 'probe-required';
      else status = 'n/a';
    }
    return { name, requires, status };
  });
  return textResult(JSON.stringify(opsSuccess({
    groups,
    editor: cs?.editor ?? null,
    bridge: cs?.bridge ?? null,
  })));
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  manage_tools: {
    readonly: true,
    long_running: false,
    actionRisks: {
      list_groups: 'read',
      discover: 'read',
      sync: 'read',
      reconnect: 'read',
      migrate: 'read',
      activate: 'write',
      deactivate: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};

function handleMigrate(): ToolResult {
  const mapping: Record<string, { tool: string; action: string }> = {};
  const renamed: Record<string, string> = {};
  const removed: string[] = [];
  const unchanged = ['confirm_and_execute', 'godot_advanced_tool', 'manage_tools', 'godot_list_instances', 'godot_select_instance'];

  for (const [oldName, target] of Object.entries(LEGACY_TOOL_MAP)) {
    mapping[oldName] = target;
    removed.push(oldName);
    if (oldName.includes('_')) {
      renamed[oldName] = `${target.tool}(action="${target.action}")`;
    }
  }

  return textResult(JSON.stringify(opsSuccess({
    version: '0.18.0',
    description: '旧工具名到新 (tool, action) 的迁移映射',
    mapping,
    renamed,
    removed,
    unchanged,
  })));
}

// ─── 纯工厂(供 GodotServer 接线,可单测)────────────────────────────────────

export interface EditorConnLike {
  isConnected(): boolean;
  connect(): Promise<void>;
  /** C-RECONNECT-1: 可选,EditorConnection 实现。buildReconnectEditor connect 失败时启动后台重连循环。 */
  requestReconnect?(): void;
}
export interface HealthMonitorLike {
  getState(): ConnectionState;
}

export function buildConnectionStatus(
  editorConn: EditorConnLike | null,
  healthMonitor: HealthMonitorLike | null,
): ConnectionStatus {
  return {
    editor: {
      installed: editorConn !== null,
      connected: editorConn?.isConnected() ?? false,
      // M5: state 结合 connected。healthMonitor 默认 'connected'(基于工具调用健康,非 editor 连接),
      // 直接用作 editor.state 会在 editor 未连时报 "connected"(observed: state:"connected" 但 connected:false)。
      // editor 连上时 state 才用 healthMonitor(工具健康);未连报 disconnected;未启动报 null。
      state: (editorConn?.isConnected() ?? false)
        ? (healthMonitor?.getState() ?? 'connected')
        : (editorConn ? 'disconnected' : null),
    },
    bridge: { note: '每请求建连,无持久连接' },
  };
}

export function buildReconnectEditor(
  getEditor: () => EditorConnLike | null,
  rebuild?: () => Promise<{ connected: boolean; detail: string }>,
): () => Promise<{ connected: boolean; detail: string }> {
  return async () => {
    const ec = getEditor();
    if (!ec) {
      // 方案B: ec=null(editor 降级)且注入了 rebuild → 尝试重建连接(重新读 secret + new EditorConnection)。
      if (rebuild) {
        try {
          return await rebuild();
        } catch (e) {
          return { connected: false, detail: `重建失败: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // 无 rebuild(向后兼容):中性表述 + 恢复指引。
      // 审查 IMPORTANT-3: ec=null 无法区分"从未安装"与"曾连接后降级",故不断言"未安装"
      // (降级时 editor 可能已装)。未启动→launch_editor/F5;降级→重启服务端。
      return { connected: false, detail: 'editor 未连接(可能未启动或已降级到 headless)。用 launch_editor / F5 启动编辑器;若已在运行,重启 MCP 服务端恢复' };
    }
    if (ec.isConnected()) return { connected: true, detail: '已连接' };
    // CMP-8 (2026-08-08): 按连接状态返回差异化恢复指引(AI 拿到精准诊断而非泛化提示)
    const state = 'getState' in ec ? (ec as { getState(): ConnectionState }).getState() : null;
    try {
      await ec.connect();
      return { connected: ec.isConnected(), detail: '手动重连完成' };
    } catch (e) {
      // C-RECONNECT-1: connect 一次性失败(编辑器暂未 ready/耗尽后)时启动后台自动重连循环,
      // 编辑器恢复后自动连上。避免用户须反复手动 reconnect 或重启 MCP 服务端。
      ec.requestReconnect?.();
      const errMsg = e instanceof Error ? e.message : String(e);
      // CMP-8: 按 state 给差异化 hint
      let hint = '已启动后台重试,编辑器恢复后自动连';
      if (state === 'reconnecting') hint = '自动重连进行中,编辑器恢复后自动连上,无需反复手动 reconnect';
      else if (state === 'degraded') hint = '连接降级(近有工具失败),编辑器可能卡住;若 launch_editor 后仍失败,重启 MCP 服务端';
      else if (state === 'disconnected') hint = '编辑器未运行,用 launch_editor / F5 启动;若已在运行,重启 MCP 服务端恢复';
      return { connected: false, detail: `重连失败(${hint}): ${errMsg}` };
    }
  };
}
