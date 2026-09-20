import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { executeGdscriptTrusted } from '../gdscript-executor.js';
import { requireProjectPath } from '../core/args-validation.js';
import { SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult, gdEscape, escapeForGdLiteral } from './shared.js';

const TOOL_NAMES = ['test'] as const;

export { TOOL_NAMES };

const ACTIONS = ['assert', 'stress', 'export_list_presets', 'export_get_preset', 'export_build'] as const;

const VALID_ASSERTIONS = new Set(['node_exists', 'property_equals', 'signal_connected', 'node_count']);

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] test-framework module is absorbed into validation. Do not register directly.`);
  return [
    {
      name: 'test',
      description: 'Testing and export operations. assert: assert conditions on scene tree. stress: stress test node create/destroy for leak detection. export_list_presets/export_get_preset/export_build: export preset management (Editor mode only).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Action type',
          },
          // assert params
          assertion_type: {
            type: 'string',
            enum: ['node_exists', 'property_equals', 'signal_connected', 'node_count'],
            description: 'assert: Type of assertion to perform',
          },
          path: { type: 'string', description: 'assert: Node path (e.g. root/Player)' },
          property: { type: 'string', description: 'assert: Property name (for property_equals)' },
          expected: { description: 'assert: Expected value (for property_equals)' },
          signal: { type: 'string', description: 'assert: Signal name (for signal_connected)' },
          target: { type: 'string', description: 'assert: Target node path (for signal_connected)' },
          method: { type: 'string', description: 'assert: Target method name (for signal_connected)' },
          parent: { type: 'string', description: 'assert: Parent node path (for node_count)' },
          count: { type: 'number', description: 'assert: Expected child count (for node_count)' },
          // stress params
          node_type: { type: 'string', description: 'stress: Node type to create/destroy (default: Node)', default: 'Node' },
          iterations: { type: 'number', description: 'stress: Number of iterations (default: 100)', default: 100 },
          // export params
          name: { type: 'string', description: 'export_get_preset: Export preset name' },
          preset: { type: 'string', description: 'export_build: Export preset name' },
          output_path: { type: 'string', description: 'export_build: Output directory for the build' },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'test') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  try {
    // Export tools: Editor-only. In Editor mode, GodotServer.ts dispatches to editorExecutor
    // before reaching this module, so this path only fires in Headless mode.
    if (action === 'export_list_presets' || action === 'export_get_preset' || action === 'export_build') {
      return opsErrorResult('EDITOR_ONLY', `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.`);
    }

    // SEC-P2-1 (2026-08-09 审查): 用 requireProjectPath 替代裸 validatePath + 手写 typeof 检查。
    // validatePath=resolvePath 仅归一化路径零安全校验;requireProjectPath 内部已调 requireString
    // (project_path 非空字符串检查) + isPathInAllowedRoots deny-by-default root 白名单
    // (防 project_path 指向 ALLOWED_PROJECT_PATHS 外任意路径跑 GDScript 测试)。全局门
    // ToolDispatcher.validatePathArgs 已兜底,此处为防御纵深(消除对全局门的隐式依赖)。
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();

    switch (action) {
      case 'assert': return await handleTestAssert(args, godot, projectPath);
      case 'stress': return await handleTestStress(args, godot, projectPath);
      default: return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    return opsErrorResult('INVALID_PATH', err instanceof Error ? err.message : String(err));
  }
}

async function handleTestAssert(args: Record<string, unknown>, godot: string, projectPath: string): Promise<ToolResult> {
  const rawAssertionType = args.assertion_type as string;
  if (!VALID_ASSERTIONS.has(rawAssertionType)) {
    return opsErrorResult('INVALID_PARAMS', `Invalid assertion_type: "${rawAssertionType}". Must be one of: ${[...VALID_ASSERTIONS].join(', ')}`);
  }
  // node_count requires count parameter
  if (rawAssertionType === 'node_count' && typeof args.count !== 'number') {
    return opsErrorResult('INVALID_PARAMS', 'node_count assertion requires "count" parameter');
  }

  const assertionType = gdEscape(rawAssertionType);
  // Validate path parameter — required for node_exists, property_equals, signal_connected
  const rawPath = (args.path as string) || '';
  if (!rawPath && rawAssertionType !== 'node_count') {
    return opsErrorResult('INVALID_PARAMS', `"path" is required for ${rawAssertionType} assertion`);
  }
  // T2b (debt-cleanup-20260818): 路径类变体的 % 转义按消费点分流——
  // gdEscape(%→%%)只用于 % 格式串左侧;纯字符串字面量(_mcp_get_node 查找/错误消息/字典)
  // 与 % 格式串右侧数组参数(右侧不解析 % 转义)都需 % 原样(escapeForGdLiteral),
  // 否则 %HUD unique-name 查找失败/消息显示双写。
  // path:消费于 var _path 字面量赋值→各 match 分支 _mcp_get_node(_path) 查找、
  //   "Node not found: " + _path 消息拼接、"message": "%s..." % [... _path ...]
  //   格式串右侧数组——全部需 % 原样,整体切。
  const path = escapeForGdLiteral(rawPath);
  const property = gdEscape((args.property as string) || '');
  const signalName = gdEscape((args.signal as string) || '');
  // targetPath:消费于 signal_connected 分支 _mcp_get_node("${targetPath}")(纯字面量)、
  //   "Signal %s->%s..." % ["${targetPath}" ...] 格式串右侧数组——全部需 % 原样,整体切。
  const targetPath = escapeForGdLiteral((args.target as string) || '');
  const methodName = gdEscape((args.method as string) || '');
  // parentPath 是混合上下文,拆两份(不能整体切换):
  //   parentPathLit → node_count 分支 _mcp_get_node 查找 + "Parent node not found: ..."
  //                   错误消息(纯字面量,% 原样);
  //   parentPath    → "Children of ...: %d ..." % [...] 是 % 格式串左侧(必须 %% 双写,
  //                   格式化后还原为字面 %;用字面量版会把 %H 当格式符致 GDScript 报错)。
  const rawParent = (args.parent as string) || '';
  const parentPath = gdEscape(rawParent);
  const parentPathLit = escapeForGdLiteral(rawParent);
  const count = (args.count as number) ?? -1;

  // T2c (debt-cleanup-20260818): expected 是任意用户值,消费点(_match 比较右侧、
  // "%s.%s = %s (expected: %s)" % [...] 格式串右侧数组)均为值语义,% 原样——
  // gdEscape 双写致含 % 的 expected 断言恒错(_val "a%b" vs _expected "a%%b")。
  const script = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _root = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not available")
\t\t_mcp_done()
\t\treturn
\tvar _path = "${path}"
\tmatch "${assertionType}":
\t\t"node_exists":
\t\t\tvar _n = _mcp_get_node(_path)
\t\t\tif _n != null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": true, "message": "Node exists: " + _path}))
\t\t\telse:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Node not found: " + _path}))
\t\t"property_equals":
\t\t\tvar _n = _mcp_get_node(_path)
\t\t\tif _n == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Node not found: " + _path}))
\t\t\telse:
\t\t\t\tvar _prop = "${property}"
\t\t\t\tvar _val = str(_n.get(_prop))
\t\t\t\tvar _expected = str("${escapeForGdLiteral(String(args.expected))}")
\t\t\t\tvar _match = _val == _expected
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _match, "message": "%s.%s = %s (expected: %s)" % [_path, _prop, _val, _expected], "actual": _val}))
\t\t"signal_connected":
\t\t\tvar _src = _mcp_get_node(_path)
\t\t\tvar _tgt = _mcp_get_node("${targetPath}")
\t\t\tif _src == null or _tgt == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Source or target node not found"}))
\t\t\telse:
\t\t\t\tvar _connected = _src.is_connected("${signalName}", Callable(_tgt, "${methodName}"))
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _connected, "message": "Signal %s->%s.%s %s" % ["${signalName}", "${targetPath}", "${methodName}", "connected" if _connected else "not connected"]}))
\t\t"node_count":
\t\t\tvar _p = _mcp_get_node("${parentPathLit}") if "${parentPathLit}" != "" else _root
\t\t\tif _p == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Parent node not found: ${parentPathLit}"}))
\t\t\telse:
\t\t\t\tvar _count = _p.get_child_count()
\t\t\t\tvar _expected = ${count}
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _count == _expected, "message": "Children of ${parentPath}: %d (expected: %d)" % [_count, _expected], "actual": _count}))
\t\t_:
\t\t\t_mcp_output("error", "Unknown assertion type: ${assertionType}")
\t_mcp_done()
`;

  const result = await executeGdscriptTrusted({ godotPath: godot, projectPath, code: script, timeout: 30 });
  return parseGdscriptResult(result, [], (_msg) => 'ASSERTION_FAILED');
}

const STRESS_SAFE_TYPES = new Set([
  'Node', 'Node2D', 'Node3D', 'Control', 'CanvasItem',
  'CharacterBody2D', 'CharacterBody3D', 'RigidBody2D', 'RigidBody3D',
  'StaticBody2D', 'StaticBody3D', 'AnimatableBody2D', 'AnimatableBody3D',
  'Area2D', 'Area3D', 'PhysicsBody2D', 'PhysicsBody3D',
  'Sprite2D', 'Sprite3D', 'MeshInstance3D', 'Camera2D', 'Camera3D',
  'Label', 'Button', 'Panel', 'BoxContainer', 'HBoxContainer', 'VBoxContainer',
  'MarginContainer', 'ScrollContainer', 'GridContainer',
  'CollisionShape2D', 'CollisionShape3D', 'CollisionPolygon2D', 'CollisionPolygon3D',
  'AudioStreamPlayer', 'AudioStreamPlayer2D', 'AudioStreamPlayer3D',
  'Timer', 'Tween',
]);

async function handleTestStress(args: Record<string, unknown>, godot: string, projectPath: string): Promise<ToolResult> {
  const rawType = (args.node_type as string) || 'Node';
  if (!STRESS_SAFE_TYPES.has(rawType)) {
    return opsErrorResult('INVALID_NODE_TYPE', `node_type "${rawType}" not in stress test whitelist. Allowed: ${[...STRESS_SAFE_TYPES].join(', ')}`);
  }
  const nodeType = gdEscape(rawType);
  const iterations = Math.min(Math.max((args.iterations as number) || 100, 1), 10000);

  const script = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _root = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not available")
\t\t_mcp_done()
\t\treturn
\tvar _type = "${nodeType}"
\tvar _iters = ${iterations}
\tvar _obj_before = Performance.get_monitor(Performance.OBJECT_COUNT)
\tvar _mem_before = Performance.get_monitor(Performance.MEMORY_STATIC)
\tvar _peak = _mem_before
\tfor _i in range(_iters):
\t\tvar _n = ClassDB.instantiate(_type)
\t\tif _n == null:
\t\t\t_mcp_output("error", "Cannot instantiate: " + _type)
\t\t\t_mcp_done()
\t\t\treturn
\t\t_root.add_child(_n)
\t\tvar _mem = Performance.get_monitor(Performance.MEMORY_STATIC)
\t\tif _mem > _peak:
\t\t\t_peak = _mem
\t\t_n.queue_free()
\tfor _f in range(3):
\t\tawait self.process_frame
\tvar _obj_after = Performance.get_monitor(Performance.OBJECT_COUNT)
\tvar _mem_after = Performance.get_monitor(Performance.MEMORY_STATIC)
\tvar _obj_leaked = (_obj_after - _obj_before) > _iters * 0.1
\tvar _mem_leaked = _mem_after > _mem_before * 1.1
\tvar _leaked = _obj_leaked or _mem_leaked
\t_mcp_output("result", JSON.stringify({
\t\t"success": not _leaked,
\t\t"iterations": _iters,
\t\t"node_type": _type,
\t\t"object_count_before": _obj_before,
\t\t"object_count_after": _obj_after,
\t\t"memory_before": _mem_before,
\t\t"memory_after": _mem_after,
\t\t"peak_memory": _peak,
\t\t"leaked": _leaked,
\t\t"message": "Stress test %s: %d iterations, memory %s" % ["PASSED" if not _leaked else "LEAKED", _iters, "stable" if not _leaked else "increased"]
\t}))
\t_mcp_done()
`;

  const result = await executeGdscriptTrusted({ godotPath: godot, projectPath, code: script, timeout: 120 });
  return parseGdscriptResult(result, [], (_msg) => 'STRESS_TEST_FAILED');
}
export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  test: { readonly: true, long_running: false },
};

// ─── Re-export for validation.ts absorption ──────────────────────────────────

export async function handleTestAction(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  return handleTool('test', { ...args, action }, ctx);
}
