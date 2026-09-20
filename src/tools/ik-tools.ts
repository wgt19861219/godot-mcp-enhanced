import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../core/args-validation.js';
import {
  SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, runOpsScript,
  gdEscape, escapeForGdLiteral, normalizeNodePath, validateIdentifier, validateVector3,
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

const ACTIONS = [
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
    ? `\n\tik_node.target_nodepath = NodePath("${escapeForGdLiteral(targetNodepath)}")`
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar ik_node = ${type}.new()
\tik_node.name = "${gdEscape(name)}"${posLine}${boneLine}${targetLine}
\tvar parent_node = _mcp_get_node("${escapeForGdLiteral(parent)}")
\tif parent_node == null:
\t\t_mcp_output("error", "Parent not found: ${escapeForGdLiteral(parent)}")
\t\t_mcp_done()
\t\treturn
\tparent_node.add_child(ik_node)
\tvar _root_node = _mcp_get_root()
\tif _root_node != null:
\t\tik_node.owner = _root_node
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
\tvar ik_node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif ik_node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar ik_class = ik_node.get_class()
\t_mcp_output("type", ik_class)
\t_mcp_output("active", ik_node.active)
\t_mcp_output("influence", ik_node.influence)
\tif ik_class == "TwoBoneIK3D":
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
  lines.push(`\tvar ik_node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")`);
  lines.push(`\tif ik_node == null:`);
  lines.push(`\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")`);
  lines.push(`\t\t_mcp_done()`);
  lines.push(`\t\treturn`);

  for (const [key, val] of Object.entries(props)) {
    if (key === 'active') {
      lines.push(`\tik_node.active = ${val}`);
    } else if (key === 'influence') {
      lines.push(`\tik_node.influence = ${Number(val)}`);
    } else if (key === 'bone_name') {
      lines.push(`\tik_node.bone_name = "${gdEscape(String(val))}"`);
    } else if (key === 'target_nodepath') {
      // 纯字面量构造(非 % 格式串),含 % 的 NodePath 不应被双写 → escapeForGdLiteral(同构 animtree.ts anim_player)
      lines.push(`\tik_node.target_nodepath = NodePath("${escapeForGdLiteral(String(val))}")`);
    } else if (key === 'use_magnet') {
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
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
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
  console.warn(`[DEPRECATED] ik-tools module is absorbed into animation. Do not register directly.`);
  return [
    {
      name: 'ik',
      description: `IK 操作。create: 创建 IK 修饰器节点。get: 读取属性。set: 设置参数。list_bones: 列出骨骼。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          type: {
            type: 'string',
            enum: [...IK_TYPE_WHITELIST],
            description: 'create: IK 类型',
          },
          name: { type: 'string', description: 'create: 节点名称' },
          parent: { type: 'string', description: 'create: 父节点路径（默认 root）' },
          position: {
            type: 'object',
            description: 'create: 位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          bone_name: { type: 'string', description: 'create: 要控制的骨骼名（TwoBoneIK3D）' },
          target_nodepath: { type: 'string', description: 'create: IK 目标节点路径' },
          node_path: { type: 'string', description: 'get/set/list_bones: 节点路径' },
          properties: {
            type: 'object',
            description: 'set: 属性键值对（active, influence, bone_name, target_nodepath, use_magnet, magnet_position）',
          },
          limit: { type: 'number', description: 'list_bones: 最大返回数量' },
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
  if (name !== 'ik') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
      case 'ik_modifier_create': {
        const ikType = args.type as string;
        if (!(IK_TYPE_WHITELIST as readonly string[]).includes(ikType)) {
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
          if (!(IK_SETTABLE_PROPS as readonly string[]).includes(key)) {
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
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND :
      msg.includes('not a Skeleton3D') ? ERROR_CODES.INVALID_TYPE :
      ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings: [], action });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('Identifier')) return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, msg);
    if (msg.includes('NodePath')) return opsErrorResult(ERROR_CODES.NODE_NOT_FOUND, msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ik: { readonly: false, long_running: false },
};

// ─── Exported handler for animation-ops module merge (v0.18.0) ──────────────

/** 供 animation-ops 模块合并调用（v0.18.0 action 路由统一） */
export async function handleIkAction(
  action: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  // 复用现有 handleTool，透传 action
  return handleTool('ik', { ...args, action }, ctx);
}
