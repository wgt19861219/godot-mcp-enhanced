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
    killProcess: vi.fn().mockResolvedValue(undefined),
    getSpawnedGodotPids: vi.fn().mockReturnValue([]),
    killPidTree: vi.fn(),
    unregisterSpawnedGodotPid: vi.fn(),
    killOrphanGodotProcesses: vi.fn().mockResolvedValue(0),
    killAllRunSessions: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Import SUT(after mocks)──────────────────────────────────────────────────
import { GodotServer } from '../../src/GodotServer.js';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { ProjectsStore } from '../../src/web-gui/projects-store.js';
import { executeRunProject } from '../../src/tools/runtime.js';

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

  afterEach(async () => {
    while (pendingServers.length > 0) {
      await pendingServers.pop()!.close().catch(() => { /* best-effort 清理 */ });
    }
    process.env.GODOT_MCP_WEB_GUI = prevGui;
    process.env.GODOT_MCP_READ_ONLY = prevReadOnly;
    process.env.READ_ONLY_MODE = prevReadOnlyMode;
    vi.clearAllMocks();
  });

  it("env 非 '0':构造参数含 projects/runProject/editProject/isReadOnly 四键;ProjectsStore 构造注入 getSessions", async () => {
    const opts = await runAndGetOpts();
    for (const key of ['projects', 'runProject', 'editProject', 'isReadOnly']) {
      expect(opts[key], `缺少注入键 ${key}`).toBeDefined();
    }
    // getSessions 注入满足 running 判定(spec §3.3:对照 listRunSessionsDetailed)
    const storeArgs = vi.mocked(ProjectsStore).mock.calls.at(-1)![0] as { getSessions?: () => unknown };
    expect(typeof storeArgs.getSessions).toBe('function');
    expect(Array.isArray(storeArgs.getSessions!())).toBe(true);
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
