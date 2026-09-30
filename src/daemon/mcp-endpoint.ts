// src/daemon/mcp-endpoint.ts — daemon 批 A(2026-09-30 spec §3.2/§3.5):/mcp 端点组装。
// 分层:本文件是 daemon 组合层,把 SDK 的 Streamable HTTP transport 组装成可注入
// WebGuiServerOptions.mcpHandler 的 (req,res)=>void 处理器——web-gui 不 import MCP SDK
// 的约定由此兑现(WebGuiServer 只见签名,不见协议)。
// ⚠️ SDK import 全走主入口 '@modelcontextprotocol/server'(Task 1 spike 实测:其
//    package.json exports 无 /mcp.js、/streamablehttp.js 子路径)。
// ⚠️ 错误自理:web-gui 外层 catch 在 headersSent 后 writeHead(500) 会二次抛且无人兜
//    (Task 3 交接)——本 handler 全程 try/catch,headersSent 后仅 destroy,不再 writeHead。
// Task 11(批 C,spec §3.6):单会话独占闸——POST body 缓冲嗅探 Initialize,已有
//    活跃会话(活性判定,防 SDK 计数残留死锁)→ 409 + 指引文案 + 落审计。
// 审查处置:SDK transport 单会话终态(_initialized/_closed 无 reset)——终态
//    (DELETE 完成/崩溃残留)后的新 Initialize 先重建 transport 实例再放行,
//    落 mcp-transport-rebuild 审计;否则 409 死锁只是换成 404/400。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendMachineAuditLine, isAuditEnabled } from '../core/audit-log.js';
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
  /** 单会话闸(spec §3.6)的活性超时 ms:会话超过此时长无任何请求流量即视为死
   *  残留(拦截判定视作无活跃会话,并触发 transport 重建)。缺省 5 分钟——SDK
   *  onsessionclosed 仅 DELETE 触发(dist/index.mjs:770-775),客户端崩溃/断连时
   *  计数单调高估,纯计数拦截会让新连接永远 409 死锁;正常 MCP 客户端有请求流或
   *  SSE 心跳(keepalive 秒级),5 分钟零流量视为死是合理启发(代价:空闲超阈值的
   *  活会话被误放一次——旧会话被新会话顶替,SDK validateSession 404 旧 id,不产生
   *  双活互踩)。注意:SDK transport 的 _initialized/_closed 是**实例终态无 reset**
   *  (审查核实 dist/index.mjs:655/:658/:667/:820),终态后的放行必须换新 transport
   *  实例(见 rebuildTransport),否则 DELETE 后永久 404、崩溃残留后新 Initialize
   *  撞 400 "Server already initialized"——死锁只是换了错误码,没真解。 */
  sessionStaleMs?: number;
  /** 测试注入假 transport(鸭子:仅用 handleRequest);缺省构造真 stateful transport。
   *  真 transport 端到端由 Task 1 spike 脚本 + 批 C 真机验收覆盖,单测不起真 McpServer。 */
  _transportForTest?: WebStandardStreamableHTTPServerTransport;
  /** 测试注入 transport 重建工厂(终态后新 Initialize 触发重建时调用;缺省造真
   *  transport)——与 _transportForTest 配对验证重建路径(fake 不触发真回调)。 */
  _rebuildTransportForTest?: () => WebStandardStreamableHTTPServerTransport;
  /** 测试注入种子活性状态(fake transport 不触发 onsessioninitialized/closed 真
   *  回调,单测直接摆状态驱动闸门分支;生产不传)。 */
  _sessionStateForTest?: {
    activeSessions?: number;
    /** [sessionId, lastSeenAt(epoch ms)] 种子条目。 */
    lastSeen?: Array<[string, number]>;
    /** 种子"当前 transport 已服务过会话"(模拟 DELETE 完成/崩溃残留的终态)。 */
    transportServed?: boolean;
  };
}

export interface McpEndpoint {
  /** 即 WebGuiServerOptions.mcpHandler 的实现(签名逐字一致);Promise 不外抛(全内消)。 */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 当前活跃 transport(终态重建后重指向新实例——消费方经 getter 取,勿缓存引用)。 */
  transport: WebStandardStreamableHTTPServerTransport;
  /** 活跃会话数(真 transport 由 onsessioninitialized/closed 维护;批 C 单会话拦截消费)。 */
  activeSessionCount(): number;
  /** 把 transport 交给 McpServer(Task 2 GodotServer.connectTransport 的等价直连)。 */
  connect(): Promise<void>;
}

/** Task 11(批 C,spec §3.6):第二 Initialize 的拒绝文案——指引另起 daemon 或连
 *  stdio 实例,不静默排队(spec m-8:明确拒绝优于隐式互踩)。 */
const SESSION_BUSY_ERROR =
  'mcp endpoint busy: one session at a time (spec §3.6); connect a stdio instance or start another daemon';

export function createMcpEndpoint(deps: McpEndpointDeps): McpEndpoint {
  // 活性状态双轨(spec §3.6 单会话闸):activeSessions 是 SDK 回调维护的计数;
  //  sessionLastSeen 是本文件的活性记录(每次带 mcp-session-id 且匹配的请求刷新)。
  //  拦截判定 = 计数 > 0 && 存在新鲜条目——计数残留(崩溃客户端)靠 stale 判定
  //  兜底不死锁;两轨独立来源 AND 收敛,任何单轨异常都不会误拦新会话。
  let activeSessions = deps._sessionStateForTest?.activeSessions ?? 0;
  const sessionLastSeen = new Map<string, number>(deps._sessionStateForTest?.lastSeen ?? []);
  const staleMs = deps.sessionStaleMs ?? 5 * 60_000;
  // transportServed:当前 transport 实例是否服务过会话(onsessioninitialized 置位)。
  //  SDK transport 的 _initialized/_closed 是实例终态无 reset(审查核实),终态后
  //  的新 Initialize 必须换新实例——此标记即"需要重建"的判定基础。
  let transportServed = deps._sessionStateForTest?.transportServed ?? false;
  // 重建互斥:并发到达的终态 Initialize 共享同一重建 promise,防双重建(第二次会把
  //  第一次刚接好的新 transport 又 close 掉)。
  let rebuildInFlight: Promise<void> | null = null;

  function makeTransport(): WebStandardStreamableHTTPServerTransport {
    return new WebStandardStreamableHTTPServerTransport({
      // stateful(spec §3.6 单会话拦截的判定基础);allowedHosts/enableDnsRebindingProtection
      // 是 @deprecated 选项不使用——Host 校验走本文件闸门(external middleware,SDK 文档同荐)。
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        activeSessions++;
        sessionLastSeen.set(sessionId, Date.now());
        transportServed = true;
      },
      onsessionclosed: (sessionId: string) => {
        activeSessions--;
        sessionLastSeen.delete(sessionId);
      },
    });
  }
  let transport = deps._transportForTest ?? makeTransport();

  /** 活性判定 + 懒清理:返回新鲜(< staleMs)会话数;stale 条目就地删除(Map 迭代
   *  中删当前项是 JS 规范允许的)。SDK 计数为 0 时直接返回 0(双轨 AND 的计数侧)。 */
  function liveSessionCount(now: number): number {
    if (activeSessions <= 0) return 0;
    let live = 0;
    for (const [sid, seen] of sessionLastSeen) {
      if (now - seen <= staleMs) live++;
      else sessionLastSeen.delete(sid);
    }
    return live;
  }

  /** transport 重建(审查处置,spec §3.6):SDK transport 单会话终态(_initialized/
   *  _closed 无 reset)——DELETE 完成或崩溃残留后,新 Initialize 必须换新实例,
   *  否则旧 transport 对一切请求 404(_closed)或 400 "already initialized"。
   *  spike 证据:Protocol.connect(src-CX2iR2pK.mjs:6290)直接替换 _transport 指针无
   *  二次接线守卫,旧实例 close 经 Protocol._onclose(:6320)清 in-flight 并置空指针
   *  ——McpServer 可反复 connect 新实例;新实例字段初值即干净(_initialized=false/
   *  _closed=false/sessionId=undefined,dist/index.mjs:303-311)。
   *  ⚠️ 顺序约束:必须先 close 旧再 connect 新(_onclose 置空 _transport,后 close
   *  会清掉新接线)。状态归位放 connect 成功之后——失败则 transport/计数原样,
   *  下个 Initialize 重试重建(自愈),不留半接线。 */
  async function rebuildTransport(reason: 'delete' | 'stale'): Promise<void> {
    const make = deps._rebuildTransportForTest ?? makeTransport;
    try { await transport.close(); } catch { /* best-effort:已 closed / 测试 fake 无 close */ }
    const next = make();
    await deps.mcpServer.connect(next);
    transport = next;
    transportServed = false;
    activeSessions = 0;   // 归位 SDK 残留计数(否则 stale 终态的虚高计数在下个会话 DELETE 时减成负数)
    sessionLastSeen.clear();
    auditMcpTransportRebuild(reason);
  }

  /** 嗅探 JSON-RPC method(单会话闸判定 Initialize 用):仅认单 JSON 对象的顶层
   *  method 字段;解析失败/数组/缺 method → undefined(放行交 SDK 自理——闸门宁
   *  漏拦不误拦,漏拦仅剩 batch Initialize 的理论场景,SDK 侧另有会话校验兜底)。 */
  function rpcMethodOf(body: Uint8Array): string | undefined {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (typeof parsed === 'object' && parsed !== null && 'method' in parsed) {
        const m = (parsed as { method?: unknown }).method;
        return typeof m === 'string' ? m : undefined;
      }
    } catch { /* 非 JSON body:嗅探失败即放行(SDK 自理 400) */ }
    return undefined;
  }

  // 恒定时间 Bearer 比较(对齐 web-gui server.ts tokenEquals 的 M-1 先例):长度先守卫
  // 防长度泄露,timingSafeEqual 防逐前缀定时探测。仅认 Authorization 头——spec §3.5 明确
  // 不复用 web-gui extractToken(query>header>cookie 优先级会把 query/cookie 凭据放进来)。
  function bearerOk(authHeader: string | undefined): boolean {
    const a = Buffer.from(`Bearer ${deps.token}`, 'utf8');
    const b = Buffer.from(String(authHeader ?? ''), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // 拒绝审计(N-1,spec §3.5 "失败落审计"):401/403 各落一条机器级审计行。
  // 载荷不含 token 值与 Host 原文(403 不回显 Host 是已审结论);hasAuth 仅记"是否
  // 携带 Authorization 头"布尔。fire-and-forget + .catch:审计失败 best-effort 不
  // 影响拒绝响应(对齐 main.ts daemon-startup / server.ts auditInstanceAction 先例,
  // caller 命名取 'daemon:mcp' 与 'web-gui:instances' 同款 域:子系统 风格)。
  function auditMcpReject(error: 'unauthorized' | 'host_not_allowed', hasAuth: boolean): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `daemon-mcp-${randomUUID().slice(0, 16)}`,
      tool: 'daemon',
      action: error === 'unauthorized' ? 'mcp-auth-reject' : 'mcp-host-reject',
      risk: 'process',
      ok: false, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'daemon:mcp',
      details: { error, hasAuth },
    }).catch(() => { /* best-effort:审计失败不影响拒绝响应 */ });
  }

  // Task 11(批 C,spec §3.6):单会话 409 拒绝审计(对齐上方 auditMcpReject 先例:
  // best-effort,载荷不含 token 值;details 记新鲜会话数与 staleMs 配置,排障可辨
  // "真有客户端占用"与"闸门配置")。
  function auditMcpSessionReject(liveSessions: number): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `daemon-mcp-${randomUUID().slice(0, 16)}`,
      tool: 'daemon',
      action: 'mcp-session-reject',
      risk: 'process',
      ok: false, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'daemon:mcp',
      details: { error: 'session_busy', liveSessions, staleMs },
    }).catch(() => { /* best-effort:审计失败不影响拒绝响应 */ });
  }

  // 审查处置:transport 重建审计(自愈动作,ok=true 非拒绝)——details.reason 区分
  // 终态成因:'delete'=SDK 回调干净终止过(计数归零);'stale'=崩溃残留(计数虚高,
  // 懒清理刚清了活性 Map)。排障可辨"正常会话轮换"与"客户端异常断连"。
  function auditMcpTransportRebuild(reason: 'delete' | 'stale'): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `daemon-mcp-${randomUUID().slice(0, 16)}`,
      tool: 'daemon',
      action: 'mcp-transport-rebuild',
      risk: 'process',
      ok: true, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'daemon:mcp',
      details: { reason },
    }).catch(() => { /* best-effort:审计失败不影响放行 */ });
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 闸门 1:Host(rebinding 防)——仅认本机回环 hostname(port-agnostic,SDK 判定)。
      const hostCheck = validateHostHeader(req.headers.host, localhostAllowedHostnames());
      if (!hostCheck.ok) {
        auditMcpReject('host_not_allowed', req.headers.authorization !== undefined);
        res.writeHead(403, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'host not allowed' }));
        return;
      }
      // 闸门 2:鉴权——仅 Authorization: Bearer <token>;401 响应体不含 token 值。
      if (!bearerOk(req.headers.authorization)) {
        auditMcpReject('unauthorized', req.headers.authorization !== undefined);
        res.writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized: /mcp requires Authorization: Bearer <token>' }));
        return;
      }
      // 会话活性刷新(单会话闸的活性侧,spec §3.6):任意方法的请求带 mcp-session-id
      // 头且匹配已知会话 → 刷新 lastSeen(POST 请求流与 GET SSE 心跳都算"活着";
      // SDK 客户端约定 Initialize 之后的请求必带此头)。未知 id 不刷(交给 SDK 404)。
      const sidHeader = req.headers['mcp-session-id'];
      if (typeof sidHeader === 'string' && sessionLastSeen.has(sidHeader)) {
        sessionLastSeen.set(sidHeader, Date.now());
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
      const reqUrl = `http://127.0.0.1:${deps.port}${req.url ?? '/'}`;
      let webReq: Request;
      if (hasBody) {
        // Task 11(批 C,spec §3.6):POST body 改缓冲(原 Readable.toWeb 流式)——
        // 单会话闸需嗅探 JSON-RPC method 判 Initialize。MCP 消息有界,缓冲无内存
        // 放大顾虑(且鉴权闸已挡未持 token 者);GET 的 SSE 响应侧保持流式不变
        // (响应流与请求缓冲无关)。Request 重建:method/headers/URL 原样,body 换
        // 字节副本(非流 body 无需 duplex)。
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new Uint8Array(Buffer.concat(chunks));
        // 闸门 3:单会话独占——仅 POST 且嗅探出 initialize:①存在新鲜(活跃)会话
        // → 409(spec m-8:明确 4xx + 可读 message,不静默排队)。②无活跃会话但当前
        // transport 已服务过会话(终态:DELETE 完成或崩溃残留)→ 先重建 transport
        // 再放行(SDK transport 的 _initialized/_closed 是实例终态无 reset,直通会
        // 404/400 假死——审查 Critical/Important 处置)。非 Initialize(tools/list
        // 等)不拦:存量会话请求照旧放行,无 session 头的由 SDK 自理 400;嗅探失败
        // (非 JSON)放行交 SDK。
        if (method === 'POST' && rpcMethodOf(body) === 'initialize') {
          const live = liveSessionCount(Date.now());
          if (live > 0) {
            auditMcpSessionReject(live);
            res.writeHead(409, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: SESSION_BUSY_ERROR }));
            return;
          }
          if (transportServed) {
            // 原因判定:计数>0 = onsessionclosed 未触发过的崩溃残留('stale');
            // 计数归零 = DELETE 干净终止过('delete')。
            const reason: 'delete' | 'stale' = activeSessions > 0 ? 'stale' : 'delete';
            if (!rebuildInFlight) {
              rebuildInFlight = rebuildTransport(reason).finally(() => { rebuildInFlight = null; });
            }
            await rebuildInFlight;   // 并发终态 Initialize 共享同一重建;失败冒泡至外层 catch(500),状态未动可重试
          }
        }
        webReq = new Request(reqUrl, { method, headers, body });
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
      // node:stream/web 与 undici 全局 ReadableStream 是两套类型声明同一运行时实现
      // (spike S-3 实测 SSE 回写无损)——双断言桥接,差异仅类型层。
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
    get transport() { return transport; },   // getter:重建后外部始终取当前活跃实例
    activeSessionCount: () => activeSessions,
    connect: async () => { await deps.mcpServer.connect(transport); },
  };
}
