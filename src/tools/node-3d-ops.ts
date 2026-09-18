import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, gdEscape, escapeForGdLiteral, normalizeNodePath, validateVector3, TYPE_WHITELIST, validateIdentifier, runOpsScript } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_TYPE: 'INVALID_TYPE',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TOOL_NAMES = [
  'node_create_3d',
] as const;

// ─── GDScript Generators: Node3D ───────────────────────────────────────────

export function genCreate3DScript(
  nodeType: string, nodeName: string, parentPath: string,
  position?: { x: number; y: number; z: number },
  rotation?: { x: number; y: number; z: number },
  scale?: { x: number; y: number; z: number },
  properties?: Record<string, unknown>
): string {
  let posLine = '';
  if (position) {
    posLine = `\n\tnode.position = Vector3(${position.x}, ${position.y}, ${position.z})`;
  }

  let rotLine = '';
  if (rotation) {
    rotLine = `\n\tnode.rotation = Vector3(${rotation.x}, ${rotation.y}, ${rotation.z})`;
  }

  let scaleLine = '';
  if (scale) {
    scaleLine = `\n\tnode.scale = Vector3(${scale.x}, ${scale.y}, ${scale.z})`;
  }

  let propsLines = '';
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid property name: "${key}"`);
      }
      if (value === null || value === undefined) {
        propsLines += `\n\tnode.${key} = null`;
      } else if (typeof value === 'number') {
        propsLines += `\n\tnode.${key} = ${value}`;
      } else if (typeof value === 'boolean') {
        propsLines += `\n\tnode.${key} = ${value}`;
      } else if (typeof value === 'string') {
        propsLines += `\n\tnode.${key} = "${gdEscape(value)}"`;
      } else {
        throw new Error(`Property "${key}" only supports basic types (string/number/bool/null)`);
      }
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar node = ${nodeType}.new()
\tnode.name = "${gdEscape(nodeName)}"${posLine}${rotLine}${scaleLine}${propsLines}
\tparent.add_child(node)
\tnode.owner = parent.owner if parent.owner != null else parent
\t_mcp_output("created", {"type": "${gdEscape(nodeType)}", "name": "${gdEscape(nodeName)}", "path": str(node.get_path()) if node.is_inside_tree() else "${gdEscape(nodeName)}"})
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] node-3d-ops module is absorbed into scene. Do not register directly.`);
  return [
    {
      name: 'node_create_3d',
      description: `Create 3D node at runtime. Headless-created nodes are not persisted — use add_node + save_scene for persistence. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          type: { type: 'string', description: '节点类型（仅限白名单）' },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          position: {
            type: 'object',
            description: '位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          rotation: {
            type: 'object',
            description: '旋转 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          scale: {
            type: 'object',
            description: '缩放 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          properties: { type: 'object', description: '自定义属性（仅基本类型值）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['type', 'name'],
      },
    },
  ];
}

// ─── Core handler (shared by handleTool and scene module) ─────────────────

export async function handleCreate3dNode(
  args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;

    const nodeType = args.type as string;
    const nodeName = args.name as string;
    if (!TYPE_WHITELIST.includes(nodeType as typeof TYPE_WHITELIST[number])) {
      return opsErrorResult('INVALID_TYPE', `Node type "${nodeType}" not in whitelist. Allowed: ${TYPE_WHITELIST.join(', ')}`);
    }
    validateIdentifier(nodeType, 'node_type');
    validateIdentifier(nodeName, 'node_name');
    const parentPath = normalizeNodePath((args.parent as string) || 'root');
    const position = args.position ? validateVector3(args.position) : undefined;
    const rotation = args.rotation ? validateVector3(args.rotation) : undefined;
    const scale = args.scale ? validateVector3(args.scale) : undefined;
    const properties = args.properties as Record<string, unknown> | undefined;

    let script: string;
    try {
      script = genCreate3DScript(nodeType, nodeName, parentPath, position, rotation, scale, properties);
    } catch (e) {
      return opsErrorResult('INVALID_TYPE', (e as Error).message);
    }

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings: [], warnRuntimePersist: true, action: 'node_create_3d',
      errorOpts: {
        suggestion: 'Use query_scene_tree to list available nodes, or check the node path spelling.',
      } });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;
  return handleCreate3dNode(args, ctx);
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  node_create_3d: { readonly: false, long_running: false },
};
