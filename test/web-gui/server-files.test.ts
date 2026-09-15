// test/web-gui/server-files.test.ts(关键用例;鉴权正例用 x-gui-token 头,形态对齐 server-projects.test.ts)
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebGuiServer, type WebGuiServerOptions } from '../../src/web-gui/server.js';
import { FilesApi } from '../../src/web-gui/files-api.js';

describe('WebGuiServer files 端点+assets(spec §4/§5,2026-09-15 v2)', () => {
  let root = ''; let proj = ''; let regDir = ''; let assetsDir = ''; let active: WebGuiServer | null = null;
  let prevUnrestricted: string | undefined; let prevAllowed: string | undefined;

  async function startSrv(hooks: Partial<WebGuiServerOptions> = {}): Promise<{ srv: WebGuiServer; base: string; token: string }> {
    const srv = new WebGuiServer({
      getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, registryDir: regDir,
      files: new FilesApi({ backupDir: join(regDir, 'bak') }), assetsDir, ...hooks,
    });
    await srv.start();
    return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }
  const H = (t: string) => ({ 'x-gui-token': t });

  beforeAll(async () => {
    regDir = await mkdtemp(join(tmpdir(), 'web-gui-files-reg-'));
    root = await mkdtemp(join(tmpdir(), 'web-gui-files-root-'));
    assetsDir = await mkdtemp(join(tmpdir(), 'web-gui-files-assets-'));
    proj = join(root, 'proj');
    await mkdir(join(proj, 'scripts'), { recursive: true });
    await writeFile(join(proj, 'project.godot'), '; p\n', 'utf-8');
    await writeFile(join(proj, 'main.gd'), 'extends Node\n', 'utf-8');
    await writeFile(join(proj, 'icon.svg'), '<svg/>', 'utf-8');
    // assets 临时清单(6 文件之一即可驱动正例;枚举只认固定名)
    for (const f of ['codemirror.js', 'codemirror.css', 'mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js']) {
      await writeFile(join(assetsDir, f), '/*stub*/', 'utf-8');
    }
    prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED; prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.GODOT_MCP_UNRESTRICTED; process.env.ALLOWED_PROJECT_PATHS = root;
  });
  afterAll(async () => {
    process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS; else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    for (const d of [regDir, root, assetsDir]) await rm(d, { recursive: true, force: true });
  });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  it('GET / 响应 CSP 放宽(script/style self+img/media self)', async () => {
    const t = await startSrv(); active = t.srv;
    const r = await fetch(t.base + '/', { headers: H(t.token) });
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self'; media-src 'self'; connect-src 'self'");
  });

  it('files 缺席 → 503(对齐 projects 注入缺席语义)', async () => {
    const t = await startSrv({ files: undefined }); active = t.srv;
    const r = await fetch(t.base + `/api/projects/files?project=${encodeURIComponent(proj)}`, { headers: H(t.token) });
    expect(r.status).toBe(503);
  });

  it('listDir:200 {entries} 目录先;.godot 隐藏;无 token 401', async () => {
    const t = await startSrv(); active = t.srv;
    const noAuth = await fetch(t.base + `/api/projects/files?project=${encodeURIComponent(proj)}`);
    expect(noAuth.status).toBe(401);
    const r = await fetch(t.base + `/api/projects/files?project=${encodeURIComponent(proj)}`, { headers: H(t.token) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['scripts', 'icon.svg', 'main.gd', 'project.godot']);
  });

  it('file GET text:200 带 content/mtime;mode=raw svg → image/svg+xml + 响应头防线(B-1)', async () => {
    const t = await startSrv(); active = t.srv;
    const q = `/api/projects/file?project=${encodeURIComponent(proj)}&path=main.gd&mode=text`;
    const r = await fetch(t.base + q, { headers: H(t.token) });
    expect(r.status).toBe(200);
    expect((await r.json()).content).toBe('extends Node\n');
    const rq = `/api/projects/file?project=${encodeURIComponent(proj)}&path=icon.svg&mode=raw`;
    const raw = await fetch(t.base + rq, { headers: H(t.token) });
    expect(raw.headers.get('content-type')).toBe('image/svg+xml');
    expect(raw.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('file GET hex:200 {size,bytes};mode 非法 400;非文本扩展 text 400', async () => {
    const t = await startSrv(); active = t.srv;
    const q = (m: string, p: string) => `/api/projects/file?project=${encodeURIComponent(proj)}&path=${p}&mode=${m}`;
    const hex = await fetch(t.base + q('hex', 'icon.svg'), { headers: H(t.token) });
    expect(hex.status).toBe(200);
    const hb = await hex.json();
    expect(hb.size).toBe(6); expect(hb.bytes).toHaveLength(6);
    expect((await fetch(t.base + q('bogus', 'main.gd'), { headers: H(t.token) })).status).toBe(400);
    // icon.svg 非 TEXT_EXTS → text 模式 400
    expect((await fetch(t.base + q('text', 'icon.svg'), { headers: H(t.token) })).status).toBe(400);
  });

  it('file POST 保存流:200/409 冲突带 latest/404 不存在/写端点 audit log', async () => {
    const t = await startSrv(); active = t.srv;
    const url = t.base + '/api/projects/file';
    const cur = await (await fetch(t.base + `/api/projects/file?project=${encodeURIComponent(proj)}&path=main.gd&mode=text`, { headers: H(t.token) })).json();
    const ok = await fetch(url, { method: 'POST', headers: { ...H(t.token), 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj, path: 'main.gd', content: 'extends Node2D\n', baseMtime: cur.mtime }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).mtime).toBeGreaterThan(0);
    // 409:用旧 mtime 再存
    const conflict = await fetch(url, { method: 'POST', headers: { ...H(t.token), 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj, path: 'main.gd', content: 'x', baseMtime: cur.mtime }) });
    expect(conflict.status).toBe(409);
    const cb = await conflict.json();
    expect(cb.latest.content).toBe('extends Node2D\n');
    // 404:不存在(含 baseMtime=0)
    const nf = await fetch(url, { method: 'POST', headers: { ...H(t.token), 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj, path: 'nope.gd', content: 'x', baseMtime: 0 }) });
    expect(nf.status).toBe(404);
  });

  it('file POST content-length>600KB → 413(读 body 前预检,I-6)', async () => {
    const t = await startSrv(); active = t.srv;
    const r = await fetch(t.base + '/api/projects/file', { method: 'POST', headers: { ...H(t.token), 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj, path: 'main.gd', content: 'x'.repeat(700 * 1024), baseMtime: 1 }) });
    expect(r.status).toBe(413);
  });

  it('file POST readOnly → 403(spec §3.3-1 第一重护栏,审查 fix round 1)', async () => {
    const t = await startSrv({ isReadOnly: () => true }); active = t.srv;
    const r = await fetch(t.base + '/api/projects/file', { method: 'POST', headers: { ...H(t.token), 'content-type': 'application/json' },
      body: JSON.stringify({ project: proj, path: 'main.gd', content: 'x', baseMtime: 1 }) });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('read-only');
  });

  it('assets 枚举:清单内 200+cache-control;清单外/含路径分隔 → 404;无 token 401(I-2/M-14)', async () => {
    const t = await startSrv(); active = t.srv;
    const noAuth = await fetch(t.base + '/assets/codemirror.js');
    expect(noAuth.status).toBe(401);
    const ok = await fetch(t.base + '/assets/codemirror.js', { headers: H(t.token) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(ok.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect((await fetch(t.base + '/assets/evil.js', { headers: H(t.token) })).status).toBe(404);
    expect((await fetch(t.base + '/assets/..%2Fcodemirror.js', { headers: H(t.token) })).status).toBe(404);
  });
});
