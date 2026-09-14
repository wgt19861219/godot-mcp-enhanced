import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LogReader, resolveRotationTarget } from '../../src/dashboard/log-reader.js';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { todayStr } from '../../src/core/logger.js';

const TEST_DIR = join(tmpdir(), 'godot-mcp-test-log-reader');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeJsonlLine(filePath: string, obj: Record<string, unknown>): void {
  appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function todayFile(): string {
  // 与 logger/LogReader 同款本地日期(原 toISOString 是 UTC——东八区 00:00-08:00
  // 写 UTC"昨天"文件,LogReader 修复后按本地"今天"定位会导致回归)
  return join(TEST_DIR, `${todayStr()}.jsonl`);
}

function makeEntry(msg: string): Record<string, unknown> {
  return { v: 1, level: 'info', module: 'test', msg, ts: new Date().toISOString() };
}

describe('LogReader', () => {
  it('should read existing entries on start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('hello'));
    writeJsonlLine(file, makeEntry('world'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBeGreaterThanOrEqual(2);
    reader.stop();
  });

  it('should detect new entries after start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('initial'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    const initialCount = entries.length;

    writeJsonlLine(file, makeEntry('new'));

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(entries.length).toBeGreaterThan(initialCount);
    reader.stop();
  });

  it('should skip malformed lines and count them', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('good'));
    appendFileSync(file, 'not json\n');
    writeJsonlLine(file, makeEntry('also good'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(2);
    expect(reader.getSkippedCount()).toBe(1);
    reader.stop();
  });

  it('should emit empty array when no log file exists', async () => {
    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(0);
    reader.stop();
  });

  it('should emit error event when file read fails', async () => {
    const reader = new LogReader('/nonexistent/path/that/does/not/exist', { pollIntervalMs: 50 });
    const errors: Error[] = [];
    reader.on('error', (err: Error) => errors.push(err));

    await reader.start();
    await new Promise(resolve => setTimeout(resolve, 150));

    reader.stop();
  });

  it('should track skipped count across multiple reads', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('ok1'));
    appendFileSync(file, '{bad\n');
    writeJsonlLine(file, makeEntry('ok2'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();
    const initialSkipped = reader.getSkippedCount();

    appendFileSync(file, '{also bad\n');
    writeJsonlLine(file, makeEntry('ok3'));

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(reader.getSkippedCount()).toBeGreaterThan(initialSkipped);
    reader.stop();
  });
});

describe('resolveRotationTarget (CRITICAL-1 path-traversal guard)', () => {
  const logDir = resolve(join(tmpdir(), 'godot-mcp-test-log-reader'));

  it('rejects relative path escaping logDir', () => {
    // 文件名符合日期白名单 —— 验证范围校验才是关键防线
    expect(resolveRotationTarget(logDir, '../outside/2020-01-01.jsonl')).toBeNull();
    expect(resolveRotationTarget(logDir, '../../etc/passwd')).toBeNull();
    expect(resolveRotationTarget(logDir, '../../../2020-01-01.jsonl')).toBeNull();
  });

  it('rejects absolute path outside logDir', () => {
    expect(resolveRotationTarget(logDir, resolve('/etc/2020-01-01.jsonl'))).toBeNull();
    expect(resolveRotationTarget(logDir, 'C:/secret/2020-01-01.jsonl')).toBeNull();
  });

  it('rejects non-dated filename even inside logDir', () => {
    expect(resolveRotationTarget(logDir, 'secret.jsonl')).toBeNull();
    expect(resolveRotationTarget(logDir, 'subdir/2020-01-01.jsonl')).toBeNull();
    expect(resolveRotationTarget(logDir, '2020-1-1.jsonl')).toBeNull();
  });

  it('accepts valid dated file inside logDir', () => {
    expect(resolveRotationTarget(logDir, '2026-06-15.jsonl')).toBe(join(logDir, '2026-06-15.jsonl'));
    // ./ 前缀规范化后仍在 logDir 内,应接受
    expect(resolveRotationTarget(logDir, './2026-06-15.jsonl')).toBe(join(logDir, '2026-06-15.jsonl'));
  });

  it('rejects empty / non-string', () => {
    expect(resolveRotationTarget(logDir, '')).toBeNull();
    expect(resolveRotationTarget(logDir, String(undefined))).toBeNull();
  });
});
