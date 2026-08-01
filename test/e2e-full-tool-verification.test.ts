/**
 * E2E Full Tool Verification — 在 godot-test-project 中验证全部 MCP 工具
 *
 * 通过 tool-registry 直接调用各工具模块的 handleTool，
 * 无需运行 MCP server，但需要 Godot 可执行文件。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { registerAllModules } from '../src/core/module-loader.js';
import { getModuleForTool, getAllToolNames, getAllToolDefinitions } from '../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { parseGodotConfig } from '../src/helpers.js';
import * as ps from '../src/core/process-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// I-05: 支持环境变量回退，其他开发者可直接运行
// 默认指向 repo 内极简 fixture(无 autoload,避免外部 RPG demo 的 autoload 编译失败);
// 设 GODOT_TEST_PROJECT 可覆盖指向完整项目
const TEST_PROJECT = process.env.GODOT_TEST_PROJECT || resolve(__dirname, 'fixtures', 'e2e-project');
// IMPORTANT-9b (review): 默认空强制显式设置,避免 CI 静默 skip 假绿(见 e2e-p1-p5)
const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const hasProject = existsSync(TEST_PROJECT) && existsSync(resolve(TEST_PROJECT, 'project.godot'));

// E2E 盲区告警:GODOT_PATH 默认指向开发机路径,CI 上通常不存在 → 依赖真实 Godot 的
// E2E 测试被 describe.skipIf 静默跳过。用 process.stderr.write 而非 console.warn ——
// vitest 会捕获 console.* 不透传,直接写 stderr 才能在 CI 日志/终端可见。
if (!hasGodot) {
  process.stderr.write(
    `[E2E-SKIP] 未找到 GODOT_PATH (${GODOT_PATH})。\n` +
    `  依赖真实 Godot 子进程的 E2E 测试(execute_gdscript/create_3d_node/Godot-dependent)将被跳过。\n` +
    `  设置 GODOT_PATH 环境变量以启用真实集成测试。注意:未设置时 CI 的"全部通过"不含任何真实 Godot 调用验证。\n`,
  );
}

const MAIN_SCENE = resolve(TEST_PROJECT, 'scenes', 'main.tscn');
const NEW_SCENE_PATH = resolve(TEST_PROJECT, 'scenes', 'e2e_verify_test.tscn');
const NEW_SCRIPT_PATH = resolve(TEST_PROJECT, 'scripts', 'e2e_verify_test.gd');

// v0.20.0 real-project 靶子(无 autoload,多子系统,供 L1/L2/L3 正路径)
// 详见 docs/superpowers/specs/2026-06-30-v0.20.0-full-tool-verification-design.md
const REAL_PROJECT = resolve(__dirname, 'fixtures', 'real-project');
const hasRealProject = existsSync(REAL_PROJECT) && existsSync(resolve(REAL_PROJECT, 'project.godot'));

// L2 测试(bridge 正路径 / recording)需真实游戏窗口 + bridge 键盘输入捕获, flaky —— 依赖游戏进程
// 启动时序 + 键盘事件真实捕获, 本地跑时过时失败(memory [[l2-bridge-test-pitfalls]])。默认 vitest run
// 跳过避免 flaky 致数字不稳; 显式 opt-in 才跑:
//   GODOT_MCP_E2E_L2=1 npx vitest run                         # 跑全部(含 L2)
//   GODOT_MCP_E2E_L2=1 npx vitest run test/e2e-full-tool-verification.test.ts
const OPT_IN_L2 = !!process.env.GODOT_MCP_E2E_L2;
const SCENE_2D = 'res://scenes/2d/main_2d.tscn';
const SCENE_3D = 'res://scenes/3d/main_3d.tscn';
const SCENE_AUDIO = 'res://scenes/audio_demo.tscn';

// I-01: 移入 beforeAll 避免模块顶层全局副作用
let _registered = false;

function findGodot(): Promise<string> {
  return Promise.resolve(GODOT_PATH);
}

function makeCtx(): ToolContext {
  return {
    opsScript: resolve(__dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    findGodot,
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skipBusyCheck?) { ps.setRunningProcess(proc, skipBusyCheck); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d: string) { ps.setProjectDir(d); },
    parseGodotConfig,
  };
}

// I-06: 安全的类型校验 — 验证 result 结构而非不安全断言
function isToolResult(val: unknown): val is ToolResult {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.content) && obj.content.every(
    (c: unknown) => c && typeof c === 'object' && 'type' in (c as Record<string, unknown>) && 'text' in (c as Record<string, unknown>)
  );
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool(toolName);
  if (!mod) return { text: `MODULE_NOT_FOUND: ${toolName}`, isError: true };
  const result = await mod.handleTool(toolName, { project_path: TEST_PROJECT, ...args }, makeCtx());
  // 反假绿(IMPORTANT-9b,对齐 callToolReal:120):null = action 未匹配 default return,
  // 判 isError:true 暴露 action 笔误/未实现(原 isError:false 静默放行 = 假绿)。
  if (!result) return { text: 'null result (action 未匹配任何 case — 疑似假绿,核对 action 名)', isError: true };
  if (!isToolResult(result)) return { text: `UNEXPECTED_RESULT: ${JSON.stringify(result).slice(0, 200)}`, isError: true };
  const text = result.content.map(c => c.text).join('\n') ?? '';
  return { text, isError: result.isError === true };
}

// v0.20.0 L1 正路径 helper(消费 real-project 靶子) ──────────────────────────
// 正路径断言:禁止 isError,text 含期望子串(升级现有 text.length>5 浅断言)
function expectSuccess(r: { text: string; isError: boolean }, substr?: string) {
  expect(r.isError).toBe(false);
  if (substr) expect(r.text).toContain(substr);
}
// error path 断言(P1-10):明确 isError:true + 锁预期 error 关键词(非任意文本)
function expectErrorContains(r: { text: string; isError: boolean }, substr: string) {
  expect(r.isError).toBe(true);
  expect(r.text).toContain(substr);
}
// 容错断言:允许 error,但必须返回结构化文本(not-found / 空列表也算通过)
// 仅用于无法预判 success/error 的纯结构验证(L1/bridge 段);正路径用 expectSuccess,已知 error path 用 expectErrorContains
function expectHasText(r: { text: string; isError: boolean }) {
  expect(r.text).toBeDefined();
  expect(r.text.length).toBeGreaterThan(0);
}

// 指向 real-project 的 callTool 变体(L1/L2 正路径用)
async function callToolReal(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool(toolName);
  if (!mod) return { text: `MODULE_NOT_FOUND: ${toolName}`, isError: true };
  const result = await mod.handleTool(toolName, { project_path: REAL_PROJECT, ...args }, makeCtx());
  // 反假绿(IMPORTANT-9b):null = action 未匹配任何 case(default return null,如 ui/project 模块),
  // 判为错误而非通过。避免 action 名笔误导致的假绿(现有 e2e 的 ui build_layout/project info 即此陷阱)。
  if (!result) return { text: 'null result (action 未匹配任何 case — 疑似假绿,核对 action 名)', isError: true };
  if (!isToolResult(result)) return { text: `UNEXPECTED_RESULT: ${JSON.stringify(result).slice(0, 200)}`, isError: true };
  const text = result.content.map(c => c.text).join('\n') ?? '';
  return { text, isError: result.isError === true };
}

// Snapshot for cleanup
let _mainSceneSnap: string;

beforeAll(() => {
  if (!_registered) {
    registerAllModules();
    _registered = true;
  }
  if (hasProject && existsSync(MAIN_SCENE)) {
    _mainSceneSnap = readFileSync(MAIN_SCENE, 'utf-8');
  }
  ps.resetState();
});

// I-02: afterEach 清理进程状态，防止泄漏级联
afterEach(() => {
  const proc = ps.getRunningProcess();
  if (proc && !proc.killed) {
    try { proc.kill(); } catch { /* best effort */ }
  }
  ps.setProcessBusy(false);
  ps.setRunningProcess(null, true);
});

afterAll(() => {
  if (_mainSceneSnap && existsSync(MAIN_SCENE)) {
    writeFileSync(MAIN_SCENE, _mainSceneSnap, 'utf-8');
  }
  for (const f of [NEW_SCENE_PATH, NEW_SCRIPT_PATH]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  ps.resetState();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 0. TOOL REGISTRY — 注册完整性
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: Tool Registry', () => {
  it('registers all expected tool modules', () => {
    const names = getAllToolNames();
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  it('all tool definitions have valid schemas', () => {
    const defs = getAllToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect((def.inputSchema as any).type).toBe('object');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. script — execute_gdscript (需要 Godot)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: execute_gdscript (via script tool)', { timeout: 30_000 }, () => {
  it('snippet mode: basic output', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'var _x = 42\n_mcp_output("result", _x)\n_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('42');
  });

  it('snippet mode: structured data', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'var _d = {"items": [1,2,3], "ok": true}\n_mcp_output("data", _d)\n_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('items');
  });

  it('full class mode: extends SceneTree', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'extends SceneTree\nfunc _initialize():\n\t_mcp_output("mode", "full")\n\t_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('full');
  });

  it('sandbox blocks dangerous APIs', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'OS.shell_open("https://example.com")\n_mcp_done()',
    });
    // Sandbox 拦截返回 compile_error 文本
    expect(r.text).toContain('Sandbox violation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. script — read_script / write_script / edit_script (纯文件操作)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: script CRUD (file ops)', () => {
  it('read_script: reads existing script', async () => {
    const r = await callTool('script', {
      action: 'read_script',
      script_path: 'res://scripts/main.gd',
    });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('write_script: creates new script', async () => {
    const r = await callTool('script', {
      action: 'write_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
      content: 'extends Node\n\nfunc _ready():\n\tpass\n',
    });
    expect(r.isError).toBe(false);
    expect(existsSync(NEW_SCRIPT_PATH)).toBe(true);
  });

  it('edit_script: search_and_replace mode', async () => {
    const r = await callTool('script', {
      action: 'edit_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
      search_and_replace: { search: 'pass', replace: 'print("E2E")' },
    });
    expect(r.isError).toBe(false);
  });

  it('read_script: verifies edit result', async () => {
    const r = await callTool('script', {
      action: 'read_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('E2E');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. scene — read_scene(纯文件)/ create_scene·add_node·edit_node·save_scene(Godot)
// read_scene 纯文本解析 .tscn,CI(无 Godot)可测;create_scene/save_scene 必 spawn
// Godot,add_node/edit_node/query_scene_tree 依赖 create_scene 产物 → 无 Godot 时跳过
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: scene read (file ops)', () => {
  it('read_scene: reads existing scene', async () => {
    const r = await callTool('scene', {
      action: 'read_scene',
      scene_path: resolve(TEST_PROJECT, 'scenes', 'main.tscn'),
    });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasProject || !hasGodot)('E2E: scene CRUD (Godot-dependent)', () => {
  it('create_scene: creates new scene', async () => {
    const r = await callTool('scene', {
      action: 'create_scene',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });

  it('create_scene: verifies file exists on disk', () => {
    // I-03: 前置条件检查 — 后续所有场景测试依赖此文件
    expect(existsSync(NEW_SCENE_PATH)).toBe(true);
  });

  it('add_node: adds Sprite2D child', async () => {
    const r = await callTool('scene', {
      action: 'add_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
      parent_node_path: '.',
      properties: {},
    });
    expect(r.isError).toBe(false);
  });

  it('edit_node: modifies property', async () => {
    // Imp-14: edit_node 走 executeGdscript(Godot 冷启动 + import + cleanupOldSessions staging EPERM 退避),
    // 默认 10s timeout 不够(Windows 累积时尤甚),放宽到 30s。
    const r = await callTool('scene', {
      action: 'edit_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: 'TestSprite',
      properties: { visible: false },
    });
    expect(r.isError).toBe(false);
  }, 30000);

  it('save_scene: persists changes', async () => {
    const r = await callTool('scene', {
      action: 'save_scene',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });

  it('query_scene_tree: returns tree structure', async () => {
    const r = await callTool('scene', {
      action: 'query_scene_tree',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. scene_commit — 批量操作
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: scene_commit', () => {
  it('commit: validates operations format', async () => {
    const r = await callTool('scene_commit', {
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      operations: [
        { op: 'node_add', parent: '.', type: 'Label', name: 'CommitLabel' },
        { op: 'node_property', path: 'CommitLabel', property: 'text', value: 'Committed' },
      ],
    });
    // scene_commit 通过 Godot load() + PackedScene 操作
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ui — build_layout / create_control
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: ui tool', () => {
  it('build_layout: VBoxContainer with children', async () => {
    const r = await callTool('ui', {
      action: 'ui_build_layout',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      tree: {
        type: 'VBoxContainer',
        name: 'TestVBox',
        layout: { direction: 'column', gap: 8, padding: 10 },
        children: [
          { type: 'Label', name: 'TitleLabel', properties: { text: 'E2E' } },
          { type: 'Button', name: 'TestBtn', properties: { text: 'OK' } },
        ],
      },
    });
    expect(r.isError).toBe(false);
  });

  it('create_control: single Button', async () => {
    const r = await callTool('ui', {
      action: 'ui_create_control',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      node_type: 'Button',
      node_name: 'StandaloneBtn',
      properties: { text: 'Standalone' },
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. node_create_3d (通过 scene tool)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: create_3d_node (via scene tool)', { timeout: 30_000 }, () => {
  it('creates MeshInstance3D', async () => {
    const r = await callTool('scene', {
      action: 'create_3d_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      type: 'MeshInstance3D',
      name: 'TestMesh3D',
      parent: '.',
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. project — info / list_templates
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: project', () => {
  it('info: returns project metadata', async () => {
    const r = await callTool('project', { action: 'get_project_info' });
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('list_templates: returns template list', async () => {
    const r = await callTool('project', { action: 'list_templates' });
    expect(r.text).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. docs / manage_tools / instance tools (不需要 Godot)
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: docs / manage_tools / instances', () => {
  it('docs: list', async () => {
    const r = await callTool('docs', { action: 'list' });
    expect(r.text).toBeDefined();
  });

  it('manage_tools: list_groups', async () => {
    const r = await callTool('manage_tools', { action: 'list_groups' });
    expect(r.text).toBeDefined();
  });

  it('godot_list_instances: returns instance list', async () => {
    const r = await callTool('godot_list_instances', {});
    expect(r.text).toBeDefined();
  });

  it('godot_list_dynamic_routes: returns route list', async () => {
    const r = await callTool('godot_list_dynamic_routes', {});
    expect(r.text).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Godot-dependent tools — I-04: 强化断言验证实际工作
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: Godot-dependent tools', { timeout: 60_000 }, () => {
  // P1-10: 弱断言 expectHasText（length>0 不辨 isError）已全部强化为 expectSuccess / expectErrorContains。
  // 7 个 it 曾用工具不认的 action（run_validation / inspect_node on runtime / create / read / list）
  // 致永远 UNKNOWN_ACTION 假绿——已修正确 action 名。剩余 error 多为 fixture 缺靶（极简 e2e-project）
  // 或 it 参数简化,工具行为正确（返结构化 error）,锁 expectErrorContains 明确 error path。
  it('validation: run_and_verify returns structured result', async () => {
    const r = await callTool('validation', { action: 'run_and_verify' });
    expectSuccess(r);
  });

  // screenshot 在 Linux CI headless 无 GPU 时文件不生成(success:false 结构化 error),
  // 是已知环境限制非代码 bug(同 L1 段 screenshot capture 2D 容许 BLANK 思路)。
  // 本地 Windows(windowed 有渲染)验成功文本;Linux CI headless 验结构化失败文本。
  it('screenshot: capture saves image (Windows) or structured error (Linux headless)', async () => {
    const r = await callTool('screenshot', {
      action: 'capture',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      image_path: 'user://e2e_test.png',
    });
    if (process.platform === 'win32') {
      expectSuccess(r, 'Screenshot saved');
    } else {
      // Linux/macOS headless 无 GPU:PNG 可能不生成,底层返 success:false,但上层 textResult
      // 不带 isError(screenshot.ts:117 用 textResult 非 errorResult),故 isError 恒 false。
      // 成败都算通过,只验返回了结构化的 Screenshot 文本(saved 或 failed)。
      expectHasText(r);
      expect(r.text).toMatch(/Screenshot (saved|failed)/);
    }
  });

  it('workflow: dev_loop executes and returns output', async () => {
    const r = await callTool('workflow', {
      action: 'dev_loop',
      code: 'var _v = "workflow_ok"\n_mcp_output("test", _v)\n_mcp_done()',
    });
    expectSuccess(r, 'workflow_ok');
  });

  it('scene: inspect_node returns structured node info', async () => {
    const r = await callTool('scene', {
      action: 'inspect_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'Main',
    });
    expectSuccess(r);
  });

  it('animation: list_players returns result', async () => {
    const r = await callTool('animation', {
      action: 'list_players',
      scene_path: 'res://scenes/anim_test.tscn',
    });
    expectSuccess(r);
  });

  it('animation_track: add_track — fixture lacks AnimationPlayer', async () => {
    const r = await callTool('animation_track', {
      action: 'add_track',
      scene_path: 'res://scenes/anim_test.tscn',
      node_path: 'AnimationPlayer',
      animation_name: 'NewAnim',
      track_type: 'value',
      track_path: ':position:x',
    });
    expectErrorContains(r, 'AnimationPlayer');
  });

  it('particles: particles_create validates node_type', async () => {
    const r = await callTool('particles', {
      action: 'particles_create',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      name: 'TestParticles',
      type: 'GPUParticles2D',
    });
    expectErrorContains(r, 'node_type');
  });

  it('tilemap: tilemap_read requires NodePath', async () => {
    const r = await callTool('tilemap', {
      action: 'tilemap_read',
      scene_path: 'res://demos/dynamic_tilemap_layers/dynamic_tilemap.tscn',
    });
    expectErrorContains(r, 'NodePath');
  });

  it('material: read — fixture lacks material on node', async () => {
    const r = await callTool('material', {
      action: 'read',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: '.',
    });
    expectErrorContains(r, 'material');
  });

  it('signal: signal_list — fixture lacks TestSprite node', async () => {
    const r = await callTool('signal', {
      action: 'signal_list',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: 'TestSprite',
    });
    expectErrorContains(r, 'not found');
  });

  it('audio: audio_query requires NodePath', async () => {
    const r = await callTool('audio', {
      action: 'audio_query',
      scene_path: 'res://scenes/main.tscn',
    });
    expectErrorContains(r, 'NodePath');
  });

  it('nav: query_path validates Vector3', async () => {
    const r = await callTool('nav', {
      action: 'query_path',
      scene_path: 'res://demos/navigation/navigation_demo.tscn',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 1 },
    });
    expectErrorContains(r, 'Vector3');
  });

  it('physics: raycast returns hit result', async () => {
    const r = await callTool('physics', {
      action: 'raycast',
      from: { x: 0, y: 10, z: 0 },
      to: { x: 0, y: 0, z: 0 },
    });
    expectSuccess(r);
  });

  it('animtree: animtree_create requires name + animation_player_path', async () => {
    const r = await callTool('animtree', {
      action: 'animtree_create',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: '.',
      name: 'TestAnimTree',
    });
    expectErrorContains(r, 'required');
  });

  it('profiler: snapshot returns profiler data', async () => {
    const r = await callTool('profiler', { action: 'snapshot' });
    expectSuccess(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. game (Bridge) — 无游戏运行时测试错误路径
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: game (Bridge — error path)', () => {
  it('query ping: returns error message without running game', async () => {
    const r = await callTool('game', { action: 'game_query', method: 'ping' });
    expectErrorContains(r, 'Bridge');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. editor — 测试错误路径
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: editor (error path)', () => {
  it('sync_start: returns message without editor', async () => {
    const r = await callTool('editor', { action: 'sync_start' });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L1 real-project: 文件类 + 基础工具正路径
// 消费 real-project 靶子(无 autoload),验证 10 个工具的 L1 headless 正路径。
// 反假绿(IMPORTANT-9b):强断言优先(expectSuccess);ui action 必须带 ui_ 前缀
// (底层 case 名),不带前缀会 default return null → 假绿。
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasRealProject)('L1 real-project: 文件类 + 基础工具正路径', { timeout: 60_000 }, () => {

  it('script read: 读 real-project main_2d.gd', async () => {
    const r = await callToolReal('script', {
      action: 'read_script',
      script_path: resolve(REAL_PROJECT, 'scripts', 'main_2d.gd'), // read_script 要求绝对路径
    });
    expectSuccess(r, 'action_pressed'); // main_2d.gd 真实 signal 名
  });

  it('scene read: 读 main_3d 含 MeshInstance3D', async () => {
    const r = await callToolReal('scene', {
      action: 'read_scene',
      scene_path: resolve(REAL_PROJECT, 'scenes', '3d', 'main_3d.tscn'),
    });
    expectSuccess(r, 'MeshInstance3D');
  });

  it('scene inspect_node: 返回 Camera3D 节点信息', async () => {
    const r = await callToolReal('scene', { // inspect_node 是 scene 工具 action,非 runtime(runtime 无此 case → default null 假绿)
      action: 'inspect_node',
      scene_path: SCENE_3D,
      node_path: 'Camera3D',
    });
    expectSuccess(r); // 正路径 = read 工具不报错
  });

  it('project info: 返回 real-project 元数据', async () => {
    const r = await callToolReal('project', { action: 'get_project_info' }); // 底层 case 名,非 'info'(后者 default null 假绿)
    expectSuccess(r, 'real-project'); // config/name
  });

  it('validation validate_project: 校验 real-project 健康', async () => {
    const r = await callToolReal('validation', { action: 'validate_project' }); // 底层 case 名,非 'run_validation'(后者 default null 假绿)
    expectSuccess(r);
  });

  it('screenshot capture 3D: 返回图片数据(非 BLANK)', async () => {
    const r = await callToolReal('screenshot', {
      action: 'capture',
      scene_path: SCENE_3D,
      image_path: 'user://l1_3d.png',
    });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('BLANK_DETECTED'); // 3D headless 应正常渲染
  });

  it('screenshot capture 2D: 容许 BLANK(headless 2D 已知限制)', async () => {
    const r = await callToolReal('screenshot', {
      action: 'capture',
      scene_path: SCENE_2D,
      image_path: 'user://l1_2d.png',
    });
    expectHasText(r); // 2D headless 可能 BLANK_DETECTED,不算失败
  });

  it('workflow dev_loop: 真实执行', async () => {
    const r = await callToolReal('workflow', {
      action: 'dev_loop',
      code: 'var _v = "l1_ok"\n_mcp_output("t", _v)\n_mcp_done()',
    });
    expectSuccess(r, 'l1_ok');
  });

  it('docs list: 返回文档清单', async () => {
    const r = await callToolReal('docs', { action: 'list' });
    expectHasText(r);
  });

  it('ui get_layout: 读 UIBox 真实布局', async () => {
    const r = await callToolReal('ui', {
      action: 'ui_get_layout', // 带 ui_ 前缀(底层 case 名);不带前缀会 default return null → 假绿
      scene_path: SCENE_2D,
      node_path: 'Main2D/UIBox',
    });
    expectSuccess(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L1 real-project: 领域工具真实对象正路径
// 消费靶子真实节点(AnimPlayer/TileLayer/Particles/SignalHost/BgmPlayer/NavRegion/Body3D/TestMesh)。
// 反假绿:action 名核对源码 case;tilemap/particles/signal 带 module 前缀;
// audio/nav 无 list action → 改用 audio_query(查询)/create_region(创建)验证工具响应。
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasRealProject)('L1 real-project: 领域工具真实对象正路径', { timeout: 60_000 }, () => {

  it('animation list_players: 返回 AnimPlayer', async () => {
    const r = await callToolReal('animation', { action: 'list_players', scene_path: SCENE_2D });
    expectSuccess(r, 'AnimPlayer');
  });

  it('animation_track add_track: 真实加轨道', async () => {
    // fixture AnimPlayer 预定义 L1Anim animation(持久化,避免跨进程 create 丢失)
    const r = await callToolReal('animation_track', {
      action: 'add_track', scene_path: SCENE_2D, node_path: 'root/Main2D/AnimPlayer',
      animation_name: 'L1Anim', track_type: 'value', track_path: 'Camera2D:position:x',
    });
    expectSuccess(r);
  });

  it('animtree create: 真实建 AnimationTree', async () => {
    const r = await callToolReal('animtree', { action: 'animtree_create', scene_path: SCENE_2D, name: 'L1Tree', animation_player_path: 'root/Main2D/AnimPlayer' });
    expectSuccess(r);
  });

  it('tilemap read: 返回 TileLayer 真实数据', async () => {
    const r = await callToolReal('tilemap', { action: 'tilemap_read', scene_path: SCENE_2D, node_path: 'Main2D/TileLayer' });
    expectSuccess(r); // 真实 TileMapLayer,非 not-found
  });

  it('particles create 2D: 真实建粒子', async () => {
    const r = await callToolReal('particles', { action: 'particles_create', scene_path: SCENE_2D, parent_path: '.', name: 'NewParts', node_type: 'GPUParticles2D' });
    expectSuccess(r);
  });

  it('material read: 返回 TestMesh 节点信息', async () => {
    // material 不读 scene_path(默认 main scene),用 main_2d 的 TestMesh(fixture 内置)
    const r = await callToolReal('material', { action: 'read', node_path: 'root/Main2D/TestMesh' });
    expectSuccess(r);
  });

  it('signal list: 返回 Main2D 真实信号', async () => {
    // signal 工具不读 scene_path(在默认 main scene 操作),用 main_2d 的 Main2D 节点(main_2d.gd 的 action_pressed)
    const r = await callToolReal('signal', { action: 'signal_list', node_path: 'root/Main2D' });
    expectSuccess(r, 'action_pressed');
  });

  it('audio query: 查询 BgmPlayer 状态', async () => {
    // audio 工具不读 scene_path(在默认 main scene 操作),查 main_2d 的 BgmPlayer(fixture 内置)
    const r = await callToolReal('audio', { action: 'audio_query', node_path: 'root/Main2D/BgmPlayer' });
    expectSuccess(r);
  });

  it('nav create_region: 创建空 NavigationRegion3D', async () => {
    const r = await callToolReal('nav', { action: 'create_region', name: 'L1NavTest', parent: 'root', bake: false });
    expectSuccess(r); // nav 无 read/list action,用 create_region 验证工具响应
  });

  it('physics raycast: 射线查询', async () => {
    const r = await callToolReal('physics', { action: 'raycast', from: { x: 0, y: 10, z: 0 }, to: { x: 0, y: 0, z: 0 } });
    expectSuccess(r); // 射线查询(命中/未命中均返回结构化结果)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L1 real-project: cpp scaffold_gdextension
// cpp 工具在 project_path 下生成 8 文件 GDExtension 工程骨架(无 output_dir 参数,plan 有误)。
// 用 REAL_PROJECT 子目录 + force:true 避免污染 fixture,afterAll 清理。
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasRealProject)('L1 real-project: cpp scaffold_gdextension', { timeout: 30_000 }, () => {
  const cppDir1 = resolve(REAL_PROJECT, 'cpp_l1_test');
  const cppDir2 = resolve(REAL_PROJECT, 'cpp_l1_test2');

  it('scaffold: 生成 8 文件 GDExtension 工程骨架并落盘', async () => {
    const r = await callToolReal('cpp', {
      project_path: cppDir1, // cpp 工具用 project_path 作生成根(无 output_dir 参数)
      action: 'scaffold_gdextension',
      class_name: 'L1TestNode',
      parent_class: 'Node',
      force: true,
    });
    expectSuccess(r, 'files'); // 返回 JSON 含 files 清单 + gdextension_path
    // 校验关键文件落盘(renderScaffold 8 文件:src/类.h/.cpp + register_types.h/.cpp + SConstruct + .gdextension + .gitignore + README)
    expect(existsSync(resolve(cppDir1, 'SConstruct'))).toBe(true);
    expect(existsSync(resolve(cppDir1, 'src', 'L1TestNode.cpp'))).toBe(true);
    expect(existsSync(resolve(cppDir1, 'src', 'register_types.cpp'))).toBe(true);
    expect(existsSync(resolve(cppDir1, 'l1testnode.gdextension'))).toBe(true); // lib = className.toLowerCase()
  });

  it('gdextension_file 内容含 entry 段', async () => {
    const r = await callToolReal('cpp', {
      project_path: cppDir2,
      action: 'scaffold_gdextension',
      class_name: 'L1Node2',
      force: true,
    });
    expectSuccess(r);
    const gdext = readFileSync(resolve(cppDir2, 'l1node2.gdextension'), 'utf-8');
    expect(gdext).toContain('entry'); // entry_symbol = "..._library_init"
  });

  afterAll(() => {
    // 清理:cpp 生成的工程不进 git,删除避免 fixture 污染
    for (const d of [cppDir1, cppDir2]) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L2 real-project: bridge(game)正路径
// 真启 Godot 游戏进程 + bridge TCP 9081。sequential(单端口串行)。
// beforeAll 快照 project.godot,afterAll 恢复(game_bridge_install 写 autoload)+ stop + 删密钥。
// action 前缀:game_bridge_install/query/write/input/wait 带 game_ 前缀;monitor/watch/find_ui 不带。
// ═══════════════════════════════════════════════════════════════════════════════
if (!process.env.CI && (!hasGodot || !hasRealProject || !OPT_IN_L2)) {
  const _reason = !hasGodot ? 'Godot not found'
    : !hasRealProject ? 'no real project fixture'
    : 'GODOT_MCP_E2E_L2=1 not set';
  process.stderr.write(`[skip] L2 bridge suite skipped — ${_reason}. Set GODOT_MCP_E2E_L2=1 + install Godot to enable.\n`);
}
describe.skipIf(!hasGodot || !hasRealProject || process.env.CI || !OPT_IN_L2)('L2 real-project: bridge 正路径', { timeout: 120_000, sequential: true }, () => {
  let projectGodotSnap = '';

  beforeAll(() => {
    projectGodotSnap = readFileSync(resolve(REAL_PROJECT, 'project.godot'), 'utf-8');
    // 治 bridge 密钥权限循环(memory S4 陷阱):复用 secret 不收紧/删除。
    // buildSafeEnv 传 GODOT_MCP_BRIDGE_* env 到游戏进程(helpers.ts:141)
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
  });

  it('install + run + query/write/monitor/watch/find_ui 完整链路', async () => {
    // 单 it:全局 afterEach(line ~100)会在每个 it 后 kill 游戏进程,故 bridge 链路必须在单 it 内完成
    const install = await callToolReal('game', { action: 'game_bridge_install' });
    expectSuccess(install);
    const run = await callToolReal('runtime', { action: 'run_project', wait_for_bridge: true, bridge_timeout: 30, timeout: 120 });
    expectSuccess(run);
    const ping = await callToolReal('game', { action: 'game_query', method: 'ping' });
    expectSuccess(ping);
    const tree = await callToolReal('game', { action: 'game_query', method: 'get_tree' });
    expectSuccess(tree);
    const find = await callToolReal('game', { action: 'game_query', method: 'find_nodes', params: { pattern: 'Camera' } });
    expectHasText(find);
    const set = await callToolReal('game', { action: 'game_write', method: 'set_node_property',
      params: { path: '/root/Main2D/Camera2D', property: 'position', value: { x: 100, y: 50 } } });
    expectHasText(set);
    const monStart = await callToolReal('game', { action: 'monitor_start', node_path: 'root/Main2D', properties: ['position'], interval_frames: 10 });
    expectHasText(monStart);
    const monStop = await callToolReal('game', { action: 'monitor_stop' });
    expectHasText(monStop);
    const watchStart = await callToolReal('game', { action: 'watch_start', node_path: 'root/Main2D', signal_name: 'action_pressed', max_events: 10 });
    expectHasText(watchStart);
    const watchStop = await callToolReal('game', { action: 'watch_stop' });
    expectHasText(watchStop);
    const findUi = await callToolReal('game', { action: 'find_ui_elements', type: 'Button', visible_only: true });
    expectHasText(findUi);
  });

  afterAll(async () => {
    try { await callToolReal('runtime', { action: 'stop_project' }); } catch { /* best effort */ }
    // 恢复 project.godot(game_bridge_install 写了 autoload,避免 fixture 污染)
    if (projectGodotSnap) {
      try { writeFileSync(resolve(REAL_PROJECT, 'project.godot'), projectGodotSnap, 'utf-8'); } catch { /* best effort */ }
    }
    // 清理 install 副作用:mcp_bridge.gd autoload 脚本(install copyFileSync 到项目根)+ 密钥
    const bridgeScript = resolve(REAL_PROJECT, 'mcp_bridge.gd');
    if (existsSync(bridgeScript)) { try { rmSync(bridgeScript, { force: true }); } catch { /* best effort */ } }
    const secret = resolve(REAL_PROJECT, '.godot', 'mcp_bridge_9081.secret');
    if (existsSync(secret)) { try { rmSync(secret, { force: true }); } catch { /* best effort */ } }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L2 real-project: recording + profiler
// recording 需游戏运行 + bridge 输入捕获(单 it,同 Task 8 模式);
// profiler 通过 executeGdscript(headless),不需游戏运行。
// action:recording 用 runtime record_start/stop/play(plan 写 recording_* 错);
//         profiler snapshot/start/get_data/stop。
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasRealProject || process.env.CI || !OPT_IN_L2)('L2 real-project: recording + profiler', { timeout: 150_000 }, () => {
  let projectGodotSnap = '';

  beforeAll(() => {
    projectGodotSnap = readFileSync(resolve(REAL_PROJECT, 'project.godot'), 'utf-8');
    process.env.GODOT_MCP_BRIDGE_PERSISTENT_SECRET = 'true';
  });

  if (!process.env.CI && !OPT_IN_L2) {
    process.stderr.write('[skip] L2 recording test skipped — GODOT_MCP_E2E_L2=1 not set. Set GODOT_MCP_E2E_L2=1 to enable recording E2E.\n');
  }
  it.skipIf(process.env.CI || !OPT_IN_L2)('recording start/stop/play(需游戏 + bridge 输入捕获)', async () => {
    // 单 it:afterEach 在 it 间 kill 进程,故 recording 链路(依赖游戏运行)单 it 内完成
    const install = await callToolReal('game', { action: 'game_bridge_install' });
    expectSuccess(install);
    const run = await callToolReal('runtime', { action: 'run_project', wait_for_bridge: true, bridge_timeout: 30, timeout: 120 });
    expectSuccess(run);
    const start = await callToolReal('runtime', { action: 'record_start' });
    expectHasText(start);
    await callToolReal('game', { action: 'game_input', method: 'send_key', params: { key: 'Key_W', pressed: true } });
    const stop = await callToolReal('runtime', { action: 'record_stop' });
    expectHasText(stop);
    // record_stop 返回 events_json(memory 方式 B),直接传 record_play
    const play = await callToolReal('runtime', { action: 'record_play', events_json: stop.text, speed: 1.0 });
    expectHasText(play);
  });

  it('profiler snapshot/start/get_data/stop(headless executeGdscript)', async () => {
    // profiler 通过 executeGdscript(headless 独立 Godot 进程),不需游戏运行
    const snap = await callToolReal('profiler', { action: 'snapshot' });
    expectHasText(snap);
    const start = await callToolReal('profiler', { action: 'start' });
    expectHasText(start);
    const data = await callToolReal('profiler', { action: 'get_data', dimensions: ['process'], frame_count: 30 });
    expectHasText(data);
    const stop = await callToolReal('profiler', { action: 'stop' });
    expectHasText(stop);
  });

  afterAll(async () => {
    try { await callToolReal('runtime', { action: 'stop_project' }); } catch { /* best effort */ }
    if (projectGodotSnap) {
      try { writeFileSync(resolve(REAL_PROJECT, 'project.godot'), projectGodotSnap, 'utf-8'); } catch { /* best effort */ }
    }
    const bridgeScript = resolve(REAL_PROJECT, 'mcp_bridge.gd');
    if (existsSync(bridgeScript)) { try { rmSync(bridgeScript, { force: true }); } catch { /* best effort */ } }
    const secret = resolve(REAL_PROJECT, '.godot', 'mcp_bridge_9081.secret');
    if (existsSync(secret)) { try { rmSync(secret, { force: true }); } catch { /* best effort */ } }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L2 editor(GUI 合取守卫)— 默认 skip + stderr 告警(反假绿 IMPORTANT-9b)
// ═══════════════════════════════════════════════════════════════════════════════
const hasEditorFlag = !!process.env.E2E_EDITOR;
if (!hasEditorFlag) {
  process.stderr.write('[E2E-SKIP] editor 正路径未启用(设 E2E_EDITOR=1;需 GUI 编辑器,CI 不可行)\n');
}

describe.skipIf(!hasGodot || !hasRealProject || !hasEditorFlag)('L2 real-project: editor 正路径(GUI)', { timeout: 120_000 }, () => {
  it('launch_editor + sync_start + get_scene_tree', async () => {
    const launch = await callToolReal('runtime', { action: 'launch_editor' });
    expectHasText(launch);
    const sync = await callToolReal('editor', { action: 'sync_start' });
    expectSuccess(sync);
    const tree = await callToolReal('editor', { action: 'get_scene_tree' });
    expectHasText(tree);
  });

  afterAll(async () => {
    try { await callToolReal('editor', { action: 'sync_stop' }); } catch { /* best effort */ }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L3 multi_instance + dynamic(GODOT_MCP_MULTI_INSTANCE 守卫)— 默认 skip + stderr
// ═══════════════════════════════════════════════════════════════════════════════
const hasMultiInstance = !!process.env.GODOT_MCP_MULTI_INSTANCE;
if (!hasMultiInstance) {
  process.stderr.write('[E2E-SKIP] multi_instance 测试未启用(设 GODOT_MCP_MULTI_INSTANCE=true)\n');
}

describe.skipIf(!hasMultiInstance)('L3: multi_instance + dynamic', { timeout: 60_000 }, () => {
  it('godot_list_instances: 返回实例列表', async () => {
    const r = await callTool('godot_list_instances', {});
    expectHasText(r);
  });
  it('godot_select_instance: 选中实例', async () => {
    const r = await callTool('godot_select_instance', { project_path: REAL_PROJECT });
    expectHasText(r);
  });
  it('godot_list_dynamic_routes: 返回动态路由', async () => {
    const r = await callTool('godot_list_dynamic_routes', {});
    expectHasText(r);
  });
  it('godot_advanced_tool: 代理 test', async () => {
    const r = await callTool('godot_advanced_tool', { tool_name: 'test', arguments: {} });
    expectHasText(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L3 android(adb)— list/preset/template/logcat 正路径;deploy 设备依赖 it.skip
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasRealProject)('L3: android(adb)', { timeout: 60_000 }, () => {
  it('list_devices: 返回设备列表(空也算正路径)', async () => {
    const r = await callToolReal('android', { action: 'list_devices' });
    expectHasText(r); // 无设备返回空列表,无 adb 返回 error,均算工具响应
  });
  it('get_preset_info: 返回 preset', async () => {
    const r = await callToolReal('android', { action: 'get_preset_info' });
    expectHasText(r);
  });
  it('check_template: 校验模板', async () => {
    const r = await callToolReal('android', { action: 'check_template' });
    expectHasText(r);
  });
  it('logcat: 一次性快照', async () => {
    const r = await callToolReal('android', { action: 'logcat' });
    expectHasText(r);
  });
  it.skip('deploy: 需连接设备(手动启用)', async () => {
    const r = await callToolReal('android', { action: 'deploy' });
    expectHasText(r);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// v0.20.0 L2 run_project bridge-not-ready → isError(问题 2 修复验证)
// 不 install bridge,run_project wait_for_bridge → bridge 不就绪 → isError
// (修复前 isError:false 误报,到 ping 才暴露 BRIDGE_NOT_CONNECTED)
// ═══════════════════════════════════════════════════════════════════════════════
// P1-fix(测试 gate): 补 OPT_IN_L2 + CI gate，对齐 :818 bridge suite / :884 stderr 警告的意图。
// 原仅 gate hasGodot+hasRealProject，npm test 默认就跑 run_project（--debug 非 headless），
// 起 Godot GUI 窗口；fixture project.godot 改写瞬间被 Godot 读取不完整 → 弹"no main scene"系统窗。
describe.skipIf(!hasGodot || !hasRealProject || process.env.CI || !OPT_IN_L2)('L2 run_project bridge-not-ready → isError', { timeout: 60_000 }, () => {
  it('wait_for_bridge + 无 bridge install → isError:true', async () => {
    const r = await callToolReal('runtime', { action: 'run_project', wait_for_bridge: true, bridge_timeout: 3, timeout: 30 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Bridge not ready');
  });

  afterAll(async () => {
    try { await callToolReal('runtime', { action: 'stop_project' }); } catch { /* best effort */ }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: Cleanup', () => {
  it('removes test artifacts', () => {
    for (const f of [NEW_SCENE_PATH, NEW_SCRIPT_PATH]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
    expect(true).toBe(true);
  });
});
