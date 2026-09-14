import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogReader } from '../../src/dashboard/log-reader.js';
import { todayStr, getLogger, resetLogger, getServerId, type LogEntry } from '../../src/core/logger.js';

describe('LogReader 时区对齐(设计 §2.8:与 logger todayStr 共用同一本地日期)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-tz-')); resetLogger(); });
  afterEach(() => { resetLogger(); rmSync(dir, { recursive: true, force: true }); });

  it('getTodayFile 与 logger 文件命名一致(本地日期,非 UTC)', async () => {
    // 模拟 logger 写今天的本地日期文件(若 LogReader 用 UTC,在本地≠UTC 时刻两者文件名不同)
    mkdirSync(dir, { recursive: true });
    const loggerFile = `${todayStr()}.jsonl`;
    writeFileSync(join(dir, loggerFile), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg: 'x' }) + '\n');
    const reader = new LogReader(dir, { pollIntervalMs: 1000 });
    const got: unknown[] = [];
    reader.on('entries', (es) => got.push(...es));
    await reader.start();
    // 初始回放读到了 logger 今天写的文件 → 定位正确
    expect(got.length).toBe(1);
    reader.stop();
  });

  it('UTC 与本地日期错位窗口(东八区 00:30)仍定位本地今天文件', async () => {
    vi.useFakeTimers();
    // 东八区 2026-01-01 00:30 = UTC 2025-12-31 16:30 —— UTC 日期是"昨天"
    vi.setSystemTime(new Date('2026-01-01T00:30:00+08:00'));
    try {
      mkdirSync(dir, { recursive: true });
      // logger 用本地日期 → 东八区下写 2026-01-01.jsonl
      const localToday = todayStr();  // fake clock 下的本地日期
      writeFileSync(join(dir, `${localToday}.jsonl`),
        JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg: 'tz' }) + '\n');
      const reader = new LogReader(dir, { pollIntervalMs: 1000 });
      const got: unknown[] = [];
      reader.on('entries', (es) => got.push(...es));
      await reader.start();
      expect(got.length).toBe(1);   // UTC 实现下此断言在东八区 fake clock 会失败(定位到 2025-12-31)
      reader.stop();
    } finally { vi.useRealTimers(); }
  });

  it('logger rotation 条目携带 srv(Task 1 review 遗留:rotation 写点锁定)', () => {
    vi.useFakeTimers();
    // 48h 间隔保证任何时区下本地日期必然切换(时区偏移最大 ±14h)
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    try {
      const day1 = todayStr();
      const logger = getLogger({ logDir: dir });
      logger.info('test', 'before rotation');
      logger.flush(); // 建立 fd,currentDate = day1

      vi.setSystemTime(new Date('2026-01-03T12:00:00Z'));
      const day2 = todayStr();
      expect(day2).not.toBe(day1); // 前置:跨天成立,否则 rotation 分支不会触发
      logger.info('test', 'after rotation');
      logger.flush(); // openFd 检测日期变更 → 旧文件写入 rotation 条目并切换新文件

      const lines = readFileSync(join(dir, `${day1}.jsonl`), 'utf-8').trim().split('\n');
      const lastLine = lines.at(-1);
      expect(lastLine).toBeDefined();
      const last = JSON.parse(lastLine as string) as LogEntry;
      expect(last.type).toBe('rotation');
      expect(last.srv).toBe(getServerId());
      // LogReader rotation 跟踪依赖 meta.new_file(Task 7 数据流)——顺带锁定
      expect(last.meta?.new_file).toBe(`${day2}.jsonl`);
    } finally {
      resetLogger();
      vi.useRealTimers();
    }
  });
});
