// test/web-gui/portal.test.ts(2026-09-16 入口简化批补强:file:// 入口页)
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
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
    expect(html).toContain('location.replace');                      // 自动进入第一个活实例
    expect(html).toContain('dashboard --web');                       // 全死指引命令
    expect(html).toContain('当前没有运行中的面板服务');                 // 全死文案
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
    expect(html).toContain("withToken('http://127.0.0.1:' + found[0] + '/')");   // 跳转带 token
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
