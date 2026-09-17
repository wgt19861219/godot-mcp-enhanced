import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock MCP SDK (must be before GodotServer import) ────────────────────────
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

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
  StdioServerTransport: vi.fn().mockImplementation(function() { return {}; }),
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

// ─── Mock fs to control detectProjectPath behavior ───────────────────────────
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: mockExistsSync };
});

// ─── Mock editor auth (avoids real network/file access) ─────────────────────
const { mockWaitForEditorSecret } = vi.hoisted(() => ({
  mockWaitForEditorSecret: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/core/editor-auth.js', () => ({
  waitForEditorSecret: (...args) => mockWaitForEditorSecret(...args),
}));

// ─── Mock EditorConnection and EditorToolExecutor ───────────────────────────
vi.mock('../src/core/EditorConnection.js', () => ({
  EditorConnection: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('no editor')),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../src/core/EditorToolExecutor.js', () => ({
  EditorToolExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

// ─── Mock process-state to avoid real process management ────────────────────
// Task 3(设计 §7 I-4):vi.mock(importOriginal) 部分覆盖——仅 stub 测试真正需要的
// 函数,其余导出(含 Task 2 新增 killAllRunSessions/getActiveRunPids 等)透传真实模块,
// 根治"新增导出缺透传 → close() 时 TypeError"的补导出漂移。
vi.mock('../src/core/process-state.js', async (importOriginal) => {
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
    // B-T4: close() 清理 in-flight gdscript spawn（默认空集，无 orphan）
    getSpawnedGodotPids: vi.fn().mockReturnValue([]),
    killPidTree: vi.fn(),
    unregisterSpawnedGodotPid: vi.fn(),
    // 报告②P0/P1：周期 orphan 扫描 + 启动清理调用此函数
    killOrphanGodotProcesses: vi.fn().mockResolvedValue(0),
    // Task 3: close() 逐进程清理段换 killAllRunSessions(下述 G-2 用例断言其被调)
    killAllRunSessions: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Import SUT (after mocks) ────────────────────────────────────────────────
import { GodotServer, clearGodotPathCache, getCachedGodotPath } from '../src/GodotServer.js';
import { handleTool as instanceHandleTool, setInstanceManager, setInstanceRouter } from '../src/tools/instance-tools.js';
import * as bridgeMod from '../src/tools/game-bridge.js';
import { dynamicSchema } from '../src/core/dynamic-schema.js';
import { killAllRunSessions } from '../src/core/process-state.js';
import * as dapMod from '../src/tools/dap.js';
import * as bridgeClientMod from '../src/core/bridge-client.js';
import { _resetProjectPathCache } from '../src/core/path-utils.js';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { EditorToolExecutor } from '../src/core/EditorToolExecutor.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GodotServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore constructor mocks that clearAllMocks wipes out
    vi.mocked(StdioServerTransport).mockImplementation(function() { return {}; });
    // Default: existsSync returns false
    mockExistsSync.mockReturnValue(false);
    // Default: waitForEditorSecret returns null (no editor)
    mockWaitForEditorSecret.mockResolvedValue(null);
    // Default: EditorConnection fails to connect
    vi.mocked(EditorConnection).mockImplementation(function() {
      return {
        connect: vi.fn().mockRejectedValue(new Error('no editor')),
        disconnect: vi.fn(),
      };
    });
    // Default: EditorToolExecutor creates a simple mock (must use function for `new`)
    vi.mocked(EditorToolExecutor).mockImplementation(function() {
      return { execute: vi.fn(), destroy: vi.fn() };
    });
  });

  afterEach(() => {
    delete process.env.GODOT_PROJECT_PATH;
  });

  // ── Re-exports ────────────────────────────────────────────────────────────

  describe('re-exports', () => {
    it('clearGodotPathCache is a function', () => {
      expect(typeof clearGodotPathCache).toBe('function');
    });

    it('getCachedGodotPath is a function', () => {
      expect(typeof getCachedGodotPath).toBe('function');
    });

    it('clearGodotPathCache clears the cached path', () => {
      clearGodotPathCache();
      expect(getCachedGodotPath()).toBeNull();
    });
  });

  // ── Constructor ───────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates instance without error with default options', () => {
      const server = new GodotServer('/fake/ops.gd');
      expect(server).toBeTruthy();
      expect(server).toBeInstanceOf(GodotServer);
    });

    it('creates instance with readOnly option', () => {
      const server = new GodotServer('/fake/ops.gd', { readOnly: true });
      expect(server).toBeTruthy();
    });

    it('creates instance with lite mode', () => {
      const server = new GodotServer('/fake/ops.gd', { mode: 'lite' });
      expect(server).toBeTruthy();
    });

    it('creates instance with editor connection mode', () => {
      const server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
      expect(server).toBeTruthy();
    });

    it('creates instance with noFallback option', () => {
      const server = new GodotServer('/fake/ops.gd', { noFallback: true });
      expect(server).toBeTruthy();
    });

    it('registers request handlers during construction', () => {
      new GodotServer('/fake/ops.gd');
      expect(mockSetRequestHandler.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it('injects instructions into the MCP Server on construction', () => {
      const server = new GodotServer('/fake/ops.gd');
      // SDK private 字段 _instructions：GodotServer 构造时经 readInstructions() 注入
      // 升级 @modelcontextprotocol/sdk 时需复查此断言（字段改名/改可见性会假阳性失败）
      expect(server.server._instructions).toBeTruthy();
      expect(typeof server.server._instructions).toBe('string');
      expect(server.server._instructions).toMatch(/headless/);
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('resolves without error when no process is running', async () => {
      const server = new GodotServer('/fake/ops.gd');
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('calls server.close() on the MCP server', async () => {
      const server = new GodotServer('/fake/ops.gd');
      await server.close();
      expect(mockServerClose).toHaveBeenCalled();
    });

    it('can be called multiple times without error', async () => {
      const server = new GodotServer('/fake/ops.gd');
      await server.close();
      await server.close();
      expect(mockServerClose).toHaveBeenCalled();
    });

    // P0-2 架构修复: close() 须清理 tools 侧模块级引用,防测试隔离泄漏/热重启残留。
    // 以 instance-tools 为代表(setInstanceManager/setInstanceRouter 在 run() 注入,close 应清空);
    // setDynamicSender/setToolCallDelegate/setBridgeProjectDir 在同一 finally 块,结构对称,由本机制保证。
    it('clears tools-side module-level refs (instance manager/router) on close', async () => {
      // 注入 stub(模拟 run() initMultiInstance 的注入效果)
      setInstanceManager({ loadFromRegistry: async () => [], getAllInstances: () => [], getStatus: () => 'online' });
      setInstanceRouter({ getSelectedId: () => null });
      // 注入生效: godot_list_instances 不返 NOT_INITIALIZED
      const before = await instanceHandleTool('godot_list_instances', {}, {});
      expect(before.content[0].text).not.toContain('NOT_INITIALIZED');
      // close 触发 finally 清理
      const server = new GodotServer('/fake/ops.gd');
      await server.close();
      // 清理生效: godot_list_instances 返 NOT_INITIALIZED(证明 _manager 已清空)
      const after = await instanceHandleTool('godot_list_instances', {}, {});
      expect(after.content[0].text).toContain('NOT_INITIALIZED');
      // 清理测试残留防泄漏
      setInstanceManager(null);
      setInstanceRouter(null);
    });

    // ── G-2 (2026-08-14 审查 :65 + :942③): close() 清理链补漏 + 逐项容错 ──────────
    // 根因: close 只调 setBridgeProjectDir(null),漏 registerBridgePushHandler(null)(:269 注册的
    // push handler 闭包持已 close 旧 server)与 dynamicSchema.setFetcher(null)(模块级注入点);
    // 且 editorMgr.close()/stateStore.flush 等无逐项 try——单点抛错则后续 killProcess/server.close
    // 全跳过(孤儿 Godot / server 半关)。
    describe('G-2: close() 清理链补漏 + 逐项容错', () => {
      it('close() 注销 bridge push handler 与 dynamicSchema fetcher(两注入点均 null)', async () => {
        const registerSpy = vi.spyOn(bridgeMod, 'registerBridgePushHandler');
        const fetcherSpy = vi.spyOn(dynamicSchema, 'setFetcher');
        try {
          const server = new GodotServer('/fake/ops.gd');  // 构造时注册 push handler + fetcher
          await server.close();
          // close 后两注入点最后一次调用必须是 null(闭包不持已 close 的旧 server)
          const lastRegister = registerSpy.mock.calls[registerSpy.mock.calls.length - 1];
          expect(lastRegister[0]).toBeNull();
          const lastFetcher = fetcherSpy.mock.calls[fetcherSpy.mock.calls.length - 1];
          expect(lastFetcher[0]).toBeNull();
        } finally {
          registerSpy.mockRestore();
          fetcherSpy.mockRestore();
        }
      });

      it('editorMgr.close() 抛错 → 后续 killAllRunSessions 仍执行(单点错不阻断清理链)', async () => {
        const server = new GodotServer('/fake/ops.gd');
        server.editorMgr = { close: () => { throw new Error('editor close boom'); }, getProjectPath: () => null };
        await expect(server.close()).resolves.toBeUndefined();  // 整体不抛
        // Task 3: close 逐进程清理段换 killAllRunSessions(杀全部桶活进程,孤儿 Godot 兜底)
        expect(killAllRunSessions).toHaveBeenCalled();  // 早抛的 editorMgr 不阻断孤儿清理
        expect(mockServerClose).toHaveBeenCalled();  // server.close 仍执行
      });

      it('stateStore.flush 抛错 → 后续 agentCtx/server.close 仍执行', async () => {
        const server = new GodotServer('/fake/ops.gd');
        const store = {
          flush: vi.fn().mockRejectedValue(new Error('flush boom')),
          destroy: vi.fn(),
        };
        server.stateStore = store;
        await expect(server.close()).resolves.toBeUndefined();
        expect(store.destroy).toHaveBeenCalled();  // flush 抛错不阻断同段 destroy
        expect(mockServerClose).toHaveBeenCalled();
      });
    });

    // ── 架构审查批 2 Task 2.1 (H-4): dap 会话纳入 close() 清理链 ──────────────────
    it('close() 调 closeAllDapSessions(销毁全部 DAP TCP socket + 清簿记)', async () => {
      const spy = vi.spyOn(dapMod, 'closeAllDapSessions');
      try {
        const server = new GodotServer('/fake/ops.gd');
        await server.close();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    // ── 架构审查批 2 Task 2.2 (H-3/O2): setOnBridgeConnected 装配归位控制面 ──────────
    it('run() 装配 setOnBridgeConnected(非 null),close() 对称置 null', async () => {
      const spy = vi.spyOn(bridgeClientMod, 'setOnBridgeConnected');
      process.env.GODOT_MCP_WEB_GUI = '0';  // 跳过 Web GUI 启动(与本断言无关,减噪)
      try {
        const server = new GodotServer('/fake/ops.gd');
        await server.run();
        const registered = spy.mock.calls.filter((c) => typeof c[0] === 'function');
        expect(registered.length, 'run() 须装配非 null 的 bridge 首连回调').toBeGreaterThanOrEqual(1);
        await server.close();
        const last = spy.mock.calls[spy.mock.calls.length - 1];
        expect(last[0], 'close() 最后一次须置 null(装配-清理对称)').toBeNull();
      } finally {
        spy.mockRestore();
        delete process.env.GODOT_MCP_WEB_GUI;
        // 测试卫生:run() 触发 resolveProjectPath 写模块级 TTL 缓存(本测试 existsSync
        // mock=false 缓存 "undefined"),不重置会污染后续依赖 projectPath 的 editor 测试
        _resetProjectPathCache();
      }
    });

    // ── 架构审查批 2 Task 2.3 (M-9): profiler 直关 ──────────────────────────────
    it('close() 直关 functionProfiler(M-9:killProcess 5s 超时兜底不等 proc close 事件)', async () => {
      const server = new GodotServer('/fake/ops.gd');
      const ctx = server.dispatcher.getContext();
      const profilerClose = vi.fn();
      ctx.functionProfiler = { close: profilerClose };
      await server.close();
      expect(profilerClose).toHaveBeenCalledTimes(1);
      expect(ctx.functionProfiler).toBeUndefined();  // 引用同步清(runtime.ts stop 同款)
    });

    // ── 架构审查批 2 Task 2.3 (M-10): inflight 双清 ─────────────────────────────
    it('close() 末步 clearInflightFinal 清掉首清后窗口内并发 markInflight 重建的文件(M-10)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-inflight-close-'));
      process.env.GODOT_MCP_INFLIGHT_DIR = dir;  // env 注入隔离目录(inflight.ts 官方测试通道)
      const file = join(dir, `inflight-${process.pid}.json`);
      // 本文件 vi.mock('fs') 只覆写 existsSync,statSync 等透传真实 → 文件存在性断言用 statSync
      const fileExists = () => { try { statSync(file); return true; } catch { return false; } };
      const inflightMod = await import('../src/core/inflight.js');
      const orig = inflightMod.clearAllInflight;
      let calls = 0;
      let existedAfterFirstMark = false;
      const spy = vi.spyOn(inflightMod, 'clearAllInflight').mockImplementation(() => {
        calls += 1;
        orig();  // 真删(保持 GodotServer.close 首步语义不变)
        if (calls === 1) {
          // 模拟首清后、close 尾前的并发工具调用(M-10 竞态窗口):markInflight 重建文件
          inflightMod.markInflight('fake-concurrent-tool');
          existedAfterFirstMark = fileExists();
        }
      });
      try {
        const server = new GodotServer('/fake/ops.gd');
        await server.close();
        expect(calls, '首步 clearInflight + 末步 clearInflightFinal 双清').toBe(2);
        expect(existedAfterFirstMark, '竞态场景成立前提:窗口内文件确被 markInflight 重建').toBe(true);
        expect(fileExists(), '末步须清掉窗口内重建的 inflight 文件').toBe(false);
      } finally {
        spy.mockRestore();
        delete process.env.GODOT_MCP_INFLIGHT_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Editor reconnect fallback (I-04) ───────────────────────────────────────

  describe('editor reconnect exhaustion fallback', () => {
    it('degrades to headless when reconnect exhaustion handler fires', async () => {
      const exhaustedHandlers = [];
      const mockEditorConn = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        addOnReconnectHandler: vi.fn(),
        addOnReconnectExhaustedHandler: vi.fn((handler) => {
          exhaustedHandlers.push(handler);
        }),
        // CMP-1: editor_get_project_path 回当前项目根(mockExistsSync=true 时 resolveProjectPath 返回 process.cwd())
        request: vi.fn().mockResolvedValue({ project_path: process.cwd() }),
      };

      vi.mocked(EditorConnection).mockImplementation(function() { return mockEditorConn; });
      mockWaitForEditorSecret.mockResolvedValue('test-secret');
      mockExistsSync.mockReturnValue(true);

      const server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
      await server.run();

      // Verify: editor connected, exhaustion handler registered
      expect(mockEditorConn.connect).toHaveBeenCalled();
      expect(mockEditorConn.addOnReconnectExhaustedHandler).toHaveBeenCalled();
      expect(server.connectionMode).toBe('editor');

      // Simulate reconnect exhaustion
      for (const handler of exhaustedHandlers) {
        handler();
      }

      // Verify: degraded to headless
      expect(server.connectionMode).toBe('headless');
      expect(server.editorMgr.conn).toBeNull();

      await server.close();
    });

    it('does NOT degrade on normal disconnect (only on reconnect exhaustion)', async () => {
      const disconnectHandlers = [];
      const mockEditorConn = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
        addOnDisconnectHandler: vi.fn((handler) => {
          disconnectHandlers.push(handler);
        }),
        addOnReconnectHandler: vi.fn(),
        addOnReconnectExhaustedHandler: vi.fn(),
        // CMP-1: editor_get_project_path 回当前项目根(mockExistsSync=true 时 resolveProjectPath 返回 process.cwd())
        request: vi.fn().mockResolvedValue({ project_path: process.cwd() }),
      };

      vi.mocked(EditorConnection).mockImplementation(function() { return mockEditorConn; });
      mockWaitForEditorSecret.mockResolvedValue('test-secret');
      mockExistsSync.mockReturnValue(true);

      const server = new GodotServer('/fake/ops.gd', { connectionMode: 'editor' });
      await server.run();

      // Fire disconnect handler (e.g., ws.on('close') between reconnect attempts)
      for (const handler of disconnectHandlers) {
        handler();
      }

      // Should NOT have degraded — only reconnect exhaustion triggers degradation
      expect(server.connectionMode).toBe('editor');

      await server.close();
    });
  });

  // ── Tool filtering ────────────────────────────────────────────────────────

  describe('tool filtering', () => {
    // Helper: create a server and return all captured handlers
    function createServerAndGetHandlers(options) {
      const handlers = new Map();
      mockSetRequestHandler.mockImplementation((schema, handler) => {
        handlers.set(schema, handler);
      });
      new GodotServer('/fake/ops.gd', options);
      return handlers;
    }

    // Helper: get tool names from the ListTools handler
    async function getToolNamesFromHandler(handlers) {
      const listToolsHandler = handlers.get('tools/list');
      expect(listToolsHandler).toBeTruthy();
      const result = await listToolsHandler();
      return result.tools.map(t => t.name);
    }

    it('default mode registers a large set of merged tools', async () => {
      const handlers = createServerAndGetHandlers({});
      const names = await getToolNamesFromHandler(handlers);
      expect(names.length).toBeGreaterThan(10);
      expect(names).toContain('confirm_and_execute');
      expect(names).toContain('scene');
      expect(names).toContain('script');
      expect(names).toContain('project');
    });

    it('readOnly mode excludes write tools', async () => {
      const handlers = createServerAndGetHandlers({ readOnly: true });
      const names = await getToolNamesFromHandler(handlers);
      expect(names).toContain('docs');
      expect(names).toContain('screenshot');
      expect(names).toContain('physics');
      expect(names).not.toContain('scene');
      expect(names).not.toContain('script');
      expect(names).not.toContain('project');
      expect(names).toContain('confirm_and_execute');
    });

    it('readOnly mode has fewer tools than default', async () => {
      const defaultHandlers = createServerAndGetHandlers({});
      const defaultNames = await getToolNamesFromHandler(defaultHandlers);

      vi.clearAllMocks();
      vi.mocked(StdioServerTransport).mockImplementation(function() { return {}; });
      const readonlyHandlers = createServerAndGetHandlers({ readOnly: true });
      const readonlyNames = await getToolNamesFromHandler(readonlyHandlers);

      expect(readonlyNames.length).toBeLessThan(defaultNames.length);
    });

    it('lite mode filters to LITE_TOOLS set only', async () => {
      const handlers = createServerAndGetHandlers({ mode: 'lite' });
      const names = await getToolNamesFromHandler(handlers);
      const liteTools = [
        'project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute', 'godot_get_context',
        'runtime_assert', 'help',
        'audit', // C-1 (2026-08-14): audit 归入 core 组,lite(含 core)随之可见
        'game',
        'qa', // v0.30: qa 归入 bridge 组,lite/basic(含 bridge)随之可见(run 是 process 风险,经 confirm 门)
        'animation', 'animtree', 'animation_track',
        'audio',
        'signal',
        'material', 'screenshot', 'particles',
        'docs', 'load_skill', 'cpp',
        'analysis', // v0.30: analysis 归 code 组,lite/basic(含 code)随之可见(纯静态只读)
        'profiler', 'workflow',
      ];
      for (const name of names) {
        expect(liteTools).toContain(name);
      }
      for (const expected of liteTools) {
        expect(names).toContain(expected);
      }
    });

    it('lite mode has fewer tools than default', async () => {
      const defaultHandlers = createServerAndGetHandlers({});
      const defaultNames = await getToolNamesFromHandler(defaultHandlers);

      vi.clearAllMocks();
      vi.mocked(StdioServerTransport).mockImplementation(function() { return {}; });
      const liteHandlers = createServerAndGetHandlers({ mode: 'lite' });
      const liteNames = await getToolNamesFromHandler(liteHandlers);

      expect(liteNames.length).toBeLessThan(defaultNames.length);
    });

    it('combined readOnly and lite mode applies both filters', async () => {
      const handlers = createServerAndGetHandlers({ readOnly: true, mode: 'lite' });
      const names = await getToolNamesFromHandler(handlers);
      expect(names).not.toContain('scene');
      expect(names).not.toContain('script');
      expect(names).not.toContain('project');
      for (const name of names) {
        if (name === 'confirm_and_execute') continue;
      }
    });
  });

  // ── 报告② P0/P1：进程生命周期（放在末尾，fake timers 不污染前置测试）─────────
  describe('process lifecycle (报告② P0/P1)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('P0: run() 挂载 60s 周期 orphan 扫描定时器', async () => {
      vi.useFakeTimers();
      const { killOrphanGodotProcesses } = await import('../src/core/process-state.js');
      const server = new GodotServer('/fake/ops.gd');
      await server.run();
      expect(killOrphanGodotProcesses).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(killOrphanGodotProcesses).toHaveBeenCalled();
      await server.close();
    });

    it('P0: close() 清理 orphan 扫描定时器（不再触发）', async () => {
      vi.useFakeTimers();
      const { killOrphanGodotProcesses } = await import('../src/core/process-state.js');
      const server = new GodotServer('/fake/ops.gd');
      await server.run();
      await server.close();
      vi.mocked(killOrphanGodotProcesses).mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(killOrphanGodotProcesses).not.toHaveBeenCalled();
    });

    it('P1: STARTUP_CLEANUP 默认关（run() 不触发启动清理）', async () => {
      const { killOrphanGodotProcesses } = await import('../src/core/process-state.js');
      vi.mocked(killOrphanGodotProcesses).mockClear();
      const server = new GodotServer('/fake/ops.gd');
      await server.run();
      expect(killOrphanGodotProcesses).not.toHaveBeenCalled();
      await server.close();
    });
  });
});
