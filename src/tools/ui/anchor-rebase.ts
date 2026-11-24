// solve_from_current(批1 1d):既有场景锚点改造——授权几何反解 + 浮点 offset + tscn 文本 patch。
//
// 【为什么 planRebase 不直接用纯 float64 锚点+offset(探针证据,2026-11-16)】
// Control 边距在引擎侧按 real_t=float32 重算:margin = fl32(fl32(anchor·parentSize)+offset)。
// 纯 float64 求解(offset = child − anchor·parent 的 float64 残差 ~1e-15)在 float32 重算下
// 残差被 ulp 吸收、anchor 的 float32 舍入误差裸露——靶子 MoneyLay 子树 24 边实测 4 边漂
// 1 ulp(MoneyLay.r 236.5→236.50001525878906 等),compareBaseline 0 容差必挂。
// 本文件用 f32 感知推导:anchor = fround(snap(t/p)),offset = t32 − fl32(anchor·p)
// (两 float32 值之差,Sterbenz 型精确可表示)——引擎重算 fl32(fl32(anchor·p)+offset)
// === 当前边距,位级恒等,靶子全节点 0 miss。solveAnchorsUnrounded(anchor-solver.ts)保留
// 纯 float64 语义(TS 侧数学恒等,brief Step 1);两者取舍即上述探针,不是实现疏漏。
//
// 【写回 = 文本 patch,禁 PackedScene 重存】靶子项目靠 tscn 注释记录审计线索,
// PackedScene 重存会毁掉注释——applyRebasePatch 只动目标 [node] 段内的
// layout_mode/anchors_preset/anchor_*/offset_* 行,段外字节与注释逐字节不动。
//
// 【判据禁 layout_mode】检测/解析判据全部用几何量(anchors/offsets),layout_mode 只在
// 写回时作为编辑器语义标记同步写入 1(anchors 模式)。
//
// 【已知边界(诚实声明)】边距模拟不含 min-size 钳制与脚本运行时位移——静态 chrome 场景
// (本工具靶子)不命中;命中时 dry_run 计划与 measure 基线的 0 容差比对会暴露差异,不会静默。
// 根非零锚且不全铺视口时(如 anchor 0.1..0.9 内缩),零锚一级子仍会被以视口求解——写盘后
// 按根真实尺寸重算即偏移,靠 compareBaseline 0 容差门暴露(与 min-size 钳制同款暴露面,不静默)。
// instance= 场景(子场景实例)的内部子节点不在宿主 tscn 文本节点段,不参与解析(终审 T5③)。
// 【全锚继承(反馈 2026-11-18)】viewport 为正时,「父=根形态」的全锚(0,1,0,1)零 offset 节点在
// 根尺寸不可解/非正时以 viewport 作父尺寸(simulate 内,判据同 planRebase ⑤)——根无布局行的
// 场景此前会把这类节点按退化边距 {0,0,0,0} 求解成全零锚点落盘(静默错写),其子进 skip。
// 继承只对「按构造即视口尺寸的根」生效:根 offsets 全 0 且 anchors 全 0 或全锚(含根无布局行、
// 显式 0×0 行)。根非视口尺寸形态(自身内缩锚定如 anchor 0.1..0.9、全锚带非零 offset、其他
// 非零锚)不继承——其运行时尺寸 ≠ viewport,以视口求解子树写盘即偏移(计划 Review Focus 第 4
// 条),保持诚实 skip。

import { parseTscn } from '../../tscn/tscn-parser.js';
import type { ParsedNode } from '../../tscn/tscn-parser.js';
import { findSectionEnd, getBracketAttr } from '../../tscn/tscn-editor-shared.js';
import { CONTAINER_CONTROL_TYPES, snap } from './anchor-solver.js';
import type { AnchorsOffsets } from './anchor-solver.js';

const fr = Math.fround;
const CONTAINER_TYPES = new Set<string>(CONTAINER_CONTROL_TYPES);

// Godot LayoutPreset 枚举值 → [anchor_left, anchor_right, anchor_top, anchor_bottom]。
// 枚举顺时针序:top-left(0)→top-right(1)→bottom-right(2)→bottom-left(3)——Task5 审查
// Important#1 曾把 2/3 值对调(bottom-left 锚 [0,0,1,1] 误填成 [1,1,1,1]),已修+表驱动测试锚定。
// 引擎属性应用顺序:anchors_preset 先设四锚,显式 anchor_* 行后覆盖——缺边由 preset 补全。
const PRESET_ANCHORS: Record<number, readonly [number, number, number, number]> = {
  0: [0, 0, 0, 0], 1: [1, 1, 0, 0], 2: [1, 1, 1, 1], 3: [0, 0, 1, 1],
  4: [0, 0, 0.5, 0.5], 5: [0.5, 0.5, 0, 0], 6: [1, 1, 0.5, 0.5], 7: [0.5, 0.5, 1, 1],
  8: [0.5, 0.5, 0.5, 0.5], 9: [0, 0, 0, 1], 10: [0, 1, 0, 0], 11: [1, 1, 0, 1],
  12: [0, 1, 1, 1], 13: [0.5, 0.5, 0, 1], 14: [0, 1, 0.5, 0.5], 15: [0, 1, 0, 1],
};

// ─── 授权几何解析 ────────────────────────────────────────────────────────────

export type SideKey = 'left' | 'right' | 'top' | 'bottom';
export type SideRecord = Record<SideKey, number>;

/** 授权几何节点。path 为 measure 风格(场景根 '.',一级 'Panel',深层 'Panel/MoneyLay',
 * 与 measure 输出/compareBaseline 路径同构);缺省字段取 Godot 缺省值 0。 */
export interface AuthoredNode {
  path: string;
  name: string;
  type: string;
  tscnParent: string;   // [node] 头 parent 属性原值(根 '' 一级 '.' 深层 'A/B')——写回定位用
  parentPath: string;   // 根 '' 其余与 path 同构
  parentType: string;   // 根 ''
  hasLayout: boolean;   // 是否授权过任何 offset_*/anchor_*/anchors_preset 行
  anchors: SideRecord;  // 显式行优先,缺边由 anchors_preset 补,再缺省 0
  offsets: SideRecord;  // 缺省 0
}

/** 从 tscn 文本直接解析授权几何(经 parseTscn;多 ext_resource 交错段天然兼容)。 */
export function parseAuthoredGeometry(tscnText: string): AuthoredNode[] {
  const scene = parseTscn(tscnText);
  const entries: Array<{ node: ParsedNode; path: string; parentPath: string }> = [];
  for (const n of scene.nodes) {
    if (!n.parent) {
      entries.push({ node: n, path: '.', parentPath: '' });
    } else {
      entries.push({ node: n, path: `${n.parent === '.' ? '' : n.parent + '/'}${n.name}`, parentPath: n.parent });
    }
  }
  const typeByPath = new Map(entries.map(e => [e.path, e.node.type]));

  const out: AuthoredNode[] = [];
  for (const e of entries) {
    let hasLayout = false;
    const anchors: SideRecord = { left: 0, right: 0, top: 0, bottom: 0 };
    const offsets: SideRecord = { left: 0, right: 0, top: 0, bottom: 0 };
    const seenAnchor: Record<SideKey, boolean> = { left: false, right: false, top: false, bottom: false };
    let preset: number | undefined;
    for (const p of e.node.properties) {
      const pm = p.name.match(/^(anchor|offset)_(left|right|top|bottom)$/);
      if (pm) {
        (pm[1] === 'anchor' ? anchors : offsets)[pm[2] as SideKey] = Number(p.value);
        if (pm[1] === 'anchor') seenAnchor[pm[2] as SideKey] = true;
        hasLayout = true;
        continue;
      }
      if (p.name === 'anchors_preset') {
        preset = Number(p.value);
        hasLayout = true;
      }
    }
    if (preset !== undefined && PRESET_ANCHORS[preset]) {
      const [l, r, t, b] = PRESET_ANCHORS[preset]!;
      if (!seenAnchor.left) anchors.left = l;
      if (!seenAnchor.right) anchors.right = r;
      if (!seenAnchor.top) anchors.top = t;
      if (!seenAnchor.bottom) anchors.bottom = b;
    }
    out.push({
      path: e.path, name: e.node.name, type: e.node.type,
      tscnParent: e.node.parent ?? '', parentPath: e.parentPath,
      parentType: e.parentPath === '' ? '' : (typeByPath.get(e.parentPath) ?? ''),
      hasLayout, anchors, offsets,
    });
  }
  return out;
}

// ─── 引擎 float32 边距模拟 ───────────────────────────────────────────────────

export interface SimMargins { l: number; t: number; r: number; b: number }  // 均 float32 精确值

/** 逐节点计算边距与尺寸(引擎 float32 语义)。anchors 全 0 的节点边距 = offset
 * (0·p+o 精确),不依赖父尺寸;非零 anchor 需父尺寸,父尺寸静态不可解(如锚定场景根
 * →视口)时该节点不入表——唯一例外是「父=根形态」的全锚继承节点(simulate 的 viewport
 * 形参,见其内注释;本入口不传 viewport,行为与引入继承规则前相同)。文档序保证父先于子
 * (parseTscn 按出现序 push)。 */
export function simulateMargins(parsed: AuthoredNode[]): Map<string, SimMargins> {
  return simulate(parsed).margins;
}

/** 四边是否全 0(float32 语义,与 simulate 的 fr 口径一致)。 */
function isZeroSides(s: SideRecord): boolean {
  return fr(s.left) === 0 && fr(s.right) === 0 && fr(s.top) === 0 && fr(s.bottom) === 0;
}

/** anchors 是否全锚 (0,1,0,1)(铺满父)。 */
function isFullRectSides(s: SideRecord): boolean {
  return fr(s.left) === 0 && fr(s.right) === 1 && fr(s.top) === 0 && fr(s.bottom) === 1;
}

function simulate(parsed: AuthoredNode[], viewport?: { w: number; h: number }): {
  margins: Map<string, SimMargins>;
  sizes: Map<string, { w: number; h: number }>;
} {
  const margins = new Map<string, SimMargins>();
  const sizes = new Map<string, { w: number; h: number }>();
  // 继承的根形态前提(审查前修订):只对「按构造即视口尺寸的根」生效——根 offsets 全 0 且
  // anchors 全 0 或全锚(根无布局行时 anchors/offsets 均为缺省 0,天然落在「全 0」内;显式 0×0
  // 行等价看待)。「父尺寸不可解/非正」只是必要条件:根自身内缩锚定时它同样成立,若据此继承,
  // 真实根尺寸 ≠ viewport,以视口求解子树写盘即偏移(计划 Review Focus 第 4 条)——不继承。
  const root = parsed.find((n) => n.parentPath === '');
  const rootIsViewportForm = root !== undefined
    && isZeroSides(root.offsets) && (isZeroSides(root.anchors) || isFullRectSides(root.anchors));
  for (const n of parsed) {
    const a = { l: fr(n.anchors.left), r: fr(n.anchors.right), t: fr(n.anchors.top), b: fr(n.anchors.bottom) };
    const o = { l: fr(n.offsets.left), r: fr(n.offsets.right), t: fr(n.offsets.top), b: fr(n.offsets.bottom) };
    let mm: SimMargins | null = null;
    if (a.l === 0 && a.r === 0 && a.t === 0 && a.b === 0) {
      mm = { l: o.l, t: o.t, r: o.r, b: o.b };
    } else {
      let ps = n.parentPath === '' ? undefined : sizes.get(n.parentPath);
      // 全锚继承(反馈 2026-11-18):「父=根形态」的全锚(0,1,0,1)零 offset 节点等价于铺满父——
      // 根尺寸不可解或非正时以 viewport 作父尺寸,边距 {0,0,W,H}、尺寸 W×H,子树按文档序
      // 随之可解(多层全锚链自然传递)。「非正」判据同 planRebase ⑤:根无布局行时上方已按零锚
      // 给根写入真值的 0×0 条目,只判「有没有」会对退化边距 {0,0,0,0} 放行。不传 viewport 不触发。
      const parentUnresolved = !ps || !(ps.w > 0) || !(ps.h > 0);
      const fullRectZeroOffset = n.parentPath === '.'
        && a.l === 0 && a.r === 1 && a.t === 0 && a.b === 1
        && o.l === 0 && o.r === 0 && o.t === 0 && o.b === 0;
      if (parentUnresolved && fullRectZeroOffset && rootIsViewportForm
        && viewport && viewport.w > 0 && viewport.h > 0) {
        ps = viewport;
      }
      if (ps) {
        mm = {
          l: fr(fr(a.l * ps.w) + o.l),
          t: fr(fr(a.t * ps.h) + o.t),
          r: fr(fr(a.r * ps.w) + o.r),
          b: fr(fr(a.b * ps.h) + o.b),
        };
      }
    }
    if (mm) {
      margins.set(n.path, mm);
      sizes.set(n.path, { w: fr(mm.r - mm.l), h: fr(mm.b - mm.t) });
    }
  }
  return { margins, sizes };
}

// ─── 改造计划 ────────────────────────────────────────────────────────────────

export interface RebaseFilter {
  /** 节点名白名单(只改造名单内的名字) */
  include?: string[];
  /** 节点名黑名单(exclude 优先于 include) */
  exclude?: string[];
  /** 子树限定(measure 风格路径,如 'Panel/MoneyLay';'' / 缺省 = 整树) */
  subtree?: string;
}

export interface RebaseEntry {
  path: string;
  name: string;
  tscnParent: string;
  anchors: AnchorsOffsets;
}

export interface RebasePlan {
  toWrite: RebaseEntry[];
  /** Container 父的子——逐节点点名,绝不静默(容器强制重排,rect 语义不成立) */
  skippedContainerChildren: string[];
  /** include/exclude 名单过滤掉的范围内节点 */
  skippedByFilter: string[];
  /** 父尺寸静态不可解/非正(如父链含锚定场景根→视口依赖,或父无授权几何尺寸为 0) */
  skippedUnresolvedParent: string[];
  /** 无任何 offset/anchor 授权行(非布局节点/默认位置——写全零锚点是纯噪音) */
  skippedNoGeometry: string[];
}

/** 反解计划:对范围内每个可解节点,以其当前 float32 边距为目标求解比例锚点+浮点 offset。
 * 数值语义见文件头注(f32 感知推导,引擎重算位级恒等)。
 * opts.viewport(批2 Task1,闭环批1终审 Important#1):「父=根形态」节点(一级子;根自身
 * 零锚)父尺寸无法从 tscn 解析时的正数视口兜底——以视口为父尺寸继续既有求解。深层链断
 * 节点(父≠根)不兜底:真实父尺寸≠视口,以视口求解写盘即偏移(Task1 审查 Important 收紧)。
 * 同一个 viewport 也传给 simulate(反馈 2026-11-18):全锚(0,1,0,1)零 offset 的一级子在根尺寸
 * 不可解/非正时继承视口尺寸(头注「全锚继承」;仅限按构造即视口尺寸的根——根非视口尺寸形态
 * 不继承,保持诚实 skip),其子树因父尺寸已解而直接进求解——这不是对「深层链断不兜底」的
 * 放宽:该链上的父尺寸就是视口,不属于「真实父尺寸≠视口」。
 * 语义严格限定:已解析父的节点求解结果与不传 viewport 逐字节相同(求解路径零改动);
 * 不传 viewport 时整体结果与引入继承规则前逐字节相同。 */
export function planRebase(
  parsed: AuthoredNode[], filter?: RebaseFilter,
  opts?: { viewport?: { w: number; h: number } },
): RebasePlan {
  const include = filter?.include ? new Set(filter.include) : undefined;
  const exclude = filter?.exclude ? new Set(filter.exclude) : undefined;
  const subtree = (filter?.subtree ?? '').replace(/\/+$/, '');
  const { margins, sizes } = simulate(parsed, opts?.viewport);

  const toWrite: RebaseEntry[] = [];
  const skippedContainerChildren: string[] = [];
  const skippedByFilter: string[] = [];
  const skippedUnresolvedParent: string[] = [];
  const skippedNoGeometry: string[] = [];

  for (const n of parsed) {
    // ① 子树范围:范围外不报(不是本计划的事务)
    if (subtree !== '' && n.path !== subtree && !n.path.startsWith(subtree + '/')) continue;
    // ② 名单过滤(exclude 优先)
    if ((exclude?.has(n.name)) || (include && !include.has(n.name))) { skippedByFilter.push(n.path); continue; }
    // ③ Container 父的子
    if (CONTAINER_TYPES.has(n.parentType)) { skippedContainerChildren.push(n.path); continue; }
    // ④ 无授权几何
    if (!n.hasLayout) { skippedNoGeometry.push(n.path); continue; }
    // ⑤ 父尺寸:场景根(父 = 视口)或锚定链不可解/非正
    let ps = n.path === '.' ? undefined : sizes.get(n.parentPath);
    if (!ps || !(ps.w > 0) || !(ps.h > 0)) {
      // 批2 Task1:viewport 兜底——仅「父=根形态」节点(一级子 parentPath='.';根自身
      // path='.' 零锚时父=视口,几何亦成立)且 opts.viewport 为正时,以视口为父尺寸继续
      // 既有求解(f32 感知推导同款)。深层链断节点(父≠根)即使零锚有静态边距也不兜底
      // ——真实父尺寸≠视口,以视口求解写盘即偏移(Task1 审查 Important 收紧)。非零锚
      // 且父链断的节点目标边距本身依赖运行时(margins 无值),viewport 也救不了。
      const vp = opts?.viewport;
      const isRootParentForm = n.path === '.' || n.parentPath === '.';
      if (!isRootParentForm || !(vp && vp.w > 0 && vp.h > 0) || !margins.has(n.path)) {
        skippedUnresolvedParent.push(n.path); continue;
      }
      ps = vp;
    }
    // ⑥ f32 感知求解(文件头注):anchor 吸附后 fround 量化,offset = 边距 − fl32(anchor·p)
    const mm = margins.get(n.path)!;  // ⑤ 通过 → 零锚节点边距恒有;锚定节点父尺寸已知 → 已算;viewport 兜底路径经 margins.has 守卫
    const solve = (t: number, p: number): { a: number; o: number } => {
      const a = fr(snap(t / p));
      return { a, o: t - fr(a * p) };
    };
    const L = solve(mm.l, ps.w), T = solve(mm.t, ps.h), R = solve(mm.r, ps.w), B = solve(mm.b, ps.h);
    toWrite.push({
      path: n.path, name: n.name, tscnParent: n.tscnParent,
      anchors: {
        anchor_left: L.a, anchor_right: R.a, anchor_top: T.a, anchor_bottom: B.a,
        offset_left: L.o, offset_right: R.o, offset_top: T.o, offset_bottom: B.o,
      },
    });
  }
  return { toWrite, skippedContainerChildren, skippedByFilter, skippedUnresolvedParent, skippedNoGeometry };
}

// ─── tscn 文本 patch(段落级写回)────────────────────────────────────────────

const LAYOUT_PROP_RE = /^\s*(layout_mode|anchors_preset|anchor_left|anchor_right|anchor_top|anchor_bottom|offset_left|offset_right|offset_top|offset_bottom)\s*=/;

/** 浮点字面量:float32 精确值的 float64 最短往返十进制(Godot VariantParser 解析到
 * double 再窄化到 real_t,值位级还原);整数值补 .0 保持浮点语义。 */
function fmtFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`INVALID_PARAMS: non-finite layout value: ${v}`);
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** 段落级文本替换:目标 [node] 段内删除既有布局行(layout_mode / anchors_preset /
 * anchor_* / offset_*),在段头后插入 layout_mode=1 + 四 anchor + 四 offset;段内其他
 * 属性行、段外字节与注释逐字节不动。CRLF 场景新增行跟随文件换行风格。 */
export function applyRebasePatch(tscnText: string, toWrite: RebaseEntry[]): { text: string; patched: number; warnings: string[] } {
  const lines = tscnText.split('\n');
  const crlf = lines.some(l => l.endsWith('\r'));
  const eol = crlf ? '\r' : '';
  const want = new Map(toWrite.map(e => [`${e.tscnParent} ${e.name}`, e]));
  const warnings: string[] = [];
  const edits: Array<{ header: number; block: string[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;
    const name = getBracketAttr(trimmed, 'name');
    if (name === null) continue;
    const parent = getBracketAttr(trimmed, 'parent') ?? '';
    const entry = want.get(`${parent} ${name}`);
    if (!entry) continue;
    want.delete(`${parent} ${name}`);  // 同名同父段只 patch 第一处(重复段在 Godot 中非法)
    const end = findSectionEnd(lines, i);
    const kept: string[] = [];
    for (let j = i + 1; j < end; j++) {
      if (!LAYOUT_PROP_RE.test(lines[j]!)) kept.push(lines[j]!);
    }
    const a = entry.anchors;
    edits.push({
      header: i,
      block: [
        `layout_mode = 1${eol}`,
        `anchor_left = ${fmtFloat(a.anchor_left)}${eol}`,
        `anchor_top = ${fmtFloat(a.anchor_top)}${eol}`,
        `anchor_right = ${fmtFloat(a.anchor_right)}${eol}`,
        `anchor_bottom = ${fmtFloat(a.anchor_bottom)}${eol}`,
        `offset_left = ${fmtFloat(a.offset_left)}${eol}`,
        `offset_top = ${fmtFloat(a.offset_top)}${eol}`,
        `offset_right = ${fmtFloat(a.offset_right)}${eol}`,
        `offset_bottom = ${fmtFloat(a.offset_bottom)}${eol}`,
        ...kept,
      ],
    });
  }
  for (const key of want.keys()) warnings.push(`节点段未在文本中定位(未写回): ${key}`);

  // 自底向上 splice,前面的段索引不受影响
  edits.sort((x, y) => y.header - x.header);
  for (const e of edits) {
    const end = findSectionEnd(lines, e.header);
    lines.splice(e.header + 1, end - e.header - 1, ...e.block);
  }
  return { text: lines.join('\n'), patched: edits.length, warnings };
}
