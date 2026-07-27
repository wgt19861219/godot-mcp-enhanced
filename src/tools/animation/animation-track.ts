import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { gdEscape } from '../shared.js';
import { SCENE_TREE_HEADER } from '../shared.js';
import { valueToGd } from './animation-shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** @deprecated v0.25.0 — animation_track 工具已合并进 animation 工具。
 * 6 个 GDScript 生成器定义保留在此文件（被 animation-ops.ts re-export 使用），
 * 但工具本身不再注册。详见 animation-ops.ts 的 set_curve case。 */
export const TOOL_NAMES = [] as const;

// ─── Tool Definitions ──────────────────────────────────────────────────────

/** @deprecated v0.25.0 — 已合并到 animation-ops。不再暴露工具。 */
export function getToolDefinitions(): Tool[] {
  return [];
}

// ─── (legacy getToolDefinitions removed in v0.25.0 — generators below kept) ──
// 原 animation_track 工具的 6 个 action（add_track/remove_track/add_keyframe/
// remove_keyframe/update_keyframe/set_curve）及其 schema 已迁入 animation-ops.ts。
// 本文件下方仅保留 6 个 GDScript 生成器定义，供 animation-ops.ts re-export 复用。



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

// ─── Tool Handler (deprecated shim) ────────────────────────────────────────

/** @deprecated v0.25.0 — animation_track 工具已合并进 animation 工具。
 * 此 handleTool 永远返回 null，仅保留签名以满足 ToolModule 接口。
 * 实际 handler 在 animation-ops.ts:547 的 set_curve case 及同名 track/keyframe case。 */
export async function handleTool(): Promise<ToolResult | null> {
  return null;
}

/** @deprecated v0.25.0 — 已无工具可登记，保留空对象满足 ToolModule 接口。
 * animation_track 的 risk 标注已迁入 animation-ops.ts 的 TOOL_META.actionRisks。 */
export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {};

