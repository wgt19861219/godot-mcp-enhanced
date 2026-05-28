import { expect } from 'vitest';
import { EditorToolExecutor } from '../src/core/EditorToolExecutor.js';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorToolExecutor', () => {
  let wss;
  let port;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
  });

  it('forwards tool call as JSON-RPC and returns result', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { node_path: 'root/Player' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('add_node', {
      project_path: '/test',
      scene_path: 'res://main.tscn',
      node_type: 'Sprite2D',
      node_name: 'Player',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ node_path: 'root/Player' });
    conn.disconnect();
  });

  it('handles JSON-RPC error from plugin', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Node not found' } }));
        }
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('edit_node', { node_path: 'root/Missing' });
    expect(result.isError).toBe(true);
    conn.disconnect();
  });
});
