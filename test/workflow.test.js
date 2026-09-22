import { expect, vi, describe, it, beforeEach } from 'vitest';

// vi.mock 由 vitest 自动 hoist 到所有 import 之前;工厂不引用外部变量。
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => ({ success: true, outputs: [] })),
  executeGdscriptTrusted: vi.fn(async () => ({ success: true, outputs: [] })),
}));

import { executeGdscriptTrusted } from '../src/gdscript-executor.js';
import { getToolDefinitions, handleTool } from '../src/tools/workflow.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── scene_snapshot null-root guard (defect: gdscript-gen-null-root-deref 回归) ──
// _mcp_get_root() 可返回 null(gdscript-executor.ts:829); add_child 前必须判空,
// 防 null.add_child 崩溃。与 gdscript-templates.ts 既定模式一致。

describe('scene_snapshot — _mcp_get_root() null guard before add_child', () => {
  beforeEach(() => {
    executeGdscriptTrusted.mockClear();
  });

  it('add_child 前判空 root(防 null.add_child 崩溃)', async () => {
    await handleTool('workflow', {
      action: 'scene_snapshot',
      project_path: '/fake/proj',
      scene_path: 'main.tscn',
    }, fakeCtx);
    expect(executeGdscriptTrusted).toHaveBeenCalled();
    const code = executeGdscriptTrusted.mock.calls[0][0].code;
    expect(code.includes('_mcp_get_root().add_child')).toBe(false);
    expect(code).toContain('var _root: Node = _mcp_get_root()');
  });
});

describe('workflow tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 1 tool', () => {
    expect(tools.length).toBe(1);
  });

  it('includes workflow', () => {
    expect(names).toContain('workflow');
  });

  it('tool has action parameter with correct enum values', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const action = wf.inputSchema.properties.action;
    expect(action).toBeTruthy();
    expect(action.enum).toContain('dev_loop');
    expect(action.enum).toContain('scene_snapshot');
    expect(action.enum).toContain('batch_validate');
  });

  it('tool has required fields', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('workflow has bridge parameter', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const props = wf.inputSchema.properties;
    expect(props.bridge).toBeTruthy();
    expect(props.bridge.properties.screenshot).toBeTruthy();
    expect(props.bridge.properties.queries).toBeTruthy();
  });

  it('bridge.queries has maxItems limit', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const queries = wf.inputSchema.properties.bridge.properties.queries;
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
    expect(BRIDGE_READ_ONLY_METHODS.has('get_node_layout')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_performance')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_viewport_info')).toBe(true);
    // CMP-2 (2026-08-08): get_errors/clear_errors 加入只读集合(只操作 bridge 内部 buffer)
    expect(BRIDGE_READ_ONLY_METHODS.has('get_errors')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('clear_errors')).toBe(true);
    // 布局审计批 (2026-09-22): dump_layout_tree/get_font_report 加入只读集合(能力 A/C 只读导出)
    expect(BRIDGE_READ_ONLY_METHODS.has('dump_layout_tree')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_font_report')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.size).toBe(11);
  });
});
