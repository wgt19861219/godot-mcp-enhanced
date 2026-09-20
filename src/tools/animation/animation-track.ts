import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { executeGdscriptRuntime as executeGdscript } from '../../gdscript-executor.js';
import { normalizeNodePath, escapeForGdLiteral } from '../shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from '../shared.js';
import {
  TRACK_TYPES, ensureNumber, valueToGd, animErrorMapper,
  animPreamble, trackRangeGuard, keyframeRangeGuard,
  genRemoveTrackScript as genAnimationTrackRemove,
  genRemoveKeyframeScript as genAnimationKeyframeRemove,
} from './animation-shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['animation_track'] as const;

export { TOOL_NAMES };

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'animation_track',
      description:
        '动画轨道与关键帧操作。轨道: add_track, remove_track。关键帧: add_keyframe, remove_keyframe, update_keyframe。曲线: set_curve。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: ['add_track', 'remove_track', 'add_keyframe', 'remove_keyframe', 'update_keyframe', 'set_curve'],
            description: '操作类型。add_track/remove_track=增删轨道, add_keyframe/remove_keyframe/update_keyframe=关键帧增删改, set_curve=设贝塞尔曲线',
          },
          node_path: { type: 'string', description: 'AnimationPlayer 节点路径' },
          animation_name: { type: 'string', description: '动画名称' },
          track_type: {
            type: 'string',
            enum: [...TRACK_TYPES],
            description: '轨道类型（add_track 时必填）',
          },
          track_path: { type: 'string', description: '轨道路径，如 "Sprite2D:frame"（add_track 时可选）' },
          track_index: { type: 'number', description: '轨道索引' },
          insert_at: { type: 'number', description: '轨道插入位置，-1 为末尾（add_track 时可选）' },
          keyframe_index: { type: 'number', description: '关键帧索引（remove_keyframe/update_keyframe/set_curve 时必填）' },
          time: { type: 'number', description: '关键帧时间（秒）（add_keyframe 时必填）' },
          value: { description: '关键帧值（add_keyframe/update_keyframe）' },
          transition: { type: 'number', description: '过渡曲线，1.0=线性' },
          in_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '入控制柄坐标（set_curve）',
          },
          out_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '出控制柄坐标（set_curve）',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action'],
      },
    },
  ];
}



// ─── GDScript Generators ───────────────────────────────────────────────────

function genAnimationTrackAdd(nodePath: string, animName: string, trackType: string, trackPath: string | undefined, insertAt: number | undefined): string {
  // TRACK_TYPES 常量顺序与 Godot TrackType 枚举值一致;非法类型回退 0(value),
  // 保留原 typeMap[trackType] ?? 0 的防御语义(输出零漂移约束)。
  const typeIdx = (TRACK_TYPES as readonly string[]).indexOf(trackType);
  const typeVal = typeIdx >= 0 ? typeIdx : 0;
  const insertLine = insertAt !== undefined && insertAt >= 0
    ? `_anim.add_track(${typeVal}, ${insertAt})`
    : `_anim.add_track(${typeVal})`;
  const pathLine = trackPath
    ? `\n\t_anim.track_set_path(_idx, NodePath("${escapeForGdLiteral(trackPath)}"))`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
\t${insertLine}
\tvar _idx: int = _anim.get_track_count() - 1${pathLine}
\t_mcp_output("result", {"track_index": _idx, "track_type": ${typeVal}})
\t_mcp_done()
`;
}

// genAnimationTrackRemove/genAnimationKeyframeRemove 已收敛至 animation-shared.js 的
// genRemoveTrackScript/genRemoveKeyframeScript(顶部 import 别名即本地绑定,底部 export 不变)。

function genAnimationKeyframeAdd(nodePath: string, animName: string, trackIdx: number, time: number, value: unknown, transition: number | undefined): string {
  const transStr = transition ?? 1.0;
  const valueStr = value !== undefined ? valueToGd(value) : 'null';
  const rotValueStr = value !== undefined && Array.isArray(value) && value.length === 3
    ? `Quaternion.from_euler(Vector3(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])}))`
    : valueStr;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
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
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
${keyframeRangeGuard(trackIdx, kfIdx)}
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
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
${keyframeRangeGuard(trackIdx, kfIdx)}
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
    const projectPath = requireProjectPath(args);
    const loadAutoloads = (args.load_autoloads as boolean) !== false;
    const godotPath = await ctx.findGodot();

    let code: string;
    const action = args.action as string;
    if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

    const nodePath = normalizeNodePath((args.node_path as string) ?? '');
    const animName = (args.animation_name as string) ?? '';

    switch (action) {
      case 'add_track': {
        if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
        if (!args.track_type) return opsErrorResult('INVALID_PARAMS', 'track_type required for add_track');
        code = genAnimationTrackAdd(nodePath, animName, args.track_type as string, args.track_path as string | undefined,
          args.insert_at !== undefined ? ensureNumber(args.insert_at, 'insert_at') : undefined);
        break;
      }
      case 'remove_track': {
        if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
        if (args.track_index === undefined) return opsErrorResult('INVALID_PARAMS', 'track_index required for remove_track');
        code = genAnimationTrackRemove(nodePath, animName, ensureNumber(args.track_index, 'track_index'));
        break;
      }
      case 'add_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.time === undefined) return opsErrorResult('INVALID_PARAMS', 'time required for add_keyframe');
        code = genAnimationKeyframeAdd(nodePath, animName, trackIdx, ensureNumber(args.time, 'time'), args.value,
          args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        break;
      }
      case 'remove_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for remove_keyframe');
        code = genAnimationKeyframeRemove(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'));
        break;
      }
      case 'update_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for update_keyframe');
        code = genAnimationKeyframeUpdate(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'),
          args.value,
          args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        break;
      }
      case 'set_curve': {
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
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
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

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  animation_track: {
    readonly: false,
    long_running: false,
    // P0-2 (批次 E): remove_track/remove_keyframe/update_keyframe 是破坏性操作（删轨道/关键帧/改值），
    // 对齐兄弟模块 animation-ops.ts:691（同名操作标 destructive）。原标 'read' 绕确认门（spec §4.1
    // 零行为改变决策）是 bug——破坏性操作应确认。add_track/add_keyframe/set_curve 仍 read（非破坏）。
    // risk-coverage GUARDED_KEYS 加 'animation_track' 允许非 read。
    actionRisks: {
      add_track: 'read',
      remove_track: 'destructive',
      add_keyframe: 'read',
      remove_keyframe: 'destructive',
      update_keyframe: 'destructive',
      set_curve: 'read',
    },
  },
};
