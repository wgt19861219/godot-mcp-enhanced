import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock godot-finder(configure 里 findGodot 硬依赖)
vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

// Mock 全部真实 adapter 的副作用实现(detect/isConfigured/configure 可控),
// 保持 ALL_ADAPTERS 注册结构真实(测 findAdapterByName 匹配逻辑)。
vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock('../../src/cli/clients/warp.js', () => ({
  WarpAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Warp';
    this.scope = 'project';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

import { normalizeClientName, findAdapterByName, runConfigure } from '../../src/cli/configure.js';
import { ALL_ADAPTERS } from '../../src/cli/clients/index.js';

describe('configure 命令', () => {
  describe('normalizeClientName', () => {
    it('folds case/space/hyphen/underscore', () => {
      expect(normalizeClientName('Claude Code')).toBe(normalizeClientName('claude-code'));
      expect(normalizeClientName('claude_code')).toBe(normalizeClientName('claudecode'));
      expect(normalizeClientName('WARP')).toBe('warp');
    });
  });

  describe('findAdapterByName', () => {
    it('finds adapter by exact name', () => {
      expect(findAdapterByName('Warp')?.name).toBe('Warp');
    });

    it('finds adapter by kebab-case alias', () => {
      expect(findAdapterByName('claude-code')?.name).toBe('Claude Code');
      expect(findAdapterByName('claude-desktop')?.name).toBe('Claude Desktop');
      expect(findAdapterByName('gemini-cli')?.name).toBe('Gemini CLI');
    });

    it('finds adapter ignoring case', () => {
      expect(findAdapterByName('CLAUDE CODE')?.name).toBe('Claude Code');
    });

    it('returns null for unknown client', () => {
      expect(findAdapterByName('not-a-client')).toBeNull();
    });

    it('every ALL_ADAPTERS entry is reachable by its own name', () => {
      // 反向完整性:每个注册 adapter 都能按自身 name 找到(防注册了但匹配不到)
      for (const a of ALL_ADAPTERS) {
        expect(findAdapterByName(a.name)).toBe(a);
      }
    });
  });

  describe('runConfigure', () => {
    let testDir: string;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'mcp-test-configure-'));
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      vi.spyOn(process, 'cwd').mockReturnValue(testDir);
      // 跨测试清零 mock 调用计数(Once 队列与默认 resolved 值保留);
      // 只清被 mock 的三个 adapter(claude-code/cursor/warp),真实 adapter 方法无 mockClear
      for (const a of ALL_ADAPTERS) {
        for (const m of [a.detect, a.isConfigured, a.configure] as Array<unknown>) {
          if (typeof m === 'function' && 'mockClear' in m) (m as ReturnType<typeof vi.fn>).mockClear();
        }
      }
    });

    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
      exitSpy.mockRestore();
      vi.mocked(process.cwd).mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    });

    it('unknown client exits 1 with available list', async () => {
      await runConfigure(['not-a-client']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown client: not-a-client'));
    });

    it('uninstalled client without --force exits 1 (Warp 默认未装)', async () => {
      await runConfigure(['warp']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not detected'));
    });

    it('uninstalled client with --force configures anyway', async () => {
      await runConfigure(['warp', '--force']);
      expect(exitSpy).not.toHaveBeenCalled();
      const warp = ALL_ADAPTERS.find(a => a.name === 'Warp')!;
      expect(warp.configure).toHaveBeenCalled();
    });

    it('installed+unconfigured client configures (Claude Code mock detect=true)', async () => {
      await runConfigure(['claude-code']);
      expect(exitSpy).not.toHaveBeenCalled();
      const claude = ALL_ADAPTERS.find(a => a.name === 'Claude Code')!;
      expect(claude.configure).toHaveBeenCalledWith(
        testDir, '/usr/bin/godot', expect.any(String), expect.any(Array),
      );
    });

    it('already-configured client skips without --force (幂等)', async () => {
      const claude = ALL_ADAPTERS.find(a => a.name === 'Claude Code')!;
      (claude.isConfigured as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      await runConfigure(['claude-code']);
      expect(claude.configure).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already configured'));
    });

    it('already-configured client rewrites with --force', async () => {
      const claude = ALL_ADAPTERS.find(a => a.name === 'Claude Code')!;
      (claude.isConfigured as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      await runConfigure(['claude-code', '--force']);
      expect(claude.configure).toHaveBeenCalled();
    });

    it('--list lists all clients without configuring', async () => {
      await runConfigure(['--list']);
      expect(exitSpy).not.toHaveBeenCalled();
      for (const a of ALL_ADAPTERS) {
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(a.name));
      }
      const claude = ALL_ADAPTERS.find(a => a.name === 'Claude Code')!;
      expect(claude.configure).not.toHaveBeenCalled();
    });

    it('no args behaves as --list', async () => {
      await runConfigure([]);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Supported clients'));
    });

    it('N-4:project scope 在非 Godot 项目目录警告(不阻断)', async () => {
      // tmpDir 无 project.godot → warn;global scope(Codex)不 warn
      await runConfigure(['claude-code']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('不是 Godot 项目'));
      const claude = ALL_ADAPTERS.find(a => a.name === 'Claude Code')!;
      expect(claude.configure).toHaveBeenCalled(); // 警告不阻断
    });

    it('批4-T9: configure 成功 → machine-audit 落 caller=cli:configure 条目(安全敏感写面留痕)', async () => {
      // FAKE_HOME 隔离 machine-audit 落点(对齐 godot-installer.test.ts N-4 模式)
      const { readFileSync, existsSync } = await import('node:fs');
      const { getMachineAuditFile } = await import('../../src/core/audit-log.js');
      vi.stubEnv('HOME', testDir);
      vi.stubEnv('USERPROFILE', testDir);
      try {
        await runConfigure(['claude-code']);
        expect(exitSpy).not.toHaveBeenCalled();
        // 审计 fire-and-forget,轮询等落盘(最多 ~1s)
        let last = '';
        for (let i = 0; i < 20 && !last; i++) {
          try { last = readFileSync(getMachineAuditFile(), 'utf8').trim().split('\n').at(-1) ?? ''; } catch { /* 尚未落盘 */ }
          if (!last) await new Promise((r) => setTimeout(r, 50));
        }
        expect(last, `machine-audit 应有条目: ${getMachineAuditFile()} exists=${existsSync(getMachineAuditFile())}`).not.toBe('');
        const e = JSON.parse(last) as Record<string, unknown>;
        expect(e.tool).toBe('cli');
        expect(e.action).toBe('configure_client');
        expect(e.caller).toBe('cli:configure');
        expect((e.details as { client?: string })?.client).toBe('Claude Code');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
