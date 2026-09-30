// src/daemon/mcp-endpoint.ts — daemon 批 A(2026-09-30 spec §3.2/§3.5):/mcp 端点组装。
// 分层:本文件是 daemon 组合层,把 SDK 的 Streamable HTTP transport 组装成可注入
// WebGuiServerOptions.mcpHandler 的 (req,res)=>void 处理器——web-gui 不 import MCP SDK
// 的约定由此兑现(WebGuiServer 只见签名,不见协议)。
// ⚠️ SDK import 全走主入口 '@modelcontextprotocol/server'(Task 1 spike 实测:其
//    package.json exports 无 /mcp.js、/streamablehttp.js 子路径)。
// ⚠️ 错误自理:web-gui 外层 catch 在 headersSent 后 writeHead(500) 会二次抛且无人兜
//    (Task 3 交接)——本 handler 全程 try/catch,headersSent 后仅 destroy,不再 writeHead。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  WebStandardStreamableHTTPServerTransport,
  validateHostHeader,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';

/** Task 5 消费驱动的接口收敛(2026-09-30):原类型为 SDK 名义类 McpServer,但 GodotServer
 *  持有的是同包的 Server 类(Protocol 直系)——两者互不名义兼容,而本端点只消费
 *  connect(transport)。结构最小接口让 SDK Server / McpServer / 测试 fake 三者都天然
 *  满足(依赖倒置),免 as 断言(禁 any 纪律)。运行时语义:connect 即 Protocol 基类的
 *  transport 接线,两类一致。 */
export type McpConnectable = { connect(transport: Transport): Promise<void> };

export interface McpEndpointDeps {
  mcpServer: McpConnectable;
  token: string;
  /** 端口(constructing Web Request 的 URL 与规范化 Host 用)。 */
  port: number;
  /** 测试注入假 transport(鸭子:仅用 handleRequest);缺省构造真 stateful transport。
   *  真 transport 端到端由 Task 1 spike 脚本 + 批 C 真机验收覆盖,单测不起真 McpServer。 */
  _transportForTest?: WebStandardStreamableHTTPServerTransport;
}

export interface McpEndpoint {
  /** 即 WebGuiServerOptions.mcpHandler 的实现(签名逐字一致);Promise 不外抛(全内消)。 */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  transport: WebStandardStreamableHTTPServerTransport;
  /** 活跃会话数(真 transport 由 onsessioninitialized/closed 维护;批 C 单会话拦截消费)。 */
  activeSessionCount(): number;
  /** 把 transport 交给 McpServer(Task 2 GodotServer.connectTransport 的等价直连)。 */
  connect(): Promise<void>;
}

export function createMcpEndpoint(deps: McpEndpointDeps): McpEndpoint {
  let activeSessions = 0;
  const transport = deps._transportForTest ?? new WebStandardStreamableHTTPServerTransport({
    // stateful(spec §3.6 单会话拦截的判定基础);allowedHosts/enableDnsRebindingProtection
    // 是 @deprecated 选项不使用——Host 校验走本文件闸门(external middleware,SDK 文档同荐)。
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: () => { activeSessions++; },
    onsessionclosed: () => { activeSessions--; },
  });

  // 恒定时间 Bearer 比较(对齐 web-gui server.ts tokenEquals 的 M-1 先例):长度先守卫
  // 防长度泄露,timingSafeEqual 防逐前缀定时探测。仅认 Authorization 头——spec §3.5 明确
  // 不复用 web-gui extractToken(query>header>cookie 优先级会把 query/cookie 凭据放进来)。
  function bearerOk(authHeader: string | undefined): boolean {
    const a = Buffer.from(`Bearer ${deps.token}`, 'utf8');
    const b = Buffer.from(String(authHeader ?? ''), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 闸门 1:Host(rebinding 防)——仅认本机回环 hostname(port-agnostic,SDK 判定)。
      const hostCheck = validateHostHeader(req.headers.host, localhostAllowedHostnames());
      if (!hostCheck.ok) {
        res.writeHead(403, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'host not allowed' }));
        return;
      }
      // 闸门 2:鉴权——仅 Authorization: Bearer <token>;401 响应体不含 token 值。
      if (!bearerOk(req.headers.authorization)) {
        res.writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized: /mcp requires Authorization: Bearer <token>' }));
        return;
      }
      // Node → Web(spike S-1 同款):头归一化(过滤 undefined;set-cookie 数组 join——
      // MCP 端点正常无此头,防御性处理)+ Host 固定为 127.0.0.1:<port>(rebinding 闸已过,
      // 规范化避免 transport 侧看到 localhost/127.0.0.1 两种形态)。
      const method = req.method ?? 'GET';
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      headers.host = `127.0.0.1:${deps.port}`;
      // node:stream/web 与 undici 全局 ReadableStream 是两套类型声明同一运行时实现
      // (Node 全局 fetch 即基于 node:stream/web),结构差异仅类型层——双断言桥接,
      // spike S-1/S-3 已实测 POST body 流(Readable.toWeb)与 SSE 回写(fromWeb)无损。
      const reqUrl = `http://127.0.0.1:${deps.port}${req.url ?? '/'}`;
      let webReq: Request;
      if (hasBody) {
        // @types/node 20.x 已知行为:worker_threads 给 globalThis 声明了 onmessage,
        // web-globals 桥接(typeof globalThis extends {onmessage})把全局 RequestInit
        // 解析为 {} 分支,丢失 duplex 字段(undici-types 原生含它;运行时流 body 必须
        // duplex:'half',spike 实测)。交叉补齐 + 经变量传参绕开字面量 excess check。
        const reqInit: RequestInit & { duplex?: 'half' } = {
          method, headers,
          body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
          duplex: 'half',
        };
        webReq = new Request(reqUrl, reqInit);
      } else {
        webReq = new Request(reqUrl, { method, headers });
      }
      // Web → Node:状态/头透传(set-cookie 多值经 getSetCookie 保数组,writeHead 原生
      // 支持数组值发多行);body 流 pipe(SSE 长流同路径)。
      const webRes = await transport.handleRequest(webReq);
      const outHeaders: Record<string, string | string[]> = {};
      webRes.headers.forEach((v, k) => { outHeaders[k] = v; });
      const setCookies = webRes.headers.getSetCookie();
      if (setCookies.length > 0) outHeaders['set-cookie'] = setCookies;
      res.writeHead(webRes.status, outHeaders);
      if (!webRes.body) { res.end(); return; }
      const nodeStream = Readable.fromWeb(webRes.body as unknown as NodeWebReadableStream<Uint8Array>);
      // 双侧 error 监听:未监听的 'error' 事件会以 unhandled error 炸进程;此处流中断
      // 已无干净响应可写(headersSent=true)→ destroy 断连,客户端走重连路径。
      nodeStream.on('error', () => { res.destroy(); });
      res.on('error', () => { nodeStream.destroy(); });
      nodeStream.pipe(res);
    } catch {
      // headersSent 自理(Task 3 ⚠️ 交接):头已发出后 writeHead 会二次抛 ERR_HTTP_HEADERS_SENT
      // 且 web-gui 外层无人兜——仅 destroy;未发出则 500(响应体不含 token/错误细节)。
      if (res.headersSent) { res.destroy(); return; }
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'internal error' }));
      } catch { res.destroy(); }
    }
  }

  return {
    handler,
    transport,
    activeSessionCount: () => activeSessions,
    connect: async () => { await deps.mcpServer.connect(transport); },
  };
}
