import { EXIT_CODES } from '../core/exit-codes.js';
import { hasFlag } from './args.js';

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __cliDir = dirname(fileURLToPath(import.meta.url));
const __rootDir = join(__cliDir, '..', '..');

/** CLI 子命令清单(export 供 test/cli/router.test.ts 单一真相源引用,防硬编码漂移) */
export const SUBCOMMANDS = ['setup', 'configure', 'skills', 'doctor', 'init', 'dashboard', 'qa', 'install', 'gif', 'web'] as const;
export type Subcommand = typeof SUBCOMMANDS[number];

export function parseSubcommand(args: string[]): { subcommand: Subcommand; rest: string[] } | null {
  if (args.length === 0) return null;
  const first = args[0]!;
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    return { subcommand: first as Subcommand, rest: args.slice(1) };
  }
  return null;
}

export async function routeCommand(args: string[]): Promise<void> {
  const parsed = parseSubcommand(args);
  if (!parsed) {
    console.error(`Unknown command: ${args[0]!}`);
    console.error('Run "godot-mcp-enhanced --help" for usage.');
    process.exit(EXIT_CODES.EXIT_OPERATION_FAILED);
  }

  switch (parsed.subcommand) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup(parsed.rest);
      break;
    }
    case 'configure': {
      const { runConfigure } = await import('./configure.js');
      await runConfigure(parsed.rest);
      break;
    }
    case 'skills': {
      const { runSkills } = await import('./skills.js');
      await runSkills(parsed.rest);
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor(parsed.rest);
      break;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit(parsed.rest);
      break;
    }
    case 'dashboard': {
      // M-2(2026-09-17 审查批):--rotate-token 轮换共享 token(泄露止损出口),
      // 打印打码形态(前 4 位)——全量 token 不落终端;处理完即退,不与 --web 组合。
      if (hasFlag(parsed.rest, 'rotate-token')) {
        const { rotateSharedToken } = await import('../web-gui/registry.js');
        const newToken = rotateSharedToken();
        console.log(`token rotated: ${newToken.slice(0, 4)}****(面板入口页已同步,运行中实例须重启生效)`);
        process.exit(EXIT_CODES.EXIT_OK);
      }
      if (hasFlag(parsed.rest, 'web')) {
        const { openWebDashboard } = await import('../web-gui/open.js');
        const code = await openWebDashboard({ showToken: hasFlag(parsed.rest, 'show-token') });
        process.exit(code === 0 ? EXIT_CODES.EXIT_OK : EXIT_CODES.EXIT_OPERATION_FAILED);
      }
      const { launchDashboardOnce } = await import('../dashboard/launcher.js');
      launchDashboardOnce();
      console.log('Dashboard starting... (use the separate terminal window)');
      process.exit(EXIT_CODES.EXIT_OK);
      break; // unreachable — no-fallthrough 需要显式终止语句（process.exit 不被识别）
    }
    case 'qa': {
      const { runQa } = await import('./qa.js');
      await runQa(parsed.rest);
      break;
    }
    case 'web': {
      const { runWeb } = await import('./web.js');
      await runWeb(parsed.rest);
      break;
    }
    case 'gif': {
      const { runGif } = await import('./gif.js');
      await runGif(parsed.rest);
      break;
    }
    case 'install': {
      const { runInstall } = await import('./godot-installer.js');
      await runInstall(parsed.rest);
      break;
    }
  }
}

export function isCliInvocation(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!;
  if (first.startsWith('-')) {
    // --help / --version 走 CLI
    if (first === '--help' || first === '-h' || first === '--version' || first === '-v') return true;
    // --profile=xxx 等 MCP flags 不走 CLI
    return false;
  }
  // 子命令走 CLI
  return (SUBCOMMANDS as readonly string[]).includes(first);
}

/**
 * 未知子命令检测:首参非 flag 且不在子命令表内。
 * 2026-08-21 架构审查 MAJOR-1:此前这种输入静默落入 stdio MCP server(终端表现为
 * 挂起等 stdin,零提示);router 的 Unknown command 分支对此不可达。分流处
 * (index.ts)先调本函数,报错退出而非启动 server。
 */
export function isUnknownCommand(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!;
  if (first.startsWith('-')) return false;
  return !(SUBCOMMANDS as readonly string[]).includes(first);
}

export function showHelp(): void {
  console.log(`
godot-mcp-enhanced — Godot AI 开发环境

用法:
  godot-mcp-enhanced                  启动 MCP 服务器（stdio 模式）
  godot-mcp-enhanced setup            一键配置 AI 客户端
  godot-mcp-enhanced configure <客户端>  定向配置单个客户端（--list 列出全部，--force 强制）
  godot-mcp-enhanced skills [install]   打包的 Claude Code skills 列出/装入(install 支持 --target <目录> --force)
  godot-mcp-enhanced doctor           环境诊断
  godot-mcp-enhanced init <name>      创建 Godot 项目
  godot-mcp-enhanced dashboard [--web]  启动监控面板（--web 打开浏览器版；--rotate-token 轮换共享 token；--show-token 配合 --web 显示完整 URL;默认 TUI）
  godot-mcp-enhanced qa run <spec>    执行 QA 测试套件（夜间跑批）
  godot-mcp-enhanced install [tag]   从官方 releases 安装 Godot(默认 latest stable;零预装上手)
  godot-mcp-enhanced gif <project>  录制 demo GIF(bridge 定频截图;--fps/--seconds/--keys/--out)
  godot-mcp-enhanced web <project>  Web 试玩闭环(导出+127.0.0.1 服务器;--port/--serve-only)

MCP 参数:
  --profile=<name>  工具 profile (full/minimal/lite)
  --minimal         最小工具集
  --lite            轻量工具集
  --help, -h        显示帮助
  --version, -v     显示版本
`);
}

export async function showVersion(): Promise<void> {
  try {
    const pkg = JSON.parse(readFileSync(join(__rootDir, 'package.json'), 'utf-8'));
    console.log(`godot-mcp-enhanced v${pkg.version}`);
  } catch {
    console.log('godot-mcp-enhanced (version unknown)');
  }
}
