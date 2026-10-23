// src/core/inflight.ts — P4-3 (2026-09-11): in-flight 工具调用孤儿记录(BuildersGate 模式)。
//
// 动机(取消经济学):MCP 客户端对"无响应无进度"的调用按 idle 上限杀进程(夜班事故:付费
// 任务扣费成功、文件落盘,agent 什么都没看到还报了 hang)。进程被杀后**下一个 server
// 启动时**读本目录残留文件,报出上个进程死时抓着什么——把"静默损失"变成可诊断事件。
//
// 设计:per-pid 文件 ~/.godot-mcp/inflight-<pid>.json,内容 = 进行中调用数组(≤16,满弃新)。
// 开始登记/结束移除由 ToolDispatcher 的 executeMiddleware 包裹(与 withToolHeartbeat 同点)。
// 报丧走 stderr——stdout 是 MCP transport,绝不能混(BuildersGate 同款约束)。
// 本进程正常退出(GodotServer.close)清自己的文件;异常死亡留文件 → 下个启动报丧。
// 开关:GODOT_MCP_INFLIGHT_LOG=0 关闭(默认开)。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const MAX_ENTRIES = 16;
const FILE_PREFIX = 'inflight-';

interface InflightEntry {
  tool: string;
  since: number;  // epoch ms
}

function inflightDir(): string {
  // env 覆盖(测试注入隔离目录,不写真用户目录)
  return process.env.GODOT_MCP_INFLIGHT_DIR || join(homedir(), '.godot-mcp');
}

function ownFile(): string {
  return join(inflightDir(), `${FILE_PREFIX}${process.pid}.json`);
}

function enabled(): boolean {
  return process.env.GODOT_MCP_INFLIGHT_LOG !== '0';
}

function readOwn(): InflightEntry[] {
  try {
    const raw = readFileSync(ownFile(), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: InflightEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeOwn(entries: InflightEntry[]): void {
  try {
    mkdirSync(inflightDir(), { recursive: true });
    // L-13(2026-10-22 审查):写临时文件 + 原子 rename——裸 writeFileSync 非原子,
    // 进程在写一半被 kill 留半截 JSON → readOwn parse 失败恒返 [] → 本进程后续
    // in-flight 诊断失忆。temp 名含本 pid(同进程同步串行无碰撞,跨进程文件本就独立)。
    const tmp = `${ownFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, entries }), 'utf8');
    renameSync(tmp, ownFile());
  } catch {
    // best-effort:登记失败不影响工具调用(诊断设施不反噬主路径)
  }
}

/** 工具调用开始:登记进行中条目(文件不存在则创建)。 */
export function markInflight(toolName: string): void {
  if (!enabled()) return;
  const entries = readOwn();
  if (entries.length >= MAX_ENTRIES) return;  // 满弃新(诊断粒度,不追全量)
  entries.push({ tool: toolName, since: Date.now() });
  writeOwn(entries);
}

/** 工具调用结束:移除最早的同名条目(串行下即本次;并发同名移除最早者,诊断粒度够用)。 */
export function clearInflight(toolName: string): void {
  if (!enabled()) return;
  const entries = readOwn();
  const idx = entries.findIndex(e => e.tool === toolName);
  if (idx < 0) return;
  entries.splice(idx, 1);
  if (entries.length === 0) {
    try { rmSync(ownFile(), { force: true }); } catch { /* best-effort */ }
  } else {
    writeOwn(entries);
  }
}

/** 本进程全部 in-flight 清除(正常退出路径)。 */
export function clearAllInflight(): void {
  try { rmSync(ownFile(), { force: true }); } catch { /* best-effort */ }
  // L-13: 顺手清原子写的中断残留 tmp(rename 失败路径产物;reportOrphaned 的
  // .endsWith('.json') filter 不会误扫 tmp,此处防长期堆积)
  try { rmSync(`${ownFile()}.${process.pid}.tmp`, { force: true }); } catch { /* best-effort */ }
}

/**
 * 启动时报丧:扫目录里非本 pid 的残留文件 → stderr 一行汇总(死进程死时抓着什么)。
 * 文件 mtime 超 24h 的静默清掉(陈年残留不刷屏)。
 */
export function reportOrphanedInflight(): void {
  if (!enabled()) return;
  const dir = inflightDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.startsWith(FILE_PREFIX) && f.endsWith('.json'));
  } catch {
    return;  // 目录不存在 = 从无记录
  }
  const now = Date.now();
  for (const f of files) {
    const full = join(dir, f);
    try {
      const mtimeMs = statMtime(full);
      if (now - mtimeMs > 24 * 3600 * 1000) {
        rmSync(full, { force: true });
        continue;
      }
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as { pid?: number; entries?: InflightEntry[] };
      if (parsed.pid === process.pid) continue;
      // I-1(审查): 探活再判死——"残留文件 + pid 非我" ≠ 死进程。多 server 并存是多会话
      // 工作流常态(server A 跑长工具时 server B 启动会误报丧+误删 A 的活跃文件)。
      // process.kill(pid, 0): ESRCH=进程不存在(真死,报丧);其他(含 EPERM)=活着,跳过。
      if (parsed.pid !== undefined && isProcessAlive(parsed.pid)) continue;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      if (entries.length === 0) {
        rmSync(full, { force: true });
        continue;
      }
      const summary = entries.map(e => `${e.tool}(开始于 ${Math.round((now - e.since) / 1000)}s 前)`).join(', ');
      // stderr:stdout 是 MCP transport。报丧是诊断信息,绝不能混入协议流。
      process.stderr.write(
        `[godot-mcp] ⚠️ 检测到孤儿 in-flight 记录:上一个 server 进程 (pid ${parsed.pid}) 非正常退出,死亡时仍在执行: ${summary}。文件: ${full}\n`,
      );
      rmSync(full, { force: true });  // 报过即清,防下次启动重复报丧
    } catch {
      // 单文件解析失败跳过(报丧是 best-effort 诊断)
    }
  }
}

/** pid 探活:signal 0 不实际发信号,只测存在性。异常 ESRCH=死,其余(EPERM 等)=活。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function statMtime(full: string): number {
  try {
    return statSync(full).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** 供测试注入目录(默认 ~/.godot-mcp)。 */
export const _test = { inflightDir, ownFile, exists: () => existsSync(ownFile()) };
