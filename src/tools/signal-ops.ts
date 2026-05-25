import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape, validateIdentifier } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TOOL_NAMES = [
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
\tvar source = _mcp_get_node("${gdEscape(sourcePath)}")
\tvar target = _mcp_get_node("${gdEscape(targetPath)}")
\tif source == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(sourcePath)}")
\t\t_mcp_done()
\t\treturn
\tif target == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(targetPath)}")
\t\t_mcp_done()
\t\treturn
\tsource.connect("${gdEscape(signalName)}", Callable(target, "${gdEscape(methodName)}")${flagsArg})
\t_mcp_output("connected", {"source": "${gdEscape(sourcePath)}", "signal": "${gdEscape(signalName)}", "target": "${gdEscape(targetPath)}", "method": "${gdEscape(methodName)}"})
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
\tvar source = _mcp_get_node("${gdEscape(sourcePath)}")
\tvar target = _mcp_get_node("${gdEscape(targetPath)}")
\tif source == null or target == null:
\t\t_mcp_output("error", "Node not found")
\t\t_mcp_done()
\t\treturn
\tsource.disconnect("${gdEscape(signalName)}", Callable(target, "${gdEscape(methodName)}"))
\t_mcp_output("disconnected", {"source": "${gdEscape(sourcePath)}", "signal": "${gdEscape(signalName)}"})
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
      else if (typeof arg === 'string') { serialized.push(`"${gdEscape(arg)}"`); }
      else { throw new Error('signal_emit args only support basic types (string/number/bool/null)'); }
    }
    argsStr = ', ' + serialized.join(', ');
  }
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar source = _mcp_get_node("${gdEscape(sourcePath)}")
\tif source == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(sourcePath)}")
\t\t_mcp_done()
\t\treturn
\tsource.emit_signal("${gdEscape(signalName)}"${argsStr})
\t_mcp_output("emitted", {"source": "${gdEscape(sourcePath)}", "signal": "${gdEscape(signalName)}"})
\t_mcp_done()
`;
}

export function genSignalListScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
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
      name: 'signal_connect',
      description: `Connect a signal between two nodes. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          source_path: { type: 'string', description: '源节点路径（scene tree path，如 root/Player）' },
          signal_name: { type: 'string', description: '信号名称' },
          target_path: { type: 'string', description: '目标节点路径' },
          method_name: { type: 'string', description: '目标方法名称' },
          flags: { type: 'number', description: '连接标志（可选，默认 0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'source_path', 'signal_name', 'target_path', 'method_name'],
      },
    },
    {
      name: 'signal_disconnect',
      description: `Disconnect a signal between two nodes. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          source_path: { type: 'string', description: '源节点路径' },
          signal_name: { type: 'string', description: '信号名称' },
          target_path: { type: 'string', description: '目标节点路径' },
          method_name: { type: 'string', description: '目标方法名称' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'source_path', 'signal_name', 'target_path', 'method_name'],
      },
    },
    {
      name: 'signal_emit',
      description: `Emit a node signal. Args only support basic types (string/number/bool/null). ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          source_path: { type: 'string', description: '源节点路径' },
          signal_name: { type: 'string', description: '信号名称' },
          args: { type: 'array', description: '信号参数（仅 string/number/bool/null）', items: {} },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'source_path', 'signal_name'],
      },
    },
    {
      name: 'signal_list',
      description: `List available signals on a node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (name) {
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
        return null;
    }

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  signal_connect: { readonly: false, long_running: false },
  signal_disconnect: { readonly: false, long_running: false },
  signal_emit: { readonly: false, long_running: false },
  signal_list: { readonly: true, long_running: false },
};
