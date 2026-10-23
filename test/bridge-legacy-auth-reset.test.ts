// L-11(2026-10-22 审查第二轮): resetBridgeState 必须清 _bridgeLegacyAuth/_bridgeLegacyAuthSince
// ——不清则状态重置(测试隔离/服务重启)后仍按 TTL 内已降级记忆继续明文重试。
// mock 设施对齐 bridge-auth-proof.test.ts(auth_begin 回 JSON-RPC error -32001 → 降级明文)。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'bridge-l11-secret-0123456789abcdef';
let PORT = 0;

describe('L-11 resetBridgeState 清 legacy 明文认证记忆', () => {
  let server: Server;
  let tmpProj: string;
  let clientSockets: Socket[];
  let registryDir: string;

  beforeAll(async () => {
    registryDir = mkdtempSync(join(tmpdir(), 'gme-l11-reg-'));
    vi.stubEnv('GODOT_MCP_BRIDGE_REGISTRY_DIR', registryDir);

    server = createServer();
    server.on('connection', (sock) => {
      clientSockets.push(sock);
      let buf = '';
      sock.on('data', (data) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.substring(0, idx).trim();
          buf = buf.substring(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method === 'auth_begin') {
            // 旧 bridge 形态:JSON-RPC error → TS 侧记忆降级并重连明文
            sock.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'Authentication required' } }) + '\n');
          } else if (msg.method === 'auth') {
            // legacy 明文认证:authenticated truthy 即成功
            sock.write(JSON.stringify({ id: msg.id, result: { authenticated: true } }) + '\n');
          } else {
            sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n');
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    PORT = (server.address() as AddressInfo).port;
    vi.stubEnv('GODOT_MCP_BRIDGE_PORT_OVERRIDE', String(PORT));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(registryDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    clientSockets = [];
    tmpProj = mkdtempSync(join(tmpdir(), 'gme-l11-proj-'));
    mkdirSync(join(tmpProj, '.godot'), { recursive: true });
    writeFileSync(join(tmpProj, 'project.godot'),
      '[autoload]\n\nMCPBridge="*res://addons/mcp_bridge.gd"\n', 'utf-8');
    writeFileSync(join(tmpProj, '.godot', `mcp_bridge_${PORT}.secret`), SECRET, 'utf-8');
  });

  afterEach(async () => {
    const { resetBridgeState, setBridgeProjectDir } = await import('../src/core/bridge-client.js');
    resetBridgeState();
    setBridgeProjectDir(null);
    for (const s of clientSockets) s.destroy();
    rmSync(tmpProj, { recursive: true, force: true });
  });

  it('legacy 降级置位后 resetBridgeState 清零(不再带 TTL 记忆明文重试)', { timeout: 10_000 }, async () => {
    const { setBridgeProjectDir, sendToBridge, resetBridgeState, _testBridgeCacheState } =
      await import('../src/core/bridge-client.js');
    setBridgeProjectDir(tmpProj);
    const res = await sendToBridge('ping', {}, 5000);
    expect((res as { result?: { ok?: boolean } }).result?.ok).toBe(true);
    // 降级路径已走完:legacy 记忆置位
    expect(_testBridgeCacheState().bridgeLegacyAuth).toBe(true);

    // L-11 核心:状态重置后 legacy 记忆归零
    resetBridgeState();
    expect(_testBridgeCacheState().bridgeLegacyAuth).toBe(false);
  });
});
