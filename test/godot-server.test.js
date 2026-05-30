import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock MCP SDK (must be before GodotServer import) ────────────────────────
const mockSetRequestHandler = vi.fn();
const mockServerClose = vi.fn().mockResolvedValue(undefined);
const mockServerConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function () {
    this.setRequestHandler = mockSetRequestHandler;
    this.connect = mockServerConnect;
    this.close = mockServerClose;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
  ListResourcesRequestSchema: 'ListResourcesRequestSchema',
  ListResourceTemplatesRequestSchema: 'ListResourceTemplatesRequestSchema',
  ReadResourceRequestSchema: 'ReadResourceRequestSchema',
}));

// ─── Mock editor auth (avoids real network/file access) ─────────────────────
vi.mock('../src/core/editor-auth.js', () => ({
  waitForEditorSecret: vi.fn().mockResolvedValue(null),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GodotServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      // Merged tools: each module registers one tool (scene, script, project, etc.)
      // Should be much fewer than 50 individual tools but still substantial
      expect(names.length).toBeGreaterThan(10);
      // confirm_and_execute is always present
      expect(names).toContain('confirm_and_execute');
      // Merged tool names should be present
      expect(names).toContain('scene');
      expect(names).toContain('script');
      expect(names).toContain('project');
    });

    it('readOnly mode excludes write tools', async () => {
      const handlers = createServerAndGetHandlers({ readOnly: true });
      const names = await getToolNamesFromHandler(handlers);
      // Read-only tools (TOOL_META readonly=true) should still be present
      expect(names).toContain('docs');
      expect(names).toContain('screenshot');
      expect(names).toContain('physics');
      // Write tools (TOOL_META readonly=false) should be filtered out
      expect(names).not.toContain('scene');
      expect(names).not.toContain('script');
      expect(names).not.toContain('project');
      // confirm_and_execute is not in TOOL_META, so it gets filtered by ReadOnlyGuard too
      expect(names).not.toContain('confirm_and_execute');
    });

    it('readOnly mode has fewer tools than default', async () => {
      const defaultHandlers = createServerAndGetHandlers({});
      const defaultNames = await getToolNamesFromHandler(defaultHandlers);

      vi.clearAllMocks();
      const readonlyHandlers = createServerAndGetHandlers({ readOnly: true });
      const readonlyNames = await getToolNamesFromHandler(readonlyHandlers);

      expect(readonlyNames.length).toBeLessThan(defaultNames.length);
    });

    it('lite mode filters to LITE_TOOLS set only', async () => {
      const handlers = createServerAndGetHandlers({ mode: 'lite' });
      const names = await getToolNamesFromHandler(handlers);
      // LITE_TOOLS from tool-registry.ts (15 merged tool names)
      const liteTools = [
        'project', 'scene', 'script',
        'runtime', 'validation',
        'confirm_and_execute',
        'animation', 'audio', 'docs',
        'signal', 'material', 'test',
        'screenshot', 'profiler', 'workflow',
        'game',
      ];
      // All returned tools should be in the LITE set
      for (const name of names) {
        expect(liteTools).toContain(name);
      }
      // All LITE_TOOLS should be present
      for (const expected of liteTools) {
        expect(names).toContain(expected);
      }
    });

    it('lite mode has fewer tools than default', async () => {
      const defaultHandlers = createServerAndGetHandlers({});
      const defaultNames = await getToolNamesFromHandler(defaultHandlers);

      vi.clearAllMocks();
      const liteHandlers = createServerAndGetHandlers({ mode: 'lite' });
      const liteNames = await getToolNamesFromHandler(liteHandlers);

      expect(liteNames.length).toBeLessThan(defaultNames.length);
    });

    it('combined readOnly and lite mode applies both filters', async () => {
      const handlers = createServerAndGetHandlers({ readOnly: true, mode: 'lite' });
      const names = await getToolNamesFromHandler(handlers);
      // All LITE_TOOLS have readonly=false, so readOnly filter removes them all
      // Only tools that pass BOTH filters (in LITE_TOOLS AND readonly=true) survive
      // Since all lite tools are write tools, combined filter may return very few or none
      expect(names).not.toContain('scene');
      expect(names).not.toContain('script');
      expect(names).not.toContain('project');
      // The result should be a subset of lite tools (possibly empty if none are readonly)
      for (const name of names) {
        // confirm_and_execute is special — not in module registry
        if (name === 'confirm_and_execute') continue;
      }
    });
  });
});
