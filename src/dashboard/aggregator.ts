import type { LogEntry } from '../core/logger.js';
import { RingBuffer } from './ring-buffer.js';

export interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastCalled: string;
}

export interface TimeSeriesBucket {
  minute: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  count: number;
}

export interface DashboardState {
  startTime: string;
  mode: string;
  projectPath: string;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[];
  recentLogs: RingBuffer<LogEntry>;
}

/** per-project 聚合体(Web GUI 设计 §8.1):与全局统计同构的独立累积结构。 */
interface ProjectAggregate {
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeriesBuf: RingBuffer<TimeSeriesBucket>;
  timeSeriesMap: Map<string, TimeSeriesBucket>;
}

const RECENT_LOGS_CAPACITY = 500;
const TIME_SERIES_MAX_BUCKETS = 30;

/** 提取分钟级 key（UTC）。
 *  IMPORTANT-4: 与 entry.ts 的 ts(toISOString,UTC)和 startTime(UTC ISO)统一为 UTC,
 *  避免本地时区导致的桶标签与日志流时间不一致,以及夏令时切换日的桶回跳/重复。 */
function minuteKey(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export class Aggregator {
  private totalCalls = 0;
  private totalErrors = 0;
  private toolStats = new Map<string, ToolStats>();
  private timeSeriesBuf = new RingBuffer<TimeSeriesBucket>(TIME_SERIES_MAX_BUCKETS);
  private timeSeriesMap = new Map<string, TimeSeriesBucket>();
  private recentLogs = new RingBuffer<LogEntry>(RECENT_LOGS_CAPACITY);
  private mode = 'unknown';
  private projectPath = '';
  private startTime = new Date().toISOString();
  private byProject = new Map<string, ProjectAggregate>();

  private projectAggregate(project: string): ProjectAggregate {
    let p = this.byProject.get(project);
    if (!p) {
      p = { totalCalls: 0, totalErrors: 0, toolStats: new Map(),
            timeSeriesBuf: new RingBuffer<TimeSeriesBucket>(TIME_SERIES_MAX_BUCKETS),
            timeSeriesMap: new Map() };
      this.byProject.set(project, p);
    }
    return p;
  }

  /** A-12 幽灵清理同源:桶被 RingBuffer 挤出后 map 仍持引用,后续同 key 条目会并入
   *  幽灵桶(增量不回 buf),读取侧清理时整桶丢失。除 getState/getStateFor 读取侧外,
   *  process 写入侧也前置调用(Task 7 交接注意 c),保证"挤出后再撞同 key"落新桶。
   *  O(30) 开销可忽略;顺带保证 map 规模受 buf 容量约束(无读取时也不无界增长)。 */
  private evictGhostTimeSeries(buf: RingBuffer<TimeSeriesBucket>, map: Map<string, TimeSeriesBucket>): void {
    const activeKeys = new Set(buf.toArray().map(b => b.minute));
    for (const key of map.keys()) {
      if (!activeKeys.has(key)) map.delete(key);
    }
  }

  process(entry: LogEntry): void {
    this.recentLogs.push(entry);

    if (this.mode === 'unknown' && entry.module === 'godot-mcp') {
      const msg = entry.msg.toLowerCase();
      if (msg.includes('editor')) this.mode = 'editor';
      else if (msg.includes('headless')) this.mode = 'headless';
      else if (msg.includes('bridge')) this.mode = 'bridge';
    }

    // 死逻辑修复(Task 3):原读 meta.project_path,但 logger.toolStart 的 meta 只有
    // arg_keys,project_path 从不出现 → 恒 miss。Task 1 起真实路径在 entry.project。
    const projectKey = entry.project && entry.project.length > 0 ? entry.project : 'unknown';
    if (!this.projectPath && projectKey !== 'unknown') {
      this.projectPath = projectKey;
    }

    if (entry.type !== 'tool_end') return;

    this.totalCalls++;
    const tool = entry.tool ?? 'unknown';
    const durationMs = entry.duration_ms ?? 0;
    const isError = !!entry.error;

    if (isError) this.totalErrors++;

    const existing = this.toolStats.get(tool);
    if (existing) {
      existing.calls++;
      existing.errors += isError ? 1 : 0;
      existing.totalDurationMs += durationMs;
      existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.lastCalled = entry.ts;
    } else {
      this.toolStats.set(tool, {
        tool,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        lastCalled: entry.ts,
      });
    }

    const key = minuteKey(entry.ts);
    this.evictGhostTimeSeries(this.timeSeriesBuf, this.timeSeriesMap);
    const existingBucket = this.timeSeriesMap.get(key);
    if (existingBucket) {
      existingBucket.calls++;
      existingBucket.errors += isError ? 1 : 0;
      existingBucket.totalDurationMs += durationMs;
      existingBucket.count++;
    } else {
      const bucket: TimeSeriesBucket = {
        minute: key,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        count: 1,
      };
      this.timeSeriesBuf.push(bucket);
      this.timeSeriesMap.set(key, bucket);
    }

    // ---- per-project 同构统计(追加式;与上方全局统计逻辑同构,不抽公共函数以免重构既有路径)----
    const pa = this.projectAggregate(projectKey);
    pa.totalCalls++;
    if (isError) pa.totalErrors++;

    const existingPStats = pa.toolStats.get(tool);
    if (existingPStats) {
      existingPStats.calls++;
      existingPStats.errors += isError ? 1 : 0;
      existingPStats.totalDurationMs += durationMs;
      existingPStats.minDurationMs = Math.min(existingPStats.minDurationMs, durationMs);
      existingPStats.maxDurationMs = Math.max(existingPStats.maxDurationMs, durationMs);
      existingPStats.lastCalled = entry.ts;
    } else {
      pa.toolStats.set(tool, {
        tool,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        lastCalled: entry.ts,
      });
    }

    const pKey = minuteKey(entry.ts);
    this.evictGhostTimeSeries(pa.timeSeriesBuf, pa.timeSeriesMap);
    const existingPBucket = pa.timeSeriesMap.get(pKey);
    if (existingPBucket) {
      existingPBucket.calls++;
      existingPBucket.errors += isError ? 1 : 0;
      existingPBucket.totalDurationMs += durationMs;
      existingPBucket.count++;
    } else {
      const pBucket: TimeSeriesBucket = {
        minute: pKey,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        count: 1,
      };
      pa.timeSeriesBuf.push(pBucket);
      pa.timeSeriesMap.set(pKey, pBucket);
    }
  }

  getState(): DashboardState {
    // A-12: 每次 getState 都清理幽灵条目（O(30) 开销可忽略）
    // 防止 map 中残留已被 RingBuffer 覆盖的旧 bucket
    this.evictGhostTimeSeries(this.timeSeriesBuf, this.timeSeriesMap);
    return {
      startTime: this.startTime,
      mode: this.mode,
      projectPath: this.projectPath,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      toolStats: this.toolStats,
      timeSeries: this.timeSeriesBuf.toArray(),
      recentLogs: this.recentLogs,
    };
  }

  getProjectKeys(): string[] {
    return [...this.byProject.keys()];
  }

  /** per-project 视图(设计 §8.1):结构与 getState() 同构(含 A-12 幽灵清理)。
   *  recentLogs 共享全局日志流(不按项目复制,省内存)。 */
  getStateFor(project: string): DashboardState {
    const p = this.projectAggregate(project);
    this.evictGhostTimeSeries(p.timeSeriesBuf, p.timeSeriesMap);
    return {
      startTime: this.startTime,
      mode: this.mode,
      projectPath: project === 'unknown' ? '' : project,
      totalCalls: p.totalCalls,
      totalErrors: p.totalErrors,
      toolStats: p.toolStats,
      timeSeries: p.timeSeriesBuf.toArray(),
      recentLogs: this.recentLogs,
    };
  }

  getTopTools(n: number): ToolStats[] {
    return [...this.toolStats.values()]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, n);
  }
}
