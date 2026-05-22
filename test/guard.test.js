import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiresConfirmation, createPendingToken, consumeToken, pendingCount, GUARDED_TOOLS,
} from '../build/guard.js';

describe('GUARDED_TOOLS', () => {
  it('includes remove_node', () => {
    assert.ok(GUARDED_TOOLS.has('remove_node'));
  });
  it('includes execute_gdscript (arbitrary code execution)', () => {
    assert.ok(GUARDED_TOOLS.has('execute_gdscript'));
  });
  it('does NOT include write_script (unblocked for usability)', () => {
    assert.ok(!GUARDED_TOOLS.has('write_script'));
  });
  it('does NOT include edit_script (auto-validate handles safety)', () => {
    assert.ok(!GUARDED_TOOLS.has('edit_script'));
  });
});

describe('requiresConfirmation', () => {
  it('returns true for remove_node', () => {
    assert.strictEqual(requiresConfirmation('remove_node'), true);
  });
  it('returns true for execute_gdscript (arbitrary code execution)', () => {
    assert.strictEqual(requiresConfirmation('execute_gdscript'), true);
  });
  it('returns false for write_script (unblocked)', () => {
    assert.strictEqual(requiresConfirmation('write_script'), false);
  });
  it('returns false for non-guarded tools', () => {
    assert.strictEqual(requiresConfirmation('read_scene'), false);
    assert.strictEqual(requiresConfirmation('get_project_info'), false);
  });
});

describe('createPendingToken + consumeToken', () => {
  it('creates and consumes a valid token', () => {
    const token = createPendingToken('remove_node', { node_path: '/root/Player' });
    assert.ok(typeof token === 'string' && token.length > 10);
    assert.strictEqual(pendingCount(), 1);

    const result = consumeToken(token);
    assert.ok(result);
    assert.strictEqual(result.toolName, 'remove_node');
    assert.deepStrictEqual(result.args, { node_path: '/root/Player' });
    assert.strictEqual(pendingCount(), 0);
  });

  it('token is single-use', () => {
    const token = createPendingToken('write_script', { path: 'test.gd' });
    const first = consumeToken(token);
    assert.ok(first);
    const second = consumeToken(token);
    assert.strictEqual(second, null);
  });

  it('unknown token returns null', () => {
    const result = consumeToken('nonexistent_token_12345');
    assert.strictEqual(result, null);
  });
});
