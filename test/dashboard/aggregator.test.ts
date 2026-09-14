import { describe, it, expect, beforeEach } from 'vitest';
import { Aggregator } from '../../src/dashboard/aggregator.js';
import type { LogEntry } from '../../src/core/logger.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    level: 'info',
    module: 'dispatcher',
    msg: 'test',
    ...overrides,
  };
}

function makeToolEnd(tool: string, durationMs: number, error?: string): LogEntry {
  return makeEntry({
    type: 'tool_end',
    tool,
    duration_ms: durationMs,
    call_id: `${tool}:abc`,
    ...(error ? { error, level: 'error' } : {}),
  });
}

describe('Aggregator', () => {
  let agg: Aggregator;

  beforeEach(() => {
    agg = new Aggregator();
  });

  it('should count total calls from tool_end entries', () => {
    agg.process(makeToolEnd('read_scene', 120));
    agg.process(makeToolEnd('execute_gdscript', 2000));
    agg.process(makeToolEnd('read_scene', 80));
    const state = agg.getState();
    expect(state.totalCalls).toBe(3);
  });

  it('should count errors from tool_end entries with error field', () => {
    agg.process(makeToolEnd('read_scene', 50));
    agg.process(makeToolEnd('edit_script', 100, 'timeout'));
    agg.process(makeToolEnd('save_scene', 200, 'write_error'));
    const state = agg.getState();
    expect(state.totalErrors).toBe(2);
  });

  it('should compute per-tool statistics', () => {
    agg.process(makeToolEnd('read_scene', 100));
    agg.process(makeToolEnd('read_scene', 200));
    agg.process(makeToolEnd('execute_gdscript', 3000));
    const stats = agg.getState().toolStats;
    expect(stats.get('read_scene')!.calls).toBe(2);
    expect(stats.get('read_scene')!.totalDurationMs).toBe(300);
    expect(stats.get('read_scene')!.minDurationMs).toBe(100);
    expect(stats.get('read_scene')!.maxDurationMs).toBe(200);
    expect(stats.get('execute_gdscript')!.calls).toBe(1);
  });

  it('should maintain recentLogs ring buffer (capacity 500)', () => {
    for (let i = 0; i < 600; i++) {
      agg.process(makeEntry({ msg: `log ${i}` }));
    }
    const state = agg.getState();
    expect(state.recentLogs.length).toBe(500);
    const logs = state.recentLogs.toArray();
    expect(logs[0].msg).toBe('log 100');
    expect(logs[499].msg).toBe('log 599');
  });

  it('should build time series buckets from tool_end entries', () => {
    agg.process(makeToolEnd('read_scene', 100));
    const state = agg.getState();
    expect(state.timeSeries.length).toBe(1);
    expect(state.timeSeries[0].calls).toBe(1);
    expect(state.timeSeries[0].totalDurationMs).toBe(100);
  });

  it('should detect mode from first log entry', () => {
    agg.process(makeEntry({ msg: 'Editor mode connected', module: 'godot-mcp' }));
    expect(agg.getState().mode).toBe('editor');
  });

  it('should detect headless mode', () => {
    agg.process(makeEntry({ msg: 'Headless mode starting', module: 'godot-mcp' }));
    expect(agg.getState().mode).toBe('headless');
  });

  it('should default mode to unknown', () => {
    agg.process(makeEntry({ msg: 'something', module: 'dispatcher' }));
    expect(agg.getState().mode).toBe('unknown');
  });

  it('should extract project path from tool_start entries', () => {
    // Task 3 死逻辑修复:projectPath 读 entry.project(Task 1 起 logger 写入),
    // 原 meta.project_path 从不出现(logger.toolStart 的 meta 只有 arg_keys)属恒 miss 死逻辑。
    agg.process(makeEntry({
      type: 'tool_start',
      tool: 'read_scene',
      call_id: 'read_scene:abc',
      project: 'D:/game',
    }));
    const state = agg.getState();
    expect(state.projectPath).toBe('D:/game');
  });

  it('should keep projectPath empty when no tool_start with project_path', () => {
    agg.process(makeToolEnd('read_scene', 100));
    expect(agg.getState().projectPath).toBe('');
  });

  it('should return top N tools sorted by call count', () => {
    for (let i = 0; i < 5; i++) agg.process(makeToolEnd('read_scene', 100));
    for (let i = 0; i < 3; i++) agg.process(makeToolEnd('execute_gdscript', 200));
    agg.process(makeToolEnd('edit_script', 50));
    const top = agg.getTopTools(2);
    expect(top).toHaveLength(2);
    expect(top[0].tool).toBe('read_scene');
    expect(top[0].calls).toBe(5);
    expect(top[1].tool).toBe('execute_gdscript');
    expect(top[1].calls).toBe(3);
  });

  it('should limit timeSeries to 30 buckets using RingBuffer overflow', () => {
    // 创建 35 个不同分钟的 tool_end
    const baseTime = Date.now();
    for (let i = 0; i < 35; i++) {
      const ts = new Date(baseTime + i * 60000).toISOString();
      agg.process(makeEntry({
        type: 'tool_end',
        tool: 'test_tool',
        duration_ms: 100,
        call_id: `test_tool:m${i}`,
        ts,
      }));
    }
    const state = agg.getState();
    expect(state.timeSeries.length).toBeLessThanOrEqual(30);
  });
});
