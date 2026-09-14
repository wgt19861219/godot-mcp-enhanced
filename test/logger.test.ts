/**
 * Logger 核心模块测试
 *
 * 覆盖：JSONL 写入、stderr 双写、Sanitizer、tool 配对、
 * 原子写入、日志轮转清理、close flush、pendingCount。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogger, resetLogger } from '../src/core/logger.js';

const TEST_LOG_DIR = join(tmpdir(), 'godot-mcp-test-logger');

beforeEach(() => {
  resetLogger();
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  const logger = getLogger();
  logger.close();
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
});

/** 读取当天的 JSONL 文件内容并按行解析 */
function readJsonl(filename?: string): any[] {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const fname = filename ?? `${yyyy}-${mm}-${dd}.jsonl`;
  const content = readFileSync(join(TEST_LOG_DIR, fname), 'utf-8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// 1. 核心写入
// ---------------------------------------------------------------------------

describe('核心写入', () => {
  it('info log 写入 JSONL 文件，解析验证 v/level/module/msg', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('test-mod', 'hello world');
    logger.flush();
    const entries = readJsonl();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const e = entries[entries.length - 1];
    expect(e.v).toBe(1);
    expect(e.level).toBe('info');
    expect(e.module).toBe('test-mod');
    expect(e.msg).toBe('hello world');
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// 2. 所有级别
// ---------------------------------------------------------------------------

describe('所有级别', () => {
  it('debug/info/warn/error 四个级别都写入', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.debug('mod', 'debug msg');
    logger.info('mod', 'info msg');
    logger.warn('mod', 'warn msg');
    logger.error('mod', 'error msg');
    logger.flush();
    const entries = readJsonl();
    const levels = entries.filter(e => e.module === 'mod').map(e => e.level);
    expect(levels).toContain('debug');
    expect(levels).toContain('info');
    expect(levels).toContain('warn');
    expect(levels).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// 3. stderr 双写
// ---------------------------------------------------------------------------

describe('stderr 双写', () => {
  it('info 调用同时写 stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('stderr-mod', 'stderr test');
    logger.flush();
    const calls = spy.mock.calls.map(c => c[0] as string);
    const found = calls.some(c => c.includes('stderr-mod') && c.includes('stderr test'));
    expect(found).toBe(true);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. Sanitizer
// ---------------------------------------------------------------------------

describe('Sanitizer', () => {
  it('长 msg 截断到 ≤200 字符', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const longMsg = 'A'.repeat(300);
    logger.info('san', longMsg);
    logger.flush();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'san');
    expect(e).toBeDefined();
    expect(e.msg.length).toBeLessThanOrEqual(200);
    expect(e.msg).toMatch(/\.\.\.$/);
  });

  it('敏感 key 值替换为 ***', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('san', 'test', { password: 'secret123', apiKey: 'key456', safe: 'visible' });
    logger.flush();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'san' && x.meta);
    expect(e.meta.password).toBe('***');
    expect(e.meta.apiKey).toBe('***');
    expect(e.meta.safe).toBe('visible');
  });

  it('meta 中长 string 值截断', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const longVal = 'B'.repeat(300);
    logger.info('san', 'trunc-meta', { data: longVal });
    logger.flush();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'san' && x.msg === 'trunc-meta');
    expect((e.meta.data as string).length).toBeLessThanOrEqual(200);
  });

  // P2-10: sanitizeMsg 值级脱敏 — 防调用方把 secret 拼进 msg 字符串（当前无活跃泄露但脆弱设计）
  it('msg 中敏感 key=value 值脱敏为 *** (P2-10)', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('san', 'auth failed secret=abc123 token=xyz789 safe=ok');
    logger.flush();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'san' && x.msg.includes('auth failed'));
    expect(e.msg).toContain('secret=***');
    expect(e.msg).toContain('token=***');
    expect(e.msg).toContain('safe=ok');
    expect(e.msg).not.toContain('abc123');
    expect(e.msg).not.toContain('xyz789');
  });

  it('msg 中带冒号+引号的敏感值也脱敏 (P2-10)', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('san', 'loaded key: "deadbeef1234"');
    logger.flush();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'san' && x.msg.startsWith('loaded'));
    expect(e.msg).toContain('key: ***');
    expect(e.msg).not.toContain('deadbeef');
  });
});

// ---------------------------------------------------------------------------
// 5. tool 配对
// ---------------------------------------------------------------------------

describe('tool 配对', () => {
  it('toolStart + toolEnd 正常配对', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('read_scene', { project_path: '/tmp', scene_path: 'main.tscn' });
    expect(callId).toMatch(/^read_scene:[a-z0-9]{8}$/);
    logger.toolEnd(callId, 'read_scene', 120);
    logger.flush();
    const entries = readJsonl();
    const start = entries.find(e => e.type === 'tool_start');
    const end = entries.find(e => e.type === 'tool_end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start.call_id).toBe(callId);
    expect(end.call_id).toBe(callId);
    expect(end.duration_ms).toBe(120);
    expect(end.tool).toBe('read_scene');
    // toolStart args 只记录 key 名列表
    expect(start.meta.arg_keys).toEqual(['project_path', 'scene_path']);
  });

  it('未知 callId → warn 级别日志', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.toolEnd('fake:callid123', 'fake_tool', 50);
    logger.flush();
    const entries = readJsonl();
    const warns = entries.filter(e => e.level === 'warn' && e.msg.includes('Unknown call_id'));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  // ─── §4.6: tool_start/tool_end 条目 project 字段(子项目 2 Web GUI 数据基础) ───

  it('toolStart 第三参 project → tool_start/tool_end 均携带 project 字段', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('run_project', { project_path: '/tmp/a' }, '/tmp/a');
    logger.toolEnd(callId, 'run_project', 80);
    logger.flush();
    const entries = readJsonl();
    const start = entries.find(e => e.type === 'tool_start');
    const end = entries.find(e => e.type === 'tool_end');
    expect(start?.project).toBe('/tmp/a');
    expect(end?.project).toBe('/tmp/a');
  });

  it('未传 project → 不写 project 字段(向后兼容,dashboard 聚合器不破)', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('read_scene', { scene_path: 'main.tscn' });
    logger.toolEnd(callId, 'read_scene', 10);
    logger.flush();
    const entries = readJsonl();
    const start = entries.find(e => e.type === 'tool_start');
    const end = entries.find(e => e.type === 'tool_end');
    expect('project' in start!).toBe(false);
    expect('project' in end!).toBe(false);
  });

  it('60s 超时的 tool_end 也带 project(pendingTools 配对携带)', () => {
    vi.useFakeTimers();
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('slow_tool', { a: 1 }, '/tmp/b');
    vi.advanceTimersByTime(61_000);
    logger.flush();
    const entries = readJsonl();
    const timeoutEntry = entries.find(e => e.type === 'tool_end' && e.error === 'timeout');
    expect(timeoutEntry?.project).toBe('/tmp/b');
    expect(timeoutEntry?.call_id).toBe(callId);
    vi.useRealTimers();
  });

  it('60s 超时 → 自动写 tool_end error: timeout', () => {
    vi.useFakeTimers();
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('slow_tool', { a: 1 });
    // 前进 61 秒
    vi.advanceTimersByTime(61_000);
    // 触发 flush 以检查超时
    logger.flush();
    const entries = readJsonl();
    const timeoutEntry = entries.find(e => e.type === 'tool_end' && e.error === 'timeout');
    expect(timeoutEntry).toBeDefined();
    expect(timeoutEntry.call_id).toBe(callId);
    expect(timeoutEntry.level).toBe('warn');
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 6. 原子写入
// ---------------------------------------------------------------------------

describe('原子写入', () => {
  it('20 条连续写入，每行都能 JSON.parse', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    for (let i = 0; i < 20; i++) {
      logger.info('atomic', `msg-${i}`);
    }
    logger.flush();
    const entries = readJsonl();
    expect(entries.length).toBeGreaterThanOrEqual(20);
    // 每条都有完整的 JSON 字段
    for (const e of entries.filter(e => e.module === 'atomic')) {
      expect(e.v).toBe(1);
      expect(e.level).toBe('info');
      expect(typeof e.ts).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 日志文件名
// ---------------------------------------------------------------------------

describe('日志文件名', () => {
  it('按当天日期命名', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('fname', 'check filename');
    logger.flush();
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const expected = `${yyyy}-${mm}-${dd}.jsonl`;
    const files = readdirSync(TEST_LOG_DIR).filter(f => f.endsWith('.jsonl'));
    expect(files).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// 8. 轮转清理
// ---------------------------------------------------------------------------

describe('轮转清理', () => {
  it('创建 10 个旧文件，maxRetentionDays=7 触发清理后 ≤8 个文件', () => {
    // 先创建 10 个旧日期文件
    const oldDate = new Date();
    for (let i = 10; i >= 1; i--) {
      const d = new Date(oldDate);
      d.setDate(d.getDate() - i - 7); // 超过 7 天
      const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
      writeFileSync(join(TEST_LOG_DIR, name), '{}\n');
    }
    // 再加一个不超过 7 天的
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 3);
    const recentName = `${recentDate.getFullYear()}-${String(recentDate.getMonth() + 1).padStart(2, '0')}-${String(recentDate.getDate()).padStart(2, '0')}.jsonl`;
    writeFileSync(join(TEST_LOG_DIR, recentName), '{}\n');

    // 初始化 Logger 触发清理
    const logger = getLogger({ logDir: TEST_LOG_DIR, maxRetentionDays: 7 });
    logger.info('rotation', 'trigger cleanup');
    logger.flush();

    const remaining = readdirSync(TEST_LOG_DIR).filter(f => f.endsWith('.jsonl'));
    // 今天的文件 + 3天前的文件 = 2 个（旧 10 个被清理）
    expect(remaining.length).toBeLessThanOrEqual(2);
    expect(remaining).toContain(recentName);
  });
});

// ---------------------------------------------------------------------------
// 9. close flush
// ---------------------------------------------------------------------------

describe('close flush', () => {
  it('close() 后缓冲区内容写入文件', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('close-test', 'before close');
    // 不调用 flush()，直接 close
    logger.close();
    const entries = readJsonl();
    const e = entries.find(x => x.module === 'close-test');
    expect(e).toBeDefined();
    expect(e.msg).toBe('before close');
  });
});

// ---------------------------------------------------------------------------
// 10. pendingCount
// ---------------------------------------------------------------------------

describe('pendingCount', () => {
  it('返回缓冲区大小', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = getLogger({ logDir: TEST_LOG_DIR, bufferMs: 10_000, bufferMax: 1000 });
    logger.info('pending', 'msg1');
    logger.info('pending', 'msg2');
    expect(logger.pendingCount()).toBe(2);
    logger.flush();
    expect(logger.pendingCount()).toBe(0);
    (process.stderr.write as ReturnType<typeof vi.spyOn>).mockRestore?.();
  });
});
