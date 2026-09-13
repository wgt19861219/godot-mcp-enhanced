// src/core/orphan-cleanup.ts
//
// Orphan Godot 进程清理(2026-08-14 P2-4 从 process-state.ts 拆出,降内聚)。
// process-state.ts 原 522 行塞 4 职责(进程杀死 / spawned 登记 / busy 锁 / 缓冲+目录),
// orphan 段(~175 行)独立成模块。依赖 process-state 的状态/操作经 OrphanCleanupCtx
// 参数注入(避免 orphan-cleanup → process-state 循环 import);process-state 的
// killOrphanGodotProcesses 改为薄包装,importer 签名不变。

import { spawn } from 'child_process';
import { getLogger } from './logger.js';

const isWin = process.platform === 'win32';
const ORPHAN_SCAN_INTERVAL_MS = 30_000;
const ORPHAN_SCAN_TIMEOUT_MS = 15_000;

// Task 3(设计 §4.4 M-5):节流 per-project 化——key=projectDir 参数(无项目上下文
// 的调用以 '' 计)。旧全局单值会"A 的周期扫描节流 30s 内 B 的 stop_project orphan 分支"。
const _lastOrphanScanAt = new Map<string, number>();

/** Escape single quotes for PowerShell single-quoted strings (' → ''). */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Escape single quotes for POSIX shell single-quoted strings (' → '\''). */
function escapeShellArg(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** orphan 清理依赖的 process-state 状态/操作(参数注入破循环)。
 *  Task 2(设计 §4.4):spawnedPids 归属化 Map(pid → projectKey);排除集合从
 *  runningPid 单值改为 activePids(全部桶内活进程)——多桶并存时周期扫描不误杀非活跃窗口。 */
export interface OrphanCleanupCtx {
  spawnedPids: Map<number, string>;
  activePids: number[];
  isPidAlive: (pid: number) => boolean;
  killPidTree: (pid: number) => void;
}

/** 测试隔离用:重置 per-project 30s 节流表(由 process-state.resetState 调用)。 */
export function resetOrphanScanTime(): void {
  _lastOrphanScanAt.clear();
}

/**
 * 清理本会话 orphan Godot 进程(V-01 第二层,会话隔离版)。状态经 ctx 注入。
 *
 * 默认(第一层):遍历 ctx.spawnedPids,清"脱离 activePids 管理且仍存活"的 PID。
 *   - 跳过 activePids(任一桶正在管理的进程不杀)
 *   - 已退出 PID 惰性移除
 *   - 存活且脱离管理 → killPidTree(双平台清整树)
 *
 * opt-in(第二层,崩溃恢复兜底):options.fullSystemScan === true 且 projectDir 时,
 *   走全系统扫描(清命令行含 projectDir 的所有 Godot,跳过 activePids)。
 *
 * IPC-R1/R5:显式 options 参数,不读 process.env(消除 env 全局状态竞态)。
 * 30s 节流(per-project:按 projectDir 参数分 key,设计 §4.4 M-5——多桶并存时
 * A 的周期扫描不节流 B 的 orphan 清理)。返回清理数。
 */
export async function killOrphanGodotProcesses(
  ctx: OrphanCleanupCtx,
  projectDir?: string,
  options?: { fullSystemScan?: boolean },
): Promise<number> {
  const throttleKey = projectDir ?? '';
  const lastScanAt = _lastOrphanScanAt.get(throttleKey) ?? 0;
  if (Date.now() - lastScanAt < ORPHAN_SCAN_INTERVAL_MS) return 0;
  _lastOrphanScanAt.set(throttleKey, Date.now());

  let killed = 0;

  // 第一层(默认):本会话 PID 集合
  for (const pid of Array.from(ctx.spawnedPids.keys())) {
    if (ctx.activePids.includes(pid)) continue;  // 任一桶正在管理的活进程,跳过(设计 §4.4)
    if (!ctx.isPidAlive(pid)) { ctx.spawnedPids.delete(pid); continue; }  // 已退出,惰性移除
    ctx.killPidTree(pid);
    ctx.spawnedPids.delete(pid);
    killed++;
  }

  // 第二层(opt-in 崩溃恢复兜底,options.fullSystemScan 显式门控)。
  // 周期 orphan 扫描(GodotServer 定时器)和 stop_project 不传此参数,保持会话隔离。
  if (options?.fullSystemScan === true && projectDir) {
    killed += await fullSystemScanGodot(projectDir, ctx.activePids);
  }
  return killed;
}

/**
 * V-01 全系统扫描(仅 fullSystemScan=true 时调用)。
 * 扫描命令行含 projectDir 的 Godot 进程并清理,跳过 excludePids(在管活进程,设计 §4.4)。
 * 保留 escapePsSingleQuote / escapeShellArg 转义(注入防护)。
 */
async function fullSystemScanGodot(projectDir: string, excludePids: number[]): Promise<number> {
  if (!projectDir) return 0;
  const normalizedDir = projectDir.replace(/\\/g, '/');

  if (isWin) {
    const safePath = escapePsSingleQuote(normalizedDir);
    return new Promise((resolve) => {
      let settled = false;
      const ps = spawn('powershell', [
        '-NoProfile', '-Command',
        // I-01 fix: use ('*'+$path+'*') instead of "*$path*" to avoid $ expansion in -like
        // D4 fix: -like treats '['/']'/'*'/'?' as wildcards → path containing them mismatches.
        //         Switch the path test to literal .Contains($path); keep '-like ''*--path*'''
        //         (literal, no wildcard chars). '$_.CommandLine -and' guards null/empty
        //         (-and short-circuits before .Contains so null CommandLine won't throw).
        `$path = '${safePath}'; ` +
        `Get-CimInstance Win32_Process -Filter "Name LIKE 'Godot%'" | ` +
        `Where-Object { $_.CommandLine -and $_.CommandLine -like '*--path*' -and $_.CommandLine.Contains($path) -and -not ($_.CommandLine -like '*--editor*') } | ` +
        `Select-Object -ExpandProperty ProcessId | ForEach-Object { Write-Output $_ }`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      // P2: unref orphan-scan spawn so close() doesn't block Node exit on in-flight scan (15s timeout window).
      // 可选链:测试 mock 的 spawn 返回值无 unref(真实 ChildProcess 有)。
      ps.unref?.();

      // I-03 fix: 15s timeout to prevent hanging on unresponsive WMI/shell
      const timer = setTimeout(() => {
        if (!settled && !ps.killed) {
          settled = true;
          ps.kill();
          resolve(0);
        }
      }, ORPHAN_SCAN_TIMEOUT_MS);

      let out = '';
      let stderr = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      ps.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const pids = out.trim().split('\n').map(Number).filter(n => n > 0 && !excludePids.includes(n));
        for (const pid of pids) {
          try {
            // P1: same async-error guard as forceKillTree — a spawn 'error' without
            // a listener crashes via uncaughtException. best-effort orphan kill.
            const tk = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
            tk.on('error', () => {});
          } catch { /* best effort */ }
        }
        if (stderr) getLogger().debug('orphan-cleanup', `orphan scan stderr: ${stderr.slice(0, 200)}`);
        resolve(pids.length);
      });
      ps.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        getLogger().debug('orphan-cleanup', `orphan scan error: ${err.message}`);
        resolve(0);
      });
    });
  } else {
    // I-02 fix: use single-quoted shell argument with proper escaping
    const safeDir = escapeShellArg(normalizedDir);
    return new Promise((resolve) => {
      let settled = false;
      const ps = spawn('sh', ['-c',
        `pgrep -f godot | xargs -I{} sh -c 'cat /proc/{}/cmdline 2>/dev/null | tr "\\0" " " | grep -v -- "--editor" | grep -F -- '${safeDir}' && echo {}'`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      // P2: unref orphan-scan spawn(同 powershell 分支)。
      ps.unref?.();

      const timer = setTimeout(() => {
        if (!settled && !ps.killed) {
          settled = true;
          ps.kill();
          resolve(0);
        }
      }, ORPHAN_SCAN_TIMEOUT_MS);

      let out = '';
      let stderr = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      ps.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const lines = out.trim().split('\n').filter(l => /^\d+$/.test(l.trim()));
        const pids = lines.map(Number).filter(n => n > 0 && !excludePids.includes(n));
        for (const pid of pids) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* best effort */ }
        }
        if (stderr) getLogger().debug('orphan-cleanup', `orphan scan stderr: ${stderr.slice(0, 200)}`);
        resolve(pids.length);
      });
      ps.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        getLogger().debug('orphan-cleanup', `orphan scan error: ${err.message}`);
        resolve(0);
      });
    });
  }
}
