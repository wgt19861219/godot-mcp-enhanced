import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
  // 易用性批4:默认返回受支持版本,个别用例用 mockResolvedValueOnce 覆盖
  detectGodotVersion: vi.fn().mockResolvedValue('4.7.2.stable'),
  // 反馈批次 C1 (2026-11-12):2.7b godot-paths.json 可见性——mock 隔离,
  // 默认空(本机 ~/.godot-mcp/godot-paths.json 真实存在且非空,勿漏进断言)
  readGodotPathsConfig: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(true); this.isConfigured = vi.fn().mockResolvedValue(true);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/gemini-cli.js', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Gemini CLI'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/qwen-code.js', () => ({
  QwenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Qwen Code'; this.scope = 'project'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/claude-desktop.js', () => ({
  ClaudeDesktopAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Desktop'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/windsurf.js', () => ({
  WindsurfAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Windsurf'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cline.js', () => ({
  ClineAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cline'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/zed.js', () => ({
  ZedAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Zed'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/antigravity.js', () => ({
  AntigravityAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Antigravity'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

// 内存治理 mock(一期 Task 5 两行 → 二期 Task 5 面板行)——不 mock 会真起 PowerShell
// 采样 + 读真实 ~/.godot-mcp/memory-leases.json(测试隔离纪律)。二期起 doctor 5.8 段
// 整体消费 buildMemoryPanel 共享单源(doctor/get_context 两处防漂移),mock 面收敛为
// 单函数注入;默认面板 = disabled 健康态,个别用例 mockReturnValueOnce 覆盖。
const memguardDoctor = vi.hoisted(() => ({
  panel: vi.fn(() => ({
    guard: false,
    watermarkMB: 3072,
    pressure: { state: 'normal' as const, enteredAt: null },
    machine: {
      freePhysBytes: 8 * 1024 ** 3, totalPhysBytes: 16 * 1024 ** 3,
      commitAvailBytes: 10 * 1024 ** 3, commitTotalBytes: 20 * 1024 ** 3,
      godotProcCount: 2, sampledAt: 0,
    },
    budget: { pct: 67, budgetMB: 10922, usedMB: 0, leaseCount: 0 },
    instances: [] as unknown[],
  })),
}));
vi.mock('../../src/core/memory-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/memory-guard.js')>();
  return {
    ...actual,
    buildMemoryPanel: memguardDoctor.panel,
  };
});

vi.mock('../../src/cli/clients/trae.js', () => ({
  TraeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Trae'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/cherry-studio.js', () => ({
  CherryStudioAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cherry Studio'; this.scope = 'global'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

describe('doctor', () => {
  it('runDoctor completes and reports Node version', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Node.js');
    expect(output).toContain('Godot');
    consoleSpy.mockRestore();
  });

  it('logs client scope (project|global) on each status line', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    expect(logSpy.mock.calls.some(c => /\(project\)/.test(String(c[0] ?? '')))).toBe(true);
    expect(logSpy.mock.calls.some(c => /\(global\)/.test(String(c[0] ?? '')))).toBe(true);
    logSpy.mockRestore();
  });

  // ─── 易用性批4 (2026-09-19):版本检查 / 白名单提示 / 不适用标记 ───

  it('reports supported version 4.5–4.7 as ✓', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('4.6.1.stable');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});  // mock 环境下 Node/Godot 全 ✓ 不 exit,catch 兜底
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot version 4.6.1.stable (supported 4.5–4.7)');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('reports unsupported Godot 3.x as ✗ and exits 1', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('3.5.stable.official');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(runDoctor([])).rejects.toThrow('exit');
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('✗ Godot version 3.5.stable.official unsupported (requires 4.5–4.7)');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('reports Godot > 4.7 as warn (unverified, not error)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockResolvedValueOnce('4.8.1.stable');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('! Godot version 4.8.1.stable > 4.7');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('skips version check gracefully when detectGodotVersion throws', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { detectGodotVersion } = await import('../../src/core/godot-finder.js');
    vi.mocked(detectGodotVersion).mockRejectedValueOnce(new Error('godot path not in whitelist'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot version check skipped');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  // B-7③ (2026-10-03): findGodot 对显式 GODOT_PATH 校验失败带 stage 消息 throw,
  // doctor 须透出具体原因——不再一律显示"set GODOT_PATH"误导已配置的用户。
  it('surfaces findGodot rejection reason (B-7③ stage message) instead of generic hint', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { findGodot } = await import('../../src/core/godot-finder.js');
    vi.mocked(findGodot).mockRejectedValueOnce(new Error('GODOT_PATH is rejected by the GODOT_MCP_ALLOWED_GODOT_PATHS whitelist. Add the executable (or its parent directory) to the whitelist, or unset GODOT_PATH to fall back to auto-discovery.'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('GODOT_MCP_ALLOWED_GODOT_PATHS whitelist');
    expect(output).not.toContain('set GODOT_PATH 或运行');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('warns with config example when ALLOWED_PROJECT_PATHS unset', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const orig = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.ALLOWED_PROJECT_PATHS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await runDoctor([]).catch(() => {});
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('ALLOWED_PROJECT_PATHS not set');
    expect(output).toContain('ALLOWED_PROJECT_PATHS="D:/proj/A;D:/proj/B"');
    if (orig !== undefined) process.env.ALLOWED_PROJECT_PATHS = orig;
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  it('marks not-installed clients and non-project dir with neutral ⊘ instead of ✗', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    // 在非 Godot 目录跑(临时目录),Cursor mock detect=false → ⊘ not installed
    const tempDir = join(tmpdir(), 'doctor-na-' + Math.random().toString(36).slice(2));
    mkdirSync(tempDir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try { await runDoctor([]).catch(() => {}); } finally { process.chdir(originalCwd); rmSync(tempDir, { recursive: true, force: true }); }
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('⊘ Cursor (project): not installed');
    expect(output).toContain('⊘ project.godot not found');
    expect(output).not.toContain('✗ Cursor');
    logSpy.mockRestore(); exitSpy.mockRestore();
  });

  // ─── 反馈批次 C1 (2026-11-12): 2.7b godot-paths.json 接管可见性 ───
  // 三分支:env 非空(json 被忽略提示)/ env 空 json 非空(接管+命中判定)/ 双空(back-compat)。
  // readGodotPathsConfig 全程 mock——本机 ~/.godot-mcp/godot-paths.json 真实存在且非空,
  // 不 mock 会让分支判定依赖开发机状态(测试隔离教训)。

  it('branch ②: env 未设 + json 非空 → godot-paths.json active (N entries) + 发现结果命中 ✓', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { readGodotPathsConfig } = await import('../../src/core/godot-finder.js');
    vi.mocked(readGodotPathsConfig).mockReturnValue(['/usr/bin/godot', '/opt/godot/Godot_v4.exe']);
    const origEnv = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    delete process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('godot-paths.json active (2 entries)');
      expect(output).toContain('✓ discovered Godot is whitelisted by godot-paths.json: /usr/bin/godot');
      expect(output).not.toContain('GODOT_MCP_ALLOWED_GODOT_PATHS not set');
      expect(output).not.toContain('godot-paths.json ignored');
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = origEnv;
      vi.mocked(readGodotPathsConfig).mockReturnValue([]);
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('branch ② miss: 发现结果不在 json → ✗ + 加行示例', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { readGodotPathsConfig } = await import('../../src/core/godot-finder.js');
    vi.mocked(readGodotPathsConfig).mockReturnValue(['/opt/other/Godot_v4.exe', '/opt/other2/Godot_v4.exe']);
    const origEnv = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    delete process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('godot-paths.json active (2 entries)');
      expect(output).toContain('✗ discovered Godot is NOT in godot-paths.json: /usr/bin/godot');
      expect(output).toContain('~/.godot-mcp/godot-paths.json');
      expect(output).toContain('"paths"');
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = origEnv;
      vi.mocked(readGodotPathsConfig).mockReturnValue([]);
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('branch ② + findGodot 抛错: 回落 GODOT_PATH env 值做命中判定(反馈场景)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { findGodot, readGodotPathsConfig } = await import('../../src/core/godot-finder.js');
    vi.mocked(findGodot).mockRejectedValueOnce(new Error('GODOT_PATH is rejected by the GODOT_MCP_ALLOWED_GODOT_PATHS whitelist. Add the executable (or its parent directory) to the whitelist, or unset GODOT_PATH to fall back to auto-discovery.'));
    vi.mocked(readGodotPathsConfig).mockReturnValue(['/opt/godot/Godot_v4.exe', '/opt/godot2/Godot_v4.exe']);
    const origEnv = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    delete process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    const origGodotPath = process.env.GODOT_PATH;
    process.env.GODOT_PATH = '/custom/godot';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('godot-paths.json active (2 entries)');
      expect(output).toContain('✗ discovered Godot is NOT in godot-paths.json: /custom/godot');
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = origEnv;
      if (origGodotPath !== undefined) process.env.GODOT_PATH = origGodotPath; else delete process.env.GODOT_PATH;
      vi.mocked(readGodotPathsConfig).mockReturnValue([]);
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('branch ①: env 已设 + json 非空 → env 优先 + json 被忽略提示', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { readGodotPathsConfig } = await import('../../src/core/godot-finder.js');
    vi.mocked(readGodotPathsConfig).mockReturnValue(['/opt/godot/Godot_v4.exe']);
    const origEnv = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = 'C:/Godot;D:/godot';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('GODOT_MCP_ALLOWED_GODOT_PATHS set (2 path(s))');
      expect(output).toContain('godot-paths.json ignored (env takes precedence)');
      expect(output).not.toContain('godot-paths.json active');
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = origEnv;
      else delete process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
      vi.mocked(readGodotPathsConfig).mockReturnValue([]);
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('branch ③: 双空 → 现 back-compat 文案不变', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const { readGodotPathsConfig } = await import('../../src/core/godot-finder.js');
    vi.mocked(readGodotPathsConfig).mockReturnValue([]);
    const origEnv = process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    delete process.env.GODOT_MCP_ALLOWED_GODOT_PATHS;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('GODOT_MCP_ALLOWED_GODOT_PATHS not set — back-compat 放行');
      expect(output).not.toContain('godot-paths.json active');
      expect(output).not.toContain('godot-paths.json ignored');
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_ALLOWED_GODOT_PATHS = origEnv;
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('handles BOM in mcp-godot.json without throwing', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const tempDir = join(tmpdir(), 'doctor-test-' + Math.random().toString(36).slice(2));
    const godotDir = join(tempDir, '.godot');
    mkdirSync(godotDir, { recursive: true });

    const configPath = join(godotDir, 'mcp-godot.json');
    const BOM = '﻿';
    const configContent = BOM + JSON.stringify({ godot_path: '/custom/godot' });
    writeFileSync(configPath, configContent, 'utf-8');

    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Change to temp dir to test project-level config
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);

      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');

      // Should not throw, and should read the Godot override correctly
      expect(output).toContain('Project Godot override: /custom/godot');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── 内存治理(一期 Task 5 两行 → 二期 Task 5 面板行):doctor 5.8 段消费 buildMemoryPanel ───

  it('附 memory-guard 状态行(disabled)+ 机器快照行 + 面板行(pressure/budget/instances)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      // 第一行:开关 + 预算阈值 + 租约计数 + 水位线(brief 逐字格式)
      expect(output).toContain('memory-guard: disabled (budget 67%, leases 0, watermark 3072MB)');
      // 第二行:机器内存快照(物理/commit/Godot 进程计数)
      expect(output).toMatch(/machine memory: physical 8\.0\/16\.0 GB free \(50% used\), commit avail 10\.0 GB, godot procs 2/);
      // 二期面板行:pressure 状态 / 预算与已占用 / 实例表(空表中性标记)
      expect(output).toContain('memory pressure: normal');
      expect(output).toContain('memory budget: 67% = 10.7 GB, used 0.0 GB (0 leases)');
      expect(output).toContain('memory instances: none');
    } finally {
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('enabled 态 + 租约非空 + 快照降级:状态行切 enabled,快照行 warn 标记带降级原因', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    memguardDoctor.panel.mockReturnValueOnce({
      guard: true,
      watermarkMB: 3072,
      pressure: { state: 'normal', enteredAt: null },
      machine: {
        freePhysBytes: 8 * 1024 ** 3, totalPhysBytes: 16 * 1024 ** 3,
        commitAvailBytes: null, commitTotalBytes: null,
        godotProcCount: 0, sampledAt: 0, degraded: 'non-windows',
      },
      budget: { pct: 67, budgetMB: 10922, usedMB: 4096, leaseCount: 2 },
      instances: [],
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('memory-guard: enabled (budget 67%, leases 2, watermark 3072MB)');
      expect(output).toContain('! machine memory:');
      expect(output).toContain('degraded: non-windows');
      expect(output).toContain('memory budget: 67% = 10.7 GB, used 4.0 GB (2 leases)');
    } finally {
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('pressure 态带进入时长 + 活跃实例表逐行(pid/kind/声明/RSS/最后交互/来源)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const pokeAt = Date.now() - 2 * 60_000; // 2m ago(相对时间展示)
    memguardDoctor.panel.mockReturnValueOnce({
      guard: true,
      watermarkMB: 3072,
      pressure: { state: 'pressure', enteredAt: Date.now() - 4 * 60_000 },
      machine: {
        freePhysBytes: 2 * 1024 ** 3, totalPhysBytes: 16 * 1024 ** 3,
        commitAvailBytes: 3 * 1024 ** 3, commitTotalBytes: 20 * 1024 ** 3,
        godotProcCount: 2, sampledAt: 0,
      },
      budget: { pct: 67, budgetMB: 10922, usedMB: 3584, leaseCount: 1 },
      instances: [
        { pid: 4242, project: 'D:/proj-a', kind: 'game_window', declaredMB: 3072, rssMB: 512, lastPokeAt: pokeAt, source: 'lease' },
        { pid: 9999, project: 'D:/external', kind: null, declaredMB: null, rssMB: null, lastPokeAt: null, source: 'registry' },
      ],
    } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      // pressure 非 normal:附进入时长(4m ago)
      expect(output).toMatch(/memory pressure: pressure \(entered \d+m ago\)/);
      expect(output).toContain('memory instances (2):');
      // 租约行:全字段
      expect(output).toMatch(/pid 4242\s+kind game_window\s+declared 3072MB\s+rss 512MB\s+poked 2m ago\s+project D:\/proj-a\s+\(lease\)/);
      // registry-only 行:kind/声明/rss/poked 无值槽显示 '-'
      expect(output).toMatch(/pid 9999\s+kind -\s+declared -\s+rss -\s+poked -\s+project D:\/external\s+\(registry\)/);
    } finally {
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });

  it('面板聚合抛错 → ⊘ 跳过本段,doctor 后续段照常(诊断命令不中断)', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    memguardDoctor.panel.mockImplementationOnce(() => { throw new Error('panel boom'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    try {
      await runDoctor([]).catch(() => {});
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('memory panel skipped (panel boom)');
      expect(output).toContain('Next steps:');   // 后续段照常输出
    } finally {
      logSpy.mockRestore(); exitSpy.mockRestore();
    }
  });
});

// ─── Addons 同步检查(项目待办 :150) ──

describe('doctor addons sync — compareAddons / listAddonFiles 纯函数', () => {
  /** 造临时 addon 目录结构:root/plugin.gd + root/commands/foo.gd */
  function makeAddon(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }
  }

  it('in sync when upstream and target have identical files', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    const files = { 'plugin.cfg': 'v1', 'plugin.gd': 'extends EditorPlugin', 'commands/foo.gd': 'func bar()' };
    makeAddon(upstream, files);
    makeAddon(target, files);
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(result.missing).toEqual([]);
    expect(result.differing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('reports missing when target lacks files upstream has', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.cfg': 'v1', 'plugin.gd': 'x', 'commands/foo.gd': 'y' });
    makeAddon(target, { 'plugin.cfg': 'v1' });  // 缺 plugin.gd + commands/foo.gd
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(false);
    expect(result.missing).toContain('plugin.gd');
    expect(result.missing).toContain('commands/foo.gd');
    expect(result.missing).not.toContain('plugin.cfg');
    rmSync(base, { recursive: true, force: true });
  });

  it('reports differing when content differs', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.cfg': 'version=1', 'plugin.gd': 'extends EditorPlugin' });
    makeAddon(target, { 'plugin.cfg': 'version=2', 'plugin.gd': 'extends EditorPlugin' });  // plugin.cfg 内容不同
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(false);
    expect(result.differing).toEqual(['plugin.cfg']);  // sorted
    expect(result.missing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it('extra files in target do not break sync (reported but not a failure)', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    makeAddon(upstream, { 'plugin.gd': 'x' });
    makeAddon(target, { 'plugin.gd': 'x', 'custom.gd': 'y' });  // 目标多一个文件
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);  // extra 不影响 inSync
    expect(result.extra).toEqual(['custom.gd']);
    rmSync(base, { recursive: true, force: true });
  });

  it('listAddonFiles skips symlinks (B6 escape prevention)', async () => {
    const { listAddonFiles } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    writeFileSync(join(base, 'real.gd'), 'content', 'utf-8');
    // 造 symlink 指向 base 自身(防逃逸测试);某些平台/CI 不支持 symlink,try-catch 跳过
    try {
      symlinkSync(base, join(base, 'escape-link'));
    } catch {
      rmSync(base, { recursive: true, force: true });
      return;  // 无 symlink 权限(如 Windows 非 admin),跳过本测试
    }
    const files = listAddonFiles(base);
    expect(files.some(f => f.endsWith('real.gd'))).toBe(true);
    expect(files.some(f => f.includes('escape-link'))).toBe(false);  // symlink 跳过
    rmSync(base, { recursive: true, force: true });
  });

  it('treats CRLF vs LF as in sync (审查 Nit #1 行尾归一)', async () => {
    const { compareAddons } = await import('../../src/cli/doctor.js');
    const base = mkdtempSync(join(tmpdir(), 'addon-sync-'));
    const upstream = join(base, 'upstream');
    const target = join(base, 'target');
    // 上游 LF,目标 CRLF(Windows 编辑器写回场景)——内容等价,行尾不同
    makeAddon(upstream, { 'plugin.gd': 'line1\nline2\n' });
    makeAddon(target, { 'plugin.gd': 'line1\r\nline2\r\n' });
    const result = compareAddons(upstream, target);
    expect(result.inSync).toBe(true);  // CRLF 归一后等价,不误报 differing
    expect(result.differing).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('doctor addons sync — 集成检查', () => {
  it('reports OUT OF SYNC when target addon differs from upstream', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    // 用真实上游 addons(本仓库)对比一个造的 stale 目标
    const tempDir = mkdtempSync(join(tmpdir(), 'doctor-sync-'));
    const targetAddon = join(tempDir, 'addons', 'godot_mcp_server');
    // 造一个 stale plugin.cfg(内容与上游不同)
    mkdirSync(targetAddon, { recursive: true });
    writeFileSync(join(targetAddon, 'plugin.cfg'), 'STALE-CONTENT', 'utf-8');
    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);
      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('OUT OF SYNC');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips sync check when project has no addon', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const tempDir = mkdtempSync(join(tmpdir(), 'doctor-noaddon-'));
    try {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      await runDoctor([]);
      process.chdir(originalCwd);
      const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('skip sync check');
      expect(output).not.toContain('OUT OF SYNC');
      consoleSpy.mockRestore();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── 反馈批次 C1 (2026-11-12): godotWhitelistHit 纯函数(与 isGodotPathAllowed 同语义的
// 只读命中判定:realpath 归一 + 本身/子路径匹配,不读 env/json——条目由调用方传入) ──

describe('doctor — godotWhitelistHit 纯函数', () => {
  it('精确匹配(假路径 realpath 失败回落字符串比较)', async () => {
    const { godotWhitelistHit } = await import('../../src/cli/doctor.js');
    expect(godotWhitelistHit('/usr/bin/godot', ['/opt/g', '/usr/bin/godot'])).toBe(true);
  });

  it('条目是父目录 → 子路径命中(可执行文件或其父目录均可登记)', async () => {
    const { godotWhitelistHit } = await import('../../src/cli/doctor.js');
    expect(godotWhitelistHit('/opt/g/godot4.exe', ['/opt/g', '/other'])).toBe(true);
  });

  it('无交集 → 未命中', async () => {
    const { godotWhitelistHit } = await import('../../src/cli/doctor.js');
    expect(godotWhitelistHit('/usr/bin/godot', ['/opt/g', '/other/godot'])).toBe(false);
  });

  it('前缀串非目录边界不误命中(/usr/bin-x 不算 /usr/bin 子路径)', async () => {
    const { godotWhitelistHit } = await import('../../src/cli/doctor.js');
    expect(godotWhitelistHit('/usr/bin-x/godot', ['/usr/bin'])).toBe(false);
  });
});

// ─── Rules distribution 报告行(2026-10-24 可靠性批 P1-4) ──

describe('doctor rules distribution — formatRulesDist 纯函数', () => {
  it('current → ok 标记 + 版本与文件数', async () => {
    const { formatRulesDist } = await import('../../src/cli/doctor.js');
    const r = formatRulesDist({ status: 'current', installed_version: '0.36.1', files: 10 }, '0.36.1');
    expect(r.mark).toBe('ok');
    expect(r.line).toContain('0.36.1');
    expect(r.line).toContain('10');
  });

  it('stale → warn 标记 + 两侧版本 + 修复指引', async () => {
    const { formatRulesDist } = await import('../../src/cli/doctor.js');
    const r = formatRulesDist({ status: 'stale', installed_version: '0.35.0', files: 10 }, '0.36.1');
    expect(r.mark).toBe('warn');
    expect(r.line).toContain('0.35.0');
    expect(r.line).toContain('0.36.1');
    expect(r.line).toContain('rules --paths');
  });

  it('content-drift → warn 标记 + 毒化提示', async () => {
    const { formatRulesDist } = await import('../../src/cli/doctor.js');
    const r = formatRulesDist({ status: 'content-drift', installed_version: '0.36.1', files: 10 }, '0.36.1');
    expect(r.mark).toBe('warn');
    expect(r.line).toContain('CONTENT-DRIFT');
    expect(r.line).toContain('毒化');
  });

  it('missing → na 标记 + 原因(detail 透传)', async () => {
    const { formatRulesDist } = await import('../../src/cli/doctor.js');
    const r = formatRulesDist({ status: 'missing', installed_version: null, files: 0, detail: 'manifest 不存在' }, '0.36.1');
    expect(r.mark).toBe('na');
    expect(r.line).toContain('manifest 不存在');
  });
});
