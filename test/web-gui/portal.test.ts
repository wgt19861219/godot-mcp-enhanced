// test/web-gui/portal.test.ts(2026-09-16 入口简化批补强:file:// 入口页)
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensurePortalPage, ensureProjectPortalEntry, ensurePackageRootEntry, buildPortalHtml } from '../../src/web-gui/portal.js';
import { writeRegistration } from '../../src/web-gui/registry.js';

describe('file:// 入口页 portal.html(2026-09-16 入口简化批)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-portal-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('幂等写 portal.html,返回路径;内容含扫描范围/探测/自动进入/启动指引', () => {
    const p1 = ensurePortalPage(dir);
    const p2 = ensurePortalPage(dir);
    expect(p1).toBe(p2);
    expect(p1).toBe(join(dir, 'portal.html'));
    const html = readFileSync(p1, 'utf-8');
    expect(html).toContain('9550');                                  // 扫描段起点
    expect(html).toContain('9569');                                  // 扫描段终点
    expect(html).toContain("mode: 'no-cors'");                       // 兼容新旧 build 的探测方式
    expect(html).toContain('location.replace');                      // 自动进入挑选的实例
    expect(html).toContain('dashboard --web');                       // 全死指引命令
    expect(html).toContain('当前没有运行中的面板服务');                 // 全死文案
  });

  // ─── 根治批(2026-10-08):preferredPort 挑选策略 ─────────────────────────────
  it('preferredPort 内嵌:入口页优先跳写入实例(最近启动),CLI 版无偏好回退最大端口', () => {
    const withPref = buildPortalHtml(undefined, 9552);
    expect(withPref).toContain('var PREFERRED = 9552;');
    // 挑选逻辑:preferred 活着优先;否则回退最大端口(不再挑 found[0] 被 9550 旧实例截胡)
    expect(withPref).toContain("var target = (PREFERRED && found.indexOf(PREFERRED) !== -1) ? PREFERRED : found[found.length - 1];");
    expect(withPref).not.toContain("found[0] + '/'");                // 旧的"第一个活实例"跳转已移除
    expect(withPref).toContain("'★ '");                             // 跳转目标按钮 ★ 标注(源码 \u2605 运行时即 ★)
    const noPref = buildPortalHtml();
    expect(noPref).toContain('var PREFERRED = 0;');                  // CLI/registry 层重写 → 无偏好回退
    // 落盘链:server 侧 ensureXxx 透传端口
    expect(readFileSync(ensurePortalPage(dir, 9553), 'utf-8')).toContain('var PREFERRED = 9553;');
    expect(readFileSync(ensurePackageRootEntry(dir, 'a'.repeat(32), 9554), 'utf-8')).toContain('var PREFERRED = 9554;');
  });

  it('preferredPort 非法值防御:非整数/越界一律退化为无偏好(0)', () => {
    for (const bad of [0, -1, 70000, 1.5, Number.NaN] as const) {
      expect(buildPortalHtml(undefined, bad)).toContain('var PREFERRED = 0;');
    }
  });

  it('与 registry 目录共存(不干扰 pid.json/projects.json/token.txt)', async () => {
    ensurePortalPage(dir);
    expect(existsSync(join(dir, 'portal.html'))).toBe(true);
    // 再写登记文件不受影响(不同文件名)
    await writeRegistration({ pid: 1, port: 9550, token: 't'.repeat(32), startedAt: 't' }, { dir });
    expect(existsSync(join(dir, '1.json'))).toBe(true);
    expect(existsSync(join(dir, 'portal.html'))).toBe(true);
  });
});

describe('项目目录入口页 面板入口.html(2026-09-16 项目入口批)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-pentry-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('Godot 项目目录(有 project.godot)写入 面板入口.html,内容与 portal.html 同源', () => {
    writeFileSync(join(dir, 'project.godot'), '; test project', 'utf-8');
    const p = ensureProjectPortalEntry(dir);
    expect(p).toBe(join(dir, '面板入口.html'));
    expect(existsSync(p!)).toBe(true);
    // 内容同源:两份入口共享同一 PORTAL_HTML(扫描跳转逻辑一致)
    expect(readFileSync(p!, 'utf-8')).toBe(readFileSync(ensurePortalPage(join(dir, 'sub-reg')), 'utf-8'));
  });

  it('非 Godot 目录护栏:无 project.godot 不写任何文件,返回 null', () => {
    const p = ensureProjectPortalEntry(dir);
    expect(p).toBeNull();
    expect(existsSync(join(dir, '面板入口.html'))).toBe(false);
  });

  it('幂等:重复调用成功且内容一致', () => {
    writeFileSync(join(dir, 'project.godot'), '', 'utf-8');
    const p1 = ensureProjectPortalEntry(dir);
    const p2 = ensureProjectPortalEntry(dir);
    expect(p1).toBe(p2);
    expect(readFileSync(p1!, 'utf-8')).toBe(readFileSync(p2!, 'utf-8'));
  });

  it('包根入口 ensurePackageRootEntry:内嵌 token(双击直达免首授权)+权限收紧', () => {
    const tok = 'a'.repeat(32) + 'Z9_-';   // 满足 SHARED_TOKEN_RE([A-Za-z0-9_-]{32,})
    const p = ensurePackageRootEntry(dir, tok);   // tmp 目录无 project.godot,照样写入
    expect(p).toBe(join(dir, '面板入口.html'));
    const html = readFileSync(p, 'utf-8');
    expect(html).toContain(tok);                       // token 内嵌
    expect(html).toContain("withToken('http://127.0.0.1:' + target + '/')");   // 跳转带 token(根治批:target 挑选)
    if (process.platform !== 'win32') {
      const mode = (statSync(p).mode & 0o777).toString(8);
      expect(mode).toBe('600');                        // registry 同款文件权限(POSIX)
    }
  });

  it('非法形状 token 防御性退化为无 token 版(buildPortalHtml 单一校验来源)', () => {
    const html = buildPortalHtml('short');             // 不满足 32+ 长度
    expect(html).not.toContain('short');
    expect(html).toContain('var TOKEN = "";');         // 退化为空 token(纯跳转)
    const plain = buildPortalHtml();
    expect(plain).toContain('var TOKEN = "";');        // 项目目录/registry 版永不内嵌
  });
});

// ─── Task C3(2026-11-12 反馈批次):写前内容比对——端口未变零写盘 ────────────────
// 反馈 2026-11-08:server 每次启动以自身端口重写入口页,PREFERRED 未变也写盘,
// 打破 git 干净态 ≥4 次。修法:三 ensure 函数统一 diff-before-write——目标已存在且
// 内容完全相同 → 跳过写盘;不同或不存在 → 正常写。断言手段:先 utimesSync 钉住
// 旧 mtime(若实现重写文件,mtime 必然刷新为当前时间 → toBe 失败,测试确定性成立)。
describe('写前内容比对——端口未变零写盘(Task C3,反馈 2026-11-08)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-portal-diff-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** 把文件 mtime 钉到 2 分钟前——跳过写盘则 mtime 不变,重写则必变(>秒级差,无粒度歧义)。 */
  const pinOldMtime = (p: string) => {
    const past = new Date(Date.now() - 120_000);
    utimesSync(p, past, past);
    return statSync(p).mtimeMs;
  };

  it('内容相同(PREFERRED 未变):ensurePortalPage 跳过写盘,mtime 不变', () => {
    const p = ensurePortalPage(dir, 9553);
    const pinned = pinOldMtime(p);
    ensurePortalPage(dir, 9553);                       // 同端口再启动(反馈场景:每次 server 启动都重写)
    expect(statSync(p).mtimeMs).toBe(pinned);
  });

  it('内容相同:ensureProjectPortalEntry 跳过写盘,mtime 不变', () => {
    writeFileSync(join(dir, 'project.godot'), '', 'utf-8');
    const p = ensureProjectPortalEntry(dir, 9553)!;
    const pinned = pinOldMtime(p);
    ensureProjectPortalEntry(dir, 9553);
    expect(statSync(p).mtimeMs).toBe(pinned);
  });

  it('内容相同:ensurePackageRootEntry 跳过写盘,mtime 不变且权限语义保留', () => {
    const tok = 'a'.repeat(32);
    const p = ensurePackageRootEntry(dir, tok, 9553);
    const pinned = pinOldMtime(p);
    ensurePackageRootEntry(dir, tok, 9553);
    expect(statSync(p).mtimeMs).toBe(pinned);
    if (process.platform !== 'win32') {
      // 跳过 = 不触碰文件 → 上次写入设的 0o600 原样保留(icacls 同理,win32 无 mode 断言)
      expect((statSync(p).mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('端口变化(PREFERRED 不同):正常覆写为新端口', () => {
    const p = ensurePortalPage(dir, 9553);
    ensurePortalPage(dir, 9555);                       // 新实例占不同端口 → 入口页须反映最近实例
    expect(readFileSync(p, 'utf-8')).toContain('var PREFERRED = 9555;');
    expect(readFileSync(p, 'utf-8')).not.toContain('var PREFERRED = 9553;');
  });

  it('token 轮换(内容不同):正常覆写为新 token', () => {
    const oldTok = 'a'.repeat(32);
    const newTok = 'b'.repeat(32);
    const p = ensurePackageRootEntry(dir, oldTok, 9553);
    ensurePackageRootEntry(dir, newTok, 9553);         // rotateSharedToken 场景:token 变了必须重写
    const html = readFileSync(p, 'utf-8');
    expect(html).toContain(newTok);
    expect(html).not.toContain(oldTok);
  });

  it('文件不存在(ENOENT):正常写入', () => {
    const p = ensurePortalPage(dir, 9553);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('var PREFERRED = 9553;');
  });
});
