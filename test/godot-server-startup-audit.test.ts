// test/godot-server-startup-audit.test.ts
// 批4-T7(五维评估 P2 抗抵赖): run() 落 machine-audit startup 事件的落盘验证。
//
// 为什么独立文件:godot-server.test.js 的 vi.mock('fs', {...actual, existsSync}) 展开副本
// 使该环境下所有真实 fs/promises 写入静默无副作用(实测连直调 node:fs/promises 的
// appendFile 都 resolve 但零落盘)——无法断言真实文件。本文件只 mock MCP SDK,fs 走真实,
// FAKE_HOME 隔离 machine-audit 落点(对齐 godot-installer.test.ts 的 N-4 模式)。
import { describe, it, expect, vi } from 'vitest';

vi.mock('@modelcontextprotocol/server', () => ({
  Server: vi.fn().mockImplementation(function () {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GodotServer } from '../src/GodotServer.js';
import { getMachineAuditFile } from '../src/core/audit-log.js';

describe('批4-T7: run() 落 machine-audit startup 事件(审计关闭仍留痕)', () => {
  it('GODOT_MCP_AUDIT=false 启动 → startup 条目存在且 details.audit_enabled=false', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'gme-t7home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('GODOT_MCP_AUDIT', 'false');
    process.env.GODOT_MCP_WEB_GUI = '0';  // 跳过 Web GUI 启动(减噪)
    let server: GodotServer | null = null;
    try {
      server = new GodotServer('/fake/ops.gd');
      await server.run();

      expect(existsSync(getMachineAuditFile()), `machine-audit 应存在: ${getMachineAuditFile()}`).toBe(true);
      const lines = readFileSync(getMachineAuditFile(), 'utf8').trim().split('\n');
      const startup = lines.map((l) => JSON.parse(l)).find((e: { action?: string }) => e.action === 'startup');
      expect(startup, 'startup 条目应存在(审计关闭仍留痕——不经 isAuditEnabled 开关)').toBeDefined();
      expect((startup as { tool?: string }).tool).toBe('server');
      expect((startup as { caller?: string }).caller).toBe('mcp-server');
      // 如实记录关闭状态:事后可区分"没操作"与"审计被关"
      expect((startup as { details?: { audit_enabled?: boolean } }).details?.audit_enabled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      delete process.env.GODOT_MCP_WEB_GUI;
      if (server) await server.close().catch(() => undefined);
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 15_000);
});
