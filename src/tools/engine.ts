import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── CMP-4 (2026-08-08): engine 组 — 实时 ClassDB 内省 (editor-only) ──────────
//
// 让 AI 发现运行中引擎的实际可用类/方法/属性/信号/枚举。
// 补静态 docs 工具(extension_api.json 4.7 快照)的缺口:
// - 第三方 addon 注册的 ClassDB 类不在静态 JSON 里
// - 4.6/4.8 build 的 API 差异不在 4.7 快照里
// - 自定义 C# / GDExtension 注册的类不在 JSON 里
//
// 心智模型:静态查 docs / 实时查 engine。docs 是离线快照(4.7),
// engine 是运行中引擎的真实 ClassDB(实际版本 + 第三方 addon + 自定义类)。
//
// Headless mode: 三个 action 硬返回 EDITOR_ONLY — ClassDB 在 gdscript-executor
// 沙箱里被列为危险模式(gdscript-executor.ts:83),实时内省走 editor 层直调(不经沙箱)。

const TOOL_NAMES = ['engine'] as const;
export { TOOL_NAMES };

const ACTIONS = ['class_info', 'search', 'get_inheritance', 'call_method'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'engine',
      description: [
        '实时 ClassDB 内省+节点方法调用(editor-only):查询运行中引擎的实际可用类/方法/属性/信号/枚举,或调用编辑器场景树节点的实例方法。',
        'class_info=类完整结构(默认 no_inherit=true 只看本类), search=substring 搜类名(上限 100,搜到后用 class_info 查详情), get_inheritance=继承链(到 Object)。',
        'call_method=调用节点实例方法:参数按声明类型自动强转,deny-list 默认挡危险方法(free/queue_free/set_script/call 等),env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE 只能追加(∪ 默认表),call 不可 undo。',
        '⚠️ 补 docs 工具缺口:docs 是静态 4.7 快照(不含第三方 addon/自定义类),engine 是运行中引擎真实 ClassDB。',
        '⚠️ editor-only:headless 模式返回 EDITOR_ONLY。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。class_info=类完整结构, search=substring 搜类名, get_inheritance=继承链, call_method=调用节点实例方法',
          },
          class: {
            type: 'string',
            description: 'class_info/get_inheritance: 类名（如 Node、Sprite2D、RigidBody3D，或第三方 addon 注册的类名）',
          },
          query: {
            type: 'string',
            description: 'search: substring 匹配类名（大小写不敏感）',
          },
          no_inherit: {
            type: 'boolean',
            description: 'class_info: true=只看本类 own 成员（默认，翻继承链会淹没新 API）；false=含继承链合并',
          },
          node_path: {
            type: 'string',
            description: 'call_method: 目标节点路径（如 "root/Player"、"Player/Sprite2D"，相对编辑器场景树根）',
          },
          method: {
            type: 'string',
            description: 'call_method: 要调用的方法名（方法不存在时返回 did-you-mean 建议；deny-list 默认挡 free/queue_free/set_script/call 等危险方法）',
          },
          args: {
            type: 'array',
            description: 'call_method: 位置参数数组（按方法声明类型自动强转，如 [1,2,3] 给 Vector3 参数）。最多 8 个参数',
            items: {},
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
  if (name !== 'engine') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  // All actions are editor-only: ClassDB introspection runs in the editor addon
  // (not through the sandboxed gdscript-executor where ClassDB is blocked).
  return opsErrorResult(
    'EDITOR_ONLY',
    `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin. ` +
      'ClassDB introspection runs in the editor addon (not the sandboxed executor).',
  );
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  engine: {
    // CMP-9-A 后含 call_method(write),组级不再是纯只读。readOnlyHint 由 deriveMcpHints 按 actionRisks 派生。
    readonly: false,
    long_running: false,
    actionRisks: {
      class_info: 'read',
      search: 'read',
      get_inheritance: 'read',
      call_method: 'write',  // CMP-9-A: 方法可能有副作用(deny-list 挡高危,但剩余方法非 readonly)
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
