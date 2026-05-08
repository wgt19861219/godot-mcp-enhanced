import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions } from '../build/tools/workflow.js';

describe('workflow tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 3 tools', () => {
    assert.strictEqual(tools.length, 3);
  });

  it('includes dev_loop', () => {
    assert.ok(names.includes('dev_loop'));
  });

  it('includes scene_snapshot', () => {
    assert.ok(names.includes('scene_snapshot'));
  });

  it('includes batch_validate', () => {
    assert.ok(names.includes('batch_validate'));
  });

  it('all tools have required fields', () => {
    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
      assert.ok(tool.description, `${tool.name} missing description`);
    }
  });
});
