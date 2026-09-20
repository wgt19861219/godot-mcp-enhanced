/**
 * script 工具入口：MCP schema 定义 + action 路由。
 *
 * 各 action 实现拆分至 ./script/ 目录（2026-09-20 可维护性批7，纯机械搬迁零行为变更）：
 *   read.ts / write.ts / edit.ts / test-gen.ts / execute.ts / project-replace.ts
 * 跨 action 共享守卫（沙箱扫描/editor 写守卫/class_name import 重建）在 ./script/shared.ts。
 *
 * SECURITY WARNING: execute_gdscript 的 GDScript 有完整系统访问权限（FileAccess、
 * DirAccess、OS.execute = arbitrary shell）。scanGdscriptSandbox 提供黑名单以拦截误用，
 * 不是安全边界——正则无法穷尽间接/反射绕过。本地单用户 MCP 可接受；多用户或不可信
 * 输入场景用容器/VM 隔离 + GODOT_MCP_ALLOW_UNSAFE=false。
 */

import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { readScript } from './script/read.js';
import { writeScript } from './script/write.js';
import { editScript } from './script/edit.js';
import { generateTest, createTestScene } from './script/test-gen.js';
import { executeGdscriptAction } from './script/execute.js';
import { projectReplace } from './script/project-replace.js';

const ACTIONS = [
  'read_script',
  'write_script',
  'edit_script',
  'generate_test',
  'create_test_scene',
  'execute_gdscript',
  'project_replace',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'script',
      description: '脚本操作。读写: read_script, write_script。编辑: edit_script（行号/search_and_replace）。执行: execute_gdscript（⚠️ 沙箱仅防误操作，不可用于不可信输入；高安全场景 ALLOW_EXECUTE_GDSCRIPT=false 或容器隔离）。⚠️ write_script/edit_script 写 .gd 前也走沙箱扫描（与 execute_gdscript 同威胁面）。测试: generate_test, create_test_scene。批量替换: project_replace。💡 最佳实践:分步执行、每步验证,复杂逻辑拆小块用 read/edit_script 迭代。详细用法: help 工具。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。read_script=读, write_script=写, edit_script=编辑(行号/search_and_replace), execute_gdscript=执行, project_replace=全仓批量替换, generate_test/create_test_scene=测试生成',
          },
          script_path: { type: 'string', description: 'read_script 用绝对路径；write_script/edit_script/generate_test 用绝对或相对项目路径' },
          content: { type: 'string', description: 'write_script: GDScript 内容' },
          overwrite: { type: 'boolean', description: 'write_script: 覆盖已有文件（默认 false）', default: false },
          start_line: { type: 'number', description: 'edit_script: 替换起始行（1-based）' },
          end_line: { type: 'number', description: 'edit_script: 替换结束行（1-based，含）' },
          new_content: { type: 'string', description: 'edit_script: 替换内容' },
          indent_mode: {
            type: 'string',
            enum: ['raw', 'smart'],
            description: 'edit_script: 缩进模式（默认 raw）',
            default: 'raw',
          },
          verify_content: { type: 'string', description: 'edit_script: 期望内容守卫（不匹配则中止）' },
          auto_validate: {
            type: 'boolean',
            description: 'edit_script: 自动验证语法并在失败时回滚（默认 true）',
            default: true,
          },
          search_and_replace: {
            type: 'object',
            description: 'edit_script: 内容搜索替换模式（提供时忽略 start_line/end_line）',
            properties: {
              search: { type: 'string', description: '搜索文本（CRLF 归一化匹配）' },
              replace: { type: 'string', description: '替换文本' },
              occurrence: { type: 'number', description: '替换第几次出现（1-based，0=全部）' },
            },
            required: ['search', 'replace'],
          },
          code: { type: 'string', description: 'execute_gdscript: 要执行的 GDScript 代码' },
          timeout: { type: 'number', description: 'execute_gdscript: 超时秒数（默认 30）', default: 30 },
          load_autoloads: { type: 'boolean', description: 'execute_gdscript: 省略时自动检测 autoload 引用；显式 true/false 覆盖自动检测' },
          search: { type: 'string', description: 'project_replace: 搜索文本' },
          replace: { type: 'string', description: 'project_replace: 替换文本' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 文件扩展名（默认 [".gd"]）',
            default: ['.gd'],
          },
          exclude_dirs: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 排除目录（默认 [".godot", ".import"]）',
            default: ['.godot', '.import'],
          },
          dry_run: { type: 'boolean', description: 'project_replace: 仅预览不写入（默认 false）', default: false },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler（action 路由） ────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'script') return null;

  const action = args.action as string;

  switch (action) {
    case 'read_script':
      return readScript(args);
    case 'write_script':
      return writeScript(args, ctx);
    case 'edit_script':
      return editScript(args, ctx);
    case 'generate_test':
      return generateTest(args);
    case 'create_test_scene':
      return createTestScene(args);
    case 'execute_gdscript':
      return executeGdscriptAction(args, ctx);
    case 'project_replace':
      return projectReplace(args);
    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  script: {
    readonly: false,
    long_running: false,
    actionRisks: {
      read_script: 'read', write_script: 'write', edit_script: 'write',
      generate_test: 'write', create_test_scene: 'write',
      execute_gdscript: 'process', project_replace: 'destructive',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
