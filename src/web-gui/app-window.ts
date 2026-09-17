// Web GUI 面板独立窗口(浏览器 App 模式,2026-09-16)
// 动机:面板此前只能落在默认浏览器普通标签页,与其他网页混排,不便随时查看与启用。
// App 窗口 = Edge/Chrome `--app=<url>` 启动:无地址栏/无标签页的独立 OS 窗口,任务栏
// 独立图标可固定。约束:页面内 JS 无法把已开标签转成 App 窗口(必须是浏览器启动参数),
// 故入口只能落在"以 app 模式启动浏览器"的命令上,共两个:
//   1. CLI `dashboard --web --app`(open.ts defaultOpener 探测本模块 findAppBrowserPath)
//   2. 包根双击件 面板独立窗口.bat(ensurePackageRootAppLauncher 生成,双击直达)

import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ENTRY_NAME } from './portal.js';

export interface AppBrowserOpts {
  /** 测试注入平台;缺省 process.platform(候选清单按平台分支)。 */
  platform?: NodeJS.Platform;
  /** 测试注入存在性探测;缺省 existsSync。 */
  exists?: (p: string) => boolean;
}

/** 浏览器候选路径(按优先级):Edge Win10/11 预装且路径稳定,优先;Chrome 兜底。
 *  env 缺失时退标准硬编码路径(保持候选清单平台确定 → 探测结果只由 exists 决定)。 */
export function appBrowserCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const local = process.env['LocalAppData'] ?? join(homedir(), 'AppData', 'Local');
    return [
      join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
      join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      join(local, 'Microsoft/Edge/Application/msedge.exe'),
      join(pf, 'Google/Chrome/Application/chrome.exe'),
      join(pf86, 'Google/Chrome/Application/chrome.exe'),
      join(local, 'Google/Chrome/Application/chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

/** 探测本机支持 --app 模式的浏览器;找不到返回 null(调用方降级普通标签页)。 */
export function findAppBrowserPath(opts: AppBrowserOpts = {}): string | null {
  const exists = opts.exists ?? existsSync;
  for (const cand of appBrowserCandidates(opts.platform)) {
    if (exists(cand)) return cand;
  }
  return null;
}

/** 本地文件路径 → file:// URL。RFC 3986 path 允许字符(pchar:未保留+子分隔+`:`+`@`)
 *  白名单之外的才编码:盘符冒号保留(encodeURIComponent 会错编成 %3A),中文/空格/
 *  `?`/`#` 等 URL 结构敏感字符编码。 */
export function buildFileUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/g, (c) => encodeURIComponent(c));
  return `file:///${encoded}`;
}

/** 包根双击件文件名(中文,与 面板入口.html 呼应,资源管理器一眼可辨)。 */
export const APP_LAUNCHER_NAME = '面板独立窗口.bat';

/**
 * 构建双击件内容。纯 ASCII(URL 已 percent-encode,注释用英文)——cmd 按系统 ANSI
 * 代码页解析 bat,UTF-8 中文注释会乱码;CRLF 行尾(cmd 对 LF-only bat 的 goto 标签
 * 定位有历史坑)。percent-encoding 的 %XX 在 cmd 变量展开中会被吃掉,双写 %% 还原。
 * 自包含探测链:Edge/Chrome 标准路径逐个试,全无则降级默认浏览器标签页。
 */
export function buildAppLauncherBat(entryFileUrl: string): string {
  const url = entryFileUrl.replaceAll('%', '%%');
  return [
    '@echo off',
    'rem godot-mcp-enhanced panel standalone window (browser app mode).',
    'rem Opens the portal entry page in an app window (no address bar, no tabs);',
    'rem the page auto-detects a running server and jumps with token.',
    'setlocal',
    `set "URL=${url}"`,
    '',
    'set "BROWSER="',
    // 平行 if exist 会被后位命中覆盖(Edge 命中后 Chrome 存在则覆盖)——统一加
    // "if not defined BROWSER" 前缀保住首个命中,优先级与 findAppBrowserPath 一致
    'if not defined BROWSER if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER if exist "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    '',
    'if not defined BROWSER goto fallback',
    'start "" "%BROWSER%" --app="%URL%"',
    'exit /b 0',
    '',
    ':fallback',
    'rem No Edge/Chrome found - open in default browser as a normal tab.',
    'start "" "%URL%"',
    'exit /b 0',
    '',
  ].join('\r\n');
}

export interface AppLauncherOpts {
  /** 测试注入平台;缺省 process.platform(bat 仅 win32 有意义)。 */
  platform?: NodeJS.Platform;
}

/**
 * 幂等写包根双击件(仅 win32;其他平台返回 null 不落盘)。
 * 不含 token——双击打开的是同目录 面板入口.html(token 由其内嵌且权限已收紧),
 * bat 本身零敏感信息,无需 0600/icacls;内容每次刷新(root 迁移后 URL 随之更新)。
 */
export function ensurePackageRootAppLauncher(root: string, opts: AppLauncherOpts = {}): string | null {
  if ((opts.platform ?? process.platform) !== 'win32') return null;
  const entryUrl = buildFileUrl(join(root, PROJECT_ENTRY_NAME));
  const filePath = join(root, APP_LAUNCHER_NAME);
  writeFileSync(filePath, buildAppLauncherBat(entryUrl), { encoding: 'ascii' });
  return filePath;
}
