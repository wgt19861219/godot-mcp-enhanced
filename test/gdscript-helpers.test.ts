import { describe, it, expect } from 'vitest';
import { wrapSnippet, wrapSnippetAsNode } from '../src/gdscript-executor.js';
import {
  GD_MCP_GET_ROOT,
  GD_MCP_GET_NODE,
  GD_MCP_LOAD_MAIN_SCENE,
  GD_MCP_OUTPUT,
} from '../src/tools/shared.js';

describe('GDScript helpers - baseline snapshots', () => {
  it('wrapSnippet("var x = 1") baseline', () => {
    const result = wrapSnippet('var x = 1');
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _mcp_get_root');
    expect(result).toContain('func _mcp_get_node');
    expect(result).toContain('func _mcp_load_main_scene');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).toContain('var x = 1');
    expect(result).toMatchSnapshot('wrapSnippet-var-x');
  });

  it('wrapSnippet with func declaration baseline', () => {
    const result = wrapSnippet('func my_func():\n\treturn 42\nvar result = my_func()');
    expect(result).toMatchSnapshot('wrapSnippet-func-decl');
  });

  it('wrapSnippetAsNode("var x = 1") baseline', () => {
    const result = wrapSnippetAsNode('var x = 1');
    expect(result).toContain('extends Node');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).not.toContain('func _mcp_get_root');
    expect(result).not.toContain('func _mcp_get_node');
    expect(result).toMatchSnapshot('wrapSnippetAsNode-var-x');
  });
});

describe('GD_MCP shared constants', () => {
  it('GD_MCP_GET_ROOT contains expected function signature', () => {
    expect(GD_MCP_GET_ROOT).toBeInstanceOf(Array);
    expect(GD_MCP_GET_ROOT[0]).toBe('func _mcp_get_root() -> Node:');
    expect(GD_MCP_GET_ROOT.join('\n')).toContain('_mcp_root = ml.root');
  });

  it('GD_MCP_GET_NODE uses precise version (not simplified)', () => {
    expect(GD_MCP_GET_NODE).toBeInstanceOf(Array);
    expect(GD_MCP_GET_NODE[0]).toBe('func _mcp_get_node(path: NodePath) -> Node:');
    const joined = GD_MCP_GET_NODE.join('\n');
    // 精确版特征：单独检查 _part == "root" 且带 _node == _r 条件
    expect(joined).toContain('if _part == "root" and _node == _r:');
    // 简洁版特征不应存在
    expect(joined).not.toContain('or _part == "root"');
  });

  it('GD_MCP_LOAD_MAIN_SCENE contains ProjectSettings call', () => {
    expect(GD_MCP_LOAD_MAIN_SCENE).toBeInstanceOf(Array);
    expect(GD_MCP_LOAD_MAIN_SCENE[0]).toBe('func _mcp_load_main_scene() -> void:');
    expect(GD_MCP_LOAD_MAIN_SCENE.join('\n')).toContain('ProjectSettings.get_setting');
  });

  it('GD_MCP_OUTPUT contains append call', () => {
    expect(GD_MCP_OUTPUT).toBeInstanceOf(Array);
    expect(GD_MCP_OUTPUT.join('\n')).toContain('_mcp_outputs.append');
  });
});
