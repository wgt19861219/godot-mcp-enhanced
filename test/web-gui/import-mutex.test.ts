// import-mutex 单测(2026-10-08 审查 I-1 修复):模块级共享锁的三语义
// (tryAcquire 非阻塞 / acquire FIFO 排队 / release 移交)与防御分支。
// resetImportLocks 隔离模块级状态(对齐 import-check.ts resetImportCache 先例)。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireImportLock,
  acquireImportLock,
  releaseImportLock,
  isImportLocked,
  resetImportLocks,
} from '../../src/web-gui/import-mutex.js';

describe('import-mutex(资源重导入共享互斥,审查 I-1 修复)', () => {
  beforeEach(() => { resetImportLocks(); });

  it('tryAcquire:空闲 → true 持有;占用 → false;release 后可再取', () => {
    expect(tryAcquireImportLock('k1')).toBe(true);
    expect(isImportLocked('k1')).toBe(true);
    expect(tryAcquireImportLock('k1')).toBe(false);   // 占用中非阻塞拒绝
    releaseImportLock('k1');
    expect(isImportLocked('k1')).toBe(false);
    expect(tryAcquireImportLock('k1')).toBe(true);    // 释放后可再取
  });

  it('acquire:空闲 → 立即持有(不挂起)', async () => {
    await acquireImportLock('k1');
    expect(isImportLocked('k1')).toBe(true);
  });

  it('acquire 排队:占用时挂起,release 唤醒(FIFO 顺序移交)', async () => {
    tryAcquireImportLock('k1');   // 手动 ⟳ 端点先持有
    const order: number[] = [];
    const w1 = acquireImportLock('k1').then(() => { order.push(1); });
    const w2 = acquireImportLock('k1').then(() => { order.push(2); });
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual([]);        // 两者均挂起
    expect(isImportLocked('k1')).toBe(true);
    releaseImportLock('k1');          // 移交队首(w1)
    await w1;
    expect(order).toEqual([1]);
    expect(isImportLocked('k1')).toBe(true);   // 锁移交中仍持有
    releaseImportLock('k1');          // 移交 w2
    await w2;
    expect(order).toEqual([1, 2]);
    releaseImportLock('k1');          // 无等待者 → 清锁
    expect(isImportLocked('k1')).toBe(false);
  });

  it('不同 key 互不干扰', () => {
    expect(tryAcquireImportLock('a')).toBe(true);
    expect(tryAcquireImportLock('b')).toBe(true);
    releaseImportLock('a');
    expect(isImportLocked('b')).toBe(true);
  });

  it('release 未持有的 key → no-op(不抛不建)', () => {
    expect(() => releaseImportLock('never')).not.toThrow();
    expect(isImportLocked('never')).toBe(false);
  });

  it('runImport 120s 超时语义下的有界等待:release 必然发生(fire 链成败双分支)', async () => {
    // 模拟端点 fire 链:成功/失败两个分支都必须释放锁(有界性靠 runImport 超时必 settle)
    const fire = (fail: boolean): Promise<void> =>
      new Promise((resolve) => {
        void (fail ? Promise.reject(new Error('timeout')) : Promise.resolve(undefined))
          .catch(() => { /* 失败分支同样走 release */ })
          .then(() => { releaseImportLock('k1'); resolve(); });
      });
    tryAcquireImportLock('k1');
    await fire(true);
    expect(isImportLocked('k1')).toBe(false);
    tryAcquireImportLock('k1');
    await fire(false);
    expect(isImportLocked('k1')).toBe(false);
  });
});
