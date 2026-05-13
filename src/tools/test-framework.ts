import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { executeGdscript } from '../gdscript-executor.js';
import { validatePath } from '../helpers.js';
import { SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult } from './shared.js';
import { gdEscape } from './godot-ops.js';

const TOOL_NAMES = ['test_assert', 'test_stress', 'export_list_presets', 'export_get_preset', 'export_build'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'test_assert',
      description: 'Assert conditions on the Godot scene tree or runtime state. Supports: node_exists, property_equals, signal_connected, node_count.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          assertion_type: {
            type: 'string',
            enum: ['node_exists', 'property_equals', 'signal_connected', 'node_count'],
            description: 'Type of assertion to perform',
          },
          path: { type: 'string', description: 'Node path (e.g. root/Player)' },
          property: { type: 'string', description: 'Property name (for property_equals)' },
          expected: { description: 'Expected value (for property_equals)' },
          signal: { type: 'string', description: 'Signal name (for signal_connected)' },
          target: { type: 'string', description: 'Target node path (for signal_connected)' },
          method: { type: 'string', description: 'Target method name (for signal_connected)' },
          parent: { type: 'string', description: 'Parent node path (for node_count)' },
          count: { type: 'number', description: 'Expected child count (for node_count)' },
        },
        required: ['project_path', 'assertion_type'],
      },
    },
    {
      name: 'test_stress',
      description: 'Stress test: repeatedly create/destroy nodes to detect memory leaks. Returns iterations, peak memory, and leak status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          node_type: { type: 'string', description: 'Node type to create/destroy (default: Node)', default: 'Node' },
          iterations: { type: 'number', description: 'Number of iterations (default: 100)', default: 100 },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'export_list_presets',
      description: 'List export presets in the Godot project. Editor mode only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'export_get_preset',
      description: 'Get detailed configuration of an export preset. Sensitive fields (keystore, certificates) are sanitized. Editor mode only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          name: { type: 'string', description: 'Export preset name' },
        },
        required: ['project_path', 'name'],
      },
    },
    {
      name: 'export_build',
      description: 'Execute an export build. This is a long-running operation. Editor mode only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          preset: { type: 'string', description: 'Export preset name' },
          output_path: { type: 'string', description: 'Output directory for the build' },
        },
        required: ['project_path', 'preset'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    // Export tools are Editor-only, return error in Headless mode
    if (name === 'export_list_presets' || name === 'export_get_preset' || name === 'export_build') {
      return opsErrorResult('EDITOR_ONLY', `Tool "${name}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.`);
    }

    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();

    switch (name) {
      case 'test_assert': return await handleTestAssert(args, godot, projectPath);
      case 'test_stress': return await handleTestStress(args, godot, projectPath);
      default: return null;
    }
  } catch (err) {
    return opsErrorResult('INVALID_PATH', err instanceof Error ? err.message : String(err));
  }
}

async function handleTestAssert(args: Record<string, unknown>, godot: string, projectPath: string): Promise<ToolResult> {
  const assertionType = gdEscape(args.assertion_type as string);
  const path = gdEscape((args.path as string) || '');
  const property = gdEscape((args.property as string) || '');
  const expectedStr = JSON.stringify(args.expected);
  const signalName = gdEscape((args.signal as string) || '');
  const targetPath = gdEscape((args.target as string) || '');
  const methodName = gdEscape((args.method as string) || '');
  const parentPath = gdEscape((args.parent as string) || '');
  const count = (args.count as number) ?? -1;

  const script = `${SCENE_TREE_HEADER}

func _init():
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
\t\t\t\tvar _val = var_to_str(_n.get(_prop))
\t\t\t\tvar _expected = "${gdEscape(expectedStr)}"
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
\t\t\tvar _p = _mcp_get_node("${parentPath}") if "${parentPath}" != "" else _root
\t\t\tif _p == null:
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": false, "message": "Parent node not found: ${parentPath}"}))
\t\t\telse:
\t\t\t\tvar _count = _p.get_child_count()
\t\t\t\tvar _expected = ${count}
\t\t\t\t_mcp_output("result", JSON.stringify({"passed": _count == _expected, "message": "Children of ${parentPath}: %d (expected: %d)" % [_count, _expected], "actual": _count}))
\t\t_:
\t\t\t_mcp_output("error", "Unknown assertion type: ${assertionType}")
\t_mcp_done()
`;

  const result = await executeGdscript({ godotPath: godot, projectPath, code: script, timeout: 30 });
  return parseGdscriptResult(result, [], (msg) => 'ASSERTION_FAILED');
}

async function handleTestStress(args: Record<string, unknown>, godot: string, projectPath: string): Promise<ToolResult> {
  const nodeType = gdEscape((args.node_type as string) || 'Node');
  const iterations = (args.iterations as number) || 100;

  const script = `${SCENE_TREE_HEADER}

func _init():
\tvar _root = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not available")
\t\t_mcp_done()
\t\treturn
\tvar _type = "${nodeType}"
\tvar _iters = ${iterations}
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
\tawait get_tree().process_frame
\tvar _mem_after = Performance.get_monitor(Performance.MEMORY_STATIC)
\tvar _leaked = _mem_after > _mem_before * 1.1
\t_mcp_output("result", JSON.stringify({
\t\t"success": not _leaked,
\t\t"iterations": _iters,
\t\t"node_type": _type,
\t\t"memory_before": _mem_before,
\t\t"memory_after": _mem_after,
\t\t"peak_memory": _peak,
\t\t"leaked": _leaked,
\t\t"message": "Stress test %s: %d iterations, memory %s" % ["PASSED" if not _leaked else "LEAKED", _iters, "stable" if not _leaked else "increased"]
\t}))
\t_mcp_done()
`;

  const result = await executeGdscript({ godotPath: godot, projectPath, code: script, timeout: 120 });
  return parseGdscriptResult(result, [], (msg) => 'STRESS_TEST_FAILED');
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  test_assert: { readonly: true, long_running: false },
  test_stress: { readonly: false, long_running: true },
  export_list_presets: { readonly: true, long_running: false },
  export_get_preset: { readonly: true, long_running: false },
  export_build: { readonly: false, long_running: true },
};
