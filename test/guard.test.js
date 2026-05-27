import { expect } from 'vitest';
import fc from 'fast-check';
import {
  requiresConfirmation, createPendingToken, consumeToken, pendingCount, GUARDED_TOOLS,
} from '../src/guard.js';

describe('GUARDED_TOOLS', () => {
  it('includes remove_node', () => {
    expect(GUARDED_TOOLS.has('remove_node')).toBeTruthy();
  });
  it('includes execute_gdscript (arbitrary code execution)', () => {
    expect(GUARDED_TOOLS.has('execute_gdscript')).toBeTruthy();
  });
  it('includes write_script (file overwrite protection)', () => {
    expect(GUARDED_TOOLS.has('write_script')).toBeTruthy();
  });
  it('includes save_scene (scene overwrite protection)', () => {
    expect(GUARDED_TOOLS.has('save_scene')).toBeTruthy();
  });
  it('includes detach_instance (destructive scene modification)', () => {
    expect(GUARDED_TOOLS.has('detach_instance')).toBeTruthy();
  });
  it('does NOT include edit_script (auto-validate handles safety)', () => {
    expect(GUARDED_TOOLS.has('edit_script')).toBeFalsy();
  });
});

describe('requiresConfirmation', () => {
  it('returns true for remove_node', () => {
    expect(requiresConfirmation('remove_node')).toBe(true);
  });
  it('returns true for execute_gdscript (arbitrary code execution)', () => {
    expect(requiresConfirmation('execute_gdscript')).toBe(true);
  });
  it('returns true for write_script (now guarded)', () => {
    expect(requiresConfirmation('write_script')).toBe(true);
  });
  it('returns false for non-guarded tools', () => {
    expect(requiresConfirmation('read_scene')).toBe(false);
    expect(requiresConfirmation('get_project_info')).toBe(false);
  });
});

describe('createPendingToken + consumeToken', () => {
  it('creates and consumes a valid token', () => {
    const token = createPendingToken('remove_node', { node_path: '/root/Player' });
    expect(typeof token === 'string' && token.length > 10).toBeTruthy();
    expect(pendingCount()).toBe(1);

    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.toolName).toBe('remove_node');
    expect(result.args).toEqual({ node_path: '/root/Player' });
    expect(pendingCount()).toBe(0);
  });

  it('token is single-use', () => {
    const token = createPendingToken('write_script', { path: 'test.gd' });
    const first = consumeToken(token);
    expect(first).toBeTruthy();
    const second = consumeToken(token);
    expect(second).toBe(null);
  });

  it('unknown token returns null', () => {
    const result = consumeToken('nonexistent_token_12345');
    expect(result).toBe(null);
  });
});

describe('Property: guard', () => {
  it('requiresConfirmation is deterministic for any string', () => {
    fc.assert(
      fc.property(fc.string(), (toolName) => {
        const result = requiresConfirmation(toolName);
        // 调用两次返回相同结果
        expect(requiresConfirmation(toolName)).toBe(result);
        // 结果只能是 true 或 false
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('consumeToken with random string always returns null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (token) => {
        // 任意字符串 token 不会匹配真实 token
        expect(consumeToken(token)).toBe(null);
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('createPendingToken + consumeToken roundtrip preserves toolName', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.anything()),
        (toolName, args) => {
          const token = createPendingToken(toolName, args);
          const consumed = consumeToken(token);
          expect(consumed).not.toBeNull();
          expect(consumed.toolName).toBe(toolName);
        }
      ),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });
});
