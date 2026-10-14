// C1 回归测试(2026-10-14 全维度审查): workflow 吸收的 batch 三 action
// (create_files/run_verify/diff_scenes)参数必须经 ToolDispatcher 的 validateArgs
// (P8-2 顶层未知参数拒绝)全链路可传——v0.18 吸收时漏搬 schema,真实 MCP 调用
// 100% 被"未知参数: files"拒绝,而 test/batch-tools.test.js 直调模块 handleTool
// 绕过 dispatcher 校验链,三层自检全部漏网。本文件钉死该链路。
import { describe, it, expect } from 'vitest';
import { getToolDefinitions as getWorkflowDefs } from '../src/tools/workflow.js';
import { getToolDefinitions as getBatchDefs, BATCH_ACTION_PARAMS } from '../src/tools/batch-tools.js';
import { validateArgs } from '../src/core/args-validator.js';

const workflowDef = getWorkflowDefs().find(d => d.name === 'workflow');
const BATCH_PARAM_KEYS = Object.keys(BATCH_ACTION_PARAMS);

describe('C1: workflow inputSchema 覆盖 batch action 参数', () => {
  it('workflow 工具定义存在', () => {
    expect(workflowDef).toBeTruthy();
  });

  it('BATCH_ACTION_PARAMS 恰好包含 7 个 batch 专属参数', () => {
    expect(BATCH_PARAM_KEYS.sort()).toEqual([
      'capture_tree', 'files', 'ignore_properties', 'scene_a', 'scene_b', 'scenes', 'validate',
    ]);
  });

  it('workflow inputSchema 声明了全部 batch 专属参数', () => {
    const props = Object.keys(workflowDef!.inputSchema.properties);
    for (const k of BATCH_PARAM_KEYS) {
      expect(props).toContain(k);
    }
  });

  it('batch-tools(废弃路径)与 workflow schema 的 batch 参数声明一致(单源防 drift)', () => {
    const batchDef = getBatchDefs().find(d => d.name === 'batch');
    const batchProps = batchDef!.inputSchema.properties;
    for (const k of BATCH_PARAM_KEYS) {
      expect(workflowDef!.inputSchema.properties).toHaveProperty(k);
      expect(batchProps).toHaveProperty(k);
    }
  });
});

describe('C1: 经 validateArgs(dispatcher 校验链)的 batch action 调用不再被未知参数拒绝', () => {
  const project = 'D:/proj';

  it('create_files 带 files/validate 通过', () => {
    const { ok, errors } = validateArgs({
      action: 'create_files', project_path: project,
      files: [{ path: 'res://scripts/player.gd', content: 'extends Node' }],
      validate: true,
    }, workflowDef!.inputSchema);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('run_verify 带 scenes/capture_tree/timeout 通过', () => {
    const { ok, errors } = validateArgs({
      action: 'run_verify', project_path: project,
      scenes: ['scenes/main.tscn'], capture_tree: true, timeout: 15,
    }, workflowDef!.inputSchema);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('diff_scenes 带 scene_a/scene_b/ignore_properties 通过', () => {
    const { ok, errors } = validateArgs({
      action: 'diff_scenes', project_path: project,
      scene_a: 'scenes/a.tscn', scene_b: 'scenes/b.tscn',
      ignore_properties: ['metadata/_edit_lock'],
    }, workflowDef!.inputSchema);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('P8-2 行为不回归: 真正的未知参数仍被拒绝', () => {
    const { ok, errors } = validateArgs({
      action: 'create_files', project_path: project, filez: [1],
    }, workflowDef!.inputSchema);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toContain('未知参数');
  });
});
