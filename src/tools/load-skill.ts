import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult, getErrorMessage } from '../types.js';
import { searchSkills } from './load-skill-search.js';

const TOOL_NAMES = ['load_skill'] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'load_skill',
      description:
        '从本地知识库(GodotPrompter/gd-agentic 等)按关键词检索 SKILL.md。两级检索:name/description 高精度→全文 fallback;返回带来源标注(source/path)与 score;缺失库进 missing_libraries 不报错。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '检索关键词(必填)' },
          libraries: {
            type: 'array',
            items: { type: 'string' },
            description: '知识库目录绝对路径数组。省略时读 GODOT_SKILL_LIBRARIES 环境变量(逗号分隔)',
          },
          limit: { type: 'number', description: '返回上限(默认 10)' },
        },
        required: ['query'],
      },
    },
  ];
}

// B-3 (2026-08-14): 返回来源标记 — explicit(参数)与 env(管理员配置)区分:
// explicit 需过 ALLOWED_PROJECT_PATHS 白名单(searchSkills 内检查),env 豁免。
// 二者互斥(explicit 存在则不用 env),来源对整次调用一致。
function resolveLibraries(args: Record<string, unknown>): { paths: string[]; fromEnv: boolean } {
  const explicit = args.libraries;
  if (Array.isArray(explicit)) return { paths: explicit.filter(s => typeof s === 'string'), fromEnv: false };
  const env = process.env.GODOT_SKILL_LIBRARIES;
  if (env) return { paths: env.split(',').map(s => s.trim()).filter(Boolean), fromEnv: true };
  return { paths: [], fromEnv: false };
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  const query = typeof args.query === 'string' ? args.query : '';
  if (!query || !String(query).trim()) {
    return errorResult('query is required');
  }

  const { paths: libraries, fromEnv } = resolveLibraries(args);
  if (libraries.length === 0) {
    return errorResult(
      'No skill libraries configured. Pass `libraries` (absolute paths) or set GODOT_SKILL_LIBRARIES env (comma-separated).'
    );
  }

  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10;

  try {
    const { matches, missing } = await searchSkills(libraries, String(query), limit, { fromEnv });
    const result: Record<string, unknown> = {
      total_matches: matches.length,
      matches,
      missing_libraries: missing,
    };
    if (missing.length > 0) {
      result.note = `${missing.length} library(ies) unavailable. Check missing_libraries for details.`;
    }
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return errorResult(`load_skill failed: ${getErrorMessage(err)}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  load_skill: { readonly: true, long_running: false },
}
