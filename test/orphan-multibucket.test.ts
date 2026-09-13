import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  killOrphanGodotProcesses,
  resetOrphanScanTime,
  type OrphanCleanupCtx,
} from '../src/core/orphan-cleanup.js';

/**
 * Task 3(设计 §4.4 M-5 + 坑 2):orphan 清理多桶行为锁定。
 * 直接测 orphan-cleanup 层——ctx 注入形态天然可测(killPidTree/isPidAlive 均为
 * vi.fn,无 spawn/taskkill 系统调用);process-state 薄包装的参数透传由
 * test/process-state.test.js 的 killOrphanGodotProcesses describe 覆盖。
 *
 * 行为要点:
 * - 节流 per-project:A 项目周期扫描(GodotServer.ts 30s/60s 定时器)后 30s 内,
 *   B 项目 stop_project 的 orphan 分支(runtime.ts:310)不被全局节流吞掉。
 * - 排除集合 = activePids(全部桶内活进程):多桶并存时 A/B 活 pid 均跳过,
 *   仅 detached pid(曾由该项目 run 出、现已脱离管理)被清。
 */
function makeCtx(
  spawned: Array<[number, string]>,
  activePids: number[],
): { ctx: OrphanCleanupCtx; killPidTree: ReturnType<typeof vi.fn> } {
  const killPidTree = vi.fn();
  const ctx: OrphanCleanupCtx = {
    spawnedPids: new Map(spawned),
    activePids,
    // 测试 pid 一律视为存活——detached 判定只依赖 activePids 排除,不走系统探测
    isPidAlive: (pid: number) => pid > 0,
    killPidTree,
  };
  return { ctx, killPidTree };
}

describe('orphan 清理多桶(Task 3:节流 per-project + 排除集合多桶)', () => {
  beforeEach(() => {
    resetOrphanScanTime();
  });

  it('M-5 节流 per-project:A 项目扫描后 30s 内,B 项目 orphan 分支不被全局节流吞掉', async () => {
    // A 项目周期扫描:清掉 A 桶 detached pid 111,并(旧实现为全局)登记节流时间戳
    const a = makeCtx([[111, '/proj/a']], []);
    const killedA = await killOrphanGodotProcesses(a.ctx, '/proj/a');
    expect(killedA).toBe(1);
    expect(a.killPidTree).toHaveBeenCalledWith(111);

    // 30s 内 B 项目 stop_project 的 orphan 分支:旧全局节流直接 return 0(detached
    // pid 222 泄漏不清);per-project 节流下 B 独立执行,222 被清。
    const b = makeCtx([[222, '/proj/b']], []);
    const killedB = await killOrphanGodotProcesses(b.ctx, '/proj/b');
    expect(killedB).toBe(1);
    expect(b.killPidTree).toHaveBeenCalledWith(222);
  });

  it('M-5 节流锁定:同一项目 30s 内第二次扫描仍被节流(return 0,不执行清理)', async () => {
    const first = makeCtx([[111, '/proj/a']], []);
    await killOrphanGodotProcesses(first.ctx, '/proj/a');

    const second = makeCtx([[333, '/proj/a']], []);
    const killed = await killOrphanGodotProcesses(second.ctx, '/proj/a');
    expect(killed).toBe(0);
    expect(second.killPidTree).not.toHaveBeenCalled();
    expect(second.ctx.spawnedPids.has(333)).toBe(true);  // 未清,注册表保持
  });

  it('M-5 节流无项目上下文(undefined)与显式项目 key 相互独立', async () => {
    // GodotServer 周期扫描在 getProjectDir() 为空时传 undefined('' 桶);
    // stop_project 显式传被停项目的 dir——两者不得互相节流。
    const anon = makeCtx([[111, '']], []);
    const killedAnon = await killOrphanGodotProcesses(anon.ctx, undefined);
    expect(killedAnon).toBe(1);

    const b = makeCtx([[222, '/proj/b']], []);
    const killedB = await killOrphanGodotProcesses(b.ctx, '/proj/b');
    expect(killedB).toBe(1);
  });

  it('排除集合含多桶活进程:A/B 桶活 pid 均跳过,仅 detached pid 被杀(设计 §4.4 坑 2)', async () => {
    const { ctx, killPidTree } = makeCtx(
      [
        [111, '/proj/a'],  // A 桶活进程(activePids 含)
        [222, '/proj/b'],  // B 桶活进程(activePids 含)
        [333, '/proj/b'],  // B 桶 detached(曾由 B run 出、已脱离管理)
      ],
      [111, 222],          // activePids = 全部桶内活进程(getActiveRunPids 形状)
    );
    const killed = await killOrphanGodotProcesses(ctx, '/proj/b');
    expect(killed).toBe(1);                        // 仅 333
    expect(killPidTree).toHaveBeenCalledTimes(1);
    expect(killPidTree).toHaveBeenCalledWith(333);
    expect(ctx.spawnedPids.has(111)).toBe(true);   // 活进程留注册表(不误杀)
    expect(ctx.spawnedPids.has(222)).toBe(true);
    expect(ctx.spawnedPids.has(333)).toBe(false);  // detached 清出注册表
  });
});
