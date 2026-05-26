import { expect } from 'vitest';
import {
  registerTools,
  clearRegistry,
  isReadOnly,
  isLongRunning,
  getReadOnlyTools,
  getWriteTools,
  getAllToolNames,
} from '../src/core/tool-registry.js';
import { VERIFY_ELIGIBLE_TOOLS, isVerifyEligible } from '../src/core/tool-registry.js';

describe('tool-registry', () => {
  it('registers tools with tags', () => {
    clearRegistry();
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'nav_bake_mesh', readonly: false, long_running: true },
    ]);
    expect(isReadOnly('read_scene')).toBe(true);
    expect(isReadOnly('add_node')).toBe(false);
    expect(isLongRunning('nav_bake_mesh')).toBe(true);
    expect(isLongRunning('add_node')).toBe(false);
  });

  it('returns false for unknown tools', () => {
    expect(isReadOnly('nonexistent_tool')).toBe(false);
    expect(isLongRunning('nonexistent_tool')).toBe(false);
  });

  it('lists all readonly tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
    ]);
    const ro = getReadOnlyTools();
    expect(ro.includes('read_scene')).toBeTruthy();
    expect(ro.includes('get_project_info')).toBeTruthy();
    expect(!ro.includes('add_node')).toBeTruthy();
  });

  it('lists all write tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
    const wr = getWriteTools();
    expect(wr.includes('add_node')).toBeTruthy();
    expect(wr.includes('write_script')).toBeTruthy();
    expect(!wr.includes('read_scene')).toBeTruthy();
  });

  it('getAllToolNames returns all registered names', () => {
    clearRegistry();
    registerTools([
      { name: 'a', readonly: true, long_running: false },
      { name: 'b', readonly: false, long_running: false },
    ]);
    const names = getAllToolNames();
    expect(names.sort()).toEqual(['a', 'b']);
  });
});

describe('L1 verify eligible tools', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains expected write tools', () => {
    expect(VERIFY_ELIGIBLE_TOOLS.has('add_node')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('edit_node')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('write_script')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('edit_script')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('ui_build_layout')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('load_sprite')).toBeTruthy();
  });

  it('isVerifyEligible returns true for add_node', () => {
    expect(isVerifyEligible('add_node')).toBe(true);
  });

  it('isVerifyEligible returns false for read-only tools', () => {
    expect(isVerifyEligible('read_scene')).toBe(false);
    expect(isVerifyEligible('execute_gdscript')).toBe(false);
    expect(isVerifyEligible('profiler')).toBe(false);
  });
});
