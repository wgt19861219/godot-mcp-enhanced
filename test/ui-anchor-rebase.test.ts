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
    expect(ml).toBeDefined();
    expect(ml.type).toBe('Control');
    expect(ml.parentPath).toBe('Panel');
    expect(ml.parentType).toBe('Control');
    expect(ml.offsets).toEqual({ left: 11.5, top: 8.5, right: 236.5, bottom: 72.5 });
    expect(ml.anchors).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(ml.name).toBe('MoneyLay');
  });

  it('场景根 path="." 无父;Panel 一级路径正确', () => {
    const root = byPath.get('.')!;
    expect(root).toBeDefined();
    expect(root.parentPath).toBe('');
    expect(root.parentType).toBe('');
    expect(root.anchors).toEqual({ left: 0, right: 1, top: 0, bottom: 1 });  // preset 15 + 显式行
    expect(byPath.get('Panel')!.parentPath).toBe('.');
    expect(byPath.get('Panel')!.tscnParent).toBe('.');
  });

  it('变体①:无任何 offset 行的节点 → 全缺省 0(Review Focus 5)', () => {
    const n = byPath.get('Panel/MoneyLay/NoOffsetNode')!;
    expect(n).toBeDefined();
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
    expect(n).toBeDefined();
    expect(n.offsets).toEqual({ left: 43.75, top: 8.25, right: 90.25, bottom: 44.75 });
    // 交错 ext_resource 后的深层节点也在(RuleMark)
    expect(byPath.get('Panel/MoneyLay/RuleButt/RuleMark')).toBeDefined();
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
      expect(node, `preset ${n} 节点已解析`).toBeDefined();
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
    expect(n).toBeDefined();
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
      expect(a, `patch 后边距缺失: ${path}`).toBeDefined();
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
    expect(r).not.toBeNull();
    expect(r!.isError).toBeFalsy();
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
      expect(r?.isError).toBeTruthy();
      expect((r!.content?.[0] as { text?: string }).text).toContain('INVALID_PARAMS');
    }
  });

  it('include/exclude 节点名白名单(^[A-Za-z_][A-Za-z0-9_]*$)→ 非法名拒', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      include: ['bad name!'],
    }, ctx());
    expect(r?.isError).toBeTruthy();
    const r2 = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      exclude: ['x;rm'],
    }, ctx());
    expect(r2?.isError).toBeTruthy();
  });

  it('node_path 不存在 → NODE_NOT_FOUND', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      node_path: '/root/Panel/Nope',
    }, ctx());
    expect(r?.isError).toBeTruthy();
    expect((r!.content?.[0] as { text?: string }).text).toContain('NODE_NOT_FOUND');
  });

  it('缺 scene_path → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', {
      action: 'solve_from_current', project_path: dir,
    }, ctx());
    expect(r?.isError).toBeTruthy();
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
    expect(raw, 'measure 输出存在').toBeDefined();
    return (JSON.parse(String(raw!.value)) as { nodes: MeasuredNode[] }).nodes;
  }

  it('基线→dry_run=false 改造→复测:compareBaseline ok===true + TS 边距模拟恒等 + 注释保留', async () => {
    copyFileSync(SRC, COPY_ABS);
    try {
      const textBefore = readFileSync(COPY_ABS, 'utf-8');
      const baseline = await measure();

      // 交叉验证:授权几何的 float32 模拟与引擎实测一致(dyadic 链节点抽检)
      const di = baseline.find(n => n.path === 'Panel/MoneyLay/DataImg2')!;
      expect(di).toBeDefined();
      expect(di.rect.x).toBe(112.25 + 8.5);   // Panel.global.x 100.75 + MoneyLay 11.5 + DataImg2 8.5
      expect(di.rect.y).toBe(36.25 + 8.5 + 3.5);

      const r = await handleTool('ui', {
        action: 'solve_from_current', project_path: TARGET_PROJECT,
        scene_path: 'res://scenes/ui/_solve_from_current_e2e_copy.tscn',
        node_path: '/root/Panel/MoneyLay', dry_run: false,
      }, {} as ToolContext);
      expect(r?.isError).toBeFalsy();
      const body = JSON.parse((r!.content?.[0] as { text?: string }).text ?? '{}') as {
        success: boolean; data: { dry_run: boolean; written: number };
      };
      expect(body.success).toBe(true);
      expect(body.data.dry_run).toBe(false);
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
        expect(a, `patch 后边距缺失: ${path}`).toBeDefined();
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
