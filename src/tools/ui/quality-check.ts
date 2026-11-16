// 质量门(基线快照与 0 容差比对):布局约束批次(1b)的验收基础设施。
// compareBaseline:实测 vs 基线逐节点 rect 四值严格 `===`(浮点直接比,不经 round);
// 路径集差异(基线有/实测无、实测有/基线无)双向进 mismatches——缺失一侧的数值
// 用 NaN 标注、field 置 'x'。NaN 比较用 Number.isNaN 显式处理,不落 `!==` 陷阱
// (NaN !== NaN 恒真,裸 !== 会把"双侧同 NaN"误判不等、把单侧 NaN 误判成普通数值差)。
// 纯函数,零 Godot 依赖。

import type { MeasuredNode } from './layout-diff.js';

// 质量报告(本任务空壳,Task 4 填充字段)
export interface QualityReport {}

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
