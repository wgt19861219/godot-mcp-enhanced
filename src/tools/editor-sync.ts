import type { Tool } from "@modelcontextprotocol/server";

// src/tools/editor-sync.ts — Editor real-time scene tree sync tools
import type { ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';

const TOOL_NAMES = ['editor'] as const;

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  editor: {
    readonly: false,
    long_running: false,
    // 该工具原不在 GUARDED 表中 → 所有 action 此前一律不确认 → 零行为改变要求全部标 'read'
    // （任何非 read 都会收紧确认，超出本次迁移范围；见 spec §4.1）
    actionRisks: {
      sync_start: 'read',
      sync_stop: 'read',
      get_scene_tree: 'read',
    },
  },
};

const EDITOR_NOT_CONNECTED = JSON.stringify({
  error: 'EDITOR_NOT_CONNECTED',
  message: '本工具需 editor 模式且编辑器插件已连接(WebSocket 9090)。替代方案:headless 模式用 scene 工具的 query_scene_tree。',
});

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'editor',
      description: '编辑器实时操作(需 editor 模式+插件连接)。sync_start=开启场景树监听, sync_stop=停止监听, get_scene_tree=取当前场景树快照。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: ['sync_start', 'sync_stop', 'get_scene_tree'],
            description: '操作类型。sync_start=开启监听, sync_stop=停止监听, get_scene_tree=取场景树快照',
          },
        },
        required: ['action'],
      },
    },
  ];
}



export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: unknown,
): Promise<ToolResult | null> {
  // Check if this is one of our tools
  const names: readonly string[] = TOOL_NAMES;
  if (!names.includes(name)) return null;

  // In headless mode, these tools return error (not silent failure)
  // In editor mode, EditorToolExecutor handles them directly, never reaching here
  return textResult(EDITOR_NOT_CONNECTED);
}
