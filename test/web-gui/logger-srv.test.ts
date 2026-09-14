import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger, resetLogger, getServerId } from '../../src/core/logger.js';

function tmpLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'webgui-logger-'));
}

describe('logger srv 进程标识(设计 §3.3.1:5 写点全覆盖)', () => {
  let dir: string;
  beforeEach(() => { dir = tmpLogDir(); resetLogger(); });
  afterEach(() => { resetLogger(); rmSync(dir, { recursive: true, force: true }); });

  it('getServerId 进程内稳定且非空', () => {
    const id = getServerId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getServerId()).toBe(id);
  });

  it('普通 log 条目携带 srv', async () => {
    const logger = getLogger({ logDir: dir });
    logger.info('test', 'hello srv');
    logger.flush(); logger.close();
    const files = await import('node:fs').then(m => m.readdirSync(dir));
    const f = files.find(x => x.endsWith('.jsonl'))!;
    const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const entry = lines.find((e: { msg: string }) => e.msg === 'hello srv');
    expect(entry).toBeDefined();
    expect(entry.srv).toBe(getServerId());
  });

  it('toolStart/toolEnd 条目携带 srv', () => {
    const logger = getLogger({ logDir: dir });
    const callId = logger.toolStart('demo_tool', { a: 1 }, 'D:/proj');
    logger.toolEnd(callId, 'demo_tool', 12);
    logger.flush(); logger.close();
    const lines = readFileSync(join(dir, `${todayStrLocal()}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const start = lines.find((e: { type?: string }) => e.type === 'tool_start');
    const end = lines.find((e: { type?: string }) => e.type === 'tool_end');
    expect(start.srv).toBe(getServerId());
    expect(end.srv).toBe(getServerId());
  });

  it('超时 tool_end 条目携带 srv(checkToolTimeouts 直推 buffer 写点)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      const logger = getLogger({ logDir: dir });
      logger.toolStart('slow_tool');
      vi.advanceTimersByTime(61_000);
      logger.flush(); logger.close();
      const lines = readFileSync(join(dir, `${todayStrLocal()}.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const timeout = lines.find((e: { error?: string }) => e.error === 'timeout');
      expect(timeout).toBeDefined();
      expect(timeout.srv).toBe(getServerId());
    } finally { vi.useRealTimers(); }
  });
});

// 与 logger 同款本地日期(TDD 阶段临时复制,断言目标文件名)
function todayStrLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
