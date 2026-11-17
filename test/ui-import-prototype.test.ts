// test/ui-import-prototype.test.ts
// Task 2 TDD:ui_import_prototype 接线(spec docs/superpowers/specs/2026-08-16-prototype-import-design.md §2.3)。
// mock executeGdscriptTrusted 单段返回(PR-4 单 spawn 合成,spec §6:build+persist+reload(CACHE_MODE_IGNORE)+measure 一次调用),
// 断言:一次调用返回 {tree, build_warnings, measure, verify_coverage, layout_verify};
// geometry/geometry_path 二选一语义;路径逃逸拒绝;ACTIONS/TOOL_META/UI_PERSIST_ACTIONS 登记契约。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { mockSuccessResult } from './helpers/mock-results.js';
import { isolatePathEnv } from './helpers/path-isolation.js';

// vi.mock 提升优先于 import,共享 mock 引用须经 vi.hoisted(参照 test/android.test.ts 模式)
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(),
  executeGdscriptTrusted: execMock,
}));

// 批3 Task 3:pixel_verify $token 用例的 capture mock——构造与目标色一致的纯色 PNG
// (80x60 = viewport 800x600 等比,采样坐标线性缩放后仍命中目标色),不走真 Godot 窗口。
const { shotMock } = vi.hoisted(() => ({ shotMock: vi.fn() }));
vi.mock('../src/screenshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/screenshot.js')>();
  return { ...actual, captureScreenshot: shotMock };
});

import { executeGdscriptTrusted } from '../src/gdscript-executor.js';
import { handleTool, TOOL_META, getToolDefinitions } from '../src/tools/ui/index.js';
import { ACTIONS } from '../src/tools/ui/types.js';
import { SLIM_CONFIG } from '../src/module-loader.js';
import type { ToolResult } from '../src/types.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

// 两节点嵌套:Title(10,20,200,24) 完整落在 TopBar(0,0,800,60) 内 → 父子。
const GEO = {
  viewport: { w: 800, h: 600 },
  nodes: [
    { name: 'TopBar', rect: { x: 0, y: 0, w: 800, h: 60 }, bg: '#10141f' },
    { name: 'Title', rect: { x: 10, y: 20, w: 200, h: 24 }, text: '标题' },
  ],
};

// build 执行成功输出(单 spawn 合成脚本产物:persist;PR-4 尾部替换后真实脚本不输出 layout_built,
// 终审 M-2 已删该死键——mock shape 对齐真实输出)
function buildOutputs() {
  return [
    { key: 'persist', value: JSON.stringify({ saved: true }) },
  ];
}

// measure 执行成功输出(genUiMeasureScript 产物;rect 与翻译树精确一致 → diff 全绿)。
// path 形态:measure nodePath=/root(挂载父)时 get_path_to 相对场景根 = 树根名链,
// 与 flattenTargets(tree) 的 '_PrototypeRoot/...' 恰好对齐(expect_tree 注入段同款对齐前提)。
function measureOutputs(dOffset = 0) {
  return [{
    key: 'measure',
    value: JSON.stringify({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 800, h: 600 },
      nodes: [
        { path: '_PrototypeRoot', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 600 } },
        { path: '_PrototypeRoot/TopBar', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 60 } },
        { path: '_PrototypeRoot/TopBar/Title', type: 'Label', rect: { x: 10 + dOffset, y: 20, w: 200, h: 24 } },
      ],
    }),
  }];
}

/** 单段 mock(PR-4):一次 executor 调用合并返回 build(persist)+measure 输出。 */
function mockSinglePhase(dOffset = 0) {
  execMock.mockReset();
  execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [...buildOutputs(), ...measureOutputs(dOffset)] }));
}

function textOf(result: ToolResult | null, index = 0): string {
  const el = result?.content?.[index];
  if (!el || el.type !== 'text') throw new Error(`content[${index}] is not text`);
  return el.text;
}

function createCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null, setRunningProcess: vi.fn(),
    outputBuffer: [], setOutputBuffer: vi.fn(),
    processStartTime: 0, setProcessStartTime: vi.fn(),
    projectDir: '/fake/project', setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
  } as never;
}

// ─── 正常链路:inline geometry 一次调用翻译+build+measure+verify ──────────────

describe('ui_import_prototype 正常链路(inline geometry)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('返回 data 含 tree/build_warnings/measure/verify_coverage/layout_verify,executor 恰一次(单 spawn)', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());

    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.success).toBe(true);
    // tree:合成根 + 两节点
    expect(parsed.data.tree.name).toBe('_PrototypeRoot');
    expect(parsed.data.tree.children[0].name).toBe('TopBar');
    expect(parsed.data.tree.children[0].children[0].name).toBe('Title');
    // build_warnings:数组 + 容差模糊带使用提示(控制器落档项)
    expect(Array.isArray(parsed.data.build_warnings)).toBe(true);
    expect(parsed.data.build_warnings.join('\n')).toContain('2px');
    // measure:透传 measure 输出字段
    expect(parsed.data.measure.stable_after_frames).toBe(3);
    expect(parsed.data.measure.stalled).toBe(false);
    expect(parsed.data.measure.viewport).toEqual({ w: 800, h: 600 });
    // verify_coverage(B-2):targets 含合成根(2 输入 + 1 根 = 3),附 _note 语义说明
    expect(parsed.data.verify_coverage.targets).toBe(3);
    expect(parsed.data.verify_coverage.total_nodes).toBe(2);
    expect(typeof parsed.data.verify_coverage._note).toBe('string');
    // layout_verify:targets/diff 全绿/overlaps/out_of_bounds/viewport
    expect(parsed.data.layout_verify.targets).toHaveLength(3);
    expect(parsed.data.layout_verify.diff).toHaveLength(3);
    expect(parsed.data.layout_verify.diff.every((d: { ok: boolean }) => d.ok)).toBe(true);
    expect(parsed.data.layout_verify.overlaps).toEqual([]);
    expect(parsed.data.layout_verify.out_of_bounds).toEqual([]);
    expect(parsed.data.layout_verify.viewport).toEqual({ w: 800, h: 600 });

    // 单 spawn(PR-4):一次调用合成 build(含 persist 原子写)+reload+measure
    expect(execMock).toHaveBeenCalledTimes(1);
    const code = execMock.mock.calls[0]![0] as { code: string };
    expect(code.code).toContain('ResourceSaver.save');
    expect(code.code).toContain('_PrototypeRoot');
    expect(code.code).toContain('process_frame.connect');
    expect(code.code).toContain('ResourceLoader.CACHE_MODE_IGNORE');
    expect(code.code).toContain('call_deferred("_measure_go")');
  });

  it('固定持久化:build 脚本含 persist 块,返回不含 "退出即丢" ⚠ 提示(不入 UI_PERSIST_ACTIONS)', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());
    const firstCode = execMock.mock.calls[0]![0] as { code: string };
    expect(firstCode.code).toContain('persist');
    const allText = result!.content.map(el => (el.type === 'text' ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('tolerance 生效:偏移 3px 时默认容差 2 不绿,tolerance=5 绿', async () => {
    mockSinglePhase(3); // Title x 偏移 3px
    const r2 = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());
    const diff2 = JSON.parse(textOf(r2)).data.layout_verify.diff as Array<{ ok: boolean }>;
    expect(diff2.some(d => !d.ok)).toBe(true);

    mockSinglePhase(3);
    const r5 = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO, tolerance: 5,
    }, createCtx());
    const diff5 = JSON.parse(textOf(r5)).data.layout_verify.diff as Array<{ ok: boolean }>;
    expect(diff5.every(d => d.ok)).toBe(true);
  });

  it('geometry+geometry_path 同时给:geometry 优先 + warning 提示', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO, geometry_path: 'res://whatever.json',
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.data.build_warnings.join('\n')).toContain('geometry');
    // 只一次 executor(单 spawn 合成),geometry_path 未触发额外执行
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  // I-2(final review 声明式修复):parent_path 非 root → build_warnings 追加根级 diff 参照系限制提示
  it('parent_path 非 root → build_warnings 含根级 diff 参照系限制提示;默认 root 不提示', async () => {
    mockSinglePhase();
    const r1 = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO, parent_path: '/root/HUD',
    }, createCtx());
    expect(r1!.isError).toBeFalsy();
    const w1 = JSON.parse(textOf(r1)).data.build_warnings.join('\n');
    expect(w1).toContain('parent_path="/root/HUD"');
    expect(w1).toContain('原点对齐');
    expect(w1).toContain('根级 diff 恒误报');

    mockSinglePhase();
    const r2 = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());
    expect(r2!.isError).toBeFalsy();
    const w2 = JSON.parse(textOf(r2)).data.build_warnings.join('\n');
    expect(w2).not.toContain('根级 diff 恒误报');
  });

  // 审查遗留②:尾斜杠变体('root/' → 归一化为 '/root/')与 '/root' 语义等价,
  // 归一化判定(去尾斜杠)后不触发假阳性 warning;真子路径仍触发。
  it('parent_path 尾斜杠变体("root/","/root/")→ 不触发根级 diff 限制提示(假阳性修复)', async () => {
    for (const variant of ['root/', '/root/']) {
      mockSinglePhase();
      const r = await handleTool('ui', {
        action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
        geometry: GEO, parent_path: variant,
      }, createCtx());
      expect(r!.isError).toBeFalsy();
      const w = JSON.parse(textOf(r)).data.build_warnings.join('\n');
      expect(w).not.toContain('根级 diff 恒误报');
    }
  });

  it('错误透传:executor error 输出(Parent not found)→ isError 且 message 原样返回', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'error', value: 'Parent not found: /root' },
    ] }));
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Parent not found: /root');
    // PR-4 终审 M-1:锁 uiErrorMapper 谓词(msg 含 'not found' → NODE_NOT_FOUND,src/tools/ui/index.ts uiErrorMapper)
    expect(parsed.error_code).toBe('NODE_NOT_FOUND');
  });
});

// ─── geometry_path 文件读入 + res:// 剥离 ───────────────────────────────────

describe('ui_import_prototype geometry_path', () => {
  let tmpProj: string;
  let restore: () => void;

  beforeEach(() => {
    tmpProj = mkdtempSync(join(tmpdir(), 'ui-import-proto-'));
    writeFileSync(join(tmpProj, 'project.godot'), '[application]\nname="Test"\n');
    writeFileSync(join(tmpProj, 'geo.json'), JSON.stringify(GEO));
    // env 隔离:test/setup.js 全局 UNRESTRICTED=true,路径安全用例须清旁路 + 收白名单
    restore = isolatePathEnv({ allowed: [tmpProj] });
    vi.clearAllMocks();
  });
  afterEach(() => {
    restore();
    rmSync(tmpProj, { recursive: true, force: true });
  });

  it('相对路径读入成功', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry_path: 'geo.json',
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.data.tree.name).toBe('_PrototypeRoot');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('res:// 前缀被剥离,指向项目内合法文件成功', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry_path: 'res://geo.json',
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).data.verify_coverage.targets).toBe(3);
  });

  it('../ 逃逸 → INVALID_PARAMS,不触达 executor', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry_path: '../outside/evil.json',
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(textOf(result)).toMatch(/traversal|越权|非法/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('白名单外绝对路径 → INVALID_PARAMS', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry_path: join(tmpdir(), 'outside-evil.json'),
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('res:// 变体逃逸(res://../) → INVALID_PARAMS', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry_path: 'res://../evil.json',
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(execMock).not.toHaveBeenCalled();
  });
});

// ─── 输入校验负向 ───────────────────────────────────────────────────────────

describe('ui_import_prototype 输入校验', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('geometry 与 geometry_path 都不给 → INVALID_PARAMS', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('parseGeometry 失败(schema 违规)透传 INVALID_PARAMS + 详情', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: { viewport: { w: 800, h: 600 }, nodes: [{ name: 'X' }] }, // 缺 rect
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(textOf(result)).toContain('geometry schema');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('翻译失败(交叉重叠)透传 INVALID_PARAMS,不触达 executor', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: {
        viewport: { w: 800, h: 600 },
        nodes: [
          { name: 'A', rect: { x: 0, y: 0, w: 100, h: 50 } },
          { name: 'B', rect: { x: 50, y: 0, w: 100, h: 50 } }, // 与 A 交叉互不包含
        ],
      },
    }, createCtx());
    expect(result!.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PARAMS');
    expect(execMock).not.toHaveBeenCalled();
  });
});

// ─── 登记契约:ACTIONS / TOOL_META / schema / SLIM_CONFIG ────────────────────

describe('ui_import_prototype 登记契约', () => {
  it('ACTIONS 数组含 ui_import_prototype', () => {
    expect(ACTIONS).toContain('ui_import_prototype');
  });

  it('schema action enum 含 ui_import_prototype,且声明 geometry/geometry_path/tolerance', () => {
    const defs = getToolDefinitions();
    const schema = defs[0]!.inputSchema as { properties: Record<string, unknown> };
    expect((schema.properties.action as { enum: string[] }).enum).toContain('ui_import_prototype');
    expect(schema.properties.geometry).toBeTruthy();
    expect(schema.properties.geometry_path).toBeTruthy();
    expect(schema.properties.tolerance).toBeTruthy();
    // I-2:parent_path schema 声明原点对齐限制(ui_build_layout 与 ui_import_prototype 共用参数)
    expect(String((schema.properties.parent_path as { description?: string }).description)).toContain('原点对齐');
  });

  it('TOOL_META actionRisks: ui_import_prototype 为 write(satisfies 护卫)', () => {
    expect(TOOL_META.ui!.actionRisks!.ui_import_prototype).toBe('write');
  });

  it('SLIM_CONFIG: ui 条目已移除(P8-3),geometry/geometry_path 留在 schema(unknown-param 拒绝语义下键不可砍)', () => {
    expect(SLIM_CONFIG['ui'], 'P8-3 (2026-09-12) 移除——schema 是参数 SSOT').toBeUndefined();
    const uiDef = getToolDefinitions().find(d => d.name === 'ui');
    expect(uiDef, 'ui def').toBeDefined();
    const props = Object.keys(uiDef!.inputSchema.properties ?? {});
    expect(props).toContain('geometry');
    expect(props).toContain('geometry_path');
  });

  it('ui_import_prototype 的 style_verify/flow_verify 返回说明留在工具 description(不依赖 descHint)', () => {
    // P2-11 时代此说明在 SLIM_CONFIG descHint(slim 时追加);P8-3 移除条目后,
    // 说明常驻源 description——unknown-param 语义下 schema/description 不撒谎
    const uiDef = getToolDefinitions().find(d => d.name === 'ui');
    expect(uiDef!.description).toContain('style_verify');
    expect(uiDef!.description).toContain('ui_import_prototype');
  });
});

// ─── PR-2 Task 4: import 链 style_verify/flow_verify 接线 ───────────────────

// geometry: Card(Panel bg+radius+border)+ Holder(flow row)→ BtnA(Button bg,flow 直接子)。
// 颜色归一 target: '#1a1f2e'→[26,31,46]/255, '#3ddc84'→[61,220,132]/255, '#3d5afe'→[61,90,254]/255。
const GEO_STYLE = {
  viewport: { w: 800, h: 600 },
  nodes: [
    { name: 'Card', rect: { x: 40, y: 40, w: 320, h: 200 },
      bg: '#1a1f2e', borderRadius: 12, border: { width: 2, color: '#3ddc84' } },
    { name: 'Holder', rect: { x: 0, y: 300, w: 400, h: 40 }, flow: 'row' },
    { name: 'BtnA', rect: { x: 100, y: 304, w: 72, h: 32 },
      interactive: true, text: '按钮A', bg: '#3d5afe' },
  ],
};

/** PR-2 measure mock:nodes[].styles 按 GD _walk 产出真实形状(flat:true 时四组字段
 * 全产出:slot/flat/bg_color/corner_radius/border_width/border_color)。Card 的
 * bg/border 读回值带 float32 漂移级差异(与归一 target 差 ≤0.002 → STYLE_COLOR_TOL 内绿);
 * dropStyles=true 模拟 override 没设上场景(节点无 styles 字段)。 */
function styleMeasureOutputs(dropStyles = false) {
  const withStyles = (slot: string, r: {
    bg: number[]; corner: { tl: number; tr: number; br: number; bl: number }; bw: number; bc: number[];
  }) => (dropStyles ? {} : {
    styles: [{
      slot, flat: true,
      bg_color: r.bg,
      corner_radius: r.corner,
      border_width: { left: r.bw, top: r.bw, right: r.bw, bottom: r.bw },
      border_color: r.bc,
    }],
  });
  return [{
    key: 'measure',
    value: JSON.stringify({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 800, h: 600 },
      nodes: [
        { path: '_PrototypeRoot', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 600 } },
        { path: '_PrototypeRoot/Card', type: 'Panel', rect: { x: 40, y: 40, w: 320, h: 200 },
          ...withStyles('panel', {
            bg: [0.102, 0.122, 0.18, 1],                 // '#1a1f2e' 归一值的漂移级差异
            corner: { tl: 12, tr: 12, br: 12, bl: 12 },
            bw: 2, bc: [0.24, 0.863, 0.518, 1],           // '#3ddc84' 归一值的漂移级差异
          }) },
        { path: '_PrototypeRoot/Holder', type: 'Panel', rect: { x: 0, y: 300, w: 400, h: 40 } },
        { path: '_PrototypeRoot/Holder/Holder_Flow', type: 'HBoxContainer', rect: { x: 0, y: 300, w: 400, h: 40 } },
        { path: '_PrototypeRoot/Holder/Holder_Flow/BtnA', type: 'Button', rect: { x: 100, y: 304, w: 72, h: 32 },
          ...withStyles('normal', {
            bg: [61 / 255, 90 / 255, 254 / 255, 1],       // '#3d5afe' 精确归一值(delta=0)
            corner: { tl: 0, tr: 0, br: 0, bl: 0 }, bw: 0, bc: [0, 0, 0, 1],
          }) },
      ],
    }),
  }];
}

function mockSinglePhaseStyles(dropStyles = false) {
  execMock.mockReset();
  execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [...buildOutputs(), ...styleMeasureOutputs(dropStyles)] }));
}

interface StyleVerifyEntry {
  path: string;
  slot: string;
  field: string;
  delta: number | number[] | null;
  ok: boolean;
}

describe('ui_import_prototype 返回 style_verify/flow_verify(PR-2)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('stylebox+flow geometry → style_verify 全绿(含 Card/panel bg_color)+ flow_verify 覆盖 BtnA + measure 脚本内嵌期望清单', async () => {
    mockSinglePhaseStyles();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_STYLE,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));

    // 1. style_verify 全绿;含 Card/panel 的 bg_color 条目(delta ≤0.002,float32 容差)
    const sv = parsed.data.style_verify as StyleVerifyEntry[];
    expect(Array.isArray(sv)).toBe(true);
    expect(sv.length).toBeGreaterThan(0);
    expect(sv.every(e => e.ok)).toBe(true);
    const cardBg = sv.find(e => e.path === '_PrototypeRoot/Card' && e.slot === 'panel' && e.field === 'bg_color');
    expect(cardBg).toBeTruthy();
    expect(Math.max(...(cardBg!.delta as number[]).map(Math.abs))).toBeLessThanOrEqual(0.002);
    // Card box 四组显式字段均产出条目(corner×4/border_width×4/border_color)+ BtnA normal bg_color
    expect(sv.some(e => e.field === 'corner_radius_top_left')).toBe(true);
    expect(sv.some(e => e.field === 'border_width_left')).toBe(true);
    expect(sv.some(e => e.field === 'border_color')).toBe(true);
    expect(sv.some(e => e.path.endsWith('/BtnA') && e.slot === 'normal' && e.field === 'bg_color')).toBe(true);

    // 2. flow_verify:1 条 BtnA,期望=输入视口 rect,actual(measure global rect)直接对比 ok
    const fv = parsed.data.flow_verify as Array<{
      path: string; target: { x: number; y: number; w: number; h: number };
      actual: { x: number; y: number; w: number; h: number }; ok: boolean;
    }>;
    expect(fv).toHaveLength(1);
    expect(fv[0]!.path).toBe('_PrototypeRoot/Holder/Holder_Flow/BtnA');
    expect(fv[0]!.target).toEqual({ x: 100, y: 304, w: 72, h: 32 });
    expect(fv[0]!.ok).toBe(true);

    // 3. verify_coverage._note 含 flow_verify 措辞(不再只说 screenshot diff 兜底)
    expect(String(parsed.data.verify_coverage._note)).toContain('flow_verify');

    // 4. 单 spawn 脚本内嵌期望清单:唯一调用 code 含 JSON 内嵌 path→slots
    expect(execMock).toHaveBeenCalledTimes(1);
    const code = execMock.mock.calls[0]![0] as { code: string };
    expect(code.code).toContain('JSON.parse_string');
    expect(code.code).toContain('Holder_Flow');
  });

  it('无 stylebox 无 flow 的 geometry → style_verify=[] 且 flow_verify=[],合成脚本不注入期望清单', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      ...buildOutputs(),
      {
        key: 'measure',
        value: JSON.stringify({
          stable_after_frames: 3,
          stalled: false,
          viewport: { w: 800, h: 600 },
          nodes: [
            { path: '_PrototypeRoot', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 600 } },
            { path: '_PrototypeRoot/Bar', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 60 } },
            { path: '_PrototypeRoot/Bar/Title', type: 'Label', rect: { x: 10, y: 20, w: 200, h: 24 } },
          ],
        }),
      },
    ] }));
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: {
        viewport: { w: 800, h: 600 },
        nodes: [
          { name: 'Bar', rect: { x: 0, y: 0, w: 800, h: 60 } },               // 推断布局壳 Panel,无样式
          { name: 'Title', rect: { x: 10, y: 20, w: 200, h: 24 }, text: '标题' }, // Label,无样式
        ],
      },
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.data.style_verify).toEqual([]);
    expect(parsed.data.flow_verify).toEqual([]);
    // 空期望清单 → 合成脚本不注入 JSON.parse_string
    const code = execMock.mock.calls[0]![0] as { code: string };
    expect(code.code).not.toContain('JSON.parse_string');
  });

  it('styles 缺失(override 没设上场景)→ style_verify 出 (reading missing) 红条目', async () => {
    mockSinglePhaseStyles(true);
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_STYLE,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const sv = JSON.parse(textOf(result)).data.style_verify as StyleVerifyEntry[];
    // Card/panel 与 BtnA/normal 两个期望全部落空
    expect(sv.some(e => e.field === '(reading missing)' && !e.ok)).toBe(true);
    expect(sv.every(e => !e.ok)).toBe(true);
  });
});

// ─── 批3 Task 3: $token 预取 + import/pixel_verify 双链接线 ─────────────────

// 单节点 $token geometry:bg '$brand'(resolve 后字面量 [0.5,0.25,0.75,1])。
const GEO_TOKEN = {
  viewport: { w: 800, h: 600 },
  nodes: [
    { name: 'P', rect: { x: 0, y: 0, w: 100, h: 60 }, bg: '$brand' },
  ],
};

const TTHEME = 'res://themes/tokens.tres';

/** 预取段 mock:token_map 输出(genTokenPrefetchScript 产物形状)。 */
function tokenMapOutputs(colors: Record<string, number[]>) {
  return [{ key: 'token_map', value: JSON.stringify({ colors }) }];
}

/** $token 版 measure 输出:P 带 panel 槽 styles(读回值=解析字面量,delta=0 全绿)。 */
function tokenMeasureOutputs() {
  return [{
    key: 'measure',
    value: JSON.stringify({
      stable_after_frames: 3,
      stalled: false,
      viewport: { w: 800, h: 600 },
      nodes: [
        { path: '_PrototypeRoot', type: 'Panel', rect: { x: 0, y: 0, w: 800, h: 600 } },
        { path: '_PrototypeRoot/P', type: 'Panel', rect: { x: 0, y: 0, w: 100, h: 60 },
          styles: [{
            slot: 'panel', flat: true,
            bg_color: [0.5, 0.25, 0.75, 1],
            corner_radius: { tl: 0, tr: 0, br: 0, bl: 0 },
            border_width: { left: 0, top: 0, right: 0, bottom: 0 },
            border_color: [0, 0, 0, 1],
          }] },
      ],
    }),
  }];
}

describe('ui_import_prototype $token 预取(批3 Task 3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('带 $bg + theme_path:预取→build 两段式(第一次 code 含 get_color_list,loadAutoloads=false),成功且 tokens_resolved 挂出', async () => {
    execMock.mockReset();
    // 两段式:第一次预取 spawn(token_map),第二次 build+measure 单 spawn 合成
    execMock
      .mockResolvedValueOnce(mockSuccessResult({ outputs: tokenMapOutputs({ brand: [0.5, 0.25, 0.75, 1] }) }))
      .mockResolvedValueOnce(mockSuccessResult({ outputs: [...buildOutputs(), ...tokenMeasureOutputs()] }));

    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN, theme_path: TTHEME,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.success).toBe(true);

    // 预取段:恰两次 executor 调用;第一次 code 是预取脚本(含 get_color_list),且不开 autoload
    expect(execMock).toHaveBeenCalledTimes(2);
    const prefetchCall = execMock.mock.calls[0]![0] as { code: string; loadAutoloads?: boolean; timeout?: number };
    expect(prefetchCall.code).toContain('get_color_list');
    expect(prefetchCall.loadAutoloads).toBe(false);
    expect(prefetchCall.timeout).toBe(30);
    // 第二次是 build+measure 合成脚本
    const buildCall = execMock.mock.calls[1]![0] as { code: string };
    expect(buildCall.code).toContain('ResourceSaver.save');

    // bg 已解析为字面量:翻译树 P 的 panel 槽 bg_color
    const p = parsed.data.tree.children.find((c: { name: string }) => c.name === 'P');
    expect(p.styleboxes[0].box.bg_color).toEqual([0.5, 0.25, 0.75, 1]);

    // tokens_resolved:refs=geometry 内 $ 引用次数,tokens=去重已解析名(与主题总 token 数解耦)
    expect(parsed.data.tokens_resolved).toEqual({ theme_path: TTHEME, refs: 1, tokens: ['brand'] });
  });

  it('无 $ 引用 → 恰一次调用(零预取 spawn),data 无 tokens_resolved', async () => {
    mockSinglePhase();
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(textOf(result)).data.tokens_resolved).toBeUndefined();
  });

  it('$ 引用而无 theme_path → INVALID_PARAMS(含 theme_path 指引),零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('theme_path');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('预取 map 缺键 → TOKEN_NOT_FOUND(前缀分流锚,非 INVALID_PARAMS)', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: tokenMapOutputs({ other: [0, 0, 0, 1] }) }));
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN, theme_path: TTHEME,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('TOKEN_NOT_FOUND');
    expect(body.error).toContain('brand');
    expect(body.error).toContain(TTHEME);
    // 失败于预取解析段,build 段未触达
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('预取 error 输出(theme_path load failed)→ THEME_NOT_FOUND', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'error', value: `theme_path load failed: ${TTHEME}` },
    ] }));
    const result = await handleTool('ui', {
      action: 'ui_import_prototype', project_path: '/fake/p', scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN, theme_path: TTHEME,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('THEME_NOT_FOUND');
    expect(body.error).toContain('theme_path load failed');
  });
});

// ─── 批3 Task 3: ui_pixel_verify $token 链(capture mock,采样基准=解析后字面量)───

describe('ui_pixel_verify $token 预取(批3 Task 3)', () => {
  let tmpProj: string;
  let restore: () => void;

  beforeEach(() => {
    tmpProj = mkdtempSync(join(tmpdir(), 'ui-pv-token-'));
    writeFileSync(join(tmpProj, 'project.godot'), '[application]\nname="Test"\n');
    // capture mock:写与解析后目标色一致的纯色 PNG(80x60;viewport 800x600 → 线性缩放采样)
    shotMock.mockReset();
    shotMock.mockImplementation((params: { outputPath: string }) => {
      mkdirSync(join(params.outputPath, '..'), { recursive: true });
      const png = new PNG({ width: 80, height: 60 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 128; png.data[i + 1] = 64; png.data[i + 2] = 191; png.data[i + 3] = 255;
      }
      writeFileSync(params.outputPath, PNG.sync.write(png));
      return Promise.resolve({ success: true, godotOutput: '' });
    });
    // env 隔离:test/setup.js 全局 UNRESTRICTED=true,路径安全用例须清旁路 + 收白名单
    restore = isolatePathEnv({ allowed: [tmpProj] });
    vi.clearAllMocks();
  });
  afterEach(() => {
    restore();
    rmSync(tmpProj, { recursive: true, force: true });
  });

  it('带 $bg + theme_path:capture 采样链收解析后字面量 bg(target 换算 0-255 全过)', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: tokenMapOutputs({ brand: [0.5, 0.25, 0.75, 1] }) }));
    const result = await handleTool('ui', {
      action: 'ui_pixel_verify', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN, theme_path: TTHEME,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.success).toBe(true);
    const nodes = parsed.data.pixel_verify.nodes as Array<{ target: number[]; ok: boolean }>;
    expect(nodes).toHaveLength(1);
    // collectBgTargets 收到解析后字面量 bg:[0.5,0.25,0.75,1] → round(*255) = [128,64,191]
    expect(nodes[0]!.target).toEqual([128, 64, 191]);
    expect(nodes[0]!.ok).toBe(true);
    // 预取段恰一次(capture 走 screenshot mock,不经 executor)
    expect(execMock).toHaveBeenCalledTimes(1);
    const prefetchCall = execMock.mock.calls[0]![0] as { code: string };
    expect(prefetchCall.code).toContain('get_color_list');
  });

  it('$ 引用而无 theme_path → INVALID_PARAMS(非 SCRIPT_EXEC_FAILED),零 spawn 零 capture', async () => {
    const result = await handleTool('ui', {
      action: 'ui_pixel_verify', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('theme_path');
    expect(execMock).not.toHaveBeenCalled();
    expect(shotMock).not.toHaveBeenCalled();
  });

  it('预取 map 缺键 → TOKEN_NOT_FOUND(解析层前缀分流,不冒 SCRIPT_EXEC_FAILED)', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: tokenMapOutputs({}) }));
    const result = await handleTool('ui', {
      action: 'ui_pixel_verify', project_path: tmpProj, scene_path: 'res://scene.tscn',
      geometry: GEO_TOKEN, theme_path: TTHEME,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('TOKEN_NOT_FOUND');
    expect(body.error).toContain('brand');
    expect(shotMock).not.toHaveBeenCalled();
  });
});

// ─── 批3 Task 4: token_set/token_list handler 接线 ───────────────────────────

describe('token_set/token_list(批3 Task 4)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('契约:ACTIONS 含两新值;actionRisks token_set=write/token_list=read;schema 声明 token_name/token_value', () => {
    expect(ACTIONS).toContain('token_set');
    expect(ACTIONS).toContain('token_list');
    expect(TOOL_META.ui!.actionRisks!.token_set).toBe('write');
    expect(TOOL_META.ui!.actionRisks!.token_list).toBe('read');
    const defs = getToolDefinitions();
    const schema = defs[0]!.inputSchema as { properties: Record<string, unknown> };
    // action enum 登记两新值(unknown-action 语义下 enum 是路由 SSOT)
    expect((schema.properties.action as { enum: string[] }).enum).toContain('token_set');
    expect((schema.properties.action as { enum: string[] }).enum).toContain('token_list');
    // SSOT:schema 声明两新参数(handler 私读键须入 schema,check:ssot-params 锚)
    expect(schema.properties.token_name).toBeTruthy();
    expect(schema.properties.token_value).toBeTruthy();
    // 白名单提示留在 token_name description
    expect(String((schema.properties.token_name as { description?: string }).description)).toContain('A-Za-z');
  });

  it('token_set 缺 theme_path → INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', token_name: 'brand', token_value: 8,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('theme_path');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_set 缺 token_name → INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres', token_value: 8,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('token_name');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_set 缺 token_value → INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres', token_name: 'brand',
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('token_value');
    expect(execMock).not.toHaveBeenCalled();
  });

  it.each(['1abc', 'a b'])('token_set token_name 非白名单(%s)→ INVALID_PARAMS,零 spawn', async (bad) => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
      token_name: bad, token_value: 8,
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('token_name');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_set token_value 非法字符串("red")→ INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
      token_name: 'brand', token_value: 'red',
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('token_value');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_set color 数组含非有限数([0.5, "x", 1])→ INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
      token_name: 'brand', token_value: [0.5, 'x', 1],
    } as Record<string, unknown>, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_set 合法 color → 一次 spawn,code 含 set_color + 原子落盘段', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'token_set', value: JSON.stringify({ name: 'brand', path: 'res://themes/t.tres', kind: 'color' }) },
    ] }));
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
      token_name: 'brand', token_value: [0.5, 0.25, 0.75, 1],
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    expect(execMock).toHaveBeenCalledTimes(1);
    const call = execMock.mock.calls[0]![0] as { code: string };
    expect(call.code).toContain('set_color("brand"');
    expect(call.code).toContain('Color(0.5, 0.25, 0.75, 1)');
    expect(call.code).toContain('ResourceSaver.save');
  });

  it('token_set 合法 number → code 含 set_constant', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'token_set', value: JSON.stringify({ name: 'space_1', path: 'res://themes/t.tres', kind: 'constant' }) },
    ] }));
    const result = await handleTool('ui', {
      action: 'token_set', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
      token_name: 'space_1', token_value: 8,
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    const call = execMock.mock.calls[0]![0] as { code: string };
    expect(call.code).toContain('set_constant("space_1"');
  });

  it('token_list 缺 theme_path → INVALID_PARAMS,零 spawn', async () => {
    const result = await handleTool('ui', {
      action: 'token_list', project_path: '/fake/p',
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('INVALID_PARAMS');
    expect(body.error).toContain('theme_path');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('token_list 合法 → 一次 spawn,code 含 get_color_list + get_constant_list', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'token_list', value: JSON.stringify({ colors: {}, constants: {} }) },
    ] }));
    const result = await handleTool('ui', {
      action: 'token_list', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
    }, createCtx());
    expect(result!.isError).toBeFalsy();
    expect(execMock).toHaveBeenCalledTimes(1);
    const call = execMock.mock.calls[0]![0] as { code: string };
    expect(call.code).toContain('get_color_list');
    expect(call.code).toContain('get_constant_list');
  });

  it('mapper 顺序修正:theme file not found → THEME_NOT_FOUND(非 NODE_NOT_FOUND,不被首位 not found 截胡)', async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'error', value: 'theme file not found: res://themes/t.tres(先 theme_create(scene_path+save_path) 或 ui_set_theme create+save 建主题)' },
    ] }));
    const result = await handleTool('ui', {
      action: 'token_list', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('THEME_NOT_FOUND');
    expect(body.error).toContain('theme file not found');
  });

  it("mapper 'load failed' 收紧为全前缀:Scene reload failed → SCRIPT_EXEC_FAILED(非 THEME_NOT_FOUND,终审 Important-1)", async () => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce(mockSuccessResult({ outputs: [
      { key: 'error', value: 'Scene reload failed (post-persist): res://x.tscn —— build 已持久化,可重跑 ui_measure_layout' },
    ] }));
    const result = await handleTool('ui', {
      action: 'token_list', project_path: '/fake/p', theme_path: 'res://themes/t.tres',
    }, createCtx());
    expect(result!.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body.error_code).toBe('SCRIPT_EXEC_FAILED');
    expect(body.error).not.toContain('THEME_NOT_FOUND');
  });
});
