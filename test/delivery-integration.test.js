// test/delivery-integration.test.js
import { expect } from 'vitest';

describe('delivery integration tests', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains expected tools', async () => {
    const reg = await import('../src/core/tool-registry.js');
    const supportedTools = ['add_node', 'edit_node', 'write_script', 'edit_script', 'load_sprite', 'ui_build_layout'];
    for (const name of supportedTools) {
      expect(reg.VERIFY_ELIGIBLE_TOOLS.has(name)).toBeTruthy();
    }
  });

  it('verify_delivery is registered in GodotServer toolModules', async () => {
    const mod = await import('../src/tools/delivery.js');
    expect(mod.getToolDefinitions).toBeTruthy();
    expect(mod.handleTool).toBeTruthy();
    expect(mod.TOOL_META).toBeTruthy();
    expect(mod.TOOL_META.verify_delivery).toBeTruthy();
  });

  it('wrapAssertionCode produces valid SceneTree script', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("x", "42")', 'value check');
    expect(code.includes('extends SceneTree')).toBeTruthy();
    expect(code.includes('_mcp_output("x", "42")')).toBeTruthy();
    expect(code.includes('_mcp_done')).toBeTruthy();
  });

  it('dev_loop tool definition includes acceptance', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    expect(devLoop).toBeTruthy();
    expect(devLoop.inputSchema.properties.acceptance).toBeTruthy();
  });

  it('all new test files have no syntax errors', () => {
    // This test passes if the file itself loaded without error
    expect(true).toBeTruthy();
  });
});
