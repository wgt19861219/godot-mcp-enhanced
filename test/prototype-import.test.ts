// Task 1 (prototype-import): 翻译器纯函数测试。
// 覆盖 brief Step 1 四组:parseGeometry schema / buildTree 建树 / 12 规则正负例 / coverage;
// fast-check 规则 2 闭环:随机合法两层嵌套 geometry → 翻译 → abs(parent)+rel 与输入视口坐标一致 ≤1px。
// 深度口径:最终输出树(合成根 _PrototypeRoot = depth 1)cap 10,对齐 genUiBuildLayoutScript 的
// validateUiNodeSpec(tree, 1) 语义——输入链 10 层 → 最终树 11 层 → throw;9 层 → 最终 10 层 → 合法。

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseGeometry, translateGeometry } from '../src/tools/ui/prototype-import.js';
import type { GeometryNode, PrototypeGeometry } from '../src/tools/ui/prototype-import.js';
import { flattenTargets } from '../src/tools/ui/layout-diff.js';
import type { UiNodeSpec } from '../src/tools/ui/types.js';

const VP = { w: 1280, h: 720 };
const ROOT_NAME = '_PrototypeRoot';

// ─── helpers ───────────────────────────────────────────────────────────────

/** 最小合法节点。 */
const n = (name: string, x: number, y: number, w: number, h: number, extra: Partial<GeometryNode> = {}): GeometryNode =>
  ({ name, rect: { x, y, w, h }, ...extra });

const geo = (nodes: GeometryNode[], viewport = VP): PrototypeGeometry => ({ viewport, nodes });

/** 递归按 name 找节点(含合成根与 _Flow)。 */
function findNode(node: UiNodeSpec, name: string): UiNodeSpec | undefined {
  if (node.name === name) return node;
  for (const c of node.children ?? []) {
    const r = findNode(c, name);
    if (r) return r;
  }
  return undefined;
}

/** 翻译便捷入口。 */
const tr = (g: PrototypeGeometry) => translateGeometry(parseGeometry(g));

// ─── 组 1: parseGeometry(zod schema) ──────────────────────────────────────

describe('parseGeometry', () => {
  it('合法 JSON 通过(含全部可选字段)', () => {
    const g = parseGeometry(geo([
      n('TopBar', 0, 0, 1280, 56, {
        type: 'Panel', text: '标题', fontSize: 16, color: '#e8ecf5',
        bg: '#10141f', align: 'center', flow: 'row', justify: 'space-between', interactive: false,
      }),
    ]));
    expect(g.viewport).toEqual(VP);
    expect(g.nodes[0]!.text).toBe('标题');
    expect(g.nodes[0]!.flow).toBe('row');
  });

  it('缺 viewport → INVALID_PARAMS', () => {
    expect(() => parseGeometry({ nodes: [] } as unknown as PrototypeGeometry)).toThrow(/INVALID_PARAMS/);
  });

  it('缺 nodes → INVALID_PARAMS', () => {
    expect(() => parseGeometry({ viewport: VP } as unknown as PrototypeGeometry)).toThrow(/INVALID_PARAMS/);
  });

  it('缺 rect → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([{ name: 'A' } as unknown as GeometryNode]))).toThrow(/INVALID_PARAMS/);
  });

  it('非数字坐标 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', '10' as unknown as number, 0, 5, 5)]))).toThrow(/INVALID_PARAMS/);
  });

  it('NaN/Infinity 坐标 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', NaN, 0, 5, 5)]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, Infinity, 5)]))).toThrow(/INVALID_PARAMS/);
  });

  it('rect w/h ≤ 0 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 0, 5)]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 5, -1)]))).toThrow(/INVALID_PARAMS/);
  });

  it('name 缺失/空 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('', 0, 0, 5, 5)]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([{ rect: { x: 0, y: 0, w: 5, h: 5 } } as unknown as GeometryNode]))).toThrow(/INVALID_PARAMS/);
  });

  it('节点 > 500 → INVALID_PARAMS', () => {
    const nodes = Array.from({ length: 501 }, (_, i) => n(`N${i}`, i * 2, 0, 1, 1));
    expect(() => parseGeometry(geo(nodes))).toThrow(/INVALID_PARAMS/);
  });

  it('未知字段(strict)→ INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 5, 5, { 'font-size': 12 } as unknown as Partial<GeometryNode>)])))
      .toThrow(/INVALID_PARAMS/);
  });

  it('fontSize 非法(0/负/非数)→ INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { fontSize: 0 })]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { fontSize: -3 })]))).toThrow(/INVALID_PARAMS/);
  });

  it('color/bg 值域外([300,0,0] / [2,0,0,1])→ INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { color: [300, 0, 0] })]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { bg: [2, 0, 0, 1] })]))).toThrow(/INVALID_PARAMS/);
  });

  it('align/flow/justify 枚举外 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { align: 'justify' as never })]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'diagonal' as never })]))).toThrow(/INVALID_PARAMS/);
  });
});

// ─── 组 2: buildTree(经 translateGeometry) ────────────────────────────────

describe('buildTree', () => {
  it('嵌套 rects 正确建树(父=最小包含者)', () => {
    const { tree } = tr(geo([
      n('Root', 0, 0, 1000, 800),
      n('Top', 0, 0, 1000, 60),
      n('Btn', 10, 10, 80, 40),
      n('Side', 0, 60, 200, 740),
    ]));
    const root = findNode(tree, 'Root');
    expect(root).toBeDefined();
    expect(root!.children?.map(c => c.name)).toContain('Top');
    expect(root!.children?.map(c => c.name)).toContain('Side');
    // Btn 挂最小包含者 Top(面积 60000)而非 Root(面积 800000)
    expect(findNode(tree, 'Top')!.children!.some(c => c.name === 'Btn')).toBe(true);
    expect(root!.children!.some(c => c.name === 'Btn')).toBe(false);
  });

  it('顶层节点挂合成根 _PrototypeRoot 下', () => {
    const { tree } = tr(geo([n('A', 0, 0, 100, 100), n('B', 200, 0, 100, 100)]));
    expect(tree.name).toBe(ROOT_NAME);
    expect(tree.children?.map(c => c.name).sort()).toEqual(['A', 'B']);
  });

  it('两 rect 交叉重叠(互不包含)→ throw INVALID_PARAMS', () => {
    expect(() => tr(geo([n('A', 0, 0, 100, 100), n('B', 50, 50, 100, 100)]))).toThrow(/INVALID_PARAMS/);
  });

  it('完全相等 rect → throw INVALID_PARAMS', () => {
    expect(() => tr(geo([n('A', 0, 0, 100, 100), n('B', 0, 0, 100, 100)]))).toThrow(/INVALID_PARAMS/);
  });

  it('容差:严格包含(边距>1px)合法;近似相等(各边差 ≤1px 互含)→ throw', () => {
    expect(() => tr(geo([n('A', 0, 0, 100, 100), n('B', 1, 1, 50, 50)]))).not.toThrow();
    expect(() => tr(geo([n('A', 0, 0, 100, 100), n('B', 0, 0, 100.5, 100)]))).toThrow(/INVALID_PARAMS/);
  });

  it('兄弟相接(共享边)合法', () => {
    expect(() => tr(geo([n('A', 0, 0, 50, 50), n('B', 50, 0, 50, 50)]))).not.toThrow();
  });

  it('容差 1px 内的微小重叠视为相离(合法)', () => {
    expect(() => tr(geo([n('A', 0, 0, 50, 50), n('B', 49.5, 0, 50, 50)]))).not.toThrow();
  });

  it('重叠超过 1px 且互不包含 → throw', () => {
    expect(() => tr(geo([n('A', 0, 0, 50, 50), n('B', 47, 0, 50, 50)]))).toThrow(/INVALID_PARAMS/);
  });

  it('节点 > 500(绕过 parse 的防御检查)→ INVALID_PARAMS', () => {
    const nodes = Array.from({ length: 501 }, (_, i) => n(`N${i}`, i * 2, 0, 1, 1));
    expect(() => translateGeometry(geo(nodes))).toThrow(/INVALID_PARAMS/);
  });
});

// ─── 组 3: 12 规则正负例 ──────────────────────────────────────────────────

describe('规则 1: 类型推断', () => {
  it('显式 type 优先(白名单内)', () => {
    const { tree, warnings } = tr(geo([n('A', 0, 0, 100, 40, { type: 'LineEdit' })]));
    expect(findNode(tree, 'A')!.type).toBe('LineEdit');
    expect(warnings.some(w => w.includes('降级'))).toBe(false);
  });

  it("flow:'row' → Panel 壳 + HBoxContainer(_Flow)", () => {
    const { tree } = tr(geo([
      n('Bar', 0, 0, 400, 40, { flow: 'row' }),
      n('L', 0, 0, 100, 40), n('R', 300, 0, 100, 40),
    ]));
    const bar = findNode(tree, 'Bar')!;
    expect(bar.type).toBe('Panel');
    const flow = bar.children?.find(c => c.name === 'Bar_Flow');
    expect(flow).toBeDefined();
    expect(flow!.type).toBe('HBoxContainer');
  });

  it("flow:'column' → VBoxContainer", () => {
    const { tree } = tr(geo([
      n('Col', 0, 0, 100, 400, { flow: 'column' }),
      n('A', 0, 0, 100, 190), n('B', 0, 210, 100, 190),
    ]));
    expect(findNode(tree, 'Col_Flow')!.type).toBe('VBoxContainer');
  });

  it('value → ProgressBar', () => {
    const { tree } = tr(geo([n('Hp', 0, 0, 200, 20, { value: 0.72 })]));
    const hp = findNode(tree, 'Hp')!;
    expect(hp.type).toBe('ProgressBar');
    expect(hp.properties!.value).toBe(0.72);
  });

  it('interactive + text → Button', () => {
    const { tree } = tr(geo([n('OK', 0, 0, 80, 40, { text: '确定', interactive: true })]));
    expect(findNode(tree, 'OK')!.type).toBe('Button');
  });

  it('text(无 interactive)→ Label(负例:不是 Button)', () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: '标题' })]));
    expect(findNode(tree, 'T')!.type).toBe('Label');
  });

  it('无任何线索 → Panel', () => {
    const { tree } = tr(geo([n('A', 0, 0, 50, 50)]));
    expect(findNode(tree, 'A')!.type).toBe('Panel');
  });

  it('推断优先级:显式 type > flow > value > interactive+text > text', () => {
    // 显式 type 覆盖推断
    const { tree } = tr(geo([n('A', 0, 0, 50, 50, { type: 'Panel', value: 0.5 })]));
    expect(findNode(tree, 'A')!.type).toBe('Panel');
    // value 优先于 text(无 interactive)
    const r2 = tr(geo([n('B', 0, 0, 50, 50, { value: 0.5, text: 'x' })]));
    expect(findNode(r2.tree, 'B')!.type).toBe('ProgressBar');
  });
});

describe('规则 2: 视口坐标 → 相对父', () => {
  it('逐层减父原点', () => {
    const { tree } = tr(geo([
      n('Root', 100, 50, 800, 600),
      n('Child', 150, 100, 200, 80),
    ]));
    expect(findNode(tree, 'Root')!.rect).toEqual({ x: 100, y: 50, w: 800, h: 600 });
    expect(findNode(tree, 'Child')!.rect).toEqual({ x: 50, y: 50, w: 200, h: 80 });
  });

  it('属性:随机合法两层嵌套 → abs(parent)+rel 与输入视口坐标一致 ≤1px', () => {
    // 生成器:根 rect 在视口内;k(≥2) 个子列为宽 ≥3 的随机列(相邻割点整数,总宽 ≤ w0,
    // y 全高贴边)。列宽 ≥3 避开 contains 公式的 1px 容差模糊带(1px 相邻列会被判定互含,
    // 属输入格式约束;模糊带行为由上方"容差"固定用例专测)——本属性测的是规则 2 相对化正确性。
    const genArb = fc.integer({ min: 200, max: 2000 }).chain(vw =>
      fc.integer({ min: 200, max: 2000 }).chain(vh =>
        fc.integer({ min: 0, max: vw - 100 }).chain(x0 =>
          fc.integer({ min: 0, max: vh - 100 }).chain(y0 =>
            fc.integer({ min: 100, max: vw - x0 }).chain(w0 =>
              fc.integer({ min: 100, max: vh - y0 }).chain(h0 =>
                fc.integer({ min: 2, max: 5 }).chain(k =>
                  fc.array(fc.integer({ min: 3, max: 50 }), { minLength: k, maxLength: k })
                    .filter(ws => ws.reduce((a, b) => a + b, 0) <= w0)
                    .map(colWs => {
                      let off = 0;
                      const nodes: GeometryNode[] = [n('R', x0, y0, w0, h0)];
                      for (let i = 0; i < colWs.length; i++) {
                        nodes.push(n(`C${i}`, x0 + off, y0, colWs[i]!, h0));
                        off += colWs[i]!;
                      }
                      return { vw, vh, nodes };
                    }))))))));
    fc.assert(fc.property(genArb, g => {
      const { tree } = translateGeometry({ viewport: { w: g.vw, h: g.vh }, nodes: g.nodes });
      const input = new Map(g.nodes.map(nd => [nd.name, nd.rect]));
      const walk = (node: UiNodeSpec, ax: number, ay: number): void => {
        let nx = ax, ny = ay;
        if (node.rect) {
          nx = ax + node.rect.x; ny = ay + node.rect.y;
          const want = input.get(node.name);
          if (want) {
            expect(Math.abs(nx - want.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(ny - want.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(node.rect.w - want.w)).toBeLessThanOrEqual(1);
            expect(Math.abs(node.rect.h - want.h)).toBeLessThanOrEqual(1);
          }
        }
        for (const c of node.children ?? []) walk(c, nx, ny);
      };
      walk(tree, 0, 0);
      // 每个输入节点都出现在树里
      for (const nm of input.keys()) expect(findNode(tree, nm)).toBeDefined();
    }), { numRuns: 300 });
  });
});

describe('规则 3: Label 垂直居中', () => {
  it('推断 Label → vertical_alignment === 1', () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: 'x' })]));
    expect(findNode(tree, 'T')!.properties!.vertical_alignment).toBe(1);
  });

  it('显式 Label 同样 === 1;Button 不设(负例)', () => {
    const { tree } = tr(geo([
      n('L1', 0, 0, 80, 40, { type: 'Label', text: 'x' }),
      n('B1', 0, 50, 80, 40, { text: 'x', interactive: true }),
    ]));
    expect(findNode(tree, 'L1')!.properties!.vertical_alignment).toBe(1);
    expect(findNode(tree, 'B1')!.properties!.vertical_alignment).toBeUndefined();
  });
});

describe('规则 4: 透明壳(self_modulate,禁 modulate 级联)', () => {
  it('无 text/bg/flow → self_modulate [1,1,1,0] 且无 modulate + 透明壳提示 warning', () => {
    const { tree, warnings } = tr(geo([n('Shell', 0, 0, 100, 50)]));
    const p = findNode(tree, 'Shell')!.properties!;
    expect(p.self_modulate).toEqual([1, 1, 1, 0]);
    expect(p.modulate).toBeUndefined();
    // I-1:被设透明壳的推断 Panel 节点追加一次性使用提示
    expect(warnings.some(w => w.includes('Shell') && w.includes('layout-only Panel') && w.includes('set bg or type to keep it visible'))).toBe(true);
  });

  it('有 bg → styleboxes panel 槽 bg_color(不再 modulate)', () => {
    const { tree, warnings } = tr(geo([n('Bg', 0, 0, 100, 50, { bg: '#10141f' })]));
    const p = findNode(tree, 'Bg')!;
    expect(p.properties?.modulate).toBeUndefined();
    expect(p.styleboxes).toEqual([
      { slot: 'panel', box: { bg_color: [16 / 255, 20 / 255, 31 / 255, 1] } },
    ]);
    expect(warnings.some(w => w.includes('近似'))).toBe(false);
  });

  it('有 text 无 bg(Label)→ 不设 self_modulate(负例)', () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: 'x' })]));
    const p = findNode(tree, 'T')!.properties ?? {};
    expect(p.self_modulate).toBeUndefined();
  });

  // I-1(final review 负例防回归):value 推断 ProgressBar 无 text/bg —— 自带视觉,不设透明壳
  it('ProgressBar(value 推断)无 bg → 不设 self_modulate(HP 条不可见回归防线)', () => {
    const { tree } = tr(geo([n('Hp', 0, 0, 200, 27, { value: 0.72 })]));
    const p = findNode(tree, 'Hp')!.properties ?? {};
    expect(findNode(tree, 'Hp')!.type).toBe('ProgressBar');
    expect(p.self_modulate).toBeUndefined();
  });

  // I-1:显式 type 一律不设(type 显式给出者说明有意为之——含显式 Label/ProgressBar/Panel)
  it('显式 type Label 无 text/bg → 不设 self_modulate', () => {
    const { tree } = tr(geo([n('L', 0, 0, 80, 40, { type: 'Label' })]));
    const p = findNode(tree, 'L')!.properties ?? {};
    expect(p.self_modulate).toBeUndefined();
  });

  it('显式 type ProgressBar 无 bg(RTS fixture HpBar 形态)→ 不设 self_modulate', () => {
    const { tree } = tr(geo([n('HpBar', 992, 599, 240, 27, { type: 'ProgressBar', value: 0.72 })]));
    const p = findNode(tree, 'HpBar')!.properties ?? {};
    expect(p.self_modulate).toBeUndefined();
  });

  // 审查遗留①(与 I-1 对偶):显式 Panel 无 bg → 落 Godot 默认灰底 stylebox(HTML div 默认透明,
  // 行为翻转),须 declaration warning;有 bg 负例不触发。
  it('显式 type Panel 无 bg → 不设 modulate/self_modulate + 灰底翻转 warning', () => {
    const { tree, warnings } = tr(geo([n('P', 0, 0, 100, 50, { type: 'Panel' })]));
    const p = findNode(tree, 'P')!.properties ?? {};
    expect(p.self_modulate).toBeUndefined();
    expect(p.modulate).toBeUndefined();
    expect(warnings.some(w => w.includes('P') && w.includes('gray panel stylebox'))).toBe(true);
  });

  it('显式 type Panel 有 bg → panel 槽 stylebox,无灰底翻转 warning(负例)', () => {
    const { tree, warnings } = tr(geo([n('PB', 0, 0, 100, 50, { type: 'Panel', bg: '#10141f' })]));
    expect(findNode(tree, 'PB')!.styleboxes).toHaveLength(1);
    expect(warnings.some(w => w.includes('gray panel stylebox'))).toBe(false);
  });

  // 审查 N-5:非白名单 type 降级 Panel 无 bg → 同样落灰底默认主题,须一并提示(与显式 Panel 对齐)
  it('非白名单 type(降级 Panel)无 bg → 灰底翻转 warning + 降级 warning 并存', () => {
    const { tree, warnings } = tr(geo([n('Custom', 0, 0, 100, 50, { type: 'Foo' })]));
    expect(findNode(tree, 'Custom')!.type).toBe('Panel');
    expect(warnings.some(w => w.includes('Custom') && w.includes('降级为 Panel'))).toBe(true);
    expect(warnings.some(w => w.includes('Custom') && w.includes('gray panel stylebox'))).toBe(true);
  });

  // I-1:Button(推断或显式)自带视觉,不设透明壳
  it('Button 推断(interactive+text)与显式 Button → 不设 self_modulate', () => {
    const { tree } = tr(geo([
      n('OkBtn', 0, 0, 80, 40, { text: '确定', interactive: true }),
      n('BtnA', 100, 0, 80, 40, { type: 'Button', text: 'A', interactive: true }),
    ]));
    expect(findNode(tree, 'OkBtn')!.type).toBe('Button');
    expect(findNode(tree, 'OkBtn')!.properties?.self_modulate).toBeUndefined();
    expect(findNode(tree, 'BtnA')!.properties?.self_modulate).toBeUndefined();
  });

  it('flow 壳自身无 bg → self_modulate 透明', () => {
    const { tree } = tr(geo([
      n('Bar', 0, 0, 400, 40, { flow: 'row' }),
      n('A', 0, 0, 100, 40),
    ]));
    expect(findNode(tree, 'Bar')!.properties!.self_modulate).toEqual([1, 1, 1, 0]);
  });
});

describe('规则 5: flow 容器(壳 + _Flow + 子丢 rect 留 min_size)', () => {
  const built = tr(geo([
    n('Bar', 10, 20, 400, 40, { flow: 'row', justify: 'space-between' }),
    n('L', 10, 20, 100, 40), n('R', 310, 20, 100, 40),
  ]));

  it('壳保留 name/rect(相对化),子层 _Flow 为 full_rect 容器', () => {
    const bar = findNode(built.tree, 'Bar')!;
    expect(bar.type).toBe('Panel');
    expect(bar.rect).toEqual({ x: 10, y: 20, w: 400, h: 40 });
    const flow = bar.children!.find(c => c.name === 'Bar_Flow')!;
    expect(flow.type).toBe('HBoxContainer');
    expect(flow.anchor_preset).toBe('full_rect');
    expect(flow.rect).toBeUndefined();
    expect(flow.layout).toEqual({ direction: 'row', justify: 'space-between' });
  });

  it('flow 子节点挂 _Flow 下、丢 rect、min_size 取原 rect 尺寸', () => {
    const flow = findNode(built.tree, 'Bar_Flow')!;
    const kids = flow.children ?? [];
    expect(kids.map(k => k.name).sort()).toEqual(['L', 'R']);
    for (const k of kids) {
      expect(k.rect).toBeUndefined();
      expect(k.flex).toEqual({ min_width: 100, min_height: 40 });
    }
    // flow 子节点 min_size 映射产生提示 warning
    expect(built.warnings.some(w => w.includes('min_'))).toBe(true);
  });

  it('flow 子节点的孙层保留相对化 rect(相对其输入父原点)', () => {
    const { tree } = tr(geo([
      n('Bar', 0, 0, 400, 100, { flow: 'row' }),
      n('Item', 0, 0, 200, 100),
      n('Deep', 20, 30, 160, 40), // Item 的子,孙层
    ]));
    const deep = findNode(tree, 'Deep')!;
    expect(deep.rect).toEqual({ x: 20, y: 30, w: 160, h: 40 }); // 20-0, 30-0(相对 Item 原点)
    expect(findNode(tree, 'Item')!.children?.some(c => c.name === 'Deep')).toBe(true);
  });
});

describe('规则 6/7: 字号与行高钳制预警', () => {
  it('fontSize → theme_override_font_sizes/font_size', () => {
    const { tree } = tr(geo([n('T', 0, 0, 200, 48, { text: 'x', fontSize: 16 })]));
    expect(findNode(tree, 'T')!.properties!['theme_override_font_sizes/font_size']).toBe(16);
  });

  it('rect.h < fontSize*1.5 → warning 含"钳制";足够高则无(负例)', () => {
    const r1 = tr(geo([n('S', 0, 0, 200, 18, { text: 'x', fontSize: 16 })]));
    expect(r1.warnings.some(w => w.includes('钳制'))).toBe(true);
    const r2 = tr(geo([n('B', 0, 0, 200, 48, { text: 'x', fontSize: 16 })]));
    expect(r2.warnings.some(w => w.includes('钳制'))).toBe(false);
  });

  // 规则 7 同族(引擎下限,2026-08-16 Task 3 集成验收裁定):Godot 4.7 默认主题
  // ProgressBar stylebox 最小高 27px(实测 HpBar h=16 落地 27)——只警不修。
  it('ProgressBar rect.h < 27 → "will be clamped" 预警;h=27 与非 ProgressBar 不误报(负例)', () => {
    const r1 = tr(geo([n('P', 0, 0, 240, 16, { type: 'ProgressBar', value: 0.7 })]));
    expect(r1.warnings.some(w => w.includes('will be clamped'))).toBe(true);
    const r2 = tr(geo([n('P', 0, 0, 240, 27, { type: 'ProgressBar', value: 0.7 })]));
    expect(r2.warnings.some(w => w.includes('will be clamped'))).toBe(false);
    // 非 ProgressBar 的矮节点不误报(该引擎约束仅 ProgressBar)
    const r3 = tr(geo([n('L', 0, 0, 240, 16, { type: 'Panel' })]));
    expect(r3.warnings.some(w => w.includes('will be clamped'))).toBe(false);
  });
});

describe('规则 8/9/10: 颜色三格式与对齐', () => {
  it("color '#ff8000' → font_color [1, 128/255, 0, 1]", () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: '#ff8000' })]));
    expect(findNode(tree, 'T')!.properties!['theme_override_colors/font_color'])
      .toEqual([1, 128 / 255, 0, 1]);
  });

  it('color [r,g,b](0-255)→ 归一 0-1', () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: [255, 128, 0] })]));
    expect(findNode(tree, 'T')!.properties!['theme_override_colors/font_color'])
      .toEqual([1, 128 / 255, 0, 1]);
  });

  it('color [r,g,b,a](0-1)→ 直接用', () => {
    const { tree } = tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: [1, 0.5, 0, 0.25] })]));
    expect(findNode(tree, 'T')!.properties!['theme_override_colors/font_color'])
      .toEqual([1, 0.5, 0, 0.25]);
  });

  it('color/bg 格式非法 → INVALID_PARAMS', () => {
    expect(() => tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: '#ff' })]))).toThrow(/INVALID_PARAMS/);
    expect(() => tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: '#gggggg' })]))).toThrow(/INVALID_PARAMS/);
    expect(() => tr(geo([n('T', 0, 0, 80, 40, { text: 'x', color: [1, 2] })]))).toThrow(/INVALID_PARAMS/);
    expect(() => tr(geo([n('T', 0, 0, 80, 40, { bg: 42 as unknown as string })]))).toThrow(/INVALID_PARAMS/);
  });

  it('bg [r,g,b](0-255)→ stylebox bg_color 归一', () => {
    const { tree } = tr(geo([n('P', 0, 0, 80, 40, { bg: [10, 20, 30] })]));
    expect(findNode(tree, 'P')!.styleboxes![0]!.box.bg_color).toEqual([10 / 255, 20 / 255, 30 / 255, 1]);
  });

  it('align left/center/right → horizontal_alignment 0/1/2', () => {
    const mk = (align: 'left' | 'center' | 'right') =>
      tr(geo([n('T', 0, 0, 80, 40, { text: 'x', align })]));
    expect(findNode(mk('left').tree, 'T')!.properties!.horizontal_alignment).toBe(0);
    expect(findNode(mk('center').tree, 'T')!.properties!.horizontal_alignment).toBe(1);
    expect(findNode(mk('right').tree, 'T')!.properties!.horizontal_alignment).toBe(2);
  });
});

describe('规则 11: 白名单过滤', () => {
  it('非白名单 type → Panel 降级 + warning', () => {
    const { tree, warnings } = tr(geo([n('W', 0, 0, 50, 50, { type: 'MagicWidget' })]));
    expect(findNode(tree, 'W')!.type).toBe('Panel');
    expect(warnings.some(w => w.includes('MagicWidget') && w.includes('降级'))).toBe(true);
  });

  it('白名单 type 不产生降级 warning(负例)', () => {
    const { warnings } = tr(geo([n('L', 0, 0, 50, 50, { type: 'Label', text: 'x' })]));
    expect(warnings.some(w => w.includes('降级'))).toBe(false);
  });
});

describe('规则 12: 深度 cap 与 name 清洗', () => {
  it('name 非法字符 [^a-zA-Z0-9_] → _', () => {
    const { tree } = tr(geo([n('非法 字符!', 0, 0, 50, 50)]));
    expect(findNode(tree, '______')).toBeDefined(); // "非法 字符!" 共 6 字符全清洗
  });

  it('清洗后重复("A B" 与 "A_B")→ INVALID_PARAMS', () => {
    expect(() => tr(geo([n('A B', 0, 0, 50, 50), n('A_B', 100, 0, 50, 50)]))).toThrow(/INVALID_PARAMS/);
  });

  it('原始 name 重复 → INVALID_PARAMS', () => {
    expect(() => tr(geo([n('A', 0, 0, 50, 50), n('A', 100, 0, 50, 50)]))).toThrow(/INVALID_PARAMS/);
  });

  it('输入嵌套 10 层(最终树 11 层)→ throw;9 层(最终 10)→ 合法', () => {
    const chain = (depth: number): GeometryNode[] =>
      Array.from({ length: depth }, (_, i) => n(`L${i}`, i, i, 200 - i * 2, 100 - i * 2));
    expect(() => tr(geo(chain(10)))).toThrow(/INVALID_PARAMS/);
    expect(() => tr(geo(chain(9)))).not.toThrow();
  });
});

// ─── 组 4: coverage ────────────────────────────────────────────────────────

describe('coverage', () => {
  it('无 flow:targets = flattenTargets(tree).length = 输入节点数 + 1(合成根)', () => {
    const g = geo([
      n('Root', 0, 0, 1000, 800),
      n('A', 10, 10, 100, 50, { text: 'x' }),
      n('B', 10, 70, 100, 50),
    ]);
    const r = tr(g);
    expect(r.coverage.total_nodes).toBe(3);
    expect(r.coverage.targets).toBe(flattenTargets(r.tree).length);
    expect(r.coverage.targets).toBe(4); // 合成根 + Root + A + B
  });

  it('含 flow:子节点丢 rect → targets < total_nodes', () => {
    const g = geo([
      n('Bar', 0, 0, 400, 40, { flow: 'row' }),
      n('L', 0, 0, 100, 40), n('R', 300, 0, 100, 40),
      n('Out', 0, 100, 400, 50),
    ]);
    const r = tr(g);
    expect(r.coverage.total_nodes).toBe(4);
    // targets = 合成根 + Bar 壳 + Out = 3;L/R 丢 rect 不计
    expect(r.coverage.targets).toBe(flattenTargets(r.tree).length);
    expect(r.coverage.targets).toBeLessThan(r.coverage.total_nodes);
    expect(r.warnings.some(w => w.includes('verify'))).toBe(true);
  });
});

// ─── PR-1 Task 2: 样式三件套翻译规则 ───────────────────────────────────────

describe('StyleBox 通道翻译(PR-1)', () => {
  it('ProgressBar: bg→background 槽 + fill→fill 槽双 stylebox', () => {
    const { tree } = tr(geo([n('Hp', 0, 0, 120, 20, { type: 'ProgressBar', value: 0.5, bg: '#222222', fill: '#3ddc84' })]));
    const sb = findNode(tree, 'Hp')!.styleboxes!;
    expect(sb.map(s => s.slot)).toEqual(['background', 'fill']);
    expect(sb[1]!.box.bg_color).toEqual([61 / 255, 220 / 255, 132 / 255, 1]);
  });

  it('Button/Label 有 bg → normal 槽(badge 映射)', () => {
    const { tree: t1 } = tr(geo([n('Tag', 0, 0, 40, 20, { text: 'NEW', bg: '#3ddc84' })]));
    expect(findNode(t1, 'Tag')!.styleboxes![0]!.slot).toBe('normal');   // text+无 interactive → Label
    const { tree: t2 } = tr(geo([n('Btn', 0, 0, 60, 30, { text: '确定', interactive: true, bg: '#2255aa' })]));
    expect(findNode(t2, 'Btn')!.styleboxes![0]!.slot).toBe('normal');   // interactive+text → Button
  });

  it('bg 缺省但 border/borderRadius 存在 → draw_center=false(CSS 透明底)', () => {
    const { tree } = tr(geo([n('BO', 0, 0, 60, 30, { type: 'Panel', borderRadius: 8, border: { width: 2, color: '#7a8aab' } })]));
    const box = findNode(tree, 'BO')!.styleboxes![0]!.box;
    expect(box.draw_center).toBe(false);
    expect(box.bg_color).toBeUndefined();
    expect(box.corner_radius).toBe(8);
    expect(box.border_width).toBe(2);
    expect(box.border_color).toEqual([122 / 255, 138 / 255, 171 / 255, 1]);
  });

  it('borderRadius 四角对象原样保留', () => {
    const { tree } = tr(geo([n('R4', 0, 0, 60, 30, { type: 'Panel', bg: '#111111', borderRadius: { tl: 8, br: 4 } })]));
    expect(findNode(tree, 'R4')!.styleboxes![0]!.box.corner_radius).toEqual({ tl: 8, br: 4 });
  });

  it('未映射控件(LineEdit)带 bg → warning + 忽略(不产 stylebox)', () => {
    const { tree, warnings } = tr(geo([n('LE', 0, 0, 100, 24, { type: 'LineEdit', bg: '#123456' })]));
    expect(findNode(tree, 'LE')!.styleboxes).toBeUndefined();
    expect(warnings.some(w => w.includes('LE') && w.includes('样式槽位'))).toBe(true);
  });

  it('fill 给非 ProgressBar → warning + 忽略', () => {
    const { tree, warnings } = tr(geo([n('LB', 0, 0, 40, 20, { text: 'x', fill: '#ff0000' })]));
    expect(findNode(tree, 'LB')!.styleboxes).toBeUndefined();
    expect(warnings.some(w => w.includes('fill 仅 ProgressBar'))).toBe(true);
  });

  it('规则 7:ProgressBar h<27 无条件预警(带 override 仍被钳,实测 23/27)', () => {
    const { warnings: w1 } = tr(geo([n('P1', 0, 0, 100, 16, { type: 'ProgressBar', value: 0.5 })]));
    expect(w1.some(w => w.includes('will be clamped'))).toBe(true);
    const { warnings: w2 } = tr(geo([n('P2', 0, 0, 100, 16, { type: 'ProgressBar', value: 0.5, bg: '#222222', fill: '#3ddc84' })]));
    expect(w2.some(w => w.includes('will be clamped'))).toBe(true);
  });

  it('parseGeometry:borderRadius 负值 → INVALID_PARAMS;border 坏颜色 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('X', 0, 0, 10, 10, { borderRadius: -1 })])))
      .toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('Y', 0, 0, 10, 10, { border: { width: 1, color: 'not-a-color' } })])))
      .toThrow(/INVALID_PARAMS/);
  });
});

// ─── B1: border 四边各异消静默(2026-10-24 UI 迁移构建侧整改方案 §四) ───────

describe('border 四边各异消静默(B1)', () => {
  it('perSides 四边各异 → warning 存在且 border_width 仍取 top(渲染行为不变)', () => {
    const { tree, warnings } = tr(geo([n('BD', 0, 0, 60, 30, {
      type: 'Panel', bg: '#111111',
      border: { width: 2, color: '#7a8aab', perSides: { top: 2, right: 4, bottom: 6, left: 4 } },
    })]));
    const box = findNode(tree, 'BD')!.styleboxes![0]!.box;
    expect(box.border_width).toBe(2);
    expect(warnings.some(w => w.includes('BD') && w.includes('border sides differ')
      && w.includes('2/4/6/4') && w.includes('using top'))).toBe(true);
  });

  it('perSides 四边全等 → 无 border sides differ warning', () => {
    const { warnings } = tr(geo([n('BE', 0, 0, 60, 30, {
      type: 'Panel', bg: '#111111',
      border: { width: 2, color: '#7a8aab', perSides: { top: 2, right: 2, bottom: 2, left: 2 } },
    })]));
    expect(warnings.some(w => w.includes('border sides differ'))).toBe(false);
  });

  it('不带 perSides → 零变化(回归:border_width 正常产出、无 border warning)', () => {
    const { tree, warnings } = tr(geo([n('BR', 0, 0, 60, 30, {
      type: 'Panel', bg: '#111111', border: { width: 3, color: '#7a8aab' },
    })]));
    expect(findNode(tree, 'BR')!.styleboxes![0]!.box.border_width).toBe(3);
    expect(warnings.some(w => w.includes('border sides differ'))).toBe(false);
  });

  it('top=0 其余边>0:borderNotice 透传成 warning,且不触发任何 stylebox override(防 draw_center=false 全透明回归)', () => {
    // 无 bg + 仅 borderNotice(无 border/borderRadius)→ 不进 hasBorderish 分支 → 零 override;
    // 若翻译器误把 borderNotice 算进 hasBorderish,将产出 draw_center=false 的 override,本断言变红
    const { tree, warnings } = tr(geo([n('BN', 0, 0, 60, 30, {
      type: 'Panel',
      borderNotice: 'CSS border top=0 而其余边>0 (top/right/bottom/left = 0/0/2/0);Godot StyleBoxFlat 无按边 border,已不产 border spec——改为独立装饰线节点或源侧统一边框',
    })]));
    expect(findNode(tree, 'BN')!.styleboxes).toBeUndefined();
    expect(warnings.some(w => w.includes('BN') && w.includes('top=0') && w.includes('不产 border spec'))).toBe(true);
  });

  it('显式 width:0 → schema 拒绝(I-1 防线:防「有 border 无 bg」走 draw_center=false 全透明静默回归)', () => {
    expect(() => parseGeometry(geo([n('W0', 0, 0, 10, 10, {
      type: 'Panel', border: { width: 0, color: '#ffffff' },
    })]))).toThrow(/INVALID_PARAMS/);
  });

  it('parseGeometry:perSides 缺边/负值 → INVALID_PARAMS;borderNotice 非串 → INVALID_PARAMS', () => {
    expect(() => parseGeometry(geo([n('M1', 0, 0, 10, 10, {
      type: 'Panel',
      border: { width: 1, color: '#ffffff', perSides: { top: 1, right: 1, bottom: 1 } as unknown as { top: number; right: number; bottom: number; left: number } },
    })]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('M2', 0, 0, 10, 10, {
      type: 'Panel',
      border: { width: 1, color: '#ffffff', perSides: { top: -1, right: 1, bottom: 1, left: 1 } },
    })]))).toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('M3', 0, 0, 10, 10, {
      type: 'Panel', borderNotice: 42 as unknown as string,
    })]))).toThrow(/INVALID_PARAMS/);
  });
});

// ─── PR-2 Task 2: flow_expect 产出 + fill-only 灰底 warning ────────────────

describe('flow_expect(PR-2,spec §4.2)', () => {
  const geo = (nodes: unknown[]) => ({ viewport: { w: 1280, h: 720 }, nodes });

  it('flow 直接子节点 → flow_expect 条目(path 含 _Flow 层,rect 为输入视口绝对)', () => {
    const r = translateGeometry(geo([
      { name: 'Holder', rect: { x: 100, y: 100, w: 408, h: 40 }, flow: 'row', justify: 'space-between' },
      { name: 'BtnA', rect: { x: 100, y: 104, w: 72, h: 32 }, type: 'Button', text: 'A' },
      { name: 'BtnB', rect: { x: 268, y: 104, w: 72, h: 32 }, type: 'Button', text: 'B' },
    ]) as never);
    expect(r.flow_expect).toEqual([
      { path: '_PrototypeRoot/Holder/Holder_Flow/BtnA', rect: { x: 100, y: 104, w: 72, h: 32 } },
      { path: '_PrototypeRoot/Holder/Holder_Flow/BtnB', rect: { x: 268, y: 104, w: 72, h: 32 } },
    ]);
  });
  it('flow 孙层不进 flow_expect(仅直接子层);孙层 rect 照旧保留在树中', () => {
    const r = translateGeometry(geo([
      { name: 'F', rect: { x: 0, y: 0, w: 400, h: 100 }, flow: 'row' },
      { name: 'C1', rect: { x: 0, y: 0, w: 200, h: 100 } },
      { name: 'G1', rect: { x: 10, y: 10, w: 50, h: 30 }, text: 'g' },
    ]) as never);
    expect(r.flow_expect).toEqual([{ path: '_PrototypeRoot/F/F_Flow/C1', rect: { x: 0, y: 0, w: 200, h: 100 } }]);
    const c1 = r.tree.children![0]!.children![0]!.children![0]!;
    expect(c1.name).toBe('C1');
    expect(c1.children![0]!.rect).toBeDefined(); // 孙层保留 rect(近似覆盖)
  });
  it('嵌套 flow:内层 flow 直接子也进 flow_expect(path 全链)', () => {
    const r = translateGeometry(geo([
      { name: 'Outer', rect: { x: 0, y: 0, w: 400, h: 200 }, flow: 'row' },
      { name: 'Inner', rect: { x: 0, y: 0, w: 200, h: 200 }, flow: 'column' },
      { name: 'Leaf', rect: { x: 5, y: 5, w: 100, h: 30 }, text: 'x' },
    ]) as never);
    expect(r.flow_expect).toEqual([
      { path: '_PrototypeRoot/Outer/Outer_Flow/Inner', rect: { x: 0, y: 0, w: 200, h: 200 } },
      { path: '_PrototypeRoot/Outer/Outer_Flow/Inner/Inner_Flow/Leaf', rect: { x: 5, y: 5, w: 100, h: 30 } },
    ]);
  });
  it('合成根撞名改名时 path 用最终树名(禁硬编码 ROOT_NAME)', () => {
    const r = translateGeometry(geo([
      { name: '_PrototypeRoot', rect: { x: 0, y: 0, w: 1280, h: 720 }, flow: 'row' },
      { name: 'A', rect: { x: 0, y: 0, w: 50, h: 30 }, text: 'a' },
    ]) as never);
    expect(r.tree.name).toBe('_PrototypeRoot2');   // uniqueName 改名
    expect(r.flow_expect[0]!.path).toBe('_PrototypeRoot2/_PrototypeRoot/_PrototypeRoot_Flow/A');
  });
  it('无 flow → flow_expect 空数组', () => {
    const r = translateGeometry(geo([
      { name: 'A', rect: { x: 0, y: 0, w: 50, h: 30 }, text: 'a' },
    ]) as never);
    expect(r.flow_expect).toEqual([]);
  });
  it('B-2 warning 文案改为 flow_verify 数字覆盖措辞', () => {
    const r = translateGeometry(geo([
      { name: 'F', rect: { x: 0, y: 0, w: 400, h: 100 }, flow: 'row' },
      { name: 'C1', rect: { x: 0, y: 0, w: 200, h: 100 }, text: 'c' },
    ]) as never);
    // brief 原选择器 includes('flow') 会先命中 flow 子节点 min_size 提示(树构造期先 push),
    // 改用 flow_verify 精确定位 B-2 文案;后续断言语义不变。
    const w = r.warnings.find(x => x.includes('flow_verify'))!;
    expect(w).toContain('直接子节点');
    expect(w).not.toContain('screenshot diff 兜底');
  });
});

describe('fill-only 灰底 warning(PR-2 顺手项 3/4,PR-1 终审转来)', () => {
  const geo = (nodes: unknown[]) => ({ viewport: { w: 800, h: 600 }, nodes });

  it('显式 Panel fill-only:fill 忽略 warning 追加默认主题灰底声明', () => {
    const r = translateGeometry(geo([
      { name: 'P', rect: { x: 0, y: 0, w: 100, h: 50 }, type: 'Panel', fill: '#3ddc84' },
    ]) as never);
    const w = r.warnings.find(x => x.includes('fill 仅 ProgressBar'))!;
    expect(w).toContain('灰底');
    expect(r.tree.children![0]!.styleboxes).toBeUndefined(); // 无 override 产出
  });
  it('推断布局壳 fill-only:同样灰底声明(透明壳被 fill 输入阻断)', () => {
    const r = translateGeometry(geo([
      { name: 'Shell', rect: { x: 0, y: 0, w: 100, h: 50 }, fill: '#3ddc84' },
    ]) as never);
    const w = r.warnings.find(x => x.includes('fill 仅 ProgressBar'))!;
    expect(w).toContain('灰底');
    expect(r.tree.children![0]!.properties?.self_modulate).toBeUndefined(); // 未设透明壳(fill 阻断推断壳路径,properties 可能整体不存在,用可选链)
  });
  it('fill+bg(显式 Panel):仅 fill 忽略 warning,无灰底声明(有 override 不灰底)', () => {
    const r = translateGeometry(geo([
      { name: 'P', rect: { x: 0, y: 0, w: 100, h: 50 }, type: 'Panel', bg: '#1a1f2e', fill: '#3ddc84' },
    ]) as never);
    const w = r.warnings.find(x => x.includes('fill 仅 ProgressBar'))!;
    expect(w).not.toContain('灰底');
  });
  it('fill-only Label:fill 忽略 warning 无灰底措辞(Label 默认主题透明,非灰底)', () => {
    const r = translateGeometry(geo([
      { name: 'L', rect: { x: 0, y: 0, w: 100, h: 30 }, text: 'x', fill: '#3ddc84' },
    ]) as never);
    const w = r.warnings.find(x => x.includes('fill 仅 ProgressBar'))!;
    expect(w).not.toContain('灰底');
  });
});

// ─── 批1 1e(Task 6): flow_gap/flow_align 平级新键 + 多层 flow 翻译 ──────────

describe('flow_gap/flow_align schema(批1 1e)', () => {
  it('{flow:"row", flow_gap:8, flow_align:"center"} 通过(schema 新平级可选键)', () => {
    const g = parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: 8, flow_align: 'center' })]));
    expect(g.nodes[0]!.flow_gap).toBe(8);
    expect(g.nodes[0]!.flow_align).toBe('center');
  });

  it('flow_gap: -1 → 拒(min(0))', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: -1 })])))
      .toThrow(/INVALID_PARAMS/);
  });

  it('flow_gap: NaN/Infinity → 拒(finite)', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: NaN })])))
      .toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: Infinity })])))
      .toThrow(/INVALID_PARAMS/);
  });

  it('flow_gap: 0 合法(下界含 0);非数字 → 拒', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: 0 })]))).not.toThrow();
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_gap: '8' as unknown as number })])))
      .toThrow(/INVALID_PARAMS/);
  });

  it('flow_align 枚举外("justify"/"stretch")→ 拒', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_align: 'justify' as never })])))
      .toThrow(/INVALID_PARAMS/);
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: 'row', flow_align: 'stretch' as never })])))
      .toThrow(/INVALID_PARAMS/);
  });

  it('BC 锚:flow 枚举形态不动——{flow:{dir:"row"}} 仍拒(不升级为对象形态)', () => {
    expect(() => parseGeometry(geo([n('A', 0, 0, 50, 50, { flow: { dir: 'row' } as unknown as 'row' })])))
      .toThrow(/INVALID_PARAMS/);
  });
});

describe('多层 flow + flow_gap/flow_align 翻译(批1 1e)', () => {
  it('三层嵌套 flow 壳(根 flow row > 子 flow column > 孙 Label)→ Container 嵌套树,孙不再走 rect 锚点', () => {
    const r = tr(geo([
      n('Root', 0, 0, 600, 400, { flow: 'row' }),
      n('Sub', 0, 0, 280, 400, { flow: 'column' }),
      n('Label', 10, 10, 200, 30, { text: 'x' }),
    ]));
    // 根:_PrototypeRoot > Root(壳) > Root_Flow(HBox)
    const rootFlow = findNode(r.tree, 'Root')!.children!.find(c => c.name === 'Root_Flow')!;
    expect(rootFlow.type).toBe('HBoxContainer');
    // 子:Root_Flow 内是 Sub(壳) > Sub_Flow(VBox)——任意深度 flow 壳子节点进 Container
    const sub = rootFlow.children!.find(c => c.name === 'Sub')!;
    expect(sub).toBeDefined();
    const subFlow = sub.children!.find(c => c.name === 'Sub_Flow')!;
    expect(subFlow.type).toBe('VBoxContainer');
    // 孙 Label 挂 Sub_Flow 容器内,丢 rect(不走锚点求解)、min_size 取原尺寸
    const label = subFlow.children!.find(c => c.name === 'Label')!;
    expect(label.type).toBe('Label');
    expect(label.rect).toBeUndefined();
    expect(label.flex).toEqual({ min_width: 200, min_height: 30 });
    // 两层 flow 直接子都进 flow_expect(数字覆盖不因嵌套丢失)
    expect(r.flow_expect.map(e => e.path)).toEqual([
      '_PrototypeRoot/Root/Root_Flow/Sub',
      '_PrototypeRoot/Root/Root_Flow/Sub/Sub_Flow/Label',
    ]);
  });

  it('flow_gap: 8 → _Flow 容器 layout.gap=8(HBox/VBox separation 的 theme override 常量载体)', () => {
    const r = tr(geo([
      n('Bar', 0, 0, 400, 100, { flow: 'row', flow_gap: 8 }),
      n('A', 0, 0, 100, 100, { text: 'a' }),
    ]));
    expect(findNode(r.tree, 'Bar_Flow')!.layout).toEqual({ direction: 'row', gap: 8 });
  });

  it('flow_align start/center/end → layout.align flex-start/center/flex-end(跨轴对齐词表映射)', () => {
    const mk = (flow_align: 'start' | 'center' | 'end') =>
      tr(geo([
        n('Bar', 0, 0, 400, 100, { flow: 'row', flow_align }),
        n('A', 0, 0, 100, 100, { text: 'a' }),
      ]));
    expect(findNode(mk('start').tree, 'Bar_Flow')!.layout!.align).toBe('flex-start');
    expect(findNode(mk('center').tree, 'Bar_Flow')!.layout!.align).toBe('center');
    expect(findNode(mk('end').tree, 'Bar_Flow')!.layout!.align).toBe('flex-end');
  });

  it('多层 flow 各自携带 flow_gap/flow_align,各自落到自己的 _Flow 容器(不串层)', () => {
    const r = tr(geo([
      n('Root', 0, 0, 600, 400, { flow: 'row', flow_gap: 8, flow_align: 'center' }),
      n('Sub', 0, 0, 280, 400, { flow: 'column', flow_gap: 4, flow_align: 'end' }),
      n('Label', 10, 10, 200, 30, { text: 'x' }),
    ]));
    expect(findNode(r.tree, 'Root_Flow')!.layout).toEqual({ direction: 'row', gap: 8, align: 'center' });
    expect(findNode(r.tree, 'Sub_Flow')!.layout).toEqual({ direction: 'column', gap: 4, align: 'flex-end' });
  });

  it('flow_gap/flow_align 无 flow → 忽略 + warning(不静默丢弃)', () => {
    const r = tr(geo([
      n('Plain', 0, 0, 400, 100, { flow_gap: 8, flow_align: 'center' }),
      n('Kid', 10, 10, 100, 30, { text: 'k' }),
    ]));
    const plain = findNode(r.tree, 'Plain')!;
    expect(plain.layout).toBeUndefined();
    expect(r.warnings.some(w => w.includes('Plain') && w.includes('flow_gap') && w.includes('flow 未声明')))
      .toBe(true);
  });
});

describe('无新键回归锚(批1 1e,BC 三锚之一)', () => {
  it('不带 flow_gap/flow_align 的既有输入 → 产出树/flow_expect/coverage 与改前逐字节一致', () => {
    // 基线取自改动前代码的实际输出(2026-11-16,commit 9dbb188b 工作区)——JSON.stringify
    // 键序由构造代码决定,同构对象重序列化恒定,可作逐字节锚。
    const r = tr(geo([
      n('Bar', 10, 20, 400, 40, { flow: 'row', justify: 'space-between' }),
      n('L', 10, 20, 100, 40, { text: 'l' }),
      n('R', 310, 20, 100, 40, { text: 'r' }),
      n('Out', 0, 100, 400, 50, { bg: '#10141f' }),
    ]));
    expect(JSON.stringify(r.tree)).toBe(
      '{"type":"Panel","name":"_PrototypeRoot","rect":{"x":0,"y":0,"w":1280,"h":720},'
      + '"properties":{"self_modulate":[1,1,1,0]},"children":['
      + '{"type":"Panel","name":"Bar","rect":{"x":10,"y":20,"w":400,"h":40},'
      + '"properties":{"self_modulate":[1,1,1,0]},"children":['
      + '{"type":"HBoxContainer","name":"Bar_Flow","anchor_preset":"full_rect",'
      + '"layout":{"direction":"row","justify":"space-between"},"children":['
      + '{"type":"Label","name":"L","properties":{"text":"l","horizontal_alignment":1,"vertical_alignment":1},'
      + '"flex":{"min_width":100,"min_height":40}},'
      + '{"type":"Label","name":"R","properties":{"text":"r","horizontal_alignment":1,"vertical_alignment":1},'
      + '"flex":{"min_width":100,"min_height":40}}]}]},'
      + '{"type":"Panel","name":"Out","rect":{"x":0,"y":100,"w":400,"h":50},'
      + '"styleboxes":[{"slot":"panel","box":{"bg_color":[0.06274509803921569,0.0784313725490196,0.12156862745098039,1]}}]}]}',
    );
    expect(r.flow_expect).toEqual([
      { path: '_PrototypeRoot/Bar/Bar_Flow/L', rect: { x: 10, y: 20, w: 100, h: 40 } },
      { path: '_PrototypeRoot/Bar/Bar_Flow/R', rect: { x: 310, y: 20, w: 100, h: 40 } },
    ]);
    expect(r.coverage).toEqual({ targets: 3, total_nodes: 4 });
  });
});
