// Task 4 (layout-diff): expect_tree 逐节点 diff/重叠/越界。
// 纯函数测试逐字来自 brief Step 1;附加:容差边界(<=)、'.' 根 artifact 负向、
// handler 注入链路(mock executor: INVALID_PARAMS / layout_verify 注入 / 错误结果不注入)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flattenTargets, diffLayout, detectOverlaps, detectOutOfBounds } from '../src/tools/ui/layout-diff.js';
import type { MeasuredNode } from '../src/tools/ui/layout-diff.js';
import type { UiNodeSpec } from '../src/tools/ui/types.js';
import type { ExecuteGdscriptResult } from '../src/gdscript-executor.js';
import { flattenStyleTargets, styleExpectList, diffStyles, diffFlow, STYLE_COLOR_TOL, compactDiffEntries, compactStyleEntries } from '../src/tools/ui/layout-diff.js';
import type { StyleReading, DiffEntry, StyleDiffEntry } from '../src/tools/ui/layout-diff.js';

const n = (path: string, x: number, y: number, w: number, h: number): MeasuredNode =>
  ({ path, type: 'Control', rect: { x, y, w, h } });

describe('flattenTargets', () => {
  it('递归收集带 rect 节点,路径为名称链', () => {
    const t = flattenTargets({
      type: 'Panel', name: 'P',
      children: [
        { type: 'Button', name: 'A', rect: { x: 0, y: 0, w: 10, h: 10 } },
        { type: 'VBoxContainer', name: 'Col', layout: { direction: 'column' },
          children: [{ type: 'Button', name: 'B', rect: { x: 5, y: 5, w: 8, h: 8 } }] },
      ],
    });
    expect(t).toEqual([
      { path: 'P/A', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { path: 'P/Col/B', rect: { x: 5, y: 5, w: 8, h: 8 } },
    ]);
  });

  it('无 rect 的节点不产出条目', () => {
    expect(flattenTargets({ type: 'Label', name: 'L' })).toEqual([]);
  });

  it('同构对照:measure 整场景(path=get_path_to 名称链)与 build 树(挂场景根下)路径一致', () => {
    // ui_build_layout 建树 P{A, Col{B}} 挂 root 下 → ui_measure_layout(不带 node_path)
    // 输出 nodes path: 'P' / 'P/A' / 'P/Col/B'(_target=场景根,get_path_to 不含根名)。
    // expect_tree 传 build 的同一棵树 → flattenTargets 计根名后恰为 'P/A' / 'P/Col/B'。
    // C1 父相对语义:父 P 在非原点 (500,300),子 target 为相对父的 rect → diff 仍全绿。
    const tree: UiNodeSpec = {
      type: 'Panel', name: 'P',
      children: [
        { type: 'Button', name: 'A', rect: { x: 0, y: 0, w: 10, h: 10 } },
        { type: 'VBoxContainer', name: 'Col',
          children: [{ type: 'Button', name: 'B', rect: { x: 0, y: 0, w: 5, h: 5 } }] },
      ],
    };
    const measured: MeasuredNode[] = [
      n('P', 500, 300, 100, 100),
      n('P/A', 500, 300, 10, 10),
      n('P/Col', 500, 300, 50, 50),
      n('P/Col/B', 500, 300, 5, 5),
    ];
    const d = diffLayout(measured, flattenTargets(tree), 2);
    expect(d.map(e => e.path)).toEqual(['P/A', 'P/Col/B']);
    expect(d.every(e => e.ok)).toBe(true);
  });
});

describe('diffLayout(C1 父相对坐标语义)', () => {
  // target 语义 = 相对父左上角(与生成侧一致);actual = 子 global − 父 global,与 target 同构。
  it('同父两子各自相对位置正确(父在非原点也不误报)', () => {
    const targets = [
      { path: 'P/A', rect: { x: 50, y: 30, w: 120, h: 48 } },
      { path: 'P/B', rect: { x: 300, y: 0, w: 100, h: 48 } },
    ];
    const measured = [
      n('P', 100, 50, 600, 400),
      n('P/A', 150, 80, 120, 48),   // global 150,80 = 父 100,50 + 相对 50,30
      n('P/B', 400, 50, 100, 48),
    ];
    const d = diffLayout(measured, targets, 2);
    expect(d).toHaveLength(2);
    expect(d.every(e => e.ok)).toBe(true);
    expect(d[0]!.actual).toEqual({ x: 50, y: 30, w: 120, h: 48 });
    expect(d[1]!.actual).toEqual({ x: 300, y: 0, w: 100, h: 48 });
  });

  it('父相对换算后超容差 → ok:false,delta 为父相对差', () => {
    const targets = [{ path: 'P/A', rect: { x: 50, y: 30, w: 120, h: 48 } }];
    // 子 global y=90,父 y=50 → 父相对 y=40 vs target 30 → dy=10(旧语义误算 90-30=60)
    const d = diffLayout([n('P', 100, 50, 600, 400), n('P/A', 150, 90, 120, 48)], targets, 2);
    expect(d[0]!.ok).toBe(false);
    expect(d[0]!.delta.dy).toBe(10);
    expect(d[0]!.delta.dx).toBe(0);
  });

  it('根级 target(无父段)以视口原点为参照:measured global 直接比', () => {
    const targets = [{ path: 'P', rect: { x: 100, y: 50, w: 600, h: 400 } }];
    const ok = diffLayout([n('P', 100, 50, 600, 400)], targets, 2);
    expect(ok[0]!.ok).toBe(true);
    const off = diffLayout([n('P', 120, 50, 600, 400)], targets, 2);
    expect(off[0]!.ok).toBe(false);
    expect(off[0]!.delta.dx).toBe(20);
  });

  it('父不在测量集 → delta NaN 不 ok(缺失语义)', () => {
    const targets = [{ path: 'P/A', rect: { x: 50, y: 30, w: 120, h: 48 } }];
    const d = diffLayout([n('P/A', 150, 80, 120, 48)], targets, 2); // 父 'P' 未测
    expect(d[0]!.ok).toBe(false);
    expect(Number.isNaN(d[0]!.delta.dx)).toBe(true);
    expect(Number.isNaN(d[0]!.delta.dy)).toBe(true);
  });

  it('measure 缺失的目标节点 → delta 标记 NaN 不 ok', () => {
    const d = diffLayout([n('Z', 0, 0, 1, 1)], [{ path: 'A', rect: { x: 0, y: 24, w: 100, h: 48 } }], 2);
    expect(d).toHaveLength(1);
    expect(d[0]!.ok).toBe(false);
    expect(Number.isNaN(d[0]!.delta.dx)).toBe(true);
  });

  it('delta 恰等于容差 2 → ok:true(容差为 <= 语义)', () => {
    const targets = [{ path: 'P/A', rect: { x: 0, y: 24, w: 100, h: 48 } }];
    const d = diffLayout([n('P', 0, 0, 100, 100), n('P/A', 2, 26, 100, 50)], targets, 2);
    expect(d[0]!.ok).toBe(true);
  });

  it('默认容差为 2(不传 tolerancePx)', () => {
    const targets = [{ path: 'P/A', rect: { x: 0, y: 24, w: 100, h: 48 } }];
    const within = diffLayout([n('P', 0, 0, 100, 100), n('P/A', 0, 26, 100, 48)], targets);
    expect(within[0]!.ok).toBe(true);
    const beyond = diffLayout([n('P', 0, 0, 100, 100), n('P/A', 0, 27, 100, 48)], targets);
    expect(beyond[0]!.ok).toBe(false);
  });
});

describe('detectOverlaps(仅同父兄弟)', () => {
  it('兄弟相交 → 报告;不同父不相交不报(负向)', () => {
    const ms = [
      n('P/A', 0, 0, 50, 50), n('P/B', 25, 0, 50, 50),      // 同父相交
      n('Q/A', 0, 0, 50, 50), n('R/B', 25, 0, 50, 50),      // 不同父,不比较
    ];
    const ov = detectOverlaps(ms);
    expect(ov).toHaveLength(1);
    expect(ov[0]!.a).toBe('P/A');
    expect(ov[0]!.b).toBe('P/B');
  });

  it('重叠 ≤1px 不报(阈值 >1px,负向:不误报)', () => {
    const ov = detectOverlaps([n('P/A', 0, 0, 50, 50), n('P/B', 50, 0, 50, 50)]);
    expect(ov).toEqual([]);
  });

  it('measure 根节点 path "." 与一级子不比较(负向:get_path_to artifact 不误报)', () => {
    // 整场景 measure 时 _target.get_path_to(自身) = ".",场景根与一级子 'P' 落进同一
    // parent='' 组,父包子的正常包含不是兄弟重叠 → 必须不报。
    const ov = detectOverlaps([
      n('.', 0, 0, 200, 200),
      n('P', 10, 10, 100, 100),
      n('Q', 120, 10, 60, 60),
    ]);
    expect(ov).toEqual([]);
  });
});

describe('detectOutOfBounds', () => {
  it('子超出父 → 溢出量;子在父内 → 不报(负向)', () => {
    const ms = [
      n('P', 0, 0, 100, 100),
      n('P/In', 10, 10, 50, 50),          // 在内
      n('P/Out', 80, 80, 50, 50),         // 右下溢出 30,30
    ];
    const oob = detectOutOfBounds(ms);
    expect(oob).toHaveLength(1);
    expect(oob[0]!.path).toBe('P/Out');
    expect(oob[0]!.overflow.w).toBe(30);
    expect(oob[0]!.overflow.h).toBe(30);
  });

  it('溢出 ≤1px 不报(阈值 >1px,负向)且父缺失/根节点跳过', () => {
    expect(detectOutOfBounds([
      n('P', 0, 0, 100, 100),
      n('P/Edge', 0, 0, 101, 100),        // 右溢 1px,不报
    ])).toEqual([]);
    // 一级子 'P' 的父(场景根 '.')不在 measured 键中(键 '.' ≠ parentOf('P')='')→ 跳过
    expect(detectOutOfBounds([n('.', 0, 0, 50, 50), n('P', 0, 0, 100, 100)])).toEqual([]);
  });
});

// ─── handler 注入链路(mock executor)────────────────────────────────────

vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscriptTrusted: vi.fn(),
}));

import { executeGdscriptTrusted } from '../src/gdscript-executor.js';
import { handleTool } from '../src/tools/ui/index.js';

const mockedExec = vi.mocked(executeGdscriptTrusted);

function okResult(measurePayload: unknown): ExecuteGdscriptResult {
  return {
    success: true, compile_success: true, compile_error: '', errors: [],
    run_success: true, run_error: '',
    outputs: [{ key: 'measure', value: JSON.stringify(measurePayload) }],
    raw_output: '', duration_ms: 1,
  };
}

const ctx = { findGodot: async () => '/fake/godot', projectDir: '/fake/p' };

beforeEach(() => {
  mockedExec.mockReset();
});

describe('ui_measure_layout expect_tree(handler 集成)', () => {
  it('expect_tree 缺 name → INVALID_PARAMS,不触 executor', async () => {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: { type: 'Panel' },
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('INVALID_PARAMS');
    expect((r.content[0] as { text: string }).text).toContain('expect_tree');
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('提供 expect_tree → data.layout_verify 注入 diff/overlaps/out_of_bounds/viewport,measure 数据保留', async () => {
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 1280, h: 720 },
      nodes: [
        { path: '.', type: 'Control', rect: { x: 0, y: 0, w: 1280, h: 720 } },
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 200 } },
        { path: 'P/A', type: 'Button', rect: { x: 0, y: 40, w: 100, h: 48 } },
        { path: 'P/B', type: 'Button', rect: { x: 0, y: 0, w: 120, h: 48 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: {
        type: 'Panel', name: 'P',
        children: [
          { type: 'Button', name: 'A', rect: { x: 0, y: 24, w: 100, h: 48 } },
          { type: 'Button', name: 'B', rect: { x: 0, y: 0, w: 100, h: 48 } },
        ],
      },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      success: boolean;
      data: {
        measure?: { nodes?: unknown[] };
        layout_verify?: {
          targets: Array<{ path: string }>;
          diff: Array<{ path: string; ok: boolean; delta: { dy: number; dw: number } }>;
          overlaps: Array<{ a: string; b: string }>;
          out_of_bounds: Array<{ path: string }>;
          viewport?: { w: number; h: number };
        };
      };
    };
    expect(parsed.success).toBe(true);
    expect(parsed.data.measure?.nodes).toHaveLength(4);   // 原 measure 输出保留
    const lv = parsed.data.layout_verify!;
    expect(lv.targets.map(t => t.path)).toEqual(['P/A', 'P/B']);
    // C1 父相对语义:P/A actual = (0,40)−(0,0) → dy=16;P/B dw=20
    const a = lv.diff.find(e => e.path === 'P/A')!;
    expect(a.ok).toBe(false);                              // 父相对 y 40 vs 24,dy=16 超容差
    expect(a.delta.dy).toBe(16);
    const b = lv.diff.find(e => e.path === 'P/B')!;
    expect(b.ok).toBe(false);                              // w 120 vs 100,dw=20 超容差
    expect(b.delta.dw).toBe(20);
    expect(lv.viewport).toEqual({ w: 1280, h: 720 });      // 根级参照系透传
    expect(lv.overlaps).toEqual([{ a: 'P/A', b: 'P/B', overlap: { x: 0, y: 40, w: 100, h: 8 } }]); // A(y40-88)与 B(y0-48)同父重叠
    expect(lv.out_of_bounds).toEqual([]);                  // 均在 P 内
  });

  it('measure 输出异常(执行失败)→ 原样返回错误,不注入 layout_verify', async () => {
    mockedExec.mockResolvedValue({
      ...okResult(null),
      run_success: false, run_error: 'boom', outputs: [],
    });
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: { type: 'Panel', name: 'P' },
    }, ctx);
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('boom');
    expect(text).not.toContain('layout_verify');
  });

  it('不提供 expect_tree → 行为与 Task 3 一致,无 layout_verify 键', async () => {
    mockedExec.mockResolvedValue(okResult({ stable_after_frames: 2, nodes: [] }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { text: string }).text).not.toContain('layout_verify');
  });

  // ─── PR-2 Task 4: expect_tree 同构复用 style_verify(spec §4.1 挂两处之二) ──

  it('expect_tree 带 styleboxes → data.style_verify 注入 + measure 脚本内嵌期望清单(PR-2)', async () => {
    // styles 按 GD _walk 产出真实形状(flat:true 时四组字段全产出)
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 2,
      stalled: false,
      viewport: { w: 1280, h: 720 },
      nodes: [
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 200 },
          styles: [{ slot: 'panel', flat: true, bg_color: [0.1, 0.12, 0.18, 1],
            corner_radius: { tl: 0, tr: 0, br: 0, bl: 0 },
            border_width: { left: 0, top: 0, right: 0, bottom: 0 },
            border_color: [0, 0, 0, 1] }] },
        { path: 'P/A', type: 'Button', rect: { x: 0, y: 40, w: 100, h: 48 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: {
        type: 'Panel', name: 'P',
        styleboxes: [{ slot: 'panel', box: { bg_color: [0.1, 0.12, 0.18, 1] } }],
        children: [
          { type: 'Button', name: 'A', rect: { x: 0, y: 24, w: 100, h: 48 } },
        ],
      },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      data: {
        style_verify?: Array<{ path: string; slot: string; field: string; ok: boolean }>;
        layout_verify?: unknown;
      };
    };
    // style_verify 注入(与 layout_verify 并列;只比 box 显式字段 → 仅 bg_color 1 条全绿)
    const sv = parsed.data.style_verify!;
    expect(sv).toHaveLength(1);
    expect(sv[0]).toMatchObject({ path: 'P', slot: 'panel', field: 'bg_color', ok: true });
    expect(parsed.data.layout_verify).toBeTruthy();
    // measure 脚本第 4 参期望清单内嵌:code 含 JSON.parse_string 与 path→slots 清单
    // (escapeForGdLiteral 会把 JSON 的 " 转义为 \",断言按转义后字面序列)
    const call = mockedExec.mock.calls[0]![0] as { code: string };
    expect(call.code).toContain('JSON.parse_string');
    expect(call.code).toContain('\\"P\\":[\\"panel\\"]');
  });

  it('expect_tree 无 styleboxes → style_verify=[] 且 measure 脚本不注入期望清单(PR-2)', async () => {
    mockedExec.mockResolvedValue(okResult({ stable_after_frames: 2, nodes: [] }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: { type: 'Panel', name: 'P', rect: { x: 0, y: 0, w: 100, h: 100 } },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as { data?: { style_verify?: unknown } };
    expect(parsed.data?.style_verify).toEqual([]);
    const call = mockedExec.mock.calls[0]![0] as { code: string };
    expect(call.code).not.toContain('JSON.parse_string');
  });

  // ─── 批4 Task2: verify 分档 detail=compact|extended ─────────────────────

  it('detail=compact + expect_tree → diff/style_verify 对象化 {entries,summary} + data.detail;本 fixture 无品质发现 quality/order 不挂', async () => {
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 1280, h: 720 },
      nodes: [
        { path: '.', type: 'Control', rect: { x: 0, y: 0, w: 1280, h: 720 } },
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 200 } },
        { path: 'P/A', type: 'Button', rect: { x: 0, y: 40, w: 100, h: 48 } },
        { path: 'P/B', type: 'Button', rect: { x: 0, y: 0, w: 120, h: 48 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      detail: 'compact',
      expect_tree: {
        type: 'Panel', name: 'P',
        children: [
          { type: 'Button', name: 'A', rect: { x: 0, y: 24, w: 100, h: 48 } },
          { type: 'Button', name: 'B', rect: { x: 0, y: 0, w: 100, h: 48 } },
        ],
      },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      data: {
        detail?: string;
        layout_verify?: { diff?: unknown };
        style_verify?: unknown;
        quality?: unknown;
        order?: unknown;
      };
    };
    expect(parsed.data.detail).toBe('compact');
    // diff 对象化:A(dy=16) B(dw=20) 双红,severity 20 > 16 → B 先
    expect(Array.isArray(parsed.data.layout_verify!.diff)).toBe(false);
    const d = parsed.data.layout_verify!.diff as {
      entries: Array<{ path: string }>;
      summary: { total: number; ok: number; non_ok: number; truncated: number };
    };
    expect(d.entries.map(e => e.path)).toEqual(['P/B', 'P/A']);
    expect(d.summary).toEqual({ total: 2, ok: 0, non_ok: 2, truncated: 0 });
    // style_verify 空清单 → 对象化全零 summary
    expect(parsed.data.style_verify).toEqual({ entries: [], summary: { total: 0, ok: 0, non_ok: 0, truncated: 0 } });
    // 本 fixture 无品质发现(D8):quality/order 不挂
    expect(parsed.data.quality).toBeUndefined();
    expect(parsed.data.order).toBeUndefined();
  });

  it('detail=compact 不带 expect_tree → compact 只作用段3:列表字段 {entries,summary{total,truncated}},spacing_scale 标量在外层/off_scale 对象化', async () => {
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 800, h: 600 },
      theme_constants: { space_1: 8 },
      nodes: [
        { path: '.', type: 'Control', rect: { x: 0, y: 0, w: 800, h: 600 } },
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 60 } },
        { path: 'P/A', type: 'TextureRect', rect: { x: 0, y: 0, w: 20, h: 10 } },
        { path: 'P/B', type: 'TextureRect', rect: { x: 28, y: 0, w: 20, h: 10 } },
        { path: 'P/C', type: 'TextureRect', rect: { x: 76, y: 0, w: 20, h: 10 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      detail: 'compact',
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      data: {
        detail?: string;
        layout_verify?: unknown;
        order?: {
          equidistant: { entries: unknown[]; summary: { total: number; truncated: number } };
          alignment_lanes: { entries: unknown[]; summary: { total: number; truncated: number } };
          spacing_scale: {
            on_scale: number; total: number; rate: number;
            off_scale: { entries: Array<{ a: string; b: string; gap: number; nearest: number }>; summary: { total: number; truncated: number } };
          };
          visual_groups: { entries: unknown[]; summary: { total: number; truncated: number } };
        };
      };
    };
    expect(parsed.data.detail).toBe('compact');
    expect(parsed.data.layout_verify).toBeUndefined(); // 段1 不产(无 expect_tree),compact 不造
    const order = parsed.data.order!;
    expect(order.equidistant).toEqual({ entries: [], summary: { total: 0, truncated: 0 } });
    expect(order.alignment_lanes).toEqual({ entries: [], summary: { total: 0, truncated: 0 } });
    // spacing_scale 标量保留外层;off_scale 对象化(x 轴 gap 8/28:28 距最近档 8 超容差)
    expect(order.spacing_scale.on_scale).toBe(1);
    expect(order.spacing_scale.total).toBe(2);
    expect(order.spacing_scale.rate).toBe(0.5);
    expect(order.spacing_scale.off_scale).toEqual({
      entries: [{ a: 'P/B', b: 'P/C', gap: 28, nearest: 8 }],
      summary: { total: 1, truncated: 0 },
    });
    expect(order.visual_groups).toEqual({ entries: [], summary: { total: 0, truncated: 0 } });
  });

  it('不传 detail → diff 仍裸数组 + 无 detail 字段(extended 缺省,逐字节锚)', async () => {
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 3, stalled: false, viewport: { w: 1280, h: 720 },
      nodes: [
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 200 } },
        { path: 'P/B', type: 'Button', rect: { x: 0, y: 0, w: 120, h: 48 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      expect_tree: { type: 'Panel', name: 'P', rect: { x: 0, y: 0, w: 200, h: 200 },
        children: [{ type: 'Button', name: 'B', rect: { x: 0, y: 0, w: 100, h: 48 } }] },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      data: { detail?: string; layout_verify?: { diff: unknown } };
    };
    expect(Array.isArray(parsed.data.layout_verify!.diff)).toBe(true);
    expect(parsed.data.layout_verify!.diff).toHaveLength(2);
    expect(parsed.data.detail).toBeUndefined();
  });

  it('detail=extended 显式 → 与不传一致(裸数组 + 无 detail 字段)', async () => {
    mockedExec.mockResolvedValue(okResult({
      stable_after_frames: 3, stalled: false, viewport: { w: 1280, h: 720 },
      nodes: [
        { path: 'P', type: 'Panel', rect: { x: 0, y: 0, w: 200, h: 200 } },
        { path: 'P/B', type: 'Button', rect: { x: 0, y: 0, w: 120, h: 48 } },
      ],
    }));
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: '/fake/p',
      scene_path: 'res://scenes/main.tscn',
      detail: 'extended',
      expect_tree: { type: 'Panel', name: 'P', rect: { x: 0, y: 0, w: 200, h: 200 },
        children: [{ type: 'Button', name: 'B', rect: { x: 0, y: 0, w: 100, h: 48 } }] },
    }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text) as {
      data: { detail?: string; layout_verify?: { diff: unknown } };
    };
    expect(Array.isArray(parsed.data.layout_verify!.diff)).toBe(true);
    expect(parsed.data.detail).toBeUndefined();
  });
});

// ─── PR-2 Task 1: style_verify / flow_verify 纯函数 ────────────────────────

describe('flattenStyleTargets / styleExpectList(PR-2)', () => {
  const tree: UiNodeSpec = {
    type: 'Panel', name: 'Root', rect: { x: 0, y: 0, w: 100, h: 100 },
    styleboxes: [{ slot: 'panel', box: { bg_color: [0.1, 0.12, 0.18, 1] } }],
    children: [
      { type: 'ProgressBar', name: 'Hp', rect: { x: 8, y: 8, w: 80, h: 10 },
        styleboxes: [
          { slot: 'background', box: { bg_color: [0, 0, 0, 1] } },
          { slot: 'fill', box: { bg_color: [0.2, 0.8, 0.4, 1] } },
        ] },
    ],
  };
  it('flattenStyleTargets:逐节点逐槽位,path 链与 flattenTargets 同构(根级无前缀)', () => {
    const out = flattenStyleTargets(tree);
    expect(out.map(t => `${t.path}:${t.slot}`)).toEqual([
      'Root:panel', 'Root/Hp:background', 'Root/Hp:fill',
    ]);
  });
  it('styleExpectList:同 path 多槽聚合(顺序保持)', () => {
    const list = styleExpectList(flattenStyleTargets(tree));
    expect(list).toEqual([
      { path: 'Root', slots: ['panel'] },
      { path: 'Root/Hp', slots: ['background', 'fill'] },
    ]);
  });
  it('无 styleboxes 的树 → 两个函数均空数组', () => {
    const plain: UiNodeSpec = { type: 'Panel', name: 'P' };
    expect(flattenStyleTargets(plain)).toEqual([]);
    expect(styleExpectList([])).toEqual([]);
  });
});

describe('diffStyles(PR-2)', () => {
  const target = { path: 'Card', slot: 'panel', box: {
    bg_color: [0.1, 0.12, 0.18, 1], corner_radius: 8, border_width: 2, border_color: [0.24, 0.86, 0.52, 1],
  } };
  const flatReading: StyleReading = {
    path: 'Card', slot: 'panel', flat: true,
    bg_color: [0.1, 0.12, 0.18, 1],
    corner_radius: { tl: 8, tr: 8, br: 8, bl: 8 },
    border_width: { left: 2, top: 2, right: 2, bottom: 2 },
    border_color: [0.24, 0.86, 0.52, 1],
  };
  it('全字段命中 → 全绿,10 条(bg1+corner4+border_width4+border_color1)', () => {
    const out = diffStyles([flatReading], [target]);
    expect(out).toHaveLength(10);
    expect(out.every(e => e.ok)).toBe(true);
    const bg = out.find(e => e.field === 'bg_color')!;
    expect(bg.target).toEqual([0.1, 0.12, 0.18, 1]);
    expect(bg.delta).toEqual([0, 0, 0, 0]);
    const c = out.find(e => e.field === 'corner_radius_top_left')!;
    expect(c.target).toBe(8);
    expect(c.actual).toBe(8);
  });
  it('颜色 float32 漂移在容差内绿(0.2 → 0.2000000029 级),超容差红', () => {
    // 注:brief 原用 0.1 + STYLE_COLOR_TOL 构造"恰好容差边界",但 double 表示误差使
    // (0.1+0.002)-0.1 = 0.0020000000000000018 > tol → 误红;改用 tol/2 表示"容差内漂移"。
    // 红例 delta 断言用同一浮点表达式回算,不做 0.02 精确字面量假设。
    const r: StyleReading = { ...flatReading, bg_color: [0.1 + STYLE_COLOR_TOL / 2, 0.12, 0.18, 1] };
    const out = diffStyles([r], [target]);
    expect(out.find(e => e.field === 'bg_color')!.ok).toBe(true);
    const r2: StyleReading = { ...flatReading, bg_color: [0.1 + STYLE_COLOR_TOL * 10, 0.12, 0.18, 1] };
    const out2 = diffStyles([r2], [target]);
    const bg2 = out2.find(e => e.field === 'bg_color')!;
    expect(bg2.ok).toBe(false);
    const drift = (0.1 + STYLE_COLOR_TOL * 10) - 0.1;
    expect(bg2.delta).toEqual([drift, 0, 0, 0]);
  });
  it('非 StyleBoxFlat(Label 未 override → StyleBoxEmpty)→ 单条 type 红条目,不进字段 diff', () => {
    const r: StyleReading = { path: 'Card', slot: 'normal', flat: false, type: 'StyleBoxEmpty' };
    const out = diffStyles([r], [{ path: 'Card', slot: 'normal', box: { bg_color: [1, 1, 1, 1] } }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.field).toBe('type');
    expect(out[0]!.target).toBe('StyleBoxFlat');
    expect(out[0]!.actual).toBe('StyleBoxEmpty');
    expect(out[0]!.ok).toBe(false);
  });
  it('override 没设上(get 回默认主题数值)→ 字段 diff 红(§4.1 核心防线)', () => {
    // Panel 默认主题 panel 槽是 StyleBoxFlat 灰底 + 无圆角无边框
    const defaultTheme: StyleReading = {
      path: 'Card', slot: 'panel', flat: true,
      bg_color: [0.1, 0.1, 0.1, 1],
      corner_radius: { tl: 0, tr: 0, br: 0, bl: 0 },
      border_width: { left: 0, top: 0, right: 0, bottom: 0 },
      border_color: [0.8, 0.8, 0.8, 1],
    };
    const out = diffStyles([defaultTheme], [target]);
    expect(out.find(e => e.field === 'bg_color')!.ok).toBe(false);
    expect(out.find(e => e.field === 'corner_radius_top_left')!.ok).toBe(false);
    expect(out.find(e => e.field === 'border_width_left')!.ok).toBe(false);
  });
  it('reading 缺失(节点不在测量集)→ (reading missing) 红条目', () => {
    const out = diffStyles([], [target]);
    expect(out).toHaveLength(1);
    expect(out[0]!.field).toBe('(reading missing)');
    expect(out[0]!.ok).toBe(false);
  });
  it('期望字段缺省不比对(box 只有 bg_color 时仅 1 条;draw_center 永不比)', () => {
    const t = { path: 'X', slot: 'panel', box: { bg_color: [0, 0, 0, 1], draw_center: false } };
    const out = diffStyles([{ path: 'X', slot: 'panel', flat: true, bg_color: [0, 0, 0, 1] }], [t]);
    expect(out).toHaveLength(1);
    expect(out.every(e => e.ok)).toBe(true);
  });
  it('corner_radius 对象形态:{tl:8} 展开 tl=8 其余 0(与生成器同缺省)', () => {
    const t = { path: 'Y', slot: 'panel', box: { corner_radius: { tl: 8 } } };
    const r: StyleReading = { path: 'Y', slot: 'panel', flat: true,
      corner_radius: { tl: 8, tr: 0, br: 0, bl: 0 } };
    const out = diffStyles([r], [t]);
    expect(out).toHaveLength(4);
    expect(out.every(e => e.ok)).toBe(true);
    expect(out.find(e => e.field === 'corner_radius_bottom_right')!.target).toBe(0);
  });
});

describe('diffFlow(PR-2)', () => {
  const measured = [
    { path: 'R/H/H_Flow/A', type: 'Button', rect: { x: 100, y: 100, w: 72, h: 40 } },
    { path: 'R/H/H_Flow/B', type: 'Button', rect: { x: 268, y: 100, w: 72, h: 40 } },
  ];
  const expect1 = [
    { path: 'R/H/H_Flow/A', rect: { x: 100, y: 104, w: 72, h: 32 } },
    { path: 'R/H/H_Flow/B', rect: { x: 268, y: 104, w: 72, h: 32 } },
  ];
  it('期望为视口绝对、actual 直接对比(不换父相对);x 命中 y/h 超容差 → 对应维度红', () => {
    const out = diffFlow(measured, expect1, 2);
    expect(out).toHaveLength(2);
    const a = out[0]!;
    expect(a.delta.dx).toBe(0);
    expect(a.delta.dy).toBe(-4);
    expect(a.delta.dh).toBe(8);
    expect(a.ok).toBe(false);
  });
  it('容差内全绿', () => {
    const out = diffFlow(measured, expect1, 10);
    expect(out.every(e => e.ok)).toBe(true);
  });
  it('节点缺失 → actual:null + NaN delta,ok:false', () => {
    const out = diffFlow(measured, [{ path: 'R/H/H_Flow/GONE', rect: { x: 0, y: 0, w: 1, h: 1 } }]);
    expect(out[0]!.actual).toBeNull();
    expect(out[0]!.delta.dy).toBeNaN();
    expect(out[0]!.ok).toBe(false);
  });
});

// ─── 批4 Task2: verify 分档 compact 纯函数 ────────────────────────────────

describe('compactDiffEntries(批4 Task2)', () => {
  const de = (path: string, dx: number, dy: number, dw = 0, dh = 0, ok?: boolean): DiffEntry => ({
    path, target: null, actual: null, delta: { dx, dy, dw, dh },
    ok: ok ?? Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh)) <= 2,
  });
  const deNaN = (path: string): DiffEntry => ({
    path, target: null, actual: null, delta: { dx: NaN, dy: NaN, dw: NaN, dh: NaN }, ok: false,
  });

  it('过滤 !ok + 偏差量降序 + summary 计数;NaN 条目排最前计入 non_ok', () => {
    const out = compactDiffEntries([de('a', 0, 0), de('b', 3, 0), de('c', 10, 0), deNaN('d')]);
    expect(out.entries.map(e => e.path)).toEqual(['d', 'c', 'b']); // NaN 最前,10 > 3
    expect(out.summary).toEqual({ total: 4, ok: 1, non_ok: 3, truncated: 0 });
  });

  it('25 条递增偏差 → 截 top 20(25..6 降序),truncated=5', () => {
    const list = Array.from({ length: 25 }, (_, i) => de(`p${String(i + 1).padStart(2, '0')}`, i + 1, 0, 0, 0, false));
    const out = compactDiffEntries(list);
    expect(out.entries).toHaveLength(20);
    expect(out.entries.map(e => e.delta.dx)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(out.summary).toEqual({ total: 25, ok: 0, non_ok: 25, truncated: 5 });
  });

  it('恰好 20 条不 ok → 不截断(truncated=0)', () => {
    const list = Array.from({ length: 20 }, (_, i) => de(`p${i}`, i + 1, 0, 0, 0, false));
    const out = compactDiffEntries(list);
    expect(out.entries).toHaveLength(20);
    expect(out.summary.truncated).toBe(0);
  });

  it('偏差量并列 → 稳定按 path 升序', () => {
    const out = compactDiffEntries([de('z', 5, 0), de('a', 5, 0)]);
    expect(out.entries.map(e => e.path)).toEqual(['a', 'z']);
  });

  it('偏差量键 = max(|dx|,|dy|,|dw|,|dh|)(dy=12 > dx=3 排前)', () => {
    const out = compactDiffEntries([de('a', 3, 0), de('b', 0, 12)]);
    expect(out.entries.map(e => e.path)).toEqual(['b', 'a']);
  });
});

describe('compactStyleEntries(批4 Task2)', () => {
  const se = (path: string, delta: number | number[] | null, ok = false): StyleDiffEntry => ({
    path, slot: 'panel', field: 'bg_color', target: null, actual: null, delta, ok,
  });

  it('delta 三形态排序:null 最大最前、数组取 max |分量|、数值取 |·|;过滤 ok + summary 计数', () => {
    const out = compactStyleEntries([
      se('ok1', 0.001, true),
      se('a', 0.5),
      se('b', [0.1, 3, 0.2]), // 数组 max 分量 3
      se('c', null),          // null 最大
      se('d', 2),
    ]);
    expect(out.entries.map(e => e.path)).toEqual(['c', 'b', 'd', 'a']);
    expect(out.summary).toEqual({ total: 5, ok: 1, non_ok: 4, truncated: 0 });
  });

  it('25 条不 ok → 截 top 20,truncated=5', () => {
    const list = Array.from({ length: 25 }, (_, i) => se(`p${String(i + 1).padStart(2, '0')}`, (25 - i) * 0.1));
    const out = compactStyleEntries(list);
    expect(out.entries).toHaveLength(20);
    expect(out.entries[0]!.delta).toBe(2.5);
    expect(out.summary).toEqual({ total: 25, ok: 0, non_ok: 25, truncated: 5 });
  });
});
