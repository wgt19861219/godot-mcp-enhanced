// 资源导入互斥(2026-10-08 审查 I-1 修复):同项目 `godot --headless --import` 的
// 两个入口——面板「⟳」端点(POST /api/projects/reimport,web-gui/server.ts)与
// runProject 运行前自动按需导入(GodotServer.ts)——共用的模块级互斥锁。
// 修复前的缺口:两端各自「入口内完备」(端点有实例 Set、自动导入裸跑),跨入口并发
// 照样穿透——「点运行→自动导入中→立刻点 ⟳」双向各留数十秒并发窗,恰是 409/互斥
// 设计要防的 Windows `.godot/imported` 文件锁并发写场景。
//
// 语义:
//  - tryAcquireImportLock:非阻塞——锁空闲则持有返回 true,占用返回 false(⟳ 端点用,
//    响应 {started:false, reason:'importing'},不等待)。
//  - acquireImportLock:排队等待——占用则挂起,release 时 FIFO 移交(自动导入用:
//    手动导入进行中点「▶ 运行」→ 排队,轮到后双检 needsImport,他人导入成功已更新
//    mtime 缓存则跳过重复 import,零浪费)。
//  - releaseImportLock:释放并唤醒队首;无等待者则彻底清锁。未持有调释放 = no-op(防御)。
//
// 边界(诚实声明):模块级 = **同进程内**有效;跨进程(daemon 与 stdio 双实例)不在此
// 层防护——与 reimport 端点 409 会话判定同语义(进程内状态),跨进程并发由 runImport
// 自身报错 + integrity gutted 自检兜底。释放责任在调用方(try/finally 或 fire 链的
// 成败双分支);runImport 有 120s 超时必 settle,等待者不会永久挂起。

/** key 在场 = 锁被持有;value = FIFO 等待队列(等待者被 release 唤醒即视为持锁)。 */
const locks = new Map<string, Array<() => void>>();

/** 非阻塞获取:空闲 → 持有并返回 true;占用 → false(不等待)。 */
export function tryAcquireImportLock(key: string): boolean {
  if (locks.has(key)) return false;
  locks.set(key, []);
  return true;
}

/** 排队获取:空闲 → 立即持有;占用 → 挂起,release 时按 FIFO 移交。 */
export async function acquireImportLock(key: string): Promise<void> {
  const waiters = locks.get(key);
  if (waiters === undefined) {
    locks.set(key, []);
    return;
  }
  await new Promise<void>((resolve) => { waiters.push(resolve); });
  // 唤醒 = 锁已移交(调用方此刻持锁,release 责任随之转移)
}

/** 释放:唤醒队首(锁移交,map 保留);无等待者 → 清锁。未持有 → no-op。 */
export function releaseImportLock(key: string): void {
  const waiters = locks.get(key);
  if (waiters === undefined) return;
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  locks.delete(key);
}

/** 查询:key 锁是否被持有(含等待者未清空时的移交中间态恒为持有)。 */
export function isImportLocked(key: string): boolean {
  return locks.has(key);
}

/** 清空全部锁状态——测试隔离专用(对齐 import-check.ts resetImportCache 先例)。 */
export function resetImportLocks(): void {
  locks.clear();
}
