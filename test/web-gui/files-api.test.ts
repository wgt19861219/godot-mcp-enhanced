// test/web-gui/files-api.test.ts
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
    it('路径是目录 → bad_request 而非裸 EISDIR(M-3)', async () => {
      await mkdir(join(proj, 'adir'), { recursive: true });
      await expect(api.readText(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
      await expect(api.readRaw(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
      await expect(api.readHex(proj, 'adir')).rejects.toMatchObject({ code: 'bad_request' });
    });
    it('目录名带 .gd 扩展 → readText 走 isDirectory 防线而非扩展名检查(M-3 补,Plan B Task 2 Mi-1)', async () => {
      // 'adir.gd' 扩展合法先过扩展名检查,唯一能拦它的是 readText 内 isDirectory 行——
      // 该行的唯一真实覆盖路径;若删该行,readFile(目录) 冒裸 EISDIR,本用例转红。
      await mkdir(join(proj, 'adir.gd'), { recursive: true });
      await expect(api.readText(proj, 'adir.gd')).rejects.toMatchObject({ code: 'bad_request' });
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
    it.skipIf(process.platform === 'win32')('备份子目录以 0o700 创建(spec §3.3-3;Windows ACL 语义不同跳过)', async () => {
      // 自包含触发一次保存:mkdtemp 的 backupDir 父已存在,递归 mkdir 首次创建的层级是 <projEnc> 子目录
      await writeFile(join(proj, 'main.gd'), 'PERM', 'utf-8');
      const cur = await api.readText(proj, 'main.gd');
      await api.saveText(proj, 'main.gd', 'PERM2', cur.mtime);
      const projEnc = proj.replaceAll('\\', '%5C').replaceAll(':', '%3A');
      const st = await stat(join(backupDir, projEnc));
      expect(st.mode & 0o777).toBe(0o700);
    });
    it.skipIf(process.platform === 'win32')('备份 .bak 文件 0o600(内容为旧文件,同 registry 登记文件惯例)', async () => {
      await writeFile(join(proj, 'main.gd'), 'PERMFILE', 'utf-8');
      const cur = await api.readText(proj, 'main.gd');
      await api.saveText(proj, 'main.gd', 'PERMFILE2', cur.mtime);
      const projEnc = proj.replaceAll('\\', '%5C').replaceAll(':', '%3A');
      const st = await stat(join(backupDir, projEnc, 'main.gd.bak'));
      expect(st.mode & 0o777).toBe(0o600);
    });
    // ── 审查 Low(2026-09-17 批 3):备份写后补 hardenFilePermissionsWindows(Windows icacls)
    //    源码契约——.bak 含旧文件全文(恢复价值),Windows 无视 0o600 须 icacls 收紧 ACL,
    //    对齐 registry.ts/projects-store.ts 同域持久化文件惯例;行为级 icacls 语义由
    //    registry 域既有用例覆盖(harden 本身 best-effort),此处锁调用落位防回退。
    it('源码契约:saveText 备份写后调 hardenFilePermissionsWindows(Windows ACL 收紧)', async () => {
      const src = readFileSync(new URL('../../src/web-gui/files-api.ts', import.meta.url), 'utf-8');
      expect(src).toContain("from './registry.js'");
      expect(src).toMatch(/hardenFilePermissionsWindows\(\s*bakPath\s*\)/);      // 落位在 .bak 写入之后(顺序契约:先写后加固,防"加固后覆盖回默认 ACL"反序)
      const writeIdx = src.indexOf('writeFile(bakPath');
      const hardenIdx = src.indexOf('hardenFilePermissionsWindows(bakPath)');
      expect(writeIdx).toBeGreaterThan(-1);
      expect(hardenIdx).toBeGreaterThan(writeIdx);
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
    // ── 2C (2026-09-19 安全加固批2): Web GUI 旁路写接审计——此前 HTTP 文件写零留痕
    //    (可核查缺口 M8)。审计 fire-and-forget,轮询等落盘(最多 ~1s)。
    it('2C: 成功保存 → mcp_audit.jsonl 落 tool=web-gui 审计行(changed_files 项目相对路径)', async () => {
      const cur = await api.readText(proj, 'main.gd');
      await api.saveText(proj, 'main.gd', 'AUDITED\n', cur.mtime);
      const auditPath = join(proj, '.godot', 'mcp_audit.jsonl');
      let last = '';
      for (let i = 0; i < 20 && !last; i++) {
        try { last = readFileSync(auditPath, 'utf8').trim().split('\n').at(-1) ?? ''; } catch { /* 尚未落盘 */ }
        if (!last) await new Promise((r) => setTimeout(r, 50));
      }
      expect(last).not.toBe('');
      const e = JSON.parse(last) as Record<string, unknown>;
      expect(e.tool).toBe('web-gui');
      expect(e.action).toBe('write_file');
      expect(e.risk).toBe('write');
      expect(e.changed_files).toEqual(['main.gd']);
      expect(e.caller).toBe('web-gui');
    });
  });

  it('PathError 直接透传语义受控:所有 forbidden 判定均经 isPathInAllowedRoots+resolveWithinRoot', async () => {
    // 反向确认:合法子路径深层可读
    const r = await api.readText(proj, join('scripts', 'util.gd'));
    expect(r.content).toContain('pass');
  });
});
