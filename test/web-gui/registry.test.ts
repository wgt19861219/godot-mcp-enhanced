// test/web-gui/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRegistration, removeRegistration, listRegistrations, sweepStaleRegistrations, getOrCreateSharedToken, rotateSharedToken } from '../../src/web-gui/registry.js';
import { PROJECT_ENTRY_NAME } from '../../src/web-gui/portal.js';

const ALIVE = () => true;
const DEAD = () => false;

describe('web-gui per-pid 登记(设计 §3.1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-reg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('写 per-pid 文件 + readdir 聚合读回', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'tok-a', startedAt: new Date().toISOString() }, { dir });
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files).toEqual(['111.json']);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list).toHaveLength(1);
    expect(list[0]!.token).toBe('tok-a');
  });

  it('双进程并发登记互不丢失(各写各文件)', async () => {
    await Promise.all([
      writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir }),
      writeRegistration({ pid: 222, port: 9551, token: 'b', startedAt: 't' }, { dir }),
    ]);
    const list = await listRegistrations({ dir, isPidAlive: ALIVE });
    expect(list.map(r => r.pid).sort()).toEqual([111, 222]);
  });

  it('死 pid 条目被过滤且文件被清除', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    const list = await listRegistrations({ dir, isPidAlive: DEAD });
    expect(list).toHaveLength(0);
    expect(existsSync(join(dir, '111.json'))).toBe(false);
  });

  it('removeRegistration 删除自己的文件(best-effort)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await removeRegistration(111, { dir });
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('registry 目录不存在时 listRegistrations 返回空数组不抛', async () => {
    const list = await listRegistrations({ dir: join(dir, 'no-such-sub'), isPidAlive: ALIVE });
    expect(list).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('登记文件权限 0o600(Linux/macOS)', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'secret', startedAt: 't' }, { dir });
    const mode = statSync(join(dir, '111.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // ── 陈旧登记清扫(2026-09-15 独立批:Windows 强杀不走 exit-hook 的系统性堆积) ──
  it('sweepStaleRegistrations:死 pid 删/活 pid 留/返回删除数', async () => {
    await writeRegistration({ pid: 111, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await writeRegistration({ pid: 222, port: 9551, token: 'b', startedAt: 't' }, { dir });
    // 混入非登记形态文件(projects.json 同目录共存):格式校验不过 → 不删不报
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [] }), 'utf-8');
    const removed = await sweepStaleRegistrations({ dir, isPidAlive: (pid) => pid === 111 });
    expect(removed).toBe(1);
    expect(existsSync(join(dir, '111.json'))).toBe(true);
    expect(existsSync(join(dir, '222.json'))).toBe(false);
    expect(existsSync(join(dir, 'projects.json'))).toBe(true);
  });

  it('sweepStaleRegistrations:目录不存在返回 0 不抛', async () => {
    expect(await sweepStaleRegistrations({ dir: join(dir, 'no-such'), isPidAlive: DEAD })).toBe(0);
  });

  // ── 共享持久 token(2026-09-16 入口简化批:cookie 跨实例/跨重启持续有效的前提) ──
  it('getOrCreateSharedToken:首调生成,再调复用同值;目录递归建', () => {
    const d = join(dir, 'tok-sub');
    const t1 = getOrCreateSharedToken({ dir: d });
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(join(d, 'token.txt'))).toBe(true);
    expect(getOrCreateSharedToken({ dir: d })).toBe(t1);
  });

  it('getOrCreateSharedToken:两个实例(同目录)拿到同一 token', () => {
    const t1 = getOrCreateSharedToken({ dir });
    const t2 = getOrCreateSharedToken({ dir });
    expect(t1).toBe(t2);
  });

  it.skipIf(process.platform === 'win32')('共享 token 文件权限 0o600(Linux/macOS)', () => {
    getOrCreateSharedToken({ dir });
    const mode = statSync(join(dir, 'token.txt')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('getOrCreateSharedToken:损坏 token.txt(非法字符集)重新生成', () => {
    writeFileSync(join(dir, 'token.txt'), 'bad token with spaces!!', 'utf-8');
    const t = getOrCreateSharedToken({ dir });
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toBe('bad token with spaces!!');
  });

  // ── rotateSharedToken(M-2,2026-09-17 审查批:token 疑似泄露后的主动轮换) ──
  it('rotateSharedToken:返回新值 ≠ 旧值;token.txt 已换;后续 getOrCreateSharedToken 复读新值', () => {
    const t1 = getOrCreateSharedToken({ dir });
    const t2 = rotateSharedToken({ dir });
    expect(t2).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(t2).not.toBe(t1);
    expect(readFileSync(join(dir, 'token.txt'), 'utf-8').trim()).toBe(t2);
    expect(getOrCreateSharedToken({ dir })).toBe(t2);
  });

  it('rotateSharedToken:包根入口页不存在则不创建;存在则用新 token 重写', () => {
    const root = join(dir, 'pkg-root');
    mkdirSync(root, { recursive: true });
    getOrCreateSharedToken({ dir });
    // 入口页不存在:rotate 只换 token,不落新文件(不向未授权目录写)
    rotateSharedToken({ dir, packageRoot: root });
    expect(existsSync(join(root, PROJECT_ENTRY_NAME))).toBe(false);
    // 入口页存在(旧 token 版):rotate 后内容换成内嵌新 token 的页面
    writeFileSync(join(root, PROJECT_ENTRY_NAME), 'OLD-PAGE', 'utf-8');
    const t2 = rotateSharedToken({ dir, packageRoot: root });
    const page = readFileSync(join(root, PROJECT_ENTRY_NAME), 'utf-8');
    expect(page).not.toBe('OLD-PAGE');
    expect(page).toContain(t2);
  });
});
