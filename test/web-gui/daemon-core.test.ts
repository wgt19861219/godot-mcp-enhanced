// test/web-gui/daemon-core.test.ts
// daemon 批 A(2026-09-30 spec §3.3):Task 2——GodotServer transport 参数化用例。
// Task 3(WebGuiServer strictPort/instanceKind/mcpHandler + registry kind)追加于后。
//
// 批 A 审查 N-2 处置:ServerOptions 的 processMode/mcpHandler 死字段已删——daemon 与
// stdio 的差异走入口组装(daemon 不调 run(),src/daemon/main.ts 自走 buildWebGuiOptions
// 工厂 + connectTransport),GodotServer 构造参数两侧一致。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Transport } from '@modelcontextprotocol/server';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GodotServer } from '../../src/GodotServer.js';
import { WebGuiServer } from '../../src/web-gui/server.js';
import type { RunSessionDetailed } from '../../src/core/process-state.js';

describe('GodotServer transport 参数化(daemon 批 A)', () => {
  it('connectTransport 接受外部 transport 并 connect', async () => {
    const server = new GodotServer('res://ops.gd');
    const fake = { start: vi.fn(), send: vi.fn(), close: vi.fn() };
    await server.connectTransport(fake as unknown as Transport);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it('connectTransport 不碰 process.stdin(daemon 纪律:注入点不注册 stdin-end 钩子)', async () => {
    const server = new GodotServer('res://ops.gd');
    const fake = { start: vi.fn(), send: vi.fn(), close: vi.fn() };
    const before = process.stdin.listenerCount('end');
    await server.connectTransport(fake as unknown as Transport);
    // daemon/stdio 的 stdin 钩子差异在入口层(index.ts,stdio 注册/daemon 不注册,Task 5);
    // 注入点本身必须 stdin 无感——否则 daemon 传 HTTP transport 也会被 stdio 自杀钩子拖死。
    expect(process.stdin.listenerCount('end')).toBe(before);
  });
});

// ── Task 3(daemon 批 A spec §3.4/M-2):WebGuiServer 三个注入点 ──────────────
// strictPort(respawn 交接端口不漂移不变式)/ instanceKind(registry kind 登记)/
// mcpHandler(/mcp 三方法路由,web-gui 不 import MCP SDK 的分层兑现)。
// 端口选择高位段(19551/19561)避开 CSP+ACAO 白名单端口段(9550-9569)的真实实例面。
describe('WebGuiServer strictPort / instanceKind / mcpHandler(daemon 批 A)', () => {
  const NO_SESSIONS: RunSessionDetailed[] = [];
  const FAKE_HTML = '<!doctype html><html><body>gui</body></html>';
  const TOKEN = 'task3-tok-0123456789abcdef0123456789';
  let registryDir = '';

  beforeAll(async () => { registryDir = await mkdtemp(join(tmpdir(), 'web-gui-daemon-core-')); });
  afterAll(async () => { if (registryDir) await rm(registryDir, { recursive: true, force: true }); });

  it('strictPort:端口被占时 start() 直接 reject EADDRINUSE(不静默顺延)', async () => {
    const holder = net.createServer();
    await new Promise<void>(r => holder.listen(19551, '127.0.0.1', r));
    const gui = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 19551, strictPort: true, token: TOKEN, registryDir,
    });
    // reject 消息须含 EADDRINUSE(respawn 交接失败要能区分"端口被占"与"其他启动故障")
    await expect(gui.start()).rejects.toThrow(/EADDRINUSE/);
    holder.close();
  });

  it('非 strictPort(缺省):行为不变——起点被占时顺延到下一端口', async () => {
    const first = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 19561, token: TOKEN, registryDir,
    });
    await first.start();
    expect(first.port).toBe(19561);
    const second = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 19561, token: TOKEN, registryDir,
    });
    await second.start();
    expect(second.port).toBe(19562);
    await second.stop();
    await first.stop();
  });

  it('mcpHandler 注入:POST/GET/DELETE /mcp 三方法均路由到 handler', async () => {
    const gui = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 0, token: TOKEN, registryDir,
      mcpHandler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`ok:${req.method}`);
      },
    });
    await gui.start();
    const base = `http://127.0.0.1:${gui.port}/mcp`;
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const res = await fetch(base, { method });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`ok:${method}`);
    }
    // 非 Streamable HTTP 方法面(PUT)不路由到 handler:落通用非 GET 405 语义
    const put = await fetch(base, { method: 'PUT' });
    expect(put.status).toBe(405);
    await gui.stop();
  });

  it('mcpHandler 未注入:POST /mcp 返回 404(端点不活跃,不走面板鉴权链)', async () => {
    const gui = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 0, token: TOKEN, registryDir,
    });
    await gui.start();
    const res = await fetch(`http://127.0.0.1:${gui.port}/mcp`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'mcp endpoint not active' });
    await gui.stop();
  });

  it('instanceKind:"daemon" 登记进 registry kind 字段;缺省不写 kind(旧实例语义)', async () => {
    const daemonGui = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 0, token: TOKEN, registryDir, instanceKind: 'daemon',
    });
    await daemonGui.start();
    // start() resolve 即 writeRegistration 落盘完成;同 pid 登记文件名 <pid>.json
    const raw = JSON.parse(readFileSync(join(registryDir, `${process.pid}.json`), 'utf-8')) as { kind?: string };
    expect(raw.kind).toBe('daemon');
    await daemonGui.stop();

    const stdioGui = new WebGuiServer({
      getSessions: () => NO_SESSIONS, getIndexHtml: () => FAKE_HTML,
      portStart: 0, token: TOKEN, registryDir,   // 不传 instanceKind = 缺省 stdio
    });
    await stdioGui.start();
    const raw2 = JSON.parse(readFileSync(join(registryDir, `${process.pid}.json`), 'utf-8')) as { kind?: string };
    expect(raw2.kind).toBeUndefined();
    await stdioGui.stop();
  });
});
