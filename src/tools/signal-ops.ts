import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { normalizeNodePath, gdEscape, escapeForGdLiteral, validateIdentifier } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, runOpsScript } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ACTIONS = [
  'signal_connect',
  'signal_disconnect',
  'signal_emit',
  'signal_list',
] as const;

// ─── GDScript Generators: Signals ──────────────────────────────────────────

export function genSignalConnectScript(
  sourcePath: string, signalName: string,
  targetPath: string, methodName: string, flags?: number
): string {
  const flagsArg = flags !== undefined ? `, ${flags}` : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar source = _mcp_get_node("${escapeForGdLiteral(sourcePath)}")
\tvar target = _mcp_get_node("${escapeForGdLiteral(targetPath)}")
\tif source == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(sourcePath)}")
\t\t_mcp_done()
\t\treturn
\tif target == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(targetPath)}")
\t\t_mcp_done()
\t\treturn
\tsource.connect("${gdEscape(signalName)}", Callable(target, "${gdEscape(methodName)}")${flagsArg})
\t_mcp_output("connected", {"source": "${escapeForGdLiteral(sourcePath)}", "signal": "${gdEscape(signalName)}", "target": "${escapeForGdLiteral(targetPath)}", "method": "${gdEscape(methodName)}"})
\t_mcp_done()
`;
}

export function genSignalDisconnectScript(
  sourcePath: string, signalName: string,
  targetPath: string, methodName: string
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar source = _mcp_get_node("${escapeForGdLiteral(sourcePath)}")
\tvar target = _mcp_get_node("${escapeForGdLiteral(targetPath)}")
\tif source == null or target == null:
\t\t_mcp_output("error", "Node not found")
\t\t_mcp_done()
\t\treturn
\tsource.disconnect("${gdEscape(signalName)}", Callable(target, "${gdEscape(methodName)}"))
\t_mcp_output("disconnected", {"source": "${escapeForGdLiteral(sourcePath)}", "signal": "${gdEscape(signalName)}"})
\t_mcp_done()
`;
}

export function genSignalEmitScript(
  sourcePath: string, signalName: string, args?: unknown[]
): string {
  let argsStr = '';
  if (args && args.length > 0) {
    const serialized: string[] = [];
    for (const arg of args) {
      if (arg === null || arg === undefined) { serialized.push('null'); }
      else if (typeof arg === 'number') { serialized.push(String(arg)); }
      else if (typeof arg === 'boolean') { serialized.push(String(arg)); }
      // T2c (debt-cleanup-20260818): emit args 是任意用户字符串,消费点是
      // emit_signal("...", "...") 的字面量实参(纯值传递,不参与 % 格式化),
      // % 需原样;gdEscape 双写致监听方收到 "a%%b"。
      else if (typeof arg === 'string') { serialized.push(`"${escapeForGdLiteral(arg)}"`); }
      else { throw new Error('signal_emit args only support basic types (string/number/bool/null)'); }
    }
    argsStr = ', ' + serialized.join(', ');
  }
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar source = _mcp_get_node("${escapeForGdLiteral(sourcePath)}")
\tif source == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(sourcePath)}")
\t\t_mcp_done()
\t\treturn
\tsource.emit_signal("${gdEscape(signalName)}"${argsStr})
\t_mcp_output("emitted", {"source": "${escapeForGdLiteral(sourcePath)}", "signal": "${gdEscape(signalName)}"})
\t_mcp_done()
`;
}

export function genSignalListScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar signals = node.get_signal_list()
\t_mcp_output("signals", signals)
\t_mcp_done()
`;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'signal',
      description: `信号操作。connect/disconnect: 连接/断开信号。emit: 发射信号（参数仅基本类型）。list: 列出节点可用信号。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型。signal_connect/signal_disconnect=连接/断开信号, signal_emit=发射信号, signal_list=列节点可用信号',
          },
          source_path: { type: 'string', description: 'connect/disconnect/emit: 源节点路径（如 root/Player）' },
          signal_name: { type: 'string', description: 'connect/disconnect/emit: 信号名称' },
          target_path: { type: 'string', description: 'connect/disconnect: 目标节点路径' },
          method_name: { type: 'string', description: 'connect/disconnect: 目标方法名称' },
          flags: { type: 'number', description: 'connect: 连接标志（可选，默认 0）' },
          args: { type: 'array', description: 'emit: 信号参数（仅 string/number/bool/null）', items: {} },
          node_path: { type: 'string', description: 'list: 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'signal') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
      case 'signal_connect': {
        const sourcePath = normalizeNodePath(args.source_path as string);
        const signalName = args.signal_name as string;
        const targetPath = normalizeNodePath(args.target_path as string);
        const methodName = args.method_name as string;
        const flags = args.flags as number | undefined;
        if (flags !== undefined && typeof flags !== 'number') return opsErrorResult('INVALID_SIGNAL', 'flags must be a number');
        if (!signalName || !methodName) return opsErrorResult('INVALID_SIGNAL', 'signal_name and method_name are required');
        try { validateIdentifier(signalName, 'signal_name'); } catch (e) { return opsErrorResult('INVALID_SIGNAL', (e as Error).message); }
        try { validateIdentifier(methodName, 'method_name'); } catch (e) { return opsErrorResult('INVALID_SIGNAL', (e as Error).message); }
        script = genSignalConnectScript(sourcePath, signalName, targetPath, methodName, flags);
        break;
      }
      case 'signal_disconnect': {
        const sourcePath = normalizeNodePath(args.source_path as string);
        const signalName = args.signal_name as string;
        const targetPath = normalizeNodePath(args.target_path as string);
        const methodName = args.method_name as string;
        if (!signalName || !methodName) return opsErrorResult('INVALID_SIGNAL', 'signal_name and method_name are required');
        try { validateIdentifier(signalName, 'signal_name'); } catch (e) { return opsErrorResult('INVALID_SIGNAL', (e as Error).message); }
        try { validateIdentifier(methodName, 'method_name'); } catch (e) { return opsErrorResult('INVALID_SIGNAL', (e as Error).message); }
        script = genSignalDisconnectScript(sourcePath, signalName, targetPath, methodName);
        break;
      }
      case 'signal_emit': {
        const sourcePath = normalizeNodePath(args.source_path as string);
        const signalName = args.signal_name as string;
        const signalArgs = args.args as unknown[] | undefined;
        if (!signalName) return opsErrorResult('INVALID_SIGNAL', 'signal_name is required');
        try { validateIdentifier(signalName, 'signal_name'); } catch (e) { return opsErrorResult('INVALID_SIGNAL', (e as Error).message); }
        try {
          script = genSignalEmitScript(sourcePath, signalName, signalArgs);
        } catch (e) {
          return opsErrorResult('INVALID_SIGNAL', (e as Error).message);
        }
        break;
      }
      case 'signal_list': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genSignalListScript(nodePath);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings: [], warnRuntimePersist: true, action });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  signal: {
    readonly: false,
    long_running: false,
    actionRisks: {
      signal_connect: 'read', signal_disconnect: 'read', signal_list: 'read', signal_emit: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
