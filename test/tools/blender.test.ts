import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBlenderScript, handleTool } from '../../src/tools/blender.js';
import { tmpdir } from 'os';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

vi.mock('../../src/core/blender-finder.js', () => ({ findBlender: vi.fn() }));
vi.mock('../../src/core/blender-spawn.js', () => ({ runBlenderHeadless: vi.fn() }));
vi.mock('../../src/core/args-validation.js', async (orig) => {
  const actual = await orig() as any;
  return {
    ...actual,
    requireProjectPath: (args: any) => args.project_path,  // 测试直通
  };
});

let tmpProj: string;
beforeEach(() => {
  vi.clearAllMocks();
  tmpProj = join(tmpdir(), `mcp-blender-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpProj, { recursive: true });
  writeFileSync(join(tmpProj, 'project.godot'), '', 'utf-8');
});
afterEach(() => { try { rmSync(tmpProj, { recursive: true, force: true }); } catch { /* */ } });

describe('buildBlenderScript', () => {
  it('wraps AI snippet with header + empty scene + argv export', () => {
    const script = buildBlenderScript('bpy.ops.mesh.primitive_cube_add()');
    expect(script).toContain('import bpy, bmesh, mathutils, math, sys');
    expect(script).toContain("bpy.ops.wm.read_factory_settings(use_empty=True)");
    expect(script).toContain("bpy.ops.mesh.primitive_cube_add()"); // AI 片段原样
    expect(script).toContain('sys.argv[sys.argv.index("--") + 1]'); // argv 不插值
    expect(script).toContain("export_format='GLB'");
  });
});

describe('execute_bpy path validation', () => {
  it('rejects traversal export_path (EXPORT_PATH_TRAVERSAL)', async () => {
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: '../../etc/evil.glb', code: 'pass' },
      {} as any);
    expect(r).toBeTruthy();
    expect(JSON.stringify(r)).toContain('EXPORT_PATH_TRAVERSAL');
  });

  it('blocks dangerous code via sandbox (SANDBOX_BLOCKED, 不触发 spawn)', async () => {
    // Important-1 (review): handler 反向断言。危险 code 在 writeFileSync 前被 scanBpySandbox 拦截。
    // 注意接线顺序：scan 在 findBlender 之后（接线 concern 见 task-2-report fix 节），故需 mock findBlender 通过。
    // test/setup.js 全局设 GODOT_MCP_UNRESTRICTED=true（bypass scanBpySandbox），需在此 it 内清空。
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', '');
    vi.stubEnv('GODOT_MCP_DISABLE_SAFETY', '');
    const { findBlender } = await import('../../src/core/blender-finder.js');
    const { runBlenderHeadless } = await import('../../src/core/blender-spawn.js');
    vi.mocked(findBlender).mockResolvedValue('/fake/blender');
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: 'a.glb',
        code: 'import os\nos.system("echo hi")' },
      {} as any);
    expect(r).toBeTruthy();
    expect((r as any).isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/SANDBOX_BLOCKED/);
    // 反向断言：未触发 spawn（scan 在 writeFileSync 前 return）
    expect(vi.mocked(runBlenderHeadless)).not.toHaveBeenCalled();
  });

  it('accepts bare relative path without res:// prefix (normalizeUserProjectPath no-prefix branch)', async () => {
    const { findBlender } = await import('../../src/core/blender-finder.js');
    const { runBlenderHeadless } = await import('../../src/core/blender-spawn.js');
    vi.mocked(findBlender).mockResolvedValue('/fake/blender');
    // 让 spawn "成功"：模拟 glb 已生成
    vi.mocked(runBlenderHeadless).mockImplementation(async () => {
      mkdirSync(join(tmpProj, 'assets', 'models'), { recursive: true });
      writeFileSync(join(tmpProj, 'assets', 'models', 'rock.glb'), 'FAKEGLB', 'utf-8');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: 'assets/models/rock.glb', code: 'pass' },
      {} as any);
    expect(JSON.stringify(r)).toContain('glb exported');
    expect(JSON.stringify(r)).toContain('rock.glb');
  });

  it('accepts res:// prefixed path (normalizeUserProjectPath prefix branch)', async () => {
    const { findBlender } = await import('../../src/core/blender-finder.js');
    const { runBlenderHeadless } = await import('../../src/core/blender-spawn.js');
    vi.mocked(findBlender).mockResolvedValue('/fake/blender');
    vi.mocked(runBlenderHeadless).mockImplementation(async () => {
      mkdirSync(join(tmpProj, 'out'), { recursive: true });
      writeFileSync(join(tmpProj, 'out', 'x.glb'), 'FAKEGLB', 'utf-8');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: 'res://out/x.glb', code: 'pass' },
      {} as any);
    expect(JSON.stringify(r)).toContain('glb exported');
  });

  it('returns BLENDER_NOT_FOUND when findBlender throws', async () => {
    const { findBlender } = await import('../../src/core/blender-finder.js');
    vi.mocked(findBlender).mockRejectedValue(new Error('not found'));
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: 'a.glb', code: 'pass' },
      {} as any);
    expect(JSON.stringify(r)).toContain('BLENDER_NOT_FOUND');
  });

  it('returns EXPORT_FILE_MISSING when blender succeeds but glb absent', async () => {
    const { findBlender } = await import('../../src/core/blender-finder.js');
    const { runBlenderHeadless } = await import('../../src/core/blender-spawn.js');
    vi.mocked(findBlender).mockResolvedValue('/fake/blender');
    vi.mocked(runBlenderHeadless).mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
    const r = await handleTool('blender',
      { project_path: tmpProj, action: 'execute_bpy', export_path: 'a.glb', code: 'pass' },
      {} as any);
    expect(JSON.stringify(r)).toContain('EXPORT_FILE_MISSING');
  });
});
