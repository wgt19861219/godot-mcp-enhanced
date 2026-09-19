// Task 6(设计 §3.4/§5):WebGuiServer HTTP 骨架——静态 HTML + /api/sessions +
// token/Origin 四象限鉴权 + 端口避让 + isWebGuiActive 复位。
// registryDir 注入 temp 目录隔离登记文件,不污染真实 ~/.godot-mcp/web-gui/。
// 面板控制第一版(2026-09-14 批准设计):POST /api/sessions/stop + /api/sessions/remove。

import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { WebGuiServer, isWebGuiActive, WEB_GUI_CSP, type WebGuiServerOptions } from '../../src/web-gui/server.js';
import { rotateSharedToken } from '../../src/web-gui/registry.js';
import { INDEX_HTML } from '../../src/web-gui/html.js';
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
    expect(res.headers.get('cache-control')).toBe('no-store');   // 防浏览器缓存旧 HTML(2026-09-15 真机叠加因素)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBeNull();   // 不发任何 CORS 头
  });

  // ── CSP 加固(审查 Low,2026-09-17 批 3):script-src 去 'unsafe-inline' 改精确
  //    sha256 放行 INDEX_HTML 内联脚本;补 frame-ancestors 'none'。hash 提取以独立
  //    路径(split,非实现同款 regex)重算比对,防实现提取逻辑漂移。
  //    fix round 1(2026-09-17 主审 playwright 实证):浏览器对 inline script 的 hash
  //    **不剥前导换行**(含前导换行版 txMCHDj5… 与浏览器期望逐字节匹配;原剥前导
  //    换行实现 OZf9I8dd… 被真机 CSP violation 证伪)——独立重算同步含前导换行,
  //    并把真实浏览器算出的 hash 作为硬编码锚锁进测试,此后提取规则再漂移会被锚抓住。
  it('CSP 加固:script-src 含 sha256 且无 unsafe-inline;含 frame-ancestors;hash 与 INDEX_HTML 内联脚本独立重算一致 + 浏览器期望锚', () => {
    expect(WEB_GUI_CSP).toMatch(/script-src [^;]*'sha256-[A-Za-z0-9+/=]{43,44}'/);
    expect(WEB_GUI_CSP).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(WEB_GUI_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_GUI_CSP).toContain("style-src 'unsafe-inline'");   // 样式属性面保留(非脚本执行面)
    // 硬编码锚:playwright 打开真实面板实例,浏览器 console 报的期望 hash(2026-09-17 实证)
    // 易用性批5 (2026-09-19) 重锚:内联脚本 401 文案改动(「凭证已失效」→「需经 CLI 授权」)
    // 使 hash 变更;新 hash 由独立重算路径(下)与 server 实算 CSP 双向互证后锁入。
    // 安全加固批2 (2026-09-19) 二次重锚:2B token hash 通道(内联脚本加 location.hash
    // token 提取段)使 hash 变更;同款双通道互证后锁入。
    expect(WEB_GUI_CSP).toContain("'sha256-4EHDPVCTzyjJ29iZLnK+WcfXsyjac1MzfNRCn3Y3bmA='");
    // 独立重算:split 提取(实现用 exec regex),CRLF 归一但**含前导换行**(浏览器语义)
    const after = INDEX_HTML.split('<script>')[1] ?? '';
    const body = after.slice(0, after.indexOf('</script>')).replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(body).digest('base64');
    expect(WEB_GUI_CSP).toContain(`'sha256-${hash}'`);
    expect(hash).toBe('4EHDPVCTzyjJ29iZLnK+WcfXsyjac1MzfNRCn3Y3bmA=');   // 独立重算与锚互证
    // 响应头与导出常量一致(接线不漂移)
    expect(after.length).toBeGreaterThan(0);
  });

  it('GET / 响应头 CSP 与 WEB_GUI_CSP 常量逐字一致', async () => {
    const t = await startTestServer(); active = t.srv;
    const res = await fetch(t.base + '/');
    expect(res.headers.get('content-security-policy')).toBe(WEB_GUI_CSP);
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

  // M-1(2026-09-17 审查批):握手端点补 Origin 闸门——种 cookie 的端点不得响应
  // 非 127.0.0.1/localhost 本端口的浏览器源(DNS rebinding / 恶意页纵深防御)。
  it('/api/auth Origin 闸门(M-1):错 Origin 即使 token 正确也 403 且不种 cookie;合法 Origin 200', async () => {
    const t = await startTestServer(); active = t.srv;
    const evil = await fetch(`${t.base}/api/auth?token=${t.token}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('set-cookie')).toBeNull();
    const good = await fetch(`${t.base}/api/auth?token=${t.token}`, {
      headers: { origin: `http://127.0.0.1:${t.srv.port}` },
    });
    expect(good.status).toBe(200);
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

describe('POST 会话控制端点(面板控制第一版:stop + remove)', () => {
  let active: WebGuiServer | null = null;

  beforeAll(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-ctrl-test-'));
  });
  afterAll(async () => {
    if (registryDir) await rm(registryDir, { recursive: true, force: true });
  });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  type CtrlHooks = Partial<Pick<WebGuiServerOptions, 'stopSession' | 'removeSession'>>;

  async function startCtrlServer(hooks: CtrlHooks): Promise<{ srv: WebGuiServer; base: string; token: string }> {
    const srv = new WebGuiServer({
      getSessions: () => FAKE_SESSIONS,
      getIndexHtml: () => FAKE_HTML,
      portStart: 0,
      registryDir,
      ...hooks,
    });
    await srv.start();
    return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }

  function post(base: string, path: string, token: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'x-gui-token': token, 'content-type': 'application/json', ...extraHeaders },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('stop:注入 stopSession → 200 {ok:true},projectPath 原样传给回调,响应 JSON 头', async () => {
    const calls: string[] = [];
    const t = await startCtrlServer({ stopSession: async (p) => { calls.push(p); return { ok: true }; } });
    active = t.srv;
    const res = await post(t.base, '/api/sessions/stop', t.token, { projectPath: 'D:/projX' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(calls).toEqual(['D:/projX']);
  });

  it('stop:未注入 → 503 {error:"not configured"}', async () => {
    const t = await startCtrlServer({});
    active = t.srv;
    const res = await post(t.base, '/api/sessions/stop', t.token, { projectPath: 'D:/projX' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('写路径鉴权不放松:无 token → 401;对 token 带错 Origin → 403', async () => {
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }), removeSession: () => ({ ok: true }) });
    active = t.srv;
    const noToken = await fetch(`${t.base}/api/sessions/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"projectPath":"D:/x"}',
    });
    expect(noToken.status).toBe(401);
    const evilStop = await post(t.base, '/api/sessions/stop', t.token, { projectPath: 'D:/x' }, { origin: 'http://evil.example' });
    expect(evilStop.status).toBe(403);
    const evilRemove = await post(t.base, '/api/sessions/remove', t.token, { projectPath: 'D:/x' }, { origin: 'http://evil.example' });
    expect(evilRemove.status).toBe(403);
  });

  it('stop:reason not_found → 404;其他 reason → 500;回调抛错 → 500 {error}', async () => {
    const nf = await startCtrlServer({ stopSession: async () => ({ ok: false, reason: 'not_found' }) });
    active = nf.srv;
    const r1 = await post(nf.base, '/api/sessions/stop', nf.token, { projectPath: 'D:/gone' });
    expect(r1.status).toBe(404);
    await nf.srv.stop(); active = null;

    const weird = await startCtrlServer({ stopSession: async () => ({ ok: false, reason: 'weird' }) });
    active = weird.srv;
    const r2 = await post(weird.base, '/api/sessions/stop', weird.token, { projectPath: 'D:/x' });
    expect(r2.status).toBe(500);
    await weird.srv.stop(); active = null;

    const boom = await startCtrlServer({ stopSession: async () => { throw new Error('boom'); } });
    active = boom.srv;
    const r3 = await post(boom.base, '/api/sessions/stop', boom.token, { projectPath: 'D:/x' });
    expect(r3.status).toBe(500);
    expect(await r3.json()).toEqual({ error: 'boom' });
  });

  it('坏 JSON body → 400(两端点同判)', async () => {
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }), removeSession: () => ({ ok: true }) });
    active = t.srv;
    const stopRes = await post(t.base, '/api/sessions/stop', t.token, '{not-json');
    expect(stopRes.status).toBe(400);
    const removeRes = await post(t.base, '/api/sessions/remove', t.token, 'nope');
    expect(removeRes.status).toBe(400);
  });

  // ── readJsonBody 统一上限(审查 Low,2026-09-17 批 3):通用 JSON POST 64KB 预检 ──
  //    content-length 与 chunked(无 CL)两形态都拦;file save 的 600KB 语义独立保留
  //    (server-files.test.ts 锁定,此处通用端点只认 64KB)。
  it('通用 POST body >64KB(content-length 形式)→ 413;鉴权仍在预检之前(无 token 401 优先)', async () => {
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }) });
    active = t.srv;
    const big = await post(t.base, '/api/sessions/stop', t.token, { projectPath: 'D:/x', pad: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload too large' });
    // 鉴权先于预检:错 token + 超大 body → 401(不因 413 掩盖鉴权语义)
    const unauth = await fetch(t.base + '/api/sessions/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: 'D:/x', pad: 'x'.repeat(70 * 1024) }),
    });
    expect(unauth.status).toBe(401);
  });

  it('通用 POST chunked 无 content-length:累计超 64KB → 413(不整读进内存)', async () => {
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }) });
    active = t.srv;
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      // 原生 http 客户端不设 content-length → 自动 chunked(undici fetch 会补 CL)
      const req = http.request({
        host: '127.0.0.1', port: t.srv.port, path: '/api/sessions/stop', method: 'POST',
        headers: { 'x-gui-token': t.token, 'content-type': 'application/json' },
      }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode ?? 0 })); });
      req.on('error', reject);
      req.write('{"projectPath":"D:/x","pad":"');
      for (let i = 0; i < 70; i++) req.write('x'.repeat(1024));   // 累计 ~70KB,分块喂
      req.end('"}');
    });
    expect(res.status).toBe(413);
  });

  // ── 终审 R1(2026-09-18):readJsonBody 跨 chunk 多字节 UTF-8 ────────────────
  //    for-await 的每个 chunk 是 Buffer;旧实现 `raw += chunk` 触发逐段隐式
  //    toString('utf8') 解码,多字节序列(汉字 3 字节)跨 chunk 边界时被逐段替换为
  //    U+FFFD。U+FFFD 在 JSON 字符串内合法 → JSON.parse 成功 → 损坏内容静默落盘
  //    (file save 600KB 含中文注释文件是真实场景;64KB 默认路径共用同函数)。
  //    修复:Buffer[] 收集 + Buffer.concat 后一次解码。本用例把第一 chunk 末字节
  //    切在 '二'(E4 BA 8C)3 字节序列的首字节 E4 上,断言回调收到的字段与原文
  //    逐字相等(旧实现必红:'一' 后接 3 个 U+FFFD 再接 '三四…')。
  it('跨 chunk 多字节 UTF-8:汉字 3 字节序列跨 chunk 边界 → 解析值与原文逐字相等(终审 R1)', async () => {
    const seen: string[] = [];
    const t = await startCtrlServer({ stopSession: async (p) => { seen.push(p); return { ok: true }; } });
    active = t.srv;
    const cn = '一二三四五六七八九十';
    const payload = Buffer.from(JSON.stringify({ projectPath: cn }), 'utf8');
    // '{"projectPath":"' 为 16 个 ASCII 字节,'一'(E4 B8 80)占 3 字节;
    // 切点 20 → 第一块末字节 = '二' 的首字节 E4,第二块从 BA 8C 起。
    expect(payload.subarray(19, 22)).toEqual(Buffer.from('二', 'utf8'));   // 守卫:切点确落在 '二' 序列内
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      // 原生 http 客户端不设 content-length → 自动 chunked;write/end 各成独立
      // HTTP chunk frame,服务端 for-await 分两段 Buffer 收到(frame 边界 = data 边界)
      const req = http.request({
        host: '127.0.0.1', port: t.srv.port, path: '/api/sessions/stop', method: 'POST',
        headers: { 'x-gui-token': t.token, 'content-type': 'application/json; charset=utf-8' },
      }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode ?? 0 })); });
      req.on('error', reject);
      req.write(payload.subarray(0, 20));
      req.end(payload.subarray(20));
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([cn]);   // 逐字相等:任何 U+FFFD 损坏在此被抓住
  });

  it('remove:ok → 200;alive → 409 {error:"session is still running"};not_found → 404;未注入 → 503', async () => {
    const okSrv = await startCtrlServer({ removeSession: () => ({ ok: true }) });
    active = okSrv.srv;
    const okRes = await post(okSrv.base, '/api/sessions/remove', okSrv.token, { projectPath: 'D:/projY' });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });
    await okSrv.srv.stop(); active = null;

    const aliveSrv = await startCtrlServer({ removeSession: () => ({ ok: false, reason: 'alive' }) });
    active = aliveSrv.srv;
    const aliveRes = await post(aliveSrv.base, '/api/sessions/remove', aliveSrv.token, { projectPath: 'D:/projY' });
    expect(aliveRes.status).toBe(409);
    expect(await aliveRes.json()).toEqual({ error: 'session is still running' });
    await aliveSrv.srv.stop(); active = null;

    const nfSrv = await startCtrlServer({ removeSession: () => ({ ok: false, reason: 'not_found' }) });
    active = nfSrv.srv;
    const nfRes = await post(nfSrv.base, '/api/sessions/remove', nfSrv.token, { projectPath: 'D:/gone' });
    expect(nfRes.status).toBe(404);
    await nfSrv.srv.stop(); active = null;

    const noneSrv = await startCtrlServer({});
    active = noneSrv.srv;
    const noneRes = await post(noneSrv.base, '/api/sessions/remove', noneSrv.token, { projectPath: 'D:/x' });
    expect(noneRes.status).toBe(503);
  });

  it('GET 路径行为不变:GET POST-only 路径 → 404;未知 path 的 POST → 405;DELETE → 405', async () => {
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }) });
    active = t.srv;
    const getCtrl = await fetch(`${t.base}/api/sessions/stop?token=${t.token}`);
    expect(getCtrl.status).toBe(404);
    const postUnknown = await post(t.base, '/api/unknown', t.token, { a: 1 });
    expect(postUnknown.status).toBe(405);
    const del = await fetch(`${t.base}/api/sessions`, { method: 'DELETE', headers: { 'x-gui-token': t.token } });
    expect(del.status).toBe(405);
  });

  // ── 入口简化+自愈批(2026-09-16,用户确认):共享 token + /api/health 探测 ──────
  it('共享持久 token:同 registryDir 两实例 token 相同;显式注入 token 仍优先', async () => {
    const a = new WebGuiServer({ getSessions: () => FAKE_SESSIONS, getIndexHtml: () => FAKE_HTML, portStart: 0, registryDir });
    const b = new WebGuiServer({ getSessions: () => FAKE_SESSIONS, getIndexHtml: () => FAKE_HTML, portStart: 0, registryDir });
    expect(a.token).toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const c = new WebGuiServer({ getSessions: () => FAKE_SESSIONS, getIndexHtml: () => FAKE_HTML, portStart: 0, registryDir, token: 'explicit-tok-0123456789abcdef012345' });
    expect(c.token).toBe('explicit-tok-0123456789abcdef012345');
  });

  // M-4(2026-09-17 审查批):ACAO 从 `*` 收紧为 9550-9569 段白名单回显(前端自愈
  // 跨端口探测仍可读),响应体删 startedAt(无消费方,减少指纹面)。
  it('/api/health:无 token 200 + ACAO 白名单回显(9550-9569 段) + {ok,port} 无 startedAt/pid/token + no-store', async () => {
    const t = await startTestServer(); active = t.srv;
    const r = await fetch(`${t.base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();   // 无 Origin(非浏览器)不发 ACAO
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.port).toBe(t.srv.port);
    expect('startedAt' in body).toBe(false);
    expect('pid' in body).toBe(false);
    expect('token' in body).toBe(false);

    const loop1 = await fetch(`${t.base}/api/health`, { headers: { origin: 'http://127.0.0.1:9555' } });
    expect(loop1.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:9555');
    const loop2 = await fetch(`${t.base}/api/health`, { headers: { origin: 'http://localhost:9560' } });
    expect(loop2.headers.get('access-control-allow-origin')).toBe('http://localhost:9560');   // 956x 段也在白名单(9550-9569 全段,自愈扫描范围)
    const evil = await fetch(`${t.base}/api/health`, { headers: { origin: 'https://evil.com' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();   // 白名单外不回显
    expect(evil.status).toBe(200);   // health 本身仍无鉴权可探测(活着+端口,无害)
  });

  // M-1(2026-09-17 审查批):token 比较必须恒定时间——timingSafeEqual 落位即被锁,
  // 且不允许再出现 `=== this.token` / `!== this.token` 字面比较(防回退)。
  // 恒定时间的行为级差异(逐前缀定时探测)在测试内不可测,以恒定时间实现 + 本契约
  // 断言组合覆盖;错误 token 401 / 正确 token 200 的行为由上方既有用例锁定不回归。
  it('源码契约(M-1):server.ts 引入 timingSafeEqual,无 === this.token / !== this.token 字面比较', () => {
    const src = readFileSync(new URL('../../src/web-gui/server.ts', import.meta.url), 'utf-8');
    expect(src).toContain("import { timingSafeEqual } from 'node:crypto'");
    expect(src).not.toContain('=== this.token');
    expect(src).not.toContain('!== this.token');
  });

  // ── 批4-T8(五维评估 P2): 写端点审计补线——此前仅 files-api 一处,sessions/process 零留痕
  it('批4-T8: sessions/stop 成功 → 审计落 caller=web-gui:sessions 条目(与 MCP stop_project 对称)', async () => {
    const tmpProj = await mkdtemp(join(tmpdir(), 'gme-t8proj-'));
    const t = await startCtrlServer({ stopSession: async () => ({ ok: true }) });
    active = t.srv;
    try {
      const res = await post(t.base, '/api/sessions/stop', t.token, { projectPath: tmpProj });
      expect(res.status).toBe(200);
      const auditPath = join(tmpProj, '.godot', 'mcp_audit.jsonl');
      let last = '';
      for (let i = 0; i < 20 && !last; i++) {
        try { last = readFileSync(auditPath, 'utf8').trim().split('\n').at(-1) ?? ''; } catch { /* 尚未落盘 */ }
        if (!last) await new Promise((r) => setTimeout(r, 50));
      }
      expect(last, '审计行应落盘(fire-and-forget 轮询)').not.toBe('');
      const e = JSON.parse(last) as Record<string, unknown>;
      expect(e.tool).toBe('web-gui');
      expect(e.action).toBe('stop');
      expect(e.risk).toBe('process');
      expect(e.caller).toBe('web-gui:sessions');   // 批4-T4 通道前缀
      expect(typeof e.trace_id).toBe('string');
    } finally {
      await rm(tmpProj, { recursive: true, force: true });
    }
  });

  it('批5-N4②: sessions/stop 失败(r.ok=false 500)→ 审计落 ok:false + details.error(此前失败零留痕)', async () => {
    const tmpProj = await mkdtemp(join(tmpdir(), 'gme-n4proj-'));
    const t = await startCtrlServer({ stopSession: async () => ({ ok: false, reason: 'process crash mid-kill' }) });
    active = t.srv;
    try {
      const res = await post(t.base, '/api/sessions/stop', t.token, { projectPath: tmpProj });
      expect(res.status).toBe(500);
      const auditPath = join(tmpProj, '.godot', 'mcp_audit.jsonl');
      let hit: Record<string, unknown> | undefined;
      for (let i = 0; i < 20 && !hit; i++) {
        try {
          const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
          hit = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
            .find((e) => e.action === 'stop' && e.ok === false);
        } catch { /* 尚未落盘 */ }
        if (!hit) await new Promise((r) => setTimeout(r, 50));
      }
      expect(hit, '失败审计行应落盘(查找式:ok:false)').toBeDefined();
      expect(hit!.caller).toBe('web-gui:sessions');
      expect((hit!.details as { error?: string })?.error).toBe('process crash mid-kill');
    } finally {
      await rm(tmpProj, { recursive: true, force: true });
    }
  });
});

// ── rotateSharedToken 与 server 联动(M-2,2026-09-17 审查批)──────────────────
// 诚实边界:rotate 换的是 token.txt(共享持久 token 的真相源)——已运行实例的内存
// token 不热更新,须重启才收敛新值;rotate 的防守对象是"新会话/新实例不再认旧 token"。
describe('rotateSharedToken 与 server 联动(M-2)', () => {
  it('rotate 后新起实例:旧 token 401 / 新 token 200;实例 token 收敛到文件新值', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-gui-rotate-'));
    const mkOpts = (): WebGuiServerOptions => ({
      getSessions: () => FAKE_SESSIONS, getIndexHtml: () => FAKE_HTML, portStart: 0, registryDir: dir,
    });
    const a = new WebGuiServer(mkOpts());
    await a.start();
    const oldToken = a.token;
    const newToken = rotateSharedToken({ dir });
    expect(newToken).not.toBe(oldToken);
    const b = new WebGuiServer(mkOpts());
    await b.start();
    expect(b.token).toBe(newToken);   // 新实例从 token.txt 读到新值
    const old = await fetch(`http://127.0.0.1:${b.port}/api/sessions?token=${oldToken}`);
    expect(old.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${b.port}/api/sessions?token=${newToken}`);
    expect(ok.status).toBe(200);
    await a.stop();
    await b.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
