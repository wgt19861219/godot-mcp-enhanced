// CLI `dashboard --web`(设计 §6):聚合登记 → 探活清死 → 单个直开/多个菜单/零个提示。
// 跨平台开浏览器:start(Win)/open(mac)/xdg-open(Linux);失败降级打印 URL 手动点。
// App 窗口模式(2026-09-16):`--app` 时优先 Edge/Chrome `--app=<url>` 开独立窗口
// (无地址栏/无标签页,任务栏独立图标可固定);探测不到 Edge/Chrome 降级普通标签页。

import { exec, execFile } from 'node:child_process';
import { listRegistrations, type WebGuiRegistration } from './registry.js';
import { ensurePortalPage } from './portal.js';
import { findAppBrowserPath, buildFileUrl } from './app-window.js';

export interface OpenWebDashboardOpts {
  /** 浏览器打开函数(测试注入);缺省跨平台探测。第二参 appWindow=true 表示请求独立窗口。 */
  opener?: (url: string, appWindow?: boolean) => void;
  /** 多实例选择器(测试注入);缺省读 stdin 编号菜单 */
  choose?: (entries: WebGuiRegistration[]) => Promise<WebGuiRegistration | null>;
  registryDir?: string;
  isPidAlive?: (pid: number) => boolean;
  /** App 窗口模式:独立 OS 窗口(Edge/Chrome --app);找不到可用浏览器自动降级标签页。 */
  appWindow?: boolean;
}

function defaultOpener(url: string, appWindow = false): void {
  if (appWindow) {
    const exe = findAppBrowserPath();
    if (exe) {
      // execFile 不经 shell:exe 来自固定候选清单 + existsSync,url 的 token 已过 registry
      // 格式校验([A-Za-z0-9_-]+),无字符串拼接注入面。
      execFile(exe, [`--app=${url}`], { windowsHide: true }, () => {
        /* 失败降级:调用方已打印 URL,手动点 */
      });
      return;
    }
    console.log('未找到支持独立窗口的浏览器(Edge/Chrome),按普通标签页打开。');
  }
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"`
    : platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 失败降级:调用方已打印 URL,手动点 */
  });
}

/** 菜单行文本 → 选择编号:trim → parseInt → 整数且 1..count 返回数字,否则 null(空行取消/无效输入)。 */
export function parseChooseLine(line: string, count: number): number | null {
  const n = Number.parseInt(line.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= count ? n : null;
}

async function defaultChoose(entries: WebGuiRegistration[]): Promise<WebGuiRegistration | null> {
  console.log('检测到多个运行中的 MCP server:');
  entries.forEach((e, i) => {
    console.log(`  [${i + 1}] pid=${e.pid}  http://127.0.0.1:${e.port}/  (started ${e.startedAt})`);
  });
  process.stdout.write('选择编号(回车取消): ');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });
  const line: string = await new Promise((resolve) => rl.once('line', resolve));
  rl.close();
  const n = parseChooseLine(line, entries.length);
  return n === null ? null : entries[n - 1]!;
}

export async function openWebDashboard(opts: OpenWebDashboardOpts = {}): Promise<number> {
  const open = opts.opener ?? defaultOpener;
  // 入口页幂等落盘(2026-09-16):file:/// 书签永远可用的跳转页,随 CLI 顺带确保存在
  const portalPath = ensurePortalPage(opts.registryDir);
  const entries = await listRegistrations({ dir: opts.registryDir, isPidAlive: opts.isPidAlive });
  if (entries.length === 0) {
    console.log('没有运行中的 MCP server(先在 AI 客户端里启动 godot-mcp-enhanced)。');
    console.log('已打开本地入口页(服务启动后它会自动跳转):');
    // buildFileUrl 统一编码出口(审查 Nit-1):中文/空格用户名路径裸拼进 --app= 有兼容风险
    const portalUrl = buildFileUrl(portalPath);
    console.log(`  ${portalUrl}`);
    open(portalUrl, opts.appWindow);
    return 1;
  }
  let picked: WebGuiRegistration | null;
  if (entries.length === 1) {
    picked = entries[0]!;
  } else {
    const choose = opts.choose ?? defaultChoose;
    picked = await choose(entries);
  }
  if (!picked) return 1;
  const url = `http://127.0.0.1:${picked.port}/?token=${picked.token}`;
  console.log(`Web GUI: ${url}`);
  open(url, opts.appWindow);
  return 0;
}
