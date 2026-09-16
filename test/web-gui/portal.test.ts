// test/web-gui/portal.test.ts(2026-09-16 入口简化批补强:file:// 入口页)
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensurePortalPage } from '../../src/web-gui/portal.js';
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
