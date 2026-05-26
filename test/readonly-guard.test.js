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
    expect(result.message.includes('read-only')).toBeTruthy();
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
});
