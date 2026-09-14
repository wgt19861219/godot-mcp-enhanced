// CLI `dashboard --web`(设计 §6):聚合登记 → 探活清死 → 单个直开/多个菜单/零个提示。
// 跨平台开浏览器:start(Win)/open(mac)/xdg-open(Linux);失败降级打印 URL 手动点。

import { exec } from 'node:child_process';
import { listRegistrations, type WebGuiRegistration } from './registry.js';

export interface OpenWebDashboardOpts {
  /** 浏览器打开函数(测试注入);缺省跨平台探测 */
  opener?: (url: string) => void;
  /** 多实例选择器(测试注入);缺省读 stdin 编号菜单 */
  choose?: (entries: WebGuiRegistration[]) => Promise<WebGuiRegistration | null>;
  registryDir?: string;
  isPidAlive?: (pid: number) => boolean;
}

function defaultOpener(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"`
    : platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 失败降级:调用方已打印 URL,手动点 */
  });
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
  const n = Number.parseInt(line.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= entries.length ? entries[n - 1]! : null;
}

export async function openWebDashboard(opts: OpenWebDashboardOpts = {}): Promise<number> {
  const entries = await listRegistrations({ dir: opts.registryDir, isPidAlive: opts.isPidAlive });
  if (entries.length === 0) {
    console.log('没有运行中的 MCP server(先在 AI 客户端里启动 godot-mcp-enhanced)。');
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
  (opts.opener ?? defaultOpener)(url);
  return 0;
}
