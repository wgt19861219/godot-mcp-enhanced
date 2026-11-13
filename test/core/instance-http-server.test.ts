// test/core/instance-http-server.test.ts
// 行225 MULTI_INSTANCE 接收端 HTTP server 集成测试（真 http，不 mock）。
// 验证 verifyApiToken 闭环：HMAC 签名验证 + 转发 dispatcher + 安全防御。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock homedir 到临时目录（instance-api-auth 的 secret 文件隔离）
const MOCK_HOME = join(tmpdir(), `mcp-http-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => MOCK_HOME };
});

// Mock dispatcher：只测 HTTP 层验签 + 转发，不跑真工具逻辑。
// vi.mock factory 不能引用外部变量（hoisting），用 vi.hoisted 提升 mockHandleCall。
const { mockHandleCall } = vi.hoisted(() => ({ mockHandleCall: vi.fn() }));
vi.mock('../../src/core/ToolDispatcher.js', () => {
  return {
    ToolDispatcher: class MockDispatcher {
      handleCall = mockHandleCall;
    },
  };
});

import { InstanceHttpServer, resolveForwardTimeoutMs } from '../../src/core/instance-http-server.js';
import { generateApiToken, clearCachedSecret } from '../../src/core/instance-api-auth.js';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { resolve as pathResolve, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'node:url';
import type { ToolDispatcher } from '../../src/core/ToolDispatcher.js';

const TEST_INSTANCE_ID = 'ts-test-12345-abcdef';
const MOCK_REGISTRY = join(MOCK_HOME, '.godot-mcp');

let server: InstanceHttpServer;
let baseUrl: string;
let port: number;

// 找一个空闲端口（避免硬编码，防 CI 并行冲突）
async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:http');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close();
        reject(new Error('cannot find free port'));
      }
    });
    s.on('error', reject);
  });
}

beforeAll(async () => {
  mkdirSync(MOCK_REGISTRY, { recursive: true });
  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = new InstanceHttpServer({
    port,
    instanceId: TEST_INSTANCE_ID,
    dispatcher: { handleCall: mockHandleCall } as unknown as ToolDispatcher,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  try { rmSync(MOCK_HOME, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  mockHandleCall.mockReset();
  clearCachedSecret();
});

afterEach(() => {
  clearCachedSecret();
});

describe('InstanceHttpServer HMAC 闭环', () => {
  it('H1 有效签名 → verifyApiToken 通过 → 转发 dispatcher → 200', async () => {
    mockHandleCall.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    const token = generateApiToken(TEST_INSTANCE_ID);
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'execute', project_path: '/fake' }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.content[0].text).toBe('{"ok":true}');
    // 验证 dispatcher 收到正确的 name + arguments
    expect(mockHandleCall).toHaveBeenCalledOnce();
    const callArg = mockHandleCall.mock.calls[0]![0];
    expect(callArg.params.name).toBe('script');
    expect(callArg.params.arguments.action).toBe('execute');
  });

  it('H2 无 Authorization header → 401', async () => {
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(resp.status).toBe(401);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H3 篡改签名 → 401', async () => {
    // 用正确 instanceId 生成 token，但篡改 hmac 部分
    const token = generateApiToken(TEST_INSTANCE_ID);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.deadbeef`;
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tampered}` },
      body: '{}',
    });
    expect(resp.status).toBe(401);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H4 过期 token（timestamp +120s 超过 60s TTL）→ 401', async () => {
    // 构造过期 token：手动拼 timestamp 在 120s 前
    const { getOrCreateApiSecret } = await import('../../src/core/instance-api-auth.js');
    const { createHmac, randomBytes } = await import('node:crypto');
    const secret = getOrCreateApiSecret();
    const oldTs = Date.now() - 120_000; // 120s 前，超过 60s TTL
    const nonce = randomBytes(8).toString('hex');
    const hmac = createHmac('sha256', secret)
      .update(`${TEST_INSTANCE_ID}:${oldTs}:${nonce}`)
      .digest('hex');
    const expiredToken = `${oldTs}.${nonce}.${hmac}`;
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${expiredToken}` },
      body: '{}',
    });
    expect(resp.status).toBe(401);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H5 重放攻击（同一有效 token 第二次）→ 401（nonce 防重放）', async () => {
    mockHandleCall.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
    const token = generateApiToken(TEST_INSTANCE_ID);
    // 第一次：成功
    const resp1 = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    expect(resp1.status).toBe(200);
    // 第二次：同一 token（同 nonce）→ 重放，拒绝
    const resp2 = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    expect(resp2.status).toBe(401);
  });

  it('H6 非法 tool 名（路径注入）→ 400', async () => {
    const token = generateApiToken(TEST_INSTANCE_ID);
    const resp = await fetch(`${baseUrl}/api/..%2Fetc%2fpasswd`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    // decodeURIComponent 后是 ../etc/passwd，不匹配 ^[a-zA-Z_][a-zA-Z0-9_]*$
    expect(resp.status).toBe(400);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H7 GET 方法 → 405', async () => {
    const token = generateApiToken(TEST_INSTANCE_ID);
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(resp.status).toBe(405);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H8 非 /api 路径 → 404', async () => {
    const token = generateApiToken(TEST_INSTANCE_ID);
    const resp = await fetch(`${baseUrl}/foo/bar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    expect(resp.status).toBe(404);
    expect(mockHandleCall).not.toHaveBeenCalled();
  });

  it('H9 dispatcher 抛错 → 500（不泄露内部错误细节）', async () => {
    mockHandleCall.mockRejectedValueOnce(new Error('internal boom'));
    const token = generateApiToken(TEST_INSTANCE_ID);
    const resp = await fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    expect(resp.status).toBe(500);
    const data = await resp.json();
    expect(data.error).toBe('Internal server error.');
    expect(JSON.stringify(data)).not.toContain('internal boom'); // 不泄露内部错误
  });
});

// ── P2-2R/P2-3R/P3-1R（2026-08-11 可靠性加固）──────────────────────────────
// handleCall/readBody 超时（对齐 sender 30s）+ stop() 强制关连接（closeAllConnections）。
// forwardTimeoutMs 注入小值避免等 30s。TimeoutError 类区分超时 vs 其他异常（保 H9 500 语义）。
// 注：P3-1R readBody 超时共享 P2-2R 的 withTimeout 机制（T1 已验证超时→对应状态码），
// 慢 stream 单独测需构造 raw http 慢 chunk（复杂度高收益低），此处用机制共享覆盖。
describe('InstanceHttpServer 可靠性加固 (P2-2R/P2-3R/P3-1R)', () => {
  async function startTimeoutServer(forwardTimeoutMs: number): Promise<{
    server: InstanceHttpServer; baseUrl: string; mock: ReturnType<typeof vi.fn>;
  }> {
    const mock = vi.fn();
    const p = await findFreePort();
    const srv = new InstanceHttpServer({
      port: p,
      instanceId: TEST_INSTANCE_ID,
      dispatcher: { handleCall: mock } as unknown as ToolDispatcher,
      forwardTimeoutMs,
    });
    await srv.start();
    clearCachedSecret();
    return { server: srv, baseUrl: `http://127.0.0.1:${p}`, mock };
  }

  it('P2-2R: handleCall 超时 → 504（与 sender 30s AbortSignal 对称）', async () => {
    const { server, baseUrl, mock } = await startTimeoutServer(200);
    try {
      // mock 返永不 resolve 的 pending（模拟 nav bake 110s 超过 sender 30s）
      mock.mockReturnValueOnce(new Promise(() => { }));
      const token = generateApiToken(TEST_INSTANCE_ID);
      const resp = await fetch(`${baseUrl}/api/script`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: '{}',
      });
      expect(resp.status).toBe(504);
      const data = await resp.json();
      expect(data.error).toMatch(/timed out/i);
    } finally {
      await server.stop();
    }
  }, 10000);

  it('P2-2R: dispatcher 自身异常（非超时）仍走 500（TimeoutError 区分，H9 语义保持）', async () => {
    const { server, baseUrl, mock } = await startTimeoutServer(200);
    try {
      mock.mockRejectedValueOnce(new Error('internal boom'));
      const token = generateApiToken(TEST_INSTANCE_ID);
      const resp = await fetch(`${baseUrl}/api/script`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: '{}',
      });
      expect(resp.status).toBe(500);
      const data = await resp.json();
      expect(data.error).toBe('Internal server error.');
    } finally {
      await server.stop();
    }
  }, 10000);

  it('P2-3R: stop() 强制关连接，不被 in-flight 长请求阻塞（closeAllConnections）', async () => {
    // forwardTimeoutMs 设大（30s），确保 stop 快速完成是靠 closeAllConnections 而非 timeout
    const { server, baseUrl, mock } = await startTimeoutServer(30_000);
    mock.mockReturnValue(new Promise(() => { })); // 永不 resolve
    const token = generateApiToken(TEST_INSTANCE_ID);
    // 发起挂起的请求（不 await，连接 in-flight）
    const fetchPromise = fetch(`${baseUrl}/api/script`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: '{}',
    }).catch((e: unknown) => e);
    // 等请求到达 server
    await vi.waitFor(() => expect(mock).toHaveBeenCalled(), { timeout: 2000 });
    // stop() 应快速完成（closeAllConnections 强制关连接，不等 in-flight 30s timeout）
    const start = Date.now();
    await server.stop();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // 若无 closeAllConnections 会阻塞到 forwardTimeoutMs(30s)
    // fetch 应已断开（连接强制关闭）
    const result = await fetchPromise;
    expect(result).toBeDefined();
  }, 15000);
});

// ── C4: GODOT_MCP_FORWARD_TIMEOUT_MS env 可配（反馈 2026-11-11，30s 硬超时收口）──
// 定谳：多实例转发的 30s 硬编码共三处——sender 两处 AbortSignal.timeout(30000)
// （GodotServer.ts sendToInstance / dynamicSender）+ receiver DEFAULT_FORWARD_TIMEOUT_MS。
// 修复：三处统一改读 GODOT_MCP_FORWARD_TIMEOUT_MS（默认 30000 行为兼容，非法回落 + warn）。
describe('C4: GODOT_MCP_FORWARD_TIMEOUT_MS env 可配', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('env 设 60000 → resolveForwardTimeoutMs()=60000，且构造默认（未注入 forwardTimeoutMs）同步生效', () => {
    vi.stubEnv('GODOT_MCP_FORWARD_TIMEOUT_MS', '60000');
    expect(resolveForwardTimeoutMs()).toBe(60000);
    const srv = new InstanceHttpServer({
      port: 1, // 不 start，仅构造读默认值
      instanceId: TEST_INSTANCE_ID,
      dispatcher: { handleCall: vi.fn() } as unknown as ToolDispatcher,
    });
    expect((srv as unknown as { forwardTimeoutMs: number }).forwardTimeoutMs).toBe(60000);
  });

  it('env 未设 → 默认 30000（行为兼容）', () => {
    vi.stubEnv('GODOT_MCP_FORWARD_TIMEOUT_MS', undefined);
    expect(resolveForwardTimeoutMs()).toBe(30000);
    const srv = new InstanceHttpServer({
      port: 1,
      instanceId: TEST_INSTANCE_ID,
      dispatcher: { handleCall: vi.fn() } as unknown as ToolDispatcher,
    });
    expect((srv as unknown as { forwardTimeoutMs: number }).forwardTimeoutMs).toBe(30000);
  });

  it('env 非法值 → 回落 30000 + console.warn 一行提示', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });
    vi.stubEnv('GODOT_MCP_FORWARD_TIMEOUT_MS', 'not-a-number');
    expect(resolveForwardTimeoutMs()).toBe(30000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0])).toContain('GODOT_MCP_FORWARD_TIMEOUT_MS');
  });

  it('构造显式注入 forwardTimeoutMs 优先于 env（测试注入通道语义不变）', () => {
    vi.stubEnv('GODOT_MCP_FORWARD_TIMEOUT_MS', '60000');
    const srv = new InstanceHttpServer({
      port: 1,
      instanceId: TEST_INSTANCE_ID,
      dispatcher: { handleCall: vi.fn() } as unknown as ToolDispatcher,
      forwardTimeoutMs: 200,
    });
    expect((srv as unknown as { forwardTimeoutMs: number }).forwardTimeoutMs).toBe(200);
  });

  // 源码契约（先例：bridge-idempotency-contract.test.ts）：sender 两处 fetch 超时
  // 不得再出现 30000 硬编码，必须走 resolveForwardTimeoutMs() 派生。
  it('源码契约: GodotServer sender 两处 AbortSignal 无 30000 硬编码，统一走 resolveForwardTimeoutMs', () => {
    const here = pathDirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, '../../src/GodotServer.ts'), 'utf-8');
    expect(src).not.toContain('AbortSignal.timeout(30000)');
    const uses = src.match(/AbortSignal\.timeout\(forwardTimeoutMs\)/g) ?? [];
    expect(uses.length).toBe(2); // sendToInstance + dynamicSender 两处
    expect(src).toContain('resolveForwardTimeoutMs()');
    // receiver 侧 DEFAULT_FORWARD_TIMEOUT_MS 常量本身仍在（resolveForwardTimeoutMs 的回落基准），
    // 但不应再有裸 `?? DEFAULT_FORWARD_TIMEOUT_MS` 之外的第三处独立硬编码 30_000 转发超时。
    expect(src).toContain("import { InstanceHttpServer, resolveForwardTimeoutMs }");
  });
});
