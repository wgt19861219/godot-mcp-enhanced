// src/core/EditorConnection.ts
import WebSocket from 'ws';
import { createHmac } from 'crypto';
import { getLogger } from './logger.js';
import { ConnectionError, InternalError } from './tool-errors.js';
import { getErrorMessage } from '../types.js';

// I-01: Auth uses a dedicated id outside the normal requestId sequence to avoid conflicts.
// The plugin expects id=-1 for auth handshake (negative IDs are never used by normal requests).
const AUTH_REQUEST_ID = -1;
const MAX_INBOUND_MESSAGE_SIZE = 1048576; // 1MB
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCKOUT_MS = 300_000; // 5 minutes
// 3A (2026-09-19 安全加固批3): auth_begin 探测超时——哑占位者(占端口的假监听进程)对
// 任何消息都不回应,短超时探测失败后不降级,防把 secret 主动送给假监听者。
const AUTH_BEGIN_PROBE_TIMEOUT_MS = 1500;

interface EditorConnectionOptions {
  port: number;
  host?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  connectTimeout?: number;
  requestTimeout?: number;
  maxReconnectAttempts?: number;
  secret?: string;
  authTimeout?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EditorConnection {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnectEnabled = true;
  private connectAttempt = false;
  private connectGeneration = 0;  // ipc P1-4: 防 disconnect 后进行中的 connect() 复活已断开连接
  /** 3A (2026-09-19 安全加固批3): 明文 auth 降级记忆——auth_begin 收到旧端 error 响应后
   *  置 true,本实例后续连接直接走 legacyPlaintextAuth(免每次探测)。 */
  private _useLegacyAuth = false;

  private disconnectHandlers = new Set<() => void>();
  private reconnectHandlers = new Set<() => void>();
  /** I-04: Handlers called specifically when reconnect attempts are exhausted (not on normal disconnect). */
  private reconnectExhaustedHandlers = new Set<() => void>();

  /** Track dropped notify() calls so callers can detect stale scene-tree state */
  private _droppedNotifications = 0;

  /** Guard against duplicate fireDisconnect() calls */
  private _disconnectFired = false;

  /**
   * A-3 (2026-08-14 finding :932): auth 失败(exhaustion)已 fire 标记。
   * 去重:同一轮"auth 耗尽"只 fire 一次 reconnectExhausted handlers(对齐 I-04
   * "exactly once" 不变量),下次成功连接时复位。
   */
  private _authExhaustedFired = false;

  /**
   * Backward-compatible setter: converts a direct assignment like
   * `conn.onDisconnect = fn` into the multicast Set pattern.
   */
  get onDisconnect(): (() => void) | null {
    const first = this.disconnectHandlers.values().next().value;
    return first ?? null;
  }
  set onDisconnect(fn: (() => void) | null) {
    this.disconnectHandlers.clear();
    if (fn) this.disconnectHandlers.add(fn);
  }

  get onReconnect(): (() => void) | null {
    const first = this.reconnectHandlers.values().next().value;
    return first ?? null;
  }
  set onReconnect(fn: (() => void) | null) {
    this.reconnectHandlers.clear();
    if (fn) this.reconnectHandlers.add(fn);
  }

  /** Add a handler invoked when the editor disconnects. */
  addOnDisconnectHandler(handler: () => void): void {
    this.disconnectHandlers.add(handler);
  }
  /** Remove a previously added disconnect handler. */
  removeOnDisconnectHandler(handler: () => void): void {
    this.disconnectHandlers.delete(handler);
  }

  /** Add a handler invoked when the editor reconnects. */
  addOnReconnectHandler(handler: () => void): void {
    this.reconnectHandlers.add(handler);
  }
  /** Remove a previously added reconnect handler. */
  removeOnReconnectHandler(handler: () => void): void {
    this.reconnectHandlers.delete(handler);
  }

  /** I-04: Add a handler invoked when reconnect attempts are exhausted (distinct from normal disconnect). */
  addOnReconnectExhaustedHandler(handler: () => void): void {
    this.reconnectExhaustedHandlers.add(handler);
  }
  removeOnReconnectExhaustedHandler(handler: () => void): void {
    this.reconnectExhaustedHandlers.delete(handler);
  }

  private fireDisconnect(): void {
    if (this._disconnectFired) return;
    this._disconnectFired = true;
    // B5: 单 handler 抛错不阻断后续 handler / scheduleReconnect（对齐 health-monitor:156-160 容错模式）
    // 2026-08-06 审查 P2：迭代前 Array.from 快照，防 handler 内 disconnect().clear() 修改 live Set 致后续 handler 跳过
    for (const handler of Array.from(this.disconnectHandlers)) {
      try {
        handler();
      } catch (err) {
        getLogger().warn('editor', `disconnect handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private fireReconnect(): void {
    // B5: 同 fireDisconnect 容错模式,单 handler 抛错不阻断后续
    // 2026-08-06 审查 P2：迭代前 Array.from 快照（同 fireDisconnect）
    for (const handler of Array.from(this.reconnectHandlers)) {
      try {
        handler();
      } catch (err) {
        getLogger().warn('editor', `reconnect handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * I-04/A-3: fire reconnectExhausted handlers。
   * 2026-08-06 审查 P2：迭代前 Array.from 快照 + try/catch 容错（对齐 fireDisconnect/fireReconnect），
   * 防第一个 handler 调 disconnect() 触发 reconnectExhaustedHandlers.clear() 致后续 handler 静默丢失。
   */
  private fireReconnectExhausted(): void {
    for (const handler of Array.from(this.reconnectExhaustedHandlers)) {
      try {
        handler();
      } catch (err) {
        getLogger().warn('editor', `reconnectExhausted handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private readonly host: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts: number;
  private readonly editorSecret: string | null;
  private authenticated = false;
  private authFailureCount = 0;
  private authFailed = false;  // IMP-8 (2026-06-26 review): 显式认证失败标志,加固 close handler wasConnected 判断(防 connectAttempt 边缘误判)
  private authLockoutUntil = 0;

  constructor(private readonly options: EditorConnectionOptions) {
    this.host = options.host ?? '127.0.0.1';
    // Reject non-localhost hosts — WebSocket auth is plaintext (no TLS)
    if (this.host !== '127.0.0.1' && this.host !== 'localhost' && this.host !== '::1') {
        throw new InternalError('Editor WebSocket only supports localhost connections');
    }
    this.shouldReconnect = options.reconnect ?? true;
    this.reconnectEnabled = this.shouldReconnect;
    this.reconnectBaseMs = options.reconnectInterval ?? 1000;
    this.maxReconnectMs = options.maxReconnectInterval ?? 60000;
    this.connectTimeoutMs = options.connectTimeout ?? 10000;
    this.requestTimeoutMs = options.requestTimeout ?? 30000;
    this.authTimeoutMs = options.authTimeout ?? 10000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
    this.editorSecret = options.secret ?? null;
  }

  async connect(): Promise<void> {
    const gen = ++this.connectGeneration;  // ipc P1-4: 本轮 connect 的 generation
    // C-06: Clean up stale WebSocket before creating new one
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.options.port}`;
      this.connectAttempt = true;
      let settled = false; // I-05: Guard against double reject/resolve
      const timer = setTimeout(() => {
        if (settled) return; settled = true;
        ws.removeAllListeners();
        ws.terminate();
        reject(new Error(`Connection timeout to ${url}`));
      }, this.connectTimeoutMs);

      const ws = new WebSocket(url);
      ws.on('open', async () => {
        if (settled) return; clearTimeout(timer);
        // ipc P1-4: disconnect/supersede 期间 connect 完成时 gen 过期 -> 丢弃 ws 防复活, reject 让 connect Promise 不永挂
        if (gen !== this.connectGeneration) { ws.removeAllListeners(); ws.terminate(); if (!settled) { settled = true; reject(new Error('Connection superseded by disconnect/reconnect')); } return; }
        this.ws = ws;
        this.connected = true;
        this.connectAttempt = false;
        this._disconnectFired = false;
        // C-3: Reset reconnectEnabled on successful connection
        this.reconnectEnabled = this.shouldReconnect;
        this.setupMessageHandler();
        if (this.editorSecret) {
          // Check auth lockout
          if (Date.now() < this.authLockoutUntil) {
            const remaining = Math.ceil((this.authLockoutUntil - Date.now()) / 1000);
            this.connected = false;
            this.ws = null;
            ws.removeAllListeners();
            ws.terminate();
            if (!settled) { settled = true; reject(new Error(`Auth locked out: too many failures. Retry in ${remaining}s`)); }
            return;
          }
          // Reset failure counter if lockout has expired
          if (this.authFailureCount >= MAX_AUTH_FAILURES && Date.now() >= this.authLockoutUntil) {
            this.authFailureCount = 0;
            this.authLockoutUntil = 0;
          }
          try {
            await this.performAuth();
            this.authFailureCount = 0; // Reset on success
          this.authFailed = false;
          } catch (authErr) {
            this.authFailureCount++;
            if (this.authFailureCount >= MAX_AUTH_FAILURES) {
              this.authLockoutUntil = Date.now() + AUTH_LOCKOUT_MS;
              getLogger().error('auth', `Locked out for ${AUTH_LOCKOUT_MS / 1000}s after ${MAX_AUTH_FAILURES} failures`);
            }
            this.connected = false;
            this.authenticated = false;  // 阶段1b 守卫1: 重置认证状态(performAuth reject/timeout/catch 三路径都经此 catch),防残留 true 致 close handler wasConnected(:243)误判
            // I-04: Prevent reconnect loop after auth failure.
            // connectAttempt was set to false in 'open' handler (line ~163),
            // so close handler sees wasConnected=true and would call scheduleReconnect.
            // Setting reconnectEnabled=false blocks that cycle.
            this.reconnectEnabled = false;
            this.authFailed = true;  // IMP-8: 显式标记,close handler 据此跳过重连
            this.ws = null;
            ws.removeAllListeners();
            ws.terminate();
            // A-3 (2026-08-14 finding :932, P0): auth 失败(如 editor 重启换 secret)同样意味着
            // 本连接的自动重连链死亡 —— reconnectEnabled 已置 false,scheduleReconnect 入口
            // 永远静默 return,原实现只在耗尽分支 fire exhaustion,此处不 fire 则上层
            // (EditorConnectionManager.handleStall) 无降级路径 → conn 永不置 null →
            // manage_tools(reconnect) 只会 ec.connect()(旧 secret)永远失败并累计
            // authFailureCount,5 次后 5 分钟 lockout,只能重启 MCP 服务端。
            // 此处 fire 后 handleStall 置 conn=null → rebuild()(重读 secret)路径可达。
            // _authExhaustedFired 去重:同一轮"auth 耗尽"只 fire 一次(下次成功连接复位)。
            if (!this._authExhaustedFired) {
              this._authExhaustedFired = true;
              this.fireReconnectExhausted();
            }
            if (!settled) { settled = true; reject(authErr); }
            return;
          }
        } else {
          // No secret configured — reject connection for security
          this.connected = false;
          this.ws = null;
          ws.removeAllListeners();
          ws.terminate();
          if (!settled) { settled = true; reject(new Error('Editor auth required but no secret configured. Install the editor plugin.')); }
          return;
        }
        const isReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        // A-3: 成功连接复位 auth 耗尽去重标记(新一轮生命周期允许再次 fire)
        this._authExhaustedFired = false;
        // A-1 (2026-08-14 finding :937): connect 成功时清掉遗留的 backoff timer。
        // backoff 挂起窗口内手动 connect 成功后,旧 timer 若不清,触发时会再跑一次 connect(),
        // 而 connect 入口(:164-169)无条件 terminate 现有 ws → 弹跳健康连接,
        // in-flight editor 工具请求全部丢失。
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (isReconnect) {
          this.fireReconnect();
        }
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('error', (err) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        // Reject all pending requests — they will never receive a response
        // B4: 挂 err.code='CONNECTION_LOST' 供 Executor 分流(do_not_retry),不依赖字符串匹配
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(Object.assign(new Error('Connection lost'), { code: 'CONNECTION_LOST' }));
        }
        this.pending.clear();
        // Don't clear notificationHandlers — they need to survive reconnect
        // C-02: Only reconnect if we were fully authenticated — don't reconnect on auth failure
        const wasConnected = !this.connectAttempt && this.authenticated && !this.authFailed;  // IMP-8: authFailed 时不算 wasConnected,防重连
        this.fireDisconnect();
        if (wasConnected && this.reconnectEnabled) this.scheduleReconnect();
        this.connectAttempt = false;
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;
    this.ws.on('message', (data: WebSocket.Data) => {
      // IPC-R2 (2026-08-08): 删除 CMP-6 gap 检测——它挂在 ws.on('message'),但真正
      // 需要它的场景(OS 挂起后 TCP 假活无消息)它恰好不触发。「检测但不动作」是最差状态
      // (误导性暗示有 OS 挂起防护)。OS 挂起靠 health-monitor 心跳探活纠正(scheduleNext;
      // ToolDispatcher 实例化时配 heartbeatIntervalMs:15_000,默认 30s 但本项目用 15s)。
      const raw = typeof data === 'string' ? data : data.toString();
      try {
        if (Buffer.byteLength(raw, 'utf8') > MAX_INBOUND_MESSAGE_SIZE) {
          getLogger().warn('editor', 'Inbound message exceeds size limit, discarding');
          return;
        }
        const msg = JSON.parse(raw);
        // A-12: Validate msg.id is a number before using as pending lookup key
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            // I-01: Preserve structured error info (code, data) from editor plugin
            const err = new Error(msg.error.message || 'JSON-RPC error') as Error & { code?: unknown; data?: unknown };
            if (msg.error.code !== undefined) err.code = msg.error.code;
            if (msg.error.data !== undefined) err.data = msg.error.data;
            pending.reject(err);
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method && msg.id == null) {
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers) {
            // P2: 对齐 B5 容错（fireDisconnect/fireReconnect :106-123），单 handler 抛错不阻断后续 + 不冒泡到 ws 'message' 回调
            for (const handler of handlers) {
              try {
                handler(msg.params);
              } catch (err) {
                getLogger().warn('editor', `notification handler threw for ${msg.method}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      } catch (err) {
        const snippet = typeof raw === 'string' ? raw.substring(0, 200) : '(unavailable)';
        getLogger().warn('editor', `parse WebSocket message: ${getErrorMessage(err)} raw: ${snippet}`);
        // Attempt to extract id from malformed JSON and reject the pending request
        const idMatch = raw.match(/"id"\s*:\s*(\d+)/);
        if (idMatch) {
          const badId = Number(idMatch[1]);
          const pending = this.pending.get(badId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(badId);
            // B4: 挂 err.code='PARSE_ERROR' 供 Executor 分流(do_not_retry),覆盖原字符串匹配漏项
            pending.reject(Object.assign(new Error(`JSON parse error in editor response: ${getErrorMessage(err)}`), { code: 'PARSE_ERROR' }));
          }
        }
      }
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        // B4: ConnectionError 自带 code='NOT_CONNECTED'(ToolError 字段)供 Executor 分流(do_not_retry)。
        reject(new ConnectionError());
        return;
      }
      // Increment and wrap (ID 0 is reserved/skipped to avoid falsy confusion).
      // Wrapping at MAX_SAFE_INTEGER is safe — in practice unreachable (would need
      // ~9 quadrillion requests). The modulo ensures we never overflow.
      let candidate = (this.requestId + 1) % Number.MAX_SAFE_INTEGER;
      if (candidate === 0) candidate = 1;
      let attempts = 0;
      while (this.pending.has(candidate) && attempts < 1000) {
        candidate = (candidate + 1) % Number.MAX_SAFE_INTEGER;
        if (candidate === 0) candidate = 1;
        attempts++;
      }
      if (attempts >= 1000) {
        // A-03: 附加当前 pending 数量信息帮助调试
        reject(new Error(`No available request IDs — too many pending requests (pending.size=${this.pending.size})`));
        return;
      }
      const id = this.requestId = candidate;
      // B3: 心跳等活性检测传独立短超时(options.timeoutMs),默认回退业务 requestTimeoutMs(30s)。
      // 差异化理由:心跳 ping 失败目的是"快速发现卡死",业务请求用长超时是"容忍慢操作"。
      const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // B4: 挂 err.code='REQUEST_TIMEOUT' 供 Executor 分流(do_not_retry)
        reject(Object.assign(new Error(`Request timeout: ${method}`), { code: 'REQUEST_TIMEOUT' }));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.ws.send(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Send failed: ${(e as Error).message}`));
      }
    });
  }

  /**
   * Send a fire-and-forget notification to the editor plugin.
   *
   * NOTE: This is currently unused but retained as a future-facing API.
   * When adopting it for critical state changes (e.g. scene-tree mutations),
   * consider using request() instead to guarantee delivery, or check
   * droppedNotifications > 0 after a batch of notify calls and trigger
   * a full scene-tree refresh if any were lost.
   */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.ws || !this.connected) throw new ConnectionError();
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch (err) {
      this._droppedNotifications++;
      getLogger().error('editor', `notify send failed (method=${method}, dropped=${this._droppedNotifications}): ${err}`);
    }
  }

  /** Number of notify() calls that failed to send since last check */
  get droppedNotifications(): number {
    return this._droppedNotifications;
  }

  /** Reset the dropped notification counter (call after consuming the value) */
  resetDroppedNotifications(): void {
    this._droppedNotifications = 0;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }
    this.notificationHandlers.get(method)!.add(handler);
  }

  offNotification(method: string, handler?: (params: unknown) => void): void {
    if (!this.notificationHandlers.has(method)) return;
    if (handler) {
      this.notificationHandlers.get(method)!.delete(handler);
    } else {
      this.notificationHandlers.delete(method);
    }
  }

  async startOperation(timeoutSec: number): Promise<unknown> {
    return this.request('operation_start', { timeout: Math.min(timeoutSec, 600) });
  }

  async endOperation(): Promise<unknown> {
    return this.request('operation_end', {});
  }

  /** 3A (2026-09-19 安全加固批3): challenge-response 握手编排。
   *
   *  防假监听者(H3):本机恶意进程先绑 9090/9081 可收到旧协议主动发送的明文 secret;
   *  proof 模式下 secret 永不上线路,对端只能收到 HMAC(对单次 challenge 有效)——拿不到
   *  secret 本身,无法连真插件横向复用。
   *
   *  降级矩阵(兼容矩阵的关键风险控制):
   *  - 实例记忆 _useLegacyAuth=true → 直接明文(旧端已确认,免每次探测)
   *  - auth_begin 收到 JSON-RPC error 响应(err.code 为 number,对端至少是真 JSON-RPC
   *    服务端——旧插件回 -32001 后 close)→ 记忆降级 + warn。
   *    [已知残余面]协议感知的假监听者可伪造 -32001 诱降级收 secret——localhost 明文
   *    模型下不可根除,设 GODOT_MCP_EDITOR_REQUIRE_CR_AUTH=true 硬锁可拒一切降级。
   *  - 探测超时(哑占位者不回应)→ **不降级**直接 fail(secret 不上线)。
   *  - GODOT_MCP_EDITOR_REQUIRE_CR_AUTH=true → 非成功 challenge 路径一律 fail。 */
  private async performAuth(): Promise<void> {
    if (this._useLegacyAuth) return this.legacyPlaintextAuth();
    if (!this.ws || !this.editorSecret) {
      throw new ConnectionError('Cannot authenticate: not connected or no secret');
    }
    try {
      await this.challengeResponseAuth();
      return;
    } catch (err) {
      const e = err as Error & { crFallback?: boolean };
      if (this.requireCrAuth()) {
        throw new ConnectionError(
          `challenge-response auth required (GODOT_MCP_EDITOR_REQUIRE_CR_AUTH=true) but handshake failed: ${e.message}`);
      }
      if (e.crFallback === true) {
        this._useLegacyAuth = true;
        getLogger().warn('editor',
          'auth_begin rejected/invalid peer response — falling back to legacy plaintext auth ' +
          '(editor 插件版本过旧?). secret 将明文经 ws:// 传输(localhost 模型);' +
          'N-2(审查): _useLegacyAuth 为实例级降级记忆且不复位,升级插件后需**重启 MCP server**才恢复 proof 模式. ' +
          '[已知残余面]协议感知的假监听者可伪造响应诱降级收 secret——GODOT_MCP_EDITOR_REQUIRE_CR_AUTH=true 可硬锁.');
        return this.legacyPlaintextAuth();
      }
      throw new ConnectionError(
        `challenge-response auth failed without a usable peer response (${e.message}) — ` +
        `不降级(防哑占位者收 secret)。检查 editor 插件版本/端口占用;升级插件或重试.`);
    }
  }

  /** challenge-response 握手主体(auth_begin → challenge → HMAC proof)。
   *  可降级的失败(error 响应/无 challenge 的 result 响应)抛错挂 crFallback=true;
   *  超时/断连/proof 阶段失败不挂(不可降级)。 */
  private async challengeResponseAuth(): Promise<void> {
    const secret = this.editorSecret;
    if (!secret) throw new ConnectionError('Cannot authenticate: no secret');
    let beginRes: unknown;
    try {
      beginRes = await this.request('auth_begin', {}, { timeoutMs: AUTH_BEGIN_PROBE_TIMEOUT_MS });
    } catch (beginErr) {
      const be = beginErr as Error & { code?: unknown };
      // string code = 本地故障(超时'REQUEST_TIMEOUT'/断连'DISCONNECTED'),非对端响应 → 不可降级
      if (typeof be.code === 'string') throw beginErr;
      throw Object.assign(
        new Error(`auth_begin rejected by peer (code=${String(be.code)}): ${be.message}`),
        { crFallback: true },
      );
    }
    const challenge = (beginRes as { challenge?: unknown } | null)?.challenge;
    if (typeof challenge !== 'string' || challenge.length < 16) {
      // 有 result 响应但无 challenge:非本协议的 JSON-RPC 服务端(旧端/异构端)→ 可降级
      throw Object.assign(new Error('auth_begin response missing/short challenge'), { crFallback: true });
    }
    // proof 阶段失败直接上抛(无 crFallback 标记 → 不降级:secret 错再发明文只会多泄露一次)
    const proof = createHmac('sha256', secret).update(challenge, 'utf8').digest('hex');
    await this.request('auth_proof', { proof });
    this.authenticated = true;
  }

  /** 强制 challenge-response 模式(高安全 opt-in):拒绝一切明文降级。 */
  private requireCrAuth(): boolean {
    return process.env.GODOT_MCP_EDITOR_REQUIRE_CR_AUTH === 'true'
      || process.env.GODOT_MCP_REQUIRE_CR_AUTH === 'true';
  }

  /** 旧明文 auth 握手(id=-1,单发 secret)——proof 模式探测失败后的降级路径,原 performAuth 逻辑原样保留。 */
  private legacyPlaintextAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.editorSecret) {
        reject(new ConnectionError('Cannot authenticate: not connected or no secret'));
        return;
      }
      let settled = false;
      const authTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(AUTH_REQUEST_ID);
        this.connectAttempt = true; // Prevent close handler from scheduling reconnect
        reject(new Error('Auth handshake timeout'));
        this.ws?.close();
      }, this.authTimeoutMs);

      // I-01: Use id=-1 for auth (negative IDs never conflict with normal requests)
      this.pending.set(AUTH_REQUEST_ID, {
        resolve: (_result: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(authTimeout);
          this.authenticated = true;
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(authTimeout);
          reject(err);
        },
        timer: authTimeout,
      });

      try {
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: AUTH_REQUEST_ID,
          method: 'auth',
          params: { secret: this.editorSecret },
        }));
      } catch (e) {
        clearTimeout(authTimeout);
        this.pending.delete(AUTH_REQUEST_ID);
        reject(new Error(`Auth send failed: ${(e as Error).message}`));
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled) return;  // D2: disconnect()/exhaust 后不再重连(catch 分支调本方法时也要拦)
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      getLogger().error('editor', `Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      this.reconnectEnabled = false;
      // I-04: Fire dedicated exhaustion handlers instead of relying on fireDisconnect dedup.
      // This ensures consumers (e.g. GodotServer) always get notified when reconnect is exhausted,
      // regardless of whether fireDisconnect was already called by ws.on('close').
      this.fireReconnectExhausted();
      return;
    }
    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectMs,
    );
    // D2: 加 jitter 防多实例同时重连风暴(thundering herd)
    const delay = base + Math.floor(Math.random() * this.reconnectBaseMs);
    this.reconnectAttempt++;
    getLogger().warn('editor', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        getLogger().info('editor', 'Reconnected');
      } catch (err) {
        getLogger().warn('editor', `reconnect failed: ${getErrorMessage(err)}`);
        // Re-schedule next attempt so the reconnect chain doesn't break
        this.scheduleReconnect();
      }
    }, delay);
    // F-7: unref 长生命周期重连定时器,避免阻止 Node 优雅退出(与 gdscript-executor _cleanupTimer.unref() 一致)
    this.reconnectTimer?.unref();
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    this.connectGeneration++;  // ipc P1-4: 让进行中的 connect() 过期(open 检查 gen 不等 -> 丢弃)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      // B4: 挂 err.code='DISCONNECTED' 供 Executor 分流(do_not_retry),覆盖原字符串匹配漏项
      pending.reject(Object.assign(new Error('Disconnected'), { code: 'DISCONNECTED' }));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    // IM-5: clear handler Sets so closures (holding GodotServer refs) can be GC'd
    this.disconnectHandlers.clear();
    this.reconnectHandlers.clear();
    this.reconnectExhaustedHandlers.clear();
  }

  /**
   * Reset reconnect state so that a subsequent `connect()` can re-enable
   * reconnection. This is useful after max-reconnect-attempts was reached
   * and you want to retry later.
   */
  resetReconnectState(): void {
    this.reconnectAttempt = 0;
    this.reconnectEnabled = this.shouldReconnect;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 手动触发重连：重置耗尽状态(reconnectEnabled/attempt)并启动后台重连循环。
   * 用于 manage_tools(reconnect) 在 connect 一次性失败后,让编辑器恢复时自动连上,
   * 避免用户须反复手动调 reconnect 或重启 MCP 服务端(反馈 reconnecting 卡死)。
   */
  requestReconnect(): void {
    this.resetReconnectState();
    if (!this.connected && !this.reconnectTimer) {
      this.scheduleReconnect();
    }
  }

  /**
   * B8: 连接活性语义说明。
   * 仅反映 ws 'open'/'close' 事件后的 connected flag, 非TCP 实时活性——
   * TCP 半开(对端 accept 不响应不 close)时此方法仍返回 true。
   * 实时活性检测见 HealthMonitor 心跳(health-monitor.ts startHeartbeat + ping)。
   */
  isConnected(): boolean {
    return this.connected;
  }
}
