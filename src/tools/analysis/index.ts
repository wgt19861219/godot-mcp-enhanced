// src/tools/analysis/index.ts — 理解层工具：signal_map / impact_check / layout_compare
//
// 定位（对标 GodotIQ Pro 的免费开源版）：改信号/脚本/场景前列出受影响面，
// 防"改一处坏五处"。纯静态分析（tscn parser + .gd 文本扫描 + 树读数比对），
// 零 Godot 依赖。诚实边界：运行时动态信号名、autoload 单例间 connect 在扫描
// 可见面之外，blindspots 字段显式标注。
// layout_compare（2026-09-21 布局审计能力 B）：ref/cand 两份树读数 JSON 容差
// 比对——跨引擎迁移/版本快照对齐的数值审计层，配合 game_query dump_layout_tree。

import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { Tool } from '@modelcontextprotocol/server';
import type { ToolResult, ToolContext } from '../../types.js';
import { textResult } from '../../types.js';
import { opsSuccess, opsErrorResult } from '../shared.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { scanProject, sceneScriptBindings, toResPath, type ProjectScan } from './scanner.js';
import { scanGdScriptSignals, type GdSignalRef } from './gdscan.js';
import { layoutCompare } from './layout-compare.js';
import type { Connection } from '../../tscn/tscn-parser.js';

const TOOL_NAMES = ['analysis'] as const;
export { TOOL_NAMES };

const DEFAULT_LIMIT = 200;

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'analysis',
    description: '理解层静态分析（零 Godot 依赖）。action=signal_map 列全项目信号连接'
      + '（.tscn [connection] 声明 + .gd 代码 connect/emit 引用，两来源分开标注）；'
      + 'action=impact_check 改动前影响面评估——改信号列出全部连接方/发射方/监听方，'
      + '改脚本列出引用它的场景与节点，改场景列出其连接/脚本/被实例化处。'
      + 'action=layout_compare 布局树读数容差比对（ref/cand 两份 JSON，DRIFT/MISSING/EXTRA '
      + '数值差异清单，锚点与 null 项自动跳过防假阳性，支持 rebase 相对化）——跨引擎迁移/'
      + '版本快照对齐的数值审计层，配合 game_query dump_layout_tree 导出。'
      + '盲区诚实标注：运行时动态信号名/autoload 间连接不可见。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['signal_map', 'impact_check', 'layout_compare'],
          description: 'signal_map=信号连接全景；impact_check=改动影响面；layout_compare=布局树读数比对',
        },
        project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录；layout_compare 不需要）' },
        // signal_map 过滤
        signal: { type: 'string', description: '信号名过滤（signal_map 精确匹配；impact_check 必填三选一）' },
        scene: { type: 'string', description: 'signal_map: 场景路径子串过滤（如 scenes/ui）' },
        // impact_check 目标（三选一）
        script_path: { type: 'string', description: 'impact_check: 脚本路径（res:// 或绝对）' },
        scene_path: { type: 'string', description: 'impact_check: 场景路径（res:// 或绝对）' },
        limit: { type: 'number', description: `每列表截断上限（默认 ${DEFAULT_LIMIT}）` },
        // layout_compare 参数
        ref_path: { type: 'string', description: 'layout_compare: 基准树读数 JSON 路径（平铺 {名:[x,y,w,h]} 或包装 {"controls":{...},"_anchored":[...]}）' },
        cand_path: { type: 'string', description: 'layout_compare: 候选树读数 JSON 路径（同上格式）' },
        tol: { type: 'number', description: 'layout_compare: 坐标容差 px（默认 2；恰好等于 tol 不判 DRIFT）' },
        rebase: { type: 'string', description: 'layout_compare: cand 侧以指定控件 origin 为原点相对化（global→皮肤根相对，跨源比对必需）' },
      },
      // project_path 有 GODOT_PROJECT_PATH/cwd 兜底（requireProjectPath），且 layout_compare
      // 不消费它——不列 required（修复原 schema "description 说可选但 required 强制"的不自洽）
      required: ['action'],
    },
  }];
}

export const TOOL_META = {
  'analysis': {
    readonly: true,
    long_running: false,
    actionRisks: {
      signal_map: 'read' as const,
      impact_check: 'read' as const,
      layout_compare: 'read' as const,
    },
  },
};

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'analysis') return null;
  void ctx; // 纯静态分析，无需执行上下文
  const action = args.action as string;

  try {
    switch (action) {
      case 'signal_map':
        return signalMap(args);
      case 'impact_check':
        return impactCheck(args);
      case 'layout_compare':
        return layoutCompare(args);
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}（可用：signal_map/impact_check/layout_compare）`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return opsErrorResult('ANALYSIS_ERROR', `analysis.${action} 失败: ${msg}`);
  }
}

// ─── 共享 ────────────────────────────────────────────────────────────────────

interface CodeRef extends GdSignalRef {
  script: string;
}

/** 全项目 .gd 信号引用（读盘 + 扫描） */
function collectCodeRefs(scan: ProjectScan, signalFilter?: string): CodeRef[] {
  const out: CodeRef[] = [];
  for (const res of scan.scripts) {
    let code: string;
    try {
      code = readFileSync(join(scan.root, res.replace(/^res:\/\//, '')), 'utf-8');
    } catch {
      continue; // 读失败跳过（权限/编码），不中止全项目扫描
    }
    for (const ref of scanGdScriptSignals(code)) {
      if (signalFilter && ref.signal !== signalFilter) continue;
      out.push({ ...ref, script: res });
    }
  }
  return out;
}

function truncate<T>(list: T[], limit: number): { items: T[]; total: number; truncated: boolean } {
  return { items: list.slice(0, limit), total: list.length, truncated: list.length > limit };
}

const BLINDSPOTS = [
  '运行时动态信号名（变量拼接/字典查找 emit_signal）静态不可见',
  'autoload 单例之间的代码连接可见于 .gd 扫描，但 autoload 加载顺序问题不在本工具范围',
  'instanced 子场景的 [connection] 声明归属子场景文件本身（按文件枚举已覆盖）',
];

function normalizeResPath(root: string, p: string): string {
  if (p.startsWith('res://')) return p;
  const abs = isAbsolute(p) ? p : join(root, p);
  return toResPath(root, abs);
}

// ─── signal_map ──────────────────────────────────────────────────────────────

function signalMap(args: Record<string, unknown>): ToolResult {
  const projectPath = requireProjectPath(args);
  const signal = typeof args.signal === 'string' && args.signal ? args.signal : undefined;
  const sceneFilter = typeof args.scene === 'string' && args.scene ? args.scene : undefined;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 1000) : DEFAULT_LIMIT;

  const scan = scanProject(projectPath);

  const connections: Array<Connection & { scene: string }> = [];
  for (const s of scan.scenes) {
    if (sceneFilter && !s.scenePath.includes(sceneFilter)) continue;
    if (!s.parsed) continue;
    for (const c of s.parsed.connections) {
      if (signal && c.signal !== signal) continue;
      connections.push({ ...c, scene: s.scenePath });
    }
  }
  const codeRefs = collectCodeRefs(scan, signal);

  const connT = truncate(connections, limit);
  const refsT = truncate(codeRefs, limit);

  return opsSuccessText({
    stats: {
      ...scan.stats,
      matched_connections: connT.total,
      matched_code_refs: refsT.total,
    },
    filters: { signal: signal ?? null, scene: sceneFilter ?? null },
    // 两来源分开：editor = .tscn [connection] 声明；code = .gd 文本扫描
    connections: connT.items,
    connections_truncated: connT.truncated,
    code_refs: refsT.items.map(r => ({ script: r.script, kind: r.kind, signal: r.signal, line: r.line, snippet: r.snippet })),
    code_refs_truncated: refsT.truncated,
    blindspots: BLINDSPOTS,
  });
}

// ─── impact_check ────────────────────────────────────────────────────────────

function impactCheck(args: Record<string, unknown>): ToolResult {
  const projectPath = requireProjectPath(args);
  const signal = typeof args.signal === 'string' && args.signal ? args.signal : undefined;
  const scriptPath = typeof args.script_path === 'string' && args.script_path ? args.script_path : undefined;
  const scenePath = typeof args.scene_path === 'string' && args.scene_path ? args.scene_path : undefined;

  const targets = [signal, scriptPath, scenePath].filter(Boolean);
  if (targets.length === 0) {
    return opsErrorResult('INVALID_PARAMS', 'impact_check 需要 signal / script_path / scene_path 三选一');
  }
  if (targets.length > 1) {
    return opsErrorResult('INVALID_PARAMS', `impact_check 一次只评估一个目标（收到 ${targets.length} 个）`);
  }

  const scan = scanProject(projectPath);
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 1000) : DEFAULT_LIMIT;

  if (signal) return impactOfSignal(scan, signal, limit);
  if (scriptPath) return impactOfScript(scan, normalizeResPath(projectPath, scriptPath), limit);
  return impactOfScene(scan, normalizeResPath(projectPath, scenePath!), limit);
}

function impactOfSignal(scan: ProjectScan, signal: string, limit: number): ToolResult {
  const conns: Array<Connection & { scene: string }> = [];
  for (const s of scan.scenes) {
    if (!s.parsed) continue;
    for (const c of s.parsed.connections) {
      if (c.signal === signal) conns.push({ ...c, scene: s.scenePath });
    }
  }
  const refs = collectCodeRefs(scan, signal);
  const emitters = refs.filter(r => r.kind === 'emit');
  const listeners = refs.filter(r => r.kind === 'connect');
  const disconnects = refs.filter(r => r.kind === 'disconnect');

  const affectedScenes = [...new Set(conns.map(c => c.scene))];
  const affectedScripts = [...new Set(refs.map(r => r.script))];

  return opsSuccessText({
    target: { kind: 'signal', name: signal },
    summary: {
      editor_connections: conns.length,
      emitters: emitters.length,
      listeners: listeners.length,
      disconnects: disconnects.length,
      affected_scenes: affectedScenes.length,
      affected_scripts: affectedScripts.length,
    },
    editor_connections: truncate(conns, limit).items,
    emitters: truncate(emitters, limit).items.map(r => ({ script: r.script, line: r.line, snippet: r.snippet })),
    listeners: truncate(listeners, limit).items.map(r => ({ script: r.script, line: r.line, snippet: r.snippet })),
    disconnects: truncate(disconnects, limit).items.map(r => ({ script: r.script, line: r.line, snippet: r.snippet })),
    affected_scenes: affectedScenes,
    affected_scripts: affectedScripts,
    hint: conns.length + listeners.length === 0
      ? `未发现 "${signal}" 的任何连接方/监听方——改名或删除前仍建议 grep signal 名复核（可能经动态名连接）`
      : `"${signal}" 有 ${conns.length} 处编辑器连接 + ${listeners.length} 处代码监听，修改签名/重命名前先同步这些调用方`,
    blindspots: BLINDSPOTS,
  });
}

function impactOfScript(scan: ProjectScan, scriptRes: string, limit: number): ToolResult {
  // 1) 哪些场景以 ExtResource 引用此脚本（直接绑定或 preload）
  const referencingScenes: Array<{ scene: string; node_bindings: string[] }> = [];
  for (const s of scan.scenes) {
    if (!s.parsed) continue;
    const hasExt = s.parsed.extResources.some(e => e.path === scriptRes);
    if (!hasExt) continue;
    const bindings = sceneScriptBindings(s.parsed)
      .filter(b => b.scriptPath === scriptRes)
      .map(b => b.nodePath);
    referencingScenes.push({ scene: s.scenePath, node_bindings: bindings });
  }
  // 2) 哪些脚本文本引用此路径（preload/load/类型提示）
  const textRefs: Array<{ script: string; line: number; snippet: string }> = [];
  const needle = scriptRes;
  for (const res of scan.scripts) {
    if (res === scriptRes) continue;
    let code: string;
    try {
      code = readFileSync(join(scan.root, res.replace(/^res:\/\//, '')), 'utf-8');
    } catch {
      continue;
    }
    code.split(/\r?\n/).forEach((line, i) => {
      if (line.includes(needle) && !line.trimStart().startsWith('#')) {
        textRefs.push({ script: res, line: i + 1, snippet: line.trim().slice(0, 160) });
      }
    });
  }

  const t = truncate(textRefs, limit);
  return opsSuccessText({
    target: { kind: 'script', path: scriptRes },
    summary: {
      referencing_scenes: referencingScenes.length,
      node_bindings: referencingScenes.reduce((n, s) => n + s.node_bindings.length, 0),
      text_refs: t.total,
    },
    referencing_scenes: referencingScenes,
    text_refs: t.items,
    text_refs_truncated: t.truncated,
    hint: referencingScenes.length === 0 && t.total === 0
      ? `未发现引用 ${scriptRes} 的场景/脚本——可安全删除（建议再 grep 文件名复核非 res:// 形态引用）`
      : `${scriptRes} 被 ${referencingScenes.length} 个场景引用 + ${t.total} 处脚本文本引用，重命名/移动需同步`,
  });
}

function impactOfScene(scan: ProjectScan, sceneRes: string, limit: number): ToolResult {
  const scene = scan.scenes.find(s => s.scenePath === sceneRes);
  if (!scene) {
    return opsErrorResult('SCENE_NOT_FOUND', `场景不在扫描结果中: ${sceneRes}（解析失败也算不在——见 stats.parseErrors）`);
  }
  if (!scene.parsed) {
    return opsErrorResult('PARSE_ERROR', `场景解析失败: ${sceneRes}: ${scene.parseError}`);
  }
  const connections = scene.parsed.connections;
  const scripts = sceneScriptBindings(scene.parsed);
  // 谁实例化了这个场景（其他场景的 ext_resource type=PackedScene path=此场景）
  const instancedBy = scan.scenes
    .filter(s => s.parsed && s.scenePath !== sceneRes && s.parsed.extResources.some(e => e.path === sceneRes))
    .map(s => s.scenePath);

  return opsSuccessText({
    target: { kind: 'scene', path: sceneRes },
    summary: {
      nodes: scene.parsed.nodes.length,
      connections: connections.length,
      script_bindings: scripts.length,
      instanced_by: instancedBy.length,
    },
    connections: truncate(connections, limit).items,
    script_bindings: truncate(scripts, limit).items,
    instanced_by: instancedBy,
    hint: instancedBy.length > 0
      ? `${sceneRes} 被 ${instancedBy.length} 个场景实例化——改其内部节点名/结构会级联影响实例方`
      : `${sceneRes} 无实例化方，结构调整影响面限本场景`,
    blindspots: BLINDSPOTS,
  });
}

function opsSuccessText(data: unknown): ToolResult {
  return textResult(JSON.stringify(opsSuccess(data)));
}
