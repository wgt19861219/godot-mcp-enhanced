// test/web-gui/server-kb.test.ts
// 知识库端点路由层(2026-10-08 批):GET /api/kb/{overview,project,file} 的鉴权/
// 503/400/403/404 状态码映射。注入真实 KbApi(vaultDir 指 mkdtemp fixture——kb-api
// 行为已由 kb-api.test.ts 锁定,本文件聚焦路由与 KbError→HTTP 映射)。
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { KbApi } from '../../src/web-gui/kb-api.js';

const FAKE_HTML = '<!doctype html><html><body>gui</body></html>';

async function buildVault(root: string): Promise<string> {
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'ProjA', '开发日志'), { recursive: true });
  await writeFile(join(vault, 'ProjA', '项目待办.md'), '---\n---\n# 待办\n- [ ] t1\n- [x] t2\n', 'utf-8');
  await writeFile(join(vault, 'ProjA', '开发日志', '2026-10-08 测试.md'), '---\nstatus: done\n---\n正文', 'utf-8');
  await writeFile(join(vault, 'CLAUDE.md'), '# 无映射表', 'utf-8');
  return vault;
}

describe('WebGuiServer 知识库端点(路由层)', () => {
  let root = '';
  let vault = '';
  let registryDir = '';
  let active: WebGuiServer | null = null;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'web-gui-kb-ep-'));
    vault = await buildVault(root);
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-kb-reg-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(registryDir, { recursive: true, force: true });
  });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  async function start(kb?: KbApi) {
    const srv = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => FAKE_HTML,
      portStart: 0,
      registryDir,
      ...(kb !== undefined ? { kb } : {}),
    });
    await srv.start();
    active = srv;
    return { base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }
  const kb = () => new KbApi({ vaultDir: vault, gitLog: async () => null });

  it('三端点:注入缺席 → 503 not configured', async () => {
    const t = await start();
    for (const p of ['/api/kb/overview', '/api/kb/project?name=X', '/api/kb/file?name=X&path=a.md']) {
      const sep = p.includes('?') ? '&' : '?';
      const res = await fetch(`${t.base}${p}${sep}token=${t.token}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not configured' });
    }
  });

  it('GET /api/kb/overview:错 token 401;对 token 200 + 项目卡片', async () => {
    const t = await start(kb());
    const bad = await fetch(`${t.base}/api/kb/overview?token=wrong`);
    expect(bad.status).toBe(401);
    const res = await fetch(`${t.base}/api/kb/overview?token=${t.token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { configured: boolean; vaultName: string; projects: Array<{ name: string }> };
    expect(body.configured).toBe(true);
    expect(body.vaultName).toBe('vault');
    expect(body.projects.map(p => p.name)).toEqual(['ProjA']);
  });

  it('GET /api/kb/project:缺 name 400;name 穿越(../x)400;正常 200', async () => {
    const t = await start(kb());
    const missing = await fetch(`${t.base}/api/kb/project?token=${t.token}`);
    expect(missing.status).toBe(400);
    const evil = await fetch(`${t.base}/api/kb/project?name=${encodeURIComponent('../outside')}&token=${t.token}`);
    expect(evil.status).toBe(400);
    expect(await evil.json()).toMatchObject({ code: 'bad_request' });
    const ok = await fetch(`${t.base}/api/kb/project?name=ProjA&token=${t.token}`);
    expect(ok.status).toBe(200);
    const d = await ok.json() as { name: string; board: { file: string } | null; logs: Array<{ file: string }> };
    expect(d.name).toBe('ProjA');
    expect(d.board!.file).toBe('项目待办.md');
    expect(d.logs[0]!.file).toBe('2026-10-08 测试.md');
  });

  it('GET /api/kb/project:不存在 → 404', async () => {
    const t = await start(kb());
    const res = await fetch(`${t.base}/api/kb/project?name=NoSuch&token=${t.token}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/kb/file:穿越 → 403;缺参 400;正常 200;不存在 404;超限 413(审查 N-4 补映射面)', async () => {
    const t = await start(kb());
    const evil = await fetch(`${t.base}/api/kb/file?name=ProjA&path=${encodeURIComponent('../项目待办.md')}&token=${t.token}`);
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ code: 'forbidden' });
    const missing = await fetch(`${t.base}/api/kb/file?name=ProjA&token=${t.token}`);
    expect(missing.status).toBe(400);
    const ok = await fetch(`${t.base}/api/kb/file?name=ProjA&path=${encodeURIComponent('2026-10-08 测试.md')}&token=${t.token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ content: expect.stringContaining('正文') });
    const nf = await fetch(`${t.base}/api/kb/file?name=ProjA&path=nope.md&token=${t.token}`);
    expect(nf.status).toBe(404);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(vault, 'ProjA', '开发日志', 'big.md'), 'x'.repeat(512 * 1024 + 1), 'utf-8');
    const tooLarge = await fetch(`${t.base}/api/kb/file?name=ProjA&path=big.md&token=${t.token}`);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: 'too_large' });
  });

  it('GET /api/kb/overview:未配置 vault 的 KbApi → configured:false 仍 200(前端引导态)', async () => {
    const t = await start(new KbApi());
    const res = await fetch(`${t.base}/api/kb/overview?token=${t.token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, projects: [] });
  });

  it('内部异常 → 500 固定文本,不透传异常消息里的本地路径(审查 N-3)', async () => {
    const boom = {
      overview: async () => { throw new Error('EBUSY D:\\secret\\vault\\ProjX locked'); },
    } as unknown as KbApi;
    const t = await start(boom);
    const res = await fetch(`${t.base}/api/kb/overview?token=${t.token}`);
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('internal error');
    expect(body).not.toContain('secret');   // 异常消息(含绝对路径)不进响应
  });
});
