// test/web-gui/aggregator-projects.test.ts
// Task 3(Web GUI 监控面板):Aggregator per-project 统计 + entry.project 死逻辑修复
import { describe, it, expect } from 'vitest';
import { Aggregator } from '../../src/dashboard/aggregator.js';
import type { LogEntry } from '../../src/core/logger.js';

function toolEndEntry(tool: string, project: string | undefined, dur = 10): LogEntry {
  const e: LogEntry = { v: 1, ts: new Date().toISOString(), level: 'info', module: 'dispatcher',
    msg: `Tool call completed: ${tool}`, tool, type: 'tool_end', call_id: `${tool}:1`, duration_ms: dur };
  if (project) e.project = project;
  return e;
}

describe('Aggregator per-project 统计(设计 §8)', () => {
  it('按 entry.project 分组统计;无 project 归 unknown 桶', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('run_project', 'D:/A'));
    agg.process(toolEndEntry('run_project', 'D:/B'));
    agg.process(toolEndEntry('validate_scripts', 'D:/A'));
    agg.process(toolEndEntry('read_script', undefined));

    expect([...agg.getProjectKeys()].sort()).toEqual(['D:/A', 'D:/B', 'unknown']);
    const a = agg.getStateFor('D:/A');
    expect(a.totalCalls).toBe(2);
    expect(a.toolStats.get('run_project')!.calls).toBe(1);
    const b = agg.getStateFor('D:/B');
    expect(b.totalCalls).toBe(1);
    const unk = agg.getStateFor('unknown');
    expect(unk.toolStats.get('read_script')!.calls).toBe(1);
  });

  it('死逻辑修复:projectPath 读 entry.project 而非 meta.project_path', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('run_project', 'D:/real'));
    expect(agg.getState().projectPath).toBe('D:/real');
  });

  it('getState() 结构契约不变(TUI 冻结):键集合与既有字段完全一致', () => {
    const agg = new Aggregator();
    agg.process(toolEndEntry('t', 'p'));
    const s = agg.getState();
    expect(Object.keys(s).sort()).toEqual(
      ['mode', 'projectPath', 'recentLogs', 'startTime', 'timeSeries', 'toolStats', 'totalCalls', 'totalErrors']);
  });

  it('timeSeriesByProject 复刻 A-12 幽灵清理(跨天防撞桶)', () => {
    const agg = new Aggregator();
    const old: LogEntry = { v: 1, ts: '2026-01-01T00:00:00.000Z', level: 'info', module: 'd',
      msg: 'x', tool: 't', type: 'tool_end', call_id: 't:1', duration_ms: 1, project: 'P' };
    agg.process(old);
    // 制造 30+ 个新分钟桶把旧桶挤出 RingBuffer(TIME_SERIES_MAX_BUCKETS=30)
    for (let i = 0; i < 32; i++) {
      agg.process({ ...old, ts: new Date(Date.parse('2026-01-02T00:00:00Z') + i * 61_000).toISOString(), call_id: `t:${i + 2}` });
    }
    const s = agg.getStateFor('P');
    expect(s.timeSeries.length).toBeLessThanOrEqual(30);
    expect(s.timeSeries.every(b => b.minute !== '00:00' || b.calls > 1)).toBe(true);
  });
});
