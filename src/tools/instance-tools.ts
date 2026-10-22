// src/tools/instance-tools.ts
/**
 * Instance tools — godot_list_instances + godot_select_instance (Phase 2b)
 *
 * Tools for discovering and selecting Godot instances in multi-instance mode.
 * Belongs to the 'multi_instance' group. Only available when GODOT_MCP_MULTI_INSTANCE=true.
 */
import type { Tool } from "@modelcontextprotocol/server";

// src/tools/instance-tools.ts
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, structuredResult, getErrorMessage } from '../types.js';
import { opsSuccess, opsError } from './shared.js';
import type { InstanceManager } from '../core/instance-manager.js';
import type { InstanceRouter } from '../core/instance-router.js';

// ─── Module-level state (set by GodotServer during initialization) ──────────

let _manager: InstanceManager | null = null;
let _router: InstanceRouter | null = null;

export function setInstanceManager(manager: InstanceManager | null): void {
  _manager = manager;
}

export function setInstanceRouter(router: InstanceRouter | null): void {
  _router = router;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'godot_list_instances',
      description: '列出所有发现的 Godot 实例（id/项目/端口/状态）。需要 GODOT_MCP_MULTI_INSTANCE=true。',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      // B4 (2026-10-19): typed outputs 试点(单形态 JSON 工具,工具级 schema 可如实声明)
      outputSchema: {
        type: 'object' as const,
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              instances: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    projectPath: { type: 'string' },
                    projectName: { type: ['string', 'null'] },
                    port: { type: 'number' },
                    status: { type: 'string' },
                    godotVersion: { type: ['string', 'null'] },
                  },
                  required: ['id', 'projectPath', 'port', 'status'],
                },
              },
              selectedInstanceId: { type: ['string', 'null'] },
              total: { type: 'number' },
            },
            required: ['instances', 'total'],
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['success', 'data'],
      },
    },
    {
      name: 'godot_select_instance',
      description: '选择 Godot 实例（id 或 project_path），后续调用路由到该实例。需要 GODOT_MCP_MULTI_INSTANCE=true。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          instance_id: {
            type: 'string',
            description: '实例 ID（从 godot_list_instances 获取）',
          },
          project_path: {
            type: 'string',
            description: '项目路径（二选一，优先 instance_id）',
          },
        },
        required: [],
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
  if (toolName === 'godot_list_instances') return handleListInstances();
  if (toolName === 'godot_select_instance') return handleSelectInstance(args);
  return null;
}

async function handleListInstances(): Promise<ToolResult> {
  if (!_manager) {
    return textResult(JSON.stringify(opsError('NOT_INITIALIZED', 'InstanceManager not initialized. Set GODOT_MCP_MULTI_INSTANCE=true.')));
  }

  const instances = await _manager.loadFromRegistry();
  const list = instances.map(inst => ({
    id: inst.id,
    projectPath: inst.projectPath,
    projectName: inst.projectName,
    port: inst.port,
    status: _manager!.getStatus(inst),
    godotVersion: inst.godotVersion,
  }));

  const selectedId = _router?.getSelectedId() ?? null;

  return structuredResult(opsSuccess({
    instances: list,
    selectedInstanceId: selectedId,
    total: list.length,
  }) as Record<string, unknown>);
}

async function handleSelectInstance(args: Record<string, unknown>): Promise<ToolResult> {
  if (!_router || !_manager) {
    return textResult(JSON.stringify(opsError('NOT_INITIALIZED', 'InstanceManager/Router not initialized. Set GODOT_MCP_MULTI_INSTANCE=true.')));
  }

  const instanceId = args.instance_id as string | undefined;
  const projectPath = args.project_path as string | undefined;

  if (!instanceId && !projectPath) {
    return textResult(JSON.stringify(opsError('MISSING_PARAMS', 'instance_id or project_path is required')));
  }

  // Refresh instances before selection
  await _manager.loadFromRegistry();
  const instances = _manager.getAllInstances();

  let targetId = instanceId;

  // Fallback to project_path match
  if (!targetId && projectPath) {
    const match = instances.find(i => i.projectPath === projectPath);
    if (match) targetId = match.id;
  }

  if (!targetId || !instances.find(i => i.id === targetId)) {
    return textResult(JSON.stringify(opsError('INSTANCE_NOT_FOUND', `Instance not found: ${targetId ?? '<projectPath redacted>'}`)));
  }

  try {
    // IM-2: loadFromRegistry 刷新了 manager,但 router 的 instanceMap 不同步。
    // 同步 router 的实例列表,避免"列表看得见但选不中"。
    _router.updateInstances(_manager.getAllInstances());
    await _router.selectInstance(targetId);
    const instance = _manager.getInstance(targetId)!;
    return textResult(JSON.stringify(opsSuccess({
      selected: {
        id: instance.id,
        projectName: instance.projectName,
        port: instance.port,
      },
    })));
  } catch (err) {
    return textResult(JSON.stringify(opsError('SELECT_FAILED', getErrorMessage(err))));
  }
}

export const TOOL_META = {
  godot_list_instances: { readonly: true, long_running: false },
  godot_select_instance: { readonly: true, long_running: false },
};
