// src/core/instance-http-server.ts
/**
 * MULTI_INSTANCE 接收端 HTTP server（2026-08-10 行225：补全 verifyApiToken 闭环）。
 *
 * 此前 MULTI_INSTANCE 是「发送端 only」——sendToInstance / dynamicSender 用 fetch POST +
 * buildAuthHeaders(HMAC 签名)发请求到 127.0.0.1:<port>/api/<tool>，但 TS server 从不启动
 * HTTP 接收端，verifyApiToken 零生产调用。本模块补全接收端：
 *
 *   POST /api/<toolName>  →  verifyApiToken(instanceId, token)  →  dispatcher.handleCall
 *   ↑ HMAC 签名验证失败 = 401        ↑ 复用 GodotServer 同一个 ToolDispatcher
 *
 * 安全模型：
 * - 仅 127.0.0.1（localhost，对齐 instance-api-auth.ts 的安全模型）
 * - HMAC 签名含 instance.id + timestamp + nonce，防重放（verifyApiToken 内置）
 * - toolName 严格校验 ^[a-zA-Z_][a-zA-Z0-9_]*$（防路径注入，对齐 sendToInstance 同款校验）
 * - 仅 POST（GET/其他方法 405）
 *
 * 限制（srvCtx=undefined 的代价）：
 * - confirm_and_execute 双轮 MRTR 交互失效（多实例转发场景不需要 MRTR，可接受）
 * - logLevel / per-request log 失效（普通工具不受影响）
 *
 * 2026-08-11 可靠性加固（P2-2R/P2-3R/P3-1R）：
 * - readBody/handleCall 加超时（对齐 sender 30s AbortSignal，收发对称防孤儿请求/slowloris）
 * - stop() 强制关连接（Node 18.2+ closeAllConnections，防 in-flight 长请求致 close() 挂起）
 * - forwardTimeoutMs 可注入（测试用小值避免等 30s，提升可测试性）
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyApiToken } from './instance-api-auth.js';
import type { ToolDispatcher } from './ToolDispatcher.js';
import type { HandlerResult } from '../types.js';
import { getLogger } from './logger.js';

/** toolName 合法字符集（对齐 GodotServer.ts sendToInstance 的校验，防路径注入）。 */
const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * 默认工具转发超时（毫秒）。对齐 sender 侧 sendToInstance 的 30s AbortSignal
 * （GodotServer.ts sender 两处）——receiver 须与 sender 对称，否则 sender 已 abort 后
 * receiver 仍执行成孤儿请求（nav bake 110s/test_run 290s 等长操作尤其严重）。
 *
 * C4（反馈 2026-11-11）：30s 可经 `GODOT_MCP_FORWARD_TIMEOUT_MS` 覆盖——sender 两处
 * AbortSignal 与本 receiver 默认值统一走 resolveForwardTimeoutMs() 派生（默认 30000
 * 行为兼容；非法值回落默认并 console.warn 一行）。
 */
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;

/**
 * 解析 `GODOT_MCP_FORWARD_TIMEOUT_MS`（毫秒）。未设 → 默认 30000；非法（非正整数）
 * → 回落默认并 console.warn 一行。sender（GodotServer 两处 fetch AbortSignal）与
 * receiver（InstanceHttpServer 构造默认）共用，保证收发两端读同一 env。
 */
export function resolveForwardTimeoutMs(): number {
  const raw = process.env.GODOT_MCP_FORWARD_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_FORWARD_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn(`[godot-mcp] invalid GODOT_MCP_FORWARD_TIMEOUT_MS="${raw}", falling back to ${DEFAULT_FORWARD_TIMEOUT_MS}ms`);
  return DEFAULT_FORWARD_TIMEOUT_MS;
}

/** withTimeout 超时 reject 的 error；catch 用 instanceof TimeoutError 区分超时 vs 其他异常。 */
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * 给 promise 套超时兜底（Promise.race + setTimeout，finally 清理 timer 防泄漏）。
 * 超时 reject TimeoutError，由调用方 catch 用 instanceof 区分超时 vs promise 自身异常。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface InstanceHttpServerOptions {
  /** 监听端口。 */
  port: number;
  /** 本实例 id（verifyApiToken 用此 id 验签）。 */
  instanceId: string;
  /** 工具调度器（复用 GodotServer 的 dispatcher）。 */
  dispatcher: ToolDispatcher;
  /**
   * 工具转发超时（毫秒），默认读 `GODOT_MCP_FORWARD_TIMEOUT_MS`（未设 30s，对齐 sender）。
   * 显式注入优先于 env（测试注入小值如 200 避免等 30s）。P2-2R/P3-1R（2026-08-11 可靠性审查）；
   * env 派生为 C4（反馈 2026-11-11）。
   */
  forwardTimeoutMs?: number;
}

export class InstanceHttpServer {
  private server: http.Server | null = null;
  private readonly opts: InstanceHttpServerOptions;
  private readonly forwardTimeoutMs: number;

  constructor(opts: InstanceHttpServerOptions) {
    this.opts = opts;
    this.forwardTimeoutMs = opts.forwardTimeoutMs ?? resolveForwardTimeoutMs();
  }

  /** 启动 HTTP server 监听 127.0.0.1:<port>。 */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        reject(err);
      };
      this.server!.once('error', onError);
      this.server!.listen(this.opts.port, '127.0.0.1', () => {
        this.server!.removeListener('error', onError);
        getLogger().info('instance-http', `HTTP receiver listening on 127.0.0.1:${this.opts.port} (instance ${this.opts.instanceId})`);
        resolve();
      });
    });
  }

  /** 停止 HTTP server。best-effort，不 throw。 */
  async stop(): Promise<void> {
    if (!this.server) return;
    // P2-3R（2026-08-11 可靠性审查）：Node 18.2+ closeAllConnections 强制关所有连接，
    // 避免 in-flight 长请求致 server.close() 延迟到工具超时（110s/290s）或极端永挂。
    // 不调用则 close() 等所有连接关闭才回调，GodotServer.close() 的 httpReceiver.stop()
    // 在 editorConn.disconnect 之前，会阻塞后续清理。
    this.server.closeAllConnections?.();
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** 是否正在监听。 */
  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /** 核心请求处理：验签 → 解析 → 转发 dispatcher。 */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // ① 仅 POST
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
      }

      // ② 解析 /api/<toolName>
      const url = req.url ?? '';
      const match = url.match(/^\/api\/(.+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use POST /api/<toolName>.' }));
        return;
      }
      const toolName = decodeURIComponent(match[1]!);
      if (!TOOL_NAME_RE.test(toolName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid tool name: ${toolName}` }));
        return;
      }

      // ③ 验签：提取 Authorization: Bearer <token>
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Expected: Bearer <token>' }));
        return;
      }
      const token = authHeader.slice('Bearer '.length);
      if (!verifyApiToken(this.opts.instanceId, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication failed: invalid or expired token.' }));
        return;
      }

      // ④ 解析 body JSON
      // P3-1R：readBody 套超时防 slowloris（慢 body 无限占用连接），对齐 sender 30s。
      let body: string;
      try {
        body = await withTimeout(this.readBody(req), this.forwardTimeoutMs, 'Request body read');
      } catch (err) {
        // 仅 TimeoutError 返 408；其他（body too large 等）re-throw 走外层 500。
        if (!(err instanceof TimeoutError)) throw err;
        getLogger().warn('instance-http', `Body read timeout after ${this.forwardTimeoutMs}ms (slowloris?)`);
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Request body read timed out after ${this.forwardTimeoutMs}ms.` }));
        return;
      }
      let args: Record<string, unknown>;
      try {
        args = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
        return;
      }

      // ⑤ 转发到 dispatcher（srvCtx=undefined，普通工具不受影响）
      // P2-2R：与 sender 30s AbortSignal 对称——receiver 超时返 504，避免 sender 已
      // abort 后 receiver 继续执行成孤儿请求（nav bake 110s/test_run 290s 等长操作）。
      //
      // I-6（2026-08-14 审查 P3）：504 只避免孤儿**响应**，不避免孤儿**执行**——504 发出后
      // dispatcher.handleCall 的 promise 链继续跑（GD 侧 nav bake 继续至其 110s 内部 deadline）。
      // AbortController 评估结论（不实现）：① handleCall 签名无 AbortSignal，thread 下去要改
      // ToolDispatcher + 全部工具 handler + EditorConnection.request，跨子系统大改；
      // ② 即使 TS 侧 pending 被 abort，GD editor 插件协议无取消消息（JSON-RPC 单向 request），
      // bake 协程照跑至内部 deadline——执行侧无法真正中断，abort 只省 TS 侧等待；
      // ③ TS 侧 pending 有 timeoutMs 有界（nav 110s / 默认 30s），不无限占用。
      // 兜底：观察性 log——① 下方 res 'close' 监听记 client 提前断开（sender 已放弃但
      // 本地仍在执行）；② 504 站点已有 timeout warn log 可量化孤儿执行频率。
      let forwardSettled = false;
      res.on('close', () => {
        // writableEnded=false 的 close = 连接在响应完成前被断（client gone）；
        // 正常完成/504/500 路径 writableEnded=true 不记（避免误报）。
        if (!res.writableEnded && !forwardSettled) {
          getLogger().warn('instance-http', `Client connection closed before tool forward completed (${toolName}) — orphan execution may continue server-side`);
        }
      });
      let result: HandlerResult;
      try {
        result = await withTimeout(
          this.opts.dispatcher.handleCall({ params: { name: toolName, arguments: args } }),
          this.forwardTimeoutMs,
          'Tool forward',
        );
      } catch (err) {
        // 仅 TimeoutError 返 504；dispatcher 自身异常 re-throw 走外层 500（对齐 H9 语义）。
        if (!(err instanceof TimeoutError)) throw err;
        getLogger().warn('instance-http', `Tool forward timeout (${toolName}) after ${this.forwardTimeoutMs}ms`);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Tool forward timed out after ${this.forwardTimeoutMs}ms (aligned with sender 30s AbortSignal).` }));
        return;
      } finally {
        forwardSettled = true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      getLogger().warn('instance-http', `Request handler error: ${err instanceof Error ? err.message : err}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    }
  }

  /** 读取请求 body（有上限防内存耗尽）。 */
  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalLen = 0;
    // S-7: 降到 1MB(原 10MB)。MCP 工具 args JSON 极少超 1MB(scene_file 内容按 path 传非 inline),
    // 降低单请求内存占用峰值,限制已认证者(同机拿 secret)的资源耗尽面。
    const MAX_BODY = 1024 * 1024; // 1MB
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      totalLen += buf.length;
      if (totalLen > MAX_BODY) {
        throw new Error('Request body too large (max 1MB)');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
}
