import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── P2-12 phase 1: McpTestSuite runner (editor-only) ────────────────────────
//
// This tool runs AI-authored GDScript test suites (`extends McpTestSuite`)
// in the editor via the `test_run` / `test_manage` command_handler cases.
//
// Headless mode: both actions hard-return EDITOR_ONLY — the GD-side runner
// needs EditorInterface + EditorUndoRedoManager (unavailable headless). In
// editor mode GodotServer.ts dispatches to EditorToolExecutor BEFORE this
// module, so this handleTool path only fires in headless (same pattern as
// the deprecated test-framework.ts export_* actions).

const TOOL_NAMES = ['testing'] as const;
export { TOOL_NAMES };

const ACTIONS = ['run', 'manage'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'testing',
      description: [
        'McpTestSuite 测试框架（editor-only）：跑 AI 编写的 GDScript 测试套件（`extends McpTestSuite`，放 `res://tests/` 或 `addons/godot_mcp_server/testing/suites/`）。',
        'run: 发现并运行套件，返回 passed/failed/skipped/total/failures 结构化结果。',
        'manage: op="results_get" 取回上次运行的部分结果（超时/中断后用）。',
        '⚠️ P2-12 二期：async coroutine 执行，suite 内每 test 后让出主循环（heartbeat 照常 ping），支持长套件（总预算 290s，超时用 suite= 过滤分批）。',
        '⚠️ editor-only：headless 模式返回 EDITOR_ONLY。需 `GODOT_MCP_MODE=editor` 并安装 Godot 插件。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。run=执行测试套件, manage=管理(一期仅 results_get 查结果)',
          },
          // run params
          suite: {
            type: 'string',
            description: 'run: 套件名过滤（精确匹配 suite_name()，空=全部）',
          },
          test_name: {
            type: 'string',
            description: 'run: 测试方法名过滤（子串匹配，空=全部）',
          },
          exclude_test_name: {
            type: 'string',
            description: 'run: 排除测试方法（逗号分隔子串列表）',
          },
          verbose: {
            type: 'boolean',
            description: 'run/manage: 返回每条测试详情（默认只返回聚合 + failures）',
          },
          // manage params
          op: {
            type: 'string',
            enum: ['results_get'],
            description: 'manage: 操作类型（一期仅 results_get）',
          },
          project_path: {
            type: 'string',
            description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录；editor 模式可省略，用当前打开的项目）',
          },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'testing') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  // Both actions are editor-only: the GD-side runner needs EditorInterface +
  // EditorUndoRedoManager. In editor mode GodotServer dispatches to
  // EditorToolExecutor before reaching this module, so this branch only fires
  // in headless (same pattern as test-framework.ts:78-80 export_* actions).
  return opsErrorResult(
    'EDITOR_ONLY',
    `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin. ` +
      'McpTestSuite runner needs EditorInterface + EditorUndoRedoManager (unavailable headless).',
  );
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  testing: {
    readonly: true,
    long_running: true,
    actionRisks: {
      run: 'read',
      manage: 'read',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
