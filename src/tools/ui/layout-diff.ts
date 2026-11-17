// 布局对比:measure 结果 vs 目标 spec(rect)的逐节点 diff + 重叠/越界检测。
// Pascal verify_scene 模式(spec §3.1/§4):结构化问题清单,数字驱动收敛。
// 路径同构约定:ui_measure_layout 不带 node_path 时 path 为 get_path_to 名称链
// ('P' / 'P/A',不含场景根名),expect_tree 传 ui_build_layout 的同一棵树(挂场景
// 根下)时 flattenTargets 计根名,两者恰好逐一对齐。
// C1 坐标语义:target.rect 相对父左上角(与生成侧一致);diff 的 actual 换算为
// 父相对坐标(子 global − 父 global),根级 target 以视口原点为参照。

import type { UiNodeSpec, StyleBoxFlatSpec } from './types.js';
import type { Rect } from './anchor-solver.js';

export interface MeasuredNode {
  path: string;
  type: string;
  rect: Rect;
  anchors?: Record<string, number>;
  offsets?: Record<string, number>;
  visible?: boolean;
  text?: string;
  styles?: StyleReading[];
}

export interface DiffEntry {
  path: string;
  target: Rect | null;
  actual: Rect | null;
  delta: { dx: number; dy: number; dw: number; dh: number };
  ok: boolean;
}

export function flattenTargets(tree: UiNodeSpec, prefix?: string): Array<{ path: string; rect: Rect }> {
  const selfPath = prefix ? `${prefix}/${tree.name}` : tree.name;
  const out: Array<{ path: string; rect: Rect }> = [];
  if (tree.rect) out.push({ path: selfPath, rect: tree.rect });
  for (const c of tree.children ?? []) out.push(...flattenTargets(c, selfPath));
  return out;
}

export function diffLayout(
  measured: MeasuredNode[],
  targets: Array<{ path: string; rect: Rect }>,
  tolerancePx = 2,
): DiffEntry[] {
  const byPath = new Map(measured.map(m => [m.path, m]));
  return targets.map(t => {
    const m = byPath.get(t.path);
    if (!m) {
      return { path: t.path, target: t.rect, actual: null,
        delta: { dx: NaN, dy: NaN, dw: NaN, dh: NaN }, ok: false };
    }
    // C1: target 语义 = 相对父左上角(与生成侧 uiNodeToGd 一致),actual 换算为同构的父相对坐标:
    //   子 global − 父 global(父 = path 去最后一段,从 measure 输出查);
    //   根级 target(无父段,即树根自身 rect)以视口原点为参照——树挂场景根下,根 global 即视口系;
    //   父不在测量集(中间节点未渲染/不可见)→ NaN 缺失语义,不 ok。
    const parentPath = parentOf(t.path);
    const parent = parentPath === '' ? null : byPath.get(parentPath);
    if (parentPath !== '' && !parent) {
      return { path: t.path, target: t.rect, actual: null,
        delta: { dx: NaN, dy: NaN, dw: NaN, dh: NaN }, ok: false };
    }
    const ax = m.rect.x - (parent ? parent.rect.x : 0);
    const ay = m.rect.y - (parent ? parent.rect.y : 0);
    const dx = ax - t.rect.x, dy = ay - t.rect.y;
    const dw = m.rect.w - t.rect.w, dh = m.rect.h - t.rect.h;
    const ok = Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx
      && Math.abs(dw) <= tolerancePx && Math.abs(dh) <= tolerancePx;
    return { path: t.path, target: t.rect, actual: { x: ax, y: ay, w: m.rect.w, h: m.rect.h },
      delta: { dx, dy, dw, dh }, ok };
  });
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bo = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bo <= y) return null;
  return { x, y, w: r - x, h: bo - y };
}

export function detectOverlaps(measured: MeasuredNode[]): Array<{ a: string; b: string; overlap: Rect }> {
  const groups = new Map<string, MeasuredNode[]>();
  for (const m of measured) {
    // measure 目标根的 path 为 "."(get_path_to 相对路径 artifact):父包子的正常
    // 包含不是兄弟重叠,且它会与一级子同落 parent='' 组 → 排除,防误报。
    if (m.path === '.') continue;
    const p = parentOf(m.path);
    const arr = groups.get(p);
    if (arr) arr.push(m); else groups.set(p, [m]);
  }
  const out: Array<{ a: string; b: string; overlap: Rect }> = [];
  for (const siblings of groups.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const ov = intersect(siblings[i]!.rect, siblings[j]!.rect);
        if (ov && ov.w > 1 && ov.h > 1) {
          out.push({ a: siblings[i]!.path, b: siblings[j]!.path, overlap: ov });
        }
      }
    }
  }
  return out;
}

export function detectOutOfBounds(measured: MeasuredNode[]): Array<{ path: string; parent: string; overflow: Rect }> {
  const byPath = new Map(measured.map(m => [m.path, m]));
  const out: Array<{ path: string; parent: string; overflow: Rect }> = [];
  for (const m of measured) {
    const p = parentOf(m.path);
    if (!p) continue; // 根节点(含 measure 目标根 ".")无父
    const parent = byPath.get(p);
    if (!parent) continue; // 父不在测量集(如一级子的父是场景根 ".")时无法判定,跳过
    const right = (m.rect.x + m.rect.w) - (parent.rect.x + parent.rect.w);
    const bottom = (m.rect.y + m.rect.h) - (parent.rect.y + parent.rect.h);
    const left = parent.rect.x - m.rect.x;
    const top = parent.rect.y - m.rect.y;
    if (right > 1 || bottom > 1 || left > 1 || top > 1) {
      out.push({ path: m.path, parent: p,
        overflow: { x: Math.max(0, left), y: Math.max(0, top), w: Math.max(0, right), h: Math.max(0, bottom) } });
    }
  }
  return out;
}

// ─── PR-2: style_verify / flow_verify(spec §4.1/§4.2)────────────────────────

/** measure 读回的单槽位样式(GD _walk 产出 JSON 形状;flat=false 时仅 type 有值)。 */
export interface StyleReading {
  path: string;
  slot: string;
  flat: boolean;
  type?: string;
  bg_color?: [number, number, number, number];
  corner_radius?: { tl: number; tr: number; br: number; bl: number };
  border_width?: { left: number; top: number; right: number; bottom: number };
  border_color?: [number, number, number, number];
}

/** style_verify 单条:逐槽位逐属性 diff(spec §4.1)。 */
export interface StyleDiffEntry {
  path: string;
  slot: string;
  field: string;
  target: number | number[] | string | null;
  actual: number | number[] | string | null;
  delta: number | number[] | null;
  ok: boolean;
}

/** Color float32 存储的序列化精度(实测 Godot 4.7.1:0.2 → 0.2000000029,
 * 集成用例 5 以 0.002 容差断言——见 test/integration/ui-import-integration.test.ts)。 */
export const STYLE_COLOR_TOL = 0.002;

export interface StyleTargetEntry { path: string; slot: string; box: StyleBoxFlatSpec }

/** expect 树 → stylebox 期望清单(path 链语义与 flattenTargets 同构,根级无前缀)。 */
export function flattenStyleTargets(tree: UiNodeSpec, prefix?: string): StyleTargetEntry[] {
  const selfPath = prefix ? `${prefix}/${tree.name}` : tree.name;
  const out: StyleTargetEntry[] = [];
  if (tree.styleboxes) {
    for (const sb of tree.styleboxes) out.push({ path: selfPath, slot: sb.slot, box: sb.box });
  }
  for (const c of tree.children ?? []) out.push(...flattenStyleTargets(c, selfPath));
  return out;
}

/** 期望清单 → measure 脚本的 path→slots 内嵌清单(GD 侧按需读回判定的并集左侧)。 */
export function styleExpectList(targets: StyleTargetEntry[]): Array<{ path: string; slots: string[] }> {
  const byPath = new Map<string, string[]>();
  for (const t of targets) {
    const arr = byPath.get(t.path) ?? [];
    if (!arr.includes(t.slot)) arr.push(t.slot);
    byPath.set(t.path, arr);
  }
  return [...byPath].map(([path, slots]) => ({ path, slots }));
}

const CORNER_FIELDS = [
  ['tl', 'corner_radius_top_left'],
  ['tr', 'corner_radius_top_right'],
  ['br', 'corner_radius_bottom_right'],
  ['bl', 'corner_radius_bottom_left'],
] as const;

const BORDER_FIELDS = [
  ['left', 'border_width_left'],
  ['top', 'border_width_top'],
  ['right', 'border_width_right'],
  ['bottom', 'border_width_bottom'],
] as const;

function colorDiff(
  path: string, slot: string, field: string, target: number[], actual: number[], tol: number,
): StyleDiffEntry {
  const delta = target.map((t, i) => (actual[i] ?? NaN) - t);
  const ok = delta.every(d => Math.abs(d) <= tol);
  return { path, slot, field, target, actual, delta, ok };
}

/** 目标(StyleBoxFlatSpec)vs 实测读回逐字段 diff。只比 box 中显式设置的字段
 * (缺省字段不比对——生成器同规则缺省不写);非 Flat 以单条 type 红条目暴露
 * (N-5:Label 未 override 的 normal 槽是 StyleBoxEmpty,读 bg_color 会崩/误判);
 * corner/border 宽度为整数属性精确匹配,颜色按 STYLE_COLOR_TOL(float32)。 */
export function diffStyles(
  readings: StyleReading[],
  targets: StyleTargetEntry[],
  colorTol: number = STYLE_COLOR_TOL,
): StyleDiffEntry[] {
  const byKey = new Map(readings.map(r => [`${r.path}/${r.slot}`, r]));
  const out: StyleDiffEntry[] = [];
  for (const t of targets) {
    const r = byKey.get(`${t.path}/${t.slot}`);
    if (!r) {
      // 节点不在测量集(路径不存在/超深/超 2000)——期望落空,显式红条目
      out.push({ path: t.path, slot: t.slot, field: '(reading missing)', target: null, actual: null, delta: null, ok: false });
      continue;
    }
    if (!r.flat) {
      out.push({ path: t.path, slot: t.slot, field: 'type', target: 'StyleBoxFlat', actual: r.type ?? '(non-flat)', delta: null, ok: false });
      continue;
    }
    // GD flat=true 时四组字段必全产出;防御性跳过缺失(不伪装成 diff 结果)
    if (t.box.bg_color !== undefined && r.bg_color) {
      out.push(colorDiff(t.path, t.slot, 'bg_color', [...t.box.bg_color], [...r.bg_color], colorTol));
    }
    if (t.box.corner_radius !== undefined && r.corner_radius) {
      const u = typeof t.box.corner_radius === 'number' ? t.box.corner_radius : undefined;
      const o = typeof t.box.corner_radius === 'object' ? t.box.corner_radius : {};
      for (const [k, field] of CORNER_FIELDS) {
        const tv = o[k] ?? u ?? 0;  // 与生成器 genStyleboxLines 同缺省(未指定角=0)
        const av = r.corner_radius[k]!;
        out.push({ path: t.path, slot: t.slot, field, target: tv, actual: av, delta: av - tv, ok: av === tv });
      }
    }
    if (t.box.border_width !== undefined && r.border_width) {
      for (const [k, field] of BORDER_FIELDS) {
        const tv = t.box.border_width;
        const av = r.border_width[k]!;
        out.push({ path: t.path, slot: t.slot, field, target: tv, actual: av, delta: av - tv, ok: av === tv });
      }
    }
    if (t.box.border_color !== undefined && r.border_color) {
      out.push(colorDiff(t.path, t.slot, 'border_color', [...t.box.border_color], [...r.border_color], colorTol));
    }
  }
  return out;
}

/** flow_verify(spec §4.2):flow 直接子层期望(输入视口绝对)vs measure 实测
 * (global rect,视口绝对)直接 diff——不做父相对换算(与 diffLayout 的关键差异,
 * 消解 B-2 盲区)。孙层不进(由 layout_verify 近似覆盖,纳入会产稳定系统性偏差报警=噪声)。 */
export function diffFlow(
  measured: MeasuredNode[],
  flowExpect: Array<{ path: string; rect: Rect }>,
  tolerancePx = 2,
): DiffEntry[] {
  const byPath = new Map(measured.map(m => [m.path, m]));
  return flowExpect.map(t => {
    const m = byPath.get(t.path);
    if (!m) {
      return { path: t.path, target: t.rect, actual: null,
        delta: { dx: NaN, dy: NaN, dw: NaN, dh: NaN }, ok: false };
    }
    const dx = m.rect.x - t.rect.x, dy = m.rect.y - t.rect.y;
    const dw = m.rect.w - t.rect.w, dh = m.rect.h - t.rect.h;
    const ok = Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx
      && Math.abs(dw) <= tolerancePx && Math.abs(dh) <= tolerancePx;
    return { path: t.path, target: t.rect, actual: m.rect, delta: { dx, dy, dw, dh }, ok };
  });
}

// ─── 批4 Task2: verify 分档 compact 纯函数 ──────────────────────────────────

/** compact 计数摘要(brief Interfaces 形态):total=输入全量,ok/non_ok 按条目 ok,
 * truncated=被 topN 截掉的不 ok 条数。 */
export interface CompactSummary {
  total: number;
  ok: number;
  non_ok: number;
  truncated: number;
}

/** DiffEntry 偏差量键:max(|dx|,|dy|,|dw|,|dh|);任一 NaN(缺失语义)→ 最大(排最前)。 */
function diffSeverity(e: DiffEntry): number {
  const { dx, dy, dw, dh } = e.delta;
  if (Number.isNaN(dx) || Number.isNaN(dy) || Number.isNaN(dw) || Number.isNaN(dh)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
}

/** detail=compact:diff 条目只留不 ok,按偏差量降序(并列稳定按 path)截 topN。
 * Infinity−Infinity=NaN 为 falsy → 双 NaN 并列自然落回 path 次键(V8 sort 稳定)。 */
export function compactDiffEntries(
  entries: DiffEntry[],
  topN = 20,
): { entries: DiffEntry[]; summary: CompactSummary } {
  const nonOk = entries.filter(e => !e.ok);
  nonOk.sort((a, b) => (diffSeverity(b) - diffSeverity(a)) || a.path.localeCompare(b.path));
  const top = nonOk.slice(0, topN);
  return {
    entries: top,
    summary: {
      total: entries.length,
      ok: entries.length - nonOk.length,
      non_ok: nonOk.length,
      truncated: nonOk.length - top.length,
    },
  };
}

/** StyleDiffEntry 偏差量键:数值 |·| / 数组 max |分量| / null(非数值形态)最大;
 * NaN 分量同 diffSeverity 语义按最大处理。 */
function styleSeverity(e: StyleDiffEntry): number {
  const d = e.delta;
  if (d === null) return Number.POSITIVE_INFINITY;
  if (typeof d === 'number') return Number.isNaN(d) ? Number.POSITIVE_INFINITY : Math.abs(d);
  return Math.max(...d.map(v => (Number.isNaN(v) ? Number.POSITIVE_INFINITY : Math.abs(v))));
}

/** detail=compact:style 条目与 compactDiffEntries 同语义(过滤 !ok、偏差量降序、
 * 并列稳定按 path、截 topN + summary)。 */
export function compactStyleEntries(
  entries: StyleDiffEntry[],
  topN = 20,
): { entries: StyleDiffEntry[]; summary: CompactSummary } {
  const nonOk = entries.filter(e => !e.ok);
  nonOk.sort((a, b) => (styleSeverity(b) - styleSeverity(a)) || a.path.localeCompare(b.path));
  const top = nonOk.slice(0, topN);
  return {
    entries: top,
    summary: {
      total: entries.length,
      ok: entries.length - nonOk.length,
      non_ok: nonOk.length,
      truncated: nonOk.length - top.length,
    },
  };
}
