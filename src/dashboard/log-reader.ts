import { EventEmitter } from 'node:events';
import { watch, existsSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { join, resolve, sep, basename, dirname } from 'node:path';
import type { LogEntry } from '../core/logger.js';
import { todayStr } from '../core/logger.js';

export interface LogReaderOptions {
  pollIntervalMs?: number;
}

export interface LogReaderEvents {
  entries: (entries: LogEntry[]) => void;
  error: (err: Error) => void;
}

const DEFAULT_POLL_MS = 2000;
const MAX_INITIAL_LINES = 500;
const INITIAL_READ_CAP = 100 * 1024; // 初始最多读最后 100KB

// CRITICAL-1: rotation 目标文件名白名单 —— 与 logger 产出的 `${today}.jsonl` 格式严格对齐
const ROTATION_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * 解析 rotation 条目指向的目标文件,做范围校验 + 日期白名单。
 *
 * CRITICAL-1: `meta.new_file` 来自磁盘 JSONL 行(任何能写入日志目录的进程均可构造),
 * 必须确保 resolve 后仍落在 logDir **直接子文件**(非子目录、非外部路径),且文件名严格为
 * `YYYY-MM-DD.jsonl`,防止路径遍历/任意文件读取。合法返回 logDir 内的绝对路径;非法返回 null。
 */
export function resolveRotationTarget(logDir: string, newFile: string): string | null {
  if (typeof newFile !== 'string' || newFile.length === 0) return null;
  const dir = resolve(logDir);
  const target = resolve(dir, newFile);
  // 范围校验:target 必须落在 logDir 内(等于 dir 或以 dir + 分隔符为前缀)
  if (target !== dir && !target.startsWith(dir + sep)) return null;
  // 必须是 logDir 的直接子文件(拒绝子目录),且文件名匹配日期白名单
  if (dirname(target) !== dir) return null;
  if (!ROTATION_FILE_RE.test(basename(target))) return null;
  return target;
}

class LogReader extends EventEmitter {
  private logDir: string;
  private pollIntervalMs: number;
  private byteOffset = 0;
  private currentFile = '';
  private skippedCount = 0;
  private pendingTail = '';
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fd: number | null = null;
  private fdPath = '';
  // A-11: 防抖时间戳，避免 fs.watch + setInterval 双重触发时重复 statSync/readSync
  private lastCheckMs = 0;
  private static readonly CHECK_DEBOUNCE_MS = 500;

  constructor(logDir: string, opts: LogReaderOptions = {}) {
    super();
    this.logDir = logDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  async start(): Promise<void> {
    this.currentFile = this.getTodayFile();

    if (existsSync(this.currentFile)) {
      const stat = statSync(this.currentFile);
      // A-03: 大文件只读最后 100KB，避免全量加载
      const startOffset = Math.max(0, stat.size - INITIAL_READ_CAP);
      const result = this.readFromOffset(this.currentFile, startOffset);
      const trimmed = result.entries.slice(-MAX_INITIAL_LINES);
      if (trimmed.length > 0) {
        this.emit('entries', trimmed);
      }
      // 初始加载后从文件末尾开始增量读取
      this.byteOffset = stat.size;
      this.pendingTail = '';
    }

    this.startWatch();
    this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      this.fdPath = '';
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.removeAllListeners();
  }

  getSkippedCount(): number {
    return this.skippedCount;
  }

  getCurrentFile(): string {
    return this.currentFile;
  }

  private getTodayFile(): string {
    // 设计 §2.8 时区修复:与 logger 共用同一本地日期函数,消除 UTC/本地错位
    // (原 toISOString() 是 UTC——东八区每日 00:00-08:00 定位到"昨天"文件,面板断流)。
    return join(this.logDir, `${todayStr()}.jsonl`);
  }

  private startWatch(): void {
    try {
      this.watcher = watch(this.logDir, (event, _filename) => {
        if (this.stopped) return;
        if (event === 'rename' || event === 'change') {
          this.checkForNewData();
        }
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.checkForNewData();
    }, this.pollIntervalMs);
  }

  private checkForNewData(): void {
    // A-11: 防抖 — fs.watch 事件和轮询可能同时触发，至少间隔 500ms
    const now = Date.now();
    if (now - this.lastCheckMs < LogReader.CHECK_DEBOUNCE_MS) return;
    this.lastCheckMs = now;

    const todayFile = this.getTodayFile();
    if (todayFile !== this.currentFile) {
      this.currentFile = todayFile;
      this.byteOffset = 0;
      this.pendingTail = ''; // 日期切换时清除旧文件尾部残留
    }

    if (!existsSync(this.currentFile)) return;

    const result = this.readFromOffset(this.currentFile, this.byteOffset);
    if (result.bytesRead > 0) {
      this.byteOffset += result.bytesRead;
    }
    if (result.entries.length > 0) {
      this.emit('entries', result.entries);
    }

    for (const entry of result.entries) {
      if (entry.type === 'rotation' && entry.meta?.new_file) {
        // CRITICAL-1: 范围校验 + 日期白名单,拒绝逃逸 logDir 的 new_file
        const target = resolveRotationTarget(this.logDir, String(entry.meta.new_file));
        if (target && existsSync(target)) {
          this.currentFile = target;
          this.byteOffset = 0;
          // IMPORTANT-3: rotation 也清 pendingTail,与日期切换一致,避免旧文件尾部残留污染新文件
          this.pendingTail = '';
        }
        break;
      }
    }
  }

  /**
   * Get or create a cached file descriptor for the given path.
   * Reopens when the path changes (e.g. date rotation).
   */
  private ensureFd(filePath: string): number {
    if (this.fd !== null && this.fdPath === filePath) return this.fd;
    if (this.fd !== null) closeSync(this.fd);
    this.fd = openSync(filePath, 'r');
    this.fdPath = filePath;
    return this.fd;
  }

  /**
   * 用 readSync + Buffer 从 byteOffset 读取增量内容。
   * I-03: 用 pendingTail 缓冲不完整尾部，防止 UTF-8 多字节截断。
   */
  private readFromOffset(filePath: string, offset: number): { entries: LogEntry[]; bytesRead: number } {
    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) {
        return { entries: [], bytesRead: 0 };
      }

      const readSize = stat.size - offset;
      let buf = Buffer.alloc(readSize);
      const fd = this.ensureFd(filePath);
      let totalBytes = 0;

      try {
        totalBytes = readSync(fd, buf, 0, readSize, offset);
      } catch {
        // fd may be stale (file truncated/rotated) — reopen and retry once
        if (this.fd !== null) { closeSync(this.fd); this.fd = null; this.fdPath = ''; }
        const fd2 = this.ensureFd(filePath);
        // Re-stat after reopen: file may have been truncated/rotated
        const newStat = statSync(filePath);
        if (newStat.size <= offset) {
          return { entries: [], bytesRead: 0 };
        }
        // I-COR-02: Assign retry buffer to `buf` so downstream code reads the correct data
        const retrySize = Math.min(readSize, newStat.size - offset);
        buf = Buffer.alloc(retrySize);
        totalBytes = readSync(fd2, buf, 0, retrySize, offset);
      }

      if (totalBytes === 0) {
        return { entries: [], bytesRead: 0 };
      }

      // I-03: 拼接上次的尾部不完整行
      const raw = buf.toString('utf-8', 0, totalBytes);
      const content = this.pendingTail + raw;
      this.pendingTail = '';

      // 找到最后一个 \n，其后的内容可能是不完整行
      const lastNl = content.lastIndexOf('\n');
      let completeContent: string;
      if (lastNl >= 0 && lastNl < content.length - 1) {
        this.pendingTail = content.slice(lastNl + 1);
        completeContent = content.slice(0, lastNl);
      } else if (lastNl === content.length - 1) {
        completeContent = content;
      } else {
        // 没有 \n — 全部是不完整行，留到下次
        this.pendingTail = content;
        return { entries: [], bytesRead: totalBytes };
      }

      const lines = completeContent.split('\n').filter(l => l.trim().length > 0);

      const entries: LogEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          this.skippedCount++;
        }
      }

      return { entries, bytesRead: totalBytes };
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return { entries: [], bytesRead: 0 };
    }
  }
}

export { LogReader };
