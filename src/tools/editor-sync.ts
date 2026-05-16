// src/tools/editor-sync.ts — Editor real-time scene tree sync tools
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../types.js';
import { textResult } from '../types.js';

const TOOL_NAMES = [
  'editor_sync_start',
  'editor_sync_stop',
  'editor_get_scene_tree',
] as const;

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  editor_sync_start: { readonly: false, long_running: false },
  editor_sync_stop: { readonly: false, long_running: false },
  editor_get_scene_tree: { readonly: true, long_running: false },
};

const EDITOR_NOT_CONNECTED = JSON.stringify({
  error: 'EDITOR_NOT_CONNECTED',
  message: 'These tools require editor mode with plugin connection. Use headless query_scene_tree as alternative.',
});

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'editor_sync_start',
      description: '启动场景树实时监听（仅编辑器模式）。插件连接 SceneTree 信号，推送 node_added/node_removed 事件。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'editor_sync_stop',
      description: '停止场景树监听，断开信号连接（仅编辑器模式）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'editor_get_scene_tree',
      description: '获取编辑器当前场景树完整快照（仅编辑器模式）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
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
