// solve_from_current(批1 1d Task5):授权几何解析 + planRebase + tscn 文本 patch + 0 容差闭环。
//
// 数值契约(本文件头注,实现侧 anchor-rebase.ts 同款):Control 边距引擎侧按 real_t=float32
// 重算(margin = fl32(fl32(anchor·parentSize)+offset)),纯 float64 求解在靶子真实值上有
// 1 ulp 漂移(探针 4/24 miss)——断言全部锚定 f32 感知推导的位级恒等:
//   fr(fr(fr(anchor)·parentSize) + fr(offset)) === 当前边距(float32 语义下严格 ===)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseAuthoredGeometry, planRebase, applyRebasePatch, simulateMargins,
} from '../src/tools/ui/anchor-rebase.js';
import { handleTool } from '../src/tools/ui/index.js';
import { compareBaseline } from '../src/tools/ui/quality-check.js';
import { genUiMeasureScript } from '../src/tools/ui/ui-measure.js';
import { executeGdscriptTrusted } from '../src/gdscript-executor.js';
import type { MeasuredNode } from '../src/tools/ui/layout-diff.js';
import type { ToolContext, ToolResult } from '../src/types.js';

const fr = Math.fround;

// ─── fixture:靶子 daily_login_content.tscn 真实片段(含注释)+ 三变体 ──────────
const FIXTURE = `[gd_scene load_steps=4 format=3]

; 每日签到面板静态 chrome(fixture 取自 DotaLegendGodot daily_login_content.tscn 真实片段)

[ext_resource type="Texture2D" path="res://assets/ui/dailylogin_data_img2.png" id="3_dataimg2"]

[node name="DailyLoginContent" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
mouse_filter = 2

[node name="Panel" type="Control" parent="."]
offset_left = 100.75
offset_top = 36.25
offset_right = 859.25
offset_bottom = 529.75
mouse_filter = 2

; 源 dailylogin_bj:758.5×493.5 全铺(物理 1517×987÷2)
[node name="Bj" type="TextureRect" parent="Panel"]
layout_mode = 0
offset_right = 758.5
offset_bottom = 493.5
mouse_filter = 2
texture = ExtResource("3_dataimg2")
expand_mode = 1

; ── money_lay 源:225×64 @(11.5,421)cocos → (11.5,8.5) ──
[node name="MoneyLay" type="Control" parent="Panel"]
unique_name_in_owner = true
layout_mode = 0
offset_left = 11.5
offset_top = 8.5
offset_right = 236.5
offset_bottom = 72.5
mouse_filter = 2

; 源 ImageView_26:data_img2 43² @(8.5,3.5)
[node name="DataImg2" type="TextureRect" parent="Panel/MoneyLay"]
layout_mode = 0
offset_left = 8.5
offset_top = 3.5
offset_right = 51.5
offset_bottom = 46.5
mouse_filter = 2
texture = ExtResource("3_dataimg2")
expand_mode = 1

; 变体①:无任何 offset 行的节点(全缺省 0)
[node name="NoOffsetNode" type="Control" parent="Panel/MoneyLay"]
mouse_filter = 2

; 变体②:有 anchors 无 offset
[node name="AnchoredNoOffset" type="Control" parent="Panel"]
anchor_left = 0.25
anchor_right = 0.75
mouse_filter = 2

; 容器父子:子应进 skippedContainerChildren(Review Focus 3)
[node name="ToolRow" type="HBoxContainer" parent="Panel"]
offset_left = 10.0
offset_top = 100.0
offset_right = 400.0
offset_bottom = 140.0

[node name="InsideBox" type="Label" parent="Panel/ToolRow"]
offset_left = 5.0
offset_top = 6.0
offset_right = 95.0
offset_bottom = 26.0
text = "x"

; 变体③:多 ext_resource 交错段(节点段之间再出现 ext_resource)
[ext_resource type="Texture2D" path="res://assets/ui/dailylogin_month_7.png" id="4_month"]

[node name="MonthNum" type="TextureRect" parent="Panel/MoneyLay"]
unique_name_in_owner = true
layout_mode = 0
offset_left = 43.75
offset_top = 8.25
offset_right = 90.25
offset_bottom = 44.75
texture = ExtResource("4_month")
expand_mode = 1

; 源 rule_butt:26.5²×0.7=18.55²
[node name="RuleButt" type="TextureButton" parent="Panel/MoneyLay"]
unique_name_in_owner = true
layout_mode = 0
offset_left = 156.225
offset_top = 18.725
offset_right = 174.775
offset_bottom = 37.275
texture_normal = ExtResource("3_dataimg2")
ignore_texture_size = true

; 源 ImageView_30:问号 9×24.5×0.7 钮内居中
[node name="RuleMark" type="TextureRect" parent="Panel/MoneyLay/RuleButt"]
layout_mode = 0
offset_left = 6.125
offset_top = 0.7
offset_right = 12.425
offset_bottom = 17.85
texture = ExtResource("6_rulemark")
expand_mode = 1
`;

/** 引擎 float32 语义重算边距。 */
function recompose(a: number, p: number, o: number): number {
  return fr(fr(fr(a) * p) + fr(o));
}

describe('parseAuthoredGeometry', () => {
  const parsed = parseAuthoredGeometry(FIXTURE);
  const byPath = new Map(parsed.map(n => [n.path, n]));

  it('靶子真实片段:MoneyLay 路径/类型/offset/父信息正确', () => {
    const ml = byPath.get('Panel/MoneyLay')!;
    expect(byPath.has('Panel/MoneyLay')).toBe(true);
    expect(ml.type).toBe('Control');
    expect(ml.parentPath).toBe('Panel');
    expect(ml.parentType).toBe('Control');
    expect(ml.offsets).toEqual({ left: 11.5, top: 8.5, right: 236.5, bottom: 72.5 });
    expect(ml.anchors).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(ml.name).toBe('MoneyLay');
  });

  it('场景根 path="." 无父;Panel 一级路径正确', () => {
    const root = byPath.get('.')!;
    expect(byPath.has('.')).toBe(true);
    expect(root.parentPath).toBe('');
    expect(root.parentType).toBe('');
    expect(root.anchors).toEqual({ left: 0, right: 1, top: 0, bottom: 1 });  // preset 15 + 显式行
    expect(byPath.get('Panel')!.parentPath).toBe('.');
    expect(byPath.get('Panel')!.tscnParent).toBe('.');
  });

  it('变体①:无任何 offset 行的节点 → 全缺省 0(Review Focus 5)', () => {
    const n = byPath.get('Panel/MoneyLay/NoOffsetNode')!;
    expect(byPath.has('Panel/MoneyLay/NoOffsetNode')).toBe(true);
    expect(n.offsets).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(n.anchors).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(n.hasLayout).toBe(false);
  });

  it('变体②:有 anchors 无 offset → anchors 解析、offsets 全 0', () => {
    const n = byPath.get('Panel/AnchoredNoOffset')!;
    expect(n.anchors).toEqual({ left: 0.25, right: 0.75, top: 0, bottom: 0 });
    expect(n.offsets).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(n.hasLayout).toBe(true);
  });

  it('变体③:多 ext_resource 交错段不影响节点解析(MonthNum 完整)', () => {
    const n = byPath.get('Panel/MoneyLay/MonthNum')!;
    expect(byPath.has('Panel/MoneyLay/MonthNum')).toBe(true);
    expect(n.offsets).toEqual({ left: 43.75, top: 8.25, right: 90.25, bottom: 44.75 });
    // 交错 ext_resource 后的深层节点也在(RuleMark)
    expect(byPath.has('Panel/MoneyLay/RuleButt/RuleMark')).toBe(true);
  });

  // ─── 表驱动:全部 16 项 LayoutPreset 缺边填充(Task5 审查 Important#1 盲区)───
  // 枚举顺时针序:top-left(0)→top-right(1)→bottom-right(2)→bottom-left(3)。
  it('preset-only 段:16 项 preset 缺边全部按 Godot 枚举填充', () => {
    const expected: Record<number, [number, number, number, number]> = {
      0: [0, 0, 0, 0], 1: [1, 1, 0, 0], 2: [1, 1, 1, 1], 3: [0, 0, 1, 1],
      4: [0, 0, 0.5, 0.5], 5: [0.5, 0.5, 0, 0], 6: [1, 1, 0.5, 0.5], 7: [0.5, 0.5, 1, 1],
      8: [0.5, 0.5, 0.5, 0.5], 9: [0, 0, 0, 1], 10: [0, 1, 0, 0], 11: [1, 1, 0, 1],
      12: [0, 1, 1, 1], 13: [0.5, 0.5, 0, 1], 14: [0, 1, 0.5, 0.5], 15: [0, 1, 0, 1],
    };  // [left, right, top, bottom]
    const sections = Array.from({ length: 16 }, (_, n) =>
      `[node name="P${n}" type="Control" parent="."]\nanchors_preset = ${n}\n`).join('\n');
    const parsed = parseAuthoredGeometry(
      `[gd_scene format=3]\n\n[node name="Root" type="Control"]\n\n${sections}`);
    for (let n = 0; n < 16; n++) {
      const node = parsed.find(p => p.name === `P${n}`)!;
      expect(parsed.some(p => p.name === `P${n}`), `preset ${n} 节点已解析`).toBe(true);
      const [l, r, t, b] = expected[n]!;
      expect(node.anchors, `preset ${n} 缺边填充`).toEqual({ left: l, right: r, top: t, bottom: b });
      expect(node.hasLayout, `preset ${n} 计为布局节点`).toBe(true);
    }
  });

  it('saver 真实形态:preset 3(BOTTOM_LEFT)仅写 anchor_top/bottom 行 → 解析 [0,0,1,1](Important#1 回归)', () => {
    const parsed = parseAuthoredGeometry(`[gd_scene format=3]

[node name="Root" type="Control"]

[node name="BlNode" type="Control" parent="."]
anchors_preset = 3
anchor_top = 1.0
anchor_bottom = 1.0
`);
    const n = parsed.find(p => p.name === 'BlNode')!;
    expect(parsed.some(p => p.name === 'BlNode')).toBe(true);
    expect(n.anchors).toEqual({ left: 0, right: 0, top: 1, bottom: 1 });
    expect(n.offsets).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('planRebase', () => {
  const parsed = parseAuthoredGeometry(FIXTURE);

  it('Container 父的子进 skippedContainerChildren、不进 toWrite(绝不静默)', () => {
    const plan = planRebase(parsed);
    expect(plan.skippedContainerChildren).toContain('Panel/ToolRow/InsideBox');
    expect(plan.toWrite.map(e => e.path)).not.toContain('Panel/ToolRow/InsideBox');
    // 容器自身(父 Panel 非 Container)仍是改造对象
    expect(plan.toWrite.map(e => e.path)).toContain('Panel/ToolRow');
  });

  it('exclude 过滤进 skippedByFilter;include 白名单生效', () => {
    const plan = planRebase(parsed, { exclude: ['MonthNum'] });
    expect(plan.skippedByFilter).toContain('Panel/MoneyLay/MonthNum');
    expect(plan.toWrite.map(e => e.path)).not.toContain('Panel/MoneyLay/MonthNum');

    const inc = planRebase(parsed, { include: ['MoneyLay', 'DataImg2'] });
    expect(inc.toWrite.map(e => e.path)).toEqual(['Panel/MoneyLay', 'Panel/MoneyLay/DataImg2']);
    expect(inc.skippedByFilter).toContain('Panel/MoneyLay/MonthNum');
    expect(inc.skippedByFilter).toContain('Panel/Bj');   // Bj 名不在 include 白名单 → 进 skippedByFilter
  });

  it('subtree 限定:范围外不报、不写;场景根(父=视口)与 Panel(父尺寸静态不可解)进 skippedUnresolvedParent', () => {
    const plan = planRebase(parsed, { subtree: 'Panel/MoneyLay' });
    const paths = plan.toWrite.map(e => e.path);
    // 精确集合:MoneyLay + DataImg2 + MonthNum + RuleButt + RuleMark(NoOffsetNode 无几何跳过)
    expect(paths.sort()).toEqual([
      'Panel/MoneyLay', 'Panel/MoneyLay/DataImg2', 'Panel/MoneyLay/MonthNum',
      'Panel/MoneyLay/RuleButt', 'Panel/MoneyLay/RuleButt/RuleMark',
    ].sort());
    expect(plan.skippedNoGeometry).toContain('Panel/MoneyLay/NoOffsetNode');
    // 范围外(Panel/Bj)不出现在任何名单
    const all = [...plan.toWrite.map(e => e.path), ...plan.skippedContainerChildren, ...plan.skippedByFilter, ...plan.skippedUnresolvedParent, ...plan.skippedNoGeometry];
    expect(all).not.toContain('Panel/Bj');

    const whole = planRebase(parsed);
    expect(whole.skippedUnresolvedParent).toContain('.');
    expect(whole.skippedUnresolvedParent).toContain('Panel');  // Panel 的父=锚定根,尺寸→视口依赖
  });

  it('f32 感知求解:引擎 float32 重算 === 当前边距(0 容差,含非二进值)', () => {
    const plan = planRebase(parsed);
    const margins = simulateMargins(parsed);
    const sizes = new Map<string, { w: number; h: number }>();
    // 由 margins 推父尺寸(与实现同式)
    for (const [p, m] of margins) sizes.set(p, { w: fr(m.r - m.l), h: fr(m.b - m.t) });
    for (const e of plan.toWrite) {
      const m = margins.get(e.path)!;
      const ps = sizes.get(e.path.split('/').slice(0, -1).join('/') || '.')!;
      const a = e.anchors;
      expect(recompose(a.anchor_left, ps.w, a.offset_left)).toBe(m.l);
      expect(recompose(a.anchor_top, ps.h, a.offset_top)).toBe(m.t);
      expect(recompose(a.anchor_right, ps.w, a.offset_right)).toBe(m.r);
      expect(recompose(a.anchor_bottom, ps.h, a.offset_bottom)).toBe(m.b);
    }
    // 非二进值定点:RuleButt.l 的当前边距是 float32(156.22500610351562),重算严格还原
    const rb = plan.toWrite.find(e => e.path === 'Panel/MoneyLay/RuleButt')!;
    const moneyLaySize = sizes.get('Panel/MoneyLay')!;
    expect(margins.get('Panel/MoneyLay/RuleButt')!.l).toBe(fr(156.225));
    expect(margins.get('Panel/MoneyLay/RuleButt')!.l).not.toBe(156.225);  // float32 ≠ float64 字面量(诚实锚定)
    expect(recompose(rb.anchors.anchor_left, moneyLaySize.w, rb.anchors.offset_left)).toBe(fr(156.225));
    // 二进值定点:MoneyLay 锚点未吸附(非 0/0.5/1)+ offset 补偿后位级还原 11.5
    const ml = plan.toWrite.find(e => e.path === 'Panel/MoneyLay')!;
    expect(ml.anchors.anchor_left).toBe(fr(11.5 / 758.5));
    expect([0, 0.5, 1]).not.toContain(ml.anchors.anchor_left);
  });
});

// ─── 批2 Task1:viewport 形参(一级子盲区根治,闭环批1终审 Important#1)─────────
// 语义严格限定:仅父尺寸无法从 tscn 解析(将进 skippedUnresolvedParent)且 viewport 为正
// 时以视口为父尺寸;已解析父的求解结果与不传 viewport 逐字节相同(场景③双锚)。
describe('planRebase viewport 兜底(批2 Task1)', () => {
  const parsed = parseAuthoredGeometry(FIXTURE);
  const VP = { viewport: { w: 960, h: 540 } };

  it('① 一级子(父=根)无 viewport → 进 skippedUnresolvedParent(现状锚,回归保护)', () => {
    const plan = planRebase(parsed);
    expect(plan.skippedUnresolvedParent).toContain('Panel');
    expect(plan.toWrite.map(e => e.path)).not.toContain('Panel');
  });

  it('② 同节点传 {viewport:{w:960,h:540}} → 进 toWrite,四 anchor 按视口比例、offset 浮点、f32 位级恒等', () => {
    const plan = planRebase(parsed, undefined, VP);
    const e = plan.toWrite.find(x => x.path === 'Panel')!;
    expect(plan.toWrite.some(x => x.path === 'Panel')).toBe(true);
    expect(plan.skippedUnresolvedParent).not.toContain('Panel');
    // 零锚 Panel 的当前边距 = offsets(静态已知,与父尺寸无关);引擎 float32 重算位级还原
    const ml = fr(100.75), mt = fr(36.25), mr = fr(859.25), mb = fr(529.75);
    expect(recompose(e.anchors.anchor_left, 960, e.anchors.offset_left)).toBe(ml);
    expect(recompose(e.anchors.anchor_top, 540, e.anchors.offset_top)).toBe(mt);
    expect(recompose(e.anchors.anchor_right, 960, e.anchors.offset_right)).toBe(mr);
    expect(recompose(e.anchors.anchor_bottom, 540, e.anchors.offset_bottom)).toBe(mb);
    // anchor 按视口比例求解(均不在 0/0.5/1 吸附邻域 → 保持精确比率值)
    expect(e.anchors.anchor_left).toBeCloseTo(100.75 / 960, 7);
    expect(e.anchors.anchor_bottom).toBeCloseTo(529.75 / 540, 7);
    // 非零锚场景根('.')自身无静态边距(锚定视口,目标边距运行时才定)→ viewport 也救不了,
    // 仍诚实 skip(与一级子可解形成对照:兜底只对边距静态已知的节点生效)
    expect(plan.skippedUnresolvedParent).toContain('.');
  });

  it('③ 已解析父节点(Bj/MoneyLay 形态)传 viewport → 求解结果与不传逐字节相同(双锚)', () => {
    // subtree 版:范围内全部节点父尺寸可解,全集逐字节对照
    const noSub = planRebase(parsed, { subtree: 'Panel/MoneyLay' });
    const vpSub = planRebase(parsed, { subtree: 'Panel/MoneyLay' }, VP);
    expect(JSON.stringify(vpSub.toWrite)).toBe(JSON.stringify(noSub.toWrite));
    expect(JSON.stringify(vpSub.skippedUnresolvedParent)).toBe(JSON.stringify(noSub.skippedUnresolvedParent));
    // 整树版:对照集(不传时已可解的路径)条目逐字节相同;viewport 只新增 Panel 兜底条目
    const noWhole = planRebase(parsed);
    const vpWhole = planRebase(parsed, undefined, VP);
    const noBy = new Map(noWhole.toWrite.map(e => [e.path, e]));
    for (const e of vpWhole.toWrite) {
      const a = noBy.get(e.path);
      if (a) expect(JSON.stringify(e), `已解析父条目逐字节相同: ${e.path}`).toBe(JSON.stringify(a));
    }
    expect(vpWhole.toWrite.map(e => e.path)).toContain('Panel');
    expect(noWhole.toWrite.map(e => e.path)).not.toContain('Panel');
    // 审查 Important ③:viewport 只新增一级子兜底条目,不增删其他(深层链断不兜底)
    expect(vpWhole.toWrite.length).toBe(noWhole.toWrite.length + 1);
  });

  it('审查 Important 收紧:深层链断零锚孙层不被 viewport 兜底(真实父尺寸≠视口,写盘即偏移)', () => {
    // 链断形态:非零锚根 → 非零锚一级子(锚定根,边距运行时才定)→ 零锚孙层(边距=offset
    // 静态已知,但父尺寸不可解)。孙层若被以视口兜底求解,写盘后引擎按真实父尺寸 P 重算
    // a×P+o ≠ 目标边距——写盘即偏移,且错误条目与正常条目在 toWrite 中不可区分。
    const chainBroken = parseAuthoredGeometry(`[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="AnchoredChild" type="Control" parent="."]
anchor_right = 1.0
anchor_bottom = 1.0
offset_left = 20.0
offset_top = 10.0

[node name="DeepZero" type="Control" parent="AnchoredChild"]
offset_left = 50.0
offset_top = 30.0
offset_right = 150.0
offset_bottom = 80.0
`);
    const plan = planRebase(chainBroken, undefined, VP);
    // 非零锚一级子:根形态但无静态目标边距(margins 无值)→ 诚实 skip
    expect(plan.skippedUnresolvedParent).toContain('AnchoredChild');
    // 零锚孙层:有静态边距但父≠根形态(真实父=AnchoredChild,尺寸≠视口)→ 不兜底,诚实 skip
    expect(plan.skippedUnresolvedParent).toContain('AnchoredChild/DeepZero');
    expect(plan.toWrite).toEqual([]);   // 全员诚实 skip,不产出几何错误的写盘计划
  });
});

// ─── 反馈 2026-11-18:全锚继承中间层按 viewport 推导 ────────────────────────────
// 根无布局行 + 一级子全锚(0,1,0,1)零 offset 形态:simulate 按零锚给根写入真值的 0×0 尺寸
// 条目,该子节点边距被算成 {0,0,0,0} 进 margins → planRebase ⑤ 以视口求解出全零锚点并
// 落盘(静默错写),其子(真实尺寸≠0)进 skip。继承规则:该形态在根尺寸不可解/非正且
// viewport 为正时以 viewport 作父尺寸(边距 {0,0,W,H}),子树随之可解。
describe('全锚继承中间层按 viewport 推导(反馈 2026-11-18)', () => {
  const INHERIT = parseAuthoredGeometry(`[gd_scene format=3]

[node name="HeroDetailContent" type="Control"]

[node name="BaseLayer" type="Control" parent="."]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Bg" type="Panel" parent="BaseLayer"]
offset_left = 10.0
offset_top = 20.0
offset_right = 790.0
offset_bottom = 460.0
`);
  const VP = { viewport: { w: 800, h: 480 } };

  it('传 viewport → Bg 进 toWrite 且 float32 位级还原目标边距; BaseLayer 不得被写成全零锚(改动前现状即如此)', () => {
    const plan = planRebase(INHERIT, undefined, VP);
    expect(plan.skippedUnresolvedParent).toEqual([]);
    const base = plan.toWrite.find((e) => e.path === 'BaseLayer')!;
    expect(base.anchors).toEqual({ anchor_left: 0, anchor_right: 1, anchor_top: 0, anchor_bottom: 1, offset_left: 0, offset_right: 0, offset_top: 0, offset_bottom: 0 });
    const bg = plan.toWrite.find((e) => e.path === 'BaseLayer/Bg')!;
    const restore = (a: number, o: number, p: number) => fr(fr(a * p) + o);
    expect(restore(bg.anchors.anchor_left, bg.anchors.offset_left, 800)).toBe(10);
    expect(restore(bg.anchors.anchor_top, bg.anchors.offset_top, 480)).toBe(20);
    expect(restore(bg.anchors.anchor_right, bg.anchors.offset_right, 800)).toBe(790);
    expect(restore(bg.anchors.anchor_bottom, bg.anchors.offset_bottom, 480)).toBe(460);
  });

  it('不传 viewport → 与改动前相同: BaseLayer 与 Bg 均诚实 skip', () => {
    const plan = planRebase(INHERIT);
    expect(plan.skippedUnresolvedParent).toEqual(['BaseLayer', 'BaseLayer/Bg']);
    expect(plan.toWrite).toEqual([]);
  });

  // 审查前修订:继承只对「根 offsets 全 0 且 anchors 全 0 或全锚」生效——两类根:①未授权自身
  // 尺寸(无布局行 / 显式 0×0 行,构造尺寸 0×0:viewport 是调用方对根运行时尺寸的断言,不等于时
  // 子树偏移,见 anchor-rebase.ts 头注暴露面);②构造尺寸即视口(全锚零 offset)。「父尺寸不可解/
  // 非正」只是必要条件:根自身内缩锚定时它也成立,据此继承会把诚实 skip 变成会偏移的写盘计划
  // (真实根尺寸 ≠ viewport,以视口求解子树写盘即偏移,计划 Review Focus 第 4 条)。
  const page = (root: string) => parseAuthoredGeometry(`[gd_scene format=3]

[node name="Root" type="Control"]
${root}
[node name="BaseLayer" type="Control" parent="."]
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Bg" type="Panel" parent="BaseLayer"]
offset_left = 10.0
offset_top = 20.0
offset_right = 790.0
offset_bottom = 460.0
`);
  const ROOT_FORMS: Array<[string, string, boolean]> = [
    ['根自身内缩锚 0.1..0.9', 'anchor_left = 0.1\nanchor_top = 0.1\nanchor_right = 0.9\nanchor_bottom = 0.9\n', false],
    ['根全锚带非零 offset(四边 10)', 'anchors_preset = 15\noffset_left = 10.0\noffset_top = 10.0\noffset_right = 10.0\noffset_bottom = 10.0\n', false],
    ['根全锚且 offsets 全 0', 'anchors_preset = 15\n', true],
    ['根显式 0×0 offset 行', 'offset_right = 0.0\noffset_bottom = 0.0\n', true],
  ];
  for (const [label, root, inherit] of ROOT_FORMS) {
    it(`根形态「${label}」: 继承=${inherit}(传 viewport)`, () => {
      const plan = planRebase(page(root), undefined, VP);
      const written = plan.toWrite.map((e) => e.path);
      if (inherit) {
        expect(written).toEqual(expect.arrayContaining(['BaseLayer', 'BaseLayer/Bg']));
        expect(plan.skippedUnresolvedParent).not.toContain('BaseLayer');
        expect(plan.skippedUnresolvedParent).not.toContain('BaseLayer/Bg');
      } else {
        // 与改动前相同:全锚一级子与其子均诚实 skip,不产出写盘计划
        expect(plan.skippedUnresolvedParent).toEqual(expect.arrayContaining(['BaseLayer', 'BaseLayer/Bg']));
        expect(written).toEqual([]);
      }
    });
  }
});

describe('applyRebasePatch', () => {
  const parsed = parseAuthoredGeometry(FIXTURE);
  const plan = planRebase(parsed, { subtree: 'Panel/MoneyLay' });
  const patched = applyRebasePatch(FIXTURE, plan.toWrite);

  it('写后保留全部注释行与段外字节(靶子靠 tscn 注释记审计线索)', () => {
    const beforeComments = FIXTURE.split('\n').filter(l => l.trim().startsWith(';'));
    const afterComments = patched.text.split('\n').filter(l => l.trim().startsWith(';'));
    expect(afterComments).toEqual(beforeComments);
    // 未被改造的段逐字节不变(Panel 段不在 subtree)
    const panelBefore = FIXTURE.split('[node name="Panel"')[1]!.split('[node')[0];
    const panelAfter = patched.text.split('[node name="Panel"')[1]!.split('[node')[0];
    expect(panelAfter).toBe(panelBefore);
  });

  it('目标节点段出现 layout_mode = 1 + 四 anchor + 四 offset 浮点字面量;其他属性行保留', () => {
    expect(patched.patched).toBe(plan.toWrite.length);
    const mlSec = patched.text.split('[node name="MoneyLay"')[1]!.split('[node')[0];
    expect(mlSec).toContain('layout_mode = 1');
    expect(mlSec).toContain('anchor_left = ');
    expect(mlSec).toContain('anchor_bottom = ');
    expect(mlSec).toContain('offset_left = ');
    expect(mlSec).toContain('offset_bottom = ');
    expect(mlSec).toContain('unique_name_in_owner = true');   // 非布局属性行保留
    expect(mlSec).toContain('mouse_filter = 2');
    expect(mlSec).not.toMatch(/layout_mode = 0/);
    // 旧 offset 行被替换(仅出现一次 offset_left)
    expect(mlSec.match(/offset_left = /g)).toHaveLength(1);
    // 浮点字面量形态:整数值带 .0
    expect(mlSec).toMatch(/anchor_\w+ = \d+\.\d+/);
  });

  it('0 容差闭环(TS 侧):patch 后授权几何的 float32 边距模拟与 patch 前逐值 ===', () => {
    const simBefore = simulateMargins(parseAuthoredGeometry(FIXTURE));
    const simAfter = simulateMargins(parseAuthoredGeometry(patched.text));
    expect(simAfter.size).toBe(simBefore.size);
    for (const [path, m] of simBefore) {
      const a = simAfter.get(path);
      expect(simAfter.has(path), `patch 后边距缺失: ${path}`).toBe(true);
      expect(a!.l).toBe(m.l);
      expect(a!.t).toBe(m.t);
      expect(a!.r).toBe(m.r);
      expect(a!.b).toBe(m.b);
    }
  });

  it('CRLF 场景:换行风格保持(段内新增行跟随 \r)', () => {
    const crlfText = FIXTURE.replace(/\n/g, '\r\n');
    const p2 = applyRebasePatch(crlfText, plan.toWrite);
    // 新增行携带 \r(\r\n 连接保持,不混入裸 \n 行)
    expect(p2.text.includes('layout_mode = 1\r')).toBe(true);
    expect(p2.text.split('\n').every(l => !l.startsWith('layout_mode') || l.endsWith('\r'))).toBe(true);
    // patch 后文本无孤立 \r\n 之外的行尾风格分裂:重 parse 边距模拟仍恒等
    const simBefore = simulateMargins(parseAuthoredGeometry(crlfText));
    const simAfter = simulateMargins(parseAuthoredGeometry(p2.text));
    for (const [path, m] of simBefore) {
      expect(simAfter.get(path)!.l).toBe(m.l);
    }
  });
});

// ─── handler(MCP action:solve_from_current)──────────────────────────────────

describe('solve_from_current handler', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-rebase-'));
    writeFileSync(join(dir, 'main.tscn'), FIXTURE, 'utf-8');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  function ctx(): ToolContext { return {} as ToolContext; }

  function parseBody(r: ToolResult | null) {
    expect(r !== null && !r.isError).toBe(true);
    return JSON.parse((r!.content?.[0] as { text?: string }).text ?? '{}') as {
      success: boolean;
      data: {
        dry_run: boolean; written?: number;
        toWrite: Array<{ path: string }>;
        skippedContainerChildren: string[];
        skippedByFilter: string[];
        skippedUnresolvedParent: string[];
        skippedNoGeometry: string[];
      };
    };
  }

  it('dry_run 默认 true:只返回计划不写盘', async () => {
    const before = readFileSync(join(dir, 'main.tscn'), 'utf-8');
    const body = parseBody(await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      node_path: '/root/Panel/MoneyLay',
    }, ctx()));
    expect(body.success).toBe(true);
    expect(body.data.dry_run).toBe(true);
    expect(body.data.toWrite.map(e => e.path)).toContain('Panel/MoneyLay');
    expect(readFileSync(join(dir, 'main.tscn'), 'utf-8')).toBe(before);  // 盘未动
  });

  it('dry_run=false:写盘 + 注释保留 + MoneyLay 段 layout_mode=1', async () => {
    const body = parseBody(await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      node_path: '/root/Panel/MoneyLay', dry_run: false,
    }, ctx()));
    expect(body.data.dry_run).toBe(false);
    expect(body.data.written).toBe(5);
    const after = readFileSync(join(dir, 'main.tscn'), 'utf-8');
    expect(after).toContain('; ── money_lay 源:225×64 @(11.5,421)cocos → (11.5,8.5) ──');
    expect(after.split('[node name="MoneyLay"')[1]!.split('[node')[0]).toContain('layout_mode = 1');
    // 还原供后续用例
    writeFileSync(join(dir, 'main.tscn'), FIXTURE, 'utf-8');
  });

  it('scene_path 穿越/非 res:// 形态 → INVALID_PARAMS', async () => {
    for (const bad of ['res://../evil.tscn', 'main.tscn', '']) {
      const r = await handleTool('ui', {
        action: 'solve_from_current', project_path: dir, scene_path: bad,
      }, ctx());
      expect(r?.isError).toBe(true);
      expect((r!.content?.[0] as { text?: string }).text).toContain('INVALID_PARAMS');
    }
  });

  it('include/exclude 节点名白名单(^[A-Za-z_][A-Za-z0-9_]*$)→ 非法名拒', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      include: ['bad name!'],
    }, ctx());
    expect(r?.isError).toBe(true);
    const r2 = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      exclude: ['x;rm'],
    }, ctx());
    expect(r2?.isError).toBe(true);
  });

  it('node_path 不存在 → NODE_NOT_FOUND', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      node_path: '/root/Panel/Nope',
    }, ctx());
    expect(r?.isError).toBe(true);
    expect((r!.content?.[0] as { text?: string }).text).toContain('NODE_NOT_FOUND');
  });

  it('缺 scene_path → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir,
    }, ctx());
    expect(r?.isError).toBe(true);
  });

  it('viewport 形参:正整数透传生效(一级子 Panel 兜底进 toWrite);非正整数/非整数拒(批2 Task1)', async () => {
    // dry_run 默认 true——只出计划不写盘
    const body = parseBody(await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      viewport: { w: 960, h: 540 },
    }, ctx()));
    expect(body.success).toBe(true);
    expect(body.data.toWrite.map(e => e.path)).toContain('Panel');
    expect(body.data.skippedUnresolvedParent).not.toContain('Panel');

    for (const bad of [{ w: 0, h: 540 }, { w: 960, h: 1.5 }, { w: -1, h: 540 }]) {
      const r = await handleTool('ui', {
        action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
        viewport: bad,
      }, ctx());
      expect(r?.isError).toBe(true);
      expect((r!.content?.[0] as { text?: string }).text).toContain('INVALID_PARAMS');
    }
  });
});

// ─── Step 9:靶子 e2e(0 容差闭环,批1 验收 3 预演;双 skipIf)──────────────────
// 临时副本场景验证写盘——不动靶子原文件(真改造是 Task 7 手工验收的事)。

const GODOT_PATH = process.env.GODOT_PATH || '';
const TARGET_PROJECT = 'D:/workspace/projects/DotaLegendGodot';
const hasE2e = GODOT_PATH !== '' && existsSync(GODOT_PATH) && existsSync(TARGET_PROJECT);

describe.skipIf(!hasE2e)('solve_from_current 靶子 e2e(0 容差闭环)', () => {
  const SRC = join(TARGET_PROJECT, 'scenes/ui/daily_login_content.tscn');
  const COPY_ABS = join(TARGET_PROJECT, 'scenes/ui/_solve_from_current_e2e_copy.tscn');

  async function measure(): Promise<MeasuredNode[]> {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH, projectPath: TARGET_PROJECT, timeout: 60, loadAutoloads: false,
      code: genUiMeasureScript(COPY_ABS, undefined, 16, undefined, { themePath: 'res://resources/themes/default_theme.tres' }),
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    const raw = res.outputs.find(o => o.key === 'measure');
    expect(res.outputs.some(o => o.key === 'measure'), 'measure 输出存在').toBe(true);
    return (JSON.parse(String(raw!.value)) as { nodes: MeasuredNode[] }).nodes;
  }

  it('基线→dry_run=false 改造→复测:compareBaseline ok===true + TS 边距模拟恒等 + 注释保留(靶子改造后两态自适应)', async () => {
    copyFileSync(SRC, COPY_ABS);
    try {
      const textBefore = readFileSync(COPY_ABS, 'utf-8');
      // 批1 Task7 验收(2026-11-17)后靶子可能已整体锚点化,且去留由用户裁决——工作区
      // 「改造前/改造后」两态皆合法。改造后 Panel 比例锚定于视口,授权几何链在 Panel 处
      // 不可解 → MoneyLay 子树全员进 skippedUnresolvedParent、written=0 不动盘——这是
      // anchor-rebase.ts 头注边界的真数据回归锚(工具对已改造场景的诚实拒绝);改造前
      // 状态走原 0 容差闭环主链。验收证据:docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md。
      const panelRebased = /layout_mode = 1/.test(textBefore.split('[node name="Panel"')[1]!.split('[node')[0]);
      const baseline = await measure();

      // 交叉验证:授权几何的 float32 模拟与引擎实测一致(dyadic 链节点抽检;两态下引擎
      // rect 相同——改造保 g960 位级不变)
      const di = baseline.find(n => n.path === 'Panel/MoneyLay/DataImg2')!;
      expect(baseline.some(n => n.path === 'Panel/MoneyLay/DataImg2')).toBe(true);
      expect(di.rect.x).toBe(112.25 + 8.5);   // Panel.global.x 100.75 + MoneyLay 11.5 + DataImg2 8.5
      expect(di.rect.y).toBe(36.25 + 8.5 + 3.5);

      const r = await handleTool('ui', {
        action: 'solve_from_current', project_path: TARGET_PROJECT,
        scene_path: 'res://scenes/ui/_solve_from_current_e2e_copy.tscn',
        node_path: '/root/Panel/MoneyLay', dry_run: false,
      }, {} as ToolContext);
      expect(r?.isError).toBeFalsy();
      const body = JSON.parse((r!.content?.[0] as { text?: string }).text ?? '{}') as {
        success: boolean; data: {
          dry_run: boolean; written: number;
          toWrite: Array<{ path: string }>; skippedUnresolvedParent: string[];
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.dry_run).toBe(false);
      if (panelRebased) {
        expect(body.data.written).toBe(0);
        expect(body.data.toWrite).toEqual([]);
        expect(body.data.skippedUnresolvedParent).toContain('Panel/MoneyLay');
        expect(readFileSync(COPY_ABS, 'utf-8')).toBe(textBefore);   // written=0 盘未动
        return;
      }
      expect(body.data.written).toBe(6);   // MoneyLay + DataImg2 + MonthNum + LoginMonthLabel + RuleButt + RuleMark

      const after = await measure();
      const cmp = compareBaseline(after, baseline);
      expect(cmp.ok, `0 容差失败 mismatches=${JSON.stringify(cmp.mismatches.slice(0, 6))}`).toBe(true);

      // TS 侧 0 容差:patch 前后 float32 边距模拟逐值 ===
      const simBefore = simulateMargins(parseAuthoredGeometry(textBefore));
      const simAfter = simulateMargins(parseAuthoredGeometry(readFileSync(COPY_ABS, 'utf-8')));
      expect(simAfter.size).toBe(simBefore.size);
      for (const [path, m] of simBefore) {
        const a = simAfter.get(path);
        expect(simAfter.has(path), `patch 后边距缺失: ${path}`).toBe(true);
        expect(a!.l).toBe(m.l);
        expect(a!.t).toBe(m.t);
        expect(a!.r).toBe(m.r);
        expect(a!.b).toBe(m.b);
      }

      // 注释保留(靶子审计线索;真实靶子用全角冒号)+ 靶子原文件未动
      const patchedText = readFileSync(COPY_ABS, 'utf-8');
      expect(patchedText).toContain('── money_lay 源：225×64 @(11.5,421)cocos → (11.5,8.5) ──');
      expect(patchedText.split('[node name="MoneyLay"')[1]!.split('[node')[0]).toContain('layout_mode = 1');
      expect(readFileSync(SRC, 'utf-8')).toBe(textBefore);
    } finally {
      rmSync(COPY_ABS, { force: true });
    }
  }, 300_000);
});
