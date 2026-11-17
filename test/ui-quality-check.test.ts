// Task 3 (quality-check 起建):0 容差基线比对 compareBaseline。
// 测试逐字来自 brief Step 1 三例:① 完全一致 ② 浮点微差 0.0001 ③ 基线有/实测缺。
// Task 4 (批1 1c):四类品质检查器(裸壳/应跟随/等距组/溢出)+ buildQualityReport 聚合
// + index.ts 挂节接线(mock executor)+ 靶子 e2e(报告量预估,spec §1c)。
// fixture 手写 MeasuredNode(类型从 layout-diff.ts 导入)。

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareBaseline, detectBareShell, detectShouldFollow, detectViewportOverflow, detectEquidistant, detectSpacingScale, buildQualityReport } from '../src/tools/ui/quality-check.js';
import { handleTool } from '../src/tools/ui/index.js';
import type { MeasuredNode } from '../src/tools/ui/layout-diff.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { mockSuccessResult } from './helpers/mock-results.js';
import { isolatePathEnv } from './helpers/path-isolation.js';

// executor mock:接线单测注入桩输出;靶子 e2e 在 beforeAll 把 mockImplementation 指回
// 真实 executor(本文件同载纯函数/接线/靶子 e2e 三形态,工厂闭包持有真实引用)
const { execMock, realExecutor } = vi.hoisted(() => ({
  execMock: vi.fn(),
  realExecutor: { fn: null as null | ((...args: never[]) => Promise<unknown>) },
}));
vi.mock('../src/gdscript-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gdscript-executor.js')>();
  realExecutor.fn = actual.executeGdscriptTrusted as unknown as (...args: never[]) => Promise<unknown>;
  return {
    ...actual,
    executeGdscriptTrusted: (...args: Parameters<typeof actual.executeGdscriptTrusted>) => execMock(...args),
  };
});

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

// ─── 靶子真实结构标定 fixture(Review Focus 4 / spec 开放问题 4)──────────────
// 逐值转写自 DotaLegendGodot daily_login_content.tscn(2026-11-16 读盘):
// 根 DailyLoginContent(全铺)> Panel(Control;靶子真实无 override,fixture 加
// stylebox override 钉"装饰面板豁免"规则)> Bj(TextureRect 硬 offset 全铺 Panel,
// anchors 全 0)+ MoneyLay(裸 Control 壳 + 3 个 anchor 全 0 子,offsets 取 tscn 原值)。

const A0 = { left: 0, right: 0, top: 0, bottom: 0 };

function targetFixture(): MeasuredNode[] {
  return [
    { path: '.', type: 'Control', rect: { x: 0, y: 0, w: 960, h: 540 },
      anchors: { left: 0, right: 1, top: 0, bottom: 1 }, offsets: { left: 0, right: 0, top: 0, bottom: 0 } },
    { path: 'Panel', type: 'Control', rect: { x: 100.75, y: 36.25, w: 758.5, h: 493.5 },
      anchors: { ...A0 }, offsets: { left: 100.75, top: 36.25, right: 859.25, bottom: 529.75 },
      styles: [{ path: 'Panel', slot: 'panel', flat: true }] },
    { path: 'Panel/Bj', type: 'TextureRect', rect: { x: 100.75, y: 36.25, w: 758.5, h: 493.5 },
      anchors: { ...A0 }, offsets: { left: 0, top: 0, right: 758.5, bottom: 493.5 } },
    { path: 'Panel/MoneyLay', type: 'Control', rect: { x: 112.25, y: 44.75, w: 225, h: 64 },
      anchors: { ...A0 }, offsets: { left: 11.5, top: 8.5, right: 236.5, bottom: 72.5 } },
    { path: 'Panel/MoneyLay/DataImg2', type: 'TextureRect', rect: { x: 120.75, y: 48.25, w: 43, h: 43 },
      anchors: { ...A0 }, offsets: { left: 8.5, top: 3.5, right: 51.5, bottom: 46.5 } },
    { path: 'Panel/MoneyLay/MonthNum', type: 'TextureRect', rect: { x: 156, y: 53, w: 46.5, h: 36.5 },
      anchors: { ...A0 }, offsets: { left: 43.75, top: 8.25, right: 90.25, bottom: 44.75 } },
    { path: 'Panel/MoneyLay/LoginMonthLabel', type: 'Label', rect: { x: 199.25, y: 61.75, w: 100, h: 24 },
      anchors: { ...A0 }, offsets: { left: 87, top: 17, right: 187, bottom: 41 }, text: '月签到' },
  ];
}

describe('detectBareShell', () => {
  it('标定命中:MoneyLay(裸 Control 壳 + 3 个 anchor 全 0 子)为唯一命中;Panel(带 stylebox)豁免', () => {
    expect(detectBareShell(targetFixture())).toEqual([
      { path: 'Panel/MoneyLay', childCount: 3 },
    ]);
  });
  it('摘掉 Panel 的 stylebox override → Panel 也命中(豁免判据恰是 styles 字段;靶子真实 Panel 即此形态)', () => {
    const noStyles = targetFixture().map(m => (m.path === 'Panel' ? { ...m, styles: undefined } : m));
    expect(detectBareShell(noStyles).map(h => h.path)).toEqual(['Panel', 'Panel/MoneyLay']);
  });
  it('反向:壳下仅 1 个子 → 不命中', () => {
    const one: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 100, h: 50 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 5, y: 5, w: 20, h: 20 }, anchors: { ...A0 }, offsets: { left: 5, top: 5, right: 25, bottom: 25 } },
    ];
    expect(detectBareShell(one)).toEqual([]);
  });
  it('反向:任一子 anchor 非 0(anchor_right=1)→ 不命中', () => {
    const anchored = targetFixture().map(m => (m.path === 'Panel/MoneyLay/DataImg2'
      ? { ...m, anchors: { left: 0, right: 1, top: 0, bottom: 0 } } : m));
    expect(detectBareShell(anchored)).toEqual([]);
  });
  it('反向:子 offsets 全 0(退化堆叠)→ 不命中', () => {
    const zero = targetFixture().map(m => (m.path.startsWith('Panel/MoneyLay/')
      ? { ...m, offsets: { left: 0, top: 0, right: 0, bottom: 0 } } : m));
    expect(detectBareShell(zero)).toEqual([]);
  });
  it('反向:非 Control 类型壳(Label/TextureRect 带子)→ 不命中', () => {
    const typed = targetFixture().map(m => (m.path === 'Panel/MoneyLay' ? { ...m, type: 'TextureRect' } : m));
    expect(detectBareShell(typed)).toEqual([]);
  });
});

describe('detectShouldFollow', () => {
  it('标定命中:Bj(TextureRect 硬 offset 全铺 Panel、anchors 全 0)为唯一命中', () => {
    expect(detectShouldFollow(targetFixture())).toEqual([
      { path: 'Panel/Bj', parent: 'Panel' },
    ]);
  });
  it('反向:Bj 改全铺锚点(anchors 非全 0)→ 不命中', () => {
    const anchored = targetFixture().map(m => (m.path === 'Panel/Bj'
      ? { ...m, anchors: { left: 0, right: 1, top: 0, bottom: 1 } } : m));
    expect(detectShouldFollow(anchored)).toEqual([]);
  });
  it('容差边界:四边差恰 2px → 命中;2.5px → 不命中', () => {
    const mk = (d: number): MeasuredNode[] => [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 100, h: 50 }, anchors: { left: 0, right: 1, top: 0, bottom: 1 } },
      { path: 'P/C', type: 'TextureRect', rect: { x: d, y: d, w: 100 - d, h: 50 - d }, anchors: { ...A0 } },
    ];
    expect(detectShouldFollow(mk(2))).toEqual([{ path: 'P/C', parent: 'P' }]);
    expect(detectShouldFollow(mk(2.5))).toEqual([]);
  });
  it('反向:Container 父排除(容器每帧重排、anchor 无意义且 solve_from_current 亦跳过容器子)', () => {
    const inBox: MeasuredNode[] = [
      { path: 'P', type: 'HBoxContainer', rect: { x: 0, y: 0, w: 100, h: 50 } },
      { path: 'P/C', type: 'Control', rect: { x: 0, y: 0, w: 100, h: 50 }, anchors: { ...A0 } },
    ];
    expect(detectShouldFollow(inBox)).toEqual([]);
  });
});

describe('detectViewportOverflow', () => {
  const vp = { w: 960, h: 540 };
  const one = (rect: { x: number; y: number; w: number; h: number }): MeasuredNode[] =>
    [{ path: 'P', type: 'Control', rect }];
  it('命中:右缘超视口 4.25px(> margin 4)→ overflow.w=4.25', () => {
    expect(detectViewportOverflow(one({ x: 100, y: 0, w: 864.25, h: 540 }), vp)).toEqual([
      { path: 'P', overflow: { w: 4.25, h: 0 } },
    ]);
  });
  it('反向:超 3px 在 margin 内(≤4)→ 不命中', () => {
    expect(detectViewportOverflow(one({ x: 0, y: 0, w: 963, h: 540 }), vp)).toEqual([]);
  });
  it('左/上侧越界同样聚合进 w/h(签名只有两值,双侧各并一个数)', () => {
    expect(detectViewportOverflow(one({ x: -5, y: 0, w: 100, h: 545 }), vp)).toEqual([
      { path: 'P', overflow: { w: 5, h: 5 } },
    ]);
  });
  it('标定:靶子 fixture 全在 960×540 内(g960 基线语境)→ 不命中', () => {
    expect(detectViewportOverflow(targetFixture(), vp)).toEqual([]);
  });
});

describe('detectEquidistant', () => {
  // 等距三兄弟:x 间距 10/10;y 错开(间距 10/5,差 >2)隔离单轴命中
  const row3 = (): MeasuredNode[] => [
    { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 200, h: 80 } },
    { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
    { path: 'P/B', type: 'TextureRect', rect: { x: 30, y: 20, w: 20, h: 10 } },
    { path: 'P/C', type: 'TextureRect', rect: { x: 60, y: 35, w: 20, h: 10 } },
  ];
  it('命中:同父 3 节点 x 轴间距 10/10 → parent/axis/members/gap', () => {
    expect(detectEquidistant(row3())).toEqual([
      { parent: 'P', axis: 'x', members: ['P/A', 'P/B', 'P/C'], gap: 10 },
    ]);
  });
  it('命中:y 轴列间距 8/8.5 → axis y,gap 取均值 8.25(间距 = 后缘−前缘,非中心距)', () => {
    const col: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 200, h: 80 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 20 } },
      { path: 'P/B', type: 'TextureRect', rect: { x: 30, y: 28, w: 20, h: 20 } },
      { path: 'P/C', type: 'TextureRect', rect: { x: 65, y: 56.5, w: 20, h: 20 } },
    ];
    expect(detectEquidistant(col)).toEqual([
      { parent: 'P', axis: 'y', members: ['P/A', 'P/B', 'P/C'], gap: 8.25 },
    ]);
  });
  it('反向:间距 10 与 30 → 不命中', () => {
    const uneven = row3();
    uneven[3] = { ...uneven[3]!, rect: { x: 80, y: 35, w: 20, h: 10 } }; // B 缘 50 → C 80:gap 30
    expect(detectEquidistant(uneven)).toEqual([]);
  });
  it('反向:仅 2 成员(单一间距无差值证据)→ 不命中', () => {
    const two = row3().slice(0, 3);
    expect(detectEquidistant(two)).toEqual([]);
  });
  it('run 切分:间距 10/10.5/40 → 仅前 3 节点成组(gap 均值 10.25),第 4 节点分家', () => {
    const four: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 300, h: 80 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
      { path: 'P/B', type: 'TextureRect', rect: { x: 30, y: 20, w: 20, h: 10 } },
      { path: 'P/C', type: 'TextureRect', rect: { x: 60.5, y: 35, w: 20, h: 10 } },
      { path: 'P/D', type: 'TextureRect', rect: { x: 120.5, y: 60, w: 20, h: 10 } },
    ];
    expect(detectEquidistant(four)).toEqual([
      { parent: 'P', axis: 'x', members: ['P/A', 'P/B', 'P/C'], gap: 10.25 },
    ]);
  });
  it('反向:负间距等量叠压堆叠(如 y 同层标签互叠)→ 不命中(容器化为负 separation 属病理,靶子标定)', () => {
    // 三节点 y 向等量叠压(间距 -20/-20.5):等"距"但非排布行,不报
    const stacked: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 300, h: 80 } },
      { path: 'P/A', type: 'Label', rect: { x: 0, y: 0, w: 100, h: 40 }, text: 'a' },
      { path: 'P/B', type: 'Label', rect: { x: 0, y: 20, w: 100, h: 40 }, text: 'b' },
      { path: 'P/C', type: 'Label', rect: { x: 0, y: 39.5, w: 100, h: 40 }, text: 'c' },
    ];
    expect(detectEquidistant(stacked)).toEqual([]);
  });
  it('贴邻 gap=0 的紧排三节点 → 命中(gap 0,合法容器化候选 separation=0)', () => {
    const tight: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 300, h: 80 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
      { path: 'P/B', type: 'TextureRect', rect: { x: 20, y: 5, w: 20, h: 10 } },
      { path: 'P/C', type: 'TextureRect', rect: { x: 40, y: 9, w: 20, h: 10 } },
    ];
    expect(detectEquidistant(tight)).toEqual([
      { parent: 'P', axis: 'x', members: ['P/A', 'P/B', 'P/C'], gap: 0 },
    ]);
  });
});

// ─── 批2 Task2: 间距档位检测 ─────────────────────────────────────────────────

/** 同 y 行兄弟 fixture:相邻 x 间距按 gaps 逐个布放(节点宽 20,y 全同——y 轴相邻对
 * 间距恒负跳过,隔离单轴)。 */
function rowFixtureSpacing(gaps: number[]): MeasuredNode[] {
  const nodes: MeasuredNode[] = [
    { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 500, h: 80 } },
    { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
  ];
  let x = 20;
  gaps.forEach((g, i) => {
    x += g;
    nodes.push({ path: `P/${'BCDEF'[i]}`, type: 'TextureRect', rect: { x, y: 0, w: 20, h: 10 } });
    x += 20;
  });
  return nodes;
}

describe('detectSpacingScale(批2 Task2)', () => {
  it('brief Step2 ①:兄弟间距 [8,8,16,13] 档位 [4,8,12,16,24] → rate=0.75,off_scale 含 13→nearest 12 一条', () => {
    const r = detectSpacingScale(rowFixtureSpacing([8, 8, 16, 13]), [4, 8, 12, 16, 24]);
    expect(r).not.toBeNull();
    expect(r!.on_scale).toBe(3);
    expect(r!.total).toBe(4);
    expect(r!.rate).toBe(0.75);
    expect(r!.off_scale).toEqual([{ a: 'P/D', b: 'P/E', gap: 13, nearest: 12 }]);
  });
  it('brief Step2 ②:单档表 [8] 间距 [8,9] → rate=0.5(9 距最近档 8 仅 1px 仍算 off)', () => {
    const r = detectSpacingScale(rowFixtureSpacing([8, 9]), [8]);
    expect(r).not.toBeNull();
    expect(r!.on_scale).toBe(1);
    expect(r!.total).toBe(2);
    expect(r!.rate).toBe(0.5);
    expect(r!.off_scale).toEqual([{ a: 'P/B', b: 'P/C', gap: 9, nearest: 8 }]);
  });
  it('brief Step2 ③:零兄弟对 → null(不发噪音)', () => {
    const single: MeasuredNode[] = [{ path: '.', type: 'Control', rect: { x: 0, y: 0, w: 100, h: 50 } }];
    expect(detectSpacingScale(single, [8])).toBeNull();
  });
  it('brief Step2 ④:scale 空 → null(无档位声明,Review Focus 3)', () => {
    expect(detectSpacingScale(rowFixtureSpacing([8]), [])).toBeNull();
  });
  it('nearest 并列取较小档(间距 10 档 [8,12] 距均 2 → nearest 8)', () => {
    const r = detectSpacingScale(rowFixtureSpacing([10]), [12, 8]);
    expect(r!.off_scale).toEqual([{ a: 'P/A', b: 'P/B', gap: 10, nearest: 8 }]);
  });
  it('贴邻 gap=0 不在档位 → off(合法紧排但非档位间距,如实报数)', () => {
    const r = detectSpacingScale(rowFixtureSpacing([0]), [8]);
    expect(r!.on_scale).toBe(0);
    expect(r!.off_scale).toEqual([{ a: 'P/A', b: 'P/B', gap: 0, nearest: 8 }]);
  });
  it('Container 父的兄弟组排除(间距是容器排布行为,与 detectEquidistant 同纪律)', () => {
    const inBox: MeasuredNode[] = [
      { path: 'P', type: 'HBoxContainer', rect: { x: 0, y: 0, w: 300, h: 80 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
      { path: 'P/B', type: 'TextureRect', rect: { x: 28, y: 0, w: 20, h: 10 } },
    ];
    expect(detectSpacingScale(inBox, [8])).toBeNull();
  });
});

describe('buildQualityReport spacing_scale(批2 Task2)', () => {
  it('有档位且有偏离 → order.spacing_scale 挂节;等距空数组照挂(quality 节同款先例),quality 无发现省略', () => {
    // 间距 [8,16,13]:无等距 run(8|16 差 8、16|13 差 3 均切);档位 [8,16] → on 2 / off 1(nearest 16)
    const r = buildQualityReport(rowFixtureSpacing([8, 16, 13]), { spacingScale: [8, 16] });
    expect(r!.quality).toBeNull();
    expect(r!.order!.equidistant).toEqual([]);
    expect(r!.order!.spacing_scale).toEqual({
      on_scale: 2, total: 3, rate: 2 / 3,
      off_scale: [{ a: 'P/C', b: 'P/D', gap: 13, nearest: 16 }],
    });
  });
  it('无 spacingScale 且无等距 → order 整节约略(无声明不发噪音)', () => {
    expect(buildQualityReport(rowFixtureSpacing([8, 16, 13]))).toBeNull();
  });
});

describe('buildQualityReport', () => {
  it('空输入集 → null(D8:无发现省略输出)', () => {
    expect(buildQualityReport([], { viewport: { w: 960, h: 540 } })).toBeNull();
  });
  it('无 viewport → 跳过视口溢出,其余检测照常', () => {
    const r = buildQualityReport(targetFixture());
    expect(r?.quality?.bare_shells.map(b => b.path)).toEqual(['Panel/MoneyLay']);
    expect(r?.quality?.viewport_overflow).toEqual([]);
  });
  it('有发现 → 报告对象,条目各带中文建议(指向 solve_from_current/容器化);靶子 960×540 无溢出无等距 → order null', () => {
    const r = buildQualityReport(targetFixture(), { viewport: { w: 960, h: 540 } });
    expect(r).not.toBeNull();
    expect(r!.quality).not.toBeNull();
    const shell = r!.quality!.bare_shells.find(b => b.path === 'Panel/MoneyLay')!;
    expect(shell.childCount).toBe(3);
    expect(shell.suggestion).toContain('solve_from_current');
    const follow = r!.quality!.should_follow.find(s => s.path === 'Panel/Bj')!;
    expect(follow.parent).toBe('Panel');
    expect(follow.suggestion).toContain('solve_from_current');
    expect(r!.quality!.out_of_bounds).toEqual([]);
    expect(r!.order).toBeNull();
  });
  it('仅等距发现 → quality null / order 非空(两节独立省略语义)', () => {
    const anchor05 = { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 };
    const nodes: MeasuredNode[] = [
      { path: 'P', type: 'Control', rect: { x: 0, y: 0, w: 200, h: 80 }, anchors: { left: 0, right: 1, top: 0, bottom: 1 } },
      { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 }, anchors: anchor05 },
      { path: 'P/B', type: 'TextureRect', rect: { x: 30, y: 20, w: 20, h: 10 }, anchors: anchor05 },
      { path: 'P/C', type: 'TextureRect', rect: { x: 60, y: 35, w: 20, h: 10 }, anchors: anchor05 },
    ];
    const r = buildQualityReport(nodes, { viewport: { w: 200, h: 80 } });
    expect(r!.quality).toBeNull();
    expect(r!.order!.equidistant).toHaveLength(1);
    expect(r!.order!.equidistant[0]!.suggestion).toContain('容器化');
  });
});

// ─── Step 5: index.ts 挂节接线(mock executor,不出 Godot)──────────────────

function fakeCtx(): ToolContext {
  return { findGodot: async () => '/fake/godot' } as unknown as ToolContext;
}

describe('ui_measure_layout quality/order 挂节(mock executor)', () => {
  let tmpProj: string;
  let restore: () => void;
  beforeEach(() => {
    tmpProj = mkdtempSync(join(tmpdir(), 'ui-quality-'));
    writeFileSync(join(tmpProj, 'project.godot'), '[application]\nname="Test"\n');
    restore = isolatePathEnv({ allowed: [tmpProj] });
    vi.clearAllMocks();
  });
  afterEach(() => {
    restore();
    rmSync(tmpProj, { recursive: true, force: true });
  });

  function mockMeasureOutput(nodes: MeasuredNode[], stalled = false, themeConstants?: Record<string, number>) {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({
      outputs: [{ key: 'measure', value: JSON.stringify({
        stable_after_frames: 3, stalled, viewport: { w: 960, h: 540 }, nodes,
        ...(themeConstants ? { theme_constants: themeConstants } : {}) }) }],
    }));
  }

  async function runMeasure(): Promise<{ data: Record<string, unknown> }> {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: tmpProj, scene_path: 'res://main.tscn',
    }, fakeCtx()) as ToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.success).toBe(true);
    return body;
  }

  it('有发现 → data.quality 挂节(含建议);无等距 → order 省略', async () => {
    mockMeasureOutput(targetFixture());
    const body = await runMeasure();
    const q = body.data.quality as { bare_shells: Array<{ path: string }>; should_follow: Array<{ path: string }>; viewport_overflow: unknown[] };
    expect(q.bare_shells.map(b => b.path)).toEqual(['Panel/MoneyLay']);
    expect(q.should_follow).toContainEqual(expect.objectContaining({ path: 'Panel/Bj' }));
    expect(q.viewport_overflow).toEqual([]);
    expect(body.data.order).toBeUndefined();
  });
  it('stalled=true → quality/order 均不挂(D8:布局未收敛不出判定)', async () => {
    mockMeasureOutput(targetFixture(), true);
    const body = await runMeasure();
    expect(body.data.quality).toBeUndefined();
    expect(body.data.order).toBeUndefined();
  });
  it('无发现 → 两字段均省略(D8 null 语义)', async () => {
    mockMeasureOutput([{ path: '.', type: 'Panel', rect: { x: 0, y: 0, w: 960, h: 540 },
      anchors: { left: 0, right: 1, top: 0, bottom: 1 } }]);
    const body = await runMeasure();
    expect(body.data.quality).toBeUndefined();
    expect(body.data.order).toBeUndefined();
  });
  it('批2 Task2:measure 带 theme_constants(space_*)→ order.spacing_scale 挂节(非 space 键不进档位)', async () => {
    mockMeasureOutput(rowFixtureSpacing([8, 16, 13]), false, { space_2: 16, space_1: 8, font_scale: 14 });
    const body = await runMeasure();
    const order = body.data.order as {
      equidistant: unknown[];
      spacing_scale: { on_scale: number; total: number; rate: number; off_scale: Array<{ gap: number; nearest: number }> };
    };
    expect(order.equidistant).toEqual([]);
    expect(order.spacing_scale.on_scale).toBe(2);
    expect(order.spacing_scale.total).toBe(3);
    expect(order.spacing_scale.off_scale).toEqual([{ a: 'P/C', b: 'P/D', gap: 13, nearest: 16 }]);
  });
  it('批2 Task2:measure 无 theme_constants → order 不因档位挂出(无声明不发噪音)', async () => {
    mockMeasureOutput(rowFixtureSpacing([8, 16, 13]));
    const body = await runMeasure();
    expect(body.data.order).toBeUndefined();
  });
  it('批2 Task2:stalled=true → spacing_scale 同样不挂(D8 布局未收敛不出判定)', async () => {
    mockMeasureOutput(rowFixtureSpacing([8, 16, 13]), true, { space_1: 8, space_2: 16 });
    const body = await runMeasure();
    expect(body.data.quality).toBeUndefined();
    expect(body.data.order).toBeUndefined();
  });
});

describe('ui_import_prototype quality/order 挂节(mock executor)', () => {
  const GEO_MIN = {
    viewport: { w: 800, h: 600 },
    nodes: [{ name: 'A', rect: { x: 0, y: 0, w: 20, h: 24 } }],
  };
  // 等距三兄弟(x 间距 10/10;y 错开隔离单轴)挂 _PrototypeRoot(Panel,非裸 Control)
  function importMeasureNodes(): MeasuredNode[] {
    return [
      { path: '_PrototypeRoot', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 600 } },
      { path: '_PrototypeRoot/A', type: 'Label', rect: { x: 0, y: 0, w: 20, h: 24 }, text: 'a' },
      { path: '_PrototypeRoot/B', type: 'Label', rect: { x: 30, y: 30, w: 20, h: 24 }, text: 'b' },
      { path: '_PrototypeRoot/C', type: 'Label', rect: { x: 60, y: 36, w: 20, h: 24 }, text: 'c' },
    ];
  }
  function mockImportSingle(nodes: MeasuredNode[], stalled = false) {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({
      outputs: [
        { key: 'persist', value: JSON.stringify({ saved: true }) },
        { key: 'measure', value: JSON.stringify({
          stable_after_frames: 3, stalled, viewport: { w: 800, h: 600 }, nodes }) },
      ],
    }));
  }
  beforeEach(() => { vi.clearAllMocks(); });

  async function runImport(): Promise<{ data: Record<string, unknown> }> {
    const r = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_MIN,
    }, fakeCtx()) as ToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.success).toBe(true);
    return body;
  }

  it('等距兄弟 → data.order 挂节(容器化建议),quality 无发现省略', async () => {
    mockImportSingle(importMeasureNodes());
    const body = await runImport();
    const order = body.data.order as { equidistant: Array<{ members: string[]; suggestion: string }> };
    expect(order.equidistant).toHaveLength(1);
    expect(order.equidistant[0]!.members).toEqual(['_PrototypeRoot/A', '_PrototypeRoot/B', '_PrototypeRoot/C']);
    expect(order.equidistant[0]!.suggestion).toContain('容器化');
    expect(body.data.quality).toBeUndefined();
  });
  it('stalled=true → 两字段均省略', async () => {
    mockImportSingle(importMeasureNodes(), true);
    const body = await runImport();
    expect(body.data.quality).toBeUndefined();
    expect(body.data.order).toBeUndefined();
  });
});

// ─── Step 6: 靶子 e2e(报告量预估,spec §1c;双 skipIf:GODOT_PATH + 靶子项目)──

const GODOT_PATH = process.env.GODOT_PATH || '';
const TARGET_PROJECT = 'D:/workspace/projects/DotaLegendGodot';
const hasE2e = GODOT_PATH !== '' && existsSync(GODOT_PATH) && existsSync(TARGET_PROJECT);

describe.skipIf(!hasE2e)('quality 靶子 e2e(DotaLegendGodot daily_login,挂主题 measure 一次)', () => {
  beforeAll(() => {
    // 本文件 executor 被 vi.mock 包装(接线单测注入桩输出);e2e 直通真实 executor
    execMock.mockReset();
    execMock.mockImplementation((...args: never[]) => realExecutor.fn!(...args));
  });
  afterAll(() => { execMock.mockReset(); });

  it('quality 报告:改造前命中 MoneyLay 裸壳(名单化基线);批1 改造后全零——靶子两态自适应', async () => {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: TARGET_PROJECT,
      scene_path: 'res://scenes/ui/daily_login_content.tscn',
      theme_path: 'res://resources/themes/default_theme.tres',
    }, { findGodot: async () => GODOT_PATH } as unknown as ToolContext) as ToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.success).toBe(true);
    const q = body.data.quality as {
      bare_shells: Array<{ path: string }>;
      should_follow: Array<{ path: string }>;
      out_of_bounds: unknown[];
      viewport_overflow: unknown[];
    } | undefined;
    // 批1 Task7 验收(2026-11-17)可能已把靶子 daily_login 改造为比例锚点,且去留由用户
    // 裁决——工作区「改造前/改造后」两态皆合法,e2e 不硬绑历史状态:quality 节存在 =
    // 改造前(下方原断言全保留);缺席 = 改造后,须实证场景确已锚点化(而非检测器哑火),
    // 报告全零是名单化处置完毕的结果(证据:docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md)。
    if (q === undefined) {
      const sceneText = readFileSync(join(TARGET_PROJECT, 'scenes/ui/daily_login_content.tscn'), 'utf-8');
      const panelSec = sceneText.split('[node name="Panel"')[1]!.split('[node')[0];
      expect(panelSec, 'quality 全零须以场景已锚点化为证(防检测器哑火假绿)').toMatch(/layout_mode = 1/);
      expect(panelSec).toMatch(/anchor_left = 0\.1/);
      expect(body.data.order).toBeUndefined();
      console.log('[task4-e2e] 靶子已处批1改造后状态:裸壳/应跟随/溢出/等距全零(名单化处置完毕,见 docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md)');
      return;
    }
    const shells = q.bare_shells.map(b => b.path);
    expect(shells).toContain('Panel/MoneyLay');
    console.log(`[task4-e2e] 裸壳 x${q.bare_shells.length}: ${JSON.stringify(shells)}`);
    console.log(`[task4-e2e] 应跟随 x${q.should_follow.length}: ${JSON.stringify(q.should_follow.map(s => s.path))}`);
    console.log(`[task4-e2e] 父级越界 x${q.out_of_bounds.length} 视口溢出 x${q.viewport_overflow.length}`);
    const order = body.data.order as { equidistant: Array<{ parent: string; axis: string; gap: number; members: string[] }> } | undefined;
    console.log(`[task4-e2e] 等距组 x${order ? order.equidistant.length : 0}`);
    for (const g of order?.equidistant ?? []) {
      console.log(`  - ${g.parent} ${g.axis} gap=${g.gap} members=${g.members.length}`);
    }
  }, 180_000);

  it('批2 Task2:default_theme.tres 无 DesignTokens type → theme_constants={} 且 order 不含 spacing_scale(Review Focus 2,空档静默跳过)', async () => {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: TARGET_PROJECT,
      scene_path: 'res://scenes/ui/daily_login_content.tscn',
      theme_path: 'res://resources/themes/default_theme.tres',
    }, { findGodot: async () => GODOT_PATH } as unknown as ToolContext) as ToolResult;
    expect(r.isError).toBeFalsy();
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.success).toBe(true);
    const measure = body.data.measure as { theme_constants?: Record<string, number>; stalled?: boolean };
    expect(measure.stalled).not.toBe(true);
    expect(measure.theme_constants).toEqual({});
    const order = body.data.order as { spacing_scale?: unknown } | undefined;
    expect(order?.spacing_scale, '空档跳过:order 或缺 spacing_scale').toBeUndefined();
  }, 180_000);
});
