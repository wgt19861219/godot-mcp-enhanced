// src/core/exit-watchdog.ts
//
// 内存治理二期 Task 4:server 退出 watchdog(Playwright setupExitWatchdog 模式)——
// MCP 客户端死亡/终止信号到来时,本 server spawn 的游戏会话不再孤儿化挂内存。
//
// 退出链三段(语义绑定计划 Review Focus 7):
//  1. 第一次 stdin 'close'/SIGINT/SIGTERM → 优雅回收全部本 server 非 preview 会话:
//     逐桶 markSessionStopping(主动停止语义,退出码非零归 exited 不算 errored)
//     → killProcess(优雅等待版:SIGTERM/taskkill 后等 close,内置 5s 兜底强杀,并行
//     全部桶整体 ~5s)→ 收尾链(清桶/摘 pid 登记/game_window 租约反查释放);
//  2. 优雅期间(10s 有限等待窗口内)再触发 → 立即强杀全部仍存活非 preview 会话
//     (killPidTree 树杀,fire-and-forget)+ exit(0);
//  3. 30s 兜底 exit(0)——优雅回收或既有退出链任一卡死也保证进程退出。
//
// 关键语义:
//  - preview 会话不回收(run_project preview=true 是用户在看的窗口,用户关窗即结束);
//  - 一次触发不主动 exit——退出决策交还既有退出链(index.ts gracefulShutdown:
//    stdin 'end'/SIGINT/SIGTERM → server.close() → exit(0);watchdog 是护航防线,
//    补它的两个缺口:①二次信号原路径直接 exit(1) 不杀游戏进程 → 孤儿;②close 链
//    挂死无兜底 → 进程永挂);
//  - 只管会话桶(本 server spawn 的游戏会话);editor(detached,用户有意长期运行)与
//    headless 短命 spawn 的残留租约不在此链——进程退出后靠一期 90s 陈旧清理线自愈
//    (heartbeatLeases 停续命),绝不杀 editor;
//  - guard=0 不影响:退出回收是生命周期卫生,非 guard 功能(无 memoryGuardEnabled 短路);
//  - 一次性注册:重复调用 setupExitWatchdog 不叠加 handler。
//
// daemon 模式共存性(现场确认结论,2026-11-22 Task 4):
//  - daemon 进程(src/daemon/main.ts runDaemon)走 GodotServer.connectTransport(HTTP
//    transport),不调 run() → 本 watchdog 的 setupExitWatchdog 只挂在 run()(stdio
//    专属路径),daemon 进程内从不注册——stdin 'close' 钩子若进 daemon 会「启动即死」
//    (detached daemon 的 stdio 是 ignore,stdin 立即 end/close,daemon 纪律 spec 第 2 轮
//    m-1,GodotServer.connectTransport 注释同源);
//  - daemon 退出链自持:SIGINT/SIGTERM/SIGBREAK → shutdownDaemon()(gui.stop →
//    server.close 完整清理链(含 killAllRunSessions)→ exit 0;二次触发 exit 1);
//    受控重启(controlled-restart)交接后旧 daemon 走同一 shutdownDaemon。watchdog
//    不在 daemon 进程 → 无双杀、无重复注册。

import type { ChildProcess } from 'child_process';
import {
  clearRunSession,
  getSession,
  isAliveStatus,
  killPidTree,
  killProcess,
  listRunSessions,
  markSessionStopping,
  releaseRunSessionBusy,
  unregisterSpawnedGodotPid,
} from './process-state.js';
import { releaseGameWindowLeases } from './session-idle-timer.js';

/** 优雅回收有限等待窗口(二次触发升级强杀在此窗口内有效;窗口到点仍未收尾则升级树杀)。 */
const GRACE_WINDOW_MS = 10_000;
/** 兜底 exit 上限:优雅回收/既有退出链任一卡死也保证退出。 */
const EXIT_DEADLINE_MS = 30_000;

type ExitPhase = 'idle' | 'graceful' | 'forced';

let _phase: ExitPhase = 'idle';
let _installed = false;
let _exitFn: (code: number) => void = (code) => process.exit(code);
let _graceTimer: ReturnType<typeof setTimeout> | null = null;
let _exitTimer: ReturnType<typeof setTimeout> | null = null;
/** 注册时保存 [emitter, 事件, handler] 三元组,stopExitWatchdog 精确摘除
 *  (removeListener 单个,绝不 removeAllListeners 误伤他人注册的 handler)。 */
let _handlers: Array<[NodeJS.EventEmitter, string, () => void]> | null = null;

/** 回收目标:全部非 preview 存活会话(判据对齐 scanIdleSessions——preview 豁免、
 *  非 alive 跳过、无活进程跳过)。 */
interface ReapTarget {
  projectPath: string;
  displayPath: string;
  pid: number;
  proc: ChildProcess;
}

function collectReapTargets(): ReapTarget[] {
  const out: ReapTarget[] = [];
  for (const entry of listRunSessions()) {
    const s = getSession(entry.projectPath);
    if (!s || s.preview) continue;                    // preview 会话豁免(用户在看的窗口)
    if (!isAliveStatus(s.status)) continue;           // 已结束桶保留可查,无需回收
    const proc = s.proc;
    if (!proc?.pid || proc.killed || proc.exitCode !== null) continue;   // 无活进程(同 getActiveRunPids 判据)
    out.push({ projectPath: entry.projectPath, displayPath: entry.displayPath, pid: proc.pid, proc });
  }
  return out;
}

/** 优雅回收(第一段):逐桶 stopping → kill 链(等 close,5s 内置兜底)→ 收尾。
 *  收尾顺序对齐 scanIdleSessions 完整回收链(IdleTimer 先例);租约释放从账本反查,
 *  与 runtime close 回调双路幂等不冲突。 */
async function gracefulReapSessions(): Promise<void> {
  const targets = collectReapTargets();
  if (targets.length === 0) return;
  for (const t of targets) {
    releaseRunSessionBusy(t.projectPath);
    markSessionStopping(t.projectPath);   // 主动停止语义:被杀退出码非零归 exited 不算 errored
  }
  // 并行优雅等待版 kill:killProcess 每桶内置 5s 兜底强杀,并行整体 ~5s < 10s 窗口
  await Promise.all(targets.map((t) => killProcess(t.proc)));
  for (const t of targets) {
    clearRunSession(t.projectPath);
    unregisterSpawnedGodotPid(t.pid);
    releaseGameWindowLeases(t.projectPath);
    console.error(`MEMGUARD exit-reap ${t.pid} project=${t.displayPath}`);
  }
}

/** 立即强杀全部仍存活非 preview 会话(第二段:二次触发/10s 升级共用)——树杀
 *  fire-and-forget + 同款收尾链(exit 已定,收尾尽力而为不等待)。 */
function forceReapSessions(): number {
  const targets = collectReapTargets();
  for (const t of targets) {
    killPidTree(t.pid);
    clearRunSession(t.projectPath);
    unregisterSpawnedGodotPid(t.pid);
    releaseGameWindowLeases(t.projectPath);
    console.error(`MEMGUARD exit-force-kill ${t.pid} project=${t.displayPath}`);
  }
  return targets.length;
}

/** 触发入口(测试直调;setupExitWatchdog 注册的三个信号源汇聚于此):
 *  idle → 优雅回收 + 10s 窗口 + 30s 兜底;graceful/forced → 立即强杀 + exit(0)。 */
export function handleExitTrigger(signal: string): void {
  if (_phase !== 'idle') {
    // 二次触发(Playwright 二次信号语义):不等优雅段,立即强杀 + 退出
    _phase = 'forced';
    forceReapSessions();
    _exitFn(0);
    return;
  }
  _phase = 'graceful';
  console.error(`MEMGUARD exit-watchdog (${signal}) — graceful reap non-preview sessions`);
  let settled = false;
  void gracefulReapSessions().then(() => {
    settled = true;
    if (_graceTimer) { clearTimeout(_graceTimer); _graceTimer = null; }
  }).catch(() => {
    // 回收链任一环节抛出不得阻兜底退出(best-effort,对齐 startWatchdog pollOnce 兜底先例)
    settled = true;
    if (_graceTimer) { clearTimeout(_graceTimer); _graceTimer = null; }
  });
  // 10s 有限等待:窗口到点仍未收尾(killProcess 5s 兜底理论上先到,此为防御层)
  // → 升级树杀,不再等
  _graceTimer = setTimeout(() => {
    if (!settled) forceReapSessions();
  }, GRACE_WINDOW_MS);
  _graceTimer.unref?.();
  // 30s 兜底:优雅回收/既有退出链任一卡死也保证退出(unref 不阻塞自然退出)
  _exitTimer = setTimeout(() => _exitFn(0), EXIT_DEADLINE_MS);
  _exitTimer.unref?.();
}

/** 一次性注册(幂等):stdin 'close' + SIGINT/SIGTERM → handleExitTrigger。
 *  **注册主点在 src/index.ts,先于 gracefulShutdown 的信号 handler 注册**(审查
 *  Important-1:EventEmitter 注册序=执行序——若 index.ts 的 handler 先注册,二次信号
 *  时其 shuttingDown 分支同步 exit(1),本 watchdog 的二次强杀永无执行机会);run() 内
 *  的调用是幂等二次防线。daemon 走 connectTransport 不经任一注册点,退出链由
 *  daemon/main.ts shutdownDaemon 自持,勿双杀(见文件头共存性结论)。 */
export function setupExitWatchdog(): void {
  if (_installed) return;   // 幂等:重复调用不叠加 handler
  _installed = true;
  const h: Array<[NodeJS.EventEmitter, string, () => void]> = [
    [process.stdin, 'close', () => handleExitTrigger('stdin-close')],
    [process, 'SIGINT', () => handleExitTrigger('SIGINT')],
    [process, 'SIGTERM', () => handleExitTrigger('SIGTERM')],
  ];
  for (const [ee, ev, fn] of h) ee.on(ev, fn);
  _handlers = h;
}

/** 停止 watchdog(测试隔离显式收口用,幂等):精确摘除 handler + 清 timer + 状态复位。
 *  **不进 GodotServer.close() 清理链**(审查 Important-2):close() 正是第一次信号后
 *  gracefulShutdown 启动的链,中途摘除会在「close 挂死」场景(30s 兜底的目标场景)
 *  先行拆除兜底——watchdog 生命周期 = 进程生命周期(stdio 退出链防线,进程 exit 自然
 *  消亡);测试 afterEach 用本函数收口。 */
export function stopExitWatchdog(): void {
  if (_handlers) {
    for (const [ee, ev, fn] of _handlers) ee.removeListener(ev, fn);
    _handlers = null;
  }
  if (_graceTimer) { clearTimeout(_graceTimer); _graceTimer = null; }
  if (_exitTimer) { clearTimeout(_exitTimer); _exitTimer = null; }
  _installed = false;
  _phase = 'idle';
}

/** 测试注入:全量复位 + exit 函数注入(传 null 恢复 process.exit)。 */
export function _resetExitWatchdogForTest(exitFn: ((code: number) => void) | null): void {
  stopExitWatchdog();
  _exitFn = exitFn ?? ((code) => process.exit(code));
}
