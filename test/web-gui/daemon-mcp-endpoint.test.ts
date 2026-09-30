// test/web-gui/daemon-mcp-endpoint.test.ts
// daemon 批 A(2026-09-30 spec §3.2/§3.5):Task 4——/mcp 端点组装。
// fake transport 注入测 wiring/闸门(真 transport 端到端由 Task 1 spike 脚本 +
// 批 C 真机验收覆盖,单测不起真 McpServer)。
// Host 伪造/无 Host 用 raw socket(fetch 不允许改 Host 头,Node http 客户端同)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpEndpoint } from '../../src/daemon/mcp-endpoint.js';
import { appendMachineAuditLine } from '../../src/core/audit-log.js';

// N-1(批 A 审查):401/403 落审计。appendMachineAuditLine 写死 homedir() 的机器级
// 文件(getMachineAuditFile 无路径注入点)——真写会污染用户机器审计流,mock 模块
// 注入 spy 断言载荷形态(isAuditEnabled=true 强制走审计路径)。
vi.mock('../../src/core/audit-log.js', () => ({
  isAuditEnabled: () => true,
  appendMachineAuditLine: vi.fn(async () => {}),
}));

const TOKEN = 'a'.repeat(43);

/** fake transport 收到的 Web Request 快照(body 已消费为文本)。 */
interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** fake transport:handleRequest 记录请求 + 可定制响应;缺省固定 200 JSON + 自定义头。 */
function makeFakeTransport(respond?: (req: Request) => Promise<Response>): {
  seen: SeenRequest[];
  transport: { handleRequest: (req: Request) => Promise<Response> };
} {
  const seen: SeenRequest[] = [];
  return {
    seen,
    transport: {
      handleRequest: async (webReq: Request): Promise<Response> => {
        seen.push({
          url: webReq.url,
          method: webReq.method,
          headers: Object.fromEntries(webReq.headers.entries()),
          body: webReq.body ? await webReq.text() : undefined,
        });
        return respond
          ? respond(webReq)
          : new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json', 'x-custom': 'kept' } });
      },
    },
  };
}

/** 起 127.0.0.1 随机端口空 server(先拿端口再建 endpoint,deps.port 才能对上)。 */
async function serveEmpty(): Promise<{ srv: Server; port: number }> {
  const srv = createServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { srv, port };
}

async function closeServer(srv: Server): Promise<void> {
  srv.closeAllConnections?.();
  await new Promise<void>(r => srv.close(() => r()));
}

/** raw socket 发手写 HTTP(伪造/省略 Host 头——fetch 与 http 客户端都不允许),收全响应。 */
function rawHttp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port }, () => sock.write(payload));
    let buf = '';
    sock.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.setTimeout(4000, () => { sock.destroy(); reject(new Error('raw socket timeout')); });
  });
}

/** 挂 endpoint 到已监听 server,返回 fetch 基址。 */
function attach(srv: Server, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
  srv.on('request', (req, res) => { void handler(req, res); });
}

describe('mcp-endpoint /mcp 鉴权闸门(spec §3.5:仅认 Authorization Bearer header)', () => {
  it('无 Authorization → 401,body 不含 token 值', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toBe('application/json');
      const body = await res.text();
      expect(body.includes('unauthorized')).toBe(true);
      expect(body.includes(TOKEN)).toBe(false);
      expect(fake.seen.length).toBe(0);   // 闸门拦截在 transport 之前
    } finally { await closeServer(srv); }
  });

  it('Authorization: Bearer <正确 token> → 放行到 transport(fake 响应透传)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":1}');
      expect(fake.seen.length).toBe(1);
    } finally { await closeServer(srv); }
  });

  it('错误 token → 401,body 不含真 token 值', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      });
      expect(res.status).toBe(401);
      expect((await res.text()).includes(TOKEN)).toBe(false);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('非 Bearer scheme(Basic)→ 401', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
      });
      expect(res.status).toBe(401);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('query ?token=<正确值> 不放行(仅认 header,不复用 web-gui extractToken)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp?token=${TOKEN}`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('cookie gui-token=<正确值> 不放行(仅认 header)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { cookie: `gui-token=${TOKEN}` },
      });
      expect(res.status).toBe(401);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });
});

describe('mcp-endpoint Host 闸门(rebinding 防,raw socket 伪造)', () => {
  it('Host: evil.example(带正确 Bearer)→ 403', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const raw = await rawHttp(port,
        `POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
      expect(raw.includes('host not allowed')).toBe(true);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('无 Host 头(HTTP/1.0,带正确 Bearer)→ 403', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const raw = await rawHttp(port,
        `GET /mcp HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
      expect(raw.startsWith('HTTP/1.1 403') || raw.startsWith('HTTP/1.0 403')).toBe(true);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('Host: localhost:<port>(回环别名形态)→ 放行(port-agnostic)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const raw = await rawHttp(port,
        `POST /mcp HTTP/1.1\r\nHost: localhost:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
      expect(raw.includes('{"ok":1}')).toBe(true);
    } finally { await closeServer(srv); }
  });
});

describe('mcp-endpoint Node↔Web wiring(spike S-1 同款)', () => {
  it('POST:method/url/authorization/body 透传,Host 规范化为 127.0.0.1:<port>', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    const bodyText = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      expect(fake.seen.length).toBe(1);
      const seen = fake.seen[0]!;
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(seen.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(seen.headers['host']).toBe(`127.0.0.1:${port}`);   // spike 同款:固定 Host(rebinding 闸已在此前完成)
      expect(seen.headers['content-type']).toBe('application/json');
      expect(seen.body).toBe(bodyText);   // Readable.toWeb body 流无损
    } finally { await closeServer(srv); }
  });

  it('GET/DELETE:无 body 构造(不带 duplex),method 透传', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const g = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(g.status).toBe(200);
      const d = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(d.status).toBe(200);
      expect(fake.seen.map(s => s.method)).toEqual(['GET', 'DELETE']);
      expect(fake.seen.every(s => s.body === undefined)).toBe(true);
    } finally { await closeServer(srv); }
  });

  it('Web Response 状态与自定义头透传回 Node 响应', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-custom')).toBe('kept');
      expect(res.headers.get('content-type')).toBe('application/json');
    } finally { await closeServer(srv); }
  });
});

describe('mcp-endpoint 错误自理(Task 3 交接:headersSent 后不得再 writeHead)', () => {
  it('transport.handleRequest 抛错(头未发)→ 500 JSON,不含 token', async () => {
    const fake = makeFakeTransport(() => { throw new Error('transport blew up'); });
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body.includes(TOKEN)).toBe(false);
    } finally { await closeServer(srv); }
  });

  it('响应流中途 error(头已发)→ 连接销毁,客户端读到终止流而非 200 完整体', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"par'));
        setTimeout(() => c.error(new Error('mid-stream boom')), 30);
      },
    });
    const fake = makeFakeTransport(async () => new Response(broken, { status: 200, headers: { 'content-type': 'application/json' } }));
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);   // 头已发出(真实场景:headersSent=true,只能 destroy)
      await expect(res.text()).rejects.toThrow();   // 半截 body 不允许以 200 正常结束
    } finally { await closeServer(srv); }
  });
});

describe('mcp-endpoint 缺省构造分支(真 transport)', () => {
  it('未注入 _transportForTest → transport 是 WebStandardStreamableHTTPServerTransport 实例', () => {
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port: 1 });
    expect(ep.transport).toBeInstanceOf(WebStandardStreamableHTTPServerTransport);
    expect(ep.activeSessionCount()).toBe(0);   // 尚无会话(fake 注入时恒 0,真 transport 由回调计数)
  });

  it('connect() 把 transport 交给 mcpServer.connect', async () => {
    const connect = vi.fn(async () => {});
    const ep = createMcpEndpoint({ mcpServer: { connect } as never, token: TOKEN, port: 1 });
    await ep.connect();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]![0]).toBe(ep.transport);
  });
});

describe('mcp-endpoint 401/403 落审计(N-1:spec §3.5 失败落审计,批 A 审查处置)', () => {
  beforeEach(() => { vi.mocked(appendMachineAuditLine).mockClear(); });

  it('401(无 Authorization)→ 落一条机器级审计行,载荷不含 token 值', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(vi.mocked(appendMachineAuditLine)).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendMachineAuditLine).mock.calls[0]![0];
      expect(entry.action).toBe('mcp-auth-reject');
      expect(entry.ok).toBe(false);
      expect(entry.caller).toBe('daemon:mcp');
      expect(entry.details).toEqual({ error: 'unauthorized', hasAuth: false });
      expect(JSON.stringify(entry).includes(TOKEN)).toBe(false);   // 审计载荷不落 token 值
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });

  it('403(伪造 Host,带正确 Bearer)→ 落一条机器级审计行,载荷不含 Host 原文与 token 值', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({ mcpServer: { connect: async () => {} } as never, token: TOKEN, port, _transportForTest: fake.transport as never });
    attach(srv, ep.handler);
    try {
      const raw = await rawHttp(port,
        `POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
      expect(vi.mocked(appendMachineAuditLine)).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendMachineAuditLine).mock.calls[0]![0];
      expect(entry.action).toBe('mcp-host-reject');
      expect(entry.ok).toBe(false);
      expect(entry.caller).toBe('daemon:mcp');
      expect(entry.details).toEqual({ error: 'host_not_allowed', hasAuth: true });
      expect(JSON.stringify(entry).includes('evil.example')).toBe(false);   // 403 不回显 Host(已审结论)
      expect(JSON.stringify(entry).includes(TOKEN)).toBe(false);
      expect(fake.seen.length).toBe(0);
    } finally { await closeServer(srv); }
  });
});

// Task 11(批 C,spec §3.6):/mcp 单会话独占——第二 Initialize 409;SDK onsessionclosed
// 仅 DELETE 触发(批 A 审查:客户端崩溃/断连时计数不减),纯计数拦截会让新连接
// 永远 409 死锁——闸门以"会话 lastSeen 活性"判定,超 staleMs 无流量视为死残留放行。
describe('mcp-endpoint 单会话独占(spec §3.6:第二 Initialize 409;活性超时防计数残留死锁)', () => {
  const STALE_MS = 10_000;
  const INIT_BODY = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'second-client', version: '1.0' } },
  });
  const BUSY_JSON =
    '{"error":"mcp endpoint busy: one session at a time (spec §3.6); connect a stdio instance or start another daemon"}';

  beforeEach(() => { vi.mocked(appendMachineAuditLine).mockClear(); });

  it('有活跃会话(计数=1 且 lastSeen 新鲜)+ Initialize → 409 + spec 文案,不进 transport', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now()]] },
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: INIT_BODY,
      });
      expect(res.status).toBe(409);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.text()).toBe(BUSY_JSON);
      expect(fake.seen.length).toBe(0);   // 闸门拦截在 transport 之前
    } finally { await closeServer(srv); }
  });

  it('无活跃会话(缺省状态)Initialize → 放行到 transport,body 透传无损', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: INIT_BODY,
      });
      expect(res.status).toBe(200);
      expect(fake.seen.length).toBe(1);
      expect(fake.seen[0]!.body).toBe(INIT_BODY);   // 缓冲重建后 body 无损
    } finally { await closeServer(srv); }
  });

  it('计数残留(activeSessions=1 但 lastSeen 超 staleMs)Initialize → 放行,不死锁', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now() - (STALE_MS + 5000)]] },
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: INIT_BODY,
      });
      expect(res.status).toBe(200);
      expect(fake.seen.length).toBe(1);
      expect(ep.activeSessionCount()).toBe(1);   // SDK 计数残留仍在(回调未触发),闸门靠活性放行而非计数清零
    } finally { await closeServer(srv); }
  });

  it('活跃会话 + 非 Initialize POST(tools/list)→ 放行(拦截只针对新会话建立)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now()]] },
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'mcp-session-id': 's1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      expect(fake.seen.length).toBe(1);   // 存量会话的请求照旧放行
    } finally { await closeServer(srv); }
  });

  it('409 落一条机器级审计行(mcp-session-reject),载荷不含 token 值', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now()]] },
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: INIT_BODY,
      });
      expect(res.status).toBe(409);
      expect(vi.mocked(appendMachineAuditLine)).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendMachineAuditLine).mock.calls[0]![0];
      expect(entry.action).toBe('mcp-session-reject');
      expect(entry.ok).toBe(false);
      expect(entry.caller).toBe('daemon:mcp');
      expect(entry.details).toEqual({ error: 'session_busy', activeSessions: 1, staleMs: STALE_MS });
      expect(JSON.stringify(entry).includes(TOKEN)).toBe(false);   // 审计载荷不落 token 值
    } finally { await closeServer(srv); }
  });

  it('带 mcp-session-id 的请求刷新 lastSeen——已 stale 的会话被迟到请求复活,Initialize 仍 409', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    // 种子已超 staleMs:若无刷新逻辑,后续 Initialize 应放行(上一用例);本用例
    // 先发一个带 s1 头的存量会话请求把 lastSeen 刷到当下 → Initialize 必须仍 409。
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now() - (STALE_MS + 2000)]] },
    });
    attach(srv, ep.handler);
    try {
      const refresh = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'mcp-session-id': 's1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(refresh.status).toBe(200);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: INIT_BODY,
      });
      expect(res.status).toBe(409);
      expect(fake.seen.length).toBe(1);   // 只有 tools/list 进了 transport,Initialize 被闸门拦下
    } finally { await closeServer(srv); }
  });

  it('POST body 非 JSON + 活跃会话 → 放行(嗅探失败不误拦,交 SDK 自理)', async () => {
    const fake = makeFakeTransport();
    const { srv, port } = await serveEmpty();
    const ep = createMcpEndpoint({
      mcpServer: { connect: async () => {} } as never, token: TOKEN, port,
      sessionStaleMs: STALE_MS,
      _transportForTest: fake.transport as never,
      _sessionStateForTest: { activeSessions: 1, lastSeen: [['s1', Date.now()]] },
    });
    attach(srv, ep.handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
        body: 'not json at all',
      });
      expect(res.status).toBe(200);
      expect(fake.seen.length).toBe(1);
      expect(fake.seen[0]!.body).toBe('not json at all');
    } finally { await closeServer(srv); }
  });
});
