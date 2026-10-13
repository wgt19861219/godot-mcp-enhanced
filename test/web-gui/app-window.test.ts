// test/web-gui/app-window.test.ts(2026-09-16 独立窗口批)
// 覆盖:file URL 编码 / 浏览器探测优先级与平台分支 / bat 内容(%% 转义·CRLF·纯 ASCII·
// fallback 分支)/ 包根双击件幂等落盘与非 win32 跳过。全部注入探测函数,不碰真实浏览器。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appBrowserCandidates,
  findAppBrowserPath,
  buildFileUrl,
  buildAppLauncherBat,
  ensurePackageRootAppLauncher,
  APP_LAUNCHER_NAME,
} from '../../src/web-gui/app-window.js';

describe('buildFileUrl(本地路径 → percent-encoded file URL)', () => {
  it('Windows 反斜杠路径 + 中文文件名:逐段编码成正斜杠 file URL', () => {
    expect(buildFileUrl('D:\\repo\\面板入口.html')).toBe('file:///D:/repo/%E9%9D%A2%E6%9D%BF%E5%85%A5%E5%8F%A3.html');
  });
  it('纯 ASCII 路径保持可读(仅反斜杠转正斜杠)', () => {
    expect(buildFileUrl('C:\\Users\\wgt\\.godot-mcp\\web-gui\\portal.html')).toBe('file:///C:/Users/wgt/.godot-mcp/web-gui/portal.html');
  });
});

describe('findAppBrowserPath(浏览器探测)', () => {
  it('优先级:Edge(x86) 命中即返回,不继续探测 Chrome', () => {
    const edgeX86 = appBrowserCandidates('win32')[0]!;
    const exe = findAppBrowserPath({ platform: 'win32', exists: p => p === edgeX86 });
    expect(exe).toBe(edgeX86);
  });
  it('Edge 全无 → Chrome 兜底', () => {
    const cands = appBrowserCandidates('win32');
    const chromePf = cands.find(c => c.includes('Google') && c.includes('Program Files') && !c.includes('(x86)'))!;
    const exe = findAppBrowserPath({ platform: 'win32', exists: p => p === chromePf });
    expect(exe).toBe(chromePf);
  });
  it('全部不存在 → null(调用方降级标签页)', () => {
    expect(findAppBrowserPath({ platform: 'win32', exists: () => false })).toBeNull();
  });
  it('win32 候选 6 项:Edge 3 路径在前 Chrome 3 路径在后(env 缺失退硬编码标准路径)', () => {
    const cands = appBrowserCandidates('win32');
    expect(cands).toHaveLength(6);
    expect(cands.slice(0, 3).every(c => c.includes('msedge.exe'))).toBe(true);
    expect(cands.slice(3).every(c => c.includes('chrome.exe'))).toBe(true);
  });
  it('darwin 候选为 .app 内可执行;linux 候选为 /usr/bin 下包管理器路径', () => {
    expect(appBrowserCandidates('darwin').every(c => c.startsWith('/Applications/'))).toBe(true);
    expect(appBrowserCandidates('linux').every(c => c.startsWith('/usr/bin/'))).toBe(true);
  });
});

describe('buildAppLauncherBat(双击件内容)', () => {
  it('percent-encoding 双写 %%:cmd 变量展开后还原单 %(URL 不被吃字符)', () => {
    // 「面板入口」四字的 UTF-8 percent-encoding:面%E9%9D%A2 板%E6%9D%BF 入%E5%85%A5 口%E5%8F%A3
    const bat = buildAppLauncherBat('file:///D:/repo/%E9%9D%A2%E6%9D%BF%E5%85%A5%E5%8F%A3.html');
    expect(bat).toContain('set "URL=file:///D:/repo/%%E9%%9D%%A2%%E6%%9D%%BF%%E5%%85%%A5%%E5%%8F%%A3.html"');
    expect(bat).not.toMatch(/%E9%9D/);   // 不允许残留单个 %(会被 cmd 变量展开吞掉)
  });
  it('结构完整:--app 启动 + 探测链 + fallback 降级默认浏览器', () => {
    const bat = buildAppLauncherBat('file:///D:/x/entry.html');
    expect(bat).toContain('start "" "%BROWSER%" --app="%URL%"');
    expect(bat).toContain('if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"');
    expect(bat).toContain('goto fallback');
    expect(bat).toContain(':fallback');
    expect(bat).toContain('start "" "%URL%"');
  });
  it('优先级保持:每条探测统一带 if not defined BROWSER 前缀——平行 if exist 会被后位命中覆盖(2026-09-16 真机踩坑:Edge 命中被 Chrome 覆盖,开了 Chrome 而非 Edge)', () => {
    const bat = buildAppLauncherBat('file:///D:/x/entry.html');
    const probeLines = bat.split('\r\n').filter(l => l.includes(' if exist '));
    expect(probeLines).toHaveLength(6);
    expect(probeLines.every(l => l.startsWith('if not defined BROWSER if exist '))).toBe(true);
  });
  it('纯 ASCII + CRLF:cmd 按系统代码页解析,UTF-8 中文会乱码;LF-only bat 的 goto 有历史坑', () => {
    const bat = buildAppLauncherBat('file:///D:/%E9%9D%A2.html');
    expect(/^[\x00-\x7F]*$/.test(bat)).toBe(true);
    expect(bat).toContain('\r\n');
    expect(bat).not.toMatch(/[^\r]\n/);   // 无裸 LF(全部 CRLF)
  });
});

describe('ensurePackageRootAppLauncher(包根双击件落盘)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-appwin-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('win32:写入 面板独立窗口.bat,URL 指向同目录 面板入口.html(%% 转义),幂等', () => {
    const p1 = ensurePackageRootAppLauncher(dir, { platform: 'win32' });
    const p2 = ensurePackageRootAppLauncher(dir, { platform: 'win32' });
    expect(p1).toBe(join(dir, APP_LAUNCHER_NAME));
    expect(p1).toBe(p2);
    const bat = readFileSync(p1!, 'utf-8');
    const expectedUrl = buildFileUrl(join(dir, '面板入口.html')).replaceAll('%', '%%');
    expect(bat).toContain(`set "URL=${expectedUrl}"`);
  });
  it('非 win32:返回 null 不落盘(bat 仅 Windows 有意义)', () => {
    const p = ensurePackageRootAppLauncher(dir, { platform: 'linux' });
    expect(p).toBeNull();
    expect(existsSync(join(dir, APP_LAUNCHER_NAME))).toBe(false);
  });
});
