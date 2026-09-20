import { describe, it, expect } from 'vitest';

// Mock dependencies that tool modules import
// I-4 统一策略(设计 §7):importOriginal 部分覆盖——仅 stub 防副作用的 getter/setter,
// 新导出透传真实模块,防补导出漂移。
vi.mock('../../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/process-state.js')>();
  return {
    ...actual,
    getRunningProcess: vi.fn().mockReturnValue(null),
    setRunningProcess: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue([]),
    setOutputBuffer: vi.fn(),
    getProcessStartTime: vi.fn().mockReturnValue(0),
    setProcessStartTime: vi.fn(),
    getProjectDir: vi.fn().mockReturnValue(''),
    setProjectDir: vi.fn(),
  };
});

vi.mock('../../src/core/path-utils.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
  validatePath: vi.fn((p) => p),
}));
vi.mock('../../src/core/config-parser.js', () => ({
  parseGodotConfig: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/core/args-validation.js', () => ({
  requireProjectPath: vi.fn().mockReturnValue('/test'),
}));
vi.mock('../../src/core/godot-finder.js', () => ({
  buildSafeEnv: vi.fn().mockReturnValue({}),
  checkVersionMismatch: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    toolStart: vi.fn().mockReturnValue(0),
    toolEnd: vi.fn(),
  }),
}));

import { getAllToolDefinitions } from '../../src/core/tool-registry.js';

describe('Tool schema: project_path not required', () => {
  it('no tool has project_path in required array', () => {
    const tools = getAllToolDefinitions();
    const violations: string[] = [];
    for (const tool of tools) {
      const required = (tool.inputSchema as { required?: string[] }).required;
      if (required && required.includes('project_path')) {
        violations.push(tool.name);
      }
    }
    expect(violations).toEqual([]);
  });

  it('all tools that accept project_path have updated description', () => {
    const tools = getAllToolDefinitions();
    const violations: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
      if (props?.project_path) {
        const desc = props.project_path.description || '';
        if (!desc.includes('可选') && !desc.includes('optional')) {
          violations.push(tool.name);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});