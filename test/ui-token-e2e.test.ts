// test/ui-token-e2e.test.ts
// 批3 Task 3 e2e:$token 双链(import/pixel_verify)真机行为锚定(GODOT_PATH 门控)。
// fixture 仿 test/ui-measure-theme.test.ts:212 模式(自建无 autoload 最小项目),
// 但 themes/tokens.tres 写 **colors**(DesignTokens/colors/brand = Color(0.5, 0.25, 0.75, 1)
// —— float32 精确值,roundtrip 位级一致锚的取值依据:0.5/0.25/0.75/1 均为 2 的幂次,
// .tres → Color(float32) → [r,g,b,a] JSON → resolve 字面量 → build Color → measure 读回,
// 全链各位级无损 → style_verify bg_color 分量 delta = 0)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTool } from '../src/tools/ui/index.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { isolatePathEnv } from './helpers/path-isolation.js';

const GODOT_PATH = process.env.GODOT_PATH ?? '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

// 单节点 $token geometry:bg '$brand' 解析后 [0.5,0.25,0.75,1] → 0-255 target [128,64,191]。
const GEO = {
  viewport: { w: 800, h: 600 },
  nodes: [
    { name: 'P', rect: { x: 0, y: 0, w: 100, h: 60 }, type: 'Panel', bg: '$brand' },
  ],
};

describe.skipIf(!hasGodot)('$token 双链 e2e(批3 Task 3,无 autoload fixture)', () => {
  let dir: string;
  let restore: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-token-e2e-'));
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n');
    // 构建目标场景(挂载父,Panel 根 + 原点对齐)
    writeFileSync(join(dir, 'main.tscn'), `[gd_scene format=3]

[node name="Main" type="Panel"]
offset_right = 800.0
offset_bottom = 600.0
`);
    mkdirSync(join(dir, 'themes'), { recursive: true });
    // DesignTokens colors:brand = Color(0.5, 0.25, 0.75, 1)(float32 精确值,位级 roundtrip 锚)
    writeFileSync(join(dir, 'themes', 'tokens.tres'), `[gd_resource type="Theme" format=3]

[resource]
DesignTokens/colors/brand = Color(0.5, 0.25, 0.75, 1)
`);
    // 裸 Theme(有 colors 但非 DesignTokens type)——预取空 map → 缺键路径
    writeFileSync(join(dir, 'themes', 'bare.tres'), `[gd_resource type="Theme" format=3]

[resource]
Other/colors/x = Color(1, 1, 1, 1)
`);
    restore = isolatePathEnv({ allowed: [dir] });
  });
  afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

  const ctx = { findGodot: async () => GODOT_PATH } as unknown as ToolContext;

  function bodyOf(r: ToolResult): {
    success: boolean; error?: string; error_code?: string;
    data?: {
      tokens_resolved?: { theme_path: string; refs: number; tokens: string[] };
      style_verify?: Array<{ path: string; slot: string; field: string; delta: number[] | null; ok: boolean }>;
      pixel_verify?: { nodes: Array<{ target: number[]; ok: boolean }>; pass: number; fail: number };
    };
  } {
    return JSON.parse((r.content?.[0] as { text?: string }).text ?? '{}');
  }

  it('import 带 $bg + theme_path:成功,style_verify bg 槽分量 delta=0(位级 roundtrip),tokens_resolved 含 brand', async () => {
    const r = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: dir, scene_path: 'res://main.tscn',
      geometry: GEO, theme_path: 'res://themes/tokens.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const body = bodyOf(r);
    expect(body.success).toBe(true);
    // tokens_resolved:refs=1,tokens=['brand']
    expect(body.data!.tokens_resolved).toEqual({ theme_path: 'res://themes/tokens.tres', refs: 1, tokens: ['brand'] });
    // style_verify:P 的 panel 槽 bg_color 分量 delta 全 0(float32 位级一致,非容差内)
    const entry = body.data!.style_verify!.find(e => e.path.endsWith('/P') && e.slot === 'panel' && e.field === 'bg_color');
    expect(entry, 'P/panel/bg_color 条目存在').toBeDefined();
    expect(Math.max(...(entry!.delta as number[]).map(Math.abs))).toBe(0);
  }, 120_000);

  it('theme 无 DesignTokens type(裸 Theme)→ TOKEN_NOT_FOUND 点名 brand 与路径', async () => {
    const r = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: dir, scene_path: 'res://main.tscn',
      geometry: GEO, theme_path: 'res://themes/bare.tres',
    }, ctx) as ToolResult;
    // 错误路径:errorResult 的 ToolResult isError=true,body 仍是 opsError JSON(单测同款契约)
    expect(r.isError).toBe(true);
    const body = bodyOf(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('TOKEN_NOT_FOUND');
    expect(body.error).toContain('brand');
    expect(body.error).toContain('res://themes/bare.tres');
  }, 120_000);

  it('theme 文件不存在 → THEME_NOT_FOUND(theme_path load failed 分流)', async () => {
    const r = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: dir, scene_path: 'res://main.tscn',
      geometry: GEO, theme_path: 'res://themes/missing.tres',
    }, ctx) as ToolResult;
    // 错误路径:errorResult 的 ToolResult isError=true,body 仍是 opsError JSON(单测同款契约)
    expect(r.isError).toBe(true);
    const body = bodyOf(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('THEME_NOT_FOUND');
    expect(body.error).toContain('theme_path load failed');
  }, 120_000);

  it('pixel_verify 同 geometry(scene_path 指向 import 产物):预取解析后采样链正常返回', async () => {
    const r = await handleTool('ui', {
      action: 'ui_pixel_verify', project_path: dir, scene_path: 'res://main.tscn',
      geometry: GEO, theme_path: 'res://themes/tokens.tres',
    }, ctx) as ToolResult;
    expect(r.isError).toBeFalsy();
    const body = bodyOf(r);
    if (body.success !== true) {
      // capture 通道不可用(如无显示环境/dummy renderer):错误须来自 capture 层而非解析层
      // ——解析层正常性由前序 TOKEN_NOT_FOUND/THEME_NOT_FOUND 用例锚定,此处记录实况。
      console.log('[token-e2e] pixel_verify capture 不可用(降级断言 capture 层错误):', body.error);
      expect(String(body.error)).toMatch(/像素截图|空白|capture|screenshot/i);
      return;
    }
    // 采样链走通:target = 解析色 [0.5,0.25,0.75,1] → round(*255) = [128,64,191]
    const pv = body.data!.pixel_verify!;
    expect(pv.nodes).toHaveLength(1);
    expect(pv.nodes[0]!.target).toEqual([128, 64, 191]);
    expect(pv.fail).toBe(0);
  }, 180_000);

  it('pixel_verify 解析层:theme 文件不存在 → THEME_NOT_FOUND(非 SCRIPT_EXEC_FAILED,不触 capture)', async () => {
    const r = await handleTool('ui', {
      action: 'ui_pixel_verify', project_path: dir, scene_path: 'res://main.tscn',
      geometry: GEO, theme_path: 'res://themes/missing.tres',
    }, ctx) as ToolResult;
    // 错误路径:errorResult 的 ToolResult isError=true,body 仍是 opsError JSON(单测同款契约)
    expect(r.isError).toBe(true);
    const body = bodyOf(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('THEME_NOT_FOUND');
  }, 120_000);
});
