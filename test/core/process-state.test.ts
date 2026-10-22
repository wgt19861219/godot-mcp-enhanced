import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';

describe('fullSystemScanGodot filter excludes --editor processes', () => {
  const srcPath = join(__dirname, '../../src/core/orphan-cleanup.ts');
  const src = readFileSync(srcPath, 'utf-8');

  it('PowerShell branch excludes --editor (Windows)', () => {
    // 提取 PowerShell Where-Object 块
    const psBlock = src.match(/Where-Object \{[\s\S]*?CommandLine\.Contains[\s\S]*?\}/s);
    expect(psBlock, 'PowerShell Where-Object block found').toBeTruthy();

    // 反向断言：过滤必须排除 --editor
    expect(psBlock![0]).toMatch(/-not.*\*--editor\*|--editor.*-not/i);
  });

  it('POSIX branch excludes --editor (Linux/macOS)', () => {
    // 提取 POSIX sh 分支 grep 命令
    const shBlock = src.match(/pgrep -f godot[\s\S]*?grep -F/s);
    expect(shBlock, 'POSIX pgrep/grep block found').toBeTruthy();

    // 反向断言：过滤必须排除 --editor
    expect(shBlock![0]).toMatch(/grep.*-v.*--editor|--editor.*exclude/i);
  });
});

// ── M-2(2026-10-22 审查): 超时兜底强杀不被 killed 标志短路,POSIX 升级 SIGKILL ──
describe('M-2 forceKillTree ignoreKilled 升级强杀', () => {
  beforeEach(() => {
    // isWin 在模块加载时固化,改 platform 后须 resetModules 重载
    vi.resetModules();
    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => ({ on: vi.fn() })),
    }));
  });

  const withPlatform = async <T>(platform: string, fn: () => Promise<T>): Promise<T> => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try { return await fn(); } finally {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
  };

  it('killed=true 且无 ignoreKilled → 短路不杀(既有守卫语义保留)', async () => {
    await withPlatform('linux', async () => {
      const { forceKillTree } = await import('../../src/core/process-state.js');
      const kill = vi.fn();
      forceKillTree({ killed: true, pid: 123, kill } as unknown as ChildProcess);
      expect(kill).not.toHaveBeenCalled();
    });
  });

  it('killed=true 且 ignoreKilled:true → POSIX 分支仍发 SIGKILL 升级', async () => {
    await withPlatform('linux', async () => {
      const { forceKillTree } = await import('../../src/core/process-state.js');
      const kill = vi.fn();
      forceKillTree({ killed: true, pid: 123, kill } as unknown as ChildProcess, { ignoreKilled: true });
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  it('killProcess 5s 兜底改走升级路径(源码锚定:ignoreKilled: true)', () => {
    const src = readFileSync(join(__dirname, '../../src/core/process-state.ts'), 'utf-8');
    expect(src).toMatch(/forceKillTree\(proc,\s*\{\s*ignoreKilled:\s*true\s*\}\)/);
  });
});
