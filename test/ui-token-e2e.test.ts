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
    // 批3 Task 4:token_set 可写目标(空 Theme;token_set 只写已存在主题,缺失分支报
    // THEME_NOT_FOUND——独立文件防污染共享 tokens.tres)
    writeFileSync(join(dir, 'themes', 'writable.tres'), `[gd_resource type="Theme" format=3]

[resource]
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
      token_set?: { name: string; path: string; kind: string };
      token_list?: { colors: Record<string, number[]>; constants: Record<string, number> };
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
    const body = bodyOf(r);
    if (r.isError || body.success !== true) {
      // capture 通道不可用(如无显示环境/dummy renderer):错误须来自 capture 层而非解析层
      // ——解析层正常性由前序 TOKEN_NOT_FOUND/THEME_NOT_FOUND 用例锚定,此处记录实况。
      // capture 失败走 errorResult(isError=true):降级判断必须先于 isError 断言——否则没有显示器的
      // CI(如 check 任务不起 xvfb)在走到这里之前就红(2026-11-27 CI)。
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

  // ─── 批3 Task 4:token_set/token_list 文件级读写真机锚 ─────────────────────

  it('token_set(color float32 安全值 + constant)→ token_list 精确读回(逐值 ===)', async () => {
    const WRITABLE = 'res://themes/writable.tres';
    // color [0.5,0.25,0.75,1] 全 2 的幂次,float32 位级无损(同 tokens.tres 锚值);constant 8
    const setColor = await handleTool('ui', {
      action: 'token_set', project_path: dir, theme_path: WRITABLE,
      token_name: 'brand2', token_value: [0.5, 0.25, 0.75, 1],
    }, ctx) as ToolResult;
    expect(setColor.isError, JSON.stringify(setColor.content)).toBeFalsy();
    expect(bodyOf(setColor).data!.token_set).toMatchObject({ name: 'brand2', kind: 'color' });

    const setConst = await handleTool('ui', {
      action: 'token_set', project_path: dir, theme_path: WRITABLE,
      token_name: 'space_1', token_value: 8,
    }, ctx) as ToolResult;
    expect(setConst.isError, JSON.stringify(setConst.content)).toBeFalsy();
    expect(bodyOf(setConst).data!.token_set).toMatchObject({ name: 'space_1', kind: 'constant' });

    // 读回:逐值 ===(float32 安全值位级一致,非容差内)
    const list = await handleTool('ui', {
      action: 'token_list', project_path: dir, theme_path: WRITABLE,
    }, ctx) as ToolResult;
    expect(list.isError, JSON.stringify(list.content)).toBeFalsy();
    const tl = bodyOf(list).data!.token_list!;
    expect(tl.colors.brand2).toEqual([0.5, 0.25, 0.75, 1]);
    expect(tl.colors.brand2!.every((v, i) => v === [0.5, 0.25, 0.75, 1][i])).toBe(true);
    expect(tl.constants.space_1).toBe(8);
    expect(tl.constants.space_1 === 8).toBe(true);
  }, 120_000);

  it('token_set 同名覆盖 → 再 list 验证新值(旧值不残留)', async () => {
    const WRITABLE = 'res://themes/writable.tres';
    // 覆盖 brand2 为新色(全 2 的幂次);space_1 覆盖为 16
    const r1 = await handleTool('ui', {
      action: 'token_set', project_path: dir, theme_path: WRITABLE,
      token_name: 'brand2', token_value: [1, 0.5, 0.25, 1],
    }, ctx) as ToolResult;
    expect(r1.isError, JSON.stringify(r1.content)).toBeFalsy();
    const r2 = await handleTool('ui', {
      action: 'token_set', project_path: dir, theme_path: WRITABLE,
      token_name: 'space_1', token_value: 16,
    }, ctx) as ToolResult;
    expect(r2.isError, JSON.stringify(r2.content)).toBeFalsy();

    const list = await handleTool('ui', {
      action: 'token_list', project_path: dir, theme_path: WRITABLE,
    }, ctx) as ToolResult;
    expect(list.isError, JSON.stringify(list.content)).toBeFalsy();
    const tl = bodyOf(list).data!.token_list!;
    expect(tl.colors.brand2).toEqual([1, 0.5, 0.25, 1]);
    expect(tl.constants.space_1).toBe(16);
    // 前序值不残留(space_1 8 已被 16 覆盖)
    expect(tl.constants.space_1).not.toBe(8);
  }, 120_000);

  it('token_set/token_list theme 文件缺失 → THEME_NOT_FOUND(theme file not found 分流)', async () => {
    const rSet = await handleTool('ui', {
      action: 'token_set', project_path: dir, theme_path: 'res://themes/missing.tres',
      token_name: 'brand', token_value: 8,
    }, ctx) as ToolResult;
    expect(rSet.isError).toBe(true);
    const bodySet = bodyOf(rSet);
    expect(bodySet.error_code).toBe('THEME_NOT_FOUND');
    expect(bodySet.error).toContain('theme file not found');
    // 指引文案(brief 逐字)
    expect(bodySet.error).toContain('theme_create(scene_path+save_path)');

    const rList = await handleTool('ui', {
      action: 'token_list', project_path: dir, theme_path: 'res://themes/missing.tres',
    }, ctx) as ToolResult;
    expect(rList.isError).toBe(true);
    const bodyList = bodyOf(rList);
    expect(bodyList.error_code).toBe('THEME_NOT_FOUND');
    expect(bodyList.error).toContain('theme file not found');
  }, 120_000);

  it('token_list 裸 Theme(无 DesignTokens type)→ 空 {colors:{}, constants:{}} 不报错', async () => {
    const r = await handleTool('ui', {
      action: 'token_list', project_path: dir, theme_path: 'res://themes/bare.tres',
    }, ctx) as ToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const tl = bodyOf(r).data!.token_list!;
    expect(tl.colors).toEqual({});
    expect(tl.constants).toEqual({});
  }, 120_000);
});
