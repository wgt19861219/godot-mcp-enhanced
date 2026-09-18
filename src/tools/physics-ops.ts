import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, escapeForGdLiteral, normalizeNodePath, validateVector3, runOpsScript } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_VECTOR: 'INVALID_VECTOR',
  INVALID_ACTION: 'INVALID_ACTION',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ACTIONS = [
  'raycast',
  'body_info',
  'diagnose',
  'query_spatial',
  'collision_overlay',
] as const;

// ─── GDScript Generators ───────────────────────────────────────────────────

export function genRaycastScript(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  collisionMask?: number,
  excludePaths?: string[]
): string {
  let maskLine = '';
  if (collisionMask !== undefined) {
    maskLine = `\n\tquery.collision_mask = ${collisionMask}`;
  }

  let excludeBlock = '';
  if (excludePaths && excludePaths.length > 0) {
    const pathsStr = excludePaths.map(p => `"${escapeForGdLiteral(p)}"`).join(', ');
    excludeBlock = `
\tvar exclude_bodies = []
\tfor ep in [${pathsStr}]:
\t\tvar n = _mcp_get_node(ep)
\t\tif n:
\t\t\texclude_bodies.append(n.get_rid())
\tquery.exclude = exclude_bodies`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _world = root.get_world_3d()
\tif _world == null:
\t\t_mcp_output("error", "No World3D available (scene may not have 3D content)")
\t\t_mcp_done()
\t\treturn
\tvar space_state = _world.direct_space_state
\tvar query = PhysicsRayQueryParameters3D.create(Vector3(${from.x}, ${from.y}, ${from.z}), Vector3(${to.x}, ${to.y}, ${to.z}))${maskLine}${excludeBlock}
\tvar result = space_state.intersect_ray(query)
\tif result.is_empty():
\t\t_mcp_output("hit", false)
\telse:
\t\t_mcp_output("hit", true)
\t\t_mcp_output("position", {"x": result["position"].x, "y": result["position"].y, "z": result["position"].z})
\t\t_mcp_output("normal", {"x": result["normal"].x, "y": result["normal"].y, "z": result["normal"].z})
\t\t_mcp_output("collider", str(result["collider"]))
\t\t_mcp_output("rid", str(result["rid"]))
\t_mcp_done()
`;
}

export function genBodyInfoScript(bodyPath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar body = _mcp_get_node("${escapeForGdLiteral(bodyPath)}")
\tif body == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(bodyPath)}")
\t\t_mcp_done()
\t\treturn
\tvar shapes = []
\tfor child in body.get_children():
\t\tif child is CollisionShape3D:
\t\t\tvar shape_res = child.shape
\t\t\tvar info = {}
\t\t\tif shape_res:
\t\t\t\tinfo["shape_type"] = shape_res.get_class()
\t\t\t\tvar aabb = shape_res.get_debug_mesh().get_aabb()
\t\t\t\tinfo["aabb_size"] = {"x": aabb.size.x, "y": aabb.size.y, "z": aabb.size.z}
\t\t\telse:
\t\t\t\tinfo["shape_type"] = "None"
\t\t\tinfo["disabled"] = child.disabled
\t\t\tshapes.append(info)
\tif shapes.is_empty():
\t\t_mcp_output("has_collision", false)
\telse:
\t\t_mcp_output("has_collision", true)
\t\t_mcp_output("shapes", shapes)
\t_mcp_output("collision_layer", body.collision_layer)
\t_mcp_output("collision_mask", body.collision_mask)
\t_mcp_done()
`;
}

export function genDiagnosePhysicsScript(bodyPath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar body = _mcp_get_node("${escapeForGdLiteral(bodyPath)}")
\tif body == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(bodyPath)}")
\t\t_mcp_done()
\t\treturn
\t# Basic info
\t_mcp_output("node_type", body.get_class())
\tif not body is Node3D:
\t\t_mcp_output("error", "Node is not a Node3D: " + body.get_class())
\t\t_mcp_done()
\t\treturn
\t_mcp_output("position", {"x": body.position.x, "y": body.position.y, "z": body.position.z})
\tif body is PhysicsBody3D:
\t\t_mcp_output("collision_layer", body.collision_layer)
\t\t_mcp_output("collision_mask", body.collision_mask)
\t\tvar vel = Vector3.ZERO
\t\tif body is CharacterBody3D:
\t\t\tvel = body.velocity
\t\telif body is RigidBody3D:
\t\t\tvel = body.linear_velocity
\t\t_mcp_output("velocity", {"x": vel.x, "y": vel.y, "z": vel.z})
\t\t_mcp_output("horizontal_speed", Vector2(vel.x, vel.z).length())
\telse:
\t\t_mcp_output("warning", "Node is not a PhysicsBody3D (" + body.get_class() + ") — velocity and collision diagnostics skipped")
\t# Collision shapes
\tvar shapes = []
\tvar has_concave = false
\tfor child in body.get_children():
\t\tif child is CollisionShape3D:
\t\t\tvar shape_res = child.shape
\t\t\tvar info = {}
\t\t\tif shape_res:
\t\t\t\tinfo["shape_type"] = shape_res.get_class()
\t\t\t\tinfo["disabled"] = child.disabled
\t\t\t\tif shape_res is ConcavePolygonShape3D:
\t\t\t\t\thas_concave = true
\t\t\t\tvar aabb = shape_res.get_debug_mesh().get_aabb()
\t\t\t\tinfo["aabb_size"] = {"x": aabb.size.x, "y": aabb.size.y, "z": aabb.size.z}
\t\t\telse:
\t\t\t\tinfo["shape_type"] = "None"
\t\t\t\tinfo["disabled"] = child.disabled
\t\t\tshapes.append(info)
\t_mcp_output("shapes", shapes)
\tif has_concave:
\t\t_mcp_output("warning", "ConcavePolygonShape3D detected — may cause ball trapping at internal faces. Consider using convex shapes (BoxShape3D, SphereShape3D) instead.")
\t# Collision contacts via move_and_collide
\tvar collision = null
\tif body is PhysicsBody3D:
\t\tcollision = body.move_and_collide(Vector3.ZERO, true, 0.001, true)
\tif collision:
\t\tvar contacts = []
\t\tfor i in range(collision.get_collision_count()):
\t\t\tvar pos = collision.get_position(i)
\t\t\tvar norm = collision.get_normal(i)
\t\t\tcontacts.append({"position": {"x": pos.x, "y": pos.y, "z": pos.z}, "normal": {"x": norm.x, "y": norm.y, "z": norm.z}})
\t\t_mcp_output("contacts", contacts)
\t\tvar coll = collision.get_collider()
\t\tif coll:
\t\t\t_mcp_output("colliding_with", str(coll.get_path()) if coll is Node else str(coll))
\t\t\tvar collider_shapes = []
\t\t\tfor ch in coll.get_children():
\t\t\t\tif ch is CollisionShape3D and ch.shape:
\t\t\t\t\tvar sinfo = {"shape_type": ch.shape.get_class(), "disabled": ch.disabled}
\t\t\t\t\tif ch.shape is ConcavePolygonShape3D:
\t\t\t\t\t\tsinfo["warning"] = "ConcavePolygonShape3D — internal faces may trap small bodies"
\t\t\t\t\tcollider_shapes.append(sinfo)
\t\t\tif not collider_shapes.is_empty():
\t\t\t\t_mcp_output("collider_shapes", collider_shapes)
\t\t\t\tif collider_shapes.size() > 50:
\t\t\t\t\t_mcp_output("warning", "Collider has " + str(collider_shapes.size()) + " shapes — consider merging for performance")
\telse:
\t\t_mcp_output("contacts", [])
\t_mcp_done()
`;
}

export function genQuerySpatialScript(
  center: { x: number; y: number; z: number },
  radius: number,
  collisionMask?: number
): string {
  let maskLine = '';
  if (collisionMask !== undefined) {
    maskLine = `\n\tquery.collision_mask = ${collisionMask}`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar world = root.get_world_3d()
\tif world == null:
\t\t_mcp_output("error", "No World3D available (scene may not be loaded)")
\t\t_mcp_done()
\t\treturn
\tvar space_state = world.direct_space_state
\tif space_state == null:
\t\t_mcp_output("error", "Physics space state not available (PhysicsServer may not be initialized in headless mode)")
\t\t_mcp_done()
\t\treturn
\tvar center_v = Vector3(${center.x}, ${center.y}, ${center.z})
\tvar sphere = SphereShape3D.new()
\tsphere.radius = ${radius}
\tvar query = PhysicsShapeQueryParameters3D.new()
\tquery.shape = sphere
\tquery.transform = Transform3D(Basis(), center_v)
\tquery.collide_with_areas = false
\tquery.collide_with_bodies = true${maskLine}
\tvar results = space_state.intersect_shape(query)
\tvar bodies = []
\tfor r in results:
\t\tvar collider = r["collider"]
\t\tif not (collider is Node):
\t\t\tcontinue
\t\tvar dist = center_v.distance_to(collider.global_position)
\t\tvar entry = {"path": str(collider.get_path()), "type": collider.get_class(), "distance": dist}
\t\tvar collider_shapes = []
\t\tfor ch in collider.get_children():
\t\t\tif ch is CollisionShape3D and ch.shape:
\t\t\t\tcollider_shapes.append({"shape_type": ch.shape.get_class(), "disabled": ch.disabled})
\t\tif not collider_shapes.is_empty():
\t\t\tentry["shapes"] = collider_shapes
\t\tbodies.append(entry)
\tbodies.sort_custom(func(a, b): return a["distance"] < b["distance"])
\t_mcp_output("center", {"x": ${center.x}, "y": ${center.y}, "z": ${center.z}})
\t_mcp_output("radius", ${radius})
\t_mcp_output("count", bodies.size())
\t_mcp_output("bodies", bodies)
\t_mcp_done()
`;
}

export function genCollisionOverlayScript(parentPath: string, colorOverride?: string): string {
  let colorInit = 'var base_color = null';
  if (colorOverride) {
    colorInit = `var base_color = Color(${colorOverride})`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(parentPath)}")
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

// ─── Tool Definition ────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'physics',
      description:
        '物理系统统一工具。支持 5 种操作：raycast（3D 射线检测）、body_info（物理体碰撞信息）、' +
        'diagnose（物理诊断，含速度/接触点/碰撞形状/ConcavePolygonShape3D 警告）、' +
        'query_spatial（空间范围查询碰撞体）、collision_overlay（碰撞形状可视化覆盖层）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型：raycast | body_info | diagnose | query_spatial | collision_overlay',
          },
          // raycast 参数
          from: {
            type: 'object',
            description: '射线起点 {x,y,z}（raycast 必填）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          to: {
            type: 'object',
            description: '射线终点 {x,y,z}（raycast 必填）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          // body_info / diagnose 参数
          body_path: { type: 'string', description: '物理体节点路径（body_info / diagnose 必填）' },
          // query_spatial 参数
          center: {
            type: 'object',
            description: '查询中心点 {x,y,z}（query_spatial 必填）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          radius: { type: 'number', description: '查询半径（query_spatial，默认 10.0）', default: 10.0 },
          // raycast / query_spatial 通用参数
          collision_mask: { type: 'number', description: '碰撞掩码（raycast / query_spatial 可选）' },
          exclude_paths: { type: 'array', description: '排除节点路径数组（raycast 可选）', items: { type: 'string' } },
          // collision_overlay 参数
          parent_path: { type: 'string', description: '父节点路径（collision_overlay，默认 root）' },
          color_override: { type: 'string', description: '统一颜色，如 "1,0,0,0.5"（collision_overlay 可选）' },
          // 通用参数
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

// follow-up C5: collision_overlay 创造运行时可视化节点树（genCollisionOverlayScript），
// headless 退出丢失 → 加提示；raycast/body_info/diagnose/query_spatial 只读不加。
const PHYSICS_PERSIST_ACTIONS = new Set(['collision_overlay']);

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'physics') return null;

  try {
    const projectPath = requireProjectPath(args);
    const action = args.action as string;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return opsErrorResult('INVALID_ACTION', `未知操作: ${action}。支持: ${ACTIONS.join(', ')}`);
    }

    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
      case 'raycast': {
        if (!args.from || !args.to) return opsErrorResult('INVALID_VECTOR', 'raycast 需要 from 和 to 参数');
        const from = validateVector3(args.from);
        const to = validateVector3(args.to);
        const mask = args.collision_mask as number | undefined;
        if (mask !== undefined && typeof mask !== 'number') return opsErrorResult('INVALID_VECTOR', 'collision_mask must be a number');
        const excludeRaw = args.exclude_paths as string[] | undefined;
        const excludePaths = excludeRaw?.map(p => normalizeNodePath(p));
        script = genRaycastScript(from, to, mask, excludePaths);
        break;
      }
      case 'body_info': {
        if (!args.body_path) return opsErrorResult('INVALID_PATH', 'body_info 需要 body_path 参数');
        const bodyPath = normalizeNodePath(args.body_path as string);
        script = genBodyInfoScript(bodyPath);
        break;
      }
      case 'diagnose': {
        if (!args.body_path) return opsErrorResult('INVALID_PATH', 'diagnose 需要 body_path 参数');
        const bodyPath = normalizeNodePath(args.body_path as string);
        script = genDiagnosePhysicsScript(bodyPath);
        break;
      }
      case 'query_spatial': {
        if (!args.center) return opsErrorResult('INVALID_VECTOR', 'query_spatial 需要 center 参数');
        const center = validateVector3(args.center);
        const radius = typeof args.radius === 'number' ? Math.max(0.1, args.radius) : 10.0;
        const mask = args.collision_mask as number | undefined;
        if (mask !== undefined && typeof mask !== 'number') return opsErrorResult('INVALID_VECTOR', 'collision_mask must be a number');
        script = genQuerySpatialScript(center, radius, mask);
        break;
      }
      case 'collision_overlay': {
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const rawColor = args.color_override as string | undefined;
        let safeColor: string | undefined;
        if (rawColor) {
          const parts = rawColor.split(',').map(p => p.trim());
          if (parts.length < 3 || parts.length > 4 || !parts.every(p => /^\d+(\.\d+)?$/.test(p) && isFinite(Number(p)))) {
            return opsErrorResult('INVALID_VECTOR', 'color_override must be 3-4 comma-separated finite numbers (e.g. "1,0,0,0.5")');
          }
          safeColor = parts.map(p => String(Number(p))).join(', ');
        }
        script = genCollisionOverlayScript(parentPath, safeColor);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
      errorMapper, paramWarnings: [],
      warnRuntimePersist: PHYSICS_PERSIST_ACTIONS.has(action), action: `physics_${action}` });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  physics: {
    readonly: true,
    long_running: false,
    actionRisks: {
      raycast: 'read', body_info: 'read', diagnose: 'read', query_spatial: 'read', collision_overlay: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
