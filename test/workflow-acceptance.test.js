// test/workflow-acceptance.test.js
import { expect } from 'vitest';

describe('dev_loop acceptance parameter', () => {
  it('dev_loop definition includes acceptance parameter', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    expect(devLoop).toBeTruthy();
    const props = devLoop.inputSchema.properties;
    expect('acceptance' in props).toBeTruthy();
  });

  it('acceptance has assertions array with required fields', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    expect('assertions' in acceptanceProps).toBeTruthy();
    const items = acceptanceProps.assertions.items;
    expect(items.properties.description).toBeTruthy();
    expect(items.properties.gdscript).toBeTruthy();
    expect(items.properties.expect).toBeTruthy();
    expect(items.required.includes('description')).toBeTruthy();
    expect(items.required.includes('gdscript')).toBeTruthy();
  });

  it('acceptance does not expose max_retries (removed until implemented)', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    expect('max_retries' in acceptanceProps).toBeFalsy();
  });
});
