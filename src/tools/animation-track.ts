import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';
import { TRACK_TYPES, ensureNumber, valueToGd, animErrorMapper } from './animation-shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['animation_track', 'animation_keyframe', 'animation_curve'] as const;

export { TOOL_NAMES };

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'animation_track',
      description:
        '添加或移除动画轨道。支持 9 种轨道类型：value, position_3d, rotation_3d, scale_3d, blend_shape, method, bezier, audio, animation。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径' },
          animation_name: { type: 'string', description: '动画名称' },
          action: {
            type: 'string',
            enum: ['add', 'remove'],
            description: '操作类型：add 添加轨道，remove 移除轨道',
          },
          track_type: {
            type: 'string',
            enum: [...TRACK_TYPES],
            description: '轨道类型（add 时必填）',
          },
          track_path: { type: 'string', description: '轨道路径，如 "Sprite2D:frame"（add 时可选）' },
          track_index: { type: 'number', description: '轨道索引（remove 时必填）' },
          insert_at: { type: 'number', description: '轨道插入位置，-1 为末尾（add 时可选）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'animation_name', 'action'],
      },
    },
    {
      name: 'animation_keyframe',
      description:
        '添加、移除或更新动画关键帧。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径' },
          animation_name: { type: 'string', description: '动画名称' },
          action: {
            type: 'string',
            enum: ['add', 'remove', 'update'],
            description: '操作类型',
          },
          track_index: { type: 'number', description: '轨道索引' },
          time: { type: 'number', description: '关键帧时间（秒）' },
          value: { description: '关键帧值（add/update 时使用）' },
          transition: { type: 'number', description: '过渡曲线，1.0=线性' },
          keyframe_index: { type: 'number', description: '关键帧索引（remove/update 时必填）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'animation_name', 'action', 'track_index'],
      },
    },
    {
      name: 'animation_curve',
      description:
        '设置动画关键帧的贝塞尔曲线控制柄（in_handle / out_handle）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径' },
          animation_name: { type: 'string', description: '动画名称' },
          track_index: { type: 'number', description: '轨道索引' },
          keyframe_index: { type: 'number', description: '关键帧索引' },
          in_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '入控制柄坐标（可选）',
          },
          out_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '出控制柄坐标（可选）',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'animation_name', 'track_index', 'keyframe_index'],
      },
    },
  ];
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genAnimationTrackAdd(nodePath: string, animName: string, trackType: string, trackPath: string | undefined, insertAt: number | undefined): string {
  const typeMap: Record<string, number> = {
    value: 0, position_3d: 1, rotation_3d: 2, scale_3d: 3,
    blend_shape: 4, method: 5, bezier: 6, audio: 7, animation: 8,
  };
  const typeVal = typeMap[trackType] ?? 0;
  const insertLine = insertAt !== undefined && insertAt >= 0
    ? `_anim.add_track(${typeVal}, ${insertAt})`
    : `_anim.add_track(${typeVal})`;
  const pathLine = trackPath
    ? `\n\t_anim.track_set_path(_idx, NodePath("${gdEscape(trackPath)}"))`
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
\t${insertLine}
\tvar _idx: int = _anim.get_track_count() - 1${pathLine}
\t_mcp_output("result", {"track_index": _idx, "track_type": ${typeVal}})
\t_mcp_done()
`;
}

function genAnimationTrackRemove(nodePath: string, animName: string, trackIdx: number): string {
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

function genAnimationKeyframeAdd(nodePath: string, animName: string, trackIdx: number, time: number, value: unknown, transition: number | undefined): string {
  const transStr = transition ?? 1.0;
  const valueStr = value !== undefined ? valueToGd(value) : 'null';
  const rotValueStr = value !== undefined && Array.isArray(value) && value.length === 3
    ? `Quaternion.from_euler(Vector3(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])}))`
    : valueStr;
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
\t_mcp_output("result", {"keyframe_index": _kf_idx, "time": ${time}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationKeyframeRemove(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string {
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

function genAnimationKeyframeUpdate(nodePath: string, animName: string, trackIdx: number, kfIdx: number, value: unknown, transition: number | undefined): string {
  const valueLine = value !== undefined
    ? `\t_anim.track_set_key_value(${trackIdx}, ${kfIdx}, ${valueToGd(value)})`
    : '';
  const transLine = transition !== undefined
    ? `\t_anim.track_set_key_transition(${trackIdx}, ${kfIdx}, ${transition})`
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
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
${valueLine}
${transLine}
\t_mcp_output("result", {"updated_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationCurve(nodePath: string, animName: string, trackIdx: number, kfIdx: number, inHandle: { x: number; y: number } | undefined, outHandle: { x: number; y: number } | undefined): string {
  const inLine = inHandle
    ? `\t_anim.track_set_key_in_handle(${trackIdx}, ${kfIdx}, Vector2(${inHandle.x}, ${inHandle.y}))`
    : '';
  const outLine = outHandle
    ? `\t_anim.track_set_key_out_handle(${trackIdx}, ${kfIdx}, Vector2(${outHandle.x}, ${outHandle.y}))`
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
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
${inLine}
${outLine}
\t_mcp_output("result", {"track_index": ${trackIdx}, "keyframe_index": ${kfIdx}, "in_handle": ${inHandle ? `Vector2(${inHandle.x}, ${inHandle.y})` : 'null'}, "out_handle": ${outHandle ? `Vector2(${outHandle.x}, ${outHandle.y})` : 'null'}})
\t_mcp_done()
`;
}

// Export generators for testing
export {
  genAnimationTrackAdd,
  genAnimationTrackRemove,
  genAnimationKeyframeAdd,
  genAnimationKeyframeRemove,
  genAnimationKeyframeUpdate,
  genAnimationCurve,
};

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
      // ── animation_track tool ──
      case 'animation_track': {
        const nodePath = normalizeNodePath((args.node_path as string) ?? '');
        const animName = (args.animation_name as string) ?? '';
        const action = args.action as string;
        if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');

        if (action === 'add') {
          if (!args.track_type) return opsErrorResult('INVALID_PARAMS', 'track_type required for add');
          code = genAnimationTrackAdd(nodePath, animName, args.track_type as string, args.track_path as string | undefined,
            args.insert_at !== undefined ? ensureNumber(args.insert_at, 'insert_at') : undefined);
        } else if (action === 'remove') {
          if (args.track_index === undefined) return opsErrorResult('INVALID_PARAMS', 'track_index required for remove');
          code = genAnimationTrackRemove(nodePath, animName, ensureNumber(args.track_index, 'track_index'));
        } else {
          return opsErrorResult('INVALID_PARAMS', 'action must be "add" or "remove"');
        }
        break;
      }

      // ── animation_keyframe tool ──
      case 'animation_keyframe': {
        const nodePath = normalizeNodePath((args.node_path as string) ?? '');
        const animName = (args.animation_name as string) ?? '';
        const action = args.action as string;
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');

        if (action === 'add') {
          if (args.time === undefined) return opsErrorResult('INVALID_PARAMS', 'time required for add');
          code = genAnimationKeyframeAdd(nodePath, animName, trackIdx, ensureNumber(args.time, 'time'), args.value,
            args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        } else if (action === 'remove') {
          if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for remove');
          code = genAnimationKeyframeRemove(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'));
        } else if (action === 'update') {
          if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for update');
          code = genAnimationKeyframeUpdate(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'),
            args.value,
            args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        } else {
          return opsErrorResult('INVALID_PARAMS', 'action must be "add", "remove", or "update"');
        }
        break;
      }

      // ── animation_curve tool ──
      case 'animation_curve': {
        const nodePath = normalizeNodePath((args.node_path as string) ?? '');
        const animName = (args.animation_name as string) ?? '';
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        const kfIdx = args.keyframe_index !== undefined ? ensureNumber(args.keyframe_index, 'keyframe_index') : -1;
        if (!nodePath || !animName || trackIdx < 0 || kfIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index, keyframe_index required');

        const rawIn = args.in_handle as { x?: number; y?: number } | undefined;
        const rawOut = args.out_handle as { x?: number; y?: number } | undefined;
        const inHandle = rawIn && rawIn.x !== undefined && rawIn.y !== undefined
          ? { x: ensureNumber(rawIn.x, 'in_handle.x'), y: ensureNumber(rawIn.y, 'in_handle.y') }
          : undefined;
        const outHandle = rawOut && rawOut.x !== undefined && rawOut.y !== undefined
          ? { x: ensureNumber(rawOut.x, 'out_handle.x'), y: ensureNumber(rawOut.y, 'out_handle.y') }
          : undefined;

        code = genAnimationCurve(nodePath, animName, trackIdx, kfIdx, inHandle, outHandle);
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
  animation_track: { readonly: false, long_running: false },
  animation_keyframe: { readonly: false, long_running: false },
  animation_curve: { readonly: false, long_running: false },
};
