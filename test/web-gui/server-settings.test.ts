// test/web-gui/server-settings.test.ts
// 设置端点路由层(2026-09-29 设置批):GET /api/settings + POST /api/settings +
// POST /api/settings/verify 的鉴权/405/403_readonly/503/状态码映射。
// SettingsApi 注入 mock(逻辑层校验/持久化由 settings-api.test.ts 覆盖,
// 对齐 server-projects.test.ts 注入 mock 不建真实 store 模式)。
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGuiServer, type SettingsApi } from '../../src/web-gui/server.js';

const FAKE_HTML = '<!doctype html><html><body>gui</body></html>';
const FAKE_VIEW = {
  persisted: { godotPath: 'D:/godot/g.exe', allowedProjectPaths: ['D:/a'] },
  effective: { godotPath: 'D:/godot/g.exe', allowedProjectPaths: ['D:/a'], unrestricted: false, godotAllowedList: '' },
  candidates: ['D:/godot/g.exe'],
  readOnly: false,
};

function makeSettingsApi(overrides: Partial<SettingsApi> = {}): SettingsApi {
  return {
    get: async () => FAKE_VIEW,
    verify: async (path: string) => (path ? { ok: true, version: '4.7.1.stable' } : { ok: false, stage: 'bad-request', detail: '路径不能为空' }),
    save: async () => ({ ok: true, persisted: FAKE_VIEW.persisted }),
    ...overrides,
  };
}

describe('WebGuiServer 设置端点(路由层)', () => {
  let registryDir = '';
  let active: WebGuiServer | null = null;
  beforeAll(async () => { registryDir = await mkdtemp(join(tmpdir(), 'web-gui-settings-ep-')); });
  afterAll(async () => { await rm(registryDir, { recursive: true, force: true }); });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  async function start(opts: { settings?: SettingsApi; isReadOnly?: () => boolean } = {}) {
    const srv = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => FAKE_HTML,
      portStart: 0,
      registryDir,
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
      ...(opts.isReadOnly !== undefined ? { isReadOnly: opts.isReadOnly } : {}),
    });
    await srv.start();
    active = srv;
    return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }

  it('GET /api/settings:错 token 401;对 token 200 + 视图透传', async () => {
    const t = await start({ settings: makeSettingsApi() });
    const bad = await fetch(`${t.base}/api/settings?token=wrong`);
    expect(bad.status).toBe(401);
    const ok = await fetch(`${t.base}/api/settings?token=${t.token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(FAKE_VIEW);
  });

  it('GET /api/settings:注入缺席 → 503 not configured', async () => {
    const t = await start({});
    const res = await fetch(`${t.base}/api/settings?token=${t.token}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('POST /api/settings 与 /api/settings/verify 已注册(不再 405)', async () => {
    const t = await start({ settings: makeSettingsApi() });
    const a = await fetch(`${t.base}/api/settings?token=${t.token}`, { method: 'POST', body: '{}' });
    expect(a.status).not.toBe(405);
    const b = await fetch(`${t.base}/api/settings/verify?token=${t.token}`, { method: 'POST', body: JSON.stringify({ path: 'D:/g.exe' }) });
    expect(b.status).not.toBe(405);
  });

  it('POST /api/settings:错 token 401;类型错 400;成功 200 + persisted', async () => {
    const save = vi.fn(async (patch: { godotPath?: string; allowedProjectPaths?: string[] }) =>
      patch.godotPath === 'D:/ok.exe' ? { ok: true, persisted: { godotPath: 'D:/ok.exe', allowedProjectPaths: [] } } : { ok: true, persisted: { godotPath: '', allowedProjectPaths: [] } });
    const t = await start({ settings: makeSettingsApi({ save }) });
    const bad = await fetch(`${t.base}/api/settings?token=nope`, { method: 'POST', body: '{}' });
    expect(bad.status).toBe(401);
    const wrongType = await fetch(`${t.base}/api/settings?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ godotPath: 42 }),
    });
    expect(wrongType.status).toBe(400);
    const ok = await fetch(`${t.base}/api/settings?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ godotPath: 'D:/ok.exe' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, persisted: { godotPath: 'D:/ok.exe', allowedProjectPaths: [] } });
    expect(save).toHaveBeenCalledWith({ godotPath: 'D:/ok.exe' });
  });

  it('POST /api/settings:READ_ONLY → 403 read-only mode(不调 save)', async () => {
    const save = vi.fn(async () => ({ ok: true, persisted: { godotPath: '', allowedProjectPaths: [] } }));
    const t = await start({ settings: makeSettingsApi({ save }), isReadOnly: () => true });
    const res = await fetch(`${t.base}/api/settings?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ godotPath: 'D:/x.exe' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'read-only mode' });
    expect(save).not.toHaveBeenCalled();
  });

  it('POST /api/settings:save 失败 → 400 带 error+stage', async () => {
    const t = await start({ settings: makeSettingsApi({ save: async () => ({ ok: false, error: 'Godot 路径校验失败:…', stage: 'not-godot-signature' }) }) });
    const res = await fetch(`${t.base}/api/settings?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ godotPath: 'D:/bad.exe' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Godot 路径校验失败:…', stage: 'not-godot-signature' });
  });

  it('POST /api/settings/verify:缺 path 400;恒 200 用 body.ok 区分(探测结果即响应语义)', async () => {
    const t = await start({ settings: makeSettingsApi() });
    const missing = await fetch(`${t.base}/api/settings/verify?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
    const ok = await fetch(`${t.base}/api/settings/verify?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'D:/godot/g.exe' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, version: '4.7.1.stable' });
  });

  it('POST /api/settings/verify:注入缺席 → 503;READ_ONLY → 403 不调 verify(D-1:探测=spawn 进程,只读契约不得穿透)', async () => {
    const t0 = await start({});
    const nc = await fetch(`${t0.base}/api/settings/verify?token=${t0.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'D:/g.exe' }),
    });
    expect(nc.status).toBe(503);
    await t0.srv.stop();
    active = null;
    // D-1 fix(2026-10-01 审查):verify 会 spawn 候选路径 --version(godot-finder
    // execFileAsync)=进程创建动作——推翻设置批"只读探测不拦 READ_ONLY"的旧设计,
    // 对齐 file_save/settings_save/sessions_start 的拦截惯例(本用例原断言 200)。
    const verify = vi.fn(async (path: string) => ({ ok: path.length > 0, version: '4.7.1.stable' }));
    const t = await start({ settings: makeSettingsApi({ verify }), isReadOnly: () => true });
    const res = await fetch(`${t.base}/api/settings/verify?token=${t.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'D:/g.exe' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'read-only mode' });
    expect(verify).not.toHaveBeenCalled();
  });
});
