// src/core/EditorConnection.ts
import WebSocket from 'ws';

// Auth uses a dedicated id outside the normal requestId sequence to avoid conflicts
const AUTH_REQUEST_ID = -1;
const MAX_INBOUND_MESSAGE_SIZE = 1048576; // 1MB

interface EditorConnectionOptions {
  port: number;
  host?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  connectTimeout?: number;
  requestTimeout?: number;
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

  public onDisconnect: (() => void) | null = null;
  public onReconnect: (() => void) | null = null;

  private readonly host: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private reconnectAttempt = 0;
  private readonly editorSecret: string | null;
  private authenticated = false;

  constructor(private readonly options: EditorConnectionOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.shouldReconnect = options.reconnect ?? true;
    this.reconnectEnabled = this.shouldReconnect;
    this.reconnectBaseMs = options.reconnectInterval ?? 1000;
    this.maxReconnectMs = options.maxReconnectInterval ?? 60000;
    this.connectTimeoutMs = options.connectTimeout ?? 10000;
    this.requestTimeoutMs = options.requestTimeout ?? 30000;
    this.editorSecret = options.secret ?? null;
  }

  async connect(): Promise<void> {
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
        // C-3: Reset reconnectEnabled on successful connection
        this.reconnectEnabled = this.shouldReconnect;
        this.setupMessageHandler();
        if (this.editorSecret) {
          try {
            await this.performAuth();
          } catch (authErr) {
            this.connected = false;
            this.ws = null;
            ws.removeAllListeners();
            ws.terminate();
            reject(authErr);
            return;
          }
        }
        const isReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        if (isReconnect) {
          this.onReconnect?.();
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
        this.onDisconnect?.();
        if (wasConnected && this.reconnectEnabled) this.scheduleReconnect();
        this.connectAttempt = false;
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        if (raw.length > MAX_INBOUND_MESSAGE_SIZE) {
          console.warn('[MCP Editor] Inbound message exceeds size limit, discarding');
          return;
        }
        const msg = JSON.parse(raw);
        if (msg.id != null && this.pending.has(msg.id)) {
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
      } catch { /* non-JSON or malformed — silently skip */ }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++this.requestId;
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

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.ws || !this.connected) throw new Error('Not connected');
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      // best effort — notification has no response
    }
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
      const authTimeout = setTimeout(() => {
        this.pending.delete(AUTH_REQUEST_ID);
        reject(new Error('Auth handshake timeout'));
        this.ws?.close();
      }, 10000);

      // Use id=0 for auth (matches plugin expectation)
      this.pending.set(AUTH_REQUEST_ID, {
        resolve: (result: unknown) => {
          clearTimeout(authTimeout);
          this.authenticated = true;
          resolve();
        },
        reject: (err: Error) => {
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
      } catch {
        // close handler will schedule next reconnect
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

  isConnected(): boolean {
    return this.connected;
  }
}
