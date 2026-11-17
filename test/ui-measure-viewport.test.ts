import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { genUiMeasureScript, checkViewportEffect } from '../src/tools/ui/ui-measure.js';
import { genUiImportSingleScript } from '../src/tools/ui/ui-import-single.js';
import { executeGdscriptTrusted } from '../src/gdscript-executor.js';
import { handleTool, getToolDefinitions } from '../src/tools/ui/index.js';
import type { MeasuredNode } from '../src/tools/ui/layout-diff.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { mockSuccessResult } from './helpers/mock-results.js';

// 批2 Task4:viewport:null 四处同修的单测需捕获 handler 生成的脚本(证明 null 完全走
// 无 viewport 路径)——executor mock 化(ui-quality-check.test.ts 同款 realExecutor 闭包
// 模式;文件内既有 e2e describe 经 beforeAll 把 mockImplementation 指回真实 executor)。
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

// 批1 1a(spec 开放问题 1):measure viewport 参数——g800 复测通道。
// ── spike 结论(2026-11-16 实测,Godot 4.7 headless --path --script,探针不留仓库)──
// ① root.content_scale_size = Vector2(w,h):赋值当刻读回新值,后续帧被引擎复位回项目
//    设置(960×540),布局不重排——不生效;
// ② root.set_size(Vector2i(w,h)):同样被复位(WIN 回 64×64,headless DisplayServer
//    窗口尺寸不可控)——不生效;
// ③ **SubViewport 通道(采用)**:场景实例挂进 SubViewport(size=w×h),Control 树按注入
//    视口重排——靶子 DotaLegendGodot(960×540 默认)注入 800×480 → 全铺场景根
//    rect.w 960→800,实测生效。
// 主题交互(探针4 实测):root.set_theme 的主题传播不跨 Viewport 边界——viewport 注入
// 时 themeMount 改挂场景根(_mcp_scene_instance as Control),variation 字号才生效。
// 详见 spec 开放问题 1 答案段。
// ── 双通道契约 ────────────────────────────────────────────────────────────
// genUiMeasureScript(_initialize) 与 genUiImportSingleScript(_measure_go) 各注入一份
// (measure 核心经 'var _frames := 0' 截取后 _initialize 整体剥离,import 链必须重注);
// 注入必须在场景加载(_mcp_load_scene / reload load)之前——视口先设置,布局才按新视口算。
// ── 假绿防护(Review Focus 2)───────────────────────────────────────────────
// viewport 生效须有独立于上报值的硬证据(e2e 全铺节点 rect.w == 800),无法确认时响应
// data.measure 附 viewport_check: "inconclusive" + 指引警告,不得静默。brief 预设的
// "非全铺节点相对默认视口基线变化"辅判据实测弃用:默认基线只能挂 root 取,与 SubViewport
// 覆写轮语境不同(headless Window 不可信 + stretch 字体度量失真,Label 自适应 h/w 噪声
// 20↔23/56↔64),非视口变化会被误读为生效——检测器自身假绿(见 index.ts 后处理注释)。

const GODOT_PATH = process.env.GODOT_PATH || '';
const TARGET_PROJECT = 'D:/workspace/projects/DotaLegendGodot';
const hasE2e = GODOT_PATH !== '' && existsSync(GODOT_PATH) && existsSync(TARGET_PROJECT);
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

describe('genUiMeasureScript viewport 注入', () => {
  it('无 viewport 时不含视口覆写行(向后兼容:与现状逐字节一致)', () => {
    const s = genUiMeasureScript('res://a.tscn', undefined, 16);
    expect(s).not.toContain('_vp_sub = SubViewport.new()');
    expect(s).not.toContain('var _vp_sub: SubViewport');
  });
  it('有 {w:800,h:480} 时注入 SubViewport 建段且在 _mcp_load_scene 之前(视口先于场景加载)', () => {
    const s = genUiMeasureScript('res://a.tscn', undefined, 16, undefined, { viewport: { w: 800, h: 480 } });
    const inject = s.indexOf('_vp_sub.size = Vector2i(800, 480)');
    expect(inject).toBeGreaterThanOrEqual(0);
    // 锚定 _initialize 里的调用形态(裸 '_mcp_load_scene' 会先命中 header 的函数定义)
    expect(inject).toBeLessThan(s.indexOf('if not _mcp_load_scene'));
    // 转挂段在场景加载之后:实例从 root 移入 SubViewport(布局按注入视口重排)
    const adopt = s.indexOf('_vp_sub.add_child(_mcp_scene_instance)');
    expect(adopt).toBeGreaterThan(s.indexOf('if not _mcp_load_scene'));
  });
  it('数值为生成期字面量内插(w/h 非 Number.isFinite 时由 handler 拒,生成器只接已校验值)', () => {
    const s = genUiMeasureScript('res://a.tscn', undefined, 16, undefined, { viewport: { w: 1024, h: 768 } });
    expect(s).toContain('_vp_sub.size = Vector2i(1024, 768)');
  });
  it('注入时 _emit 上报行改为 _vp_sub 尺寸优先(viewport 参数注入时优先返回注入值)', () => {
    const s = genUiMeasureScript('res://a.tscn', undefined, 16, undefined, { viewport: { w: 800, h: 480 } });
    expect(s).toContain('var _vp := root.content_scale_size\n\tif _vp_sub != null:\n\t\t_vp = Vector2(_vp_sub.size)');
  });
  it('viewport + themePath 组合:主题改挂场景根(不跨 Viewport 边界),非 Control 根显式报错', () => {
    const s = genUiMeasureScript('res://a.tscn', undefined, 16, undefined,
      { viewport: { w: 800, h: 480 }, themePath: 'res://themes/x.tres' });
    expect(s).toContain('(_mcp_scene_instance as Control).set_theme(_theme_res)');
    expect(s).not.toContain('\troot.set_theme(_theme_res)');
    expect(s).toContain('"theme_path requires a Control scene root when viewport override is active"');
    // 挂载在转挂(adopt)之后——场景先进 SubViewport,主题挂场景根传播子树
    expect(s.indexOf('set_theme(_theme_res)')).toBeGreaterThan(s.indexOf('_vp_sub.add_child(_mcp_scene_instance)'));
  });
});

// import 链注入通道锚定(Task1 审查 Important#1 同款问题:measure _initialize 整体剥离,
// viewport 覆写必须在 _measure_go 内重注,否则 ui_import_prototype 链静默丢失视口语境):
// 注入位置在 _measure_go 的 reload load 之前(等价 _mcp_load_scene 之前的语义)。
describe('genUiImportSingleScript viewport 注入(import 链双通道)', () => {
  const tree = {
    type: 'VBoxContainer', name: 'Root',
    children: [{ type: 'Label', name: 'L', properties: { text: '你好' } }],
  };
  it('有 viewport 时覆写行在 _measure_go 内、ResourceLoader.load(reload)之前;挂载行换 _vp_sub', () => {
    const s = genUiImportSingleScript('D:/proj/main.tscn', 'root', tree, { w: 800, h: 480 });
    const inject = s.indexOf('_vp_sub.size = Vector2i(800, 480)');
    expect(inject).toBeGreaterThanOrEqual(0);
    expect(inject).toBeGreaterThan(s.indexOf('func _measure_go'));
    expect(inject).toBeLessThan(s.indexOf('ResourceLoader.load'));
    // 场景实例挂进 SubViewport(替换 root.add_child 通道)
    expect(s).toContain('\t_vp_sub.add_child(_mcp_scene_instance)');
    expect(s).not.toContain('\troot.add_child(_mcp_scene_instance)');
  });
  it('import 链 viewport 形参必填(build 求解基准)→ measure 注入恒随形参(求解语境=测量语境)', () => {
    // genUiImportSingleScript 的 viewport 形参必填,任何正值都注入——build 的 rect 求解基准
    // 与 measure 的视口语境天然一致(求解按 1280 算,测量也按 1280 测,verify 才同语境)
    const s = genUiImportSingleScript('D:/proj/main.tscn', 'root', tree, { w: 1280, h: 720 });
    expect(s).toContain('_vp_sub.size = Vector2i(1280, 720)');
    expect(s).toContain('\t_vp_sub.add_child(_mcp_scene_instance)');
  });
});

// ─── Step 5: handler 侧校验(非正数拒绝) + 假绿防护纯函数 ──────────────────

/** 校验路径不触 executor(INVALID_PARAMS 在脚本生成前 return),ctx 仅需 findGodot 桩。 */
function fakeCtx(): ToolContext {
  return {
    findGodot: async () => '/fake/godot',
  } as unknown as ToolContext;
}

describe('ui_measure_layout handler viewport 校验', () => {
  it.each([0, -1, 0.5, Number.NaN])('非正整数 w=%s → INVALID_PARAMS', async (w) => {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn',
      viewport: { w, h: 480 },
    }, fakeCtx()) as ToolResult;
    expect(r.isError).toBe(true);
    const text = (r.content?.[0] as { text?: string }).text ?? '';
    expect(text).toContain('positive integers');
  });
  it('缺 h → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn',
      viewport: { w: 800 },
    }, fakeCtx()) as ToolResult;
    expect(r.isError).toBe(true);
  });
});

// ─── 批2 Task4:viewport schema description 整数标注(终审 T2①)──────────────
describe('viewport schema description 整数标注', () => {
  it('measure 分句标注正整数(SubViewport 尺寸——handler 侧正整数校验的 schema 镜像)', () => {
    const schema = getToolDefinitions()[0]!.inputSchema as { properties: Record<string, unknown> };
    const desc = String((schema.properties.viewport as { description?: string }).description);
    expect(desc).toContain('ui_measure_layout: 覆写测量视口(SubViewport 尺寸,正整数');
  });
});

// ─── 批2 Task4 顺手项(ledger deferred B2T1 Minor):viewport:null 四处同修 ──
// 原判据 `args.viewport !== undefined` 放行 null → vp.w 读 null 抛 TypeError(被外层
// catch 吃成 SCRIPT_EXEC_FAILED);修为 `!= null`(null 与 undefined 都跳过)。断言口径:
// null 轮与缺省轮 handler 生成的 GDScript / 计划文本逐字节一致(= null 完全走无
// viewport 路径,build/measure/import 三处经捕获脚本比对,solve 纯 TS 链比对响应)。
describe('viewport:null 等价缺省(index.ts 四处同修)', () => {
  beforeEach(() => { execMock.mockReset(); });
  afterEach(() => { execMock.mockReset(); });

  function lastCode(): string {
    expect(execMock, 'executor 应被调用一次').toHaveBeenCalledTimes(1);
    return (execMock.mock.calls[0]![0] as { code: string }).code;
  }
  function mockMeasureOk() {
    execMock.mockResolvedValueOnce(mockSuccessResult({
      outputs: [{ key: 'measure', value: JSON.stringify({ stable_after_frames: 1, stalled: false, viewport: { w: 1280, h: 720 }, nodes: [] }) }],
    }));
  }

  it('ui_measure_layout:viewport:null → 不抛 TypeError,脚本与缺省轮逐字节一致(无 SubViewport 注入)', async () => {
    mockMeasureOk();
    const withNull = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn', viewport: null,
    }, fakeCtx()) as ToolResult;
    expect(withNull.isError).toBeFalsy();
    const codeNull = lastCode();
    execMock.mockReset();
    mockMeasureOk();
    const omitted = await handleTool('ui', {
      action: 'ui_measure_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn',
    }, fakeCtx()) as ToolResult;
    expect(omitted.isError).toBeFalsy();
    expect(lastCode()).toBe(codeNull);
    // 无注入锚定同文件生成器测试的标记(创建行;脚本其余处仍可能引用 _vp_sub 空值守卫)
    expect(codeNull).not.toContain('_vp_sub = SubViewport.new()');
  });

  it('ui_build_layout:viewport:null → 脚本与缺省轮逐字节一致(默认 1280x720 求解基准)', async () => {
    const tree = { type: 'Panel', name: 'R', rect: { x: 0, y: 0, w: 640, h: 480 } };
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [{ key: 'layout_built', value: '"ok"' }] }));
    const withNull = await handleTool('ui', {
      action: 'ui_build_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn', tree, viewport: null,
    }, fakeCtx()) as ToolResult;
    expect(withNull.isError).toBeFalsy();
    const codeNull = lastCode();
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [{ key: 'layout_built', value: '"ok"' }] }));
    const omitted = await handleTool('ui', {
      action: 'ui_build_layout', project_path: 'D:/fake/p', scene_path: 'res://a.tscn', tree,
    }, fakeCtx()) as ToolResult;
    expect(omitted.isError).toBeFalsy();
    expect(lastCode()).toBe(codeNull);
  });

  it('ui_import_prototype:viewport:null → 回落 geometry.viewport,脚本与缺省轮逐字节一致', async () => {
    const GEO_MIN = { viewport: { w: 800, h: 600 }, nodes: [{ name: 'A', rect: { x: 0, y: 0, w: 20, h: 24 } }] };
    function mockImport() {
      execMock.mockResolvedValueOnce(mockSuccessResult({
        outputs: [
          { key: 'persist', value: JSON.stringify({ saved: true }) },
          { key: 'measure', value: JSON.stringify({ stable_after_frames: 1, stalled: false, viewport: { w: 800, h: 600 }, nodes: [] }) },
        ],
      }));
    }
    mockImport();
    const withNull = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: 'D:/fake/p', scene_path: 'res://scene.tscn', geometry: GEO_MIN, viewport: null,
    }, fakeCtx()) as ToolResult;
    expect(withNull.isError).toBeFalsy();
    const codeNull = lastCode();
    execMock.mockReset();
    mockImport();
    const omitted = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: 'D:/fake/p', scene_path: 'res://scene.tscn', geometry: GEO_MIN,
    }, fakeCtx()) as ToolResult;
    expect(omitted.isError).toBeFalsy();
    expect(lastCode()).toBe(codeNull);
    // 回落语义:null 不覆写,合成脚本按 geometry.viewport(800×600)注入
    expect(codeNull).toContain('_vp_sub.size = Vector2i(800, 600)');
  });

  it('solve_from_current:viewport:null → 计划与缺省轮一致(纯 TS 链,viewport 上报 null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-vp-null-'));
    try {
      // 根直接子零锚节点(父=根形态,父尺寸无法从 tscn 解析)——缺省轮进
      // skippedUnresolvedParent,viewport 轮才可解;null 轮必须与缺省轮一致
      writeFileSync(join(dir, 'main.tscn'), `[gd_scene format=3]

[node name="Main" type="Control"]

[node name="C" type="ColorRect" parent="."]
offset_right = 100.0
offset_bottom = 50.0
`);
      const ctx = {} as ToolContext;
      const withNull = await handleTool('ui', {
        action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn', viewport: null,
      }, ctx) as ToolResult;
      expect(withNull.isError).toBeFalsy();
      const omitted = await handleTool('ui', {
        action: 'solve_from_current', project_path: dir, scene_path: 'res://main.tscn',
      }, ctx) as ToolResult;
      expect(omitted.isError).toBeFalsy();
      const ta = (withNull.content?.[0] as { text?: string }).text;
      const tb = (omitted.content?.[0] as { text?: string }).text;
      expect(ta).toBe(tb);
      const body = JSON.parse(tb ?? '{}') as { success: boolean; data: { viewport: unknown; skippedUnresolvedParent: string[] } };
      expect(body.success).toBe(true);
      expect(body.data.viewport).toBeNull();
      expect(body.data.skippedUnresolvedParent).toContain('C');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkViewportEffect 假绿防护判定(纯函数)', () => {
  const vp = { w: 800, h: 480 };
  const full = (w: number): MeasuredNode => ({
    path: 'Root', type: 'Control',
    rect: { x: 0, y: 0, w, h: 480 },
    anchors: { left: 0, right: 1, top: 0, bottom: 1 },
  });
  const partial = (x: number): MeasuredNode => ({
    path: 'P', type: 'Control',
    rect: { x, y: 10, w: 300, h: 50 },
    anchors: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  it('① 全铺判据:anchor 0→1 节点 rect.w 贴合注入视口宽 → effective', () => {
    expect(checkViewportEffect([full(800)], vp)).toBe('effective');
  });
  it('① 反向:全铺节点 rect.w 仍是默认视口宽(布局没按注入视口算)→ 不命中全铺判据', () => {
    expect(checkViewportEffect([full(960)], vp)).toBe('inconclusive');
  });
  it('② 基线判据:非全铺节点(rect.w < vp.w)相对基线 x 变化 → effective', () => {
    expect(checkViewportEffect([partial(100)], vp, [partial(50)])).toBe('effective');
  });
  it('② 反向:非全铺节点与基线完全一致(硬 offset 不随视口)→ inconclusive', () => {
    expect(checkViewportEffect([partial(100)], vp, [partial(100)])).toBe('inconclusive');
  });
  it('非全铺判定只看 rect.w < vp.w 的节点(≥vp.w 的全宽节点不参与基线比对)', () => {
    const wide = { ...partial(100), rect: { x: 0, y: 0, w: 800, h: 480 } };
    expect(checkViewportEffect([wide], vp, [{ ...wide, rect: { x: 9, y: 0, w: 800, h: 480 } }])).toBe('inconclusive');
  });
  it('空节点集 → inconclusive(无证据即诚实降级,不静默)', () => {
    expect(checkViewportEffect([], vp)).toBe('inconclusive');
  });
});

// ─── e2e: 生效性硬断言 ─────────────────────────────────────────────────────
// 无 autoload 最小 fixture:项目视口 1280×720,注入 800×480 后全铺根节点 rect.w 必须 800
// (而非 1280)——这是 viewport 覆写驱动重布局的直接证据(假绿防护的真机锚定)。
describe.skipIf(!hasGodot)('measure viewport 生效性(最小 fixture)', () => {
  let dir: string;

  beforeAll(() => {
    // e2e:executor 指回真实实现(文件头 mock 样板的 realExecutor 闭包)
    execMock.mockImplementation((...args: never[]) => realExecutor.fn!(...args));
    dir = mkdtempSync(join(tmpdir(), 'ui-measure-vp-'));
    // stretch=canvas_items 对齐靶子项目配置——无 stretch(disabled)项目 headless 布局按
    // Window.size(实测 64,不可信,C1 既有现象),plain 轮全铺 rect.w 无可信基准;
    // canvas_items 下 content_scale_size 驱动布局,plain 轮 rect.w=1280 可硬断言
    writeFileSync(join(dir, 'project.godot'),
      'config_version=5\n\n[display]\n\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\nwindow/stretch/mode="canvas_items"\n');
    // 全铺根(anchors_preset=15)+ 硬 offset 子(120px 宽,不随视口变)
    writeFileSync(join(dir, 'main.tscn'), `[gd_scene format=3]

[node name="Main" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Fixed" type="ColorRect" parent="."]
layout_mode = 0
offset_right = 120.0
offset_bottom = 60.0
`);
  });
  afterAll(() => { execMock.mockReset(); rmSync(dir, { recursive: true, force: true }); });

  async function measure(viewport?: { w: number; h: number }) {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH, projectPath: dir, timeout: 60, loadAutoloads: false,
      code: genUiMeasureScript(join(dir, 'main.tscn'), undefined, 16, undefined, viewport ? { viewport } : undefined),
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    const raw = res.outputs.find(o => o.key === 'measure');
    expect(raw, 'measure 输出存在').toBeDefined();
    return JSON.parse(String(raw!.value)) as {
      viewport: { w: number; h: number };
      nodes: Array<{ path: string; rect: { w: number; h: number } }>;
    };
  }

  it('默认视口 1280×720;注入 800×480 后全铺 Main rect.w=800(硬断言),上报 viewport=注入值', async () => {
    const plain = await measure();
    expect(plain.viewport).toEqual({ w: 1280, h: 720 });
    expect(plain.nodes.find(n => n.path === '.')!.rect.w).toBe(1280);

    const over = await measure({ w: 800, h: 480 });
    // 假绿防护核心断言:布局数据独立证明视口语境(而非仅上报值被改)
    expect(over.nodes.find(n => n.path === '.')!.rect.w).toBe(800);
    expect(over.nodes.find(n => n.path === '.')!.rect.h).toBe(480);
    expect(over.viewport).toEqual({ w: 800, h: 480 });
  }, 120_000);
});

// 靶子 e2e(双 skipIf):DotaLegendGodot 默认视口 960×540,注入 800×480 后场景根
// DailyLoginContent(anchors_preset=15 全铺)rect.w 应为 800 而非 960。
// 注:Bj 当前为硬 offset 758.5(tscn 注释"Panel > Bj 全铺"指铺满 Panel),不随视口变——
// 其数值仅记录(Task 7 solve_from_current 改造后才会跟随视口)。
describe.skipIf(!hasE2e)('measure viewport 靶子 e2e(DotaLegendGodot)', () => {
  beforeAll(() => {
    // e2e:executor 指回真实实现(文件头 mock 样板的 realExecutor 闭包)
    execMock.mockImplementation((...args: never[]) => realExecutor.fn!(...args));
  });
  afterAll(() => { execMock.mockReset(); });

  it('viewport 800×480:全铺场景根 rect.w=800(而非 960),Bj(硬 offset)记录数值', async () => {
    const res = await executeGdscriptTrusted({
      godotPath: GODOT_PATH, projectPath: TARGET_PROJECT, timeout: 60, loadAutoloads: false,
      code: genUiMeasureScript(
        join(TARGET_PROJECT, 'scenes/ui/daily_login_content.tscn'),
        undefined, 16, undefined, { viewport: { w: 800, h: 480 } },
      ),
    });
    expect(res.compile_success, res.compile_error).toBe(true);
    expect(res.run_success, res.run_error).toBe(true);
    const raw = res.outputs.find(o => o.key === 'measure');
    expect(raw, 'measure 输出存在').toBeDefined();
    const m = JSON.parse(String(raw!.value)) as {
      viewport: { w: number; h: number };
      nodes: Array<{ path: string; rect: { w: number; h: number } }>;
    };
    expect(m.viewport).toEqual({ w: 800, h: 480 });
    // 全铺根(唯一 anchors_preset=15 节点):视口生效的硬断言
    const root = m.nodes.find(n => n.path === '.');
    expect(root, '场景根在测量结果中').toBeDefined();
    expect(root!.rect.w).toBe(800);
    // Bj 硬 offset:数值记录(当前不随视口,Task 7 改造点)
    const bj = m.nodes.find(n => n.path === 'Panel/Bj');
    if (bj) console.log(`[vp-spike] 靶子 Panel/Bj rect.w(viewport 800)=${bj.rect.w}(硬 offset 758.5,Task 7 改造前不随视口)`);
  }, 120_000);
});

// handler 真跑链路(批1 1a Task 2 假绿防护编排):经 handleTool 全链(校验→生成→spawn→
// 后处理)验证 data.measure.viewport_check 两分支——全铺命中 effective / 子树无证据
// inconclusive(附指引警告)。
describe.skipIf(!hasE2e)('ui_measure_layout handler viewport 假绿防护(靶子真跑)', () => {
  beforeAll(() => {
    // e2e:executor 指回真实实现(文件头 mock 样板的 realExecutor 闭包)
    execMock.mockImplementation((...args: never[]) => realExecutor.fn!(...args));
  });
  afterAll(() => { execMock.mockReset(); });

  function realCtx(): ToolContext {
    return { findGodot: async () => GODOT_PATH } as unknown as ToolContext;
  }

  function parseBody(r: ToolResult | null) {
    expect(r).not.toBeNull();
    expect(r!.isError).toBeFalsy();
    return JSON.parse((r!.content?.[0] as { text?: string }).text ?? '{}') as {
      success: boolean;
      data: { measure: { viewport?: { w: number; h: number }; viewport_check?: string; nodes?: MeasuredNode[] } };
      warnings?: string[];
    };
  }

  it('整树 measure:全铺场景根 rect.w=800 命中主判据 → viewport_check effective', async () => {
    const body = parseBody(await handleTool('ui', {
      action: 'ui_measure_layout', project_path: TARGET_PROJECT,
      scene_path: 'res://scenes/ui/daily_login_content.tscn',
      viewport: { w: 800, h: 480 },
    }, realCtx()));
    expect(body.success).toBe(true);
    expect(body.data.measure.viewport).toEqual({ w: 800, h: 480 });
    expect(body.data.measure.viewport_check).toBe('effective');
  }, 180_000);

  it('node_path=Panel 子树(无全铺节点)→ inconclusive + 指引警告(诚实降级,不静默)', async () => {
    const body = parseBody(await handleTool('ui', {
      action: 'ui_measure_layout', project_path: TARGET_PROJECT,
      scene_path: 'res://scenes/ui/daily_login_content.tscn',
      node_path: '/root/Panel', viewport: { w: 800, h: 480 },
    }, realCtx()));
    expect(body.success).toBe(true);
    expect(body.data.measure.viewport_check).toBe('inconclusive');
    expect((body.warnings ?? []).join('\n')).toContain('viewport_check: inconclusive');
    expect((body.warnings ?? []).join('\n')).toContain('dump_layout_tree');
    // 子树测量:path 相对 _target(首个节点即 Panel 自身,path='.')
    expect(body.data.measure.nodes?.[0]?.path).toBe('.');
  }, 180_000);
});
