// src/core/EditorConnection.ts
import WebSocket from 'ws';

interface EditorConnectionOptions {
  port: number;
  host?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  connectTimeout?: number;
  requestTimeout?: number;
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

  public onDisconnect: (() => void) | null = null;

  private readonly host: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private reconnectAttempt = 0;

  constructor(private readonly options: EditorConnectionOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.shouldReconnect = options.reconnect ?? true;
    this.reconnectEnabled = this.shouldReconnect;
    this.reconnectBaseMs = options.reconnectInterval ?? 1000;
    this.maxReconnectMs = options.maxReconnectInterval ?? 60000;
    this.connectTimeoutMs = options.connectTimeout ?? 10000;
    this.requestTimeoutMs = options.requestTimeout ?? 30000;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.options.port}`;
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout to ${url}`));
        ws.terminate();
      }, this.connectTimeoutMs);

      const ws = new WebSocket(url);
      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.setupMessageHandler();
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
        this.notificationHandlers.clear();
        this.onDisconnect?.();
        if (this.reconnectEnabled) this.scheduleReconnect();
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
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
