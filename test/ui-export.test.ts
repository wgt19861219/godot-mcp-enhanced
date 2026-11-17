// test/ui-export.test.ts
// 批4 Task 3 单测:export_doc 生成器(genThemeInspectScript)+ 文档组装纯函数
// (buildDesignDoc)+ handler 前置校验。e2e(GODOT_PATH 门控)在同文件末段。
// themeFileNotFoundBlock 复用自 ui-tokens.ts(错误文案单一真源),顺序锚不适用(无 getter 链)。
import { describe, it, expect } from 'vitest';
import { genThemeInspectScript, buildDesignDoc } from '../src/tools/ui/ui-export.js';
import type { ThemeInspect } from '../src/tools/ui/ui-export.js';
import { ACTIONS, TOOL_META } from '../src/tools/ui-tools.js';
import { handleTool } from '../src/tools/ui/index.js';
import type { ToolContext, ToolResult } from '../src/types.js';

// ─── genThemeInspectScript ──────────────────────────────────────────────────

describe('genThemeInspectScript(批4 Task 3)', () => {
  it('含 get_type_list + 四通道 list(color/constant/stylebox/font_size)', () => {
    const script = genThemeInspectScript('res://ui/theme.tres');
    expect(script).toContain('_theme.get_type_list()');
    expect(script).toContain('get_color_list');
    expect(script).toContain('get_constant_list');
    expect(script).toContain('get_stylebox_list');
    expect(script).toContain('get_font_size_list');
  });

  it('theme 缺失分支复用 themeFileNotFoundBlock(文案单一真源,mapper 前置分流 THEME_NOT_FOUND)', () => {
    const script = genThemeInspectScript('res://ui/theme.tres');
    expect(script).toContain('theme file not found');
    expect(script).toContain('theme_create(scene_path+save_path)');
  });

  it('含 theme_inspect 输出键 + default_font 有无 + DesignTokens tokens 导出', () => {
    const script = genThemeInspectScript('res://ui/theme.tres');
    expect(script).toContain('_mcp_output("theme_inspect"');
    expect(script).toContain('default_font');
    expect(script).toContain('"DesignTokens"');
  });

  it('无场景加载(不触 _mcp_load_scene 调用;header 函数定义恒在)', () => {
    const script = genThemeInspectScript('res://ui/theme.tres');
    expect(script).not.toContain('_mcp_load_scene("');
  });
});

// ─── buildDesignDoc ─────────────────────────────────────────────────────────

/** 通道条目构造 helper。 */
function chan(names: string[], more = 0): { names: string[]; more: number } {
  return { names, more };
}

/** 构造一个带全部四通道的类型条目。 */
function fullType(type: string): NonNullable<ThemeInspect['types'][number]> {
  return {
    type,
    colors: chan(['font_color', 'font_outline_color']),
    constants: chan(['separation']),
    styleboxes: chan(['normal', 'hover', 'pressed', 'disabled', 'focus']),
    font_sizes: chan(['font_size']),
  };
}

describe('buildDesignDoc(批4 Task 3)', () => {
  it('头部: # DESIGN + 视图声明(真源 .tres,由 export_doc 生成)', () => {
    const doc = buildDesignDoc({ tokens: { colors: {}, constants: {} }, types: [], has_default_font: false });
    expect(doc).toContain('# DESIGN');
    expect(doc).toContain('.tres');
    expect(doc).toContain('export_doc');
  });

  it('DesignTokens 全量表: colors+constants 逐行(token 名与值)', () => {
    const inspect: ThemeInspect = {
      tokens: {
        colors: { brand: [0.5, 0.25, 0.75, 1] },
        constants: { space_1: 8 },
      },
      types: [],
      has_default_font: false,
    };
    const doc = buildDesignDoc(inspect);
    expect(doc).toContain('brand');
    expect(doc).toContain('0.5');
    expect(doc).toContain('space_1');
    expect(doc).toContain('8');
  });

  it('空档: tokens 双通道全空 → 一行空档说明(不报错)', () => {
    const doc = buildDesignDoc({ tokens: { colors: {}, constants: {} }, types: [], has_default_font: false });
    expect(doc).toContain('DesignTokens');
    expect(doc).toMatch(/空/);
  });

  it('引擎约束提示节: 固定三条(27px/Label TOP→CENTER/self_modulate 禁 modulate)', () => {
    const doc = buildDesignDoc({ tokens: { colors: {}, constants: {} }, types: [], has_default_font: false });
    expect(doc).toContain('引擎约束');
    expect(doc).toContain('27px');      // PROGRESS_BAR_MIN_HEIGHT 渲染值
    expect(doc).toContain('TOP');
    expect(doc).toContain('CENTER');
    expect(doc).toContain('self_modulate');
  });

  it('类型摘要表: 每类型各通道 counts + names 截断(>5 → (+N more))', () => {
    const inspect: ThemeInspect = {
      tokens: { colors: {}, constants: {} },
      types: [fullType('Button')],
      has_default_font: false,
    };
    const doc = buildDesignDoc(inspect);
    expect(doc).toContain('Button');
    expect(doc).toContain('font_color');
    // styleboxes 5 names: 恰好不截断;再造 8 names → 显示 5 + (+3 more)
    const inspect2: ThemeInspect = {
      tokens: { colors: {}, constants: {} },
      types: [{ type: 'Big', colors: chan(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) }],
      has_default_font: false,
    };
    const doc2 = buildDesignDoc(inspect2);
    expect(doc2).toContain('(+3 more)');
  });

  it('类型截断: >20 类型按通道条目总数排序截 top 20 → (+N types)', () => {
    const types = Array.from({ length: 23 }, (_, i) => fullType(`T${String(i + 1).padStart(2, '0')}`));
    const inspect: ThemeInspect = { tokens: { colors: {}, constants: {} }, types, has_default_font: false };
    const doc = buildDesignDoc(inspect);
    expect(doc).toContain('(+3 types)');
    // top 20 内含首类型,T23 被截
    expect(doc).toContain('T01');
    expect(doc).not.toContain('| T23');
  });

  it('排序: 通道条目总数多的类型在前(top 20 截断按此序)', () => {
    const inspect: ThemeInspect = {
      tokens: { colors: {}, constants: {} },
      types: [
        { type: 'Small', colors: chan(['a']) },
        { type: 'Big', colors: chan(['a', 'b', 'c']), constants: chan(['d']), styleboxes: chan(['e']), font_sizes: chan(['f']) },
      ],
      has_default_font: false,
    };
    const doc = buildDesignDoc(inspect);
    const idxBig = doc.indexOf('| Big');
    const idxSmall = doc.indexOf('| Small');
    expect(idxBig).toBeGreaterThanOrEqual(0);
    expect(idxSmall).toBeGreaterThan(idxBig);
  });
});

// ─── handler 前置校验 + 契约 ────────────────────────────────────────────────

describe('export_doc handler 前置校验(批4 Task 3)', () => {
  const fakeCtx = { findGodot: async () => '/fake/godot' } as unknown as ToolContext;

  it('缺 theme_path → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: '/fake/p',
    }, fakeCtx) as ToolResult;
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('theme_path');
  });

  it('theme_path 穿越 → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: '/fake/p', theme_path: 'res://../evil.tres',
    }, fakeCtx) as ToolResult;
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
    expect(body.error_code).toBe('INVALID_PARAMS');
  });

  it('ACTIONS 含 export_doc;actionRisks export_doc=read', () => {
    expect(ACTIONS).toContain('export_doc');
    expect(TOOL_META.ui!.actionRisks!.export_doc).toBe('read');
  });
});

// ─── e2e(GODOT_PATH 门控,fixture 仿 test/ui-token-e2e.test.ts 临时项目模式)────

import { beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatePathEnv } from './helpers/path-isolation.js';

const GODOT_PATH = process.env.GODOT_PATH ?? '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

describe.skipIf(!hasGodot)('export_doc e2e(批4 Task 3,无 autoload fixture)', () => {
  let dir: string;
  let restore: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-export-e2e-'));
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n');
    mkdirSync(join(dir, 'themes'), { recursive: true });
    // 带 DesignTokens 的 theme:全量表用例
    writeFileSync(join(dir, 'themes', 'with-tokens.tres'), `[gd_resource type="Theme" format=3]

[resource]
DesignTokens/colors/brand = Color(0.5, 0.25, 0.75, 1)
DesignTokens/constants/space_1 = 8
`);
    // 裸 Theme:空档用例
    writeFileSync(join(dir, 'themes', 'bare.tres'), `[gd_resource type="Theme" format=3]

[resource]
`);
    // 单类型 12 colors:names top10 + more=2 → 文档表内 total 12 显示 5 → (+7 more)
    const bigLines = Array.from({ length: 12 }, (_, i) =>
      `BigType/colors/n${String(i + 1).padStart(2, '0')} = Color(1, 0, 0, 1)`);
    writeFileSync(join(dir, 'themes', 'big.tres'), `[gd_resource type="Theme" format=3]

[resource]
${bigLines.join('\n')}
`);
    // 21 类型各 1 color:types 21 → top 20 + (+1 types)
    const manyLines = Array.from({ length: 21 }, (_, i) =>
      `T${String(i + 1).padStart(2, '0')}/colors/x = Color(0, 1, 0, 1)`);
    writeFileSync(join(dir, 'themes', 'many.tres'), `[gd_resource type="Theme" format=3]

[resource]
${manyLines.join('\n')}
`);
    restore = isolatePathEnv({ allowed: [dir] });
  });
  afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

  const ctx = { findGodot: async () => GODOT_PATH } as unknown as ToolContext;

  function bodyOf(r: ToolResult): {
    success: boolean; error?: string; error_code?: string;
    data?: { document?: string; theme_path?: string };
  } {
    return JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
  }

  it('带 DesignTokens theme: 全量表($brand 与 space_1 逐行)+ 头部声明', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: dir, theme_path: 'res://themes/with-tokens.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const body = bodyOf(r);
    expect(body.success).toBe(true);
    expect(body.data!.theme_path).toBe('res://themes/with-tokens.tres');
    const doc = body.data!.document!;
    expect(doc).toContain('# DESIGN');
    expect(doc).toContain('.tres');
    expect(doc).toContain('export_doc');
    expect(doc).toContain('$brand');
    expect(doc).toContain('space_1');
  }, 120_000);

  it('裸 Theme: 空档说明不报错(审计语义,缺失≠错误)', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: dir, theme_path: 'res://themes/bare.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const doc = bodyOf(r).data!.document!;
    expect(doc).toContain('# DESIGN');
    expect(doc).toMatch(/空/);
  }, 120_000);

  it('>10 names 类型: (+7 more) 截断标记(12 colors → GD 截 10 → 表内显示 5)', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: dir, theme_path: 'res://themes/big.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const doc = bodyOf(r).data!.document!;
    expect(doc).toContain('BigType');
    expect(doc).toContain('12: n01, n02, n03, n04, n05 (+7 more)');
  }, 120_000);

  it('>20 类型构造: (+1 types) 截断标记(21 类型 → top 20)', async () => {
    const r = await handleTool('ui', {
      action: 'export_doc', project_path: dir, theme_path: 'res://themes/many.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const doc = bodyOf(r).data!.document!;
    expect(doc).toContain('(+1 types)');
    expect(doc).toContain('| T01');
    expect(doc).not.toContain('| T21');
  }, 120_000);
});
