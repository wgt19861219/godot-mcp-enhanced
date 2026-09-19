import { expect } from 'vitest';
import { ReadOnlyGuard } from '../src/core/ReadOnlyGuard.js';
import { registerTools } from '../src/core/tool-registry.js';

describe('ReadOnlyGuard', () => {
  beforeEach(() => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
  });

  it('allows readonly tools when guard is active', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('read_scene');
    expect(result.blocked).toBe(false);
  });

  it('blocks write tools when guard is active', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('add_node');
    expect(result.blocked).toBe(true);
    expect(result.errorCode).toBe(-32001);
    expect(result.message).toContain('read-only');
  });

  it('allows all tools when guard is inactive', () => {
    const guard = new ReadOnlyGuard(false);
    expect(guard.check('add_node').blocked).toBe(false);
    expect(guard.check('write_script').blocked).toBe(false);
    expect(guard.check('read_scene').blocked).toBe(false);
  });

  it('blocks unknown tools in readonly mode (safe default)', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('unknown_tool');
    expect(result.blocked).toBe(true);
  });

  it('returns proper error structure', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('write_script');
    expect(result).toEqual({
      blocked: true,
      errorCode: -32001,
      message: 'Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)',
    });
  });

  // ── 批4-T5(五维评估 P2): action 粒度只读判定 ──

  it('批4-T5: readonly 工具的 read action 放行,write action 拒(显式 readonly 不再覆盖 action 风险)', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
      // 模拟 manage_tools 形态:显式 readonly:true + 含 write action(评估 P2 场景)
      {
        name: 'manage_tools', readonly: true, long_running: false,
        actionRisks: { list_groups: 'read', discover: 'read', activate: 'write', deactivate: 'write' },
      },
    ]);
    const guard = new ReadOnlyGuard(true);
    expect(guard.check('manage_tools', 'list_groups').blocked).toBe(false);
    expect(guard.check('manage_tools', 'discover').blocked).toBe(false);
    const blocked = guard.check('manage_tools', 'activate');
    expect(blocked.blocked).toBe(true);
    expect(blocked.errorCode).toBe(-32001);
    expect(blocked.message).toContain('activate');
    expect(guard.check('manage_tools', 'deactivate').blocked).toBe(true);
  });

  it('批4-T5: readonly 工具的未知 action fail-closed 拒(动态名等不可静态归风险不放行)', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
      {
        name: 'manage_tools', readonly: true, long_running: false,
        actionRisks: { list_groups: 'read' },
      },
    ]);
    const guard = new ReadOnlyGuard(true);
    const unknown = guard.check('manage_tools', 'some_new_action');
    expect(unknown.blocked).toBe(true);
    expect(unknown.message).toContain('not statically risk-mapped');
  });

  it('批4-T5: 不传 action 时保持工具级判定(工具列表过滤场景,行为兼容)', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
      {
        name: 'manage_tools', readonly: true, long_running: false,
        actionRisks: { activate: 'write' },
      },
    ]);
    const guard = new ReadOnlyGuard(true);
    expect(guard.check('manage_tools').blocked).toBe(false);  // 无 action → 工具级(readonly 放行)
    expect(guard.check('manage_tools', '').blocked).toBe(false);  // 空 action 同不传
  });
});
