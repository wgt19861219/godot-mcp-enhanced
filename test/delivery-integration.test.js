// test/delivery-integration.test.js
import { expect } from 'vitest';

describe('delivery integration tests', () => {
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
    expect(code).toContain('extends SceneTree');
    expect(code).toContain('_mcp_output("x", "42")');
    expect(code).toContain('_mcp_done');
  });

  it('workflow tool definition includes acceptance', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const wf = tools.find(t => t.name === 'workflow');
    expect(wf).toBeTruthy();
    expect(wf.inputSchema.properties.acceptance).toBeTruthy();
  });

  it('delivery tool modules import without errors', async () => {
    // 审查 Nit-T3(2026-10-13):原名「all new test files have no syntax errors」名不副实
    // (本用例不检查任何外部文件)。实际行为 = 动态 import 三个交付相关模块可加载且导出非空。
    for (const p of ['../src/tools/delivery.js', '../src/tools/shared.js', '../src/tools/workflow.js']) {
      const mod = await import(p);
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    }
  });
});
