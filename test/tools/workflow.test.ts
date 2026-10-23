import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { genSceneSnapshotScript } from '../../src/tools/workflow.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Task 4 mocks: dev_loop 的外部依赖（避免真跑 godot）──
// 注：export 名按 workflow.ts 实际 import 核实（brief 的 shared.js mock 名不符）：
//   - textResult 来自 ../types.js（非 shared.js）
//   - requireProjectPath 来自 ../core/args-validation.js(W5 批2 迁移)（非 shared.js）
//   - shared.js 实际 export: SCENE_TREE_HEADER/parseGdscriptResult/wrapAssertionCode/opsErrorResult/validateTimeout/gdEscape
vi.mock('../../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(),
  executeGdscriptTrusted: vi.fn(),
}));
vi.mock('../../src/types.js', () => ({
  textResult: vi.fn((s: string) => ({ content: [{ type: 'text' as const, text: s }] })),
}));
vi.mock('../../src/core/args-validation.js', () => ({
  requireProjectPath: vi.fn(() => '/fake/project'),
}));
vi.mock('../../src/core/path-utils.js', () => ({
  resolveWithinRoot: vi.fn((_root: string, p: string) => `/fake/project/${p}`),
  normalizeUserProjectPath: vi.fn((p: string) => p),
}));
vi.mock('../../src/tools/shared.js', () => ({
  SCENE_TREE_HEADER: '',
  parseGdscriptResult: vi.fn(),
  wrapAssertionCode: vi.fn(),
  opsErrorResult: vi.fn((code: string, msg: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, error_code: code }) }],
    isError: true,
  })),
  validateTimeout: vi.fn((_v: unknown, _min: number, _max: number, dft: number) => dft),
  gdEscape: vi.fn((s: string) => s),
}));
vi.mock('../../src/tools/game-bridge.js', () => ({
  sendToBridge: vi.fn(),
  setBridgeProjectDir: vi.fn(),
  BRIDGE_READ_ONLY_METHODS: new Set<string>(['ping']),
}));
vi.mock('../../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(),
}));
vi.mock('../../src/tools/validation.js', () => ({
  batchValidateScripts: vi.fn(),
}));
vi.mock('../../src/tools/batch-tools.js', () => ({
  handleBatchAction: vi.fn(),
}));

// 审查 CRITICAL: scene_snapshot 的 _mcp_get_root().add_child(instance) 在 self.root==null 时
// null.add_child NPE 崩溃。加固为:var _root; if _root==null: 错误返回+queue_free; _root.add_child。
// 此测试锁定判空守卫,防回退到未判空的 _mcp_get_root().add_child(崩溃级)。
describe('workflow genSceneSnapshotScript: _root 判空守卫(CRITICAL 防回归)', () => {
  it('含 _root 判空守卫(null.add_child 防崩溃)', () => {
    const script = genSceneSnapshotScript('res://scenes/x.tscn', 5);
    expect(script).toContain('var _root: Node = _mcp_get_root()');
    expect(script).toContain('if _root == null:');
    expect(script).toContain('_mcp_output("error", "Scene root not available")');
    expect(script).toContain('instance.queue_free()');
    expect(script).toContain('_root.add_child(instance)');
    // 防回归:不应出现未判空的 _mcp_get_root().add_child(崩溃级)
    expect(script).not.toContain('_mcp_get_root().add_child');
  });
});

// ── Task 4: dev_loop progress 推送（total 矩阵 + 5 推送点）──
describe('dev_loop progress 推送（Task 4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 构造最小 ctx：progress emitter + findGodot（dev_loop 正常模式会调 ctx.findGodot）
  const makeCtx = (progress?: ReturnType<typeof vi.fn>) => ({
    progress,
    findGodot: async () => '/fake/godot',
  });

  it('仅 execute（无 verify/bridge/acceptance）→ 推送 [(1,1,executing)]', async () => {
    const { executeGdscript } = await import('../../src/gdscript-executor.js');
    (executeGdscript as any).mockResolvedValue({ compile_success: true, run_success: true, outputs: [] });
    const { handleTool } = await import('../../src/tools/workflow.js');
    const progress = vi.fn();
    await handleTool('workflow', { action: 'dev_loop', code: 'pass', project_path: '/p' }, makeCtx(progress) as any);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(1, 1, 'executing GDScript');
  });

  it('verify + bridge + acceptance → 4 次推送，total=4', async () => {
    const { executeGdscript } = await import('../../src/gdscript-executor.js');
    (executeGdscript as any).mockResolvedValue({ compile_success: true, run_success: true, outputs: [] });
    const { sendToBridge } = await import('../../src/tools/game-bridge.js');
    (sendToBridge as any).mockResolvedValue({ result: {} });
    // verify 路径走 runVerification → spawnGodot（已 mock）
    const { spawnGodot } = await import('../../src/tools/spawn-helper.js');
    (spawnGodot as any).mockResolvedValue({ timedOut: false, exitCode: 0, stdout: '' });
    const { handleTool } = await import('../../src/tools/workflow.js');
    const progress = vi.fn();
    await handleTool('workflow', {
      action: 'dev_loop', code: 'pass', project_path: '/p',
      verify: true,
      bridge: { queries: [{ method: 'ping' }] },
      acceptance: { assertions: [] },
    }, makeCtx(progress) as any);
    const calls = progress.mock.calls.map((c: any[]) => [c[0], c[1], c[2]]);
    expect(calls).toContainEqual([1, 4, 'executing GDScript']);
    expect(calls).toContainEqual([2, 4, 'verifying']);
    expect(calls).toContainEqual([3, 4, 'bridge queries/screenshot']);
    expect(calls).toContainEqual([4, 4, 'acceptance assertions']);
    expect(progress).toHaveBeenCalledTimes(4);
  });

  it('execute compile_error early-return → 仅 [(1,total)]，不推假完成', async () => {
    const { executeGdscript } = await import('../../src/gdscript-executor.js');
    (executeGdscript as any).mockResolvedValue({ compile_success: false, compile_error: 'boom', run_success: false, outputs: [] });
    const { handleTool } = await import('../../src/tools/workflow.js');
    const progress = vi.fn();
    const result: any = await handleTool('workflow', {
      action: 'dev_loop', code: 'pass', project_path: '/p', verify: true,
    }, makeCtx(progress) as any);
    // total = 1(execute) + 1(verify) = 2；execute 失败 early-return，只推 (1,2)
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(1, 2, 'executing GDScript');
    // 结果含 step1_execute='compile_error'，isError 未设（textResult 不设 isError）
    const text = result?.content?.[0]?.text ?? '';
    expect(text).toContain('compile_error');
    expect(result?.isError).toBeFalsy();
  });

  it('ctx.progress 为 undefined → 不抛、不推送、结果正常（向后兼容）', async () => {
    const { executeGdscript } = await import('../../src/gdscript-executor.js');
    (executeGdscript as any).mockResolvedValue({ compile_success: true, run_success: true, outputs: [] });
    const { handleTool } = await import('../../src/tools/workflow.js');
    // ctx 无 progress 字段（模拟无 token 的旧客户端）
    const result: any = await handleTool('workflow', { action: 'dev_loop', code: 'pass', project_path: '/p' }, makeCtx() as any);
    expect(result?.content?.[0]?.text).toBeTruthy();
  });

  it('DSL 模式 3 命令 → 推送 [(1,3,m1),(2,3,m2),(3,3,m3)]', async () => {
    const { sendToBridge } = await import('../../src/tools/game-bridge.js');
    (sendToBridge as any).mockResolvedValue({ result: {} });
    const { handleTool } = await import('../../src/tools/workflow.js');
    const progress = vi.fn();
    // 3 条合法 DSL（parseE2eDsl 实际格式：waitFor/click/press）
    const dsl = 'waitFor("root/Player")\nclick(640, 360)\npress("Key_W")';
    await handleTool('workflow', { action: 'dev_loop', code: dsl, project_path: '/p' }, makeCtx(progress) as any);
    const calls = progress.mock.calls.map((c: any[]) => [c[0], c[1], c[2]]);
    expect(calls).toEqual([
      [1, 3, 'wait_for_node'],
      [2, 3, 'send_mouse_click'],
      [3, 3, 'send_key'],
    ]);
  });
});

// ── H-2(2026-10-22 审查): frame_sequence 受信通道 + 路径转义 + 帧错误纳入 acceptance ──
describe('H-2 frame_sequence 归档链路与 acceptance 帧错误', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeCtx = () => ({ findGodot: async () => '/fake/godot' });

  it('copyScript 走 executeGdscriptTrusted,Windows 反斜杠路径转正斜杠(不再被沙箱 FileAccess.WRITE 误拦)', async () => {
    const { requireProjectPath } = await import('../../src/core/args-validation.js');
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-h2-'));
    vi.mocked(requireProjectPath).mockReturnValue(tmpProject);
    try {
      const { executeGdscript, executeGdscriptTrusted } = await import('../../src/gdscript-executor.js');
      const execMock = executeGdscript as unknown as Mock;
      const trustedMock = executeGdscriptTrusted as unknown as Mock;
      // step1 execute 正常通过(否则 early-return 到不了 acceptance)
      execMock.mockResolvedValue({ compile_success: true, run_success: true, outputs: [] });
      // 受信通道 mock:从 code 中解析目标路径并真写文件(recordFrameBytes 会 statSync 该文件)
      trustedMock.mockImplementation(async (opts: { code: string }) => {
        const m = /FileAccess\.open\("([^"]+)"/.exec(opts.code);
        if (m) fs.writeFileSync(m[1]!, Buffer.alloc(8));
        return { compile_success: true, run_success: true, outputs: [] };
      });
      const { sendToBridge } = await import('../../src/tools/game-bridge.js');
      (sendToBridge as unknown as Mock).mockResolvedValue({ result: {} });
      const { handleTool } = await import('../../src/tools/workflow.js');
      type WfCtx = Parameters<typeof handleTool>[2];
      const result = await handleTool('workflow', {
        action: 'dev_loop', code: 'pass', project_path: tmpProject,
        acceptance: { frame_sequence: { count: 2 }, assertions: [] },
      }, makeCtx() as unknown as WfCtx);

      // 归档脚本必须落在受信通道,普通通道零 FileAccess.open 调用(修复前:executeGdscript 被沙箱拦截必报 compile_error)
      const trustedCalls = trustedMock.mock.calls.filter((c: unknown[]) => /FileAccess\.open/.test((c[0] as { code: string }).code));
      expect(trustedCalls.length).toBeGreaterThanOrEqual(2); // count=2 帧
      const sandboxCalls = execMock.mock.calls.filter((c: unknown[]) => /FileAccess\.open/.test((c[0] as { code: string }).code));
      expect(sandboxCalls).toHaveLength(0);
      // 路径转义:code 内不得出现 "X:\..." 裸反斜杠(Windows run.dir 必含 \,已转正斜杠)
      for (const c of trustedCalls) {
        const code = (c[0] as { code: string }).code;
        expect(code).not.toMatch(/"[A-Za-z]:\\[^"]*"/);
        expect(code).toMatch(/FileAccess\.open\("[^"\\]*\/frame_\d+\.png"/);
      }
      // 帧捕获成功 + 无断言 → 仍产出 acceptance 汇总(H-2: 汇总移出「断言非空」块),passed=true
      const text = JSON.parse(result?.content?.[0]?.text ?? '{}');
      expect(text.frame_sequence.error).toBeUndefined();
      expect(text.acceptance).toEqual({ passed: true, results: [] });
      // B1/L-4: 无断言仅有 frame_sequence 时 proof 目录同样被清理
      expect(fs.existsSync(text.frame_sequence.dir)).toBe(false);
    } finally {
      vi.mocked(requireProjectPath).mockReturnValue('/fake/project');
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  it('帧捕获失败 → acceptance.passed=false 且 frame_sequence_error 存在(即使断言列表为空)', async () => {
    const { requireProjectPath } = await import('../../src/core/args-validation.js');
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-h2-'));
    vi.mocked(requireProjectPath).mockReturnValue(tmpProject);
    try {
      const { executeGdscript } = await import('../../src/gdscript-executor.js');
      (executeGdscript as unknown as Mock).mockResolvedValue({ compile_success: true, run_success: true, outputs: [] });
      const { sendToBridge } = await import('../../src/tools/game-bridge.js');
      (sendToBridge as unknown as Mock).mockResolvedValue({ error: { message: 'bridge down' } }); // 截图失败
      const { handleTool } = await import('../../src/tools/workflow.js');
      type WfCtx = Parameters<typeof handleTool>[2];
      const result = await handleTool('workflow', {
        action: 'dev_loop', code: 'pass', project_path: tmpProject,
        acceptance: { frame_sequence: { count: 2 }, assertions: [] },
      }, makeCtx() as unknown as WfCtx);

      const text = JSON.parse(result?.content?.[0]?.text ?? '{}');
      expect(text.frame_sequence.error).toContain('frame 0');
      // H-2 核心:帧错误必须把 acceptance 判死,不再静默通过
      expect(text.acceptance.passed).toBe(false);
      expect(text.acceptance.frame_sequence_error).toContain('frame 0');
      expect(text.acceptance.results).toEqual([]);
    } finally {
      vi.mocked(requireProjectPath).mockReturnValue('/fake/project');
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});

// ── L-5(2026-10-22 审查第二轮): waitMs(0) 显式零延迟不再被 `|| 100` 折成 100ms ──
describe('L-5 DSL waitMs(0) 语义', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waitMs(0) 立即通过,总耗时远低于 100ms(修复前恒 ≥100ms)', async () => {
    const { sendToBridge } = await import('../../src/tools/game-bridge.js');
    (sendToBridge as unknown as Mock).mockResolvedValue({ result: {} });
    const { handleTool } = await import('../../src/tools/workflow.js');
    type WfCtx = Parameters<typeof handleTool>[2];
    const ctx = { findGodot: async () => '/fake/godot' } as unknown as WfCtx;
    const t0 = Date.now();
    const result: any = await handleTool('workflow', { action: 'dev_loop', code: 'waitMs(0)', project_path: '/p' }, ctx);
    const elapsed = Date.now() - t0;
    // 修复前 `(ms as number) || 100` 把显式 0 折成 100ms;修复后 0ms 即过,80ms 窗口留 mock/IO 余量
    expect(elapsed).toBeLessThan(80);
    const text = JSON.parse(result?.content?.[0]?.text ?? '{}');
    expect(text.dsl_results ?? text.steps ?? text).toBeTruthy();
  });
});
