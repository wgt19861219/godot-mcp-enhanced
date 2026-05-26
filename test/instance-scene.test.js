import { expect } from 'vitest';
import * as scene from '../src/tools/scene.js';

describe('instance_scene tool definition', () => {
  it('should be registered (handleTool returns non-null for instance_scene)', async () => {
    // TOOL_NAMES is not exported; verify via handleTool returning a result (not null)
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      // instance_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    expect(result !== null).toBeTruthy();
  });

  it('should have tool definition with correct schema', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'instance_scene');
    expect(def).toBeTruthy();
    expect(def.inputSchema.required?.includes('project_path')).toBeTruthy();
    expect(def.inputSchema.required?.includes('scene_path')).toBeTruthy();
    expect(def.inputSchema.required?.includes('instance_path')).toBeTruthy();
  });

  it('should reject missing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('error') || result.content[0].text.includes('Error')).toBeTruthy();
  });

  it('should reject self-referencing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://scenes/main.tscn',
      instance_path: 'res://scenes/main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('CIRCULAR')).toBeTruthy();
  });
});

describe('instance_scene TOOL_META', () => {
  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    expect(meta['instance_scene']).toBeTruthy();
    expect(meta['instance_scene'].readonly).toBe(false);
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
    expect(result !== null).toBeTruthy();
  });

  it('should have tool definition', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'set_instance_property');
    expect(def).toBeTruthy();
    expect(def.inputSchema.required).toEqual(['project_path', 'scene_path', 'node_path', 'property', 'value']);
  });

  it('should be marked as write tool', () => {
    expect(scene.TOOL_META['set_instance_property'].readonly).toBe(false);
  });

  it('should reject missing required params', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('MISSING_PARAM') || result.content[0].text.includes('error')).toBeTruthy();
  });

  it('should reject blocked property names', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'script',
      value: 'test',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('BLOCKED_PROP')).toBeTruthy();
  });

  it('should reject invalid property names', async () => {
    const result = await scene.handleTool('set_instance_property', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'invalid-name!',
      value: 'test',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('INVALID_PARAM') || result.content[0].text.includes('Invalid property')).toBeTruthy();
  });
});

describe('detach_instance tool definition', () => {
  it('should be registered in TOOL_NAMES', async () => {
    const result = await scene.handleTool('detach_instance', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result !== null).toBeTruthy();
  });

  it('should have tool definition', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'detach_instance');
    expect(def).toBeTruthy();
    expect(def.inputSchema.required).toEqual(['project_path', 'scene_path', 'node_path']);
  });

  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    expect(meta['detach_instance']).toBeTruthy();
    expect(meta['detach_instance'].readonly).toBe(false);
    expect(meta['detach_instance'].long_running).toBe(false);
  });

  it('should reject missing node_path', async () => {
    const result = await scene.handleTool('detach_instance', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('MISSING_PARAM') || result.content[0].text.includes('node_path')).toBeTruthy();
  });
});
