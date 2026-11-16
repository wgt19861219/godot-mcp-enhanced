// 质量门(批1):0 容差基线比对 + 四类品质检查器。
//
// compareBaseline(批1 1b):实测 vs 基线逐节点 rect 四值严格 `===`(浮点直接比,不经 round);
// 路径集差异(基线有/实测无、实测有/基线无)双向进 mismatches——缺失一侧的数值
// 用 NaN 标注、field 置 'x'。NaN 比较用 Number.isNaN 显式处理,不落 `!==` 陷阱
// (NaN !== NaN 恒真,裸 !== 会把"双侧同 NaN"误判不等、把单侧 NaN 误判成普通数值差)。
//
// 四类检查器(批1 1c,spec §1c 四模式 → quality/order 报告节):全纯函数、零 Godot
// 依赖、纯检测只读(不改场景不写盘)。判据只用 anchors/offsets + 类型 + rect + styles
// (N2;layout_mode 不是判据——measure 不回读它)。输出纪律(D8):无发现时调用方省略
// quality/order 节;measure.stalled === true(布局未收敛,rect 不可信)时调用方**不调用**
// buildQualityReport、不出判定、只报 stalled(P1-4)——本契约由 index.ts 两处调用方实现。
//
// NaN 语义(Task 3 review ledger 指针的处置):本文件的检测比较全部是 `<=`/`>` 形态,
// NaN 参与比较恒为 false → 诚实不命中,不引入"双侧同 NaN 判等"的新语义,故无需为
// eqStrict 补双侧 NaN 用例(compareBaseline 的 NaN 分支语义未变)。

import type { MeasuredNode } from './layout-diff.js';
import { detectOutOfBounds } from './layout-diff.js';
import { CONTAINER_CONTROL_TYPES } from './anchor-solver.js';
import type { Rect } from './anchor-solver.js';

const CONTAINER_TYPES = new Set<string>(CONTAINER_CONTROL_TYPES);

// 根路径归一:measure 目标根为 '.',一级子无 '/' → 父即根 '.';深层 'Panel/Bj' → 'Panel'。
function parentKeyOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

// 四 anchor 全 0(anchors 缺失 → 无法判定,保守视为非全 0,防误报)
function anchorsAllZero(n: MeasuredNode): boolean {
  const a = n.anchors;
  if (!a) return false;
  return a.left === 0 && a.right === 0 && a.top === 0 && a.bottom === 0;
}

// ─── A.1 裸壳(quality 节)───────────────────────────────────────────────────

/** 裸 Control 壳:非渲染件下子节点 ≥2 且全部四 anchor == 0 纯 offset 绝对定位。
 * "非渲染件"判据(靶子真实结构标定,Review Focus 4 / spec 开放问题 4):
 * type === 'Control'(get_class 精确到裸 Control 类,Label/TextureRect 等不算)
 * 且无 text 字段且无 styles override——Panel 带 stylebox 是装饰面板,豁免。 */
export function detectBareShell(measured: MeasuredNode[]): Array<{ path: string; childCount: number }> {
  const childrenOf = new Map<string, MeasuredNode[]>();
  for (const m of measured) {
    if (m.path === '.') continue; // 根自身不是任何节点的子
    const key = parentKeyOf(m.path);
    const arr = childrenOf.get(key);
    if (arr) arr.push(m); else childrenOf.set(key, [m]);
  }
  const out: Array<{ path: string; childCount: number }> = [];
  for (const m of measured) {
    if (m.type !== 'Control' || m.text !== undefined || (m.styles?.length ?? 0) > 0) continue;
    const kids = childrenOf.get(m.path) ?? [];
    if (kids.length < 2) continue;
    if (!kids.every(anchorsAllZero)) continue;
    // 存在非零 offset:纯 offset 绝对定位的活性证据(全零 offset 是退化堆叠,不报)
    const hasNonZeroOffset = kids.some(k => Object.values(k.offsets ?? {}).some(v => v !== 0));
    if (!hasNonZeroOffset) continue;
    out.push({ path: m.path, childCount: kids.length });
  }
  return out;
}

// ─── A.2 应跟随(quality 节)─────────────────────────────────────────────────

/** 子 rect 与父 rect 四边差均 ≤ tolerancePx(全铺背景类形态)但 anchor 全 0——
 * 视觉上"跟着父"实为硬 offset,resize 即错位。NaN rect 参与比较 → 差值 NaN →
 * ≤tol 恒 false → 诚实不命中。 */
export function detectShouldFollow(
  measured: MeasuredNode[],
  tolerancePx = 2,
): Array<{ path: string; parent: string }> {
  const byPath = new Map(measured.map(m => [m.path, m]));
  const out: Array<{ path: string; parent: string }> = [];
  for (const m of measured) {
    if (m.path === '.') continue; // 根无父
    if (!anchorsAllZero(m)) continue; // 判据要求 anchor 全 0(缺失同样保守跳过)
    const parent = byPath.get(parentKeyOf(m.path));
    if (!parent) continue; // 父不在测量集 → 无法判定
    // Container 父每帧重排子节点:anchor 无意义,且 solve_from_current(1d)会跳过
    // 容器子——检测侧同步排除,防报告给出必被工具拒绝的误导建议
    if (CONTAINER_TYPES.has(parent.type)) continue;
    const dLeft = Math.abs(m.rect.x - parent.rect.x);
    const dTop = Math.abs(m.rect.y - parent.rect.y);
    const dRight = Math.abs((m.rect.x + m.rect.w) - (parent.rect.x + parent.rect.w));
    const dBottom = Math.abs((m.rect.y + m.rect.h) - (parent.rect.y + parent.rect.h));
    if (dLeft <= tolerancePx && dTop <= tolerancePx && dRight <= tolerancePx && dBottom <= tolerancePx) {
      out.push({ path: m.path, parent: parent.path });
    }
  }
  return out;
}

// ─── D 视口溢出(quality 节;补 detectOutOfBounds 根/一级子盲区,P1-1)────────

/** global rect 越 viewport 界:双侧聚合进 w/h 各一个数(签名只有两值)——
 * w = max(右缘超宽, 左缘越界), h 同理;命中门槛 marginPx(默认 4)。
 * 既有 detectOutOfBounds 只判"子 vs 父",父是场景根的一级子永远跳过、根自身无父——
 * 本检测以 measure.viewport 为参照系补该盲区(g800 的 Panel 越视口即典型形态)。 */
export function detectViewportOverflow(
  measured: MeasuredNode[],
  viewport: { w: number; h: number },
  marginPx = 4,
): Array<{ path: string; overflow: { w: number; h: number } }> {
  const out: Array<{ path: string; overflow: { w: number; h: number } }> = [];
  for (const m of measured) {
    const ow = Math.max(0, m.rect.x + m.rect.w - viewport.w, -m.rect.x);
    const oh = Math.max(0, m.rect.y + m.rect.h - viewport.h, -m.rect.y);
    if (ow > marginPx || oh > marginPx) {
      out.push({ path: m.path, overflow: { w: ow, h: oh } });
    }
  }
  return out;
}

// ─── A.3 等距组(order 节)───────────────────────────────────────────────────

/** 同父兄弟沿轴相邻间距差 ≤ tolerancePx 且成员 ≥3(容器化候选)。
 * 间距 = 后缘 − 前缘(兄弟按 global rect 沿轴起点排序,次键 path 定序防并列漂移),
 * 非中心距。run 语义:run 内任意两间距之差(max−min)≤ tol;run 间共享一个边界成员。
 * 间距须 ≥0(靶子标定 2026-11-16:负间距 = 等量叠压堆叠,不是排布行,容器化为
 * 负 separation 属病理形态——切断 run 不报;贴邻 gap=0 是合法紧排,保留)。
 * 间距非有限(NaN rect 派生)→ 该间距处切断 run(无法判定,不命中——不引入 NaN 分支)。
 * Container 父的子已被容器排布(等距是容器行为而非容器化候选),整组排除。 */
export function detectEquidistant(
  measured: MeasuredNode[],
  tolerancePx = 2,
): Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number }> {
  const byPath = new Map(measured.map(m => [m.path, m]));
  const groups = new Map<string, MeasuredNode[]>();
  for (const m of measured) {
    if (m.path === '.') continue;
    const key = parentKeyOf(m.path);
    const arr = groups.get(key);
    if (arr) arr.push(m); else groups.set(key, [m]);
  }
  const out: Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number }> = [];
  for (const [parent, sibs] of groups) {
    if (sibs.length < 3) continue;
    const pNode = byPath.get(parent);
    if (pNode && CONTAINER_TYPES.has(pNode.type)) continue;
    for (const axis of ['x', 'y'] as const) {
      const sizeKey = axis === 'x' ? 'w' : 'h';
      const sorted = [...sibs].sort((a, b) =>
        a.rect[axis] - b.rect[axis] || a.path.localeCompare(b.path));
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!, cur = sorted[i]!;
        gaps.push(cur.rect[axis] - (prev.rect[axis] + prev.rect[sizeKey]));
      }
      let s = 0;
      while (s < gaps.length) {
        // 间距 <0(叠压)或非有限(NaN)→ 该处切断,run 不从此起
        if (!Number.isFinite(gaps[s]!) || gaps[s]! < 0) { s++; continue; }
        let e = s, mn = gaps[s]!, mx = gaps[s]!;
        while (e + 1 < gaps.length) {
          const g = gaps[e + 1]!;
          if (!Number.isFinite(g) || g < 0) break;
          const nm = Math.min(mn, g), nx = Math.max(mx, g);
          if (nx - nm > tolerancePx) break;
          mn = nm; mx = nx; e++;
        }
        const memberCount = e - s + 2; // e−s+1 个间距 → e−s+2 个成员
        if (memberCount >= 3) {
          const runGaps = gaps.slice(s, e + 1);
          const gap = runGaps.reduce((a, b) => a + b, 0) / runGaps.length;
          out.push({ parent, axis, members: sorted.slice(s, e + 2).map(x => x.path), gap });
        }
        s = e + 1; // 下一 run 从上一 run 末成员起(共享该成员)
      }
    }
  }
  return out;
}

// ─── 聚合(spec §1c 报告节;D8 无发现省略)──────────────────────────────────

/** quality 报告节(A.1/A.2/D 聚合;null = 四类全无发现,调用方省略字段)。 */
export interface QualitySection {
  bare_shells: Array<{ path: string; childCount: number; suggestion: string }>;
  should_follow: Array<{ path: string; parent: string; suggestion: string }>;
  out_of_bounds: Array<{ path: string; parent: string; overflow: Rect; suggestion: string }>;
  viewport_overflow: Array<{ path: string; overflow: { w: number; h: number }; suggestion: string }>;
}

/** order 报告节(A.3 等距组;null = 无发现,调用方省略字段)。 */
export interface OrderSection {
  equidistant: Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number; suggestion: string }>;
}

/** 质量报告(Task 3 空壳,本任务填充):quality/order 两节各自独立省略(D8)。
 * stalled 抑制是调用方契约——measure.stalled === true 时调用方不调用本函数。 */
export interface QualityReport {
  quality: QualitySection | null;
  order: OrderSection | null;
}

/** 聚合四类检测 + 既有 detectOutOfBounds(父级越界)。opts.viewport 缺省 → 跳过
 * 视口溢出检测(measure.viewport 缺失时无法判定,不造数)。全部无发现 → null。 */
export function buildQualityReport(
  measured: MeasuredNode[],
  opts?: { viewport?: { w: number; h: number } },
): QualityReport | null {
  const bare = detectBareShell(measured);
  const follow = detectShouldFollow(measured);
  const oob = detectOutOfBounds(measured);
  const vp = opts?.viewport ? detectViewportOverflow(measured, opts.viewport) : [];
  const equid = detectEquidistant(measured);

  const quality: QualitySection | null = (bare.length + follow.length + oob.length + vp.length) > 0 ? {
    bare_shells: bare.map(b => ({ ...b,
      suggestion: `裸 Control 壳下 ${b.childCount} 个子节点纯 offset 绝对定位(排布语义只活在注释里)——建议 solve_from_current 反解比例锚点,或按视觉组容器化(ui_build_layout)` })),
    should_follow: follow.map(f => ({ ...f,
      suggestion: '子 rect 已贴合父 rect(四边差 ≤2px)但 anchor 全 0,resize 不跟随——建议 solve_from_current 反解为跟随锚点' })),
    out_of_bounds: oob.map(o => ({ ...o,
      suggestion: '子节点溢出父边界——建议 solve_from_current 重排锚点/尺寸,或按报告收窄' })),
    viewport_overflow: vp.map(v => ({ ...v,
      suggestion: `节点越出视口(水平 ${v.overflow.w}px / 垂直 ${v.overflow.h}px)——建议 solve_from_current 按视口重排锚点` })),
  } : null;
  const order: OrderSection | null = equid.length > 0 ? {
    equidistant: equid.map(g => ({ ...g,
      suggestion: `同父 ${g.members.length} 个子节点沿 ${g.axis} 轴等距(间距 ≈${Math.round(g.gap * 10) / 10}px)——建议容器化为 ${g.axis === 'x' ? 'HBoxContainer' : 'VBoxContainer'}(ui_build_layout)` })),
  } : null;

  if (!quality && !order) return null;
  return { quality, order };
}

// ─── 批1 1b: 0 容差基线比对 ─────────────────────────────────────────────────

export interface RectMismatch {
  path: string;
  field: 'x' | 'y' | 'w' | 'h';
  expected: number;
  actual: number;
}

export interface BaselineCompareResult {
  ok: boolean;
  mismatches: RectMismatch[];
}

// 单值 0 容差比较:双侧同 NaN 视为相等,单侧 NaN 视为不等(显式走 Number.isNaN,防 !== 陷阱)
function eqStrict(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return a === b;
}

export function compareBaseline(
  measured: MeasuredNode[],
  baseline: MeasuredNode[],
): BaselineCompareResult {
  const mismatches: RectMismatch[] = [];
  const measuredByPath = new Map(measured.map(m => [m.path, m]));
  const baselineByPath = new Map(baseline.map(m => [m.path, m]));

  // 基线有/实测缺:缺失侧数值 NaN 标注,field 置 'x'(占位,值级归 NaN 标注)
  for (const [path, b] of baselineByPath) {
    const m = measuredByPath.get(path);
    if (!m) {
      mismatches.push({ path, field: 'x', expected: b.rect.x, actual: NaN });
      continue;
    }
    for (const f of ['x', 'y', 'w', 'h'] as const) {
      if (!eqStrict(b.rect[f], m.rect[f])) {
        mismatches.push({ path, field: f, expected: b.rect[f], actual: m.rect[f] });
      }
    }
  }

  // 实测有/基线无:同样进 mismatches(双向比对),expected NaN 标注
  for (const [path, m] of measuredByPath) {
    if (!baselineByPath.has(path)) {
      mismatches.push({ path, field: 'x', expected: NaN, actual: m.rect.x });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
