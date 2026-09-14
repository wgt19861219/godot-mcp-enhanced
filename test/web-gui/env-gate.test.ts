// Task 9 review 交接断言补齐(与 open.test.ts 真实实例驱动互补):GodotServer 层 env 门——
// GODOT_MCP_WEB_GUI='0' 时 run() 不构造 WebGuiServer;非 '0' 时构造并 start,
// webGuiActive 三态字段随 start/close 传播。vi.mock web-gui/server.js 断言构造函数调用
// (mock 模式参考 test/web-gui/wiring.test.ts;SDK/process-state 等 mock 骨架抄
// test/godot-server.test.js——故独立文件,避免与 open.test.ts 的真实 WebGuiServer 用例冲突)。
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

describe('GodotServer 层 env 门 GODOT_MCP_WEB_GUI(Task 9 review 交接断言)', () => {
  const prev = process.env.GODOT_MCP_WEB_GUI;
  afterEach(() => {
    process.env.GODOT_MCP_WEB_GUI = prev;
    vi.clearAllMocks();
  });

  it("env='0':run() 不构造 WebGuiServer,webGuiActive=false", async () => {
    process.env.GODOT_MCP_WEB_GUI = '0';
    const server = new GodotServer('/fake/ops.gd');
    await server.run();
    expect(vi.mocked(WebGuiServer)).not.toHaveBeenCalled();
    expect(server.webGuiActive).toBe(false);
    await server.close();
  });

  it("env 非 '0':run() 构造并 start,webGuiActive=true;close() 调 stop 且归 false", async () => {
    process.env.GODOT_MCP_WEB_GUI = '1';
    const server = new GodotServer('/fake/ops.gd');
    await server.run();
    expect(vi.mocked(WebGuiServer)).toHaveBeenCalledTimes(1);
    expect(mockGuiStart).toHaveBeenCalledTimes(1);
    expect(server.webGuiActive).toBe(true);
    await server.close();
    expect(mockGuiStop).toHaveBeenCalledTimes(1);
    expect(server.webGuiActive).toBe(false);
  });
});
