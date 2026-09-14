import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';

// ─── Mock MCP SDK (must be before GodotServer import) ────────────────────────
const mockSetRequestHandler = vi.fn();
const mockSetNotificationHandler = vi.fn();
const mockServerClose = vi.fn().mockResolvedValue(undefined);
const mockServerConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function (_, options) {
    this._instructions = options?.instructions;
    this.setRequestHandler = mockSetRequestHandler;
    this.setNotificationHandler = mockSetNotificationHandler;
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

// ─── Mock fs (避 detectProjectPath / FileStateStore 副作用) ──────────────────
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: mockExistsSync };
});

// ─── Mock editor-auth (返测试 secret，避真实文件/网络) ────────────────────────
const { mockWaitForEditorSecret } = vi.hoisted(() => ({
  mockWaitForEditorSecret: vi.fn().mockResolvedValue('test-secret'),
}));
vi.mock('../src/core/editor-auth.js', () => ({
  waitForEditorSecret: (...args) => mockWaitForEditorSecret(...args),
}));

// ─── Mock process-state (避真实进程管理;Task 3/设计 §7 I-4:importOriginal ────
//     部分覆盖——仅 stub 测试需要的函数,新导出(killAllRunSessions 等)透传真实模块) ──
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRunningProcess: vi.fn().mockReturnValue(null),
    setRunningProcess: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue([]),
    setOutputBuffer: vi.fn(),
    getProcessStartTime: vi.fn().mockReturnValue(0),
    setProcessStartTime: vi.fn(),
    getProjectDir: vi.fn().mockReturnValue(''),
    setProjectDir: vi.fn(),
    killProcess: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── 不 mock EditorConnection / EditorToolExecutor / HealthMonitor ───────────
// 真实接线是本集成测试的核心价值（现有 godot-server.test.js 用 mock 绕过真实重连）。
import { GodotServer } from '../src/GodotServer.js';

// ─── SUT ──────────────────────────────────────────────────────────────────────

// P0-1: EditorConnection 重连致命路径端到端零覆盖。
// editor-connection.test.js:305 已覆盖 EditorConnection 自身 reconnectExhausted（单元）；
// godot-server.test.js:198 用 mock EditorConnection 手动触发 handler（绕过真实重连）。
// 本文件补真实 ws 重连耗尽 / 半开心跳 → GodotServer.handleEditorStall → headless 降级接线。
describe('editor fallback end-to-end (P0-1)', () => {
  let wss;
  let port;
  let server;
  const envKeys = [
    'GODOT_EDITOR_PORT',
    'GODOT_MCP_EDITOR_RECONNECT_ATTEMPTS',
    'GODOT_MCP_EDITOR_RECONNECT_INTERVAL',
    'GODOT_MCP_EDITOR_RECONNECT_MAX_INTERVAL',
  ];
  const savedEnv = {};

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.GODOT_EDITOR_PORT = String(port);
    // 低重连参数（GodotServer.establishEditorConnection 从 env 读，默认 20×backoff 不可测）
    process.env.GODOT_MCP_EDITOR_RECONNECT_ATTEMPTS = '3';
    process.env.GODOT_MCP_EDITOR_RECONNECT_INTERVAL = '20';
    process.env.GODOT_MCP_EDITOR_RECONNECT_MAX_INTERVAL = '40';
    // existsSync=true 让 resolveProjectPath() 返回非 null，触发 waitForEditorSecret 流程
    // （对齐 godot-server.test.js:212；false 会导致 run() 跳过 secret 直接降级 headless）
    mockExistsSync.mockReturnValue(true);
    mockWaitForEditorSecret.mockResolvedValue('test-secret');
    mockSetRequestHandler.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    try { if (server) await server.close(); } catch { /* best-effort */ }
    server = undefined;
    try { if (wss) await new Promise((res) => { wss.close(() => res()); }); } catch { /* may already be closed */ }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // ── Path A: reconnectExhausted 端到端降级 ─────────────────────────────────
  it('degrades to headless after real reconnect exhaustion (path A)', { timeout: 30_000 }, async () => {
    // WSS 回应所有 message（含 auth + 重连尝试期间的 ping）—— 初始 connect 成功的关键
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // CMP-1: editor_get_project_path 需回当前项目根(与 resolveProjectPath 在 mockExistsSync=true 下返回 process.cwd() 一致)
        const result = msg.method === 'editor_get_project_path'
          ? { project_path: process.cwd() }
          : { status: 'ok' };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });

    server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
    await server.run();
    // 先例 godot-server.test.js:220 —— 连接成功后 connectionMode='editor'
    expect(server.connectionMode).toBe('editor');

    // 模拟编辑器崩溃:terminate 现有连接 + 关 server → 后续重连 ECONNREFUSED
    // (参照 editor-connection.test.js:337-338：不 terminate 则 client 以为连着不触发 close)
    for (const client of wss.clients) client.terminate();
    await new Promise((res) => wss.close(res));

    // 3 次重连尝试 × (backoff 20~40ms + ECONNREFUSED 即时)
    await new Promise((r) => setTimeout(r, 4000));

    // 降级断言（先例 godot-server.test.js:228-229）
    expect(server.connectionMode).toBe('headless');
    expect(server.editorMgr.conn).toBeNull();
  });

  // ── Path B: 半开心跳降级接线（onStateChange REQUEST_TIMEOUT → handleEditorStall）──
  // B-T5: ping 失败分流。REQUEST_TIMEOUT(TCP OPEN 但主线程卡死)→降级,自动重连救不了(ws 不 close,
  // scheduleReconnect 不触发)。NOT_CONNECTED/CONNECTION_LOST(下线)→不降级,让 EditorConnection
  // 自动重连兜底(见 Path C)。本测试覆盖 REQUEST_TIMEOUT 分支的真实降级接线。
  //
  // 注：真实半开 ping-timeout 端到端（ping 不响应 → 5s timeout × 5 → reconnecting）
  // 在 fakeTimers + 真实 ws 下不稳定（request 超时虽是 setTimeout 受控，但心跳 async 链
  // + 真实 I/O 事件不被 fake timer 推进），且生产心跳参数硬编码（heartbeatIntervalMs=15000 /
  // maxConsecutiveFailures=5 / pingTimeout=5000）不可 env 注入。降级为接线断言：
  // 直接驱动 health-monitor 进 'reconnecting' + 预置 _lastPingErrCode='REQUEST_TIMEOUT',
  // 触发 GodotServer.ts onStateChange 回调 REQUEST_TIMEOUT 分支 → handleEditorStall。
  it('degrades to headless when hm enters reconnecting via REQUEST_TIMEOUT (path B: half-open stall)', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // CMP-1: editor_get_project_path 需回当前项目根(与 resolveProjectPath 在 mockExistsSync=true 下返回 process.cwd() 一致)
        const result = msg.method === 'editor_get_project_path'
          ? { project_path: process.cwd() }
          : { status: 'ok' };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });

    server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
    await server.run();
    expect(server.connectionMode).toBe('editor');

    // establishEditorConnection 连接成功后 hm 复位为 'connected'（GodotServer.ts B6）
    const hm = server.dispatcher.getHealthMonitor();
    expect(hm.getState()).toBe('connected');

    // 模拟心跳检测到卡死：预置 err.code=REQUEST_TIMEOUT(TCP OPEN 主线程阻塞,ws 不 close)
    // + hm 进 'reconnecting' → onStateChange REQUEST_TIMEOUT 分支 → handleEditorStall
    server.editorMgr._lastPingErrCode = 'REQUEST_TIMEOUT';
    hm.setState('reconnecting');
    // onStateChange listener 同步触发 handleEditorStall；flush 兜底异步 listener
    await new Promise((r) => setTimeout(r, 50));

    expect(server.connectionMode).toBe('headless');
    expect(server.editorMgr.conn).toBeNull();
  });

  // ── Path C: 编辑器下线不抢占自动重连（B-T5 核心修复点）─────────────────────
  // CONNECTION_LOST/NOT_CONNECTED: 编辑器重启/瞬时不可达,ws.close 已触发 scheduleReconnect
  // (20 次退避)。旧实现无差别 handleEditorStall → disconnect() 杀自动重连(reconnectEnabled=false),
  // 用户须手动 reconnect。修复:onStateChange 分流,非 REQUEST_TIMEOUT 不降级,让自动重连兜底;
  // 重连成功 addOnReconnectHandler 触发 hm.reset();重连耗尽 reconnectExhausted 兜底降级(Path A)。
  it('does NOT degrade when hm enters reconnecting via CONNECTION_LOST (path C: editor offline, let auto-reconnect)', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // CMP-1: editor_get_project_path 需回当前项目根(与 resolveProjectPath 在 mockExistsSync=true 下返回 process.cwd() 一致)
        const result = msg.method === 'editor_get_project_path'
          ? { project_path: process.cwd() }
          : { status: 'ok' };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });

    server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
    await server.run();
    expect(server.connectionMode).toBe('editor');

    const hm = server.dispatcher.getHealthMonitor();
    expect(hm.getState()).toBe('connected');

    // 模拟编辑器下线:ws 已 close,ping 失败返 CONNECTION_LOST err.code;hm 进 reconnecting
    server.editorMgr._lastPingErrCode = 'CONNECTION_LOST';
    hm.setState('reconnecting');
    await new Promise((r) => setTimeout(r, 50));

    // 反向断言:不抢占自动重连——editorConn 保持非 null(reconnectEnabled 保持 true),
    // connectionMode 保持 'editor',等 EditorConnection scheduleReconnect 兜底恢复/耗尽降级
    expect(server.connectionMode).toBe('editor');
    expect(server.editorMgr.conn).not.toBeNull();
  });

  // ── Path D: 重连成功复位 hm（B-T5 状态机链关键节点）──────────────────────────
  // refused 后 hm 卡 reconnecting(下次 ping 要等 probeIntervalMs=60s 才纠正),
  // 期间 B-T3 半开 HOL 预检(_executeInner getState===reconnecting)拦所有 editor 工具。
  // 修复:addOnReconnectHandler 触发 hm.reset() 即刻复位 connected + 清 consecutiveHeartbeatFails。
  it('resets health-monitor to connected on editor reconnect (path D: state machine chain)', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // CMP-1: editor_get_project_path 需回当前项目根(与 resolveProjectPath 在 mockExistsSync=true 下返回 process.cwd() 一致)
        const result = msg.method === 'editor_get_project_path'
          ? { project_path: process.cwd() }
          : { status: 'ok' };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });

    server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
    await server.run();
    expect(server.connectionMode).toBe('editor');

    const hm = server.dispatcher.getHealthMonitor();
    // 模拟 refused 后卡 reconnecting
    server.editorMgr._lastPingErrCode = 'CONNECTION_LOST';
    hm.setState('reconnecting');
    expect(hm.getState()).toBe('reconnecting');

    // 模拟 EditorConnection 自动重连成功:触发 addOnReconnectHandler → hm.reset()
    // 通过 reconnectHandlers Set(JS test 可访问 TS private 字段)调用所有注册的 handler,
    // 包括本任务接线的 hm.reset() handler 和 EditorToolExecutor 的 _reconnectHandler。
    for (const h of server.editorMgr.conn.reconnectHandlers) {
      try { h(); } catch { /* best-effort,同生产 fireReconnect 容错 */ }
    }
    // 兜底 flush
    await new Promise((r) => setTimeout(r, 20));

    expect(hm.getState()).toBe('connected'); // 即刻复位,避免 60s 卡顿窗口
  });
});
