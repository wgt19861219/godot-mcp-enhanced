// B2(竞品综述落地批 2026-11-13): GodotServer 启动接线 sweepStaleBridgeArtifacts 的验证。
// 断言三件事:
// 1. 构造器触发 sweep(reportOrphanedInflight 旁的 fire-and-forget 接线)
// 2. isAlive 注入 process-state.isPidAlive(生产判活通道)
// 3. cleanSecrets 与 GODOT_MCP_STARTUP_CLEANUP feature flag 联动(默认关——secret 清理须显式 opt-in)
// mock 面对齐 godot-server-startup-audit.test.ts(MCP SDK mock + FAKE_HOME 隔离),
// 另拦截 bridge-client.sweepStaleBridgeArtifacts(防 new GodotServer() 扫真实 ~/.godot-mcp)。
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function () {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

// 拦截 sweep 真实现:接线测试只验证调用形态,函数行为由 startup-sweep-bridge-artifacts.test.ts 真测
vi.mock('../src/core/bridge-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sweepStaleBridgeArtifacts: vi.fn(() => ({ removedEntries: 0, secretsCleanedPorts: [] })) };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GodotServer } from '../src/GodotServer.js';
import { sweepStaleBridgeArtifacts } from '../src/core/bridge-client.js';
import { isPidAlive } from '../src/core/process-state.js';

const sweepSpy = vi.mocked(sweepStaleBridgeArtifacts);

afterEach(() => {
  sweepSpy.mockClear();
  vi.unstubAllEnvs();
});

describe('B2: GodotServer 构造器接线 startup sweep', () => {
  it('new GodotServer() → sweep 被调,isAlive=isPidAlive,cleanSecrets 默认 false(flag 关)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'b2-wire-home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('GODOT_MCP_STARTUP_CLEANUP', 'false');
    let server: GodotServer | null = null;
    try {
      server = new GodotServer('/fake/ops.gd');
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      // (registryDir 缺省 = machineRegistryInstancesDir(), isAlive, opts)
      expect(sweepSpy.mock.calls[0]![0]).toBeUndefined();
      expect(sweepSpy.mock.calls[0]![1]).toBe(isPidAlive);
      expect(sweepSpy.mock.calls[0]![2]).toEqual({ cleanSecrets: false });   // 默认关:secret 清理须显式 opt-in
    } finally {
      if (server) await server.close().catch(() => undefined);
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('GODOT_MCP_STARTUP_CLEANUP=true → cleanSecrets: true(flag 透传)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'b2-wire-home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('GODOT_MCP_STARTUP_CLEANUP', 'true');
    let server: GodotServer | null = null;
    try {
      server = new GodotServer('/fake/ops.gd');
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(sweepSpy.mock.calls[0]![2]).toEqual({ cleanSecrets: true });
    } finally {
      if (server) await server.close().catch(() => undefined);
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
