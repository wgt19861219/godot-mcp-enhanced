import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const TYPE_WHITELIST = [
  'Node3D', 'MeshInstance3D', 'StaticBody3D', 'RigidBody3D',
  'CharacterBody3D', 'Camera3D', 'Light3D', 'DirectionalLight3D',
  'OmniLight3D', 'SpotLight3D', 'CollisionShape3D', 'RayCast3D',
  'Area3D', 'Marker3D', 'PathFollow3D', 'VisibleOnScreenNotifier3D',
] as const;

export const ERROR_CODES = {
  INVALID_PATH: 'INVALID_PATH',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  INVALID_VECTOR: 'INVALID_VECTOR',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
} as const;

// ─── Helper Utilities ─────────────────────────────────────────────────────

export function normalizeNodePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('NodePath cannot be empty');
  if (trimmed.startsWith('res://')) throw new Error('NodePath must be a scene tree path (root/...), not a resource path (res://...)');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

export function gdEscape(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '');
}

export function validateVector3(v: unknown): { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) throw new Error('Vector3 must be an object with x, y, z number fields');
  const obj = v as Record<string, unknown>;
  for (const key of ['x', 'y', 'z']) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) throw new Error(`Vector3 field "${key}" must be a finite number`);
  }
  return { x: obj.x as number, y: obj.y as number, z: obj.z as number };
}

// Internal helpers (not exported)

function clampParam(val: number | undefined, min: number, max: number, name: string, warnings: string[]): number | undefined {
  if (val === undefined) return undefined;
  if (val < min) { warnings.push(`${name} ${val} clamped to ${min}`); return min; }
  if (val > max) { warnings.push(`${name} ${val} clamped to ${max}`); return max; }
  return val;
}

// ─── GDScript Generators: Signals ──────────────────────────────────────────

export function genSignalConnectScript(
  sourcePath: string, signalName: string,
  targetPath: string, methodName: string, flags?: number
): string {
  const flagsArg = flags !== undefined ? `, ${flags}` : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar source = get_node("${gdEscape(sourcePath)}")
\tvar target = get_node("${gdEscape(targetPath)}")
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
\tvar source = get_node("${gdEscape(sourcePath)}")
\tvar target = get_node("${gdEscape(targetPath)}")
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
\tvar source = get_node("${gdEscape(sourcePath)}")
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
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar signals = node.get_signal_list()
\t_mcp_output("signals", signals)
\t_mcp_done()
`;
}

// ─── GDScript Generators: Physics / 3D / Navigation ─────────────────────────

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
\tvar space_state = get_root().get_viewport().get_world_3d().direct_space_state
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
\tvar body = get_node("${gdEscape(bodyPath)}")
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
\tvar parent = get_node("${gdEscape(parentPath)}")
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

export function genNavQueryScript(
  startPos: { x: number; y: number; z: number },
  endPos: { x: number; y: number; z: number },
  navigationRegion?: string
): string {
  let regionBlock: string;
  if (navigationRegion) {
    regionBlock = `\tvar region_node = get_node("${gdEscape(navigationRegion)}")
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

// ─── GDScript Generators: Audio ──────────────────────────────────────────────

export function genAudioPlayScript(
  nodePath: string, streamPath?: string, volumeDb?: number,
  pitchScale?: number, bus?: string, fromPosition?: number
): string {
  let streamLine = '';
  if (streamPath) {
    streamLine = `\n\tvar stream_res = load("${gdEscape(streamPath)}")\n\tif stream_res:\n\t\tnode.stream = stream_res`;
  }
  const fmtNum = (n: number) => Number.isInteger(n) ? n.toFixed(1) : String(n);
  const volLine = volumeDb !== undefined ? `\n\tnode.volume_db = ${volumeDb}` : '';
  const pitchLine = pitchScale !== undefined ? `\n\tnode.pitch_scale = ${fmtNum(pitchScale)}` : '';
  const busLine = bus ? `\n\tnode.bus = "${gdEscape(bus)}"` : '';
  const playArg = fromPosition !== undefined ? `(${fmtNum(fromPosition)})` : '()';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${streamLine}${volLine}${pitchLine}${busLine}
\tnode.play${playArg}
\t_mcp_output("playing", {"node": "${gdEscape(nodePath)}", "stream": str(node.stream) if node.stream else "None"})
\t_mcp_done()
`;
}

export function genAudioStopScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.stop()
\t_mcp_output("stopped", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genAudioSetParamScript(
  nodePath: string, param: 'volume_db' | 'pitch_scale' | 'bus', value: number | string
): string {
  const valStr = typeof value === 'string' ? `"${gdEscape(value)}"` : String(value);
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.${param} = ${valStr}
\t_mcp_output("param_set", {"node": "${gdEscape(nodePath)}", "param": "${param}", "value": ${valStr}})
\t_mcp_done()
`;
}

export function genAudioQueryScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tvar info = {}
\tinfo["playing"] = node.playing
\tinfo["volume_db"] = node.volume_db
\tinfo["pitch_scale"] = node.pitch_scale
\tinfo["bus"] = node.bus
\tinfo["stream"] = str(node.stream.resource_path) if node.stream else "None"
\tinfo["playback_position"] = node.get_playback_position() if node.playing else 0.0
\tinfo["stream_length"] = node.stream.get_length() if node.stream else 0.0
\tinfo["node_type"] = node.get_class()
\t_mcp_output("audio_info", info)
\t_mcp_done()
`;
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'signal_connect',
      description: `连接两个节点的信号。${NON_PERSIST}`,
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
      description: `断开两个节点之间的信号连接。${NON_PERSIST}`,
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
      description: `发射节点信号。args 仅支持基础类型（string/number/bool/null）。${NON_PERSIST}`,
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
      description: `列出节点上可用的信号。${NON_PERSIST}`,
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
    {
      name: 'physics_raycast',
      description: `执行 3D 射线检测。${NON_PERSIST}`,
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
      description: `获取物理体的碰撞信息。${NON_PERSIST}`,
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
      name: 'node_create_3d',
      description: `运行时创建 3D 节点。headless 创建的节点不持久化，持久化请用 add_node + save_scene。${NON_PERSIST}`,
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
    {
      name: 'nav_query_path',
      description: `查询 3D 导航路径。${NON_PERSIST}`,
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
    {
      name: 'audio_play',
      description: `播放音频。支持 AudioStreamPlayer/AudioStreamPlayer2D/AudioStreamPlayer3D 节点。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          stream_path: { type: 'string', description: '音频资源路径（res://...），不传则播放已配置的' },
          volume_db: { type: 'number', description: '音量（dB，-80 到 24）' },
          pitch_scale: { type: 'number', description: '音调缩放（0.01 到 100）' },
          bus: { type: 'string', description: '音频总线名称' },
          from_position: { type: 'number', description: '从指定位置开始播放（秒）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'audio_stop',
      description: `停止音频播放。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'audio_set_param',
      description: `设置音频参数（音量/音调/总线）。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          param: { type: 'string', enum: ['volume_db', 'pitch_scale', 'bus'], description: '参数名' },
          value: { description: '参数值（number for volume_db/pitch_scale, string for bus）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'param', 'value'],
      },
    },
    {
      name: 'audio_query',
      description: `查询音频播放状态。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = [
  'signal_connect', 'signal_disconnect', 'signal_emit', 'signal_list',
  'physics_raycast', 'physics_body_info', 'node_create_3d', 'nav_query_path',
  'audio_play', 'audio_stop', 'audio_set_param', 'audio_query',
] as const;

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
      case 'signal_connect': {
        const sourcePath = normalizeNodePath(args.source_path as string);
        const signalName = args.signal_name as string;
        const targetPath = normalizeNodePath(args.target_path as string);
        const methodName = args.method_name as string;
        const flags = args.flags as number | undefined;
        if (flags !== undefined && typeof flags !== 'number') return opsErrorResult('INVALID_SIGNAL', 'flags must be a number');
        if (!signalName || !methodName) return opsErrorResult('INVALID_SIGNAL', 'signal_name and method_name are required');
        script = genSignalConnectScript(sourcePath, signalName, targetPath, methodName, flags);
        break;
      }
      case 'signal_disconnect': {
        const sourcePath = normalizeNodePath(args.source_path as string);
        const signalName = args.signal_name as string;
        const targetPath = normalizeNodePath(args.target_path as string);
        const methodName = args.method_name as string;
        if (!signalName || !methodName) return opsErrorResult('INVALID_SIGNAL', 'signal_name and method_name are required');
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
      case 'node_create_3d': {
        const nodeType = args.type as string;
        const nodeName = args.name as string;
        if (!TYPE_WHITELIST.includes(nodeType as typeof TYPE_WHITELIST[number])) {
          return opsErrorResult('INVALID_TYPE', `Node type "${nodeType}" not in whitelist. Allowed: ${TYPE_WHITELIST.join(', ')}`);
        }
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
      case 'nav_query_path': {
        const startPos = validateVector3(args.start_pos);
        const endPos = validateVector3(args.end_pos);
        const navRegion = args.navigation_region as string | undefined;
        const normalizedRegion = navRegion ? normalizeNodePath(navRegion) : undefined;
        script = genNavQueryScript(startPos, endPos, normalizedRegion);
        break;
      }
      case 'audio_play': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const streamPath = args.stream_path as string | undefined;
        const volumeDb = args.volume_db as number | undefined;
        const pitchScale = args.pitch_scale as number | undefined;
        const bus = args.bus as string | undefined;
        const fromPosition = args.from_position as number | undefined;
        if (fromPosition !== undefined && (typeof fromPosition !== 'number' || !Number.isFinite(fromPosition) || fromPosition < 0)) {
          return opsErrorResult('INVALID_TYPE', 'from_position must be a non-negative finite number');
        }
        const clampVol = clampParam(volumeDb, -80, 24, 'volume_db', paramWarnings);
        const clampPitch = clampParam(pitchScale, 0.01, 100, 'pitch_scale', paramWarnings);
        script = genAudioPlayScript(nodePath, streamPath, clampVol, clampPitch, bus, fromPosition);
        break;
      }
      case 'audio_stop': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioStopScript(nodePath);
        break;
      }
      case 'audio_set_param': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const param = args.param as string;
        const value = args.value;
        if (!['volume_db', 'pitch_scale', 'bus'].includes(param)) {
          return opsErrorResult('INVALID_TYPE', 'param must be volume_db, pitch_scale, or bus');
        }
        if (param === 'bus' && typeof value !== 'string') {
          return opsErrorResult('INVALID_TYPE', 'bus param requires a string value');
        }
        if (param !== 'bus' && typeof value !== 'number') {
          return opsErrorResult('INVALID_TYPE', `${param} param requires a number value`);
        }
        script = genAudioSetParamScript(nodePath, param as 'volume_db' | 'pitch_scale' | 'bus', value as number | string);
        break;
      }
      case 'audio_query': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioQueryScript(nodePath);
        break;
      }
      default:
        return null;
    }

    // Execute the generated GDScript
    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const isAudio = name.startsWith('audio_');
    const errorMapper = isAudio
      ? (msg: string) => (msg.includes('not found') || msg.includes('not an Audio') ? ERROR_CODES.AUDIO_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED)
      : (msg: string) => (msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED);

    return parseGdscriptResult(result, paramWarnings, errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    if (msg.includes('Vector3')) return opsErrorResult('INVALID_VECTOR', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}
