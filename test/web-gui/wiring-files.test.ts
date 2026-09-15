// Task 6 接线测试(资源工作台 Plan A spec §3.1):GodotServer.run() 的 WebGuiServer
// 构造扩注入 files 键(FilesApi 实例,backupDir 缺省 ~/.godot-mcp/web-gui/backups)。
// 探测形态完整复刻 wiring-projects.test.ts(mock WebGuiServer 捕获构造参数 +
// SDK/process-state/editor 骨架同源);新增 files-api 定向 mock——防真实 ~/.godot-mcp
// 备份目录 IO;注入语义为"实例直注"(无委托包装),断言五方法在场 + 调用直达实例。
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

// ─── 定向 mock:FilesApi(防真实 ~/.godot-mcp/web-gui/backups IO;实例方法 spy 断言直注)───
const { mockListDir, mockReadText, mockReadRaw, mockReadHex, mockSaveText } = vi.hoisted(() => ({
  mockListDir: vi.fn().mockResolvedValue({ entries: [] }),
  mockReadText: vi.fn().mockResolvedValue({ content: '', mtime: 0, size: 0 }),
  mockReadRaw: vi.fn().mockResolvedValue({ bytes: Buffer.alloc(0), contentType: 'application/octet-stream', size: 0 }),
  mockReadHex: vi.fn().mockResolvedValue({ size: 0, bytes: [] }),
  mockSaveText: vi.fn().mockResolvedValue({ ok: true, mtime: 0 }),
}));
vi.mock('../../src/web-gui/files-api.js', () => ({
  FilesApi: vi.fn().mockImplementation(function () {
    return {
      listDir: mockListDir,
      readText: mockReadText,
      readRaw: mockReadRaw,
      readHex: mockReadHex,
      saveText: mockSaveText,
    };
  }),
}));

// ─── 定向 mock:executeRunProject(runProject 分支引用;保 module-loader 链)───
const { mockExecuteRunProject } = vi.hoisted(() => ({
  mockExecuteRunProject: vi.fn(),
}));
vi.mock('../../src/tools/runtime.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, executeRunProject: mockExecuteRunProject };
});

// ─── 定向 mock:ProjectsStore(防真实 ~/.godot-mcp 文件 IO;projects 组装链走通)───
vi.mock('../../src/web-gui/projects-store.js', () => ({
  ProjectsStore: vi.fn().mockImplementation(function () {
    return {
      listProjects: vi.fn().mockResolvedValue([]),
      scanProjects: vi.fn().mockResolvedValue({ started: true, added: 0 }),
      addProject: vi.fn().mockResolvedValue({ ok: true }),
      removeProject: vi.fn().mockResolvedValue({ ok: true }),
    };
  }),
}));

// ─── 定向 mock:godot-finder 的 findGodot(editProject 复刻链可控;保留 re-export)───
vi.mock('../../src/core/godot-finder.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findGodot: vi.fn().mockResolvedValue('C:/fake/godot.exe') };
});

// ─── 定向 mock:child_process 的 spawn(构造链 import 副作用防真实进程;execFile 等保留)───
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) };
});

// ─── Mock MCP SDK(必须在 GodotServer import 前;骨架同 wiring-projects.test.ts)───
vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function () {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
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
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
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
import { FilesApi } from '../../src/web-gui/files-api.js';

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

describe('GodotServer files 接线(资源工作台 Plan A spec §3.1,Task 6)', () => {
  const prevGui = process.env.GODOT_MCP_WEB_GUI;

  afterEach(async () => {
    while (pendingServers.length > 0) {
      await pendingServers.pop()!.close().catch(() => { /* best-effort 清理 */ });
    }
    process.env.GODOT_MCP_WEB_GUI = prevGui;
    vi.clearAllMocks();
  });

  it("env 非 '0':构造参数含 files 键,为 FilesApi 实例且五方法在场(端到端可用语义)", async () => {
    const opts = await runAndGetOpts();
    expect(opts.files, '缺少注入键 files').toBeDefined();
    // 实例直注(无委托包装):opts.files 即 new FilesApi() 产物,五方法直达端点层
    const files = opts.files as Record<string, unknown>;
    for (const m of ['listDir', 'readText', 'readRaw', 'readHex', 'saveText']) {
      expect(typeof files[m], `files.${m} 应为函数`).toBe('function');
    }
  });

  it('FilesApi 构造于组装链:new 调用且不指定 backupDir(缺省 ~/.godot-mcp/web-gui/backups)', async () => {
    await runAndGetOpts();
    const calls = vi.mocked(FilesApi).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 缺省语义:构造参数不携带 backupDir 覆盖(传 {} 或不传均可,关键是不改缺省)
    const arg = calls.at(-1)![0] as { backupDir?: string } | undefined;
    expect(arg?.backupDir).toBeUndefined();
  });

  it('files 方法直达实例:调用 opts.files.listDir → mock 实例方法收到原参(委托零转译)', async () => {
    const opts = await runAndGetOpts();
    await (opts.files as { listDir: (p: string, s: string) => Promise<unknown> }).listDir('D:/fake/proj', 'src');
    expect(mockListDir).toHaveBeenCalledWith('D:/fake/proj', 'src');
  });

  it('接线不破坏既有键:projects/runProject/editProject/isReadOnly 仍在(files 追加非替换)', async () => {
    const opts = await runAndGetOpts();
    for (const key of ['projects', 'runProject', 'editProject', 'isReadOnly', 'files']) {
      expect(opts[key], `缺少注入键 ${key}`).toBeDefined();
    }
  });
});
