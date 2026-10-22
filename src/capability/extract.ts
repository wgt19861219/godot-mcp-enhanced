// src/capability/extract.ts
import { getAllToolDefinitions, getToolMeta, getGroupForTool, getActionRisks, TOOL_GROUPS, OFFLINE_TOOLS, type RiskLevel } from '../core/tool-registry.js';
import { deriveMcpHints } from '../module-loader.js';
import { isGuardedTool } from '../core/guard.js';
import { classifySecurityLevel, type ToolCapability } from './schema.js';
import { GROUP_SOURCE_FILES, scanDangerApi, findEditorCommandForTool } from './static-grep.js';

/**
 * trusted-nonread：标 'read' 但实际启进程/有副作用、项目有意信任不确认的 action。
 * 经人工核实 handler 确会 spawn Godot（见 task-8 Step 1）：
 * - validation.run_and_verify → validation.ts:231/560/607 spawnGodot（启 Godot headless 运行场景）
 * - validation.verify_delivery → delivery.ts:353/391/444 executeGdscript + batchValidateScripts（启 Godot 验证）
 * 其余 read action（查询/读取/短期控制）不是。
 */
const TRUSTED_NONREAD: Record<string, string[]> = {
  validation: ['run_and_verify', 'verify_delivery'],
};

/**
 * 提取全工具能力矩阵。须先调用 registerAllModules() 填充 registry。
 * projectRoot = 目标项目根（用于 grep src/tools 与 addons）。
 */
export function extractCapabilities(projectRoot: string): ToolCapability[] {
  // 预扫：每个 group 的主文件是否命中危险 API（group 级 danger-api 标注）
  const dangerGroups = new Set<string>();
  for (const [group, files] of Object.entries(GROUP_SOURCE_FILES)) {
    if (scanDangerApi(files, projectRoot).length > 0) dangerGroups.add(group);
  }

  const defs = getAllToolDefinitions();
  return defs.map(tool => {
    // R2-I-1: manage_tools 在 ALWAYS_ALLOWED 但不在 TOOL_GROUPS → 兜底归 core（语义：操作 tool-registry 内存状态，core 组 protected）。
    const group = getGroupForTool(tool.name) ?? (tool.name === 'manage_tools' ? 'core' : 'unknown');
    const meta = getToolMeta(tool.name);
    const readonly = meta?.readonly ?? false;
    const longRunning = meta?.long_running ?? false;
    const guarded = isGuardedTool(tool.name);

    // inputSchema 是未知形状的 JSON Schema，断言到所需字段子集（复用 middleware.ts:128 的模式，避免 any）。
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const requiredParams: string[] = Array.isArray(schema.required) ? schema.required : [];
    const propKeys = Object.keys(schema.properties ?? {});
    const optionalParams = propKeys.filter(k => !requiredParams.includes(k));

    const groupRequires = (TOOL_GROUPS[group]?.requires ?? []) as ('bridge' | 'editor' | 'headless')[];
    const offlineCapable = OFFLINE_TOOLS.has(tool.name);
    const dangerApiHit = dangerGroups.has(group);
    const editorCmd = findEditorCommandForTool(tool.name);

    // risk 四级分布：从 ToolMeta.actionRisks 聚合计数
    const actionRisks = getActionRisks(tool.name);
    let riskDistribution: Record<RiskLevel, number> | undefined;
    if (actionRisks) {
      const dist: Record<RiskLevel, number> = { read: 0, write: 0, destructive: 0, process: 0 };
      for (const r of Object.values(actionRisks)) dist[r]++;
      riskDistribution = dist;
    }
    const trustedNonRead = TRUSTED_NONREAD[tool.name];

    const descBytes = Buffer.byteLength(tool.description ?? '', 'utf8');
    // B4 (2026-10-19): outputSchema(typed outputs)同样进 tools/list 网络载荷,
    // 计入 schemaBytes——只数 inputSchema 会漏报增量(统计口径与真实载荷一致)。
    const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8')
      + (tool.outputSchema ? Buffer.byteLength(JSON.stringify(tool.outputSchema), 'utf8') : 0);

    // P1-2: annotations 单一真相源 —— 优先读 tool.annotations 最终值(injectTags 已派生+override),
    // 未走 injectTags 的 inline tool 降级到 deriveMcpHints 重算(防御性,保持与 tools/list 一致)。
    const rawHints = tool.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } | undefined;
    const annotations = rawHints && rawHints.readOnlyHint !== undefined && rawHints.destructiveHint !== undefined && rawHints.idempotentHint !== undefined
      ? { readOnlyHint: rawHints.readOnlyHint, destructiveHint: rawHints.destructiveHint, idempotentHint: rawHints.idempotentHint }
      : deriveMcpHints(actionRisks);

    return {
      name: tool.name,
      group,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as object,
      requiredParams,
      optionalParams,
      readonly,
      longRunning,
      guarded,
      securityLevel: classifySecurityLevel({ dangerApiHit, guarded }),
      riskDistribution,
      trustedNonRead,
      groupRequires,
      offlineCapable,
      needsGodot: !offlineCapable,
      needsEditor: groupRequires.includes('editor'),
      gdScriptImpl: {
        headless: { exists: false, path: null }, // 见 plan Scope：headless 运行时生成，无静态文件
        editor: { exists: editorCmd !== null, path: editorCmd },
      },
      relatedDefects: [], // M2 填充
      verification: { l1: 'extracted', l2: 'none', l3: 'unverified', lastRun: null },
      size: { descBytes, schemaBytes, totalBytes: descBytes + schemaBytes },
      annotations,
    } satisfies ToolCapability;
  });
}
