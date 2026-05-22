import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTools,
  clearRegistry,
  isReadOnly,
  isLongRunning,
  getReadOnlyTools,
  getWriteTools,
  getAllToolNames,
} from '../build/core/tool-registry.js';
import { VERIFY_ELIGIBLE_TOOLS, isVerifyEligible } from '../build/core/tool-registry.js';

describe('tool-registry', () => {
  it('registers tools with tags', () => {
    clearRegistry();
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'nav_bake_mesh', readonly: false, long_running: true },
    ]);
    assert.equal(isReadOnly('read_scene'), true);
    assert.equal(isReadOnly('add_node'), false);
    assert.equal(isLongRunning('nav_bake_mesh'), true);
    assert.equal(isLongRunning('add_node'), false);
  });

  it('returns false for unknown tools', () => {
    assert.equal(isReadOnly('nonexistent_tool'), false);
    assert.equal(isLongRunning('nonexistent_tool'), false);
  });

  it('lists all readonly tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
    ]);
    const ro = getReadOnlyTools();
    assert.ok(ro.includes('read_scene'));
    assert.ok(ro.includes('get_project_info'));
    assert.ok(!ro.includes('add_node'));
  });

  it('lists all write tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
    const wr = getWriteTools();
    assert.ok(wr.includes('add_node'));
    assert.ok(wr.includes('write_script'));
    assert.ok(!wr.includes('read_scene'));
  });

  it('getAllToolNames returns all registered names', () => {
    clearRegistry();
    registerTools([
      { name: 'a', readonly: true, long_running: false },
      { name: 'b', readonly: false, long_running: false },
    ]);
    const names = getAllToolNames();
    assert.deepEqual(names.sort(), ['a', 'b']);
  });
});

describe('L1 verify eligible tools', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains expected write tools', () => {
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('add_node'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('edit_node'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('write_script'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('edit_script'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('ui_build_layout'));
    assert.ok(VERIFY_ELIGIBLE_TOOLS.has('load_sprite'));
  });

  it('isVerifyEligible returns true for add_node', () => {
    assert.strictEqual(isVerifyEligible('add_node'), true);
  });

  it('isVerifyEligible returns false for read-only tools', () => {
    assert.strictEqual(isVerifyEligible('read_scene'), false);
    assert.strictEqual(isVerifyEligible('execute_gdscript'), false);
    assert.strictEqual(isVerifyEligible('profiler'), false);
  });
});
