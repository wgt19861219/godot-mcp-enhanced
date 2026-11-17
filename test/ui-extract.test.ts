// test/ui-extract.test.ts
// 批4 Task 3 单测:extract_tree 生成器(genExtractTreeScript/genDraftSaveScript)+
// 聚类纯函数(extractTreeReport)+ handler 前置校验。e2e(GODOT_PATH 门控)在同文件末段。
// 顺序锚纪律(v1 审查 B3):GD 无 override-only getter——`get_theme_stylebox(` 必须出现且
// 在 `has_theme_stylebox_override(` 之后,测试用 indexOf 顺序断言,不写"不含"锚。
import { describe, it, expect } from 'vitest';
import {
  genExtractTreeScript,
  genDraftSaveScript,
  extractTreeReport,
} from '../src/tools/ui/ui-extract.js';
import type { ExtractScanNode, StyleReading } from '../src/tools/ui/ui-extract.js';
import { ACTIONS, TOOL_META } from '../src/tools/ui-tools.js';
import { handleTool } from '../src/tools/ui/index.js';
import type { ToolContext, ToolResult } from '../src/types.js';

// ─── genExtractTreeScript ───────────────────────────────────────────────────

describe('genExtractTreeScript(批4 Task 3)', () => {
  it('顺序锚: has_theme_stylebox_override 出现且在 get_theme_stylebox( 之前(override-only getter 无 GD 版,B3 纪律)', () => {
    const script = genExtractTreeScript('/scene.tscn', undefined, 16);
    const idxHas = script.indexOf('has_theme_stylebox_override');
    const idxGet = script.indexOf('get_theme_stylebox(');
    expect(idxHas).toBeGreaterThanOrEqual(0);
    expect(idxGet).toBeGreaterThanOrEqual(0);
    expect(idxHas).toBeLessThan(idxGet);
  });

  it('font_size 门控: has_theme_font_size_override("font_size") → get_theme_font_size', () => {
    const script = genExtractTreeScript('/scene.tscn', undefined, 16);
    expect(script).toContain('has_theme_font_size_override("font_size")');
    expect(script).toContain('get_theme_font_size("font_size")');
  });

  it('font_color 门控: has_theme_color_override("font_color") → get_theme_color(Color 转数组)', () => {
    const script = genExtractTreeScript('/scene.tscn', undefined, 16);
    expect(script).toContain('has_theme_color_override("font_color")');
    expect(script).toContain('get_theme_color("font_color")');
  });

  it('输出键 extract_scan + _mcp_load_scene + _all_slots 全槽扫描', () => {
    const script = genExtractTreeScript('/scene.tscn', undefined, 16);
    expect(script).toContain('_mcp_load_scene');
    expect(script).toContain('_mcp_output("extract_scan"');
    expect(script).toContain('"panel"');
    expect(script).toContain('"disabled"');
  });

  it('maxDepth 数字内插(clamp 语义由调用方,生成器只接数)', () => {
    const script = genExtractTreeScript('/scene.tscn', undefined, 24);
    expect(script).toContain('depth > 24');
  });

  it('nodePath 可选: 传入时含 _mcp_get_scene_node 调用(header 函数定义恒在,断言调用形态)', () => {
    const withNode = genExtractTreeScript('/scene.tscn', '/root/Main/Sub', 16);
    expect(withNode).toContain('_mcp_get_scene_node("');
    const without = genExtractTreeScript('/scene.tscn', undefined, 16);
    expect(without).not.toContain('_mcp_get_scene_node("');
  });
});

// ─── genDraftSaveScript ─────────────────────────────────────────────────────

describe('genDraftSaveScript(批4 Task 3)', () => {
  it('含 StyleBoxFlat.new()/逐字段 set/set_stylebox/DesignTokens/原子落盘三件套', () => {
    const draft = {
      styleboxes: [{
        type: 'Panel', slot: 'panel' as const,
        spec: { bg_color: [0.25, 0.5, 0.75, 1], corner_radius: 4, border_width: 2, border_color: [1, 1, 1, 1], draw_center: true },
        token: 'style_panel_4080bf',
      }],
      colors: [{ name: 'style_panel_4080bf', value: [0.25, 0.5, 0.75, 1] }],
      constants: [{ name: 'font_size_20', value: 20 }],
    };
    const script = genDraftSaveScript('res://themes/draft.tres', draft);
    expect(script).toContain('StyleBoxFlat.new()');
    expect(script).toContain('_theme.set_stylebox');
    expect(script).toContain('"DesignTokens"');
    expect(script).toContain('_theme.set_color');
    expect(script).toContain('_theme.set_constant');
    expect(script).toContain('ResourceSaver.save');
    expect(script).toContain('DirAccess.rename_absolute');
    expect(script).toContain('_mcp_output("draft_saved"');
  });

  it('草稿 JSON 内嵌经 JSON.parse_string(genStyleExpectInit 先例,防裸拼 GD 字面量)', () => {
    const draft = {
      styleboxes: [],
      colors: [{ name: 'text_ff8040', value: [1, 0.5, 0.25, 1] }],
      constants: [],
    };
    const script = genDraftSaveScript('res://themes/draft.tres', draft);
    expect(script).toContain('JSON.parse_string');
    expect(script).toContain('text_ff8040');
  });
});

// ─── extractTreeReport(聚类纯函数)───────────────────────────────────────────

/** 读数构造 helper:flat StyleBoxFlat 读回形态(bg/corner/border 全 dict 四组字段)。 */
function reading(slot: string, bg: [number, number, number, number], extra: Partial<StyleReading> = {}): StyleReading {
  return {
    slot, flat: true, bg_color: bg,
    corner_radius: { tl: 0, tr: 0, br: 0, bl: 0 },
    border_width: { left: 0, top: 0, right: 0, bottom: 0 },
    border_color: [0, 0, 0, 1],
    draw_center: true,
    ...extra,
  };
}

describe('extractTreeReport(批4 Task 3 聚类)', () => {
  const BG_AB: [number, number, number, number] = [0.25, 0.5, 0.75, 1];
  const BG_C: [number, number, number, number] = [0.125, 0.125, 0.125, 1];

  it('① 同/异 spec 分组: A/B 同 bg 一组(count 2,nodes 含 A/B),C 异 bg 独立组;count 降序', () => {
    const scan: ExtractScanNode[] = [
      { path: 'PanelA', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'PanelB', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'PanelC', type: 'Panel', styles: [reading('panel', BG_C)] },
    ];
    const { report } = extractTreeReport(scan);
    expect(report.stylebox_groups).toHaveLength(2);
    const [g0, g1] = report.stylebox_groups;
    expect(g0.count).toBe(2);
    expect(g0.nodes).toEqual(['PanelA', 'PanelB']);
    expect(g0.slots).toEqual(['panel']);
    expect(g0.spec.bg_color).toEqual(BG_AB);
    expect(g1.count).toBe(1);
    expect(g1.nodes).toEqual(['PanelC']);
  });

  it('①b 精确匹配: corner/border 数值差异即异组', () => {
    const scan: ExtractScanNode[] = [
      { path: 'PanelA', type: 'Panel', styles: [reading('panel', BG_AB, { corner_radius: { tl: 4, tr: 4, br: 4, bl: 4 } })] },
      { path: 'PanelB', type: 'Panel', styles: [reading('panel', BG_AB, { corner_radius: { tl: 8, tr: 8, br: 8, bl: 8 } })] },
    ];
    const { report } = extractTreeReport(scan);
    expect(report.stylebox_groups).toHaveLength(2);
  });

  it('③ suggested_token: style_<最高频slot>_<rrggbb>', () => {
    const scan: ExtractScanNode[] = [
      { path: 'PanelA', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'PanelB', type: 'Panel', styles: [reading('panel', BG_AB)] },
    ];
    const { report } = extractTreeReport(scan);
    // 0.25*255→64(0x40) / 0.5*255→128(0x80) / 0.75*255→191(0xbf)
    expect(report.stylebox_groups[0].suggested_token).toBe('style_panel_4080bf');
  });

  it('② font_size 组 + suggested_token font_size_<n>', () => {
    const scan: ExtractScanNode[] = [
      { path: 'LabelD', type: 'Label', font_size: 20 },
      { path: 'LabelF', type: 'Label', font_size: 20 },
      { path: 'LabelG', type: 'Label', font_size: 16 },
    ];
    const { report } = extractTreeReport(scan);
    expect(report.font_size_groups).toHaveLength(2);
    const g20 = report.font_size_groups.find(g => g.value === 20);
    expect(g20!.count).toBe(2);
    expect(g20!.nodes).toEqual(['LabelD', 'LabelF']);
    expect(g20!.suggested_token).toBe('font_size_20');
  });

  it('③ font_color 组 + suggested_token text_<rrggbb>', () => {
    const scan: ExtractScanNode[] = [
      { path: 'LabelD', type: 'Label', font_color: [1, 0.5, 0.25, 1] },
    ];
    const { report } = extractTreeReport(scan);
    expect(report.font_color_groups).toHaveLength(1);
    expect(report.font_color_groups[0].suggested_token).toBe('text_ff8040');
    expect(report.font_color_groups[0].value).toEqual([1, 0.5, 0.25, 1]);
  });

  it('④ draft 槽位选举: Panel 两同 spec(count 2)>一异 spec(count 1);Button 独立选举', () => {
    const scan: ExtractScanNode[] = [
      { path: 'PanelA', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'PanelB', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'PanelC', type: 'Panel', styles: [reading('panel', BG_C)] },
      { path: 'BtnA', type: 'Button', styles: [reading('normal', [1, 0, 0, 1])] },
    ];
    const { draft } = extractTreeReport(scan);
    expect(draft).not.toBeNull();
    const panelEntry = draft!.styleboxes.find(s => s.type === 'Panel');
    expect(panelEntry!.spec.bg_color).toEqual(BG_AB);
    expect(panelEntry!.slot).toBe('panel');
    const buttonEntry = draft!.styleboxes.find(s => s.type === 'Button');
    expect(buttonEntry!.spec.bg_color).toEqual([1, 0, 0, 1]);
    expect(buttonEntry!.slot).toBe('normal');
  });

  it('④b draft token 组: stylebox bg 进 colors,font_color 组进 colors(text_*),font_size 组进 constants', () => {
    const scan: ExtractScanNode[] = [
      { path: 'PanelA', type: 'Panel', styles: [reading('panel', BG_AB)] },
      { path: 'LabelD', type: 'Label', font_size: 20, font_color: [1, 0.5, 0.25, 1] },
    ];
    const { draft } = extractTreeReport(scan);
    const colorNames = draft!.colors.map(c => c.name);
    expect(colorNames).toContain('style_panel_4080bf');
    expect(colorNames).toContain('text_ff8040');
    expect(draft!.constants).toEqual([{ name: 'font_size_20', value: 20 }]);
  });

  it('⑤ 空扫描 → draft null + notes 一行说明(Review Focus 4)', () => {
    const { report, draft, notes } = extractTreeReport([]);
    expect(report.stylebox_groups).toEqual([]);
    expect(report.font_size_groups).toEqual([]);
    expect(report.font_color_groups).toEqual([]);
    expect(draft).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('未生成草稿');
  });

  it('⑥ 不可映射类型(TextureRect 带 override)→ 报告含组、draft 跳过 + notes 点名类型', () => {
    const scan: ExtractScanNode[] = [
      { path: 'Icon', type: 'TextureRect', styles: [reading('normal', BG_AB)] },
    ];
    const { report, draft, notes } = extractTreeReport(scan);
    expect(report.stylebox_groups).toHaveLength(1);
    expect(draft).toBeNull();
    expect(notes.join('\n')).toContain('TextureRect');
  });

  it('⑥b 非 StyleBoxFlat override 读数跳过聚类 + notes 说明(诚实,不静默)', () => {
    const scan: ExtractScanNode[] = [
      { path: 'P', type: 'Panel', styles: [{ slot: 'panel', flat: false }] },
    ];
    const { report, notes } = extractTreeReport(scan);
    expect(report.stylebox_groups).toEqual([]);
    expect(notes.join('\n')).toContain('StyleBoxFlat');
  });
});

// ─── handler 前置校验 + 契约 ────────────────────────────────────────────────

describe('extract_tree handler 前置校验(批4 Task 3)', () => {
  const fakeCtx = { findGodot: async () => '/fake/godot' } as unknown as ToolContext;

  async function run(actionArgs: Record<string, unknown>): Promise<ToolResult> {
    return await handleTool('ui', { action: 'extract_tree', project_path: '/fake/p', ...actionArgs }, fakeCtx) as ToolResult;
  }

  it('缺 scene_path → INVALID_PARAMS(spawn 前拒绝)', async () => {
    const r = await run({});
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('scene_path');
  });

  it("draft_path 穿越(res://../evil.tres)→ INVALID_PARAMS", async () => {
    const r = await run({ scene_path: 'res://main.tscn', draft_path: 'res://../evil.tres' });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.error_code).toBe('INVALID_PARAMS');
  });

  it('draft_path 非 res:// 形态 → INVALID_PARAMS', async () => {
    const r = await run({ scene_path: 'res://main.tscn', draft_path: '../evil.tres' });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.error_code).toBe('INVALID_PARAMS');
  });

  it('ACTIONS 含 extract_tree;actionRisks extract_tree=write', () => {
    expect(ACTIONS).toContain('extract_tree');
    expect(TOOL_META.ui!.actionRisks!.extract_tree).toBe('write');
  });
});

// ─── e2e(GODOT_PATH 门控,fixture 仿 test/ui-token-e2e.test.ts 临时项目模式)────

import { beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatePathEnv } from './helpers/path-isolation.js';

const GODOT_PATH = process.env.GODOT_PATH ?? '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

describe.skipIf(!hasGodot)('extract_tree e2e(批4 Task 3,无 autoload fixture)', () => {
  let dir: string;
  let restore: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-extract-e2e-'));
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n');
    // 靶子场景:PanelA/B 共享同 sub_resource(同 bg 0.25/0.5/0.75=2 的幂次,位级 roundtrip)
    // + PanelC 异 bg + LabelD font_size/color override + LabelE 无 override
    writeFileSync(join(dir, 'extract.tscn'), `[gd_scene load_steps=3 format=3]

[sub_resource type="StyleBoxFlat" id="StyleBoxFlat_ab"]
bg_color = Color(0.25, 0.5, 0.75, 1)

[sub_resource type="StyleBoxFlat" id="StyleBoxFlat_c"]
bg_color = Color(0.125, 0.125, 0.125, 1)

[node name="Main" type="Control"]
offset_right = 800.0
offset_bottom = 600.0

[node name="PanelA" type="Panel" parent="."]
theme_override_styles/panel = SubResource("StyleBoxFlat_ab")
offset_right = 200.0
offset_bottom = 100.0

[node name="PanelB" type="Panel" parent="."]
theme_override_styles/panel = SubResource("StyleBoxFlat_ab")
offset_top = 120.0
offset_right = 200.0
offset_bottom = 220.0

[node name="PanelC" type="Panel" parent="."]
theme_override_styles/panel = SubResource("StyleBoxFlat_c")
offset_top = 240.0
offset_right = 200.0
offset_bottom = 340.0

[node name="LabelD" type="Label" parent="."]
theme_override_colors/font_color = Color(1, 0.5, 0.25, 1)
theme_override_font_sizes/font_size = 20
offset_top = 360.0
offset_right = 200.0
offset_bottom = 400.0

[node name="LabelE" type="Label" parent="."]
offset_top = 420.0
offset_right = 200.0
offset_bottom = 460.0
`);
    // 空场景:Control 根无任何 override → 空扫描路径
    writeFileSync(join(dir, 'empty.tscn'), `[gd_scene format=3]

[node name="Empty" type="Control"]
`);
    restore = isolatePathEnv({ allowed: [dir] });
  });
  afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

  const ctx = { findGodot: async () => GODOT_PATH } as unknown as ToolContext;

  function bodyOf(r: ToolResult): {
    success: boolean; error?: string; error_code?: string;
    data?: {
      report?: {
        stylebox_groups?: Array<{ spec: { bg_color?: number[] }; count: number; nodes: string[]; slots: string[]; suggested_token: string }>;
        font_size_groups?: Array<{ value: number; count: number; nodes: string[]; suggested_token: string }>;
        font_color_groups?: Array<{ value: number[]; count: number; nodes: string[]; suggested_token: string }>;
      };
      draft?: { styleboxes: Array<{ type: string; slot: string }>; colors: Array<{ name: string }>; constants: Array<{ name: string }> } | null;
      notes?: string[];
      persist?: { path: string };
    };
  } {
    return JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
  }

  it('fixture 场景: report 数字精确(2 stylebox 组/font_size/font_color 各 1),LabelE 不在任何组', async () => {
    const r = await handleTool('ui', {
      action: 'extract_tree', project_path: dir, scene_path: 'res://extract.tscn',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const body = bodyOf(r);
    expect(body.success).toBe(true);
    const { stylebox_groups, font_size_groups, font_color_groups } = body.data!.report!;
    expect(stylebox_groups).toHaveLength(2);
    const [g0, g1] = stylebox_groups!;
    expect(g0.count).toBe(2);
    expect(g0.nodes).toEqual(['PanelA', 'PanelB']);
    expect(g0.suggested_token).toBe('style_panel_4080bf');
    expect(g0.spec.bg_color).toEqual([0.25, 0.5, 0.75, 1]);
    expect(g1.count).toBe(1);
    expect(g1.nodes).toEqual(['PanelC']);
    expect(g1.suggested_token).toBe('style_panel_202020');
    expect(font_size_groups).toEqual([{ value: 20, count: 1, nodes: ['LabelD'], suggested_token: 'font_size_20' }]);
    expect(font_color_groups!.map(g => [g.value, g.nodes, g.suggested_token])).toEqual([
      [[1, 0.5, 0.25, 1], ['LabelD'], 'text_ff8040'],
    ]);
    // LabelE(无 override)不输出节点 → 不进任何组
    const allNodes = [
      ...stylebox_groups!.flatMap(g => g.nodes),
      ...font_size_groups!.flatMap(g => g.nodes),
      ...font_color_groups!.flatMap(g => g.nodes),
    ];
    expect(allNodes).not.toContain('LabelE');
  }, 120_000);

  it('带 draft_path: .tres 含 StyleBoxFlat/bg_color,ui_set_theme(load) 挂载无错', async () => {
    const DRAFT = 'res://themes/extract-draft.tres';
    const r = await handleTool('ui', {
      action: 'extract_tree', project_path: dir, scene_path: 'res://extract.tscn', draft_path: DRAFT,
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const body = bodyOf(r);
    expect(body.data!.persist).toEqual({ path: DRAFT });
    // draft 内容:Panel 条目(4080bf 组胜出)+ text_ff8040 color + font_size_20 constant
    const draft = body.data!.draft!;
    expect(draft.styleboxes.map(s => s.type)).toContain('Panel');
    expect(draft.colors.map(c => c.name)).toEqual(expect.arrayContaining(['style_panel_4080bf', 'text_ff8040']));
    expect(draft.constants.map(c => c.name)).toContain('font_size_20');
    // 落盘文本:StyleBoxFlat + bg_color 子资源 + DesignTokens token 行
    const text = readFileSync(join(dir, 'themes', 'extract-draft.tres'), 'utf-8');
    expect(text).toContain('StyleBoxFlat');
    expect(text).toContain('bg_color');
    expect(text).toContain('DesignTokens');
    // ui_set_theme(load) 挂载无错(草稿是合法 Theme 资源)
    const mount = await handleTool('ui', {
      action: 'ui_set_theme', project_path: dir, scene_path: 'res://extract.tscn',
      node_path: 'root', theme_action: 'load', theme_path: DRAFT,
    }, ctx) as ToolResult;
    expect(mount.isError, JSON.stringify(mount.content)).toBeFalsy();
  }, 180_000);

  it('空场景(全无 override): 空报告 + draft null + 无 persist', async () => {
    const r = await handleTool('ui', {
      action: 'extract_tree', project_path: dir, scene_path: 'res://empty.tscn',
      draft_path: 'res://themes/never-draft.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const body = bodyOf(r);
    expect(body.data!.report!.stylebox_groups).toEqual([]);
    expect(body.data!.report!.font_size_groups).toEqual([]);
    expect(body.data!.report!.font_color_groups).toEqual([]);
    expect(body.data!.draft).toBeNull();
    expect(body.data!.notes!.join('\n')).toContain('未生成草稿');
    expect(body.data!.persist).toBeUndefined();
    // 草稿路径未落盘(空扫描零写盘)
    expect(existsSync(join(dir, 'themes', 'never-draft.tres'))).toBe(false);
  }, 120_000);
});
