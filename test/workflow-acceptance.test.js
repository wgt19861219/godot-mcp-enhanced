// test/workflow-acceptance.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('dev_loop acceptance parameter', () => {
  it('dev_loop definition includes acceptance parameter', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    assert.ok(devLoop);
    const props = devLoop.inputSchema.properties;
    assert.ok('acceptance' in props, 'acceptance parameter missing');
  });

  it('acceptance has assertions array with required fields', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    assert.ok('assertions' in acceptanceProps);
    const items = acceptanceProps.assertions.items;
    assert.ok(items.properties.description);
    assert.ok(items.properties.gdscript);
    assert.ok(items.properties.expect);
    assert.ok(items.required.includes('description'));
    assert.ok(items.required.includes('gdscript'));
  });

  it('acceptance does not expose max_retries (removed until implemented)', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const acceptanceProps = devLoop.inputSchema.properties.acceptance.properties;
    assert.ok(!('max_retries' in acceptanceProps));
  });
});
