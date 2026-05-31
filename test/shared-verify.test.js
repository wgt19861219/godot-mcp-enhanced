import { expect } from 'vitest';

describe('shared verify utilities', () => {
  it('quickVerify is exported', async () => {
    const mod = await import('../src/tools/shared.js');
    expect(typeof mod.quickVerify).toBe('function');
  });

  it('quickVerify returns null when verify=false', async () => {
    const mod = await import('../src/tools/shared.js');
    const result = await mod.quickVerify('add_node', { verify: false });
    expect(result).toBe(null);
  });

  it('quickVerify returns null when verify not set', async () => {
    const mod = await import('../src/tools/shared.js');
    const result = await mod.quickVerify('add_node', {});
    expect(result).toBe(null);
  });

  it('quickVerify returns passed=false for unknown tool', async () => {
    const mod = await import('../src/tools/shared.js');
    const result = await mod.quickVerify('nonexistent_tool', { verify: true });
    expect(result.passed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('quickVerify returns passed=false for unsupported tool', async () => {
    const mod = await import('../src/tools/shared.js');
    const result = await mod.quickVerify('execute_gdscript', { verify: true });
    expect(result.passed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('wrapAssertionCode is exported', async () => {
    const mod = await import('../src/tools/shared.js');
    expect(typeof mod.wrapAssertionCode).toBe('function');
  });

  it('wrapAssertionCode wraps GDScript assertion code', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.wrapAssertionCode(
      'var _v = 42\n_mcp_output("count", str(_v))',
      'test assertion'
    );
    expect(code.includes('extends SceneTree')).toBeTruthy();
    expect(code.includes('_mcp_output')).toBeTruthy();
    expect(code.includes('var _v = 42')).toBeTruthy();
    expect(code.includes('_mcp_done')).toBeTruthy();
  });

  it('wrapAssertionCode preserves dollar signs in description', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("t", "v")', 'test $var');
    // $ is NOT escaped — it has no special meaning in GDScript string literals
    const descLine = code.split('\n').find(l => l.includes('_desc'));
    expect(descLine).toBeTruthy();
    expect(descLine.includes('$var')).toBeTruthy();
  });

  it('genCheckNodeExists template generates valid GDScript', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.genCheckNodeExists('root/Player/Sprite2D');
    expect(code.includes('_mcp_get_node')).toBeTruthy();
    expect(code.includes('root/Player/Sprite2D')).toBeTruthy();
    expect(code.includes('_mcp_output')).toBeTruthy();
    expect(code.includes('"exists"')).toBeTruthy();
  });

  it('genCheckProperties template generates valid GDScript', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.genCheckProperties('root/Player', { position: { x: 100, y: 200 } });
    expect(code.includes('position')).toBeTruthy();
    expect(code.includes('_mcp_output')).toBeTruthy();
    expect(code.includes('"actual"')).toBeTruthy();
  });
});
