// C5 fix 回归测试：appendRuntimePersistWarning 必须不可变追加独立 content 元素，
// 不能 mutate content[0].text（parseGdscriptResult 返回 content[0] 是 JSON 字符串，
// 末尾追加 "\n⚠ ..." 会破坏 JSON.parse 消费契约——MCP 客户端用 JSON.parse(result.content[0].text)）。
//
// 防假绿：5 工具（audio/particles/signal/tilemap/animation）handleTool 成功路径必须：
//   1. content[0].text 仍是合法 JSON（JSON.parse 成功，且不含 ⚠）
//   2. content[1] 是独立 warning text（含 ⚠ + action 名）

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../src/types.js';
import { mockSuccessResult } from './helpers/mock-results.js';

const SUCCESS_RESULT = mockSuccessResult({
  outputs: [{ key: 'result', value: '{"ok":true}' }],
});

vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => SUCCESS_RESULT),
  executeGdscriptRuntime: vi.fn(async () => SUCCESS_RESULT),
  executeGdscriptTrusted: vi.fn(async () => SUCCESS_RESULT),
}));

import { appendRuntimePersistWarning } from '../src/tools/shared/persistence-warning.js';
import { handleTool as audioHandle } from '../src/tools/audio-ops.js';
import { handleTool as particlesHandle } from '../src/tools/particles.js';
import { handleTool as signalHandle } from '../src/tools/signal-ops.js';
import { handleTool as tilemapHandle } from '../src/tools/tilemap-ops.js';
import { handleTool as animationHandle } from '../src/tools/animation/animation-ops.js';
import { handleTool as node3dHandle } from '../src/tools/node-3d-ops.js';
import { handleTool as physicsHandle } from '../src/tools/physics-ops.js';
import { handleTool as navHandle } from '../src/tools/navigation.js';
import { handleTool as materialHandle } from '../src/tools/material-ops.js';
import { handleTool as uiHandle } from '../src/tools/ui/index.js';
import { executeGdscriptTrusted } from '../src/gdscript-executor.js';

// Minor4: 收窄 content 元素 union 到 text 类型，消除 .text 在非 text 元素上的 undefined 访问
function isTextContent(el: ToolResult['content'][number]): el is { type: 'text'; text: string } {
  return el.type === 'text';
}

function textOf(result: ToolResult | null, index: number): string {
  if (!result || !result.content[index] || !isTextContent(result.content[index])) {
    throw new Error(`content[${index}] is not a text element`);
  }
  return result.content[index].text;
}

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
  };
}

// ─── helper 单元测试 ─────────────────────────────────────────────────────────

describe('appendRuntimePersistWarning 不可变契约', () => {
  it('content[0] 不被 mutate（原 JSON 字符串仍可 JSON.parse）', () => {
    const original = '{"success":true,"data":{"ok":1}}';
    const input: ToolResult = {
      content: [{ type: 'text', text: original }],
    } as ToolResult;
    const out = appendRuntimePersistWarning(input, 'audio_play');
    // 原对象不被 mutate
    expect(input.content[0].text).toBe(original);
    expect(input.content.length).toBe(1);
    // 输出 content[0] 仍是合法 JSON
    expect(() => JSON.parse(out.content[0].text)).not.toThrow();
    expect(JSON.parse(out.content[0].text).success).toBe(true);
    // 输出追加了 content[1] warning
    expect(out.content.length).toBe(2);
    expect(out.content[1].type).toBe('text');
    expect(out.content[1].text).toContain('⚠');
    expect(out.content[1].text).toContain('audio_play');
  });

  it('isError=true 时不追加 warning（错误结果保持原样）', () => {
    const input: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: '{"error":"FAILED"}' }],
    } as ToolResult;
    const out = appendRuntimePersistWarning(input, 'audio_play');
    expect(out.content.length).toBe(1);
    expect(out.content[0].text).toBe('{"error":"FAILED"}');
  });

  it('复用场景：连续两次调同一输入，原 content[0] 不被破坏（不可变关键）', () => {
    const original = '{"success":true}';
    const base: ToolResult = {
      content: [{ type: 'text', text: original }],
    } as ToolResult;
    const out1 = appendRuntimePersistWarning(base, 'particles_create');
    const out2 = appendRuntimePersistWarning(base, 'signal_connect');
    // base 对象始终未被 mutate
    expect(base.content[0].text).toBe(original);
    expect(base.content.length).toBe(1);
    // 两次输出各自独立
    expect(out1.content[1].text).toContain('particles_create');
    expect(out2.content[1].text).toContain('signal_connect');
    expect(out1).not.toBe(out2);
    expect(out1.content[0].text).toBe(original);
  });
});

// ─── textOf / isTextContent helper 单元测试 ──────────────────────────────────

describe('textOf / isTextContent helper', () => {
  it('textOf(null, 0) 抛错（null 结果）', () => {
    expect(() => textOf(null, 0)).toThrow(/content\[0\] is not a text element/);
  });

  it('textOf({content: []}, 0) 抛错（越界）', () => {
    const empty: ToolResult = { content: [] } as ToolResult;
    expect(() => textOf(empty, 0)).toThrow(/content\[0\] is not a text element/);
  });

  it('textOf 非 text 元素抛错（image 元素无 .text）', () => {
    const img: ToolResult = {
      content: [{ type: 'image', data: '', mimeType: '' }],
    } as ToolResult;
    expect(() => textOf(img, 0)).toThrow(/content\[0\] is not a text element/);
  });

  it('textOf 返回 text 元素的 .text 字段', () => {
    const txt: ToolResult = {
      content: [{ type: 'text', text: 'hello' }],
    } as ToolResult;
    expect(textOf(txt, 0)).toBe('hello');
  });

  it('isTextContent 对 text 元素返回 true', () => {
    expect(isTextContent({ type: 'text', text: 'x' })).toBe(true);
  });

  it('isTextContent 对非 text 元素返回 false', () => {
    expect(isTextContent({ type: 'image', data: '', mimeType: '' })).toBe(false);
  });
});

// ─── 5 工具端到端 JSON.parse 契约 ────────────────────────────────────────────

describe('5 工具 handleTool 成功路径：content[0] 仍是合法 JSON + content[1] 是 warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    {
      label: 'audio audio_play',
      handle: audioHandle,
      toolName: 'audio',
      args: { action: 'audio_play', project_path: '/fake/p', node_path: 'root/Audio', stream_path: 'res://sounds/bg.ogg' },
      expectAction: 'audio_play',
    },
    {
      label: 'particles particles_create',
      handle: particlesHandle,
      toolName: 'particles',
      args: { action: 'particles_create', project_path: '/fake/p', node_type: 'GPUParticles3D', name: 'Fire' },
      expectAction: 'particles_create',
    },
    {
      label: 'signal signal_connect',
      handle: signalHandle,
      toolName: 'signal',
      args: {
        action: 'signal_connect', project_path: '/fake/p',
        source_path: 'root/A', signal_name: 'hit', target_path: 'root/B', method_name: 'on_hit',
      },
      expectAction: 'signal_connect',
    },
    {
      label: 'tilemap tilemap_read',
      handle: tilemapHandle,
      toolName: 'tilemap',
      args: { action: 'tilemap_read', project_path: '/fake/p', node_path: 'root/Map' },
      expectAction: 'tilemap_read',
    },
    {
      label: 'animation list_players',
      handle: animationHandle,
      toolName: 'animation',
      args: { action: 'list_players', project_path: '/fake/p' },
      expectAction: 'animation_list_players',
    },
  ];

  for (const c of cases) {
    it(`${c.label}: content[0] 可 JSON.parse，content[1] 含 ⚠ + ${c.expectAction}`, async () => {
      const result = await c.handle(c.toolName, c.args, createMockCtx() as any);
      expect(result).not.toBeNull();
      expect(result!.isError).toBeFalsy();
      // 关键断言 1：content[0].text 必须是合法 JSON
      expect(typeof result!.content[0].text).toBe('string');
      const parsed = JSON.parse(result!.content[0].text); // 抛 SyntaxError 即测试失败
      expect(parsed).toBeTruthy();
      // 关键断言 2：content[0].text 不含 warning 标记（未被 mutate）
      expect(result!.content[0].text).not.toContain('⚠');
      expect(result!.content[0].text).not.toContain(c.expectAction);
      // 关键断言 3：content[1] 是独立 warning text
      expect(result!.content.length).toBeGreaterThanOrEqual(2);
      const warning = result!.content.find(
        (el, i) => i > 0 && el.type === 'text' && el.text.includes('⚠'),
      );
      expect(warning).toBeDefined();
      expect(warning!.text).toContain(c.expectAction);
    });
  }
});

// ─── follow-up Task 1: node-3d 包装 ──────────────────────────────────────────

describe('follow-up: node-3d node_create_3d 包装', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('node_create_3d: content[0] 可 JSON.parse + content[1] 含 ⚠ + node_create_3d', async () => {
    const result = await node3dHandle(
      'node_create_3d',
      { project_path: '/fake/p', type: 'Node3D', name: 'TestNode' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    // content[0] 仍是合法 JSON，未被 mutate（用 textOf 收窄类型）
    expect(() => JSON.parse(textOf(result, 0))).not.toThrow();
    expect(textOf(result, 0)).not.toContain('⚠');
    // content[1] 是独立 warning
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('node_create_3d');
  });
});

// ─── follow-up Task 2: physics 包装 ──────────────────────────────────────────

describe('follow-up: physics collision_overlay 包装 + 只读 action 不加', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('physics collision_overlay（创造运行时节点树）: content[1] 含 ⚠ + physics_collision_overlay', async () => {
    const result = await physicsHandle(
      'physics',
      { project_path: '/fake/p', action: 'collision_overlay', parent_path: 'root' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    expect(() => JSON.parse(textOf(result, 0))).not.toThrow();
    expect(textOf(result, 0)).not.toContain('⚠');
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('physics_collision_overlay');
  });

  // 反向（A3：只读 action 每 Set ≥2，防误加 Set 漏抓）
  it('physics raycast（只读）: 返回不含 ⚠', async () => {
    const result = await physicsHandle(
      'physics',
      { project_path: '/fake/p', action: 'raycast', from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: -1, z: 0 } },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('physics query_spatial（只读）: 返回不含 ⚠', async () => {
    const result = await physicsHandle(
      'physics',
      { project_path: '/fake/p', action: 'query_spatial', center: { x: 0, y: 0, z: 0 } },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });
});

// ─── follow-up Task 3: navigation 包装 ───────────────────────────────────────

describe('follow-up: navigation 创造 action 包装 + query_path 不加', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('nav create_region: content[1] 含 ⚠ + nav_create_region', async () => {
    const result = await navHandle(
      'nav',
      { project_path: '/fake/p', action: 'create_region', name: 'TestRegion' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    expect(() => JSON.parse(textOf(result, 0))).not.toThrow();
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('nav_create_region');
  });

  it('nav create_link（非主 action，防 Set 写漏）: content[1] 含 ⚠ + nav_create_link', async () => {
    const result = await navHandle(
      'nav',
      {
        project_path: '/fake/p', action: 'create_link', name: 'TestLink',
        start_position: { x: 0, y: 0, z: 0 }, end_position: { x: 1, y: 0, z: 0 },
      },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('nav_create_link');
  });

  it('nav query_path（只读）: 返回不含 ⚠', async () => {
    const result = await navHandle(
      'nav',
      {
        project_path: '/fake/p', action: 'query_path',
        start_pos: { x: 0, y: 0, z: 0 }, end_pos: { x: 1, y: 0, z: 0 },
      },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });
});

// ─── follow-up Task 4: material 包装（executeGdscriptTrusted） ────────────────

describe('follow-up: material 6 action 包装 + 落盘/只读不加', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('material create: content[1] 含 ⚠ + material_create', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'create', node_path: 'root/Mesh', material_type: 'StandardMaterial3D' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    expect(() => JSON.parse(textOf(result, 0))).not.toThrow();
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('material_create');
  });

  it('material load（eng-review 修正）: content[1] 含 ⚠ + material_load', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'load', node_path: 'root/Mesh', resource_path: 'res://m.tres' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } =>
        i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('material_load');
  });

  // 反向（A3：落盘 + 只读 ≥2）
  it('material save（落盘）: 返回不含 ⚠', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'save', node_path: 'root/Mesh', resource_path: 'res://m.tres' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('material read（只读）: 返回不含 ⚠', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'read', node_path: 'root/Mesh' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('material shader_read（只读）: 返回不含 ⚠', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'shader_read', node_path: 'root/Mesh' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('material shader_list_templates（只读，提前 inline 返回不入 Set）: 返回不含 ⚠', async () => {
    const result = await materialHandle(
      'material',
      { project_path: '/fake/p', action: 'shader_list_templates' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });
});

// ─── follow-up Task 5: recording 整工具不包装（静态保护） ─────────────────────

describe('follow-up: recording 整工具不包装（C5 文案对录制语义错位，spec §1 特例）', () => {
  it('recording.ts 源码不含 appendRuntimePersistWarning / runtimePersistWarning 调用', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/tools/recording.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('appendRuntimePersistWarning');
    expect(src).not.toContain('runtimePersistWarning');
  });
});

// ─── ui_* follow-up Task 1: Control 包装 + 正向 ─────────────────────────────

describe('follow-up: ui Control action 包装 + 正向', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('ui_create_control: content[0] 可 JSON.parse + content[1] 含 ⚠ + ui_create_control', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'ui_create_control', scene_path: 'res://scene.tscn', node_type: 'Label', node_name: 'TestLabel' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    expect(() => JSON.parse(textOf(result, 0))).not.toThrow();
    expect(textOf(result, 0)).not.toContain('⚠');
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } => i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('ui_create_control');
  });

  it('ui_build_layout（批量，非主 action 防 Set 写漏）: content[1] 含 ⚠ + ui_build_layout', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'ui_build_layout', scene_path: 'res://scene.tscn', parent_path: 'root', tree: { type: 'VBoxContainer', name: 'TestVBox' } },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const warning = result!.content.find(
      (el, i): el is { type: 'text'; text: string } => i > 0 && isTextContent(el) && el.text.includes('⚠'),
    );
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('ui_build_layout');
  });
});

// ─── ui_* follow-up Task 2: theme/query/落盘反向（不加，防回归）──────────────

describe('follow-up: ui theme/query/落盘 action 不加提示', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // 查询
  it('ui_get_layout（查询）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'ui_get_layout', scene_path: 'res://scene.tscn', node_path: 'root/X' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  // theme（文案错位，整体不加）
  it('ui_set_theme theme_action=create（theme）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'ui_set_theme', scene_path: 'res://scene.tscn', node_path: 'root/X', theme_action: 'create' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('theme_create theme_create_action=create（theme）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'theme_create', scene_path: 'res://scene.tscn', theme_create_action: 'create' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  // 反馈 2026-11-18:scene_path 依赖按 action 分支——create 免 scene_path,extract 仍必填
  it('theme_create create 不传 scene_path: 不再 INVALID_PARAMS,生成脚本不加载场景', async () => {
    const result = await uiHandle('ui', {
      project_path: '/fake/p', action: 'theme_create', theme_create_action: 'create', save_path: 'res://ui/theme.tres',
    }, createMockCtx() as never);
    expect(result!.isError).toBeFalsy();
    const code = vi.mocked(executeGdscriptTrusted).mock.calls.at(-1)![0].code;
    expect(code).toContain('Theme.new()');
    expect(code).not.toContain('if not _mcp_load_scene(');
  });

  it('theme_create extract 不传 scene_path → INVALID_PARAMS', async () => {
    const result = await uiHandle('ui', {
      project_path: '/fake/p', action: 'theme_create', theme_create_action: 'extract', source_node_path: '/root/Panel',
    }, createMockCtx() as never);
    expect(result!.isError).toBe(true);
    expect(textOf(result, 0)).toContain('scene_path is required for theme_create (extract)');
  });

  it('theme_set_property（theme）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'theme_set_property', theme_node_path: 'root/X', item_type: 'color', prop_name: 'font_color', value: [1, 0, 0] },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  // 持久化（真落盘，不加防误导）
  it('ui_set_theme theme_action=save（持久化 ResourceSaver）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'ui_set_theme', scene_path: 'res://scene.tscn', node_path: 'root/X', theme_action: 'save', theme_path: 'res://t.tres' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });

  it('theme_create save_path（持久化 ResourceSaver）: 返回不含 ⚠', async () => {
    const result = await uiHandle(
      'ui',
      { project_path: '/fake/p', action: 'theme_create', scene_path: 'res://scene.tscn', theme_create_action: 'create', save_path: 'res://t.tres' },
      createMockCtx() as any,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeFalsy();
    const allText = result!.content.map((el) => (isTextContent(el) ? el.text : '')).join('');
    expect(allText).not.toContain('⚠');
  });
});
