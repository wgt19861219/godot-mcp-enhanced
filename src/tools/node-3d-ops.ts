import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, gdEscape, normalizeNodePath, validateVector3, TYPE_WHITELIST, validateIdentifier } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_TYPE: 'INVALID_TYPE',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TOOL_NAMES = [
  'collision_overlay',
  'node_create_3d',
] as const;

// ─── GDScript Generators: Node3D ───────────────────────────────────────────

export function genCollisionOverlayScript(parentPath: string, colorOverride?: string): string {
  let colorInit = 'var base_color = null';
  if (colorOverride) {
    colorInit = `var base_color = Color(${colorOverride})`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\t${colorInit}
\tvar existing_overlay = parent.get_node_or_null("_MCP_CollisionOverlay")
\tif existing_overlay:
\t\tparent.remove_child(existing_overlay)
\t\texisting_overlay.queue_free()
\tvar overlay_parent = Node3D.new()
\toverlay_parent.name = "_MCP_CollisionOverlay"
\tparent.add_child(overlay_parent)
\tvar overlays = []
\tvar _collect_fn: Callable
\t_collect_fn = func(node: Node):
\t\tif node is CollisionShape3D and node.shape:
\t\t\tvar phys_parent = node.get_parent()
\t\t\tvar color: Color
\t\t\tif base_color != null:
\t\t\t\tcolor = base_color
\t\t\telif phys_parent is StaticBody3D:
\t\t\t\tcolor = Color(0.3, 0.5, 1.0, 0.5)
\t\t\telif phys_parent is CharacterBody3D:
\t\t\t\tcolor = Color(0.2, 0.9, 0.3, 0.5)
\t\t\telif phys_parent is RigidBody3D:
\t\t\t\tcolor = Color(1.0, 0.3, 0.3, 0.5)
\t\t\telif phys_parent is Area3D:
\t\t\t\tcolor = Color(1.0, 0.9, 0.2, 0.5)
\t\t\telse:
\t\t\t\tcolor = Color(1.0, 1.0, 1.0, 0.5)
\t\t\tvar debug_mesh = node.shape.get_debug_mesh()
\t\t\tvar mesh_inst = MeshInstance3D.new()
\t\t\tmesh_inst.mesh = debug_mesh
\t\t\tvar mat = StandardMaterial3D.new()
\t\t\tmat.albedo_color = color
\t\t\tmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
\t\t\tmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
\t\t\tmesh_inst.material_override = mat
\t\t\tmesh_inst.global_transform = node.global_transform
\t\t\toverlay_parent.add_child(mesh_inst)
\t\t\tvar parent_type = phys_parent.get_class() if phys_parent else "Unknown"
\t\t\toverlays.append({"path": str(node.get_path()), "shape": node.shape.get_class(), "color": {"r": color.r, "g": color.g, "b": color.b, "a": color.a}, "parent_type": parent_type})
\t\tfor child in node.get_children():
\t\t\t_collect_fn.call(child)
\t_collect_fn.call(parent)
\t_mcp_output("overlay_count", overlays.size())
\t_mcp_output("overlays", overlays)
\t_mcp_done()
`;
}

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
\tvar parent = _mcp_get_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(parentPath)}")
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
  return [
    {
      name: 'collision_overlay',
      description: `Create colored wireframe overlays for all CollisionShape3D nodes. StaticBody=blue, CharacterBody=green, RigidBody=red, Area=yellow. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          parent_path: { type: 'string', description: '父节点路径（默认 root）' },
          color_override: { type: 'string', description: '统一颜色（如 "1,0,0,0.5"），可选' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'node_create_3d',
      description: `Create 3D node at runtime. Headless-created nodes are not persisted — use add_node + save_scene for persistence. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
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
        required: ['project_path', 'type', 'name'],
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
      case 'collision_overlay': {
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const rawColor = args.color_override as string | undefined;
        let safeColor: string | undefined;
        if (rawColor) {
          const parts = rawColor.split(',').map(p => p.trim());
          if (parts.length < 3 || parts.length > 4 || !parts.every(p => /^[\d.]+$/.test(p) && isFinite(Number(p)))) {
            return opsErrorResult('INVALID_TYPE', 'color_override must be 3-4 comma-separated finite numbers (e.g. "1,0,0,0.5")');
          }
          safeColor = parts.map(p => String(Number(p))).join(', ');
        }
        script = genCollisionOverlayScript(parentPath, safeColor);
        break;
      }
      case 'node_create_3d': {
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
        try {
          script = genCreate3DScript(nodeType, nodeName, parentPath, position, rotation, scale, properties);
        } catch (e) {
          return opsErrorResult('INVALID_TYPE', (e as Error).message);
        }
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
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  collision_overlay: { readonly: false, long_running: false },
  node_create_3d: { readonly: false, long_running: false },
};
