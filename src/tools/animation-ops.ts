import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape, validateIdentifier } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';
import { ANIM_ERROR_CODES, LOOP_MODES, TRACK_TYPES, ensureNumber, valueToGd, argsToGd, animErrorMapper } from './animation-shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['animation', 'animation_blend'] as const;

export { TOOL_NAMES };

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'animation',
      description:
        '查询、控制和编辑动画。查询: list_players, get_info, get_details, get_keyframes。播放: play, stop, seek。编辑: create, delete, update_props, add_track, remove_track, add_keyframe, remove_keyframe, update_keyframe。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [
              'list_players', 'get_info', 'get_details', 'get_keyframes',
              'play', 'stop', 'seek',
              'create', 'delete', 'update_props',
              'add_track', 'remove_track',
              'add_keyframe', 'remove_keyframe', 'update_keyframe',
            ],
            description: '操作类型',
          },
          root_path: { type: 'string', description: '搜索起始节点路径（list_players）' },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径（除 list_players 外必填）' },
          animation_name: { type: 'string', description: '动画名称' },
          library_name: { type: 'string', description: '动画库名称（create/delete）' },
          track_index: { type: 'number', description: '轨道索引' },
          track_type: { type: 'string', enum: [...TRACK_TYPES], description: '轨道类型（add_track）' },
          track_path: { type: 'string', description: '轨道路径，如 "Sprite2D:frame"（add_track）' },
          insert_at: { type: 'number', description: '轨道插入位置，-1 为末尾（add_track）' },
          keyframe_index: { type: 'number', description: '关键帧索引' },
          time: { type: 'number', description: '关键帧时间（秒）' },
          value: { description: '关键帧值' },
          transition: { type: 'number', description: '过渡曲线，1.0=线性' },
          method_name: { type: 'string', description: '方法名（method 轨道）' },
          args: { type: 'array', items: {}, description: '方法参数' },
          length: { type: 'number', description: '动画长度（秒）' },
          loop_mode: { type: 'string', enum: [...LOOP_MODES], description: '循环模式' },
          step: { type: 'number', description: '关键帧对齐步进值' },
          custom_blend: { type: 'number', description: '自定义混合时间，-1 为默认（play）' },
          custom_speed: { type: 'number', description: '播放速度，默认 1.0（play）' },
          from_end: { type: 'boolean', description: '从末尾开始播放（play）' },
          keep_state: { type: 'boolean', description: '停止时保持状态（stop）' },
          seconds: { type: 'number', description: '跳转位置（秒）（seek）' },
          update: { type: 'boolean', description: '跳转后立即更新节点（seek）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'action'],
      },
    },
    {
      name: 'animation_blend',
      description:
        '使用 AnimationPlayer.play() 的自定义混合时间播放动画，实现动画间的线性插值混合。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径' },
          animation_name: { type: 'string', description: '动画名称' },
          blend_time: { type: 'number', description: '混合过渡时间（秒）' },
          speed: { type: 'number', description: '播放速度，默认 1.0' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'animation_name', 'blend_time'],
      },
    },
  ];
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genListPlayers(rootPath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _search_root: Node = _root
\tif "${gdEscape(rootPath)}" != "":
\t\t_search_root = _mcp_get_node("${gdEscape(rootPath)}")
\t\tif _search_root == null:
\t\t\t_mcp_output("error", "Node not found: ${gdEscape(rootPath)}")
\t\t\t_mcp_done()
\t\t\treturn
\tvar _players: Array = []
\tvar _stack: Array = [_search_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node = _stack.pop_back()
\t\tif _n is AnimationPlayer:
\t\t\t_players.append({"path": str(_n.get_path()).trim_prefix("/root/"), "name": _n.name})
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("animation_players", _players)
\t_mcp_done()
`;
}

function genGetInfo(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _info: Dictionary = {}
\t_info["current_animation"] = _ap.current_animation
\t_info["is_playing"] = _ap.is_playing()
\t_info["current_position"] = _ap.current_animation_position
\t_info["speed_scale"] = _ap.speed_scale
\t_info["autoplay"] = _ap.autoplay
\tvar _libs: Dictionary = {}
\tfor _lib_name in _ap.get_animation_library_list():
\t\tvar _lib: AnimationLibrary = _ap.get_animation_library(_lib_name)
\t\tvar _anim_names: Array = _lib.get_animation_list()
\t\t_libs[_lib_name] = _anim_names
\t_info["libraries"] = _libs
\t_info["animation_count"] = _ap.get_animation_list().size()
\t_mcp_output("player_info", _info)
\t_mcp_done()
`;
}

function genGetDetails(nodePath: string, animName: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = null
\tfor _lib_name in _ap.get_animation_library_list():
\t\tvar _lib: AnimationLibrary = _ap.get_animation_library(_lib_name)
\t\tif _lib.has_animation("${gdEscape(animName)}"):
\t\t\t_anim = _lib.get_animation("${gdEscape(animName)}")
\t\t\tbreak
\tif _anim == null and _ap.has_animation("${gdEscape(animName)}"):
\t\t_anim = _ap.get_animation("${gdEscape(animName)}")
\tif _anim == null:
\t\t_mcp_output("error", "Animation not found: ${gdEscape(animName)}")
\t\t_mcp_done()
\t\treturn
\tvar _details: Dictionary = {}
\t_details["name"] = "${gdEscape(animName)}"
\t_details["length"] = _anim.length
\t_details["loop_mode"] = _anim.loop_mode
\t_details["step"] = _anim.step
\t_details["track_count"] = _anim.get_track_count()
\tvar _tracks: Array = []
\tfor _i in range(_anim.get_track_count()):
\t\tvar _td: Dictionary = {}
\t\t_td["index"] = _i
\t\t_td["type"] = _anim.track_get_type(_i)
\t\t_td["path"] = str(_anim.track_get_path(_i))
\t\t_td["interpolation"] = _anim.track_get_interpolation_type(_i)
\t\t_td["keyframe_count"] = _anim.track_get_key_count(_i)
\t\t_tracks.append(_td)
\t_details["tracks"] = _tracks
\t_mcp_output("animation_details", _details)
\t_mcp_done()
`;
}

function genGetKeyframes(nodePath: string, animName: string, trackIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = null
\tfor _lib_name in _ap.get_animation_library_list():
\t\tvar _lib: AnimationLibrary = _ap.get_animation_library(_lib_name)
\t\tif _lib.has_animation("${gdEscape(animName)}"):
\t\t\t_anim = _lib.get_animation("${gdEscape(animName)}")
\t\t\tbreak
\tif _anim == null and _ap.has_animation("${gdEscape(animName)}"):
\t\t_anim = _ap.get_animation("${gdEscape(animName)}")
\tif _anim == null:
\t\t_mcp_output("error", "Animation not found: ${gdEscape(animName)}")
\t\t_mcp_done()
\t\treturn
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range: ${trackIdx}")
\t\t_mcp_done()
\t\treturn
\tvar _kf_count: int = _anim.track_get_key_count(${trackIdx})
\tvar _keyframes: Array = []
\tfor _i in range(_kf_count):
\t\tvar _kd: Dictionary = {}
\t\t_kd["time"] = _anim.track_get_key_time(${trackIdx}, _i)
\t\t_kd["transition"] = _anim.track_get_key_transition(${trackIdx}, _i)
\t\tvar _tt: int = _anim.track_get_type(${trackIdx})
\t\tif _tt == Animation.TYPE_VALUE or _tt == Animation.TYPE_BEZIER:
\t\t\t_kd["value"] = var_to_str(_anim.track_get_key_value(${trackIdx}, _i))
\t\telif _tt == Animation.TYPE_METHOD:
\t\t\tvar _md: Dictionary = _anim.track_get_key_value(${trackIdx}, _i)
\t\t\t_kd["method"] = _md.get("method", "")
\t\t\t_kd["args"] = _md.get("args", [])
\t\t_keyframes.append(_kd)
\t_mcp_output("keyframes", {"track_index": ${trackIdx}, "track_path": str(_anim.track_get_path(${trackIdx})), "track_type": _anim.track_get_type(${trackIdx}), "keyframes": _keyframes})
\t_mcp_done()
`;
}

function genPlay(nodePath: string, animName: string, customBlend?: number, customSpeed?: number, fromEnd?: boolean): string {
  const blendLine = customBlend !== undefined
    ? `_ap.play("${gdEscape(animName)}", ${customBlend < 0 ? '-1.0' : customBlend}, ${customSpeed ?? 1.0}, ${fromEnd ? 'true' : 'false'})`
    : `_ap.play("${gdEscape(animName)}")`;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\t${blendLine}
\t_mcp_output("result", {"playing": "${gdEscape(animName)}", "from_position": _ap.current_animation_position})
\t_mcp_done()
`;
}

function genStop(nodePath: string, keepState?: boolean): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\t_ap.stop(${keepState ? 'true' : 'false'})
\t_mcp_output("result", {"stopped": true})
\t_mcp_done()
`;
}

function genSeek(nodePath: string, seconds: number, update?: boolean): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\t_ap.seek(${seconds}, ${update ? 'true' : 'false'})
\t_mcp_output("result", {"position": ${seconds}})
\t_mcp_done()
`;
}

function genCreate(nodePath: string, animName: string, libraryName?: string, length?: number, loopMode?: string, step?: number): string {
  const loopMap: Record<string, number> = { none: 0, linear: 1, pingpong: 2 };
  const loopVal = loopMode ? loopMap[loopMode] ?? 0 : 0;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tvar _new_anim: Animation = Animation.new()
\t_new_anim.length = ${length ?? 1.0}
\t_new_anim.loop_mode = ${loopVal}
\t_new_anim.step = ${step ?? 0.1}
\tvar _lib_name: String = "${gdEscape(libraryName ?? '')}"
\tif _lib_name != "" and _ap.has_animation_library(_lib_name):
\t\tvar _lib: AnimationLibrary = _ap.get_animation_library(_lib_name)
\t\t_lib.add_animation("${gdEscape(animName)}", _new_anim)
\telse:
\t\tif not _ap.has_animation_library(""):
\t\t\t_ap.add_animation_library("", AnimationLibrary.new())
\t\tvar _default_lib: AnimationLibrary = _ap.get_animation_library("")
\t\t_default_lib.add_animation("${gdEscape(animName)}", _new_anim)
\t_mcp_output("result", {"created": "${gdEscape(animName)}", "library": _lib_name})
\t_mcp_done()
`;
}

function genDelete(nodePath: string, animName: string, libraryName?: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tvar _lib_name: String = "${gdEscape(libraryName ?? '')}"
\tif _lib_name != "" and _ap.has_animation_library(_lib_name):
\t\tvar _lib: AnimationLibrary = _ap.get_animation_library(_lib_name)
\t\t_lib.remove_animation("${gdEscape(animName)}")
\telif _ap.has_animation("${gdEscape(animName)}"):
\t\t_ap.remove_animation("${gdEscape(animName)}")
\telse:
\t\t_mcp_output("error", "Animation not found: ${gdEscape(animName)}")
\t\t_mcp_done()
\t\treturn
\t_mcp_output("result", {"deleted": "${gdEscape(animName)}"})
\t_mcp_done()
`;
}

function genUpdateProps(nodePath: string, animName: string, length?: number, loopMode?: string, step?: number): string {
  const loopMap: Record<string, number> = { none: 0, linear: 1, pingpong: 2 };
  const loopVal = loopMode ? loopMap[loopMode] ?? 0 : -1;
  const lengthLine = length !== undefined ? `\t_anim.length = ${length}` : '';
  const loopLine = loopMode !== undefined ? `\t_anim.loop_mode = ${loopVal}` : '';
  const stepLine = step !== undefined ? `\t_anim.step = ${step}` : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found: ${gdEscape(animName)}")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
${lengthLine}
${loopLine}
${stepLine}
\t_mcp_output("result", {"updated": "${gdEscape(animName)}", "length": _anim.length, "loop_mode": _anim.loop_mode, "step": _anim.step})
\t_mcp_done()
`;
}

function genAddTrack(nodePath: string, animName: string, trackType: string, trackPath: string, insertAt?: number): string {
  const typeMap: Record<string, number> = {
    value: 0, position_3d: 1, rotation_3d: 2, scale_3d: 3,
    blend_shape: 4, method: 5, bezier: 6, audio: 7, animation: 8,
  };
  const typeVal = typeMap[trackType] ?? 0;
  const insertLine = insertAt !== undefined && insertAt >= 0
    ? `_anim.add_track(${typeVal}, ${insertAt})`
    : `_anim.add_track(${typeVal})`;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\t${insertLine}
\tvar _idx: int = _anim.get_track_count() - 1
\t_anim.track_set_path(_idx, NodePath("${gdEscape(trackPath)}"))
\t_mcp_output("result", {"track_index": _idx, "track_path": "${gdEscape(trackPath)}", "track_type": "${gdEscape(trackType)}"})
\t_mcp_done()
`;
}

function genRemoveTrack(nodePath: string, animName: string, trackIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\t_anim.remove_track(${trackIdx})
\t_mcp_output("result", {"removed_track": ${trackIdx}})
\t_mcp_done()
`;
}

function genAddKeyframe(nodePath: string, animName: string, trackIdx: number, time: number, value?: unknown, transition?: number, methodName?: string, args?: unknown[]): string {
  if (methodName) validateIdentifier(methodName, 'method_name');
  const transStr = transition ?? 1.0;
  const valueStr = value !== undefined ? valueToGd(value) : 'null';
  const rotValueStr = value !== undefined && Array.isArray(value) && value.length === 3
    ? `Quaternion.from_euler(Vector3(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])}))`
    : valueStr;
  const methodBlock = methodName
    ? `\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_METHOD:\n\t\tvar _md: Dictionary = {"method": "${gdEscape(methodName)}", "args": ${argsToGd(args)}}\n\t\t_anim.track_insert_key(${trackIdx}, ${time}, _md, ${transStr})`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tvar _kf_idx: int = -1
\tif _anim.track_get_type(${trackIdx}) == Animation.TYPE_VALUE or _anim.track_get_type(${trackIdx}) == Animation.TYPE_BEZIER:
\t\t_kf_idx = _anim.track_insert_key(${trackIdx}, ${time}, ${valueStr}, ${transStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_POSITION_3D:
\t\t_kf_idx = _anim.position_track_insert_key(${trackIdx}, ${time}, ${valueStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_ROTATION_3D:
\t\t_kf_idx = _anim.rotation_track_insert_key(${trackIdx}, ${time}, ${rotValueStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_SCALE_3D:
\t\t_kf_idx = _anim.scale_track_insert_key(${trackIdx}, ${time}, ${valueStr})
${methodBlock}
\t_mcp_output("result", {"keyframe_index": _kf_idx, "time": ${time}})
\t_mcp_done()
`;
}

function genRemoveKeyframe(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
\t_anim.track_remove_key(${trackIdx}, ${kfIdx})
\t_mcp_output("result", {"removed_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genUpdateKeyframe(nodePath: string, animName: string, trackIdx: number, kfIdx: number, time?: number, value?: unknown, transition?: number): string {
  const timeLine = time !== undefined ? `\t_anim.track_set_key_time(${trackIdx}, ${kfIdx}, ${time})` : '';
  const valueLine = value !== undefined
    ? `\tvar _tt: int = _anim.track_get_type(${trackIdx})
\tif _tt == Animation.TYPE_ROTATION_3D:
\t\t_anim.track_set_key_value(${trackIdx}, ${kfIdx}, ${valueToGd(value, 'rotation_3d')})
\telse:
\t\t_anim.track_set_key_value(${trackIdx}, ${kfIdx}, ${valueToGd(value)})`
    : '';
  const transLine = transition !== undefined ? `\t_anim.track_set_key_transition(${trackIdx}, ${kfIdx}, ${transition})` : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
${timeLine}
${valueLine}
${transLine}
\t_mcp_output("result", {"updated_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationBlend(nodePath: string, animName: string, blendTime: number, speed: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${gdEscape(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\t_ap.play("${gdEscape(animName)}", ${blendTime}, ${speed}, false)
\t_mcp_output("result", {"playing": "${gdEscape(animName)}", "blend_time": ${blendTime}, "speed": ${speed}})
\t_mcp_done()
`;
}

// Export genAnimationBlend for testing
export { genAnimationBlend };

// Re-export from animation-track for backward compatibility (tests)
export {
  genAnimationTrackAdd,
  genAnimationTrackRemove,
  genAnimationKeyframeAdd,
  genAnimationKeyframeRemove,
  genAnimationKeyframeUpdate,
  genAnimationCurve,
} from './animation-track.js';

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const loadAutoloads = (args.load_autoloads as boolean) !== false;
    const godotPath = await ctx.findGodot();

    let code: string;

    switch (name) {
      // ── Original `animation` tool (action-based) ──
      case 'animation': {
        const action = args.action as string;
        const nodePath = args.node_path ? normalizeNodePath(args.node_path as string) : '';
        const animName = (args.animation_name as string) ?? '';

        switch (action) {
          case 'list_players':
            code = genListPlayers((args.root_path as string) ?? '');
            break;
          case 'get_info':
            if (!nodePath) return opsErrorResult('INVALID_PARAMS', 'node_path required for get_info');
            code = genGetInfo(nodePath);
            break;
          case 'get_details':
            if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
            code = genGetDetails(nodePath, animName);
            break;
          case 'get_keyframes':
            if (!nodePath || !animName || args.track_index === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
            code = genGetKeyframes(nodePath, animName, ensureNumber(args.track_index, 'track_index'));
            break;
          case 'play':
            if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
            code = genPlay(nodePath, animName,
              args.custom_blend !== undefined ? ensureNumber(args.custom_blend, 'custom_blend') : undefined,
              args.custom_speed !== undefined ? ensureNumber(args.custom_speed, 'custom_speed') : undefined,
              args.from_end as boolean | undefined);
            break;
          case 'stop':
            if (!nodePath) return opsErrorResult('INVALID_PARAMS', 'node_path required for stop');
            code = genStop(nodePath, args.keep_state as boolean | undefined);
            break;
          case 'seek':
            if (!nodePath || args.seconds === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path and seconds required');
            code = genSeek(nodePath, ensureNumber(args.seconds, 'seconds'), args.update as boolean | undefined);
            break;
          case 'create':
            if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
            code = genCreate(nodePath, animName, args.library_name as string | undefined,
              args.length !== undefined ? ensureNumber(args.length, 'length') : undefined,
              args.loop_mode as string | undefined,
              args.step !== undefined ? ensureNumber(args.step, 'step') : undefined);
            break;
          case 'delete':
            if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
            code = genDelete(nodePath, animName, args.library_name as string | undefined);
            break;
          case 'update_props':
            if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
            code = genUpdateProps(nodePath, animName,
              args.length !== undefined ? ensureNumber(args.length, 'length') : undefined,
              args.loop_mode as string | undefined,
              args.step !== undefined ? ensureNumber(args.step, 'step') : undefined);
            break;
          case 'add_track':
            if (!nodePath || !animName || !args.track_type || !args.track_path) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_type, track_path required');
            code = genAddTrack(nodePath, animName, args.track_type as string, args.track_path as string,
              args.insert_at !== undefined ? ensureNumber(args.insert_at, 'insert_at') : undefined);
            break;
          case 'remove_track':
            if (!nodePath || !animName || args.track_index === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
            code = genRemoveTrack(nodePath, animName, ensureNumber(args.track_index, 'track_index'));
            break;
          case 'add_keyframe':
            if (!nodePath || !animName || args.track_index === undefined || args.time === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index, time required');
            code = genAddKeyframe(nodePath, animName, ensureNumber(args.track_index, 'track_index'), ensureNumber(args.time, 'time'), args.value,
              args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined,
              args.method_name as string | undefined, args.args as unknown[] | undefined);
            break;
          case 'remove_keyframe':
            if (!nodePath || !animName || args.track_index === undefined || args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index, keyframe_index required');
            code = genRemoveKeyframe(nodePath, animName, ensureNumber(args.track_index, 'track_index'), ensureNumber(args.keyframe_index, 'keyframe_index'));
            break;
          case 'update_keyframe':
            if (!nodePath || !animName || args.track_index === undefined || args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index, keyframe_index required');
            code = genUpdateKeyframe(nodePath, animName, ensureNumber(args.track_index, 'track_index'), ensureNumber(args.keyframe_index, 'keyframe_index'),
              args.time !== undefined ? ensureNumber(args.time, 'time') : undefined,
              args.value,
              args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
            break;
          default:
            return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
        }
        break;
      }

      // ── animation_blend tool ──
      case 'animation_blend': {
        const nodePath = normalizeNodePath((args.node_path as string) ?? '');
        const animName = (args.animation_name as string) ?? '';
        if (!nodePath || !animName || args.blend_time === undefined) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, blend_time required');
        const blendTime = ensureNumber(args.blend_time, 'blend_time');
        const speed = args.speed !== undefined ? ensureNumber(args.speed, 'speed') : 1.0;
        code = genAnimationBlend(nodePath, animName, blendTime, speed);
        break;
      }

      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout: 30,
      loadAutoloads,
    });

    return parseGdscriptResult(result, [], animErrorMapper);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  animation: { readonly: false, long_running: false },
  animation_blend: { readonly: false, long_running: false },
};
