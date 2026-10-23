// M-5(2026-10-22 审查第二轮): setup/uninstall 的配置/清理失败必须反映到退出码。
// 原实现 catch 只打印 ✗ 仍以 exit 0 结束,CI/脚本无法区分「已完成」「全部失败」「无可做」。
// mock 出口模块 clients/index.js(ALL_ADAPTERS)而非逐个 mock 15 个适配器源文件——
// 出口收窄后假适配器数组即可驱动两个命令的全部行为面。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const adapters = vi.hoisted(() => ({
  // ok 适配器:全流程成功;bad 适配器:configure/unconfigure 抛错(M-5 触发器)
  ok: {
    name: 'OkClient', scope: 'project' as const,
    detect: () => Promise.resolve(true),
    isConfigured: () => Promise.resolve(false),
    configure: () => Promise.resolve(undefined),
    unconfigure: () => Promise.resolve(true),
  },
  bad: {
    name: 'BadClient', scope: 'project' as const,
    detect: () => Promise.resolve(true),
    isConfigured: () => Promise.resolve(false),
    configure: () => Promise.reject(new Error('mock configure failure')),
    unconfigure: () => Promise.reject(new Error('mock unconfigure failure')),
  },
}));

vi.mock('../../src/cli/clients/index.js', () => ({
  ALL_ADAPTERS: [adapters.ok, adapters.bad],
}));

vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: () => Promise.resolve('D:/godot/Godot_v4.7.2-stable_win64.exe'),
}));

vi.mock('../../src/cli/audit-helper.js', () => ({
  auditClientConfigured: vi.fn(),
  auditClientRemoved: vi.fn(),
  auditCliProjectWrite: vi.fn(),
}));

// InstanceManager mock:无在跑实例(避免真读 ~/.godot-mcp registry)
vi.mock('../../src/core/instance-manager.js', () => ({
  InstanceManager: vi.fn().mockImplementation(function () {
    return {
      loadFromRegistry: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockReturnValue('stale'),
    };
  }),
}));

describe('M-5 setup/uninstall 失败退出码（2026-10-22 审查第二轮）', () => {
  let tmpDir: string;
  const prevExitCode = process.exitCode;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm5-exit-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  it('setup: 任一 adapter.configure 抛错 → process.exitCode = 1', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    await runSetup([]);
    expect(process.exitCode).toBe(1);
  });

  it('setup: 全部成功 → 不设非零退出码', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    // 本文件 mock 出口只有一个 bad;把它临时换成成功实现验证零失败路径
    const bad = adapters.bad;
    const origConfigure = bad.configure;
    bad.configure = () => Promise.resolve(undefined);
    try {
      await runSetup([]);
      expect(process.exitCode).not.toBe(1);
    } finally {
      bad.configure = origConfigure;
    }
  });

  it('uninstall: 任一 adapter.unconfigure 抛错 → process.exitCode = 1', async () => {
    const { runUninstall } = await import('../../src/cli/uninstall.js');
    // --project 指向空临时目录(无 addon/引用 → Phase 2 走「未发现」分支,不弹确认);
    // --yes 跳过 Phase 1 确认门(非 TTY 环境下也是必需的)。
    await runUninstall(['--yes', '--project', tmpDir]);
    expect(process.exitCode).toBe(1);
  });
});
