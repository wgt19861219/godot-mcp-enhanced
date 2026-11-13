// src/core/uncaught-cleanup.ts
//
// B1(竞品综述落地批 2026-11-13,方案 docs/plans/2026-11-13-竞品综述落地批方案.md):
// uncaughtException 接入限时清理链。此前 index.ts 的处理器是记 stderr 后裸 exit(1)
// ——server 拉起的 Godot 游戏进程/DAP socket/Web GUI 监听全部变孤儿(对齐竞品
// Erodenn v4 "硬杀自清理"的反面:它异常退出也会收尾)。
//
// 设计要点:
// - 记 stderr 后执行带 5s 硬上限的 best-effort 清理(动作由 index.ts 注入,复用
//   gracefulShutdown 骨架的进程停止步骤 server.close()——内部幂等且逐项 best-effort)
// - 超时或清理抛错都强制 exit(1);清理成功也退 1(uncaught 同步栈已损坏,不可恢复,
//   不学 gracefulShutdown 的 exit(0))
// - 同步栈已损坏,清理调用本身也 try-catch
// - stderr 而非 logger:uncaught 时刻 logger 状态未知,console 与既有处理器同纪律
//   (stderr 不污染 stdio 协议通道 stdout)

/** uncaughtException 后的限时 best-effort 清理预算(硬上限,清理卡死时强制退)。 */
const UNCAUGHT_CLEANUP_BUDGET_MS = 5_000;

// 清理动作注入点(startMcpServer 与 daemon 入口在 server 建立后各自注入,审查 Important-2
// 补 daemon 覆盖;CLI 子命令路径未起 server 不注入——null 时跳过清理直接退,与旧裸 exit(1)
// 行为等价)。
let uncaughtCleanupFn: (() => Promise<void>) | null = null;

/** 注入/撤销 uncaughtException 清理动作。传 null 撤销(测试隔离/热重启)。 */
export function setUncaughtCleanup(fn: (() => Promise<void>) | null): void {
  uncaughtCleanupFn = fn;
}

/** process.on('uncaughtException') 处理器:记 stderr(保留堆栈)后进入限时清理链。 */
export function handleUncaughtException(err: unknown): void {
  console.error('[uncaughtException]', err instanceof Error ? (err.stack ?? err.message) : String(err));
  runUncaughtCleanup(uncaughtCleanupFn);
}

/** 限时清理链核心。导出仅为单测(计时器/退出码语义),生产入口是 handleUncaughtException。
 *  终态恒 process.exit(1):
 *  - cleanup 为 null → 跳过清理直接退(微任务一拍后)
 *  - cleanup 完成(成功 resolve)→ 退 1(uncaught 不可恢复)
 *  - cleanup 抛错(同步 throw 或 rejected promise)→ 退 1
 *  - 超预算(默认 5s)→ 硬上限 timer 强制退 1(timer 不 unref——它是清理卡死时
 *    唯一的强退保证);迟到的清理完成不会二次 exit(process.exit 幂等,防御性 clearTimeout)
 */
export function runUncaughtCleanup(
  cleanup: (() => Promise<void>) | null,
  budgetMs: number = UNCAUGHT_CLEANUP_BUDGET_MS,
): void {
  let settled = false;   // 首个终态(超时/完成/抛错)后不再二次 exit(真实进程首次 exit 即终态,防御性标志)
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => done(), budgetMs);   // done 闭包延迟求值,无 TDZ
  const done = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.exit(1);
  };
  try {
    const p = cleanup ? cleanup() : Promise.resolve();
    p.then(done, done);
  } catch {
    done();
  }
}
