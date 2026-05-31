// src/core/EditorConnection.ts
import WebSocket from 'ws';

// Auth uses a dedicated id outside the normal requestId sequence to avoid conflicts
const AUTH_REQUEST_ID = -1;
const MAX_INBOUND_MESSAGE_SIZE = 1048576; // 1MB
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCKOUT_MS = 300_000; // 5 minutes

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

  private disconnectHandlers = new Set<() => void>();
  private reconnectHandlers = new Set<() => void>();

  /** Track dropped notify() calls so callers can detect stale scene-tree state */
  private _droppedNotifications = 0;

  /** Guard against duplicate fireDisconnect() calls */
  private _disconnectFired = false;

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

  private fireDisconnect(): void {
    if (this._disconnectFired) return;
    this._disconnectFired = true;
    for (const handler of this.disconnectHandlers) handler();
  }

  private fireReconnect(): void {
    for (const handler of this.reconnectHandlers) handler();
  }

  private readonly host: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts: number;
  private readonly editorSecret: string | null;
  private authenticated = false;
  private authFailureCount = 0;
  private authLockoutUntil = 0;

  constructor(private readonly options: EditorConnectionOptions) {
    this.host = options.host ?? '127.0.0.1';
    // A-05: Reject non-localhost hosts — WebSocket auth is plaintext (no TLS)
    if (this.host !== '127.0.0.1' && this.host !== 'localhost' && this.host !== '::1') {
      throw new Error(`Editor WebSocket only supports localhost connections for security (got: ${this.host})`);
    }
    this.shouldReconnect = options.reconnect ?? true;
    this.reconnectEnabled = this.shouldReconnect;
    this.reconnectBaseMs = options.reconnectInterval ?? 1000;
    this.maxReconnectMs = options.maxReconnectInterval ?? 60000;
    this.connectTimeoutMs = options.connectTimeout ?? 10000;
    this.requestTimeoutMs = options.requestTimeout ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
    this.editorSecret = options.secret ?? null;
  }

  async connect(): Promise<void> {
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
      const timer = setTimeout(() => {
        ws.removeAllListeners();
        ws.terminate();
        reject(new Error(`Connection timeout to ${url}`));
      }, this.connectTimeoutMs);

      const ws = new WebSocket(url);
      ws.on('open', async () => {
        clearTimeout(timer);
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
            reject(new Error(`Auth locked out: too many failures. Retry in ${remaining}s`));
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
          } catch (authErr) {
            this.authFailureCount++;
            if (this.authFailureCount >= MAX_AUTH_FAILURES) {
              this.authLockoutUntil = Date.now() + AUTH_LOCKOUT_MS;
              console.error(`[AUTH] Locked out for ${AUTH_LOCKOUT_MS / 1000}s after ${MAX_AUTH_FAILURES} failures`);
            }
            this.connected = false;
            this.connectAttempt = true;
            this.ws = null;
            ws.removeAllListeners();
            ws.terminate();
            reject(authErr);
            return;
          }
        } else {
          // No secret configured — reject connection for security
          this.connected = false;
          this.ws = null;
          ws.removeAllListeners();
          ws.terminate();
          reject(new Error('Editor auth required but no secret configured. Install the editor plugin.'));
          return;
        }
        const isReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        if (isReconnect) {
          this.fireReconnect();
        }
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        // Reject all pending requests — they will never receive a response
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection lost'));
        }
        this.pending.clear();
        // Don't clear notificationHandlers — they need to survive reconnect
        const wasConnected = !this.connectAttempt;
        this.fireDisconnect();
        if (wasConnected && this.reconnectEnabled) this.scheduleReconnect();
        this.connectAttempt = false;
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;
    this.ws.on('message', (data: WebSocket.Data) => {
      const raw = typeof data === 'string' ? data : data.toString();
      try {
        if (Buffer.byteLength(raw, 'utf8') > MAX_INBOUND_MESSAGE_SIZE) {
          console.warn('[MCP Editor] Inbound message exceeds size limit, discarding');
          return;
        }
        const msg = JSON.parse(raw);
        // A-12: Validate msg.id is a number before using as pending lookup key
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method && msg.id == null) {
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers) {
            for (const handler of handlers) {
              handler(msg.params);
            }
          }
        }
      } catch (err) {
        const snippet = typeof raw === 'string' ? raw.substring(0, 200) : '(unavailable)';
        console.warn('[editor-conn] parse WebSocket message:', (err as Error).message, 'raw:', snippet);
        // Attempt to extract id from malformed JSON and reject the pending request
        const idMatch = raw.match(/"id"\s*:\s*(\d+)/);
        if (idMatch) {
          const badId = Number(idMatch[1]);
          const pending = this.pending.get(badId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(badId);
            pending.reject(new Error(`JSON parse error in editor response: ${(err as Error).message}`));
          }
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Not connected'));
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
        reject(new Error('No available request IDs — too many pending requests'));
        return;
      }
      const id = this.requestId = candidate;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.requestTimeoutMs);

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
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.ws || !this.connected) throw new Error('Not connected');
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch (err) {
      this._droppedNotifications++;
      console.error('[EditorConnection] notify send failed (method=%s, dropped=%d):', method, this._droppedNotifications, err);
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

  private performAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.editorSecret) {
        reject(new Error('Cannot authenticate: not connected or no secret'));
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
      }, 10000);

      // Use id=0 for auth (matches plugin expectation)
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
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      console.error(`[EditorConnection] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      this.reconnectEnabled = false;
      this.fireDisconnect();
      return;
    }
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectMs,
    );
    this.reconnectAttempt++;
    console.error(`[EditorConnection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.error('[EditorConnection] Reconnected');
      } catch (err) {
        console.warn('[EditorConnection] reconnect failed:', err);
      }
    }, delay);
  }

  disconnect(): void {
    this.reconnectEnabled = false;
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
      pending.reject(new Error('Disconnected'));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
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

  isConnected(): boolean {
    return this.connected;
  }
}
