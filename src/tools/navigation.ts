import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getErrorMessage } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, normalizeNodePath, gdEscape, escapeForGdLiteral, validateVector3, runOpsScript } from './shared.js';
import { validateTimeout } from './shared/validation.js';
import { ff } from './shared/value-serializer.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const NAV_ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_VECTOR: 'INVALID_VECTOR',
  INVALID_PARAMS: 'INVALID_PARAMS',
  BAKE_FAILED: 'BAKE_FAILED',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const ACTIONS = [
  'create_region',
  'bake_mesh',
  'create_agent',
  'set_params',
  'create_link',
  'query_path',
] as const;

// ─── GDScript Generators ──────────────────────────────────────────────────

// Task 6 (§9，与 editor §6 同款): NavigationRegion3D 无 is_baking 属性
// (Task 0 实测 BAKING_PROPS 空) → fallback bake_finished 信号 + dict holder
// (GDScript 4 lambda by-value，Task 0 实测 LOCAL_CAPTURE=1，与 cf060a8 同款)。
// 判据用 navigation_mesh.get_vertices().size() > 0（plan 写 get_vertices_count()
// 错，Task 0 实测 Nonexistent function）。
const BAKE_WAIT_HELPER = `
func _wait_bake_done(_nav, _timeout_ms):
\tvar _state = {"done": false}
\tvar _cb = func(): _state["done"] = true
\t_nav.bake_finished.connect(_cb)
\tawait process_frame
\tvar _deadline = Time.get_ticks_msec() + _timeout_ms
\twhile not _state["done"] and Time.get_ticks_msec() < _deadline:
\t\tif not is_instance_valid(_nav):
\t\t\treturn false
\t\tawait process_frame
\tif is_instance_valid(_nav) and _nav.bake_finished.is_connected(_cb):
\t\t_nav.bake_finished.disconnect(_cb)
\treturn true`;

export function genCreateRegionScript(
  nodeName: string,
  parentPath: string,
  position: { x: number; y: number; z: number },
  bake: boolean,
): string {
  const bakeBlock = bake
    ? `\t_nav.bake_navigation_mesh()\n\tvar _bake_wait_ok = await _wait_bake_done(_nav, 110000)\n\tvar _baked = _bake_wait_ok and _nav.navigation_mesh != null and _nav.navigation_mesh.get_vertices().size() > 0`
    : `\tvar _baked = false`;

  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _nav = NavigationRegion3D.new()
\t_nav.name = "${gdEscape(nodeName)}"
\t_nav.position = Vector3(${ff(position.x)}, ${ff(position.y)}, ${ff(position.z)})
\tparent.add_child(_nav)
\tvar _root: Node = _mcp_get_root()
\tif _root != null:
\t\t_nav.set_owner(_root)
\tvar _mesh = NavigationMesh.new()
\t_nav.navigation_mesh = _mesh
${bakeBlock}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationRegion3D", "parent": "${escapeForGdLiteral(parentPath)}", "baked": _baked})
\t_mcp_done()
${BAKE_WAIT_HELPER}
`;
}

export function genBakeMeshScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _nav = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _nav == null:
\t\t_mcp_output("error", "NavigationRegion3D not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_nav is NavigationRegion3D):
\t\t_mcp_output("error", "Node is not a NavigationRegion3D: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\t_nav.bake_navigation_mesh()
\tvar _bake_wait_ok = await _wait_bake_done(_nav, 110000)
\tvar _bake_ok = _bake_wait_ok and _nav.navigation_mesh != null and _nav.navigation_mesh.get_vertices().size() > 0
\t_mcp_output("baked", {"node": "${escapeForGdLiteral(nodePath)}", "success": _bake_ok})
\t_mcp_done()
${BAKE_WAIT_HELPER}
`;
}

export function genCreateAgentScript(
  nodeName: string,
  parentPath: string,
  targetPosition: { x: number; y: number; z: number },
  pathDesiredDistance: number,
  targetDesiredDistance: number,
  avoidanceEnabled: boolean,
): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _agent = NavigationAgent3D.new()
\t_agent.name = "${gdEscape(nodeName)}"
\tparent.add_child(_agent)
\tvar _root: Node = _mcp_get_root()
\tif _root != null:
\t\t_agent.set_owner(_root)
\t_agent.target_position = Vector3(${targetPosition.x}, ${targetPosition.y}, ${targetPosition.z})
\t_agent.path_desired_distance = ${pathDesiredDistance}
\t_agent.target_desired_distance = ${targetDesiredDistance}
\t_agent.avoidance_enabled = ${avoidanceEnabled}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationAgent3D", "parent": "${escapeForGdLiteral(parentPath)}"})
\t_mcp_done()
`;
}

function genSetParamsScript(
  nodePath: string,
  params: {
    path_desired_distance?: number;
    target_desired_distance?: number;
    radius?: number;
    height?: number;
    max_speed?: number;
    avoidance_enabled?: boolean;
    neighbor_distance?: number;
    max_neighbors?: number;
    time_horizon_agents?: number;
    time_horizon_obstacles?: number;
  },
): string {
  const paramLines: string[] = [];
  if (params.path_desired_distance !== undefined) {
    paramLines.push(`\t_agent.path_desired_distance = ${params.path_desired_distance}`);
  }
  if (params.target_desired_distance !== undefined) {
    paramLines.push(`\t_agent.target_desired_distance = ${params.target_desired_distance}`);
  }
  if (params.radius !== undefined) {
    paramLines.push(`\t_agent.radius = ${params.radius}`);
  }
  if (params.height !== undefined) {
    paramLines.push(`\t_agent.height = ${params.height}`);
  }
  if (params.max_speed !== undefined) {
    paramLines.push(`\t_agent.max_speed = ${params.max_speed}`);
  }
  if (params.avoidance_enabled !== undefined) {
    paramLines.push(`\t_agent.avoidance_enabled = ${params.avoidance_enabled}`);
  }
  if (params.neighbor_distance !== undefined) {
    paramLines.push(`\t_agent.neighbor_distance = ${params.neighbor_distance}`);
  }
  if (params.max_neighbors !== undefined) {
    paramLines.push(`\t_agent.max_neighbors = ${params.max_neighbors}`);
  }
  if (params.time_horizon_agents !== undefined) {
    paramLines.push(`\t_agent.time_horizon_agents = ${params.time_horizon_agents}`);
  }
  if (params.time_horizon_obstacles !== undefined) {
    paramLines.push(`\t_agent.time_horizon_obstacles = ${params.time_horizon_obstacles}`);
  }

  const setBlock = paramLines.join('\n');

  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _agent = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _agent == null:
\t\t_mcp_output("error", "NavigationAgent3D not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_agent is NavigationAgent3D):
\t\t_mcp_output("error", "Node is not a NavigationAgent3D: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
${setBlock}
\t_mcp_output("updated", {"node": "${escapeForGdLiteral(nodePath)}"})
\t_mcp_done()
`;
}

export function genCreateLinkScript(
  nodeName: string,
  parentPath: string,
  startPosition: { x: number; y: number; z: number },
  endPosition: { x: number; y: number; z: number },
  bidirectional: boolean,
): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${escapeForGdLiteral(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${escapeForGdLiteral(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _link = NavigationLink3D.new()
\t_link.name = "${gdEscape(nodeName)}"
\tparent.add_child(_link)
\tvar _root: Node = _mcp_get_root()
\tif _root != null:
\t\t_link.set_owner(_root)
\t_link.start_position = Vector3(${startPosition.x}, ${startPosition.y}, ${startPosition.z})
\t_link.end_position = Vector3(${endPosition.x}, ${endPosition.y}, ${endPosition.z})
\t_link.bidirectional = ${bidirectional}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationLink3D", "parent": "${escapeForGdLiteral(parentPath)}", "bidirectional": ${bidirectional}})
\t_mcp_done()
`;
}

export function genNavQueryScript(
  startPos: { x: number; y: number; z: number },
  endPos: { x: number; y: number; z: number },
  navigationRegion?: string
): string {
  let regionBlock: string;
  if (navigationRegion) {
    regionBlock = `\tvar region_node = _mcp_get_node("${escapeForGdLiteral(navigationRegion)}")
\tif region_node and region_node is NavigationRegion3D:
\t\tmap_rid = NavigationServer3D.region_get_map(region_node.get_region_rid())
\telse:
\t\tvar maps = NavigationServer3D.get_maps()
\t\tif maps.is_empty():
\t\t\t_mcp_output("path", [])
\t\t\t_mcp_output("path_length", 0)
\t\t\t_mcp_output("warning", "No navigation data available")
\t\t\t_mcp_done()
\t\t\treturn
\t\tmap_rid = maps[0]`;
  } else {
    regionBlock = `\tvar maps = NavigationServer3D.get_maps()
\tif maps.is_empty():
\t\t_mcp_output("path", [])
\t\t_mcp_output("path_length", 0)
\t\t_mcp_output("warning", "No navigation data available")
\t\t_mcp_done()
\t\treturn
\tmap_rid = maps[0]`;
  }

  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar map_rid: RID
${regionBlock}
\tvar start = Vector3(${startPos.x}, ${startPos.y}, ${startPos.z})
\tvar end = Vector3(${endPos.x}, ${endPos.y}, ${endPos.z})
\tvar path = NavigationServer3D.map_get_path(map_rid, start, end, true)
\tvar path_data = []
\tfor p in path:
\t\tpath_data.append({"x": p.x, "y": p.y, "z": p.z})
\t_mcp_output("path", path_data)
\t_mcp_output("path_length", path_data.size())
\tif path_data.is_empty():
\t\t_mcp_output("warning", "No path found")
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'nav',
      description: `导航操作。create_region: 创建 NavigationRegion3D（可选烘焙）。bake_mesh: 烘焙导航网格（耗时较长）。create_agent: 创建 NavigationAgent3D。set_params: 设置导航参数。create_link: 创建 NavigationLink3D。query_path: 查询 3D 导航路径。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          name: { type: 'string', description: 'create_region/create_agent/create_link: 节点名称' },
          parent: { type: 'string', description: 'create_region/create_agent/create_link: 父节点路径（默认 root）' },
          node_path: { type: 'string', description: 'bake_mesh/set_params: 目标节点路径' },
          position: {
            type: 'object',
            description: 'create_region: 位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          bake: { type: 'boolean', description: 'create_region: 是否立即烘焙导航网格（默认 false）' },
          target_position: {
            type: 'object',
            description: 'create_agent: 目标位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          path_desired_distance: { type: 'number', description: 'create_agent: 路径期望距离（默认 0.5）' },
          target_desired_distance: { type: 'number', description: 'create_agent: 目标期望距离（默认 1.0）' },
          avoidance_enabled: { type: 'boolean', description: 'create_agent: 是否启用避障（默认 false）' },
          params: {
            type: 'object',
            description: 'set_params: 导航参数（仅传入需要修改的字段）',
            properties: {
              path_desired_distance: { type: 'number' },
              target_desired_distance: { type: 'number' },
              radius: { type: 'number' },
              height: { type: 'number' },
              max_speed: { type: 'number' },
              avoidance_enabled: { type: 'boolean' },
              neighbor_distance: { type: 'number' },
              max_neighbors: { type: 'integer' },
              time_horizon_agents: { type: 'number' },
              time_horizon_obstacles: { type: 'number' },
            },
          },
          start_position: {
            type: 'object',
            description: 'create_link: 起始位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          end_position: {
            type: 'object',
            description: 'create_link: 终点位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          bidirectional: { type: 'boolean', description: 'create_link: 是否双向通行（默认 true）' },
          start_pos: {
            type: 'object',
            description: 'query_path: 起点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          end_pos: {
            type: 'object',
            description: 'query_path: 终点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          navigation_region: { type: 'string', description: 'query_path: NavigationRegion3D 节点路径（可选）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          // 2026-08-06 审查 P2：bake_mesh timeout 改可配（原硬编码 120s，大场景 bake 会超时 false-negative）
          timeout: { type: 'number', description: 'bake_mesh 烘焙超时秒数（默认 120，大场景可调至 600）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

// follow-up C5: 创造/改运行时导航节点树（NavigationRegion3D/Agent3D/Link3D + 烘焙 mesh + 参数）
// → 加提示；query_path 只读不加。
const NAV_PERSIST_ACTIONS = new Set(['create_region', 'bake_mesh', 'create_agent', 'set_params', 'create_link']);

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'nav') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;
    const paramWarnings: string[] = [];

    switch (action) {
      case 'create_region': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        if (!/^[A-Za-z0-9_]+$/.test(nodeName)) return opsErrorResult('INVALID_PARAMS', 'name must be a safe identifier (letters/digits/_ only, no "/")');  // IMP-5 (2026-06-26 review): 防 / 破坏 NodePath 语义
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const position = args.position ? validateVector3(args.position) : { x: 0, y: 0, z: 0 };
        const bake = args.bake === true;
        script = genCreateRegionScript(nodeName, parentPath, position, bake);
        break;
      }
      case 'bake_mesh': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genBakeMeshScript(nodePath);
        break;
      }
      case 'create_agent': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        if (!/^[A-Za-z0-9_]+$/.test(nodeName)) return opsErrorResult('INVALID_PARAMS', 'name must be a safe identifier (letters/digits/_ only, no "/")');  // IMP-5 (2026-06-26 review): 防 / 破坏 NodePath 语义
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const targetPosition = args.target_position ? validateVector3(args.target_position) : { x: 0, y: 0, z: 0 };
        const pathDesiredDistance = typeof args.path_desired_distance === 'number' ? args.path_desired_distance : 0.5;
        const targetDesiredDistance = typeof args.target_desired_distance === 'number' ? args.target_desired_distance : 1.0;
        const avoidanceEnabled = args.avoidance_enabled === true;
        script = genCreateAgentScript(nodeName, parentPath, targetPosition, pathDesiredDistance, targetDesiredDistance, avoidanceEnabled);
        break;
      }
      case 'set_params': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const rawParams = args.params as Record<string, unknown> | undefined;
        if (!rawParams || typeof rawParams !== 'object') {
          return opsErrorResult('INVALID_PARAMS', 'params must be a non-empty object');
        }
        const validKeys = [
          'path_desired_distance', 'target_desired_distance', 'radius', 'height',
          'max_speed', 'avoidance_enabled', 'neighbor_distance', 'max_neighbors',
          'time_horizon_agents', 'time_horizon_obstacles',
        ];
        const filteredParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rawParams)) {
          if (!validKeys.includes(key)) {
            paramWarnings.push(`Unknown param "${key}" ignored`);
            continue;
          }
          if (key === 'avoidance_enabled') {
            if (typeof value !== 'boolean') {
              paramWarnings.push(`Param "${key}" must be boolean, skipped`);
              continue;
            }
          } else if (key === 'max_neighbors') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
              paramWarnings.push(`Param "${key}" must be an integer, skipped`);
              continue;
            }
          } else {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              paramWarnings.push(`Param "${key}" must be a finite number, skipped`);
              continue;
            }
            if (value < 0) {
              paramWarnings.push(`Param "${key}" must be >= 0, got ${value}, skipped`);
              continue;
            }
          }
          filteredParams[key] = value;
        }
        if (Object.keys(filteredParams).length === 0) {
          return opsErrorResult('INVALID_PARAMS', 'No valid params provided');
        }
        script = genSetParamsScript(nodePath, filteredParams as Parameters<typeof genSetParamsScript>[1]);
        break;
      }
      case 'create_link': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        if (!/^[A-Za-z0-9_]+$/.test(nodeName)) return opsErrorResult('INVALID_PARAMS', 'name must be a safe identifier (letters/digits/_ only, no "/")');  // IMP-5 (2026-06-26 review): 防 / 破坏 NodePath 语义
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const startPosition = validateVector3(args.start_position);
        const endPosition = validateVector3(args.end_position);
        const bidirectional = args.bidirectional !== false;
        script = genCreateLinkScript(nodeName, parentPath, startPosition, endPosition, bidirectional);
        break;
      }
      case 'query_path': {
        const startPos = validateVector3(args.start_pos);
        const endPos = validateVector3(args.end_pos);
        const navRegion = args.navigation_region as string | undefined;
        const normalizedRegion = navRegion ? normalizeNodePath(navRegion) : undefined;
        script = genNavQueryScript(startPos, endPos, normalizedRegion);
        break;
      }
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    // Determine timeout: baking may take longer
    // 2026-08-06 审查 P2：bake_mesh timeout 改可配（原硬编码 120s 不可配，大场景 bake 会超时强杀 Godot false-negative）
    // 对齐 blender.ts:47+68 validateTimeout 模式；bake 默认 120s clamp 30-600，其他 action 仍 30s
    const timeoutSec = action === 'bake_mesh'
      ? validateTimeout(args.timeout, 30, 600, 120)
      : 30;

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return NAV_ERROR_CODES.NODE_NOT_FOUND;
      if (msg.includes('not a Navigation')) return NAV_ERROR_CODES.INVALID_PARAMS;
      if (msg.includes('bake')) return NAV_ERROR_CODES.BAKE_FAILED;
      return NAV_ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec,
      errorMapper, paramWarnings,
      warnRuntimePersist: NAV_PERSIST_ACTIONS.has(action), action: `nav_${action}` });
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ─────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  nav: {
    readonly: false,
    long_running: false,
    actionRisks: {
      query_path: 'read', create_region: 'write', bake_mesh: 'write',
      create_agent: 'write', set_params: 'write', create_link: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
