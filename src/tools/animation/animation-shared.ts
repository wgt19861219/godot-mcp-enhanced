import { ensureNumber, valueToGd, SCENE_TREE_HEADER, gdEscape, escapeForGdLiteral } from '../shared.js';

// Re-export ensureNumber for backward compatibility with animation-ops and animation-track
export { ensureNumber };

// Re-export the unified valueToGd from shared.ts (replaces the old local implementation)
export { valueToGd };

// ─── Constants ─────────────────────────────────────────────────────────────

export const ANIM_ERROR_CODES = {
  INVALID_ACTION: 'INVALID_ACTION',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  ANIM_NOT_FOUND: 'ANIM_NOT_FOUND',
  TRACK_NOT_FOUND: 'TRACK_NOT_FOUND',
  KEYFRAME_NOT_FOUND: 'KEYFRAME_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TRACK_TYPES = [
  'value', 'position_3d', 'rotation_3d', 'scale_3d',
  'blend_shape', 'method', 'bezier', 'audio', 'animation',
] as const;

export const LOOP_MODES = ['none', 'linear', 'pingpong'] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function argsToGd(args?: unknown[]): string {
  if (!args || args.length === 0) return '[]';
  return `[${args.map(a => valueToGd(a)).join(', ')}]`;
}

export function animErrorMapper(errorMsg: string): string {
  if (errorMsg.includes('not found')) {
    if (errorMsg.includes('AnimationPlayer')) return ANIM_ERROR_CODES.NODE_NOT_FOUND;
    if (errorMsg.includes('Animation not found')) return ANIM_ERROR_CODES.ANIM_NOT_FOUND;
    if (errorMsg.includes('Track index')) return ANIM_ERROR_CODES.TRACK_NOT_FOUND;
    if (errorMsg.includes('Keyframe')) return ANIM_ERROR_CODES.KEYFRAME_NOT_FOUND;
  }
  return ANIM_ERROR_CODES.SCRIPT_EXEC_FAILED;
}

// ─── 共享 GDScript 生成片段(animation 与 animation_track 复用,2026-09-18 重复分析收敛) ──
// 守卫前奏:AP 定位 → AnimationPlayer 校验 → animation 存在性 → 取 _anim。
// 两工具 8 个 gen 函数共享此前奏;result 输出行属各工具对外契约,不在此统一。
export function animPreamble(nodePath: string, animName: string): string {
  return `\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")`;
}

export function trackRangeGuard(trackIdx: number): string {
  return `\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn`;
}

export function keyframeRangeGuard(trackIdx: number, kfIdx: number): string {
  return `\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn`;
}

// 以下两函数在两工具中原本逐字相同(2026-09-18 分析确认),收敛为单一实现。
export function genRemoveTrackScript(nodePath: string, animName: string, trackIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
\t_anim.remove_track(${trackIdx})
\t_mcp_output("result", {"removed_track": ${trackIdx}})
\t_mcp_done()
`;
}

export function genRemoveKeyframeScript(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
${keyframeRangeGuard(trackIdx, kfIdx)}
\t_anim.track_remove_key(${trackIdx}, ${kfIdx})
\t_mcp_output("result", {"removed_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}
