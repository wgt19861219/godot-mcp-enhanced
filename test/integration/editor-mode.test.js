import { expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { EditorConnection } from '../../src/core/EditorConnection.js';
import { EditorToolExecutor } from '../../src/core/EditorToolExecutor.js';
import { ReadOnlyGuard } from '../../src/core/ReadOnlyGuard.js';
import { registerTools } from '../../src/core/tool-registry.js';

describe('Editor mode integration', () => {
  let wss;
  let port;

  beforeEach(() => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
    ]);
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => { wss.close(); });

  it('full flow: connect, call tool, guard readonly, disconnect', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { node_path: 'root/Player' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    expect(conn.isConnected()).toBeTruthy();

    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('add_node', { project_path: '/test', node_type: 'Sprite2D', node_name: 'Player' });
    expect(result.isError).not.toBe(true);

    const guard = new ReadOnlyGuard(true);
    expect(guard.check('add_node').blocked).toBe(true);
    expect(guard.check('read_scene').blocked).toBe(false);

    conn.disconnect();
    expect(!conn.isConnected()).toBeTruthy();
  });

  it('handles concurrent requests with unique IDs', async () => {
    const received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push({ id: msg.id, method: msg.method });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const results = await Promise.all([
      executor.execute('read_scene', {}),
      executor.execute('add_node', {}),
    ]);
    expect(results.length).toBe(2);
    // 3A (2026-09-19 批3): echo mock 无 challenge → 握手序列为 auth_begin(探测)+auth(id=-1 明文降级);
    // 认证消息(明文 auth + auth_begin 探测)过滤后剩工具调用,二者 id 唯一
    const toolIds = received.filter(m => m.method !== 'auth' && m.method !== 'auth_begin').map(m => m.id);
    expect(new Set(toolIds).size).toBe(2);
    conn.disconnect();
  });
});
