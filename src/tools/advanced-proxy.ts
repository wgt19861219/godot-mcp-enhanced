// src/tools/advanced-proxy.ts
/**
 * Advanced proxy — godot_advanced_tool + godot_list_dynamic_routes (Phase 3)
 *
 * Proxy tool that allows calling deactivated/advanced tools in slim mode,
 * and dynamic routing for tools that exist on the Godot side but aren't
 * registered on the MCP side.
 *
 * Belongs to the 'dynamic' group. Provides fuzzy matching suggestions for
 * invalid tool names, and structured dynamic routing for unknown godot_ tools.
 */
import type { Tool } from "@modelcontextprotocol/server";

// src/tools/advanced-proxy.ts
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, getErrorMessage, type ToolCallDelegate } from '../types.js';
import { opsError } from './shared.js';
import {
  isToolAllowed,
  getAllToolNames,
  getAllToolDefinitions,
  getActiveGroups,
} from '../core/tool-registry.js';
import { toolNameToRoute, isUnknownRouteResult } from '../core/dynamic-routes.js';
import { dynamicSchema } from '../core/dynamic-schema.js';
import { compactStringify } from '../core/response-format.js';
import {
  buildSummary,
  searchTools,
  listCategory,
  getToolSchema,
} from '../core/tool-discovery.js';

// ─── Delegate (set by ToolDispatcher to enable re-dispatch) ─────────────────

let _delegate: ToolCallDelegate | null = null;
let _dynamicSender: ((route: string, args: Record<string, unknown>) => Promise<ToolResult>) | null = null;

export function setToolCallDelegate(fn: ToolCallDelegate | null): void {
  _delegate = fn;
}

/** Inject HTTP sender for dynamic routing. Called by GodotServer during init. */
export function setDynamicSender(fn: ((route: string, args: Record<string, unknown>) => Promise<ToolResult>) | null): void {
  _dynamicSender = fn;
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────

/** Levenshtein distance for fuzzy matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

/** Get up to N closest tool names by edit distance. */
function suggestTools(input: string, candidates: string[], maxResults = 3): string[] {
  const scored = candidates.map(name => ({ name, dist: levenshtein(input.toLowerCase(), name.toLowerCase()) }));
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, maxResults).filter(s => s.dist <= Math.max(3, Math.floor(input.length / 2))).map(s => s.name);
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  // Build dynamic description listing currently deactivated tools
  const allNames = getAllToolNames();
  const deactivated = allNames.filter(name => !isToolAllowed(name) && name !== 'godot_advanced_tool');

  let desc = '高级/未激活 Godot 工具的代理调用。' +
    '调用形式 { tool_name: "<工具名>", arguments: {...} }。';

  if (deactivated.length > 0) {
    desc += `\n\n当前可代理的工具: ${deactivated.join(', ')}`;
  } else {
    desc += '\n\n当前所有工具均可直接调用,无需代理。';
  }

  return [
    {
      name: 'godot_advanced_tool',
      description: desc,
      inputSchema: {
        type: 'object' as const,
        properties: {
          tool_name: {
            type: 'string',
            description: '要调用的目标工具名',
          },
          arguments: {
            type: 'object',
            description: '传给目标工具的参数',
          },
        },
        required: ['tool_name'],
      },
    },
    {
      name: 'godot_list_dynamic_routes',
      description: '三级 lazy discovery:查询可用工具(静态注册 + 动态发现)。无参返回 category 计数;search 模糊匹配;category 查某类工具清单;tool 查单工具完整 schema。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            description: '类别名 → 返回该类工具清单(brief + 参数名,lean 视图)。配合 includeSchemas=true 可一次性返回完整 schema。',
          },
          search: {
            type: 'string',
            description: '关键词(空格分隔),全部命中才匹配;名字命中排名优先。上限 20 条,不带 schema。',
          },
          tool: {
            type: 'string',
            description: '工具名 → 返回单工具完整 schema(优先级最高,覆盖 search/category)。',
          },
          includeSchemas: {
            type: 'boolean',
            description: '配合 category 使用:一次性返回该类所有工具的完整 schema(体积大,慎用)。',
          },
        },
      },
    },
  ];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  // Route: godot_list_dynamic_routes
  if (toolName === 'godot_list_dynamic_routes') {
    return await handleListDynamicRoutes(args);
  }

  // Route: godot_advanced_tool
  if (toolName !== 'godot_advanced_tool') return null;

  const targetTool = args.tool_name as string | undefined;
  if (!targetTool || typeof targetTool !== 'string') {
    return textResult(JSON.stringify(opsError('MISSING_TOOL_NAME', 'tool_name is required')));
  }

  // Security gate: reject non-godot_ prefixed tools in dynamic path
  const hasGodotPrefix = targetTool.startsWith('godot_');

  // Reject if the tool is already directly available
  if (isToolAllowed(targetTool)) {
    return textResult(JSON.stringify(opsError('TOOL_ALREADY_AVAILABLE',
      `Tool "${targetTool}" is already directly available. Call it directly instead of through the proxy.`)));
  }

  // Check if tool exists in the registry
  const allNames = getAllToolNames();
  if (allNames.includes(targetTool)) {
    // Tool is known but deactivated — delegate the call
    return delegateCall(targetTool, args);
  }

  // ── Dynamic fallback: tool not in registry ─────────────────────────────────
  // Only allow dynamic routing for godot_-prefixed tools
  if (!hasGodotPrefix) {
    const suggestions = suggestTools(targetTool, allNames);
    return textResult(JSON.stringify({
      success: false,
      error_code: 'UNKNOWN_TOOL',
      message: `Unknown tool '${targetTool}'.`,
      suggestions,
    }));
  }

  // Check if 'dynamic' group is active
  const activeGroups = getActiveGroups();
  if (!activeGroups.has('dynamic')) {
    return textResult(JSON.stringify(opsError('DYNAMIC_GROUP_INACTIVE',
      `Dynamic routing is not enabled. The 'dynamic' tool group is not active in the current profile.`)));
  }

  // Derive route from tool name
  const route = toolNameToRoute(targetTool);
  if (!route) {
    return textResult(JSON.stringify(opsError('INVALID_DYNAMIC_TOOL_NAME',
      `Cannot derive route from '${targetTool}'. Tool name must follow 'godot_<category>_<action>' convention.`)));
  }

  // Execute the dynamic route via injected HTTP sender
  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
  const toolArgsBytes = Buffer.byteLength(JSON.stringify(toolArgs), 'utf-8');
  if (toolArgsBytes > 256 * 1024) {
    return textResult(JSON.stringify(opsError('INVALID_PARAMS', `toolArgs too large (${toolArgsBytes} > 256KB), refuse to proxy`)));
  }
  // P1-3 (2026-07-06 RCE 审查): 动态路由不重入 ReadOnlyGuard(advanced-proxy 自身 readonly=true 直接放行)。
  // 只读模式下拒绝动态路由:目标 godot_* 工具未注册,deny-by-default 与 ReadOnlyGuard.check 一致。
  // delegateCall 路径不受影响(它重入 handleCall 跑 guard)。
  if (process.env.GODOT_MCP_READ_ONLY === 'true') {
    return textResult(JSON.stringify(opsError('READ_ONLY',
      `Dynamic routing blocked in read-only mode (GODOT_MCP_READ_ONLY=true). Tool '${targetTool}' is not a registered read-only tool.`)));
  }

  const sender = _dynamicSender;
  if (!sender) {
    return textResult(JSON.stringify(opsError('NO_DYNAMIC_SENDER',
      'Dynamic routing sender not configured. Multi-instance mode may not be enabled.')));
  }

  try {
    return await sender(route, toolArgs);
  } catch (err) {
    // Phase 1(对标 unity tool-tiers.js:498-503):unknown-route 时附加 did-you-mean 建议,
    // 区分"路由不存在"(工具名拼错,建议相近的)和"路由存在但执行失败"(不该建议)。
    if (isUnknownRouteResult(err)) {
      const suggestions = suggestTools(targetTool, getAllToolNames());
      if (suggestions.length > 0) {
        return textResult(compactStringify({
          ...opsError('UNKNOWN_ROUTE', getErrorMessage(err)),
          hint: `Did you mean: ${suggestions.join(', ')}?`,
        }));
      }
    }
    return textResult(compactStringify(opsError('DYNAMIC_ROUTE_ERROR', getErrorMessage(err))));
  }
}

// ─── Delegate helper ────────────────────────────────────────────────────────

/** Delegate a call to the target tool via the registered delegate. */
async function delegateCall(targetTool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const delegate = _delegate;
  if (!delegate) {
    return textResult(JSON.stringify(opsError('NO_DELEGATE', 'Proxy delegate not configured')));
  }

  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
  const toolArgsBytes = Buffer.byteLength(JSON.stringify(toolArgs), 'utf-8');
  if (toolArgsBytes > 256 * 1024) {
    return textResult(JSON.stringify(opsError('INVALID_PARAMS', `toolArgs too large (${toolArgsBytes} > 256KB), refuse to proxy`)));
  }
  try {
    return await delegate(targetTool, toolArgs) as ToolResult;
  } catch (err) {
    return textResult(JSON.stringify(opsError('PROXY_ERROR', getErrorMessage(err))));
  }
}

// ─── godot_list_dynamic_routes handler ──────────────────────────────────────

/** Handle godot_list_dynamic_routes: 三级 lazy discovery(Phase 1,对标 unity tool-tiers.js)。
 *
 * 三级协议(优先级 tool > search > category > 无参):
 *   Level 1  无参        → category 计数(summary)+ 向后兼容旧字段
 *   Level 2a search=kw   → 模糊匹配 + 排序,上限 20(不带 schema)
 *   Level 2b category=N  → 该类工具清单 + brief + 参数名(lean);includeSchemas=true 给完整
 *   Level 3  tool=name   → 单工具完整 schema(找不到给 did-you-mean)
 *
 * 向后兼容:无参时保留旧字段(total_registered/registered/total_dynamic/dynamic/dynamic_*),
 * 追加 categories/totalTools/hint,已有客户端/测试不断裂。
 */
async function handleListDynamicRoutes(args: Record<string, unknown>): Promise<ToolResult> {
  let staticDefs = getAllToolDefinitions();
  // Fallback:测试环境或模块未加载时 getAllToolDefinitions() 返空,
  // 用 getAllToolNames() 构造最小定义(只有 name),保证三级 discovery 仍可用。
  if (staticDefs.length === 0) {
    staticDefs = getAllToolNames().map((name) => ({
      name,
      description: '',
      inputSchema: { type: 'object' as const, properties: {} },
    }));
  }
  // CMP-16-B: 拉真实动态工具(live schema,带缓存;editor 离线返空)
  const dynamicDefs = await dynamicSchema.getDynamicTools();
  const dynamicNames = new Set(dynamicDefs.map((t) => t.name));
  const all = [...staticDefs, ...dynamicDefs];

  // Level 3:tool=name → 单工具完整 schema(优先级最高)
  if (typeof args.tool === 'string' && args.tool.length > 0) {
    const schema = getToolSchema(args.tool, all);
    if (schema) {
      return textResult(compactStringify(schema));
    }
    // 找不到 → did-you-mean(复用现有 suggestTools)
    const suggestions = suggestTools(args.tool, all.map((t) => t.name));
    return textResult(compactStringify({
      success: false,
      error: `Unknown tool "${args.tool}".`,
      error_code: 'UNKNOWN_TOOL',
      ...(suggestions.length > 0 ? { hint: `Did you mean: ${suggestions.join(', ')}?` } : {}),
    }));
  }

  // Level 2a:search=keywords → 模糊匹配 + 排序(上限 20)
  if (typeof args.search === 'string' && args.search.length > 0) {
    const result = searchTools(args.search, all, {
      category: typeof args.category === 'string' ? args.category : undefined,
      dynamicNames,
    });
    return textResult(compactStringify(result));
  }

  // Level 2b:category=name → 该类工具清单(lean 或 includeSchemas)
  if (typeof args.category === 'string' && args.category.length > 0) {
    const result = listCategory(
      args.category,
      all,
      args.includeSchemas === true,
    );
    return textResult(compactStringify(result));
  }

  // Level 1:无参 → category 计数(summary)+ 向后兼容旧字段
  const summary = buildSummary(staticDefs, dynamicDefs);
  return textResult(compactStringify({
    // ── 新字段(三级 discovery)──
    ...summary,
    // ── 向后兼容旧字段(已有客户端/测试依赖)──
    success: true,
    total_registered: staticDefs.length,
    registered: staticDefs.map((t) => t.name),
    total_dynamic: dynamicDefs.length,
    dynamic: dynamicDefs.map((t) => t.name),
    dynamic_routing_enabled: getActiveGroups().has('dynamic'),
    dynamic_source: 'editor addon list_param_docs (CMP-16-A/B live schema)',
    hint: summary.hint + ' Static tools (registered) + dynamic tools (discovered at runtime). Use godot_advanced_tool with tool_name to call any tool.',
  }));
}

export const TOOL_META = {
  // Proxy itself doesn't write — readonly=true so it works in read-only mode.
  // Target tool's readonly check happens inside handleCall's middleware chain.
  godot_advanced_tool: { readonly: true, long_running: true },
  godot_list_dynamic_routes: { readonly: true, long_running: false },
};
