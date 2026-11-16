// 锚点求解:绝对几何(rect,相对父左上角)→ anchors+offsets。
// 映射依据:Figma constraints(LEFT/RIGHT/CENTER/LEFT_RIGHT/SCALE)与 Godot anchors 同构(spec §3.2)。

export interface Rect { x: number; y: number; w: number; h: number }

export interface AnchorsOffsets {
  anchor_left: number; anchor_right: number; anchor_top: number; anchor_bottom: number;
  offset_left: number; offset_right: number; offset_top: number; offset_bottom: number;
}

/** BoxContainer 等容器父会强制重排子 Control,rect 不适用(spec B-3)。 */
export const CONTAINER_CONTROL_TYPES: readonly string[] = [
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer', 'HSplitContainer',
  'VSplitContainer', 'TabContainer', 'HFlowContainer', 'VFlowContainer',
];

const EPS = 1e-9;

/** 把浮点误差内的 0/0.5/1 吸附到离散锚点(可读性优先,比例兜底,spec 开放问题 2)。
 * 导出供 anchor-rebase 的 f32 感知求解同源复用(吸附阈值两处必须一致)。 */
export function snap(v: number): number {
  if (Math.abs(v) < 1e-6) return 0;
  if (Math.abs(v - 0.5) < 1e-6) return 0.5;
  if (Math.abs(v - 1) < 1e-6) return 1;
  return v;
}

export function solveAnchors(parent: { w: number; h: number }, child: Rect): AnchorsOffsets {
  if (!(parent.w > EPS) || !(parent.h > EPS)) {
    throw new Error(`INVALID_PARAMS: parent size must be positive, got ${parent.w}x${parent.h}`);
  }
  const al = snap(child.x / parent.w);
  const ar = snap((child.x + child.w) / parent.w);
  const at = snap(child.y / parent.h);
  const ab = snap((child.y + child.h) / parent.h);
  return {
    anchor_left: al, anchor_right: ar, anchor_top: at, anchor_bottom: ab,
    offset_left: Math.round(child.x - al * parent.w),
    offset_right: Math.round(child.x + child.w - ar * parent.w),
    offset_top: Math.round(child.y - at * parent.h),
    offset_bottom: Math.round(child.y + child.h - ab * parent.h),
  };
}

/** 批1 1d:与 solveAnchors 同语义(含吸附),offset 不 Math.round、浮点直出。
 * 0 容差契约:重算 anchor*parentSize + offset === childRect 在 float64 下严格成立
 * (offset = child − anchor·parent 的浮点残差精确补偿;a·p 与 child 同量级时差值
 * 由 Sterbenz 型论证精确可表示,和回 child 无舍入)。
 * 注意:这是 TS 侧 float64 恒等——引擎侧(Control 边距按 real_t=float32 重算)需要
 * anchor-rebase.ts 的 f32 感知推导才能位级还原,见该文件头注的探针证据。 */
export function solveAnchorsUnrounded(parent: { w: number; h: number }, child: Rect): AnchorsOffsets {
  if (!(parent.w > EPS) || !(parent.h > EPS)) {
    throw new Error(`INVALID_PARAMS: parent size must be positive, got ${parent.w}x${parent.h}`);
  }
  const al = snap(child.x / parent.w);
  const ar = snap((child.x + child.w) / parent.w);
  const at = snap(child.y / parent.h);
  const ab = snap((child.y + child.h) / parent.h);
  return {
    anchor_left: al, anchor_right: ar, anchor_top: at, anchor_bottom: ab,
    offset_left: child.x - al * parent.w,
    offset_right: child.x + child.w - ar * parent.w,
    offset_top: child.y - at * parent.h,
    offset_bottom: child.y + child.h - ab * parent.h,
  };
}
