import { expect, vi, beforeEach, afterEach } from 'vitest';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/game-bridge.js';

// ─── Tool definition tests ──────────────────────────────────────────────────

describe('game-bridge tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 6 tools', () => {
    expect(tools.length).toBe(6);
  });

  it('includes game_bridge_install', () => {
    expect(names.includes('game_bridge_install')).toBeTruthy();
  });

  it('includes game_bridge_uninstall', () => {
    expect(names.includes('game_bridge_uninstall')).toBeTruthy();
  });

  it('includes game_query', () => {
    expect(names.includes('game_query')).toBeTruthy();
  });

  it('includes game_write', () => {
    expect(names.includes('game_write')).toBeTruthy();
  });

  it('includes game_input', () => {
    expect(names.includes('game_input')).toBeTruthy();
  });

  it('includes game_wait', () => {
    expect(names.includes('game_wait')).toBeTruthy();
  });

  it('all tools have required inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.properties).toBeTruthy();
    }
  });
});

// ─── TOOL_META tests ────────────────────────────────────────────────────────

describe('game-bridge TOOL_META', () => {
  it('game_query is readonly', () => {
    expect(TOOL_META.game_query.readonly).toBe(true);
  });

  it('game_write is not readonly', () => {
    expect(TOOL_META.game_write.readonly).toBe(false);
  });

  it('game_input is not readonly', () => {
    expect(TOOL_META.game_input.readonly).toBe(false);
  });

  it('game_wait is readonly', () => {
    expect(TOOL_META.game_wait.readonly).toBe(true);
  });
});

// ─── handleTool routing tests ────────────────────────────────────────────────

describe('game-bridge handleTool routing', () => {
  const mockCtx = { projectDir: '/tmp/test-project', opsScript: '/tmp/ops.gd' };

  it('returns null for unknown tool names', async () => {
    const result = await handleTool('unknown_tool', {}, mockCtx);
    expect(result).toBeNull();
  });

  it('rejects unknown method for game_query', async () => {
    const result = await handleTool('game_query', { method: 'send_key' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
    expect(text).toContain('send_key');
  });

  it('rejects unknown method for game_write', async () => {
    const result = await handleTool('game_write', { method: 'ping' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('rejects unknown method for game_input', async () => {
    const result = await handleTool('game_input', { method: 'ping', params: {} }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('rejects unknown method for game_wait', async () => {
    const result = await handleTool('game_wait', { method: 'ping', params: {} }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('game_query accepts only read methods', async () => {
    // These should pass method validation (will fail on connection, which is fine)
    const readMethods = ['ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_performance', 'get_viewport_info', 'take_screenshot'];
    for (const method of readMethods) {
      const result = await handleTool('game_query', { method }, mockCtx);
      // Should not be "Unknown method" — will be a connection error instead
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Unknown method');
    }
  });

  it('game_write accepts only write methods', async () => {
    const writeMethods = ['set_node_property', 'call_method'];
    for (const method of writeMethods) {
      const result = await handleTool('game_write', { method, params: {} }, mockCtx);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Unknown method');
    }
  });

  it('game_query rejects write methods', async () => {
    const writeMethods = ['set_node_property', 'call_method'];
    for (const method of writeMethods) {
      const result = await handleTool('game_query', { method }, mockCtx);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).toContain('Unknown method');
    }
  });

  it('returns ECONNREFUSED error when bridge is not running', async () => {
    const result = await handleTool('game_query', { method: 'ping' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    // Should be either ECONNREFUSED or "Cannot connect" message
    expect(text).toMatch(/connect|ECONNREFUSED|secret not found/i);
  });
});
