import { expect, vi, describe, it } from 'vitest';
import { getToolDefinitions } from '../src/tools/workflow.js';

describe('workflow tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 3 tools', () => {
    expect(tools.length).toBe(3);
  });

  it('includes dev_loop', () => {
    expect(names.includes('dev_loop')).toBeTruthy();
  });

  it('includes scene_snapshot', () => {
    expect(names.includes('scene_snapshot')).toBeTruthy();
  });

  it('includes batch_validate', () => {
    expect(names.includes('batch_validate')).toBeTruthy();
  });

  it('all tools have required fields', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('dev_loop has bridge parameter', () => {
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const props = devLoop.inputSchema.properties;
    expect(props.bridge).toBeTruthy();
    expect(props.bridge.properties.screenshot).toBeTruthy();
    expect(props.bridge.properties.queries).toBeTruthy();
  });

  it('bridge.queries has maxItems limit', () => {
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const queries = devLoop.inputSchema.properties.bridge.properties.queries;
    expect(queries.maxItems).toBe(10);
  });
});

describe('workflow dev_loop bridge logic', () => {
  it('BRIDGE_READ_ONLY_METHODS excludes write methods', async () => {
    const { BRIDGE_READ_ONLY_METHODS } = await import('../src/tools/game-bridge.js');
    expect(BRIDGE_READ_ONLY_METHODS.has('set_node_property')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('send_key')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('call_method')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('take_screenshot')).toBe(false);
  });

  it('BRIDGE_READ_ONLY_METHODS includes all read-only methods', async () => {
    const { BRIDGE_READ_ONLY_METHODS } = await import('../src/tools/game-bridge.js');
    expect(BRIDGE_READ_ONLY_METHODS.has('ping')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_tree')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('find_nodes')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_node_properties')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_performance')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_viewport_info')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.size).toBe(6);
  });
});
