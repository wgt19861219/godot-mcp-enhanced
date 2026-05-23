import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import {
  SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult,
  gdEscape, normalizeNodePath, validateIdentifier, validateVector3,
} from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PROPERTY: 'INVALID_PROPERTY',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const IK_TYPE_WHITELIST = [
  'TwoBoneIK3D',
  'FABRIK3D',
  'CCDIK3D',
  'SplineIK3D',
  'JacobianIK3D',
] as const;

const IK_SETTABLE_PROPS = [
  'active', 'influence', 'bone_name', 'target_nodepath',
  'use_magnet', 'magnet_position',
] as const;

export const TOOL_NAMES = [
  'ik_modifier_create',
  'ik_modifier_get',
  'ik_modifier_set',
  'ik_list_bones',
] as const;

// ─── GDScript Generators ───────────────────────────────────────────────────

export function genIkCreateScript(
  type: string, name: string, parent: string,
  position?: { x: number; y: number; z: number },
  boneName?: string, targetNodepath?: string,
): string {
  const posLine = position
    ? `\n\tik_node.position = Vector3(${position.x}, ${position.y}, ${position.z})`
    : '';
  const boneLine = boneName
    ? `\n\tik_node.bone_name = "${gdEscape(boneName)}"`
    : '';
  const targetLine = targetNodepath
    ? `\n\tik_node.target_nodepath = NodePath("${gdEscape(targetNodepath)}")`
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar ik_node = ${type}.new()
\tik_node.name = "${gdEscape(name)}"${posLine}${boneLine}${targetLine}
\tvar parent_node = _mcp_get_node("${gdEscape(parent)}")
\tif parent_node == null:
\t\t_mcp_output("error", "Parent not found: ${gdEscape(parent)}")
\t\t_mcp_done()
\t\treturn
\tparent_node.add_child(ik_node)
\tik_node.owner = root
\t_mcp_output("created", true)
\t_mcp_output("path", str(ik_node.get_path()))
\t_mcp_output("type", "${type}")
\t_mcp_done()
`;
}

export function genIkGetScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar ik_node = _mcp_get_node("${gdEscape(nodePath)}")
\tif ik_node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\t_mcp_output("type", ik_node.get_class())
\t_mcp_output("active", ik_node.active)
\t_mcp_output("influence", ik_node.influence)
\tif "bone_name" in ik_node:
\t\t_mcp_output("bone_name", str(ik_node.bone_name))
\t\t_mcp_output("target_nodepath", str(ik_node.target_nodepath))
\t\t_mcp_output("use_magnet", ik_node.use_magnet)
\t\tvar mag = ik_node.magnet_position
\t\t_mcp_output("magnet_position", {"x": mag.x, "y": mag.y, "z": mag.z})
\tvar skeleton = ik_node.get_parent()
\tif skeleton is Skeleton3D:
\t\t_mcp_output("skeleton_path", str(skeleton.get_path()))
\t_mcp_done()
`;
}

export function genIkSetScript(nodePath: string, props: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`${SCENE_TREE_HEADER}`);
  lines.push(`func _initialize():`);
  lines.push(`\t_mcp_load_main_scene()`);
  lines.push(`\tvar ik_node = _mcp_get_node("${gdEscape(nodePath)}")`);
  lines.push(`\tif ik_node == null:`);
  lines.push(`\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")`);
  lines.push(`\t\t_mcp_done()`);
  lines.push(`\t\treturn`);

  for (const [key, val] of Object.entries(props)) {
    if (key === 'active') {
      if (val !== true && val !== false) throw new Error('active must be boolean');
      lines.push(`\tik_node.active = ${val}`);
    } else if (key === 'influence') {
      const inf = Number(val);
      if (!Number.isFinite(inf)) throw new Error('influence must be a finite number');
      lines.push(`\tik_node.influence = ${inf}`);
    } else if (key === 'bone_name') {
      lines.push(`\tik_node.bone_name = "${gdEscape(String(val))}"`);
    } else if (key === 'target_nodepath') {
      lines.push(`\tik_node.target_nodepath = NodePath("${gdEscape(String(val))}")`);
    } else if (key === 'use_magnet') {
      if (val !== true && val !== false) throw new Error('use_magnet must be boolean');
      lines.push(`\tik_node.use_magnet = ${val}`);
    } else if (key === 'magnet_position') {
      const mp = val as { x: number; y: number; z: number };
      lines.push(`\tik_node.magnet_position = Vector3(${mp.x}, ${mp.y}, ${mp.z})`);
    }
  }

  lines.push(`\t_mcp_output("updated", true)`);
  lines.push(`\t_mcp_output("path", str(ik_node.get_path()))`);
  lines.push(`\t_mcp_done()`);
  return lines.join('\n') + '\n';
}

export function genListBonesScript(nodePath: string, limit?: number): string {
  const limitLine = limit ? `\n\tif bones.size() > ${limit}:\n\t\tbones = bones.slice(0, ${limit})` : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Skeleton3D:
\t\t_mcp_output("error", "Node is not a Skeleton3D: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar bones = []
\tfor i in range(node.get_bone_count()):
\t\tvar bname = node.get_bone_name(i)
\t\tvar rest = node.get_bone_rest(i)
\t\tbones.append({"index": i, "name": bname, "rest_position": {"x": rest.origin.x, "y": rest.origin.y, "z": rest.origin.z}})${limitLine}
\t_mcp_output("bone_count", node.get_bone_count())
\t_mcp_output("bones", bones)
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ik_modifier_create',
      description: `Create IK modifier node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          type: {
            type: 'string',
            description: 'IK 类型: TwoBoneIK3D, FABRIK3D, CCDIK3D, SplineIK3D, JacobianIK3D',
            enum: [...IK_TYPE_WHITELIST],
          },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）', default: 'root' },
          position: {
            type: 'object',
            description: '位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          bone_name: { type: 'string', description: '要控制的骨骼名（TwoBoneIK3D）' },
          target_nodepath: { type: 'string', description: 'IK 目标节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'type', 'name'],
      },
    },
    {
      name: 'ik_modifier_get',
      description: `Read IK modifier node properties. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'IK 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'ik_modifier_set',
      description: `Set IK modifier parameters. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'IK 节点路径' },
          properties: {
            type: 'object',
            description: '属性键值对: active(bool), influence(float 0-1), bone_name(string), target_nodepath(string), use_magnet(bool), magnet_position({x,y,z})',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'properties'],
      },
    },
    {
      name: 'ik_list_bones',
      description: `List Skeleton3D bones. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'Skeleton3D 节点路径' },
          limit: { type: 'number', description: '最大返回数量（可选）' },
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
      case 'ik_modifier_create': {
        const ikType = args.type as string;
        if (!IK_TYPE_WHITELIST.includes(ikType as any)) {
          return opsErrorResult(ERROR_CODES.INVALID_TYPE,
            `Invalid IK type: "${ikType}". Must be one of: ${IK_TYPE_WHITELIST.join(', ')}`);
        }
        validateIdentifier(ikType, 'type');
        validateIdentifier(args.name as string, 'name');
        const nodeName = args.name as string;
        const parent = normalizeNodePath((args.parent as string) || 'root');
        const position = args.position ? validateVector3(args.position) : undefined;
        const boneName = args.bone_name as string | undefined;
        const targetNodepath = args.target_nodepath as string | undefined;
        script = genIkCreateScript(ikType, nodeName, parent, position, boneName, targetNodepath);
        break;
      }
      case 'ik_modifier_get': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genIkGetScript(nodePath);
        break;
      }
      case 'ik_modifier_set': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const props = args.properties as Record<string, unknown>;
        if (!props || typeof props !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'properties must be an object');
        }
        for (const key of Object.keys(props)) {
          if (!IK_SETTABLE_PROPS.includes(key as any)) {
            return opsErrorResult(ERROR_CODES.INVALID_PROPERTY,
              `Unknown property: "${key}". Allowed: ${IK_SETTABLE_PROPS.join(', ')}`);
          }
        }
        if ('bone_name' in props && (!props.bone_name || String(props.bone_name).trim() === '')) {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'bone_name must be non-empty');
        }
        if ('active' in props && typeof props.active !== 'boolean') {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'active must be a boolean');
        }
        if ('influence' in props) {
          const inf = Number(props.influence);
          if (!Number.isFinite(inf) || inf < 0 || inf > 1) {
            return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'influence must be a number in [0, 1]');
          }
        }
        if ('use_magnet' in props && typeof props.use_magnet !== 'boolean') {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'use_magnet must be a boolean');
        }
        if ('magnet_position' in props) {
          props.magnet_position = validateVector3(props.magnet_position);
        }
        if ('target_nodepath' in props && typeof props.target_nodepath === 'string') {
          normalizeNodePath(props.target_nodepath);
        }
        script = genIkSetScript(nodePath, props);
        break;
      }
      case 'ik_list_bones': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const limit = args.limit as number | undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'limit must be a positive integer');
        }
        script = genListBonesScript(nodePath, limit);
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
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND :
      msg.includes('not a Skeleton3D') ? ERROR_CODES.INVALID_TYPE :
      ERROR_CODES.SCRIPT_EXEC_FAILED;

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Identifier')) return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, msg);
    if (msg.includes('NodePath')) return opsErrorResult(ERROR_CODES.NODE_NOT_FOUND, msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ik_modifier_create: { readonly: false, long_running: false },
  ik_modifier_get: { readonly: true, long_running: false },
  ik_modifier_set: { readonly: false, long_running: false },
  ik_list_bones: { readonly: true, long_running: false },
};
