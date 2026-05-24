import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, gdEscape, normalizeNodePath, validateVector3 } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_VECTOR: 'INVALID_VECTOR',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TOOL_NAMES = [
  'physics_raycast',
  'physics_body_info',
  'diagnose_physics',
  'query_spatial',
] as const;

// ─── GDScript Generators: Physics ──────────────────────────────────────────

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
    const pathsStr = excludePaths.map(p => `"${gdEscape(p)}"`).join(', ');
    excludeBlock = `
\tvar exclude_bodies = []
\tfor ep in [${pathsStr}]:
\t\tvar n = get_node(ep)
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
\tvar body = _mcp_get_node("${gdEscape(bodyPath)}")
\tif body == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(bodyPath)}")
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
\tvar body = _mcp_get_node("${gdEscape(bodyPath)}")
\tif body == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(bodyPath)}")
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

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'physics_raycast',
      description: `Perform 3D raycast. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          from: {
            type: 'object',
            description: '起点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          to: {
            type: 'object',
            description: '终点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          collision_mask: { type: 'number', description: '碰撞掩码（可选）' },
          exclude_paths: { type: 'array', description: '排除节点路径数组（可选）', items: { type: 'string' } },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'from', 'to'],
      },
    },
    {
      name: 'physics_body_info',
      description: `Get physics body collision info. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          body_path: { type: 'string', description: '物理体节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'body_path'],
      },
    },
    {
      name: 'diagnose_physics',
      description: `Diagnose physics collision state for a body. Returns velocity, contact points (position/normal), collision shape info, and warns about ConcavePolygonShape3D traps. WARNING: Uses move_and_collide with test_only=true which may have side effects on physics state. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          body_path: { type: 'string', description: '物理体节点路径（如 root/Player）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'body_path'],
      },
    },
    {
      name: 'query_spatial',
      description: `Query 3D space for collision bodies within a radius. Returns body paths, types, distances sorted nearest-first. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          center: {
            type: 'object',
            description: '查询中心点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          radius: { type: 'number', description: '查询半径（默认 10.0）', default: 10.0 },
          collision_mask: { type: 'number', description: '碰撞掩码（可选）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'center'],
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
      case 'physics_raycast': {
        const from = validateVector3(args.from);
        const to = validateVector3(args.to);
        const mask = args.collision_mask as number | undefined;
        if (mask !== undefined && typeof mask !== 'number') return opsErrorResult('INVALID_VECTOR', 'collision_mask must be a number');
        const excludeRaw = args.exclude_paths as string[] | undefined;
        const excludePaths = excludeRaw?.map(p => normalizeNodePath(p));
        script = genRaycastScript(from, to, mask, excludePaths);
        break;
      }
      case 'physics_body_info': {
        const bodyPath = normalizeNodePath(args.body_path as string);
        script = genBodyInfoScript(bodyPath);
        break;
      }
      case 'diagnose_physics': {
        const bodyPath = normalizeNodePath(args.body_path as string);
        script = genDiagnosePhysicsScript(bodyPath);
        break;
      }
      case 'query_spatial': {
        const center = validateVector3(args.center);
        const radius = typeof args.radius === 'number' ? Math.max(0.1, args.radius) : 10.0;
        const mask = args.collision_mask as number | undefined;
        if (mask !== undefined && typeof mask !== 'number') return opsErrorResult('INVALID_VECTOR', 'collision_mask must be a number');
        script = genQuerySpatialScript(center, radius, mask);
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
  physics_raycast: { readonly: true, long_running: false },
  physics_body_info: { readonly: true, long_running: false },
  diagnose_physics: { readonly: true, long_running: false },
  query_spatial: { readonly: true, long_running: false },
};
