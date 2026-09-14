// Task 6(设计 §3.4/§5):WebGuiServer HTTP 骨架——静态 HTML + /api/sessions +
// token/Origin 四象限鉴权 + 端口避让 + isWebGuiActive 复位。
// registryDir 注入 temp 目录隔离登记文件,不污染真实 ~/.godot-mcp/web-gui/。

import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { WebGuiServer, isWebGuiActive } from '../../src/web-gui/server.js';
import type { RunSessionDetailed } from '../../src/core/process-state.js';

const FAKE_SESSIONS: RunSessionDetailed[] = [{
  projectPath: 'd:/a', displayPath: 'D:/a', status: 'running', pid: 42,
  processStartTime: 1, busy: false, busyOwner: '', busySince: 0, outputLines: 3,
}];
const FAKE_HTML = '<!doctype html><html><body>gui</body></html>';

let registryDir = '';

async function startTestServer(portStart = 0): Promise<{ srv: WebGuiServer; base: string; token: string }> {
  const srv = new WebGuiServer({
    getSessions: () => FAKE_SESSIONS,
    getIndexHtml: () => FAKE_HTML,
    portStart,
    registryDir,
  });
  await srv.start();
  return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
}

describe('WebGuiServer HTTP+鉴权(设计 §3.4/§5)', () => {
  let active: WebGuiServer | null = null;
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  beforeAll(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-server-test-'));
  });
  afterAll(async () => {
    if (registryDir) await rm(registryDir, { recursive: true, force: true });
  });

  it('GET / 返回注入的 HTML + nosniff + CSP 头(无 token 要求)', async () => {
    const t = await startTestServer(); active = t.srv;
    const res = await fetch(t.base + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FAKE_HTML);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBeNull();   // 不发任何 CORS 头
  });

  it('错 token 401;对 token(无 Origin,模拟 curl)放行 /api/sessions', async () => {
    const t = await startTestServer(); active = t.srv;
    const bad = await fetch(`${t.base}/api/sessions?token=wrong`);
    expect(bad.status).toBe(401);
    const ok = await fetch(`${t.base}/api/sessions?token=${t.token}`);
    expect(ok.status).toBe(200);
    const list = await ok.json() as RunSessionDetailed[];
    expect(list[0]!.pid).toBe(42);
    expect(list[0]).not.toHaveProperty('proc');
  });

  it('X-GUI-Token 头鉴权 + 伪造 Origin 403', async () => {
    const t = await startTestServer(); active = t.srv;
    const viaHeader = await fetch(t.base + '/api/sessions', { headers: { 'x-gui-token': t.token } });
    expect(viaHeader.status).toBe(200);
    const evil = await fetch(`${t.base}/api/sessions?token=${t.token}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
  });

  it('端口避让:起点被占时 +1', async () => {
    const squat = net.createServer();
    await new Promise<void>(r => squat.listen(9561, '127.0.0.1', r));
    const t = await startTestServer(9561); active = t.srv;
    expect(t.srv.port).toBe(9562);
    await active!.stop(); active = null;
    squat.close();
  });

  it('isWebGuiActive 随 start/stop 翻转(真实实例驱动复位,设计 N-2)', async () => {
    expect(isWebGuiActive()).toBe(false);
    const t = await startTestServer(); active = t.srv;
    expect(isWebGuiActive()).toBe(true);
    await active.stop(); active = null;
    expect(isWebGuiActive()).toBe(false);
  });
});

describe('cookie 双通道(/api/auth 握手 Set-Cookie + cookie 通道鉴权)', () => {
  let active: WebGuiServer | null = null;
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  beforeAll(async () => {
    // 复用模块级 registryDir(上个 describe 的 afterAll 已 rm,这里重开隔离目录)
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-cookie-test-'));
  });
  afterAll(async () => {
    if (registryDir) await rm(registryDir, { recursive: true, force: true });
  });

  it('/api/auth 对 token → 200 {ok:true} + set-cookie(gui-token=/HttpOnly/SameSite=Strict)', async () => {
    const t = await startTestServer(); active = t.srv;
    const res = await fetch(`${t.base}/api/auth?token=${t.token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sc = res.headers.get('set-cookie');
    expect(sc).toContain('gui-token=');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).toContain('Path=/');
  });

  it('/api/auth 错 token / 缺 token → 401 且无 set-cookie', async () => {
    const t = await startTestServer(); active = t.srv;
    const bad = await fetch(`${t.base}/api/auth?token=wrong`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const none = await fetch(`${t.base}/api/auth`);
    expect(none.status).toBe(401);
    expect(none.headers.get('set-cookie')).toBeNull();
  });

  it('cookie 通道鉴权:对 cookie(无 query 无 X-GUI-Token)访问 /api/sessions → 200;错 cookie 值 → 401', async () => {
    const t = await startTestServer(); active = t.srv;
    const ok = await fetch(`${t.base}/api/sessions`, { headers: { cookie: `gui-token=${t.token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RunSessionDetailed[])[0]!.pid).toBe(42);
    const bad = await fetch(`${t.base}/api/sessions`, { headers: { cookie: 'gui-token=deadbeef' } });
    expect(bad.status).toBe(401);
  });
});
