// test/bridge-auth-proof.test.ts
// 批5-N-1(批4审查挂账): bridge 侧 auth_proof 响应语义收敛——cr-proof 阶段对端回
// result 但 authenticated 非 truthy(空 result/显式 false/异形)立即拒,与 EditorConnection
// 批4-T1 同款语义(此前判定分散在 N-4(auth_begin 措辞)/:567(===false) 两分支,proof
// 阶段空 result 走 N-4 分支消息误导)。
//
// mock 策略:真实 TCP server(net)按 mcp_bridge.gd 协议应答——比纯状态机单测强
// (锁真实 socket 时序),比 e2e 轻(无 Godot 进程)。用例③(happy path)证明 mock 协议
// 正确,①② 的失败才是语义拒绝而非 mock 协议错误。
//
// 批6-N-d(批5审查挂账): listen(0) 动态端口 + secret 文件名跟随 + env
// GODOT_MCP_BRIDGE_PORT_OVERRIDE 显式覆盖端口解析——此前固定 9090 与 e2e editor 测试
// (E2E_EDITOR=1 同绑 9090)仅靠测试门控隔离;动态端口出 scanSecretWindow 固定窗口
// 9081-9090(GD 生产硬约束不为测试扩窗),故走 override 正门。回归锁见
// test/game-bridge-registry.test.ts 'N-d: resolveBridgePort 端口覆盖'。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'bridge-n1-test-secret-0123456789abcdef';
const CHALLENGE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
let PORT = 0;  // beforeAll listen(0) 后回填实际动态端口(secret 文件名与 env 覆盖跟随)

// 每用例可编程的 proof 应答行为
let proofResponder: (msg: { id?: number }) => string;

describe('批5-N-1: bridge auth_proof 响应语义(authenticated !== true 立即拒)', () => {
  let server: Server;
  let tmpProj: string;
  let clientSockets: Socket[];
  let registryDir: string;

  beforeAll(async () => {
    // registry 重定向到空临时目录(防测试机真实实例 registry 干扰;override 覆盖下不读
    // registry,保留作深度防御——未来 override 分支若被重构到 registry 之后仍不读到真实数据)
    registryDir = mkdtempSync(join(tmpdir(), 'gme-n1-reg-'));
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
            sock.write(JSON.stringify({ id: msg.id, result: { challenge: CHALLENGE } }) + '\n');
          } else if (msg.method === 'auth_proof') {
            sock.write(proofResponder(msg) + '\n');
          } else {
            // 业务请求(happy path 用例):任意 method 回 result
            sock.write(JSON.stringify({ id: msg.id, result: { ok: true, data: 'pong' } }) + '\n');
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    // listen(0) 动态端口回填:secret 文件名与端口覆盖 env 跟随实际端口(N-d)
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
    // 临时项目:autoload 预检(project.godot 含 MCPBridge)+ 指定端口 secret 文件
    tmpProj = mkdtempSync(join(tmpdir(), 'gme-n1-proj-'));
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

  it('③ happy path(回归锁): proof 回 authenticated:true → 认证成功且业务请求正常(mock 协议自证)', async () => {
    proofResponder = (msg) => JSON.stringify({ id: msg.id, result: { authenticated: true } });
    const { setBridgeProjectDir, sendToBridge } = await import('../src/core/bridge-client.js');
    setBridgeProjectDir(tmpProj);
    const res = await sendToBridge('ping', {}, 5000);
    expect((res as { result?: { ok?: boolean } }).result?.ok).toBe(true);
  }, 10_000);

  it('① 批5-N-1: proof 回空 result {} → 立即拒(错误明确 auth_proof rejected,不再 auth_begin 措辞/干等)', async () => {
    proofResponder = (msg) => JSON.stringify({ id: msg.id, result: {} });
    const { setBridgeProjectDir, sendToBridge } = await import('../src/core/bridge-client.js');
    setBridgeProjectDir(tmpProj);
    await expect(sendToBridge('ping', {}, 5000))
      .rejects.toThrow(/auth_proof rejected \(authenticated is not true\)/);
  }, 10_000);

  it('② 批5-N-1: proof 回 authenticated:false → 立即拒并标注 secret mismatch', async () => {
    proofResponder = (msg) => JSON.stringify({ id: msg.id, result: { authenticated: false } });
    const { setBridgeProjectDir, sendToBridge } = await import('../src/core/bridge-client.js');
    setBridgeProjectDir(tmpProj);
    await expect(sendToBridge('ping', {}, 5000))
      .rejects.toThrow(/auth_proof rejected \(authenticated is not true: secret mismatch\)/);
  }, 10_000);
});
