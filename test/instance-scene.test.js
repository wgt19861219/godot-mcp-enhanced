import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../build/tools/scene.js';

describe('instance_scene tool definition', () => {
  it('should be registered (handleTool returns non-null for instance_scene)', async () => {
    // TOOL_NAMES is not exported; verify via handleTool returning a result (not null)
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      // instance_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    assert.ok(result !== null, 'handleTool should return non-null for instance_scene');
  });

  it('should have tool definition with correct schema', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'instance_scene');
    assert.ok(def, 'instance_scene tool definition not found');
    assert.ok(def.inputSchema.required?.includes('project_path'));
    assert.ok(def.inputSchema.required?.includes('scene_path'));
    assert.ok(def.inputSchema.required?.includes('instance_path'));
  });

  it('should reject missing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('error') || result.content[0].text.includes('Error'));
  });

  it('should reject self-referencing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://scenes/main.tscn',
      instance_path: 'res://scenes/main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('CIRCULAR'));
  });
});

describe('instance_scene TOOL_META', () => {
  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    assert.ok(meta['instance_scene']);
    assert.equal(meta['instance_scene'].readonly, false);
  });
});

describe('set_instance_property tool definition', () => {
  it('should be registered in TOOL_NAMES', async () => {
    // Verify via handleTool returning a result (not null)
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      // node_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    assert.ok(result !== null, 'handleTool should return non-null for set_instance_property');
  });

  it('should have tool definition', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'set_instance_property');
    assert.ok(def);
    assert.deepEqual(def.inputSchema.required, ['project_path', 'scene_path', 'node_path', 'property', 'value']);
  });

  it('should be marked as write tool', () => {
    assert.equal(scene.TOOL_META['set_instance_property'].readonly, false);
  });

  it('should reject missing required params', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('MISSING_PARAM') || result.content[0].text.includes('error'));
  });

  it('should reject blocked property names', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'script',
      value: 'test',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('BLOCKED_PROP'));
  });

  it('should reject invalid property names', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'invalid-name!',
      value: 'test',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('INVALID_PARAM') || result.content[0].text.includes('Invalid property'));
  });
});
