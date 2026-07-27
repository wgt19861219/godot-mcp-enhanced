import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock MCP SDK (must be before GodotServer import) ────────────────────────
const mockSetRequestHandler = vi.fn();
const mockSetNotificationHandler = vi.fn();
const mockServerClose = vi.fn().mockResolvedValue(undefined);
const mockServerConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function (_, options) {
    this._instructions = options?.instructions;
    this.setRequestHandler = mockSetRequestHandler;
    this.setNotificationHandler = mockSetNotificationHandler;
    this.connect = mockServerConnect;
    this.close = mockServerClose;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
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
vi.mock('../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
  killProcess: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import SUT (after mocks) ────────────────────────────────────────────────
import { GodotServer, clearGodotPathCache, getCachedGodotPath } from '../src/GodotServer.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  });

  // ── Editor reconnect fallback (I-04) ───────────────────────────────────────

  describe('editor reconnect exhaustion fallback', () => {
    it('degrades to headless when reconnect exhaustion handler fires', async () => {
      const exhaustedHandlers = [];
      const mockEditorConn = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        addOnReconnectExhaustedHandler: vi.fn((handler) => {
          exhaustedHandlers.push(handler);
        }),
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
      expect(server.editorConn).toBeNull();

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
        addOnReconnectExhaustedHandler: vi.fn(),
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
      const listToolsHandler = handlers.get('ListToolsRequestSchema');
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
        'game',
        'animation', 'animtree',
        'audio',
        'signal',
        'material', 'screenshot', 'particles',
        'docs', 'load_skill', 'cpp',
        'profiler', 'workflow',
        'test_runner',  // v0.25.0: test 组重新启用
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

    // v0.25.0: lean profile — 比 lite 更激进，砍 visual/profiler/test
    it('lean mode filters to LEAN_TOOLS set only (v0.25.0)', async () => {
      const handlers = createServerAndGetHandlers({ mode: 'lean' });
      const names = await getToolNamesFromHandler(handlers);
      const leanTools = [
        'project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute', 'godot_get_context',
        'game',
        'animation', 'animtree',
        'audio',
        'signal',
        'docs', 'load_skill', 'cpp',
      ];
      for (const name of names) {
        expect(leanTools).toContain(name);
      }
      for (const expected of leanTools) {
        expect(names).toContain(expected);
      }
    });

    it('lean mode has fewer tools than lite (v0.25.0)', async () => {
      vi.clearAllMocks();
      vi.mocked(StdioServerTransport).mockImplementation(function() { return {}; });
      const liteHandlers = createServerAndGetHandlers({ mode: 'lite' });
      const liteNames = await getToolNamesFromHandler(liteHandlers);

      vi.clearAllMocks();
      vi.mocked(StdioServerTransport).mockImplementation(function() { return {}; });
      const leanHandlers = createServerAndGetHandlers({ mode: 'lean' });
      const leanNames = await getToolNamesFromHandler(leanHandlers);

      expect(leanNames.length).toBeLessThan(liteNames.length);
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
});
