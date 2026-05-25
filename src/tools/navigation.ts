import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, normalizeNodePath, gdEscape, validateVector3 } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const NAV_ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_VECTOR: 'INVALID_VECTOR',
  INVALID_PARAMS: 'INVALID_PARAMS',
  BAKE_FAILED: 'BAKE_FAILED',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

const TOOL_NAMES = [
  'nav_create_region',
  'nav_bake_mesh',
  'nav_create_agent',
  'nav_set_params',
  'nav_create_link',
  'nav_query_path',
] as const;

// ─── GDScript Generators ──────────────────────────────────────────────────

function genCreateRegionScript(
  nodeName: string,
  parentPath: string,
  position: { x: number; y: number; z: number },
  bake: boolean,
): string {
  const bakeBlock = bake
    ? `\tvar bake_result = _nav.bake_navigation_mesh()
\tif not bake_result:
\t\t_mcp_output("warning", "Navigation mesh bake returned false — scene may lack geometry")`
    : '';

  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _nav = NavigationRegion3D.new()
\t_nav.name = "${gdEscape(nodeName)}"
\t_nav.position = Vector3(${position.x}, ${position.y}, ${position.z})
\tparent.add_child(_nav)
\t_nav.set_owner(_mcp_get_root())
\tvar _mesh = NavigationMesh.new()
\t_mesh.geometry_parsed_collision_mask = 0xFFFFFFFF
\t_nav.navigation_mesh = _mesh
${bakeBlock}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationRegion3D", "parent": "${gdEscape(parentPath)}", "baked": ${bake}})
\t_mcp_done()
`;
}

function genBakeMeshScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _nav = _mcp_get_node("${gdEscape(nodePath)}")
\tif _nav == null:
\t\t_mcp_output("error", "NavigationRegion3D not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_nav is NavigationRegion3D):
\t\t_mcp_output("error", "Node is not a NavigationRegion3D: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar bake_result = _nav.bake_navigation_mesh()
\tif not bake_result:
\t\t_mcp_output("warning", "Navigation mesh bake returned false — scene may lack geometry")
\t_mcp_output("baked", {"node": "${gdEscape(nodePath)}", "success": bake_result})
\t_mcp_done()
`;
}

function genCreateAgentScript(
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
\tvar parent = _mcp_get_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _agent = NavigationAgent3D.new()
\t_agent.name = "${gdEscape(nodeName)}"
\tparent.add_child(_agent)
\t_agent.set_owner(_mcp_get_root())
\t_agent.target_position = Vector3(${targetPosition.x}, ${targetPosition.y}, ${targetPosition.z})
\t_agent.path_desired_distance = ${pathDesiredDistance}
\t_agent.target_desired_distance = ${targetDesiredDistance}
\t_agent.avoidance_enabled = ${avoidanceEnabled}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationAgent3D", "parent": "${gdEscape(parentPath)}"})
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
\tvar _agent = _mcp_get_node("${gdEscape(nodePath)}")
\tif _agent == null:
\t\t_mcp_output("error", "NavigationAgent3D not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (_agent is NavigationAgent3D):
\t\t_mcp_output("error", "Node is not a NavigationAgent3D: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
${setBlock}
\t_mcp_output("updated", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

function genCreateLinkScript(
  nodeName: string,
  parentPath: string,
  startPosition: { x: number; y: number; z: number },
  endPosition: { x: number; y: number; z: number },
  bidirectional: boolean,
): string {
  return `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar parent = _mcp_get_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _link = NavigationLink3D.new()
\t_link.name = "${gdEscape(nodeName)}"
\tparent.add_child(_link)
\t_link.set_owner(_mcp_get_root())
\t_link.start_position = Vector3(${startPosition.x}, ${startPosition.y}, ${startPosition.z})
\t_link.end_position = Vector3(${endPosition.x}, ${endPosition.y}, ${endPosition.z})
\t_link.bidirectional = ${bidirectional}
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "type": "NavigationLink3D", "parent": "${gdEscape(parentPath)}", "bidirectional": ${bidirectional}})
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
    regionBlock = `\tvar region_node = _mcp_get_node("${gdEscape(navigationRegion)}")
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
      name: 'nav_create_region',
      description: `Create NavigationRegion3D with optional navigation mesh. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          position: {
            type: 'object',
            description: '位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          bake: { type: 'boolean', description: '是否立即烘焙导航网格（默认 false）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'name'],
      },
    },
    {
      name: 'nav_bake_mesh',
      description: `Bake navigation mesh for a NavigationRegion3D. This is a long-running operation. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'NavigationRegion3D 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'nav_create_agent',
      description: `Create NavigationAgent3D for pathfinding. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          target_position: {
            type: 'object',
            description: '目标位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          path_desired_distance: { type: 'number', description: '路径期望距离（默认 0.5）' },
          target_desired_distance: { type: 'number', description: '目标期望距离（默认 1.0）' },
          avoidance_enabled: { type: 'boolean', description: '是否启用避障（默认 false）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'name'],
      },
    },
    {
      name: 'nav_set_params',
      description: `Set navigation agent parameters. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'NavigationAgent3D 节点路径' },
          params: {
            type: 'object',
            description: '导航参数（仅传入需要修改的字段）',
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
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'params'],
      },
    },
    {
      name: 'nav_create_link',
      description: `Create NavigationLink3D for jump points or teleportation. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          start_position: {
            type: 'object',
            description: '起始位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          end_position: {
            type: 'object',
            description: '终点位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          bidirectional: { type: 'boolean', description: '是否双向通行（默认 true）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'name', 'start_position', 'end_position'],
      },
    },
    {
      name: 'nav_query_path',
      description: `Query 3D navigation path. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          start_pos: {
            type: 'object',
            description: '起点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          end_pos: {
            type: 'object',
            description: '终点 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
          },
          navigation_region: { type: 'string', description: 'NavigationRegion3D 节点路径（可选）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'start_pos', 'end_pos'],
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
    const paramWarnings: string[] = [];

    switch (name) {
      case 'nav_create_region': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const position = args.position ? validateVector3(args.position) : { x: 0, y: 0, z: 0 };
        const bake = args.bake === true;
        script = genCreateRegionScript(nodeName, parentPath, position, bake);
        break;
      }
      case 'nav_bake_mesh': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genBakeMeshScript(nodePath);
        break;
      }
      case 'nav_create_agent': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const targetPosition = args.target_position ? validateVector3(args.target_position) : { x: 0, y: 0, z: 0 };
        const pathDesiredDistance = typeof args.path_desired_distance === 'number' ? args.path_desired_distance : 0.5;
        const targetDesiredDistance = typeof args.target_desired_distance === 'number' ? args.target_desired_distance : 1.0;
        const avoidanceEnabled = args.avoidance_enabled === true;
        script = genCreateAgentScript(nodeName, parentPath, targetPosition, pathDesiredDistance, targetDesiredDistance, avoidanceEnabled);
        break;
      }
      case 'nav_set_params': {
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
      case 'nav_create_link': {
        const nodeName = args.name as string;
        if (!nodeName) return opsErrorResult('INVALID_PARAMS', 'name is required');
        const parentPath = normalizeNodePath((args.parent as string) || 'root');
        const startPosition = validateVector3(args.start_position);
        const endPosition = validateVector3(args.end_position);
        const bidirectional = args.bidirectional !== false;
        script = genCreateLinkScript(nodeName, parentPath, startPosition, endPosition, bidirectional);
        break;
      }
      case 'nav_query_path': {
        const startPos = validateVector3(args.start_pos);
        const endPos = validateVector3(args.end_pos);
        const navRegion = args.navigation_region as string | undefined;
        const normalizedRegion = navRegion ? normalizeNodePath(navRegion) : undefined;
        script = genNavQueryScript(startPos, endPos, normalizedRegion);
        break;
      }
      default:
        return null;
    }

    // Determine timeout: baking may take longer
    const timeout = name === 'nav_bake_mesh' ? 120 : 30;

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout,
      loadAutoloads,
    });

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return NAV_ERROR_CODES.NODE_NOT_FOUND;
      if (msg.includes('not a Navigation')) return NAV_ERROR_CODES.INVALID_PARAMS;
      if (msg.includes('bake')) return NAV_ERROR_CODES.BAKE_FAILED;
      return NAV_ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return parseGdscriptResult(result, paramWarnings, errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ─────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  nav_create_region: { readonly: false, long_running: false },
  nav_bake_mesh: { readonly: false, long_running: true },
  nav_create_agent: { readonly: false, long_running: false },
  nav_set_params: { readonly: false, long_running: false },
  nav_create_link: { readonly: false, long_running: false },
  nav_query_path: { readonly: true, long_running: false },
};
