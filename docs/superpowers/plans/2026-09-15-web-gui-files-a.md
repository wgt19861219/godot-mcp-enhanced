# Web GUI 资源管理工作台 Plan A(浏览+编辑) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web GUI 面板新增游戏资源管理:从项目行进入文件树,浏览目录,CodeMirror 编辑文本资源,三重护栏保存。

**Architecture:** 对齐项目面板批成熟模式——纯逻辑模块(files-api.ts)+ server 端点组(注入,缺席 503)+ 前端视图(中列 tab)。路径安全链三层:isPathInAllowedRoots+project.godot 校验 → resolveWithinRoot → 隐藏目录降噪过滤。保存三重护栏:readOnly 门+mtime 乐观锁+集中式 percent-encode 备份。

**Tech Stack:** TypeScript(ES2022/strict/ESM)+ node:fs/node:path + CodeMirror 5(npm 包构建期拷贝,同源资产端点)+ Vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-web-gui-files-design.md`(v2,独立审阅 1B+7I+8M 已闭环)——**本 plan 从 spec 论证,执行者必须同时读 spec**。

## Global Constraints(来自 spec,每任务隐含遵守)

- 简体中文回复/注释;文件引用绝对路径;Conventional Commits(type 英文+subject 中文)
- ESM import 带 `.js` 扩展名;`strict: true`+`noUncheckedIndexedAccess`;禁 `any`(eslint error);禁模块级 setter
- 默认不发版:本批不 bump version/不发 npm/不打 tag(变更进 CHANGELOG `[Unreleased]`)
- 完成前必跑:`npm run lint` + `npm run build` + `npm test` 全绿
- 安全硬规则(spec §3.2/§3.3/§5.2/§5.3,不可弱化):
  - projectPath 过 `isPathInAllowedRoots` + `project.godot` 存在校验;rel 过 `resolveWithinRoot`;PathError→403
  - 保存:文件不存在一律 404(含 baseMtime=0);mtime 不一致 409+最新内容;备份 percent-encode 0o600;原子写 tmp+rename
  - CSP 放宽为 `default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self'; media-src 'self'; connect-src 'self'`(GET / 响应)
  - raw 响应附加 `content-security-policy: default-src 'none'` + `x-content-type-options: nosniff`
  - `/assets/*` 走 authorized() 三通道;枚举式 6 文件清单;默认根 `join(__dirname, 'assets')`+assetsDir 注入
- 大小上限:文本 512KB / 图片 raw 10MB / 音频 raw 20MB / 其他 raw 50MB(下载场景,plan 补充细化)/ hex 采样 4KB / POST body 600KB(handle 层 content-length 预检)
- 前端零 innerHTML(动态内容全 textContent);事件委托挂容器;零外链(src 只允许相对路径)

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/web-gui/files-api.ts` | Create | 列目录/读三模式/保存三护栏纯逻辑+路径安全链 |
| `test/web-gui/files-api.test.ts` | Create | files-api 单测 |
| `src/web-gui/server.ts` | Modify | 4 端点+错误映射+CSP 放宽+assets 枚举+body 预检 |
| `test/web-gui/server-files.test.ts` | Create | server 端点单测 |
| `scripts/copy-codemirror.mjs` | Create | 构建期拷贝 CM 6 文件,失败 throw |
| `package.json` | Modify | deps+files 白名单+build 链 |
| `test/web-gui/cm-build.test.ts` | Create | 构建产物存在性(skipIf 未 build) |
| `src/web-gui/html.ts` | Modify | 中列 tab+文件列表+编辑视图 |
| `test/web-gui/html.test.ts` | Modify | 机制标记断言追加 |
| `src/GodotServer.ts` | Modify | files IIFE 接线 |
| `test/web-gui/wiring-files.test.ts` | Create | 接线测试 |
| `CHANGELOG.md` | Modify | `[Unreleased]` 段追加 |

---

### Task 1: files-api 模块(纯逻辑+路径安全链+三重护栏)

**Files:**
- Create: `src/web-gui/files-api.ts`
- Test: `test/web-gui/files-api.test.ts`

**Interfaces:**
- Consumes: `src/core/path-utils.ts` 的 `isPathInAllowedRoots(p: string): boolean`(path-utils.ts:251)、`resolveWithinRoot(root: string, userPath: string): string`(path-utils.ts:156,逃逸抛 `PathError`,from `src/core/tool-errors.js`)
- Produces(Task 2/6 消费,签名精确):
```ts
export interface DirEntry { name: string; isDir: boolean; size: number; mtime: number; }
export interface TextFileContent { content: string; mtime: number; size: number; }
export interface RawFile { bytes: Buffer; contentType: string; size: number; }
export interface HexSample { size: number; bytes: number[]; }
export type FilesErrorCode = 'forbidden' | 'not_found' | 'too_large' | 'conflict' | 'bad_request';
export class FilesError extends Error {
  constructor(public readonly code: FilesErrorCode, message: string,
              public readonly latestContent?: string, public readonly latestMtime?: number) { super(message); this.name = 'FilesError'; }
}
export const TEXT_EXTS: ReadonlySet<string>;   // 'gd','tscn','tres','json','md','cfg','import','txt','gdignore','gitignore','bat','sh','ps1'
export const IMG_EXTS: ReadonlySet<string>;    // 'png','jpg','jpeg','webp','svg'
export const AUDIO_EXTS: ReadonlySet<string>;  // 'ogg','wav','mp3'
export class FilesApi {
  constructor(opts?: { backupDir?: string })   // 缺省 join(homedir(),'.godot-mcp','web-gui','backups')
  listDir(projectPath: string, sub: string): Promise<{ entries: DirEntry[] }>;
  readText(projectPath: string, rel: string): Promise<TextFileContent>;
  readRaw(projectPath: string, rel: string): Promise<RawFile>;
  readHex(projectPath: string, rel: string): Promise<HexSample>;
  saveText(projectPath: string, rel: string, content: string, baseMtime: number): Promise<{ mtime: number }>;
}
```

- [ ] **Step 1: 写失败测试(核心用例全文)**

```ts
// test/web-gui/files-api.test.ts
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesApi, FilesError, TEXT_EXTS } from '../../src/web-gui/files-api.js';
import { PathError } from '../../src/core/tool-errors.js';

describe('FilesApi(spec §3,2026-09-15 v2)', () => {
  let root = ''; let proj = ''; let outside = ''; let backupDir = ''; let api: FilesApi;
  const GOOD = 'GODOT_MCP_UNRESTRICTED';   // 白名单用例须删 UNRESTRICTED(setup.js 全局设了 true)
  let prevUnrestricted: string | undefined; let prevAllowed: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'files-api-root-'));
    proj = join(root, 'proj');
    outside = await mkdtemp(join(tmpdir(), 'files-api-out-'));
    backupDir = await mkdtemp(join(tmpdir(), 'files-api-bak-'));
    await mkdir(join(proj, 'scripts'), { recursive: true });
    await mkdir(join(proj, '.godot'), { recursive: true });
    await writeFile(join(proj, 'project.godot'), '; p\n', 'utf-8');
    await writeFile(join(proj, 'main.gd'), 'extends Node\n', 'utf-8');
    await writeFile(join(proj, 'scripts', 'util.gd'), 'func x():\n\tpass\n', 'utf-8');
    await writeFile(join(proj, '.godot', 'cache.bin'), 'x', 'utf-8');
    api = new FilesApi({ backupDir });
    prevUnrestricted = process.env[GOOD]; prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
    delete process.env[GOOD]; process.env.ALLOWED_PROJECT_PATHS = root;
  });
  afterAll(async () => {
    process.env[GOOD] = prevUnrestricted;
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS; else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    for (const d of [root, outside, backupDir]) await rm(d, { recursive: true, force: true });
  });

  describe('listDir', () => {
    it('根目录:目录在前字母序;.godot 隐藏过滤', async () => {
      const { entries } = await api.listDir(proj, '');
      expect(entries.map(e => e.name)).toEqual(['scripts', 'main.gd', 'project.godot']);
      expect(entries[0]!.isDir).toBe(true);
    });
    it('子目录 entries 含 size/mtime;空 sub=根 normalize', async () => {
      const { entries } = await api.listDir(proj, 'scripts');
      expect(entries.map(e => e.name)).toEqual(['util.gd']);
      expect(entries[0]!.size).toBeGreaterThan(0);
    });
    it('白名单外 → FilesError forbidden', async () => {
      await expect(api.listDir(outside, '')).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('无 project.godot → not_found(I-4:files 边界=Godot 项目)', async () => {
      const notProj = join(root, 'notproj'); await mkdir(notProj); await writeFile(join(notProj, 'x.txt'), 'x', 'utf-8');
      await expect(api.listDir(notProj, '')).rejects.toMatchObject({ code: 'not_found' });
    });
    it('sub 含 ../ 逃逸 → forbidden(resolveWithinRoot 抛 PathError 被转)', async () => {
      await expect(api.listDir(proj, '../out')).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('项目根不存在 → not_found', async () => {
      await expect(api.listDir(join(root, 'nope'), '')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('readText', () => {
    it('返回 content/mtime/size', async () => {
      const r = await api.readText(proj, 'main.gd');
      expect(r.content).toBe('extends Node\n'); expect(r.size).toBeGreaterThan(0); expect(r.mtime).toBeGreaterThan(0);
    });
    it('非文本扩展 → bad_request(纵深防御)', async () => {
      await writeFile(join(proj, 'sprite.png'), 'png', 'utf-8');
      await expect(api.readText(proj, 'sprite.png')).rejects.toMatchObject({ code: 'bad_request' });
    });
    it('>512KB → too_large', async () => {
      await writeFile(join(proj, 'big.gd'), 'x'.repeat(512 * 1024 + 1), 'utf-8');
      await expect(api.readText(proj, 'big.gd')).rejects.toMatchObject({ code: 'too_large' });
    });
    it('TEXT_EXTS 含 godot 全家:import/tres/tscn/gdignore 可读', async () => {
      for (const f of ['a.import', 'b.tres', 'c.tscn', '.gdignore']) await writeFile(join(proj, f), 'v', 'utf-8');
      for (const f of ['a.import', 'b.tres', 'c.tscn', '.gdignore']) expect((await api.readText(proj, f)).content).toBe('v');
    });
  });

  describe('readRaw/readHex', () => {
    it('raw 返回 bytes+contentType(png→image/png;未知→application/octet-stream)', async () => {
      const r = await api.readRaw(proj, 'sprite.png');
      expect(r.contentType).toBe('image/png'); expect(r.bytes.length).toBe(3);
    });
    it('svg → image/svg+xml', async () => {
      await writeFile(join(proj, 'icon.svg'), '<svg/>', 'utf-8');
      expect((await api.readRaw(proj, 'icon.svg')).contentType).toBe('image/svg+xml');
    });
    it('图片 >10MB / 音频 >20MB / 其他 >50MB → too_large', async () => {
      await writeFile(join(proj, 'huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
      await expect(api.readRaw(proj, 'huge.png')).rejects.toMatchObject({ code: 'too_large' });
      await writeFile(join(proj, 'huge.bin'), Buffer.alloc(50 * 1024 * 1024 + 1));
      await expect(api.readRaw(proj, 'huge.bin')).rejects.toMatchObject({ code: 'too_large' });
    });
    it('hex 采样前 4KB,bytes 长度封顶,size 报真实值', async () => {
      await writeFile(join(proj, 'data.bin'), Buffer.alloc(8192, 7));
      const h = await api.readHex(proj, 'data.bin');
      expect(h.size).toBe(8192); expect(h.bytes).toHaveLength(4096); expect(h.bytes[0]).toBe(7);
    });
    it('小文件 hex 返回全部字节', async () => {
      const h = await api.readHex(proj, 'sprite.png');
      expect(h.bytes).toHaveLength(3);
    });
  });

  describe('saveText 三重护栏(spec §3.3)', () => {
    it('成功保存:返回新 mtime;内容落盘', async () => {
      const cur = await api.readText(proj, 'main.gd');
      const { mtime } = await api.saveText(proj, 'main.gd', 'extends Node2D\n', cur.mtime);
      expect(mtime).toBeGreaterThan(0);
      expect(await readFile(join(proj, 'main.gd'), 'utf-8')).toBe('extends Node2D\n');
    });
    it('保存前写备份:backupDir 下 percent-encode 路径 .bak 存在且等于旧内容', async () => {
      await writeFile(join(proj, 'main.gd'), 'OLD', 'utf-8');
      const cur = await api.readText(proj, 'main.gd');
      await api.saveText(proj, 'main.gd', 'NEW', cur.mtime);
      const projEnc = proj.replaceAll('\\', '%5C').replaceAll(':', '%3A');
      const relEnc = 'main.gd';
      const bak = await readFile(join(backupDir, projEnc, relEnc + '.bak'), 'utf-8');
      expect(bak).toBe('OLD');
    });
    it('mtime 不一致 → conflict + latestContent/latestMtime 随错误返回', async () => {
      const stale = await api.readText(proj, 'main.gd');
      await api.saveText(proj, 'main.gd', 'CHANGED-EXTERNAL', stale.mtime);   // 外部先改
      const err = await api.saveText(proj, 'main.gd', 'MINE', stale.mtime).catch(e => e as FilesError);
      expect(err).toBeInstanceOf(FilesError); expect(err.code).toBe('conflict');
      expect(err.latestContent).toBe('CHANGED-EXTERNAL'); expect(err.latestMtime).toBeGreaterThan(0);
    });
    it('文件不存在一律 404(含 baseMtime=0,堵创建后门 I-5)', async () => {
      await expect(api.saveText(proj, 'new-file.gd', 'x', 0)).rejects.toMatchObject({ code: 'not_found' });
      await expect(api.saveText(proj, 'gone.gd', 'x', 12345)).rejects.toMatchObject({ code: 'not_found' });
    });
    it('非文本扩展保存 → bad_request', async () => {
      const st = await (await import('node:fs/promises')).stat(join(proj, 'sprite.png'));
      await expect(api.saveText(proj, 'sprite.png', 'x', st.mtimeMs)).rejects.toMatchObject({ code: 'bad_request' });
    });
    it('rel 逃逸 → forbidden', async () => {
      await expect(api.saveText(proj, '../evil.gd', 'x', 0)).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  it('PathError 直接透传语义受控:所有 forbidden 判定均经 isPathInAllowedRoots+resolveWithinRoot', async () => {
    // 反向确认:合法子路径深层可读
    const r = await api.readText(proj, join('scripts', 'util.gd'));
    expect(r.content).toContain('pass');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/files-api.test.ts`
Expected: FAIL——`Cannot find module '../../src/web-gui/files-api.js'`

- [ ] **Step 3: 实现 files-api.ts**

```ts
// src/web-gui/files-api.ts
// 资源管理工作台纯逻辑层(spec 2026-09-15 v2 §3):列目录/读三模式/保存三重护栏。
// 路径安全链(§3.2):isPathInAllowedRoots+project.godot 校验 → resolveWithinRoot → 隐藏降噪。
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { isPathInAllowedRoots, resolveWithinRoot } from '../core/path-utils.js';

export interface DirEntry { name: string; isDir: boolean; size: number; mtime: number; }
export interface TextFileContent { content: string; mtime: number; size: number; }
export interface RawFile { bytes: Buffer; contentType: string; size: number; }
export interface HexSample { size: number; bytes: number[]; }

export type FilesErrorCode = 'forbidden' | 'not_found' | 'too_large' | 'conflict' | 'bad_request';

export class FilesError extends Error {
  constructor(public readonly code: FilesErrorCode, message: string,
              public readonly latestContent?: string, public readonly latestMtime?: number) {
    super(message); this.name = 'FilesError';
  }
}

export const TEXT_EXTS: ReadonlySet<string> = new Set([
  'gd', 'tscn', 'tres', 'json', 'md', 'cfg', 'import', 'txt', 'gdignore', 'gitignore', 'bat', 'sh', 'ps1',
]);
export const IMG_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
export const AUDIO_EXTS: ReadonlySet<string> = new Set(['ogg', 'wav', 'mp3']);

const HIDDEN_DIRS = new Set(['.godot', '.git', '__pycache__', 'node_modules']);
const TEXT_MAX = 512 * 1024;
const IMG_MAX = 10 * 1024 * 1024;
const AUDIO_MAX = 20 * 1024 * 1024;
const OTHER_RAW_MAX = 50 * 1024 * 1024;
export const HEX_SAMPLE_BYTES = 4096;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
};

function ext(name: string): string { return extname(name).slice(1).toLowerCase(); }

/** 统一入口安全链(§3.2):白名单+project.godot→resolveWithinRoot;任何 PathError→forbidden。 */
function resolveInProject(projectPath: string, rel: string): string {
  if (!isPathInAllowedRoots(projectPath)) throw new FilesError('forbidden', 'path outside allowed roots');
  if (!existsSync(join(projectPath, 'project.godot'))) throw new FilesError('not_found', 'not a godot project (project.godot missing)');
  try {
    return resolveWithinRoot(projectPath, rel);
  } catch {
    throw new FilesError('forbidden', 'path escapes project root');
  }
}

export class FilesApi {
  private readonly backupDir: string;

  constructor(opts: { backupDir?: string } = {}) {
    this.backupDir = opts.backupDir ?? join(homedir(), '.godot-mcp', 'web-gui', 'backups');
  }

  async listDir(projectPath: string, sub: string): Promise<{ entries: DirEntry[] }> {
    const dir = resolveInProject(projectPath, sub);
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); }
    catch { throw new FilesError('not_found', 'directory not found'); }
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;   // 浏览层降噪(§3.2-3),非访问控制
      let size = 0; let mtime = 0;
      try { const st = await stat(join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch { /* 竞态删除:显示 0 */ }
      entries.push({ name: d.name, isDir: d.isDirectory(), size, mtime });
    }
    entries.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
    return { entries };
  }

  async readText(projectPath: string, rel: string): Promise<TextFileContent> {
    const abs = resolveInProject(projectPath, rel);
    if (!TEXT_EXTS.has(ext(basename(abs)))) throw new FilesError('bad_request', 'not a text extension; use preview mode');
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    if (st.size > TEXT_MAX) throw new FilesError('too_large', `file ${st.size}B exceeds 512KB text limit`);
    const content = await readFile(abs, 'utf-8');
    return { content, mtime: st.mtimeMs, size: st.size };
  }

  async readRaw(projectPath: string, rel: string): Promise<RawFile> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    const e = ext(basename(abs));
    const max = IMG_EXTS.has(e) ? IMG_MAX : AUDIO_EXTS.has(e) ? AUDIO_MAX : OTHER_RAW_MAX;
    if (st.size > max) throw new FilesError('too_large', `file ${st.size}B exceeds raw limit`);
    const bytes = await readFile(abs);
    return { bytes, contentType: CONTENT_TYPES[e] ?? 'application/octet-stream', size: st.size };
  }

  async readHex(projectPath: string, rel: string): Promise<HexSample> {
    const abs = resolveInProject(projectPath, rel);
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found'); }
    const fh = await readFile(abs);
    return { size: st.size, bytes: Array.from(fh.subarray(0, HEX_SAMPLE_BYTES)) };
  }

  async saveText(projectPath: string, rel: string, content: string, baseMtime: number): Promise<{ mtime: number }> {
    const abs = resolveInProject(projectPath, rel);
    if (!TEXT_EXTS.has(ext(basename(abs)))) throw new FilesError('bad_request', 'not a text extension');
    let st; try { st = await stat(abs); } catch { throw new FilesError('not_found', 'file not found (creation not supported)'); }
    if (st.mtimeMs !== baseMtime) {   // 乐观锁(§3.3-2):冲突带最新内容供前端提示
      const latest = await readFile(abs, 'utf-8');
      throw new FilesError('conflict', 'file modified since loaded', latest, st.mtimeMs);
    }
    // 备份(§3.3-3):percent-encode 可逆无碰撞;0o600 滚动覆盖
    const projEnc = projectPath.replaceAll('\\', '%5C').replaceAll(':', '%3A').replaceAll('/', '%2F');
    const relEnc = rel.replaceAll('\\', '%5C').replaceAll(':', '%3A').replaceAll('/', '%2F');
    const bakDir = join(this.backupDir, projEnc);
    await mkdir(bakDir, { recursive: true });
    await writeFile(join(bakDir, relEnc + '.bak'), await readFile(abs), { mode: 0o600 });
    // 原子写(§3.3-4)
    const tmp = abs + '.mcp-tmp';
    await writeFile(tmp, content, 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, abs);
    const after = await stat(abs);
    return { mtime: after.mtimeMs };
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run test/web-gui/files-api.test.ts`
Expected: PASS 全部用例

- [ ] **Step 5: lint+commit**

```bash
npm run lint
git add src/web-gui/files-api.ts test/web-gui/files-api.test.ts
git commit -m "feat(web-gui): files-api 模块——列目录/读三模式/保存三重护栏+三层路径安全链(spec §3)"
```

---

### Task 2: server 4 端点+CSP 放宽+assets 枚举+body 预检

**Files:**
- Modify: `src/web-gui/server.ts`
- Test: `test/web-gui/server-files.test.ts`(Create)

**Interfaces:**
- Consumes: Task 1 的 `FilesApi`/`FilesError`(code→HTTP 映射:forbidden→403/not_found→404/too_large→413/conflict→409/bad_request→400);`WebGuiServerOptions`(server.ts:37 起,已有 registryDir/logDir/token 先例)
- Produces(Task 4/5/6 消费):
  - `WebGuiServerOptions` 新增 `files?: FilesApi` 与 `assetsDir?: string`
  - 端点契约(前端 fetch 用):`GET /api/projects/files?project=&sub=` → 200 `{entries}`;`GET /api/projects/file?project=&path=&mode=text` → 200 `{content,mtime,size}`;`POST /api/projects/file` body `{project,path,content,baseMtime}` → 200 `{mtime}` / 409 `{error,latest:{content,mtime}}`;`GET /assets/{name}` → 200 资产
  - GET / 响应 CSP 头新值(见 Global Constraints);raw 响应防线头

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/server-files.test.ts`
Expected: FAIL——CSP 头不匹配/端点 404/503 语义缺失

- [ ] **Step 3: 实现 server.ts 变更**

改点(逐处):
1. import 追加:`import { FilesError, type FilesApi } from './files-api.js';` + `node:path` 的 `join/resolve` + `node:fs` 的 `readFileSync`/`existsSync` + `node:url` 的 `fileURLToPath`
2. `WebGuiServerOptions` 加两字段(对齐 registryDir 位置):`files?: FilesApi; assetsDir?: string;`
3. GET / 的 CSP 头(server.ts:230)替换为 Global Constraints 的六段值
4. GET 侧(在 `/api/projects` 之后、`/api/auth` 前后按现有顺序)加三路由:
   - `/api/projects/files`:authorized 后 `if (!this.opts.files) return json(503,...)`;调 listDir,FilesError catch 转 `{forbidden:403,not_found:404}`[+ bad_request/too_large 对应],成功 `json(200, {entries})`
   - `/api/projects/file`(GET):同上按 mode 分派 text/raw/hex;raw 用 `res.writeHead(200, {'content-type':f.contentType,'content-security-policy':"default-src 'none'",'x-content-type-options':'nosniff'}); res.end(f.bytes)`
   - `/assets/{name}`:authorized 后取 `url.pathname.slice('/assets/'.length)`,在固定清单 `ASSET_FILES = ['codemirror.js','codemirror.css','mode-python.js','mode-javascript.js','mode-markdown.js','mode-xml.js']` 内精确匹配(含 `/` 或不在清单 → 404);文件读 `join(this.assetsRoot, name)`,不存在 404;响应头 `{'content-type': 按 .js/.css,'cache-control':'private, max-age=86400'}`;`assetsRoot` 构造时定:`opts.assetsDir ?? join(__dirname, 'assets')`(__dirname 由 `fileURLToPath(import.meta.url)` 取,与 index.ts 同法)
5. POST 侧(在 `/api/projects/scan` 分支前)加 `/api/projects/file`:
   - **body 预检**:`const cl = Number(req.headers['content-length'] ?? 0); if (cl > 600 * 1024) return json(413, { error: 'payload too large' });`
   - readJsonBody 后调 saveText;FilesError 映射:conflict → `json(409, { error: msg, latest: { content: e.latestContent, mtime: e.latestMtime } })`
   - audit log:`getLogger().info('web-gui', \`action=file_save project=${project} path=${path} result=${status}\`)`(成功与失败都记,对齐现有 add/remove 惯例)
6. files 相关错误统一 helper:`private filesErr(e: unknown, json): void`(FilesError→码映射,未知→500),三 GET+一 POST 共用

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run test/web-gui/server-files.test.ts`
Expected: PASS 全部

- [ ] **Step 5: 回归既有 web-gui 测试(CSP 变更可能影响 server-http 旧断言)**

Run: `npx vitest run test/web-gui/`
Expected: 全绿;若 server-http.test.ts 有旧 CSP 精确断言,**更新该断言为六段新值**(注明 spec §5.2)

- [ ] **Step 6: lint+commit**

```bash
npm run lint
git add src/web-gui/server.ts test/web-gui/server-files.test.ts test/web-gui/server-http.test.ts
git commit -m "feat(web-gui): files 4 端点+assets 枚举(assetsDir 注入)+CSP 放宽+raw 响应头防线+POST body 预检(spec §4/§5)"
```

---

### Task 3: CodeMirror 构建链(npm dep+build 拷贝+files 白名单)

**Files:**
- Create: `scripts/copy-codemirror.mjs`
- Modify: `package.json`(dependencies+files+build 脚本)
- Test: `test/web-gui/cm-build.test.ts`(Create)

**Interfaces:**
- Consumes: npm registry 的 `codemirror@^5.65`(lib/codemirror.js 402KB/lib/codemirror.css/mode/{python,javascript,markdown,xml}/*.js,spec §5.1 实测无 .min)
- Produces(Task 4/5 前端经 `/assets/*` 端点消费的 6 文件;Task 2 的 ASSET_FILES 清单名即产物名):`build/web-gui/assets/{codemirror.js,codemirror.css,mode-python.js,mode-javascript.js,mode-markdown.js,mode-xml.js}`

- [ ] **Step 1: 安装依赖+写拷贝脚本**

```bash
npm install codemirror@^5.65
```

```js
// scripts/copy-codemirror.mjs
// 构建期拷贝 CodeMirror 6 文件到 build/web-gui/assets/(spec §5.1)。
// 拷贝失败 throw——不静默降级,防发布残缺资产。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓库根
const src = join(root, 'node_modules', 'codemirror');
const dst = join(root, 'build', 'web-gui', 'assets');

const FILES = [
  ['lib/codemirror.js', 'codemirror.js'],
  ['lib/codemirror.css', 'codemirror.css'],
  ['mode/python/python.js', 'mode-python.js'],
  ['mode/javascript/javascript.js', 'mode-javascript.js'],
  ['mode/markdown/markdown.js', 'mode-markdown.js'],
  ['mode/xml/xml.js', 'mode-xml.js'],
];

if (!existsSync(src)) throw new Error(`codemirror not installed: ${src} missing — run npm install`);
mkdirSync(dst, { recursive: true });
for (const [from, to] of FILES) {
  copyFileSync(join(src, from), join(dst, to));
  console.log(`Copied codemirror: ${from} -> web-gui/assets/${to}`);
}
```

- [ ] **Step 2: package.json 三处变更**

1. `"build"` 脚本链尾追加 ` && node scripts/copy-codemirror.mjs`(现链:`tsc && node -e ... && node scripts/copy-game-templates.mjs`,package.json:37)
2. `files` 数组追加 `"build/web-gui/assets/**"`(I-3:否则 npm publish 缺 .css)
3. `dependencies` 出现 `codemirror`(npm install 自动加,确认即可)

- [ ] **Step 3: 写产物存在性测试**

```ts
// test/web-gui/cm-build.test.ts
// 构建产物存在性(spec §5.1/任务 3);本地未 build 时 skip(红=提示先 npm run build)。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'web-gui', 'assets');
const built = existsSync(assetsDir);

describe.skipIf(!built)('CodeMirror 构建产物(spec §5.1,6 文件)', () => {
  for (const f of ['codemirror.js', 'codemirror.css', 'mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js']) {
    it(`${f} 存在且非空`, () => {
      const p = join(assetsDir, f);
      expect(existsSync(p)).toBe(true);
      const { statSync } = require('node:fs');
      expect(statSync(p).size).toBeGreaterThan(100);
    });
  }
  it('codemirror.js 是 CM5 UMD(挂 window.CodeMirror 的 defineMode 机制)', () => {
    const { readFileSync } = require('node:fs');
    const js = readFileSync(join(assetsDir, 'codemirror.js'), 'utf-8');
    expect(js).toContain('CodeMirror');
  });
});
```

注:ESM 下测试用 `import { statSync, readFileSync } from 'node:fs'` 顶部导入(勿用 require——本项目 `"type": "module"`)。

- [ ] **Step 4: 跑构建+测试确认绿**

Run: `npm run build && npx vitest run test/web-gui/cm-build.test.ts`
Expected: build 输出 6 行 `Copied codemirror:`;测试 PASS(若 skip 说明 build 没跑,重跑 build)

- [ ] **Step 5: lint+commit**

```bash
npm run lint
git add scripts/copy-codemirror.mjs package.json package-lock.json test/web-gui/cm-build.test.ts
git commit -m "build(web-gui): CodeMirror 构建链——npm dep+按需拷贝 6 文件+files 白名单补 assets(I-3)"
```

---

### Task 4: 前端文件 tab+列表视图

**Files:**
- Modify: `src/web-gui/html.ts`
- Test: `test/web-gui/html.test.ts`(追加)

**Interfaces:**
- Consumes: Task 2 端点契约(`GET /api/projects/files?project=&sub=` → `{entries:[{name,isDir,size,mtime}]}`);现有事件委托模式(html.ts:379)/`fmtAgo`(html.ts:167)/token 变量(html.ts:87 sessionStorage)
- Produces(Task 5 消费):全局前端状态 `filesState = { project: string|null, sub: string, entries: DirEntry[] }`;容器 `#filesPane` 与 tab 切换函数 `showTab('logs'|'files')`;行点击按扩展路由的分发点 `openFileEntry(name, isDir)`(Task 5 在其上接编辑视图)

- [ ] **Step 1: 写失败测试(html.test.ts 追加)**

```ts
  // ── 资源管理批(Plan A Task 4,spec §6.1/§6.2)──────────────────────────────
  it('文件 tab 与项目行「文件」按钮(中列主区,spec M-10)', () => {
    expect(INDEX_HTML).toContain("showTab");                    // tab 切换函数
    expect(INDEX_HTML).toContain("'files'");                    // tab 名
    expect(INDEX_HTML).toContain("data-action");                // 委托覆盖 files action
    expect(INDEX_HTML).toContain('filesPane');                  // 文件视图容器
    expect(INDEX_HTML).toContain("action === 'files'");         // 项目行「文件」按钮分发
  });
  it('文件列表:fmtSize 新写+面包屑+目录先排序渲染+隐藏目录由 server 过滤(前端不重复)', () => {
    expect(INDEX_HTML).toContain('function fmtSize');           // 新写(M-11)
    expect(INDEX_HTML).not.toContain("fmtSize 复用");
    expect(INDEX_HTML).toContain('breadcrumb');                 // 面包屑导航
    expect(INDEX_HTML).toContain('/api/projects/files');        // 列目录端点
    expect(INDEX_HTML).toContain('isDir');                      // 目录/文件行区分
  });
  it('文件 tab 请求拼 token(JS 变量,M-9):fetch 对 files 端点带鉴权', () => {
    expect(INDEX_HTML).toContain("'x-gui-token'");              // 现有请求头模式延续到 files 端点
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/html.test.ts`
Expected: 新用例 FAIL(fmtSize/filesPane 不存在)

- [ ] **Step 3: 实现(html.ts 改点)**

1. **中列改造**:中列容器(html.ts 中列 logs 区)顶部加 tab 条 `<div class="tabs"><button id="tabLogs" class="tab on">日志</button><button id="tabFiles" class="tab">文件</button></div>`;原日志流包进 `#logsPane`;新增 `<div id="filesPane" style="display:none"></div>`;`showTab(name)` 函数切 display+tab on 类
2. **项目行**:`renderProjects` 行内按钮组追加 `<button class="ctl" data-action="files" title="浏览文件">文件</button>`(Missing 行 disabled 对齐 run/edit,html.ts:200 附近)
3. **委托分发**(现有 #projPane 委托内):`action === 'files'` → `openFiles(projectPath)`:`filesState.project=projectPath; filesState.sub=''; showTab('files'); loadDir()`
4. **loadDir()**:`fetch('/api/projects/files?project='+encodeURIComponent(project)+'&sub='+encodeURIComponent(sub), {headers:{'x-gui-token':token}})` → 200 存 `filesState.entries` + `renderFiles()`;非 200 statusBar 提示(403/404 文案区分)
5. **renderFiles()**:
   - 面包屑:`项目名`(点击回根)+ 逐段 sub 路径(点击回跳该层)
   - 列表行(div.file-row,目录行 data-dir、文件行 data-file,均 textContent 构建):
     `名称 + (isDir?'📁':'') + fmtSize(size) + fmtAgo(mtime)`
   - 新函数 `function fmtSize(n){ if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; if(n<1073741824)return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }`
6. **#filesPane 委托**(容器级,对齐 #sessions 模式):目录行 click → `filesState.sub=join(sub,dir); loadDir()`;文件行 click → `openFileEntry(name, false)`——**本任务内该函数先落文本路由骨架**:`TEXT_EXTS` 前端副本(与 server 同清单)判定,命中则 statusBar 提示「编辑视图(Task 5)」占位;IMG/AUDIO/其余同样占位提示
7. `filesState` 全局变量:`var filesState = { project: null, sub: '', entries: [] };`

- [ ] **Step 4: 跑测试确认绿+回归**

Run: `npx vitest run test/web-gui/html.test.ts && npm run build`
Expected: 全 PASS(html.ts 是 TS 字符串模块,build 确认模板无语法错)

- [ ] **Step 5: lint+commit**

```bash
npm run lint
git add src/web-gui/html.ts test/web-gui/html.test.ts
git commit -m "feat(web-gui): 中列日志|文件 tab+项目行文件入口+目录列表视图(面包屑/fmtSize/委托,spec §6.1-6.2)"
```

---

### Task 5: 前端编辑视图(CodeMirror 动态加载+三重护栏 UI+409 流)

**Files:**
- Modify: `src/web-gui/html.ts`
- Test: `test/web-gui/html.test.ts`(追加)

**Interfaces:**
- Consumes: Task 4 的 `openFileEntry` 分发点/`filesState`/`showTab`;Task 2 端点(`GET ...&mode=text` → `{content,mtime,size}`;`POST` → 200 `{mtime}` / 409 `{error,latest:{content,mtime}}`);`/assets/codemirror.js` 等 6 资产
- Produces: 编辑视图函数群 `openEditor(rel)`/`ensureCodeMirror(cb)`/`saveEditor()`;全局 `editorState = { rel, baseMtime, dirty }`;hello 只读标记消费(现有 readOnly 判定已在 start 403 文案体系,本任务复用 `state.readOnly` 若无则新增自 hello)

- [ ] **Step 1: 写失败测试(html.test.ts 追加)**

```ts
  // ── 资源管理批(Plan A Task 5,spec §6.3)──────────────────────────────────
  it('CM 动态加载:createElement script + src 拼 JS 变量 token(M-9)+只加载一次', () => {
    expect(INDEX_HTML).toContain("createElement('script')");
    expect(INDEX_HTML).toContain("'/assets/codemirror.js?token=' + token");   // 变量拼接,非字符串字面量
    expect(INDEX_HTML).toContain('cmLoaded');                                 // 一次加载标志
    expect(INDEX_HTML).toContain("'/assets/codemirror.css?token=' + token");  // css 同通道
  });
  it('mode 路由:gd→python 近似/json→javascript/md→markdown/其余 plain', () => {
    expect(INDEX_HTML).toContain("modeForFile");                              // 路由函数
    expect(INDEX_HTML).toContain("'python'");
    expect(INDEX_HTML).toContain("'javascript'");
    expect(INDEX_HTML).toContain("'markdown'");
  });
  it('保存三重护栏 UI:baseMtime 随请求/409 latest 消费/脏标 confirm', () => {
    expect(INDEX_HTML).toContain('baseMtime');
    expect(INDEX_HTML).toContain('latest');                                   // 409 响应体消费
    expect(INDEX_HTML).toContain('文件已被外部修改');                          // 冲突文案(spec §3.3-2)
    expect(INDEX_HTML).toContain('dirty');                                    // 脏标
  });
  it('readOnly:编辑器只读+保存隐藏', () => {
    expect(INDEX_HTML).toContain("setOption('readOnly'");
    expect(INDEX_HTML).toContain('只读模式');                                  // 横幅文案
  });
  it('mode 资产与下载链接(预览占位由 Plan B 替换)', () => {
    expect(INDEX_HTML).toContain('mode-python.js');
    expect(INDEX_HTML).toContain('mode-javascript.js');
    expect(INDEX_HTML).toContain('mode-markdown.js');
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run test/web-gui/html.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现(html.ts 改点)**

1. **editorState**:`var editorState = { rel: null, baseMtime: 0, dirty: false, cm: null };`
2. **ensureCodeMirror(cb)**(一次加载):
```js
var cmLoaded = false, cmPending = [];
function ensureCodeMirror(cb) {
  if (cmLoaded) { cb(); return; }
  cmPending.push(cb);
  if (cmPending.length > 1) return;
  var link = document.createElement('link'); link.rel = 'stylesheet';
  link.href = '/assets/codemirror.css?token=' + token; document.head.appendChild(link);
  var s1 = document.createElement('script'); s1.src = '/assets/codemirror.js?token=' + token;
  s1.onload = function () {
    var n = 0, modes = ['mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js'];
    modes.forEach(function (m) {
      var s = document.createElement('script'); s.src = '/assets/' + m + '?token=' + token;
      s.onload = function () { if (++n === modes.length) { cmLoaded = true; cmPending.forEach(function (f) { f(); }); cmPending = []; } };
      document.head.appendChild(s);
    });
  };
  document.head.appendChild(s1);
}
```
3. **modeForFile(rel)**:`gd→'python'`/`json→{name:'javascript', json:true}`/`md→'markdown'`/其余 `null`(plain)
4. **openEditor(rel)**(由 Task 4 openFileEntry 文本分支调用):
   - fetch text 模式 → `editorState = {rel, baseMtime: r.mtime, dirty: false}`
   - `#filesPane` 内切编辑子视图:工具行(保存/重新加载/返回列表)+ `<textarea id="cmHost">` + 状态栏(mtime/size)
   - `ensureCodeMirror(function(){ editorState.cm = CodeMirror.fromTextArea(cmHost, { lineNumbers: true, mode: modeForFile(rel), readOnly: state.readOnly ? true : false }); editorState.cm.on('change', function(){ editorState.dirty = true; 保存钮显示 ● }); })`
   - readOnly → 顶部横幅「只读模式」+ 保存钮隐藏
5. **saveEditor()**:POST `{project: filesState.project, path: editorState.rel, content: cm.getValue(), baseMtime: editorState.baseMtime}`
   - 200:`baseMtime=r.mtime; dirty=false;` 状态栏「已保存」
   - 409:确认框「文件已被外部修改(可能是 Godot 编辑器或 AI)」+ 两按钮:「重新加载」(用响应 `latest.content` 重设编辑器+baseMtime=latest.mtime) /「复制我的修改」(navigator.clipboard.writeText(cm.getValue()))
   - 413/403/404:statusBar 显示 error
6. **脏标防误切**:`showTab('logs')` 与目录行点击前 `if (editorState.dirty && !confirm('有未保存修改,离开将丢失'))return;`
7. **openFileEntry 补全**:文本扩展 → `openEditor(name)`;IMG/AUDIO/其余 → statusBar「预览(Plan B)」占位

- [ ] **Step 4: 跑测试确认绿+build**

Run: `npx vitest run test/web-gui/html.test.ts && npm run build`
Expected: 全 PASS

- [ ] **Step 5: lint+commit**

```bash
npm run lint
git add src/web-gui/html.ts test/web-gui/html.test.ts
git commit -m "feat(web-gui): CodeMirror 编辑视图——动态加载(mode 路由)+三重护栏 UI+409 冲突流+readOnly(spec §6.3)"
```

---

### Task 6: GodotServer 接线+wiring 测试+真机验收

**Files:**
- Modify: `src/GodotServer.ts`(web-gui 组装处,projects IIFE 邻近,GodotServer.ts:561-603)
- Test: `test/web-gui/wiring-files.test.ts`(Create)
- Create: `.superpowers/sdd/2026-09-15-web-gui-files-a/files-acceptance.mjs`(真机验收脚本)
- Modify: `CHANGELOG.md`([Unreleased] 追加)

**Interfaces:**
- Consumes: Task 1 `FilesApi`(构造 `new FilesApi()`,backupDir 缺省 homedir 路径);Task 2 `WebGuiServerOptions.files`
- Produces: 生产链路完整——`GodotServer` 起 web-gui 时注入 files;真机验收报告

- [ ] **Step 1: 写失败 wiring 测试**

```ts
// test/web-gui/wiring-files.test.ts(形态对齐 wiring-projects.test.ts:真实 GodotServer 组装+端口探测)
import { describe, it, expect } from 'vitest';
import { GodotServer } from '../../src/GodotServer.js';
import { getWebGuiInstances } from '../../src/web-gui/registry.js';

describe('GodotServer→WebGuiServer files 接线(spec §3.1,Plan A Task 6)', () => {
  it('组装后 web-gui 实例的 files 能力可用(端到端 listDir 语义)', async () => {
    const srv = new GodotServer(join(__dirname_as_needed, 'scripts', 'godot_operations.gd'), { mode: 'basic' });
    // 注:具体探测方式对齐 wiring-projects.test.ts 现有形态(读 GodotServer 组装的 WebGuiServerOptions
    // 或起服务后打 /api/projects/files 503-vs-200 判定);实施者以 wiring-projects.test.ts 为模板复刻,
    // 断言:注入的 files 为 FilesApi 实例(或缺席语义不触发——files 是必接能力)。
    expect(srv).toBeTruthy();
  });
});
```

(实施者注意:上面骨架里的探测方式**必须**以 `test/web-gui/wiring-projects.test.ts` 的既有模式为准复刻——它是本任务的真实模板;不要发明新探测机制。)

- [ ] **Step 2: 跑测试确认红/确认接缝**

Run: `npx vitest run test/web-gui/wiring-files.test.ts`
Expected: FAIL(GodotServer 未注入 files,503)

- [ ] **Step 3: 实现接线(GodotServer.ts)**

在 projects IIFE(GodotServer.ts:561-569)同级追加:

```ts
// 资源管理工作台(spec 2026-09-15 §3.1):files 注入——纯逻辑模块,backupDir 缺省 ~/.godot-mcp/web-gui/backups
files: new FilesApi(),
```

(import 追加 `import { FilesApi } from './web-gui/files-api.js';`——与 projects-store import 同区块;**core 不依赖 tools 的 eslint 门禁不受影响**,web-gui 内部互引合法)

- [ ] **Step 4: 跑 wiring 测试确认绿+全量门禁**

Run: `npx vitest run test/web-gui/wiring-files.test.ts && npm run lint && npm run build && npm test`
Expected: 全绿

- [ ] **Step 5: 真机验收(spec §8 第 1/2/3/5 条;第 4 条预览属 Plan B)**

脚本 `.superpowers/sdd/2026-09-15-web-gui-files-a/files-acceptance.mjs` 要点(对齐前批 projects-acceptance.mjs 形态):
1. `env -u GODOT_MCP_ALLOW_UNSAFE_CONFIRM` 起 server(必要,否则 H-08 FATAL;`sleep 900 |` 保活 stdin)
2. 从 registry(`~/.godot-mcp/web-gui/<pid>.json`)取端口+token
3. curl 断言:GET /api/projects/files(fixture 项目)200 含 project.godot;GET text 模式 200;POST 保存 200 后 `cat` 验证内容;backups 目录 `.bak` 存在且为旧内容;外部 node 改文件后再 POST → 409;`GODOT_MCP_READ_ONLY=true` 重起 → POST 403
4. Playwright 抽查:面板项目行「文件」按钮 → tab 切换 → 目录渲染 → 打开 .gd 出现 CodeMirror(类 `.CodeMirror` 存在)

Expected: 全部断言 PASS,输出验收清单

- [ ] **Step 6: CHANGELOG+commit**

`CHANGELOG.md` `[Unreleased]` 段追加(Keep a Changelog 风格,参照现有条目):

```
### Added
- Web GUI 资源管理工作台(Plan A):项目行进入文件树浏览、CodeMirror 文本编辑(gd/json/md 高亮)、三重护栏保存(readOnly 门+mtime 乐观锁+集中备份)、raw/hex 端点与响应头防线(Plan B 消费)
```

```bash
git add src/GodotServer.ts test/web-gui/wiring-files.test.ts CHANGELOG.md
git commit -m "feat(web-gui): GodotServer 接线 files 能力+真机验收 PASS(资源管理 Plan A 收口)"
```

---

## Self-Review(controller 执行)

1. **Spec 覆盖**:§3.1(Task 1)/§3.2(Task 1 安全链+测试)/§3.3(Task 1 三护栏)/§3.4(Task 1 上限+Task 2 413)/§4(Task 2 端点+预检+audit log)/§5.1(Task 3)/§5.2(Task 2 CSP)/§5.3(Task 2 assets)/§6.1-6.2(Task 4)/§6.3(Task 5)/§6.4 预览=Plan B(本 plan 只落端点与占位)/§7(Task 1/2/4/5/6 测试矩阵)/§8(Task 6 验收 1/2/3/5+Plan B 验收 4)/§9 任务切分一致。**gap:无**(§6.4 图片/音频/hex 前端视图与 §8.4 属 Plan B,spec §9 明确)。
2. **占位符扫描**:Task 6 Step 1 骨架标注「以 wiring-projects.test.ts 为模板复刻」——这是指向真实模板的引导而非空洞占位,实施者有完整参照物;其余步骤均含实码。Task 4 Step 3 第 6 点 openFileEntry 占位是**设计内的 Task 5 消费点**(Interfaces 已声明),非遗漏。
3. **类型一致性**:`FilesApi` 五方法签名 Task 1 定义,Task 2 Step 3 第 4 点/Task 6 Step 3 消费一致;`DirEntry` 四字段全链一致;`filesState`/`editorState`/`openFileEntry`/`showTab` 在 Task 4/5 Interfaces 与实现一致;assets 6 文件名 Task 2 ASSET_FILES=Task 3 FILES=Task 5 mode 加载一致。
