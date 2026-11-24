import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllModules } from '../../src/module-loader.js';
import { getAllToolNames, getToolDefinition, skipProjectPath } from '../../src/core/tool-registry.js';
import { validateArgs } from '../../src/core/args-validator.js';

describe('project_path 注入不变量(反馈 2026-11-18)', () => {
  beforeAll(() => { registerAllModules(); });

  it('名单外工具必须在 inputSchema 声明 project_path——否则 dispatcher 注入键被未知参数检查拒掉', () => {
    expect(getAllToolNames().length).toBeGreaterThan(0);
    const offenders = getAllToolNames()
      .filter((name) => !skipProjectPath(name))
      .filter((name) => !Object.keys(getToolDefinition(name)?.inputSchema?.properties ?? {}).includes('project_path'));
    expect(offenders).toEqual([]);
  });

  it('未知参数检查不因本修复放宽:显式 project_path 对未声明的 schema 仍被拒', () => {
    const schema = getToolDefinition('help')!.inputSchema;
    expect(validateArgs({ tool_name: 'help' }, schema).ok).toBe(true);
    expect(validateArgs({ tool_name: 'help', project_path: '/tmp/p' }, schema).ok).toBe(false);
  });
});
