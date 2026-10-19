// src/tools/get-context.ts
/**
 * godot_get_context — 会话全景元工具。
 * 一次返回模式/项目/连接/场景快照/调用统计/工具组/workflow/rules/performance，
 * 减少 AI 反复 list_nodes/get_scene_tree/manage_tools(sync)/health 摸环境。
 */
import type { Tool } from "@modelcontextprotocol/server";

// src/tools/get-context.ts
import type { ToolContext, ToolResult } from '../types.js';
import { structuredResult } from '../types.js';
import { opsSuccess } from './shared.js';
import { getCallRecorder } from '../core/call-recorder.js';
import { listPromptDefs } from '../prompts.js';
import { TOOL_GROUPS, getActiveGroups } from '../core/tool-registry.js';
import { sendToBridge, setBridgeProjectDir } from './game-bridge.js';
import type { ConnectionStatus } from './manage-tools.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

// ─── SceneSnapshot type（export 供 Task 4 GodotServer import）─────────────────
export type SceneSnapshot = {
  path: string;
  root: string;
  nodeCount: number;
  typeTopN?: Array<{ type: string; n: number }>;
  truncated?: boolean;
};

// ─── 注入的 provider（GodotServer 接线，参照 manage-tools _connectionStatusProvider）───
let _connectionStatusProvider: (() => ConnectionStatus | null) | null = null;

/** 注入 connectionStatus provider（editor 连接态 + bridge note）。setGetContextConnectionProvider
 *  独立命名避免与 manage-tools 的 setConnectionStatusProvider 撞名（r2 IMP-2）。 */
export function setGetContextConnectionProvider(provider: (() => ConnectionStatus | null) | null): void {
  _connectionStatusProvider = provider;
}

let _editorSceneProvider: (() => Promise<SceneSnapshot | null>) | null = null;

/** 注入 editor 场景快照 provider（内部 editorConn.request('editor_get_scene_stats')）。
 *  批 2 M1：editor 不需要 project_path（editorConn 全局），签名简化为 ()。 */
export function setEditorSceneProvider(provider: (() => Promise<SceneSnapshot | null>) | null): void {
  _editorSceneProvider = provider;
}

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'godot_get_context',
    description: '一次返回会话全景（模式/项目/连接/场景快照/最近调用统计/工具组/推荐 workflow/规则/性能），减少反复探路。headless 模式 scene=null。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: '项目路径（可选；传了补 project/rules 字段，没传降级 null/[]）' },
        include_scene: { type: 'boolean', description: '是否采集场景快照（默认 true；headless 恒 null）' },
        include_performance: { type: 'boolean', description: '是否采集性能（默认 true；仅 bridge 有效）' },
      },
    },
    // B4 (2026-10-19): typed outputs 试点——声明返回结构,modern 客户端直接消费
    // structuredContent 免 parse;text 通道与旧客户端行为不变。schema 从实际返回
    // 提炼(字段可 null 是字段级降级语义:failedFields 注明哪些字段没采到)。
    outputSchema: {
      type: 'object' as const,
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'partial'] },
            failedFields: { type: 'array', items: { type: 'string' } },
            mode: { type: ['string', 'null'], enum: ['headless', 'editor', 'bridge', null] },
            project: { type: ['object', 'null'] },
            connections: { type: 'object' },
            scene: { type: ['object', 'null'] },
            recentCalls: { type: 'array' },
            callStats: { type: ['object', 'null'] },
            toolGroups: { type: 'array' },
            workflows: { type: 'array' },
            rules: { type: 'array', items: { type: 'string' } },
            performance: { type: ['object', 'null'] },
            hint: { type: 'string' },
          },
          required: ['status', 'mode'],
        },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['success', 'data'],
    },
  }];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'godot_get_context') return null;
  // 外层 try/catch：任何未预期错误都降级为 partial，永不抛给调用方
  // (N-4 审查修复:降级路径同走 structuredResult——双通道承诺是工具级的,
  // 声明了 outputSchema 的工具不能只在 happy-path 给 structuredContent)
  try {
    return await handleGetContext(args, ctx);
  } catch {
    return structuredResult(opsSuccess({
      status: 'partial',
      failedFields: ['__handler__'],
      mode: null,  // schema required 字段——降级路径同样满足声明
      hint: 'godot_get_context 内部异常，已降级返回',
    }) as unknown as Record<string, unknown>);
  }
}

async function handleGetContext(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const failedFields: string[] = [];
  const includeScene = args.include_scene !== false;
  const includePerf = args.include_performance !== false;
  const projectPath = args.project_path as string | undefined;

  const bridgeReachable = await probeBridge(projectPath, ctx);
  const mode = await safeAsync(() => computeMode(projectPath, ctx, bridgeReachable), 'mode', failedFields);
  const project = safe(() => readProject(projectPath), 'project', failedFields);
  const connections = await safeAsync(() => readConnections(projectPath, ctx, bridgeReachable), 'connections', failedFields);
  const scene = (!includeScene || mode === 'headless' || mode === null)
    ? null
    : await safeAsync(() => readScene(mode as 'editor' | 'bridge', projectPath, ctx), 'scene', failedFields);
  const callStats = safe(() => getCallRecorder().getStats(), 'callStats', failedFields);
  const recentCalls = safe(() => getCallRecorder().getRecent(50), 'recentCalls', failedFields);
  const toolGroups = safe(() => readToolGroups(), 'toolGroups', failedFields);
  const workflows = safe(
    () => listPromptDefs().map(p => ({ name: p.name, type: 'prompt' as const, desc: p.description })),
    'workflows',
    failedFields,
  );
  const rules = safe(() => readRules(projectPath), 'rules', failedFields);
  const performance = (includePerf && mode === 'bridge')
    ? await safeAsync(() => readPerformance(ctx), 'performance', failedFields)
    : null;

  return structuredResult(opsSuccess({
    status: failedFields.length === 0 ? 'ok' : 'partial',
    failedFields,
    mode,
    project,
    connections,
    scene,
    recentCalls,
    callStats,
    toolGroups,
    workflows,
    rules,
    performance,
    hint: 'scene.nodeCount=节点总数；recentCalls=最近操作；callStats.topTools=最常用工具；workflows=推荐入口(prompt)；performance 仅 bridge；status=partial 时看 failedFields',
  }) as Record<string, unknown>);
}

/** 字段级降级 wrapper：抛错 → 字段名入 failedFields，返回 null。 */
function safe<T>(fn: () => T, field: string, failed: string[]): T | null {
  try { return fn(); } catch { failed.push(field); return null; }
}

/** 异步字段降级 wrapper：rejected → 字段名入 failed，返回 null。 */
async function safeAsync<T>(fn: () => Promise<T>, field: string, failed: string[]): Promise<T | null> {
  try { return await fn(); } catch { failed.push(field); return null; }
}

// ─── 字段采集 helper ──────────────────────────────────────────────────────────

/** 探测 bridge 是否可达（单次 ping，2s 超时，不阻塞，永不抛）。无 projectDir 则跳过返 false。 */
async function probeBridge(projectPath: string | undefined, ctx: ToolContext): Promise<boolean> {
  const dir = ctx.projectDir || projectPath;
  if (!dir) return false;
  try {
    setBridgeProjectDir(dir);  // 批 1 M1：全局副作用——设置 game-bridge 模块 project dir（后续 sendToBridge 隐式依赖）
    const r = await sendToBridge('ping', {}, 2000);
    return !!r && !r.error;
  } catch {
    return false;
  }
}

/** 摘要：editor 连了→editor，bridge 可达→bridge，否则 headless。 */
async function computeMode(
  _projectPath: string | undefined,
  _ctx: ToolContext,
  bridgeReachable: boolean,
): Promise<'headless' | 'editor' | 'bridge'> {
  const cs = _connectionStatusProvider?.() ?? null;
  if (cs?.editor.connected) return 'editor';
  if (bridgeReachable) return 'bridge';
  return 'headless';
}

/** editor 字段从 connectionStatus；bridge.status 用 ping 探测结果。 */
async function readConnections(
  projectPath: string | undefined,
  ctx: ToolContext,
  bridgeReachable: boolean,
): Promise<{
  editor: { installed: boolean; connected: boolean; state: string | null };
  bridge: { status: string; note?: string };
}> {
  const cs = _connectionStatusProvider?.() ?? null;
  return {
    editor: cs?.editor ?? { installed: false, connected: false, state: null },
    bridge: {
      status: bridgeReachable ? 'connected' : (projectPath || ctx.projectDir ? 'unreachable' : 'probe-required'),
      note: cs?.bridge.note,
    },
  };
}

/**
 * project = { name, godot: null, path }。name 从 project.godot config/name 提；
 * godot=null 避免 spawn（detectGodotVersion 无缓存，每次 spawn 成本过高）。
 * 无 projectPath / project.godot 缺失 / 读失败 → null（字段级降级）。
 */
function readProject(projectPath: string | undefined): { name: string; godot: null; path: string } | null {
  if (!projectPath) return null;
  const cfg = join(projectPath, 'project.godot');
  if (!existsSync(cfg)) return null;
  // 批 1 M4：移除内部 try/catch，fs 抛错（权限等）冒泡到 safe wrapper → failedFields（partial），
  // 与 existsSync=false 的正常降级 null 区分（后者 status 仍 ok）
  const content = readFileSync(cfg, 'utf-8');
  const name = parseProjectName(content) ?? basename(projectPath);
  return { name, godot: null, path: projectPath };
}

/** 从 project.godot 文本提 [application] 段 config/name="X" 的 X。无匹配 → null。
 *  批 1 M2：正则锚 [application] 段（[^\[]*? 不跨段），避免其他段同名 key 误匹配。 */
function parseProjectName(content: string): string | null {
  const m = content.match(/\[application\][^[]*?config\/name\s*=\s*"([^"]*)"/);
  return m ? m[1] ?? null : null;
}

/**
 * 场景快照：editor 走 editorSceneProvider（editorConn → editor_get_scene_stats），
 * bridge 走 sendToBridge('get_scene_stats')。headless null。TS 零聚合透传。
 * SceneSnapshot typeTopN/truncated optional（>2000 节点 typeTopN 缺省）。
 */
async function readScene(mode: 'headless' | 'editor' | 'bridge', projectPath: string | undefined, ctx: ToolContext): Promise<SceneSnapshot | null> {
  if (mode === 'headless') return null;  // 批 2 M3：分支守卫（调用方已过滤 headless，此处防御 + 确保 mode 收窄为 editor/bridge，否则 fall through 到 bridge 分支）
  if (mode === 'editor') {
    if (!_editorSceneProvider) return null;
    return await _editorSceneProvider();
  }
  // bridge
  const dir = ctx.projectDir || projectPath;
  if (!dir) return null;
  const r = await sendToBridge('get_scene_stats', {}, 2000);
  if (!r || r.error) return null;
  const stats = (r.result as { stats?: SceneSnapshot | null })?.stats ?? null;
  if (!stats) return null;
  // 规范化：GDScript typeTopN:null → undefined（optional 字段）
  const { typeTopN, ...rest } = stats;
  return { ...rest, ...(typeTopN && typeTopN.length > 0 ? { typeTopN } : {}) };
}

/** toolGroups 清单。复用 manage-tools.ts handleListGroups 模式。 */
function readToolGroups(): Array<{ name: string; active: boolean; requires: string[] }> {
  const active = getActiveGroups();
  return Object.entries(TOOL_GROUPS).map(([name, def]) => ({
    name,
    active: active.has(name),
    requires: def.requires,
  }));
}

/** rules = {projectPath}/.claude/rules/*.md 文件名列表。无 projectPath 或目录不存在 → []（正常降级）。
 *  批 1 M4：移除内部 try/catch，readdirSync 抛错冒泡到 safe wrapper → failedFields（partial）。
 *  批 1 M3（withFileTypes）defer：YAGNI——.claude/rules 下 .md 目录不现实，当前 endsWith('.md') 足够。 */
function readRules(projectPath: string | undefined): string[] {
  if (!projectPath) return [];
  const rulesDir = join(projectPath, '.claude', 'rules');
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir).filter(f => f.endsWith('.md'));
}

/** performance = { fps, memory_mb }。仅 bridge（外层已守卫）。get_performance result 字段可选链降级。 */
async function readPerformance(_ctx: ToolContext): Promise<{ fps: number; memory_mb: number } | null> {
  const r = await sendToBridge('get_performance', {}, 2000);
  if (!r || r.error) return null;
  const result = (r.result ?? {}) as { fps?: number; static_mem?: number; memory?: number };
  const fps = typeof result.fps === 'number' ? result.fps : null;
  const memBytes = typeof result.static_mem === 'number'
    ? result.static_mem
    : (typeof result.memory === 'number' ? result.memory : null);
  if (fps === null || memBytes === null) return null;
  return { fps, memory_mb: Math.round(memBytes / (1024 * 1024)) };
}

export const TOOL_META = {
  godot_get_context: { readonly: true, long_running: false, actionRisks: { _: 'read' as const } },
};
