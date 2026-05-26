import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock godot-docs before importing the module under test
vi.mock('../src/godot-docs.js', () => ({
  getClassInfo: vi.fn(() => ({
    name: 'Node2D',
    inherits: 'CanvasItem',
    brief_description: 'A 2D game object',
    description: 'Base node for 2D',
    methods: [{
      name: 'set_position',
      return_type: 'void',
      arguments: [{ name: 'position', type: 'Vector2' }],
      description: 'Sets the position.',
    }],
    properties: [{
      name: 'position',
      type: 'Vector2',
      description: 'Position of the node.',
    }],
    signals: [{ name: 'position_changed', description: 'Emitted when position changes.' }],
    constants: [],
    enums: [],
  })),
  searchClasses: vi.fn(() => [
    { name: 'Node2D', inherits: 'CanvasItem', description: 'A 2D game object' },
    { name: 'Node3D', inherits: 'Node', description: 'A 3D game object' },
  ]),
  findMethod: vi.fn(() => ({
    name: 'set_position',
    return_type: 'void',
    arguments: [{ name: 'position', type: 'Vector2', default_value: undefined }],
    description: 'Sets the position.',
  })),
  getInheritanceChain: vi.fn(() => ['Node2D', 'CanvasItem', 'Node', 'Object']),
  initDocs: vi.fn(),
  clearApiCache: vi.fn(),
}));

import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/docs.js';

describe('docs tools', () => {
  const ctx = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getToolDefinitions returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThanOrEqual(4);
    const names = defs.map(d => d.name);
    expect(names).toContain('search_classes');
    expect(names).toContain('get_class_info');
    expect(names).toContain('find_method');
    expect(names).toContain('get_inheritance');
  });

  it('TOOL_META has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThanOrEqual(4);
    expect(TOOL_META['get_class_info']).toBeDefined();
    expect(TOOL_META['get_class_info'].readonly).toBe(true);
    expect(TOOL_META['search_classes'].readonly).toBe(true);
    expect(TOOL_META['find_method'].readonly).toBe(true);
    expect(TOOL_META['get_inheritance'].readonly).toBe(true);
  });

  it('handleTool returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool_xyz', {}, ctx);
    expect(result).toBeNull();
  });

  it('handleTool for search_classes returns results', async () => {
    const result = await handleTool('search_classes', { query: 'node' }, ctx);
    expect(result).not.toBeNull();
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Node2D');
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(2);
    expect(parsed.classes.length).toBe(2);
  });

  it('handleTool for get_class_info returns class details', async () => {
    const result = await handleTool('get_class_info', { class_name: 'Node2D' }, ctx);
    expect(result).not.toBeNull();
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('Node2D');
    expect(parsed.inherits).toBe('CanvasItem');
    expect(parsed.methods.length).toBeGreaterThanOrEqual(1);
  });

  it('handleTool for find_method returns method info', async () => {
    const result = await handleTool('find_method', {
      class_name: 'Node2D',
      method_name: 'set_position',
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('set_position');
    expect(parsed.return_type).toBe('void');
  });

  it('handleTool for get_inheritance returns chain', async () => {
    const result = await handleTool('get_inheritance', { class_name: 'Node2D' }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.class).toBe('Node2D');
    expect(parsed.inheritance_chain.length).toBeGreaterThanOrEqual(2);
  });
});
