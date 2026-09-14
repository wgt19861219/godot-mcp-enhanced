// test/k-subscribe-setlevel.test.ts — 批 K：K-1 resources/subscribe 最小实现 + K-2 setLevel 行为锁定
//
// K-1 (:942①): push 事件(notifications/resources/updated)只发已订阅客户端。
//   此前无条件广播违反 MCP 协议"should only be sent if the client previously
//   sent a resources/subscribe request";capabilities 也未声明 subscribe:true。
// K-2 (:942④): finding 声称"logging: {} 但无 setLevel handler → method not found"。
//   实测 SDK 2.x Server 构造时声明 logging capability 即自动注册内置 setLevel handler
//   (维护 per-session _loggingLevels,sendLoggingMessage 按 isMessageIgnored 过滤)。
//   本文件 Part 2 用真实 SDK + InMemoryTransport 锁定该行为;GodotServer 不自行注册
//   setLevel handler(Map.set 会覆盖内置 → 丢 _loggingLevels 状态,引入回归)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ─── Mock MCP SDK (must be before GodotServer import;对齐 godot-server.test.js) ───
const mockSetRequestHandler = vi.fn();
const mockSetNotificationHandler = vi.fn();
const mockNotification = vi.fn();
const mockServerClose = vi.fn().mockResolvedValue(undefined);
const mockServerConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function (_info: unknown, options: { capabilities?: Record<string, unknown> }) {
    this._capabilities = options?.capabilities;
    this.setRequestHandler = mockSetRequestHandler;
    this.setNotificationHandler = mockSetNotificationHandler;
    this.notification = mockNotification;
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

// ─── Mock fs / editor-auth / EditorConnection / process-state (对齐先例) ──────
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

const { mockWaitForEditorSecret } = vi.hoisted(() => ({
  mockWaitForEditorSecret: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/core/editor-auth.js', () => ({
  waitForEditorSecret: (...args: unknown[]) => mockWaitForEditorSecret(...args),
}));

vi.mock('../src/core/EditorConnection.js', () => ({
  EditorConnection: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('no editor')),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../src/core/EditorToolExecutor.js', () => ({
  EditorToolExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    destroy: vi.fn(),
  })),
}));

// Task 3(设计 §7 I-4):vi.mock(importOriginal) 部分覆盖——仅 stub 测试真正需要的
// 函数,其余导出(含 killAllRunSessions 等新导出)透传真实模块,根治补导出漂移。
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/process-state.js')>();
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
  };
});

// ─── Mock game-bridge: 捕获 registerBridgePushHandler 注册的 push 回调 ─────────
// 不整模块替换(其他工具模块也 import game-bridge),importOriginal 保真实导出,
// 仅覆盖 registerBridgePushHandler 为捕获 spy —— K-1 测试直接调捕获的回调。
const { mockRegisterBridgePushHandler } = vi.hoisted(() => ({
  mockRegisterBridgePushHandler: vi.fn(),
}));
vi.mock('../src/tools/game-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/game-bridge.js')>();
  return { ...actual, registerBridgePushHandler: mockRegisterBridgePushHandler };
});

// ─── Import SUT (after mocks) ────────────────────────────────────────────────
import { GodotServer } from '../src/GodotServer.js';
import { Server } from '@modelcontextprotocol/server';

/** 从 mockSetRequestHandler 调用记录中取指定 method 的 handler。 */
function getHandler(method: string): (req: unknown) => Promise<unknown> {
  const call = mockSetRequestHandler.mock.calls.find(c => c[0] === method);
  if (!call) throw new Error(`handler not registered: ${method}`);
  return call[1] as (req: unknown) => Promise<unknown>;
}

/** 取 GodotServer 注册的 push 回调(constructor 调 registerBridgePushHandler 时捕获)。 */
function getPushCallback(): (params: Record<string, unknown>) => void {
  const cb = mockRegisterBridgePushHandler.mock.calls[0]?.[0];
  if (typeof cb !== 'function') throw new Error('push callback not registered');
  return cb;
}

describe('K-1: resources/subscribe 最小实现(push 仅达订阅者)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockWaitForEditorSecret.mockResolvedValue(null);
    mockNotification.mockClear();
  });

  it('capabilities 声明 resources.subscribe: true', () => {
    new GodotServer('/fake/ops.gd');
    const opts = vi.mocked(Server).mock.calls[0]?.[1] as { capabilities?: { resources?: { subscribe?: boolean } } };
    expect(opts?.capabilities?.resources?.subscribe).toBe(true);
  });

  it('未订阅客户端不收 push(修复前无条件广播)', async () => {
    new GodotServer('/fake/ops.gd');
    const push = getPushCallback();
    push({ type: 'watch', data: { event: 1 } });
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('订阅 bridge://events 后 push 以 notifications/resources/updated 到达', async () => {
    new GodotServer('/fake/ops.gd');
    const subscribe = getHandler('resources/subscribe');
    const res = await subscribe({ params: { uri: 'bridge://events' } });
    expect(res).toEqual({}); // EmptyResult 确认

    const push = getPushCallback();
    push({ type: 'watch', data: { event: 1 } });
    expect(mockNotification).toHaveBeenCalledTimes(1);
    expect(mockNotification).toHaveBeenCalledWith({
      method: 'notifications/resources/updated',
      params: { uri: 'bridge://events', type: 'watch', data: { event: 1 } },
    });
  });

  it('重复订阅幂等:两次 subscribe 后 push 恰发一次,不异常', async () => {
    new GodotServer('/fake/ops.gd');
    const subscribe = getHandler('resources/subscribe');
    await subscribe({ params: { uri: 'bridge://events' } });
    await expect(subscribe({ params: { uri: 'bridge://events' } })).resolves.toEqual({});

    getPushCallback()({ type: 'watch' });
    expect(mockNotification).toHaveBeenCalledTimes(1); // Set 去重,非数组追加
  });

  it('unsubscribe 后停发;未订阅 URI 的 unsubscribe 不炸(幂等)', async () => {
    new GodotServer('/fake/ops.gd');
    const subscribe = getHandler('resources/subscribe');
    const unsubscribe = getHandler('resources/unsubscribe');
    await unsubscribe({ params: { uri: 'bridge://events' } }); // 未订阅先退订:不炸
    await subscribe({ params: { uri: 'bridge://events' } });
    await unsubscribe({ params: { uri: 'bridge://events' } });

    getPushCallback()({ type: 'watch' });
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('close() 清空订阅集合(热重启/测试隔离防残留)', async () => {
    const gs = new GodotServer('/fake/ops.gd');
    await getHandler('resources/subscribe')({ params: { uri: 'bridge://events' } });
    getPushCallback()({ type: 'watch' });
    expect(mockNotification).toHaveBeenCalledTimes(1);

    await gs.close();
    getPushCallback()({ type: 'watch' }); // close 清 Set → 不再发
    expect(mockNotification).toHaveBeenCalledTimes(1);
  });
});

// ─── Part 2: K-2 setLevel 行为锁定(真实 SDK,vi.importActual 绕过文件级 mock) ──

describe('K-2: logging/setLevel — SDK 内置 handler 行为锁定', () => {
  it('声明 logging capability 的 SDK Server: setLevel 有响应,不 method not found', async () => {
    const actual = await vi.importActual<typeof import('@modelcontextprotocol/server')>('@modelcontextprotocol/server');
    const server = new actual.Server(
      { name: 'k2-test', version: '1.0.0' },
      { capabilities: { logging: {} } }, // 与 GodotServer 相同的声明方式
    );
    const [sT, cT] = actual.InMemoryTransport.createLinkedPair();
    await server.connect(sT);

    const pending: Array<(m: unknown) => void> = [];
    cT.onmessage = (m: unknown) => { pending.shift()?.(m); };
    const request = (msg: unknown) =>
      new Promise<unknown>((resolve) => { pending.push(resolve); void cT.send(msg as never); });

    const res = (await request({ jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: { level: 'debug' } })) as
      { result?: unknown; error?: unknown };
    expect(res.error).toBeUndefined(); // finding :942④ 声称会 method not found —— 实测不成立
    expect(res.result).toEqual({});
    await server.close();
  });

  it('setLevel 后 sendLoggingMessage 按级别过滤(_loggingLevels 状态真被维护)', async () => {
    const actual = await vi.importActual<typeof import('@modelcontextprotocol/server')>('@modelcontextprotocol/server');
    const server = new actual.Server(
      { name: 'k2-test', version: '1.0.0' },
      { capabilities: { logging: {} } },
    );
    const [sT, cT] = actual.InMemoryTransport.createLinkedPair();
    await server.connect(sT);

    const received: unknown[] = [];
    cT.onmessage = (m: unknown) => { received.push(m); };

    // 客户端设 error 级 → 低于 error 的日志被 isMessageIgnored 过滤
    await new Promise<void>((resolve) => {
      const wait = setTimeout(resolve, 50);
      cT.send({ jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: { level: 'error' } } as never).then(() => {
        clearTimeout(wait);
        resolve();
      });
    });
    await server.sendLoggingMessage({ level: 'debug', data: 'should be filtered' });
    await server.sendLoggingMessage({ level: 'error', data: 'should pass' });
    await new Promise((r) => setTimeout(r, 50)); // 等 notification 派发

    const msgs = received.filter((m) => (m as { method?: string }).method === 'notifications/message');
    expect(msgs).toHaveLength(1); // 只剩 error 级
    expect((msgs[0] as { params?: { level?: string } }).params?.level).toBe('error');
    await server.close();
  });
});

// ─── Part 3: 源码契约(防回归:勿自行注册 setLevel 覆盖 SDK 内置) ─────────────

describe('K-1/K-2 源码契约', () => {
  const src = readFileSync('src/GodotServer.ts', 'utf8');

  it('K-1: push 回调有 bridge://events 订阅过滤(has 判断在 notification 之前)', () => {
    expect(src).toMatch(/resourceSubscriptions\.has\('bridge:\/\/events'\)/);
    const guardIdx = src.indexOf("resourceSubscriptions.has('bridge://events')");
    const notifyIdx = src.indexOf("method: 'notifications/resources/updated'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(guardIdx); // 过滤先于发送
  });

  it('K-2: 不自行注册 logging/setLevel handler(Map.set 会覆盖 SDK 内置 → 丢级别过滤)', () => {
    expect(src).not.toMatch(/setRequestHandler\(\s*['"]logging\/setLevel['"]/);
  });
});
