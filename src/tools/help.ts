// src/tools/help.ts — P0-6 Help 工具（on-demand 文档展开）
//
// agent 传 tool_name 获取完整工具文档（从 docs/tools/{name}.md 读取）。
// 拼写纠错：unknown tool_name 时返回 "Did you mean 'X'?" 提示。
// 目的：降低 tools/list 的 token 占用（工具描述可压缩为单行 + "Use help tool for full docs"）。

import type { ToolResult, ToolContext } from '../types.js';
import { textResult } from '../types.js';
import type { Tool } from '@modelcontextprotocol/server';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getAllToolNames } from '../core/tool-registry.js';

// ─── Tool name enum（从注册表动态构建，含 help 自身）────────────────────────
// P1-1(2026-08-21 七维度审核): 原为硬编码 38 名单,漏 analysis/audit/debug/engine/qa/
// translation/uid 7 个 2026-08 后新增工具,enum 直接拒绝其 help 调用。单一真相源改为
// metaRegistry(module-loader 注册全量后为 45);直接 import 本模块(未走组合根)时注册表
// 可能为空,降级为 ['help'] 自身。

function toolNameEnum(): string[] {
  const names = getAllToolNames();
  return names.length > 0 ? [...names].sort() : ['help'];
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  const names = toolNameEnum();
  return [
    {
      name: 'help',
      description: `查任意工具完整文档(用法/参数/action)。可用工具名:${names.join(', ')}。传 tool_name 取详情;拼写纠错自动提示最接近名。`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          tool_name: {
            type: 'string',
            enum: names,
            description: '要查询的工具名',
          },
        },
        required: ['tool_name'],
      },
    },
  ];
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META = {
  'help': {
    readonly: true,
    long_running: false,
    // P1-1 review Nit 2: 空 actionRisks 会让 deriveMcpHints 走 risks.length===0 分支得全 false,
    // 致 readonly 查询工具被标 idempotent=false(本应 true)。填 `_` 占位让 deriveMcpHints 走正常 read 分支。
    // 参考 get-context.ts:259 的 `_: 'read'` 模式。
    actionRisks: { _: 'read' as const },
  },
};

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'help') return null;
  const toolName = args.tool_name as string;
  if (!toolName) {
    return textResult(JSON.stringify({ error: 'tool_name is required', available: toolNameEnum() }));
  }

  // 读 docs/tools/{toolName}.md
  const here = dirname(fileURLToPath(import.meta.url));
  // 开发环境：src/tools/help.ts → ../../docs/tools/
  // 构建环境：build/tools/help.js → ../../docs/tools/（docs 不打包进 build，用 cwd 兜底）
  const candidates = [
    // 2026-08-06 审查 P3：加 path.basename 纵深防御（当前依赖 inputSchema enum 约束，
    // 但若未来 enum 放宽为自由 string，未 basename 则路径遍历立即暴露）
    join(here, '..', '..', 'docs', 'tools', `${basename(toolName)}.md`),
    join(process.cwd(), 'docs', 'tools', `${basename(toolName)}.md`),
    join(here, '..', '..', '..', 'docs', 'tools', `${basename(toolName)}.md`),
  ];

  for (const docPath of candidates) {
    if (existsSync(docPath)) {
      try {
        const content = readFileSync(docPath, 'utf-8');
        return textResult(content);
      } catch {
        // 读失败继续尝试下一个路径
      }
    }
  }

  // 文档不存在——返回拼写纠错
  const available = toolNameEnum();
  const suggestion = findClosestMatch(toolName, available);
  return textResult(JSON.stringify({
    error: `No documentation found for tool '${toolName}'`,
    suggestion: suggestion ? `Did you mean '${suggestion}'?` : undefined,
    available,
  }));
}

// ─── Levenshtein 拼写纠错 ───────────────────────────────────────────────────

/** 找编辑距离 ≤ 2 的最接近工具名 */
function findClosestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}
