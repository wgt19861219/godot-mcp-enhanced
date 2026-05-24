import { expect } from 'vitest';
import { getToolDefinitions } from '../build/tools/game-bridge.js';

describe('game-bridge tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 5 tools', () => {
    expect(tools.length).toBe(5);
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
