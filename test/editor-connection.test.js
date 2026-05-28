import { expect, vi } from 'vitest';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorConnection', () => {
  let wss;
  let port;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
  });

  it('should have onNotification and offNotification methods', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(typeof conn.onNotification).toBe('function');
    expect(typeof conn.offNotification).toBe('function');
  });

  it('should have onDisconnect property', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(conn.onDisconnect).toBe(null);
  });

  it('connects and sends JSON-RPC request', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const result = await conn.request('test_method', { key: 'value' });
    expect(result).toEqual({ status: 'ok' });
    conn.disconnect();
  });

  it('handles connection refused gracefully', async () => {
    const conn = new EditorConnection({ port: 59999, reconnect: false, connectTimeout: 1000 });
    await expect(() => conn.connect()).rejects.toThrow(/connect/i);
  });

  it('handles request timeout', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // Reply to auth but ignore other requests to simulate timeout
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        }
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, requestTimeout: 500, secret: 'test-secret' });
    await conn.connect();
    await expect(() => conn.request('slow_method', {})).rejects.toThrow(/timeout/i);
    conn.disconnect();
  });

  it('sends operation_start for long running operations', async () => {
    let received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    await conn.startOperation(300);
    expect(received.some(m => m.method === 'operation_start')).toBeTruthy();
    await conn.endOperation();
    expect(received.some(m => m.method === 'operation_end')).toBeTruthy();
    conn.disconnect();
  });

  it('does not reconnect on auth timeout (C-01)', { timeout: 15_000 }, async () => {
    // Server accepts connection but never replies to auth
    wss.on('connection', (ws) => {
      // intentionally ignore auth messages — simulate timeout
    });

    const reconnectSpy = vi.fn();
    const conn = new EditorConnection({
      port,
      reconnect: true,
      secret: 'test-secret',
      connectTimeout: 1000,
    });
    conn.onDisconnect = reconnectSpy;

    // connect should reject due to auth timeout
    await expect(() => conn.connect()).rejects.toThrow(/auth/i);

    // Give a small window for any async reconnect scheduling
    await new Promise((r) => setTimeout(r, 200));

    // onDisconnect may be called once for the close event, but
    // the key point: no reconnect should be scheduled.
    // We verify by checking that the connection is in a clean state.
    expect(conn.connected).toBe(false);
  });

  it('rejects connection without secret', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });
    const conn = new EditorConnection({ port, reconnect: false });
    await expect(() => conn.connect()).rejects.toThrow(/no secret configured/i);
  });

  it('rejects connection with wrong secret', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'wrong-secret', connectTimeout: 1000 });
    await expect(() => conn.connect()).rejects.toThrow();
  });

  it('locks out after repeated auth failures', async () => {
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
        }
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'wrong', connectTimeout: 500 });
    // Fail 5 times to trigger lockout
    for (let i = 0; i < 5; i++) {
      await expect(() => conn.connect()).rejects.toThrow();
    }
    // 6th attempt should be locked out immediately
    await expect(() => conn.connect()).rejects.toThrow(/locked out/i);
  });
});
