import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  setToolCallDelegate,
  setDynamicSender,
} from '../../src/tools/advanced-proxy.js';
import {
  setActiveGroups,
  getActiveGroups,
  registerTools,
  TOOL_GROUPS,
} from '../../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const mockCtx = {} as ToolContext;

describe('advanced-proxy', () => {
  let savedGroups: ReadonlySet<string>;

  beforeEach(() => {
    setToolCallDelegate(null);
    setDynamicSender(null);
    // Save current active groups
    savedGroups = getActiveGroups();
  });

  afterEach(() => {
    // Restore active groups
    setActiveGroups(new Set(savedGroups));
  });

  describe('getToolDefinitions', () => {
    it('returns godot_advanced_tool and godot_list_dynamic_routes definitions', () => {
      const defs = getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.name)).toContain('godot_advanced_tool');
      expect(defs.map(d => d.name)).toContain('godot_list_dynamic_routes');
    });

    it('godot_advanced_tool has tool_name and arguments in inputSchema', () => {
      const defs = getToolDefinitions();
      const proxy = defs.find(d => d.name === 'godot_advanced_tool')!;
      const schema = proxy.inputSchema as any;
      expect(schema.properties.tool_name).toBeDefined();
      expect(schema.properties.arguments).toBeDefined();
      expect(schema.required).toContain('tool_name');
    });

    it('godot_list_dynamic_routes has category in inputSchema', () => {
      const defs = getToolDefinitions();
      const listRoutes = defs.find(d => d.name === 'godot_list_dynamic_routes')!;
      const schema = listRoutes.inputSchema as any;
      expect(schema.properties.category).toBeDefined();
    });

    it('has no inline annotations (tags injected by module-loader)', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.annotations).toBeUndefined();
      }
    });

    it('godot_advanced_tool description mentions proxy functionality', () => {
      const defs = getToolDefinitions();
      const proxy = defs.find(d => d.name === 'godot_advanced_tool')!;
      expect(proxy.description).toContain('代理');
    });
  });

  describe('handleTool — routing', () => {
    it('returns null for unknown tool name', async () => {
      const result = await handleTool('unknown', {}, mockCtx);
      expect(result).toBeNull();
    });

    it('returns error when tool_name is missing', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('MISSING_TOOL_NAME');
    });

    it('returns error when target tool is already directly available', async () => {
      setToolCallDelegate(vi.fn());

      // manage_tools is in ALWAYS_ALLOWED, so it's always "directly available"
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'manage_tools',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });

    it('returns fuzzy suggestions for invalid tool_name without godot_ prefix', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animaton',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.error_code).toBe('UNKNOWN_TOOL');
      expect(parsed.suggestions).toBeDefined();
      expect(Array.isArray(parsed.suggestions)).toBe(true);
      // A-01: must NOT leak full tool list
      expect(parsed.available_tools).toBeUndefined();
    });

    it('returns error when tool_name is not a string', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 123,
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('MISSING_TOOL_NAME');
    });
  });

  describe('delegate path (deactivated tools)', () => {
    // Use setActiveGroups to deactivate animation group, triggering delegate path.
    // This tests the real production code path without mocking.

    beforeEach(() => {
      // Only activate core group — animation group is deactivated
      setActiveGroups(new Set(['core']));
      // Register animation as a known tool (module not loaded in test env)
      registerTools([{ name: 'animation', readonly: false, long_running: false }]);
    });

    it('delegates call when tool is deactivated', async () => {
      const mockDelegate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"success":true,"data":{}}' }],
      });
      setToolCallDelegate(mockDelegate);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: { action: 'list_players' },
      }, mockCtx);

      expect(mockDelegate).toHaveBeenCalledWith('animation', { action: 'list_players' });
      const text = (result?.content?.[0] as any)?.text;
      expect(text).toContain('success');
    });

    it('returns NO_DELEGATE when delegate is null and tool is deactivated', async () => {
      setToolCallDelegate(null);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('NO_DELEGATE');
    });

    it('returns PROXY_ERROR when delegate throws', async () => {
      setToolCallDelegate(async () => {
        throw new Error('Target tool crashed');
      });

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('PROXY_ERROR');
      expect(parsed.error).toContain('crashed');
    });

    it('still rejects directly available tools even in slim mode', async () => {
      setToolCallDelegate(vi.fn());

      // project is in core group, always available
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'project',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });
  });

  describe('dynamic routing fallback', () => {
    beforeEach(() => {
      // Activate dynamic group + core
      setActiveGroups(new Set(['core', 'dynamic']));
    });

    it('returns NO_DYNAMIC_SENDER when no sender configured', async () => {
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_custom_light_bake',
        arguments: { intensity: 1.0 },
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('NO_DYNAMIC_SENDER');
    });

    it('calls dynamic sender and returns result', async () => {
      const mockSender = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"success":true,"data":"baked"}' }],
      });
      setDynamicSender(mockSender);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_custom_light_bake',
        arguments: { intensity: 1.0 },
      }, mockCtx);

      expect(mockSender).toHaveBeenCalledWith('custom/light-bake', { intensity: 1.0 });
      const text = (result?.content?.[0] as any)?.text;
      expect(text).toContain('baked');
    });

    it('calls dynamic sender with empty args when no arguments provided', async () => {
      const mockSender = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"success":true}' }],
      });
      setDynamicSender(mockSender);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_terrain_sculpt',
      }, mockCtx);

      expect(mockSender).toHaveBeenCalledWith('terrain/sculpt', {});
    });

    it('returns DYNAMIC_ROUTE_ERROR when sender throws', async () => {
      setDynamicSender(async () => { throw new Error('Connection refused'); });

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_custom_light_bake',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('DYNAMIC_ROUTE_ERROR');
    });

    it('rejects dynamic tool when dynamic group is inactive', async () => {
      // Deactivate dynamic group
      setActiveGroups(new Set(['core']));

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_custom_light_bake',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('DYNAMIC_GROUP_INACTIVE');
    });

    it('rejects godot_ tool name that cannot derive a valid route', async () => {
      // godot_ by itself only has one segment after prefix → route derivation returns null
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('INVALID_DYNAMIC_TOOL_NAME');
    });

    it('rejects non-godot_ unknown tool with fuzzy suggestions', async () => {
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animaton',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.error_code).toBe('UNKNOWN_TOOL');
      expect(parsed.suggestions).toBeDefined();
      // Must not return dynamic result
      expect(parsed.dynamic).toBeUndefined();
    });

    it('godot_ tool not in registry but godot_advanced_tool itself is rejected as already available', async () => {
      // godot_advanced_tool is in ALWAYS_ALLOWED, so it's "directly available"
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'godot_advanced_tool',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });

    // P1-3 (2026-07-06 RCE 审查): 动态路由不重入 ReadOnlyGuard,只读模式下必须显式拦截
    it('rejects dynamic routing in read-only mode even with sender configured (P1-3)', async () => {
      const prevRO = process.env.GODOT_MCP_READ_ONLY;
      process.env.GODOT_MCP_READ_ONLY = 'true';
      try {
        const mockSender = vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"success":true}' }],
        });
        setDynamicSender(mockSender);

        const result = await handleTool('godot_advanced_tool', {
          tool_name: 'godot_custom_light_bake',
          arguments: { intensity: 1.0 },
        }, mockCtx);

        const text = (result?.content?.[0] as any)?.text;
        const parsed = JSON.parse(text);
        expect(parsed.success).toBe(false);
        expect(parsed.error_code).toBe('READ_ONLY');
        expect(mockSender).not.toHaveBeenCalled();  // sender 未被调用(拦截在前)
      } finally {
        if (prevRO === undefined) delete process.env.GODOT_MCP_READ_ONLY;
        else process.env.GODOT_MCP_READ_ONLY = prevRO;
      }
    });
  });

  describe('godot_list_dynamic_routes', () => {
    it('returns registered tools and dynamic routing status', async () => {
      setActiveGroups(new Set(['core', 'dynamic']));

      const result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
      expect(parsed.total_registered).toBeGreaterThanOrEqual(0);
      expect(parsed.dynamic_routing_enabled).toBe(true);
      expect(parsed.hint).toBeDefined();
    });

    it('shows dynamic_routing_enabled=false when dynamic group inactive', async () => {
      setActiveGroups(new Set(['core']));

      const result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
      expect(parsed.dynamic_routing_enabled).toBe(false);
    });

    it('filters by category when provided', async () => {
      // 注册测试工具到 metaRegistry,提供明确的 category
      registerTools([
        { name: 'godot_testcat_action', readonly: false, long_running: false },
      ]);

      // 三级 discovery(Level 2b):category 返回 lean 视图 {category, count, tools}
      // godot_testcat_action → category = 'testcat'
      const result = await handleTool('godot_list_dynamic_routes', {
        category: 'testcat',
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      // lean 视图结构:{category, count, tools:[{name, brief, params?}]}
      expect(parsed.category).toBe('testcat');
      expect(typeof parsed.count).toBe('number');
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(parsed.tools)).toBe(true);
      // 该类所有工具名都含 'testcat'
      for (const tool of parsed.tools) {
        expect(tool.name).toContain('testcat');
      }
    });

    it('returns null for non-matching tool name', async () => {
      const result = await handleTool('some_other_tool', {}, mockCtx);
      expect(result).toBeNull();
    });
  });
});
