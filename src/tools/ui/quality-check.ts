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
/** 同父兄弟分组(A.3/批2 Task2 共享,提取自 detectEquidistant 原内联逻辑):跳过根
 * 自身;Container 父的组整体排除(容器子已被排布,等距/间距是容器行为而非候选)。
 * Task 3 对齐线/视觉组聚类复用本 helper。 */
export function siblingsByParent(measured: MeasuredNode[]): Map<string, MeasuredNode[]> {
  const byPath = new Map(measured.map(m => [m.path, m]));
  const groups = new Map<string, MeasuredNode[]>();
  for (const m of measured) {
    if (m.path === '.') continue;
    const key = parentKeyOf(m.path);
    const arr = groups.get(key);
    if (arr) arr.push(m); else groups.set(key, [m]);
  }
  for (const key of [...groups.keys()]) {
    const pNode = byPath.get(key);
    if (pNode && CONTAINER_TYPES.has(pNode.type)) groups.delete(key);
  }
  return groups;
}

/** 同父兄弟沿轴排序后的相邻对(间距 = 后缘−前缘,按 global rect 沿轴起点排序,
 * 次键 path 定序防并列漂移)。detectEquidistant/detectSpacingScale 共享。 */
function axisGapPairs(
  sibs: MeasuredNode[],
  axis: 'x' | 'y',
): Array<{ a: MeasuredNode; b: MeasuredNode; gap: number }> {
  const sizeKey = axis === 'x' ? 'w' : 'h';
  const sorted = [...sibs].sort((p, q) =>
    p.rect[axis] - q.rect[axis] || p.path.localeCompare(q.path));
  const pairs: Array<{ a: MeasuredNode; b: MeasuredNode; gap: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!;
    pairs.push({ a: prev, b: cur, gap: cur.rect[axis] - (prev.rect[axis] + prev.rect[sizeKey]) });
  }
  return pairs;
}

export function detectEquidistant(
  measured: MeasuredNode[],
  tolerancePx = 2,
): Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number }> {
  const out: Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number }> = [];
  for (const [parent, sibs] of siblingsByParent(measured)) {
    if (sibs.length < 3) continue;
    for (const axis of ['x', 'y'] as const) {
      const pairs = axisGapPairs(sibs, axis);
      const gaps: number[] = pairs.map(p => p.gap);
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
          // run 成员 = 首对 a + 各对 b(相邻对共享边界成员,与原 sorted.slice(s, e+2) 等价)
          out.push({ parent, axis, members: [pairs[s]!.a, ...pairs.slice(s, e + 1).map(p => p.b)].map(x => x.path), gap });
        }
        s = e + 1; // 下一 run 从上一 run 末成员起(共享该成员)
      }
    }
  }
  return out;
}

// ─── A.4 间距档位(order 节,批2 Task2)───────────────────────────────────────

/** 间距档位检测结果(brief Interfaces 形态)。 */
export interface SpacingScaleResult {
  on_scale: number;
  total: number;
  rate: number;
  off_scale: Array<{ a: string; b: string; gap: number; nearest: number }>;
}

/** 批2 Task2:兄弟相邻间距对照档位表——报“落档率”+ 落档外清单(a/b 为相邻对路径,
 * nearest = 距离最近档位值,并列取较小档)。
 * null = scale 空或无可比对兄弟对(无声明不发噪音,Review Focus 3)。
 * 间距 = 后缘−前缘(axisGapPairs 与 detectEquidistant 同语义);无效间距(负值叠压/
 * NaN)跳过不计 total;Container 父组由 siblingsByParent 统一排除。
 * 落档判定 = |gap − nearest| ≤ tolerancePx(spec 批2 节「对照档位表,容差 2px」,
 * 与全仓检测器 2px 一脉相承——真实 measure 的 rect 是浮点,严格相等会让 12.0000001
 * 系统性漏 12 档;Task2 审查 Important 裁定 spec 语义对,brief 用例系计划转写缺陷)。 */
export function detectSpacingScale(
  measured: MeasuredNode[],
  scale: number[],
  tolerancePx = 2,
): SpacingScaleResult | null {
  if (scale.length === 0) return null;
  // 升序副本供 nearest 遍历(严格小于更新 → 并列保留先遍历的较小档,与调用方传序无关)
  const asc = [...scale].sort((p, q) => p - q);
  let on = 0, total = 0;
  const off: SpacingScaleResult['off_scale'] = [];
  for (const sibs of siblingsByParent(measured).values()) {
    for (const axis of ['x', 'y'] as const) {
      for (const { a, b, gap } of axisGapPairs(sibs, axis)) {
        if (!Number.isFinite(gap) || gap < 0) continue; // 同 detectEquidistant 纪律
        total++;
        let nearest = asc[0]!;
        let best = Math.abs(gap - nearest);
        for (let i = 1; i < asc.length; i++) {
          const d = Math.abs(gap - asc[i]!);
          if (d < best) { best = d; nearest = asc[i]!; }
        }
        // best 即距最近档的最小距离(= |gap − nearest|),容差窗内落档
        if (best <= tolerancePx) on++;
        else off.push({ a: a.path, b: b.path, gap, nearest });
      }
    }
  }
  if (total === 0) return null;
  return { on_scale: on, total, rate: on / total, off_scale: off };
}

// ─── A.5 对齐线(order 节,批2 Task3)───────────────────────────────────────────

/** 对齐线检测结果(brief Interfaces 形态)。 */
export interface AlignmentLaneResult {
  parent: string;
  kind: 'left' | 'right' | 'center' | 'top' | 'bottom' | 'vc';
  lane: number;
  majority: string[];
  outliers: Array<{ path: string; offset: number }>;
}

// 六条线:x 系 left/right/center 由 global rect.x / x+w / x+w/2,y 系 top/bottom/vc 同理
const LANE_KINDS: ReadonlyArray<{ kind: AlignmentLaneResult['kind']; get: (r: Rect) => number }> = [
  { kind: 'left', get: r => r.x },
  { kind: 'right', get: r => r.x + r.w },
  { kind: 'center', get: r => r.x + r.w / 2 },
  { kind: 'top', get: r => r.y },
  { kind: 'bottom', get: r => r.y + r.h },
  { kind: 'vc', get: r => r.y + r.h / 2 },
];

/** 批2 Task3:同父 ≥3 兄弟对六条线各聚类——每线最大簇为多数派(lane = 簇内均值),
 * 簇外成员为离群者(offset = 成员值 − lane);仅报告有离群者的线(全对齐无线可报)。
 * 聚类 = 排序后单链接(相邻值差 ≤ tolerancePx 归同簇,与 detectVisualGroups 同语义);
 * 容差含等号(恰 2px 算命中,批2 Task2 修正后的全仓统一 2px 认知)。多数派需 ≥2 成员
 * (单成员簇不构成"共享线"——全散布的父六线皆静默,防检测退化为永远触发的噪音源)。
 * 值非有限(NaN rect 派生)的成员无法判定线值 → 剔除不参与聚类(NaN 参与比较恒 false
 * 的既有纪律,不产离群 NaN 的发现)。Container 父组由 siblingsByParent 统一排除。 */
export function detectAlignmentLanes(measured: MeasuredNode[], tolerancePx = 2): AlignmentLaneResult[] {
  const out: AlignmentLaneResult[] = [];
  for (const [parent, sibs] of siblingsByParent(measured)) {
    if (sibs.length < 3) continue; // ≥3 守卫(Review Focus 4):2 兄弟无多数派语义
    for (const { kind, get } of LANE_KINDS) {
      const sorted = sibs
        .filter(m => Number.isFinite(get(m.rect)))
        .sort((p, q) => get(p.rect) - get(q.rect) || p.path.localeCompare(q.path)); // 次键 path 定序防并列漂移
      if (sorted.length < 3) continue; // 有效值成员不足 3,多数派同样无意义
      // 单链接聚类:相邻值差 ≤ tolerancePx 归同簇
      const clusters: MeasuredNode[][] = [[sorted[0]!]];
      for (let i = 1; i < sorted.length; i++) {
        const v = get(sorted[i]!.rect), prev = get(sorted[i - 1]!.rect);
        if (Math.abs(v - prev) <= tolerancePx) clusters[clusters.length - 1]!.push(sorted[i]!);
        else clusters.push([sorted[i]!]);
      }
      let majorityIdx = 0;
      for (let i = 1; i < clusters.length; i++) {
        if (clusters[i]!.length > clusters[majorityIdx]!.length) majorityIdx = i; // 并列取先到者(排序确定性)
      }
      const majority = clusters[majorityIdx]!;
      if (majority.length < 2) continue; // 单成员簇无共享线语义
      const rest = clusters.filter((_, i) => i !== majorityIdx).flat();
      if (rest.length === 0) continue; // 全对齐一簇,无线可报
      const lane = majority.reduce((a, m) => a + get(m.rect), 0) / majority.length;
      out.push({
        parent, kind, lane,
        majority: majority.map(m => m.path),
        outliers: rest.map(m => ({ path: m.path, offset: get(m.rect) - lane })),
      });
    }
  }
  return out;
}

// ─── A.6 视觉组聚类(order 节,批2 Task3)──────────────────────────────────────

/** 视觉组检测结果(brief Interfaces 形态)。 */
export interface VisualGroupResult {
  parent: string;
  axis: 'x' | 'y';
  groups: Array<{ members: string[]; intraGap: number }>;
}

/** 批2 Task3:兄弟按轴排序后单链接聚类(相邻间距 ≤ thresholdPx 归同簇),报告
 * ≥2 个多成员(≥2 成员)簇的父——仅一个多成员簇无分组对比语义,该紧排形态由
 * detectEquidistant 覆盖。intraGap = 簇内相邻间距均值(axisGapPairs 同语义)。
 * 负间距(叠压)/非有限间距切断聚类(同 detectEquidistant 纪律:容器化建议的
 * separation 须 ≥0);Container 父组由 siblingsByParent 统一排除。 */
export function detectVisualGroups(measured: MeasuredNode[], thresholdPx: number): VisualGroupResult[] {
  const out: VisualGroupResult[] = [];
  for (const [parent, sibs] of siblingsByParent(measured)) {
    for (const axis of ['x', 'y'] as const) {
      const pairs = axisGapPairs(sibs, axis);
      if (pairs.length === 0) continue; // <2 兄弟无相邻对
      // 单链接聚类:pairs 共享边界成员,gap 合法则 b 进当前簇,否则起新簇
      const clusters: Array<{ members: MeasuredNode[]; gaps: number[] }> =
        [{ members: [pairs[0]!.a], gaps: [] }];
      for (const { b, gap } of pairs) {
        const c = clusters[clusters.length - 1]!;
        if (Number.isFinite(gap) && gap >= 0 && gap <= thresholdPx) {
          c.members.push(b);
          c.gaps.push(gap);
        } else {
          clusters.push({ members: [b], gaps: [] });
        }
      }
      const multi = clusters.filter(c => c.members.length >= 2);
      if (multi.length < 2) continue; // 报告 ≥2 簇且簇内 ≥2 成员的父
      out.push({
        parent, axis,
        groups: multi.map(c => ({
          members: c.members.map(m => m.path),
          intraGap: c.gaps.length > 0 ? c.gaps.reduce((x, y) => x + y, 0) / c.gaps.length : 0,
        })),
      });
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

/** order 报告节(A.3 等距组 + 批2 Task2 间距档位 + 批2 Task3 对齐线/视觉组;
 * null = 无发现,调用方省略字段)。equidistant/alignment_lanes 空/非空照挂(quality
 * 节四字段同款先例——节级省略、字段级全带,检测恒跑);spacing_scale/visual_groups
 * 仅在检测实际运行(有档位声明/阈值可得)时挂为可选字段——缺席 = 未跑不发噪音。 */
export interface OrderSection {
  equidistant: Array<{ parent: string; axis: 'x' | 'y'; members: string[]; gap: number; suggestion: string }>;
  alignment_lanes: Array<AlignmentLaneResult & { suggestion: string }>;
  spacing_scale?: SpacingScaleResult;
  visual_groups?: Array<VisualGroupResult & { suggestion: string }>;
}

/** 质量报告(Task 3 空壳,本任务填充):quality/order 两节各自独立省略(D8)。
 * stalled 抑制是调用方契约——measure.stalled === true 时调用方不调用本函数。 */
export interface QualityReport {
  quality: QualitySection | null;
  order: OrderSection | null;
}

/** 聚合四类检测 + 既有 detectOutOfBounds(父级越界)。opts.viewport 缺省 → 跳过
 * 视口溢出检测(measure.viewport 缺失时无法判定,不造数);opts.spacingScale 缺省 →
 * 跳过间距档位检测(无 theme 档位声明,批2 Task2——空数组 detectSpacingScale 自返
 * null,不造噪音);opts.visualThresholdPx 缺省取 spacingScale 最大档(批2 Task3
 * Review Focus 5——无档位且未传 → 跳过视觉组检测)。全部无发现 → null。 */
export function buildQualityReport(
  measured: MeasuredNode[],
  opts?: { viewport?: { w: number; h: number }; spacingScale?: number[]; visualThresholdPx?: number },
): QualityReport | null {
  const bare = detectBareShell(measured);
  const follow = detectShouldFollow(measured);
  const oob = detectOutOfBounds(measured);
  const vp = opts?.viewport ? detectViewportOverflow(measured, opts.viewport) : [];
  const equid = detectEquidistant(measured);
  const spacing = opts?.spacingScale ? detectSpacingScale(measured, opts.spacingScale) : null;
  const lanes = detectAlignmentLanes(measured);
  // 阈值缺省链:显式 visualThresholdPx > spacingScale 最大档 > 跳过(无档位未传不发噪音)
  const vThreshold = opts?.visualThresholdPx
    ?? (opts?.spacingScale?.length ? Math.max(...opts.spacingScale) : undefined);
  const visual = vThreshold !== undefined ? detectVisualGroups(measured, vThreshold) : null;

  const quality: QualitySection | null = (bare.length + follow.length + oob.length + vp.length) > 0 ? {
    bare_shells: bare.map(b => ({ ...b,
      // 场景根直接子(父即根 '.')默认进 skippedUnresolvedParent(父尺寸=视口依赖)——定向提示
      // 传 viewport 形参即可求解(批2 Task1 根治,闭环批1终审 Important#1)
      suggestion: `裸 Control 壳下 ${b.childCount} 个子节点纯 offset 绝对定位(排布语义只活在注释里)——建议 solve_from_current 反解比例锚点,或按视觉组容器化(ui_build_layout)` +
        (parentKeyOf(b.path) === '.' ? ';本壳为场景根直接子,传 viewport 形参即可处理(以视口为父尺寸求解)' : '') })),
    should_follow: follow.map(f => ({ ...f,
      suggestion: '子 rect 已贴合父 rect(四边差 ≤2px)但 anchor 全 0,resize 不跟随——建议 solve_from_current 反解为跟随锚点' })),
    out_of_bounds: oob.map(o => ({ ...o,
      suggestion: '子节点溢出父边界——建议 solve_from_current 重排锚点/尺寸,或按报告收窄' })),
    viewport_overflow: vp.map(v => ({ ...v,
      suggestion: `节点越出视口(水平 ${v.overflow.w}px / 垂直 ${v.overflow.h}px)——建议 solve_from_current 按视口重排锚点` })),
  } : null;
  // 挂节条件:四类 order 检测任一有产出(档位/视觉组 null = 未跑,不算发现)
  const order: OrderSection | null = (equid.length > 0 || spacing !== null || lanes.length > 0 || (visual?.length ?? 0) > 0) ? {
    equidistant: equid.map(g => ({ ...g,
      suggestion: `同父 ${g.members.length} 个子节点沿 ${g.axis} 轴等距(间距 ≈${Math.round(g.gap * 10) / 10}px)——建议容器化为 ${g.axis === 'x' ? 'HBoxContainer' : 'VBoxContainer'}(ui_build_layout)` })),
    alignment_lanes: lanes.map(l => ({ ...l,
      // brief 模板逐字:「多数派 N 节点共享 {kind} 对齐线 {lane}px,离群 {path} 偏 {offset}px」
      suggestion: `多数派 ${l.majority.length} 节点共享 ${l.kind} 对齐线 ${Math.round(l.lane * 10) / 10}px,离群 ${l.outliers.map(o => `${o.path} 偏 ${Math.round(o.offset * 10) / 10}px`).join('、')}` })),
    ...(spacing ? { spacing_scale: spacing } : {}),
    ...(visual !== null ? { visual_groups: visual.map(g => ({ ...g,
      // 组内间距在 groups[].intraGap 数据字段,不塞文案(brief 模板只要求建议容器化)
      suggestion: `同父兄弟沿 ${g.axis} 轴聚成 ${g.groups.length} 个视觉组——建议按视觉组容器化为 HBox/VBox(${g.axis === 'x' ? 'HBoxContainer' : 'VBoxContainer'},ui_build_layout)` })) } : {}),
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
