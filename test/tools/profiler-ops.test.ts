// test/tools/profiler-ops.test.ts — W10 批4 组A:工具壳层单测
// 覆盖:capture_functions 的 functionProfiler 注入路径(参数透传/错误映射/未 spawn)、
// get_data 参数边界(ensurePositiveInt)、未知 action、snapshot 的 GDScript 执行透传。
// 诚实边界:GDScript 生成内容的正确性由 GD 侧 e2e 覆盖,此处只测 TS 编排层。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/gdscript-executor.js', () => ({
  executeGdscriptRuntime: vi.fn(),
}));

import { handleTool, getToolDefinitions, TOOL_META } from '../../src/tools/profiler-ops.js';
import { ProfilerError } from '../../src/core/function-profiler.js';
import { executeGdscriptRuntime } from '../../src/gdscript-executor.js';

const mockExec = vi.mocked(executeGdscriptRuntime);

const CTX = { findGodot: async () => '/fake/godot' } as never;

function firstJson(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text!);
}

describe('profiler capture_functions(函数级 profiling,TS 侧解码)', () => {
  it('未 spawn(profiling=false) → PROFILER_NOT_SPAWNED 并指引用户先 run_project(profiling=true)', async () => {
    const r = await handleTool('profiler', { action: 'capture_functions', project_path: '/p' }, CTX);
    const j = firstJson(r!);
    expect(j.error_code).toBe('PROFILER_NOT_SPAWNED');
    expect(String(j.error)).toContain('profiling=true');
  });

  it('参数透传 profiler.captureWindow(秒/top/sort/captureLimit)并 textResult JSON 输出', async () => {
    const captureWindow = vi.fn().mockResolvedValue({ rows: [{ signature: 'a.gd::1::f' }], peak: {} });
    const r = await handleTool('profiler', {
      action: 'capture_functions', project_path: '/p',
      seconds: 7, top: 15, sort: 'totalMs', capture_limit: 64,
    }, { findGodot: CTX.findGodot, functionProfiler: { captureWindow } } as never);
    expect(captureWindow).toHaveBeenCalledWith(7, 15, 'totalMs', 64);
    expect(firstJson(r!).rows).toHaveLength(1);
  });

  it('ProfilerError → PROFILER_<CODE> 结构化错误码', async () => {
    const captureWindow = vi.fn().mockRejectedValue(
      new ProfilerError('profile_bad_frame', 'layout drifted'));
    const r = await handleTool('profiler', {
      action: 'capture_functions', project_path: '/p',
    }, { findGodot: CTX.findGodot, functionProfiler: { captureWindow } } as never);
    const j = firstJson(r!);
    expect(j.error_code).toBe('PROFILER_PROFILE_BAD_FRAME');
    expect(String(j.error)).toContain('layout drifted');
  });
});

describe('profiler 既有 action 编排层', () => {
  beforeEach(() => { mockExec.mockReset(); });

  it('未知 action → INVALID_ACTION', async () => {
    const r = await handleTool('profiler', { action: 'nope', project_path: '/p' }, CTX);
    expect(firstJson(r!).error_code).toBe('INVALID_ACTION');
  });

  it('get_data target_fps=0 越下界 → INVALID_PARAMS(ensurePositiveInt 防线)', async () => {
    const r = await handleTool('profiler', { action: 'get_data', project_path: '/p', target_fps: 0 }, CTX);
    const j = firstJson(r!);
    expect(j.error_code).toBe('INVALID_PARAMS');
    expect(String(j.error)).toContain('target_fps');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('snapshot:executeGdscriptRuntime 透传(godotPath/projectPath/code/loadAutoloads)并解析输出', async () => {
    mockExec.mockResolvedValue({
      success: true, compile_success: true, compile_error: '', errors: [],
      run_success: true, run_error: '',
      outputs: [{ key: 'snapshot', value: '{"fps":60}' }],
      raw_output: '', duration_ms: 5,
    } as never);
    const r = await handleTool('profiler', { action: 'snapshot', project_path: '/p' }, CTX);
    expect(mockExec).toHaveBeenCalledTimes(1);
    const call = mockExec.mock.calls[0]![0];
    expect(call.godotPath).toBe('/fake/godot');
    expect(call.projectPath).toBe('/p');
    expect(String(call.code)).toContain('Performance.get_monitor');
    expect((firstJson(r!).data as Record<string, unknown>).snapshot).toEqual({ fps: 60 }); // outputs JSON 解析进 data.<key>
  });

  it('get_data 成功路径走独立 timeout=45 与 parseGdscriptResult(dimensions warnings 透传)', async () => {
    mockExec.mockResolvedValue({
      success: true, compile_success: true, compile_error: '', errors: [],
      run_success: true, run_error: '',
      outputs: [{ key: 'result', value: '{"fps":60}' }],
      raw_output: '', duration_ms: 5,
    } as never);
    const r = await handleTool('profiler', {
      action: 'get_data', project_path: '/p',
      dimensions: ['process', 'invalid_dim'],  // 数组形态才走白名单校验(字符串整体回落默认)
    }, CTX);
    expect(mockExec.mock.calls[0]![0].timeout).toBe(45);
    const text = r!.content[0]!.text!;
    expect(text).toContain('invalid_dim'); // parseDimensions 的警告进结果
  });
});

describe('注册元数据', () => {
  it('getToolDefinitions 提供单工具 profiler;TOOL_META 声明只读与 action 风险', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('profiler');
    expect(TOOL_META.profiler.readonly).toBe(false); // spec §4.1:GUARDED 迁移保持原行为(不确认)
    expect(TOOL_META.profiler.actionRisks.capture_functions).toBeDefined();
  });
});
