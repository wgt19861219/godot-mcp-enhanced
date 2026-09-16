// test/web-gui/portal.test.ts(2026-09-16 入口简化批补强:file:// 入口页)
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensurePortalPage, ensureProjectPortalEntry } from '../../src/web-gui/portal.js';
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
});
