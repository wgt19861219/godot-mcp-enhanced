import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('shared verify utilities', () => {
  it('quickVerify is exported', async () => {
    const mod = await import('../build/tools/shared.js');
    assert.strictEqual(typeof mod.quickVerify, 'function');
  });

  it('quickVerify returns null when verify=false', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('add_node', { verify: false });
    assert.strictEqual(result, null);
  });

  it('quickVerify returns null when verify not set', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('add_node', {});
    assert.strictEqual(result, null);
  });

  it('quickVerify returns passed=false for unknown tool', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('nonexistent_tool', { verify: true });
    assert.strictEqual(result.passed, false);
    assert.ok(result.error);
  });

  it('quickVerify returns passed=false for unsupported tool', async () => {
    const mod = await import('../build/tools/shared.js');
    const result = await mod.quickVerify('execute_gdscript', { verify: true });
    assert.strictEqual(result.passed, false);
    assert.ok(result.error);
  });

  it('wrapAssertionCode is exported', async () => {
    const mod = await import('../build/tools/shared.js');
    assert.strictEqual(typeof mod.wrapAssertionCode, 'function');
  });

  it('wrapAssertionCode wraps GDScript assertion code', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode(
      'var _v = 42\n_mcp_output("count", str(_v))',
      'test assertion'
    );
    assert.ok(code.includes('extends SceneTree'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('var _v = 42'));
    assert.ok(code.includes('_mcp_done'));
  });

  it('wrapAssertionCode escapes dollar signs in description', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("t", "v")', 'test $var');
    // gdEscape turns $ into \$, so the raw dollar sign is escaped
    const descLine = code.split('\n').find(l => l.includes('_desc'));
    assert.ok(descLine, 'should contain _desc line');
    assert.ok(descLine.includes('\\$var'), 'dollar sign should be backslash-escaped');
  });

  it('genCheckNodeExists template generates valid GDScript', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.genCheckNodeExists('root/Player/Sprite2D');
    assert.ok(code.includes('_mcp_get_node'));
    assert.ok(code.includes('root/Player/Sprite2D'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('"exists"'));
  });

  it('genCheckProperties template generates valid GDScript', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.genCheckProperties('root/Player', { position: { x: 100, y: 200 } });
    assert.ok(code.includes('position'));
    assert.ok(code.includes('_mcp_output'));
    assert.ok(code.includes('"actual"'));
  });
});
