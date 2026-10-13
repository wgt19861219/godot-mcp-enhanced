// Task 5 接线测试(项目面板批 spec §6):GodotServer.run() 的 WebGuiServer 构造
// 扩注入 projects/runProject/editProject/isReadOnly 四键。mock 形态抄 env-gate.test.ts
// (SDK/process-state/editor 骨架同源);新增 runtime/projects-store/godot-finder/child_process
// 四组定向 mock——runProject 假成功防线(Task 3 review 裁决)经构造参数取出闭包直接测,
// 不重跑 executeRunProject 真实链(其行为已由 execute-run-project.test.ts 锁定)。
// 注:test/setup.js 全局已设 GODOT_MCP_WEB_GUI='0',本文件按用例显式覆盖并恢复。

import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockGuiStart, mockGuiStop } = vi.hoisted(() => ({
  mockGuiStart: vi.fn().mockResolvedValue(undefined),
  mockGuiStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/web-gui/server.js', () => ({
  // 注意 function 形式(非箭头)——GodotServer.run() 以 new 调用,箭头函数不可作构造器
  WebGuiServer: vi.fn().mockImplementation(function () { return { start: mockGuiStart, stop: mockGuiStop }; }),
  isWebGuiActive: vi.fn(() => false),
}));

// ─── 定向 mock:executeRunProject(防线测试的控制点;importOriginal 保 module-loader 链)───
const { mockExecuteRunProject } = vi.hoisted(() => ({
  mockExecuteRunProject: vi.fn(),
}));
vi.mock('../../src/tools/runtime.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, executeRunProject: mockExecuteRunProject };
});

// ─── 定向 mock:import-check(资源重导入批 2026-10-08:runProject 自动按需导入 +
//     reimportProject 注入链的控制在;真实 runImport 会 spawn godot,测试不可跑)───
const { mockNeedsImport, mockRunImport } = vi.hoisted(() => ({
  mockNeedsImport: vi.fn().mockReturnValue(false),
  mockRunImport: vi.fn().mockResolvedValue({ scanned: 0, gutted: [], gitModified: null }),
}));
vi.mock('../../src/tools/import-check.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, needsImport: mockNeedsImport, runImport: mockRunImport };
});

// ─── 定向 mock:ProjectsStore(防真实 ~/.godot-mcp 文件 IO;四方法 spy 断言委托)───
const { mockListProjects, mockScanProjects, mockAddProject, mockRemoveProject } = vi.hoisted(() => ({
  mockListProjects: vi.fn().mockResolvedValue([]),
  mockScanProjects: vi.fn().mockResolvedValue({ started: true, added: 0 }),
  mockAddProject: vi.fn().mockResolvedValue({ ok: true }),
  mockRemoveProject: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../src/web-gui/projects-store.js', () => ({
  ProjectsStore: vi.fn().mockImplementation(function () {
    return {
      listProjects: mockListProjects,
      scanProjects: mockScanProjects,
      addProject: mockAddProject,
      removeProject: mockRemoveProject,
    };
  }),
}));

// ─── 定向 mock:godot-finder 的 findGodot(editProject 复刻链可控;保留 re-export)───
const { mockFindGodot } = vi.hoisted(() => ({
  mockFindGodot: vi.fn().mockResolvedValue('C:/fake/godot.exe'),
}));
vi.mock('../../src/core/godot-finder.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findGodot: mockFindGodot };
});

// ─── 定向 mock:child_process 的 spawn(editProject 断言;execFile 等保留真实——
//     helpers.ts 依赖 execFile,纯工厂 mock 会令模块加载即抛,wiring.test.ts 教训)───
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: mockSpawn };
});

// ─── Mock MCP SDK(必须在 GodotServer import 前;骨架同 test/godot-server.test.js)───
const mockServerConnect = vi.fn().mockResolvedValue(undefined);
const mockServerClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function () {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = mockServerConnect;
    this.close = mockServerClose;
  }),
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('@modelcontextprotocol/core', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
  ListResourcesRequestSchema: 'ListResourcesRequestSchema',
  ListResourceTemplatesRequestSchema: 'ListResourceTemplatesRequestSchema',
  ReadResourceRequestSchema: 'ReadResourceRequestSchema',
  ListPromptsRequestSchema: 'ListPromptsRequestSchema',
  GetPromptRequestSchema: 'GetPromptRequestSchema',
  RootsListChangedNotificationSchema: 'RootsListChangedNotificationSchema',
  CompleteRequestSchema: 'CompleteRequestSchema',
}));

// ─── Mock fs 控制 resolveProjectPath(返回 null → 跳过 stateStore/projectPath 分支)───
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: mockExistsSync };
});

// ─── Mock editor 依赖(headless 用例不走,防真实网络/文件访问)──────────────────
vi.mock('../../src/core/editor-auth.js', () => ({
  waitForEditorSecret: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/core/EditorConnection.js', () => ({
  EditorConnection: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('no editor')),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../../src/core/EditorToolExecutor.js', () => ({
  EditorToolExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

// ─── Mock process-state(部分覆盖——stub close() 清理链所需,其余透传真实模块)───
// 自动按需导入的杀旧进程四步(getRunSessionProc 默认 null = 分支跳过,单用例覆写)。
const { mockGetRunSessionProc, mockMarkSessionStopping, mockReleaseRunSessionBusy, mockClearRunSession, mockKillProcess } = vi.hoisted(() => ({
  mockGetRunSessionProc: vi.fn().mockReturnValue(null),
  mockMarkSessionStopping: vi.fn(),
  mockReleaseRunSessionBusy: vi.fn(),
  mockClearRunSession: vi.fn(),
  mockKillProcess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRunningProcess: vi.fn().mockReturnValue(null),
    setRunningProcess: vi.fn(),
    setProcessBusy: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue([]),
    setOutputBuffer: vi.fn(),
    getProcessStartTime: vi.fn().mockReturnValue(0),
    setProcessStartTime: vi.fn(),
    getProjectDir: vi.fn().mockReturnValue(''),
    setProjectDir: vi.fn(),
    killProcess: mockKillProcess,
    getSpawnedGodotPids: vi.fn().mockReturnValue([]),
    killPidTree: vi.fn(),
    unregisterSpawnedGodotPid: vi.fn(),
    killOrphanGodotProcesses: vi.fn().mockResolvedValue(0),
    killAllRunSessions: vi.fn().mockResolvedValue(undefined),
    getRunSessionProc: mockGetRunSessionProc,
    markSessionStopping: mockMarkSessionStopping,
    releaseRunSessionBusy: mockReleaseRunSessionBusy,
    clearRunSession: mockClearRunSession,
  };
});

// ─── Import SUT(after mocks)──────────────────────────────────────────────────
import { GodotServer } from '../../src/GodotServer.js';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { ProjectsStore } from '../../src/web-gui/projects-store.js';
import { executeRunProject } from '../../src/tools/runtime.js';
import { tryAcquireImportLock, releaseImportLock, isImportLocked, resetImportLocks } from '../../src/web-gui/import-mutex.js';
import { normalizeProjectKey, setSessionStatus, appendOutput, setRunSessionProc, removeRunSession } from '../../src/core/process-state.js';

/** run() 一次(env='1')并返回 WebGuiServer 构造参数(断言目标);实例登记待 afterEach close。 */
const pendingServers: Array<{ close: () => Promise<void> }> = [];
async function runAndGetOpts(): Promise<Record<string, unknown>> {
  process.env.GODOT_MCP_WEB_GUI = '1';
  const server = new GodotServer('/fake/ops.gd');
  pendingServers.push(server);
  await server.run();
  const calls = vi.mocked(WebGuiServer).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

describe('GodotServer 项目面板接线(spec 2026-09-15 §6)', () => {
  const prevGui = process.env.GODOT_MCP_WEB_GUI;
  const prevReadOnly = process.env.GODOT_MCP_READ_ONLY;
  const prevReadOnlyMode = process.env.READ_ONLY_MODE;
  const prevVault = process.env.GODOT_MCP_VAULT_PATH;

  afterEach(async () => {
    while (pendingServers.length > 0) {
      await pendingServers.pop()!.close().catch(() => { /* best-effort 清理 */ });
    }
    process.env.GODOT_MCP_WEB_GUI = prevGui;
    process.env.GODOT_MCP_READ_ONLY = prevReadOnly;
    process.env.READ_ONLY_MODE = prevReadOnlyMode;
    // 审查 Major-T1(2026-10-13):VAULT 键并入统一恢复集——此前 kb 用例内自行恢复无
    // try/finally,断言失败时「vault env 被 delete」泄漏到同 worker 后续文件。
    // undefined 走 delete(直接赋 undefined 会落成字符串 'undefined',process.env 经典坑)。
    if (prevVault === undefined) delete process.env.GODOT_MCP_VAULT_PATH;
    else process.env.GODOT_MCP_VAULT_PATH = prevVault;
    vi.clearAllMocks();
    resetImportLocks();   // 共享互斥模块级状态隔离(2026-10-08 I-1 修复批)
  });

  it("env 非 '0':构造参数含 projects/runProject/editProject/isReadOnly 四键;ProjectsStore 构造注入 getSessions", async () => {
    const opts = await runAndGetOpts();
    for (const key of ['projects', 'runProject', 'editProject', 'isReadOnly']) {
      expect(opts[key], `缺少注入键 ${key}`).toBeDefined();
    }
    // stdio 类型登记(2026-10-08 实例分类批):此前 stdio 侧从不写 kind → 面板把所有
    // stdio 实例(含最新代码)误显示「早期实例」;daemon 侧 overrides 'daemon' 覆盖本值
    expect(opts.instanceKind).toBe('stdio');
    // getSessions 注入满足 running 判定(spec §3.3:对照 listRunSessionsDetailed)
    const storeArgs = vi.mocked(ProjectsStore).mock.calls.at(-1)![0] as { getSessions?: () => unknown };
    expect(typeof storeArgs.getSessions).toBe('function');
    expect(Array.isArray(storeArgs.getSessions!())).toBe(true);
  });

  it('getSessionOutput 注入(2026-10-08 输出查看批):两态取数(运行中 outputBuffer/已结束 lastFinishedRunOutput)+ 桶不存在 null;finally 清桶防泄漏', async () => {
    const opts = await runAndGetOpts();
    const fn = opts.getSessionOutput as (p: string) => { status: string; running: boolean; lines: string[] } | null;
    expect(fn, '缺少注入键 getSessionOutput').toBeDefined();
    // 桶不存在 → null(端点 404 语义)
    expect(fn('D:/never/ran/project-x')).toBeNull();
    const key = normalizeProjectKey('D:/out-view/wiring-test');
    try {
      // 运行态:outputBuffer 实时读
      setSessionStatus(key, 'running');
      appendOutput(['live-line-1', 'ERROR: boom'], key);
      expect(fn('D:/out-view/wiring-test')).toEqual({ status: 'running', running: true, lines: ['live-line-1', 'ERROR: boom'] });
      // 结束态:setRunSessionProc(null) 触发 stash → lastFinishedRunOutput(崩溃后回查场景)
      setRunSessionProc(key, null);
      setSessionStatus(key, 'exited');
      expect(fn('D:/out-view/wiring-test')).toEqual({ status: 'exited', running: false, lines: ['live-line-1', 'ERROR: boom'] });
    } finally {
      removeRunSession(key);   // exited 态桶允许移除,模块级状态不泄漏给后续用例
    }
    expect(fn('D:/out-view/wiring-test')).toBeNull();
  });

  it('settings 注入(2026-09-29 设置批,审查 Nit-1):UserSettingsService 实例三方法 + isReadOnly 同源透传', async () => {
    const opts = await runAndGetOpts();
    const settings = opts.settings as
      | { get: () => Promise<{ readOnly: boolean }>; verify: (p: string) => Promise<unknown>; save: (p: unknown) => Promise<unknown> }
      | undefined;
    expect(settings, '缺少注入键 settings').toBeDefined();
    expect(typeof settings!.get).toBe('function');
    expect(typeof settings!.verify).toBe('function');
    expect(typeof settings!.save).toBe('function');
    // isReadOnly 同源透传(get 只读展示;get 读 ~/.godot-mcp/settings.json,测试机无该文件
    // → 空设置容错,零写操作)
    process.env.GODOT_MCP_READ_ONLY = 'true';
    expect((await settings!.get()).readOnly).toBe(true);
    process.env.GODOT_MCP_READ_ONLY = 'false';
    expect((await settings!.get()).readOnly).toBe(false);
  });

  it('kb 注入(2026-10-08 知识库联动批):KbApi 实例三方法;未配置 vault 时 overview 返回引导态而非报错', async () => {
    const opts = await runAndGetOpts();
    const kb = opts.kb as
      | { overview: () => Promise<{ configured: boolean }>; projectDetail: (n: string) => Promise<unknown>; readFile: (n: string, r: string) => Promise<unknown> }
      | undefined;
    expect(kb, '缺少注入键 kb').toBeDefined();
    expect(typeof kb!.overview).toBe('function');
    expect(typeof kb!.projectDetail).toBe('function');
    expect(typeof kb!.readFile).toBe('function');
    // 测试环境未配 GODOT_MCP_VAULT_PATH(settings.json 亦无)→ 引导态(真机配置验证由
    // 面板人工验收覆盖);env 恢复由本文件 afterEach 统一处理(审查 Major-T1 修复)。
    delete process.env.GODOT_MCP_VAULT_PATH;
    const ov = await kb!.overview();
    expect(ov.configured).toBe(false);
  });

  it('projects 四方法委托 ProjectsStore 实例四方法(scan 回调透传)', async () => {
    const opts = await runAndGetOpts();
    const projects = opts.projects as {
      list: () => Promise<unknown>;
      scan: (cb?: (n: number, m: number) => void) => Promise<unknown>;
      add: (p: string) => Promise<unknown>;
      remove: (p: string) => Promise<unknown>;
    };
    await projects.list();
    expect(mockListProjects).toHaveBeenCalledTimes(1);
    const onProgress = (n: number, m: number) => { void n; void m; };
    await projects.scan(onProgress);
    expect(mockScanProjects).toHaveBeenCalledWith(onProgress);
    await projects.add('D:/fake/proj');
    expect(mockAddProject).toHaveBeenCalledWith('D:/fake/proj');
    await projects.remove('D:/fake/proj');
    expect(mockRemoveProject).toHaveBeenCalledWith('D:/fake/proj');
  });

  it('runProject 走真实链路:executeRunProject 收 {action,project_path,preview:true} + dispatcher.getContext() 的 ctx', async () => {
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: game window is now open at D:/fake/proj' }] });
    const opts = await runAndGetOpts();
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockExecuteRunProject).toHaveBeenCalledTimes(1);
    const [args, ctx] = mockExecuteRunProject.mock.calls[0] as [
      Record<string, unknown>,
      { findGodot?: unknown; setProjectDir?: unknown; projectDir?: unknown },
    ];
    // preview: true = 面板拉起即看语义(spec §6);args 仅必填 action/project_path
    expect(args).toEqual({ action: 'run_project', project_path: 'D:/fake/proj', preview: true });
    // Task 1 getContext() 真实链路:ctx 是 ToolDispatcher 的真实 ctx(IMP-4 三必用成员在场)
    expect(typeof ctx.findGodot).toBe('function');
    expect(typeof ctx.setProjectDir).toBe('function');
    expect(typeof ctx.projectDir).toBe('string');
  });

  it('runProject 假成功防线:isError 结果 → throw(端点 catch 转 500,前 200 字符提取)', async () => {
    mockExecuteRunProject.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'Bridge not ready (timeout). Game stopped.' }],
    });
    const opts = await runAndGetOpts();
    await expect((opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj'))
      .rejects.toThrow(/Bridge not ready/);
  });

  it('runProject 假成功防线:"Error:" 前缀 textResult(无 isError,Task 1 行为零变事实)→ throw', async () => {
    // executeRunProject 失败大多走 textResult("Error: ...")且不带 isError(runtime.ts
    // :156/:179/:195/:231/:248);仅 bridge 未就绪走 errorResult(isError)——防线必须双判。
    mockExecuteRunProject.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Error: Not a Godot project (no project.godot found): D:/fake/proj' }],
    });
    const opts = await runAndGetOpts();
    await expect((opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj'))
      .rejects.toThrow(/Not a Godot project/);
  });

  it('runProject 成功(Preview mode 文本)→ resolve 原 ToolResult(不误伤)', async () => {
    const ok = { content: [{ type: 'text', text: 'Preview mode: game window is now open at D:/fake/proj' }] };
    mockExecuteRunProject.mockResolvedValueOnce(ok);
    const opts = await runAndGetOpts();
    await expect((opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj')).resolves.toBe(ok);
  });

  it('editProject 复刻 launch_editor 链:findGodot + detached spawn(--editor --path)+ unref', async () => {
    const opts = await runAndGetOpts();
    await (opts.editProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockFindGodot).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], { detached?: boolean; stdio?: unknown; env?: unknown }];
    expect(bin).toBe('C:/fake/godot.exe');
    expect(args).toEqual(['--editor', '--path', 'D:/fake/proj']);
    expect(spawnOpts.detached).toBe(true);
    expect(spawnOpts.stdio).toBe('ignore');
    expect(typeof spawnOpts.env).toBe('object');   // buildSafeEnv()(helpers.ts)产物
  });

  // ─── 资源重导入批(2026-10-08):reimportProject 注入 + runProject 自动按需导入 ───

  it('reimportProject 注入:runImport 收 (path, findGodot, 120_000) 并透传 integrity 报告', async () => {
    mockRunImport.mockResolvedValueOnce({ scanned: 3, gutted: ['a.png.import'], gitModified: null });
    const opts = await runAndGetOpts();
    expect(opts.reimportProject, '缺少注入键 reimportProject').toBeDefined();
    const report = await (opts.reimportProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockRunImport).toHaveBeenCalledTimes(1);
    expect(mockRunImport).toHaveBeenCalledWith('D:/fake/proj', 'C:/fake/godot.exe', 120_000);
    expect(report).toEqual({ scanned: 3, gutted: ['a.png.import'], gitModified: null });
  });

  it('runProject 自动按需导入:needsImport=false → runImport 不调,直奔 executeRunProject', async () => {
    mockNeedsImport.mockReturnValue(false);
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockNeedsImport).toHaveBeenCalledWith('D:/fake/proj');
    expect(mockRunImport).not.toHaveBeenCalled();
    expect(mockExecuteRunProject).toHaveBeenCalledTimes(1);
  });

  it('runProject 自动按需导入:needsImport=true → 先 runImport 后 executeRunProject(顺序断言)', async () => {
    mockNeedsImport.mockReturnValue(true);
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockRunImport).toHaveBeenCalledWith('D:/fake/proj', 'C:/fake/godot.exe', 120_000);
    // 顺序:import 必须先于 spawn(importer 重写缓存不得与游戏进程并发)
    expect(mockRunImport.mock.invocationCallOrder[0]).toBeLessThan(mockExecuteRunProject.mock.invocationCallOrder[0]);
  });

  it('runProject 自动按需导入:旧进程在跑 → 杀进程四步先于 runImport(stopSession 同款)', async () => {
    mockNeedsImport.mockReturnValue(true);
    mockGetRunSessionProc.mockReturnValueOnce({ pid: 4321 } as never);
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockMarkSessionStopping).toHaveBeenCalledWith('D:/fake/proj');
    expect(mockReleaseRunSessionBusy).toHaveBeenCalledWith('D:/fake/proj');
    expect(mockClearRunSession).toHaveBeenCalledWith('D:/fake/proj');
    // 杀进程完成先于 import(killProcess await 后才 runImport)
    expect(mockKillProcess.mock.invocationCallOrder[0]).toBeLessThan(mockRunImport.mock.invocationCallOrder[0]);
  });

  it('runProject 自动按需导入:runImport 失败 → 不阻断启动(warn 语义,executeRunProject 仍执行)', async () => {
    mockNeedsImport.mockReturnValue(true);
    mockRunImport.mockRejectedValueOnce(new Error('Import warmup timed out after 120000ms'));
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    const r = await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    expect(mockExecuteRunProject).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ content: [{ type: 'text', text: 'Preview mode: ok' }] });   // 启动结果原样返回
  });

  // ─── I-1 修复(2026-10-08 审查):自动导入与面板 ⟳ 端点共享 import-mutex ───

  it('I-1 反向:⟳ 持锁时 runProject 排队等待(不并发起 import),锁释放后继续', async () => {
    mockNeedsImport.mockReturnValue(true);
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    const key = normalizeProjectKey('D:/fake/proj');
    expect(tryAcquireImportLock(key)).toBe(true);   // 模拟手动 ⟳ 端点先持有共享锁
    const pending = (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    await new Promise(r => setTimeout(r, 20));
    expect(mockRunImport).not.toHaveBeenCalled();    // 排队中——不再并发起第二个 --import
    expect(mockExecuteRunProject).not.toHaveBeenCalled();
    releaseImportLock(key);                          // 手动导入完成
    await pending;
    expect(mockRunImport).toHaveBeenCalledTimes(1);  // 轮到后才导入(双检仍 true)
    expect(mockExecuteRunProject).toHaveBeenCalledTimes(1);
  });

  it('I-1 双检:等待期间他人导入完成(needsImport 二次 false)→ 跳过重复导入但照常启动', async () => {
    mockNeedsImport.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockExecuteRunProject.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    const key = normalizeProjectKey('D:/fake/proj');
    tryAcquireImportLock(key);
    const pending = (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');
    await new Promise(r => setTimeout(r, 20));
    releaseImportLock(key);
    await pending;
    expect(mockNeedsImport).toHaveBeenCalledTimes(2);            // 段首 + 锁内双检
    expect(mockRunImport).not.toHaveBeenCalled();                // 他人已导入 → 不重复
    expect(mockExecuteRunProject).toHaveBeenCalledTimes(1);      // 启动不受影响
  });

  it('I-1 锁释放:自动导入成功/失败路径结束后锁均释放(finally)', async () => {
    const key = normalizeProjectKey('D:/fake/proj');
    mockNeedsImport.mockReturnValue(true);
    mockExecuteRunProject.mockResolvedValue({ content: [{ type: 'text', text: 'Preview mode: ok' }] });
    const opts = await runAndGetOpts();
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');   // 成功路径
    expect(isImportLocked(key)).toBe(false);
    mockRunImport.mockRejectedValueOnce(new Error('boom'));
    await (opts.runProject as (p: string) => Promise<unknown>)('D:/fake/proj');  // 失败路径
    expect(isImportLocked(key)).toBe(false);
  });

  it('isReadOnly 状态源与 index.ts 同源:GODOT_MCP_READ_ONLY / READ_ONLY_MODE', async () => {
    const opts = await runAndGetOpts();
    const isReadOnly = opts.isReadOnly as () => boolean;
    expect(isReadOnly()).toBe(false);
    process.env.GODOT_MCP_READ_ONLY = 'true';
    expect(isReadOnly()).toBe(true);
    process.env.GODOT_MCP_READ_ONLY = 'false';
    expect(isReadOnly()).toBe(false);
    process.env.READ_ONLY_MODE = 'true';
    expect(isReadOnly()).toBe(true);
  });

  it("env='0':不构造 WebGuiServer(env-gate 互补断言)", async () => {
    process.env.GODOT_MCP_WEB_GUI = '0';
    const server = new GodotServer('/fake/ops.gd');
    await server.run();
    expect(vi.mocked(WebGuiServer)).not.toHaveBeenCalled();
    await server.close();
  });
});
