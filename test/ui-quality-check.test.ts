// Task 3 (quality-check 起建):0 容差基线比对 compareBaseline。
// 测试逐字来自 brief Step 1 三例:① 完全一致 ② 浮点微差 0.0001 ③ 基线有/实测缺。
// fixture 手写 MeasuredNode(类型从 layout-diff.ts 导入)。

import { describe, it, expect } from 'vitest';
import { compareBaseline } from '../src/tools/ui/quality-check.js';
import type { MeasuredNode } from '../src/tools/ui/layout-diff.js';

const n = (path: string, x: number, y: number, w: number, h: number): MeasuredNode =>
  ({ path, type: 'Control', rect: { x, y, w, h } });

describe('compareBaseline', () => {
  it('完全一致 → ok:true 且 mismatches 为空', () => {
    const baseline = [n('P', 0, 0, 100, 50), n('P/A', 10, 10, 80, 30)];
    expect(compareBaseline(baseline, baseline.slice())).toEqual({ ok: true, mismatches: [] });
  });

  it('某节点 w 差 0.0001 → ok:false,mismatches 点名 field:w 与 expected/actual', () => {
    const baseline = [n('P', 0, 0, 100, 50)];
    const measured = [n('P', 0, 0, 100.0001, 50)];
    expect(compareBaseline(measured, baseline)).toEqual({
      ok: false,
      mismatches: [{ path: 'P', field: 'w', expected: 100, actual: 100.0001 }],
    });
  });

  it('基线有节点实测缺 → mismatches 含该 path(field x + NaN 标注)', () => {
    const baseline = [n('P', 0, 0, 100, 50), n('P/Missing', 5, 5, 20, 20)];
    const measured = [n('P', 0, 0, 100, 50)];
    const r = compareBaseline(measured, baseline);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContainEqual({
      path: 'P/Missing', field: 'x', expected: 5, actual: NaN,
    });
  });
});
