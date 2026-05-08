import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions } from '../build/tools/game-bridge.js';

describe('game-bridge tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 5 tools', () => {
    assert.strictEqual(tools.length, 5);
  });

  it('includes game_bridge_install', () => {
    assert.ok(names.includes('game_bridge_install'));
  });

  it('includes game_bridge_uninstall', () => {
    assert.ok(names.includes('game_bridge_uninstall'));
  });

  it('includes game_query', () => {
    assert.ok(names.includes('game_query'));
  });

  it('includes game_input', () => {
    assert.ok(names.includes('game_input'));
  });

  it('includes game_wait', () => {
    assert.ok(names.includes('game_wait'));
  });

  it('all tools have required inputSchema', () => {
    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
      assert.ok(tool.inputSchema.properties, `${tool.name} missing properties`);
    }
  });
});
