// Task 3(spec 2026-09-15 v2.1 §4/§5):WebGuiServer 项目 5 端点 + SSE projects 事件 +
// hello 扩展。端点层只测路由/鉴权/状态码/注入缺席——store 行为 Task 2 已测
// (projects-store.test.ts),故 ProjectsApi 用注入 mock,不建真实 store。
// ⚠️ env 隔离:test/setup.js 全局设 GODOT_MCP_UNRESTRICTED='true' 会让
// isPathInAllowedRoots 恒 true——白名单 403 用例临时 delete 该 env + 设
// ALLOWED_PROJECT_PATHS,用后还原(惯例对齐 test/web-gui/env-gate.test.ts)。

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { WebGuiServer, type WebGuiServerOptions, type ProjectsApi } from '../../src/web-gui/server.js';
import type { ProjectView } from '../../src/web-gui/projects-store.js';
import { PathError } from '../../src/core/tool-errors.js';

const DEMO_VIEW: ProjectView = {
  path: 'D:/demo', name: 'demo', addedAt: '2026-09-15T00:00:00.000Z', source: 'scan',
  mtime: 1000, missing: false, running: false, sessionId: null,
};

function mockProjects(over: {
  list?: ProjectView[];
  scan?: ProjectsApi['scan'];
  add?: ProjectsApi['add'];
  remove?: ProjectsApi['remove'];
} = {}): ProjectsApi {
  const list = over.list ?? [DEMO_VIEW];
  return {
    list: async () => list,
    scan: over.scan ?? (async () => ({ started: true, added: 0 })),
    add: over.add ?? (async () => ({ ok: true })),
    remove: over.remove ?? (async () => ({ ok: true })),
  };
}

/** 白名单 403 用例专用:临时删 UNRESTRICTED + 设 ALLOWED_PROJECT_PATHS,返回还原函数。 */
function restrictAllowedRoots(root: string): () => void {
  const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
  delete process.env.GODOT_MCP_UNRESTRICTED;
  process.env.ALLOWED_PROJECT_PATHS = root;
  return () => {
    process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
    else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
  };
}

/** SSE 事件读取器(跨调用持久缓冲):同 chunk 合并到达的多条事件不丢——
 *  本文件 scan 的 progress+completion 紧邻写出会落同一 TCP chunk,
 *  server-sse.test.ts 的单次缓冲 readEvent 形态在此会吞掉第二条,故自建。 */
function createEventReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<{ event: string; data: any }> {
  let buf = '';
  const tryParse = (): { event: string; data: any } | null => {
    const m = buf.match(/event: (\w+)\ndata: ([\s\S]*?)\n\n/);
    if (!m) return null;
    buf = buf.slice(m[0].length);
    return { event: m[1]!, data: JSON.parse(m[2]!) };
  };
  return () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE read timeout')), 4000);
    const attempt = (): void => {
      const parsed = tryParse();
      if (parsed) { clearTimeout(timer); resolve(parsed); return; }
      void reader.read().then(({ done, value }) => {
        if (done) { clearTimeout(timer); reject(new Error('SSE stream ended')); return; }
        buf += new TextDecoder().decode(value);
        attempt();
      }).catch(reject);
    };
    attempt();
  });
}

async function connectEvents(base: string, token: string): Promise<{ next: () => Promise<{ event: string; data: any }>; close: () => Promise<void> }> {
  const es = await fetch(`${base}/events?token=${token}`, { headers: { accept: 'text/event-stream' } });
  expect(es.status).toBe(200);
  const reader = es.body!.getReader();
  return { next: createEventReader(reader), close: async () => { await reader.cancel(); } };
}

describe('WebGuiServer 项目端点 + SSE projects(Task 3,spec §4/§5)', () => {
  let registryDir = '';
  let workDir = '';        // 白名单根(403 用例注入)
  let projDir = '';        // 含 project.godot 的合法项目目录(workDir 内)
  let outsideDir = '';     // 白名单外目录
  let active: WebGuiServer | null = null;

  beforeAll(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-proj-reg-'));
    workDir = await mkdtemp(join(tmpdir(), 'web-gui-proj-work-'));
    projDir = join(workDir, 'proj');
    outsideDir = await mkdtemp(join(tmpdir(), 'web-gui-proj-out-'));
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'project.godot'), '; test project\n', 'utf-8');
  });
  afterAll(async () => {
    for (const d of [registryDir, workDir, outsideDir]) {
      if (d) await rm(d, { recursive: true, force: true });
    }
  });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  async function startSrv(hooks: Partial<WebGuiServerOptions> = {}): Promise<{ srv: WebGuiServer; base: string; token: string }> {
    const srv = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => '<html></html>',
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

  // ─── GET /api/projects ────────────────────────────────────────────────────

  it('GET /api/projects:注入 → 200 数组快照', async () => {
    const t = await startSrv({ projects: mockProjects() }); active = t.srv;
    const res = await fetch(`${t.base}/api/projects?token=${t.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual([DEMO_VIEW]);
  });

  it('GET /api/projects:未注入 → 503 {error:"not configured"};无 token → 401', async () => {
    const t = await startSrv(); active = t.srv;
    const res = await fetch(`${t.base}/api/projects?token=${t.token}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
    const noToken = await fetch(`${t.base}/api/projects`);
    expect(noToken.status).toBe(401);
  });

  // ─── POST /api/projects/scan ──────────────────────────────────────────────

  it('scan:未注入 → 503', async () => {
    const t = await startSrv(); active = t.srv;
    const res = await post(t.base, '/api/projects/scan', t.token, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('scan:{started:true} 立即返回;进度 + 完成事件走 SSE projects(完成带最新快照)', async () => {
    const scanFn = vi.fn(async (onProgress?: (found: number, scanned: number) => void) => {
      onProgress?.(1, 3);
      return { started: true, added: 1 };
    });
    const t = await startSrv({ projects: mockProjects({ scan: scanFn }) }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();   // 丢弃 hello
    const res = await post(t.base, '/api/projects/scan', t.token, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
    const prog = await next();
    expect(prog.event).toBe('projects');
    expect(prog.data).toEqual({ scanning: true, found: 1, scanned: 3 });
    const done = await next();
    expect(done.event).toBe('projects');
    expect(done.data).toEqual({ scanning: false, added: 1, total: 1, projects: [DEMO_VIEW] });
    expect(scanFn).toHaveBeenCalledTimes(1);
    await close();
  });

  it('scan 进度节流 500ms:同毫秒两连拍只推第一帧(spec §5)', async () => {
    const scanFn = async (onProgress?: (found: number, scanned: number) => void): Promise<{ started: boolean; added: number }> => {
      onProgress?.(1, 2);
      onProgress?.(2, 4);   // 距上帧 <500ms → 被节流吞掉
      return { started: true, added: 1 };
    };
    const t = await startSrv({ projects: mockProjects({ scan: scanFn }) }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();
    await post(t.base, '/api/projects/scan', t.token, {});
    const first = await next();
    expect(first.data).toEqual({ scanning: true, found: 1, scanned: 2 });
    const nxt = await next();
    expect(nxt.data).toEqual({ scanning: false, added: 1, total: 1, projects: [DEMO_VIEW] });
    await close();
  });

  it('scan 互斥:进行中再收 → {started:false, reason:"scanning"}(spec §3.1.1-1)', async () => {
    let firstCall = true;
    const scanFn = async (): Promise<{ started: boolean; reason?: string }> => {
      if (!firstCall) return { started: false, reason: 'scanning' };
      firstCall = false;
      return new Promise(() => { /* 永不完成——模拟长扫描,测试内无需释放 */ });
    };
    const t = await startSrv({ projects: mockProjects({ scan: scanFn }) }); active = t.srv;
    const r1 = await post(t.base, '/api/projects/scan', t.token, {});
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ started: true });
    const r2 = await post(t.base, '/api/projects/scan', t.token, {});
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ started: false, reason: 'scanning' });
  });

  it('scan:store throw(UNRESTRICTED)→ 500 + 提示文案(Task 2 契约)', async () => {
    const scanFn = async (): Promise<never> => {
      throw new Error('UNRESTRICTED 模式不支持扫描,请用添加按钮');
    };
    const t = await startSrv({ projects: mockProjects({ scan: scanFn }) }); active = t.srv;
    const res = await post(t.base, '/api/projects/scan', t.token, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'UNRESTRICTED 模式不支持扫描,请用添加按钮' });
  });

  it('scan 异步失败 → SSE 兜底事件 {scanning:false, failed:true}(F-1:失败不得误显"扫描完成")', async () => {
    // 同步 throw 走 0-tick 探针 500(上一用例);F-1 盲区在异步 reject——then 链
    // reject 回调广播兜底事件解卡前端扫描态,必须带 failed 标记供前端区分文案。
    let rejectScan!: (e: Error) => void;
    const scanFn = vi.fn(() => new Promise<never>((_, rej) => { rejectScan = rej; }));
    const t = await startSrv({ projects: mockProjects({ scan: scanFn }) }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();   // 丢弃 hello
    const res = await post(t.base, '/api/projects/scan', t.token, {});
    expect(res.status).toBe(200);   // 0-tick 先到,扫描"已启动"
    expect(await res.json()).toEqual({ started: true });
    rejectScan(new Error('disk io error'));
    const fail = await next();
    expect(fail.event).toBe('projects');
    expect(fail.data).toEqual({ scanning: false, failed: true });
    await close();
  });

  // ─── POST /api/projects/add ───────────────────────────────────────────────

  it('add:白名单外 → 403 且不调 store;白名单内 → 放行(env 收紧后验证,spec §4)', async () => {
    const restore = restrictAllowedRoots(workDir);
    try {
      const addFn = vi.fn(async () => ({ ok: true }));
      const t = await startSrv({ projects: mockProjects({ add: addFn }) }); active = t.srv;
      const denied = await post(t.base, '/api/projects/add', t.token, { path: join(outsideDir, 'x') });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'path outside allowed roots' });
      expect(addFn).not.toHaveBeenCalled();
      const ok = await post(t.base, '/api/projects/add', t.token, { path: projDir });
      expect(ok.status).toBe(200);
      expect(addFn).toHaveBeenCalledWith(projDir);
    } finally {
      restore();
    }
  });

  it('add:not_a_project → 404;duplicate → 200 {ok:false,reason:"duplicate"};满员(ok:false 无 reason)→ 200 {ok:false,reason:"full"}', async () => {
    const addFn = async (p: string): Promise<{ ok: boolean; reason?: string }> => {
      if (p.includes('nope')) return { ok: false, reason: 'not_a_project' };
      if (p.includes('dup')) return { ok: false, reason: 'duplicate' };
      return { ok: false };   // 满员形态(Task 2 契约:无 reason)
    };
    const t = await startSrv({ projects: mockProjects({ add: addFn }) }); active = t.srv;
    const r404 = await post(t.base, '/api/projects/add', t.token, { path: 'D:/nope' });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not a godot project' });
    const dup = await post(t.base, '/api/projects/add', t.token, { path: 'D:/dup' });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ ok: false, reason: 'duplicate' });
    const full = await post(t.base, '/api/projects/add', t.token, { path: 'D:/full' });
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual({ ok: false, reason: 'full' });
  });

  it('add:ok → 200 + projects SSE 快照事件(清单变更推快照,spec §5)', async () => {
    const t = await startSrv({ projects: mockProjects() }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();
    const res = await post(t.base, '/api/projects/add', t.token, { path: 'D:/demo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const ev = await next();
    expect(ev.event).toBe('projects');
    expect(ev.data).toEqual({ projects: [DEMO_VIEW] });
    await close();
  });

  it('add:坏 JSON / path 缺失 / path 空串 → 400;未注入 → 503', async () => {
    const t = await startSrv({ projects: mockProjects() }); active = t.srv;
    expect((await post(t.base, '/api/projects/add', t.token, '{oops')).status).toBe(400);
    expect((await post(t.base, '/api/projects/add', t.token, { other: 1 })).status).toBe(400);
    expect((await post(t.base, '/api/projects/add', t.token, { path: '' })).status).toBe(400);
    await t.srv.stop(); active = null;
    const t2 = await startSrv(); active = t2.srv;
    const res = await post(t2.base, '/api/projects/add', t2.token, { path: 'D:/x' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  // ─── POST /api/projects/remove ────────────────────────────────────────────

  it('remove:ok → 200 + SSE 快照;not_found → 404;坏 body → 400;未注入 → 503', async () => {
    const t = await startSrv({ projects: mockProjects() }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();
    const ok = await post(t.base, '/api/projects/remove', t.token, { path: 'D:/demo' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const ev = await next();
    expect(ev.event).toBe('projects');
    expect(ev.data).toEqual({ projects: [DEMO_VIEW] });
    await close();
    await t.srv.stop(); active = null;

    const nf = await startSrv({ projects: mockProjects({ remove: async () => ({ ok: false, reason: 'not_found' }) }) }); active = nf.srv;
    const r404 = await post(nf.base, '/api/projects/remove', nf.token, { path: 'D:/gone' });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not found' });
    await nf.srv.stop(); active = null;

    const bad = await startSrv({ projects: mockProjects() }); active = bad.srv;
    expect((await post(bad.base, '/api/projects/remove', bad.token, 'nope')).status).toBe(400);
    expect((await post(bad.base, '/api/projects/remove', bad.token, {})).status).toBe(400);
    await bad.srv.stop(); active = null;

    const none = await startSrv(); active = none.srv;
    const r503 = await post(none.base, '/api/projects/remove', none.token, { path: 'D:/x' });
    expect(r503.status).toBe(503);
  });

  // ─── POST /api/sessions/start ─────────────────────────────────────────────

  it('start:readOnly → 403 {error:"read-only mode"} 且不调 runProject(spec v2/IMP-3)', async () => {
    const runProject = vi.fn(async () => undefined);
    const t = await startSrv({ runProject, isReadOnly: () => true }); active = t.srv;
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'read-only mode' });
    expect(runProject).not.toHaveBeenCalled();
  });

  it('start:白名单外 → 403 且不调 runProject(env 收紧后验证)', async () => {
    const restore = restrictAllowedRoots(workDir);
    try {
      const runProject = vi.fn(async () => undefined);
      const t = await startSrv({ runProject }); active = t.srv;
      const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: join(outsideDir, 'evil') });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'path outside allowed roots' });
      expect(runProject).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('start:非 Godot 项目(无 project.godot)→ 404(spec §4 project.godot 存在校验)', async () => {
    const runProject = vi.fn(async () => undefined);
    const t = await startSrv({ runProject }); active = t.srv;
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: outsideDir });
    expect(res.status).toBe(404);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('start:mode 缺省 run → 200 调 runProject(路径原样)+ SSE 快照;editProject 不被调', async () => {
    const runProject = vi.fn(async () => 'spawned');
    const editProject = vi.fn(async () => undefined);
    const t = await startSrv({ projects: mockProjects(), runProject, editProject }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    await next();
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(runProject).toHaveBeenCalledWith(projDir);
    expect(editProject).not.toHaveBeenCalled();
    const ev = await next();
    expect(ev.event).toBe('projects');
    expect(ev.data).toEqual({ projects: [DEMO_VIEW] });
    await close();
  });

  it('start:mode=edit → 200 调 editProject;runProject 不被调', async () => {
    const runProject = vi.fn(async () => undefined);
    const editProject = vi.fn(async () => undefined);
    const t = await startSrv({ runProject, editProject }); active = t.srv;
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir, mode: 'edit' });
    expect(res.status).toBe(200);
    expect(editProject).toHaveBeenCalledWith(projDir);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('start:坏 JSON / projectPath 缺失 / 非法 mode → 400', async () => {
    const t = await startSrv({ runProject: async () => undefined }); active = t.srv;
    expect((await post(t.base, '/api/sessions/start', t.token, 'junk')).status).toBe(400);
    expect((await post(t.base, '/api/sessions/start', t.token, {})).status).toBe(400);
    expect((await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir, mode: 'fly' })).status).toBe(400);
  });

  it('start:注入缺席 → 503(mode 缺省查 runProject;mode=edit 查 editProject)', async () => {
    const t = await startSrv({ editProject: async () => undefined }); active = t.srv;   // runProject 缺席
    expect((await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir })).status).toBe(503);
    await t.srv.stop(); active = null;
    const t2 = await startSrv({ runProject: async () => undefined }); active = t2.srv;  // editProject 缺席
    const res = await post(t2.base, '/api/sessions/start', t2.token, { projectPath: projDir, mode: 'edit' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('start:runProject 抛 PathError → 403(executeRunProject 第二层白名单,Task 5 接线后真实触发)', async () => {
    const t = await startSrv({ runProject: async () => { throw new PathError('project_path is outside allowed project roots'); } }); active = t.srv;
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'project_path is outside allowed project roots' });
  });

  it('start:runProject 抛其他错误 → 500 {error}', async () => {
    const t = await startSrv({ runProject: async () => { throw new Error('spawn failed'); } }); active = t.srv;
    const res = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'spawn failed' });
  });

  // ─── 鉴权门(新 POST 路径不放松)───────────────────────────────────────────

  it('写路径鉴权不放松:POST 项目端点无 token → 401;对 token 错 Origin → 403', async () => {
    const t = await startSrv({ projects: mockProjects(), runProject: async () => undefined }); active = t.srv;
    const noToken = await fetch(`${t.base}/api/projects/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"D:/x"}',
    });
    expect(noToken.status).toBe(401);
    const evilScan = await post(t.base, '/api/projects/scan', t.token, {}, { origin: 'http://evil.example' });
    expect(evilScan.status).toBe(403);
    const evilStart = await post(t.base, '/api/sessions/start', t.token, { projectPath: projDir }, { origin: 'http://evil.example' });
    expect(evilStart.status).toBe(403);
  });
});

describe('hello payload projects 字段(spec §5 / v2-M6)', () => {
  let registryDir = '';
  let active: WebGuiServer | null = null;
  beforeAll(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-proj-hello-'));
  });
  afterAll(async () => { if (registryDir) await rm(registryDir, { recursive: true, force: true }); });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  async function startSrv(hooks: Partial<WebGuiServerOptions> = {}): Promise<{ srv: WebGuiServer; base: string; token: string }> {
    const srv = new WebGuiServer({
      getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, registryDir, ...hooks,
    });
    await srv.start();
    return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }

  it('注入 → hello.projects = 最新快照数组', async () => {
    const t = await startSrv({ projects: mockProjects() }); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    const hello = await next();
    expect(hello.event).toBe('hello');
    expect(hello.data.projects).toEqual([DEMO_VIEW]);
    expect(hello.data).toHaveProperty('sessions');
    expect(hello.data).toHaveProperty('stats');
    await close();
  });

  it('未注入 → hello.projects = null', async () => {
    const t = await startSrv(); active = t.srv;
    const { next, close } = await connectEvents(t.base, t.token);
    const hello = await next();
    expect(hello.event).toBe('hello');
    expect(hello.data.projects).toBeNull();
    await close();
  });
});

// ─── 项目目录入口页 面板入口.html(2026-09-16 项目入口批)────────────────────
// server start 全量刷新 + add 成功后刷新,均为 fire-and-forget → 轮询等落盘。

describe('WebGuiServer 项目目录入口页(2026-09-16 项目入口批)', () => {
  let registryDir = '';
  let projDir = '';
  let active: WebGuiServer | null = null;

  beforeAll(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'web-gui-pentry-reg-'));
    const work = await mkdtemp(join(tmpdir(), 'web-gui-pentry-work-'));
    projDir = join(work, 'proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'project.godot'), '; test project\n', 'utf-8');
  });
  afterAll(async () => {
    for (const d of [registryDir, join(projDir, '..')]) {
      await rm(d, { recursive: true, force: true });
    }
  });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });

  async function startSrv(hooks: Partial<WebGuiServerOptions> = {}): Promise<{ srv: WebGuiServer; base: string; token: string }> {
    const srv = new WebGuiServer({
      getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, registryDir, ...hooks,
    });
    await srv.start();
    return { srv, base: `http://127.0.0.1:${srv.port}`, token: srv.token };
  }

  async function waitEntryFile(): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(projDir, '面板入口.html'))) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return existsSync(join(projDir, '面板入口.html'));
  }

  it('start 后为登记的 Godot 项目目录写入 面板入口.html', async () => {
    const t = await startSrv({ projects: mockProjects({ list: [{ ...DEMO_VIEW, path: projDir }] }) }); active = t.srv;
    expect(await waitEntryFile()).toBe(true);
    expect(readFileSync(join(projDir, '面板入口.html'), 'utf-8')).toContain('9550');
  });

  it('POST /api/projects/add 成功后新项目目录出现 面板入口.html', async () => {
    rmSync(join(projDir, '面板入口.html'), { force: true });   // 清上一用例残留,保证"初始未登记"前提
    let list: ProjectView[] = [];
    const t = await startSrv({
      projects: {
        list: async () => list,
        scan: async () => ({ started: true, added: 0 }),
        add: async (p: string) => { list = [{ ...DEMO_VIEW, path: p }]; return { ok: true }; },
        remove: async () => ({ ok: true }),
      },
    }); active = t.srv;
    expect(existsSync(join(projDir, '面板入口.html'))).toBe(false);   // 初始未登记 → 无入口
    const res = await fetch(`${t.base}/api/projects/add`, {
      method: 'POST',
      headers: { 'x-gui-token': t.token, 'content-type': 'application/json' },
      body: JSON.stringify({ path: projDir }),
    });
    expect(res.status).toBe(200);
    expect(await waitEntryFile()).toBe(true);
  });

  it('非 Godot 项目登记(path 无 project.godot)不写入口(护栏)', async () => {
    const notProj = join(projDir, '..');
    const t = await startSrv({ projects: mockProjects({ list: [{ ...DEMO_VIEW, path: notProj }] }) }); active = t.srv;
    await new Promise(r => setTimeout(r, 200));
    expect(existsSync(join(notProj, '面板入口.html'))).toBe(false);
  });

  it('start 后为包根(packageRootDir 注入)无条件写 面板入口.html(仓库根入口,2026-09-16 用户裁决)', async () => {
    const pkgRoot = await mkdtemp(join(tmpdir(), 'web-gui-pkgroot-'));   // 注入隔离,不写真实仓库根
    try {
      const t = await startSrv({ packageRootDir: pkgRoot }); active = t.srv;   // 不注入 projects → 包根路径独立可验
      for (let i = 0; i < 100 && !existsSync(join(pkgRoot, '面板入口.html')); i++) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(existsSync(join(pkgRoot, '面板入口.html'))).toBe(true);
      expect(readFileSync(join(pkgRoot, '面板入口.html'), 'utf-8')).toContain('9550');
    } finally {
      await rm(pkgRoot, { recursive: true, force: true });
    }
  });
});
