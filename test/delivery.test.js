// test/delivery.test.js
import { expect } from 'vitest';

describe('delivery tool definitions', () => {
  it('verify_delivery is in tool definitions', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tools = mod.getToolDefinitions();
    const names = tools.map(t => t.name);
    expect(names.includes('verify_delivery')).toBeTruthy();
    expect(tools.length).toBe(1);
  });

  it('verify_delivery has required fields', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    expect(tool.inputSchema).toBeTruthy();
    expect(tool.description).toBeTruthy();
    const required = tool.inputSchema.required;
    expect(required.includes('project_path')).toBeTruthy();
    expect(required.includes('scope')).toBeTruthy();
  });

  it('scope accepts scene, script, full', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const scopeEnum = tool.inputSchema.properties.scope.enum;
    expect(scopeEnum).toEqual(['scene', 'script', 'full']);
  });

  it('checks parameter has expected dimensions', async () => {
    const mod = await import('../src/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const checksProps = tool.inputSchema.properties.checks.properties;
    expect('scene_tree' in checksProps).toBeTruthy();
    expect('script_health' in checksProps).toBeTruthy();
    expect('performance' in checksProps).toBeTruthy();
    expect('assertions' in checksProps).toBeTruthy();
  });

  it('TOOL_META marks verify_delivery as readonly and long_running', async () => {
    const mod = await import('../src/tools/delivery.js');
    expect(mod.TOOL_META.verify_delivery.readonly).toBe(true);
    expect(mod.TOOL_META.verify_delivery.long_running).toBe(true);
  });

  it('checkSceneIntegrity is exported', async () => {
    const mod = await import('../src/tools/delivery.js');
    expect(typeof mod.checkSceneIntegrity).toBe('function');
  });

  it('findAssociatedScenes is exported', async () => {
    const mod = await import('../src/tools/delivery.js');
    expect(typeof mod.findAssociatedScenes).toBe('function');
  });
});
