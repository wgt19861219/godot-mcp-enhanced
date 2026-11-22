// src/core/session-idle-timer.ts
//
// 内存治理二期 Task 1:会话空闲回收 timer——60s 周期扫描全部会话桶,「距最近 bridge
// 交互超过 idle 分钟数」且非 preview 的存活会话走既有 kill 链回收(Playwright IdleTimer
// 模式:agent 忘了 stop_project 的游戏窗口不再无限挂内存)。
//
// 设计要点:
//  - preview 会话豁免(run_project preview=true 的常驻窗口是用户正在看的,不收);
//  - 空闲锚 = RunSession.lastPokeAt:建桶(spawn)时初始化为当时,bridge 交互
//    (query/input/screenshot,统一漏斗 sendToBridge)成功后 pokeRunSession 刷新——
//    spawn 本身不算交互,0 交互 15min 照收;
//  - 回收 = 树杀(killPidTree,mem-watchdog 同款)+ 清桶(clearRunSession,快照挪移
//    + 状态 exited)+ 按项目路径反查释放 game_window 租约——core 层拿不到 runtime.ts
//    的 sessionKey→leaseId 登记,从租约账本反查;releaseLease 幂等,游戏进程退出时
//    runtime close 回调的释放与本路径双路不冲突;
//  - env GODOT_MCP_SESSION_IDLE_MINUTES 默认 15,0=关(startIdleTimer no-op、扫描直接跳过)。

import {
  clearRunSession,
  getSession,
  isAliveStatus,
  killPidTree,
  listRunSessions,
  normalizeProjectKey,
  releaseRunSessionBusy,
  unregisterSpawnedGodotPid,
} from './process-state.js';
import { listActiveLeases, releaseLease } from './memory-guard.js';

/** 扫描周期(60s)。 */
const SCAN_INTERVAL_MS = 60_000;
/** 默认空闲回收阈值(分钟)。 */
const DEFAULT_IDLE_MINUTES = 15;

/** 空闲阈值分钟数:GODOT_MCP_SESSION_IDLE_MINUTES(整数;负数/非法回默认 15;0=关)。 */
function idleMinutes(): number {
  const raw = Number.parseInt(process.env.GODOT_MCP_SESSION_IDLE_MINUTES ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_MINUTES;
  return raw;
}

/** 按项目 key 反查释放 game_window 租约:runtime close 回调持闭包 leaseId 异步释放,
 *  本路径从账本反查同步释放(不等 close——树杀后 close 可能延迟,验收锚是租约不挂账)。
 *  只匹配 game_window 档(run_project 专用),其他项目/其他档的租约不牵连。 */
function releaseGameWindowLeases(projectKey: string): void {
  for (const l of listActiveLeases()) {
    if (l.kind === 'game_window' && normalizeProjectKey(l.projectPath) === projectKey) {
      releaseLease(l.id);
    }
  }
}

/** 单轮空闲扫描(测试直调;startIdleTimer 周期驱动):枚举全部会话桶,preview 豁免、
 *  非 alive(已结束)跳过、无活进程跳过;空闲严格超阈值的存活会话 → 树杀+清桶+释放
 *  game_window 租约+一行 stderr(MEMGUARD idle-reap,与 watchdog kill 行同通道——
 *  stdout 是 stdio 模式 JSON-RPC 独占通道)。返回 { reaped = 本轮回收数 }。
 *  env=0 → 直接跳过恒零。 */
export function scanIdleSessions(): { reaped: number } {
  const minutes = idleMinutes();
  if (minutes <= 0) return { reaped: 0 };   // env=0 关
  const thresholdMs = minutes * 60_000;
  const now = Date.now();
  let reaped = 0;
  for (const entry of listRunSessions()) {
    const s = getSession(entry.projectPath);
    if (!s || s.preview) continue;                    // preview 会话豁免(用户在看的窗口)
    if (!isAliveStatus(s.status)) continue;           // 已结束桶保留可查,无需回收
    const proc = s.proc;
    if (!proc?.pid || proc.killed || proc.exitCode !== null) continue;   // 无活进程(同 getActiveRunPids 判据)
    const idleMs = now - s.lastPokeAt;
    if (idleMs <= thresholdMs) continue;              // 恰在阈值不收(严格大于)
    // 回收(顺序对齐 runtime autoStop 链):释放 busy → 树杀 → 清桶(快照挪移+状态 exited)
    // → 摘 pid 登记 → 租约反查释放。进程退出时 runtime close 回调守卫(桶内 proc 比对)
    // 因桶已清而跳过重复收尾,其 releaseLease 幂等无冲突。
    releaseRunSessionBusy(entry.projectPath);
    killPidTree(proc.pid);
    clearRunSession(entry.projectPath);
    unregisterSpawnedGodotPid(proc.pid);
    releaseGameWindowLeases(entry.projectPath);
    console.error(`MEMGUARD idle-reap ${proc.pid} idle=${Math.round(idleMs / 1000)}s threshold=${minutes}min project=${entry.displayPath}`);
    reaped++;
  }
  return { reaped };
}

let _timer: ReturnType<typeof setInterval> | null = null;

/** 启动空闲扫描(GodotServer 启动挂载;幂等):60s 周期;env=0 → no-op;timer unref
 *  不阻塞进程退出。timer 模块内自持(同 mem-watchdog startWatchdog 模式)。 */
export function startIdleTimer(): void {
  if (_timer !== null) return;    // 幂等:重复调用不叠加 timer
  if (idleMinutes() <= 0) return; // env=0 关:timer 不启动
  _timer = setInterval(() => { scanIdleSessions(); }, SCAN_INTERVAL_MS);
  _timer.unref?.();
}

/** 停止空闲扫描(GodotServer.close/测试用,幂等)。 */
export function stopIdleTimer(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}
