#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';
import { getLogger } from './core/logger.js';
import { isAuditEnabled } from './core/audit-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// P2-11(2026-08-21 七维度审核): 长驻 MCP server 的最后防线——任一遗漏 catch 的
// floating promise 在 Node 15+ 默认语义下会 crash 整个进程(客户端断连/QA run 失管/
// 孤儿进程扫描随进程死亡)。rejection 记 stderr 日志保留进程(未观察对象不必然致命,
// 与 GodotServer 其余 void 调用带 .catch 的防御同级);uncaughtException 同步栈已损坏,
// 记日志后以非零码退出,不静默带病运行。stderr 不污染 stdio 协议通道(stdout)。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

export async function startMcpServer(args: string[]): Promise<void> {
  // H-08: Reject security bypass flags in production unless explicitly acknowledged
  const dangerousBypassFlags = [
    'GODOT_MCP_DISABLE_SAFETY',
    'GODOT_MCP_UNRESTRICTED',
    'GODOT_MCP_SANDBOX',
    // 2026-08-06 审查 P0 修复：此 env=true 会绕过整个 MRTR out-of-band 确认门
    // （ToolDispatcher.ts confirm_and_execute 分支），生产误设则 AI 可自确认 token 直执。
    'GODOT_MCP_ALLOW_UNSAFE_CONFIRM',
  ];
  const isDev = process.env.NODE_ENV === 'development' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true';

  if (!isDev) {
    for (const flag of dangerousBypassFlags) {
      if (process.env[flag] !== undefined) {
        console.error(`[FATAL] ${flag} is set but NODE_ENV is not "development". ` +
          `Set NODE_ENV=development or GODOT_MCP_ALLOW_UNSAFE=true to acknowledge the risk. Exiting.`);
        process.exit(1);
      }
    }
  }

  // I-05: Warn loudly when security bypass flags are active
  const securityBypassFlags = [
    'GODOT_MCP_UNRESTRICTED',
    'GODOT_MCP_SANDBOX',
    'GODOT_MCP_ALLOW_UNSAFE',
    'GODOT_MCP_DISABLE_SAFETY',
    // 2026-08-06 审查 P0 修复：同步加入 dangerousBypassFlags 的 MRTR 绕过开关
    'GODOT_MCP_ALLOW_UNSAFE_CONFIRM',
  ];
  for (const flag of securityBypassFlags) {
    const val = process.env[flag];
    if (val !== undefined) {
      const logger = getLogger();
      logger.error('security', `Security bypass flag ${flag}=${val} is ACTIVE — this disables safety checks`);
    }
  }

  // C-08: Path access is deny-by-default (restricted to cwd) when ALLOWED_PROJECT_PATHS unset — see path-utils.ts isPathInAllowedRoots
  if (!process.env.ALLOWED_PROJECT_PATHS && !process.env.GODOT_MCP_UNRESTRICTED) {
    const logger = getLogger();
    logger.info('security', 'ALLOWED_PROJECT_PATHS is not set — access restricted to the current working directory (deny-by-default). ' +
      'Set ALLOWED_PROJECT_PATHS=/path1;/path2 for explicit multi-project access.');
  }

  // 1E (2026-09-19 安全加固批1): 审计关闭显式告警——GODOT_MCP_AUDIT=false 时抗抵赖/可核查
  // 降级为无留痕模式,关闭行为本身要留一条启动日志(不留则关闭可被静默掩盖)。
  if (!isAuditEnabled()) {
    getLogger().warn('security', 'GODOT_MCP_AUDIT is disabled — operation audit trail will NOT be recorded (non-repudiation degraded)');
  }

  // Feature flags info
  const { getAllFeatureFlags } = await import('./core/feature-flags.js');
  const flags = getAllFeatureFlags();
  const disabledFeatures = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
  if (disabledFeatures.length > 0) {
    getLogger().info('godot-mcp', `Features disabled: ${disabledFeatures.join(', ')}`);
  }

  // --profile=<name> or GODOT_MCP_PROFILE for fine-grained tool selection
  const profileArg = args.find(a => a.startsWith('--profile='));
  const profileFromArg = profileArg ? profileArg.split('=')[1] : null;
  const profileFromEnv = process.env.GODOT_MCP_PROFILE;

  const activeProfile = profileFromArg || profileFromEnv;

  const toolMode: string = activeProfile ?? (
    args.includes('--minimal') ? 'minimal'
    : args.includes('--lite') ? 'lite'
    : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
    : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
    : process.env.GODOT_MCP_MODE === 'full' ? 'full'  // G7: 显式 full 回退(默认改 basic)
    : 'basic'  // G7 (2026-08-13): 默认从 full 改 basic(BREAKING,省 ~60% context)。回退:GODOT_MCP_PROFILE=full 或 --profile=full
  );

  const connectionMode = process.env.GODOT_MCP_MODE === 'editor' ? 'editor' : 'headless';
  const readOnly = process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true';
  const noFallback = process.env.GODOT_MCP_NO_FALLBACK === 'true';

  // P2-1: --overrides=<path>(可重复) 或 env GODOT_MCP_OVERRIDES=path1;path2
  // 用途:声明默认 override 脚本,graceful shutdown 时对操作过的项目批量卸载(防半装状态)。
  // ⚠️ I-1 诚实说明(P2-4 审查):CLI flag 本身不触发 install —— server 启动时不知目标项目,
  //    实际 install 由 agent 调 game_bridge install_override action 完成(项目路径在工具调用时传)。
  //    CLI flag 的价值仅在于 close() 时清理(对 agent 装的 MCPOVERRIDE_* 条目)。"启动时自动注入"
  //    需 run_project 拿到 projectPath 后调 installOverrides,推迟 P3。
  const overridesFromArgs = args
    .filter(a => a.startsWith('--overrides='))
    .map(a => a.split('=')[1]!)
    .filter(Boolean);
  const overridesFromEnv = process.env.GODOT_MCP_OVERRIDES
    ? process.env.GODOT_MCP_OVERRIDES.split(';').map(s => s.trim()).filter(Boolean)
    : [];
  const overrides = [...overridesFromArgs, ...overridesFromEnv];
  if (overrides.length > 0) {
    getLogger().warn('godot-mcp',
      `--overrides / GODOT_MCP_OVERRIDES 已声明 ${overrides.length} 个脚本,但 CLI flag 不自动 install。` +
      `请用 game_bridge install_override action 注入到目标项目。CLI flag 仅用于 close() 时清理。`);
  }

  const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
    mode: toolMode,
    connectionMode,
    readOnly,
    noFallback,
    overrides: overrides.length > 0 ? overrides : undefined,
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A-2: second signal forces immediate exit (first shutdown may be stuck in server.close)
      process.exit(1);
    }
    shuttingDown = true;
    const logger = getLogger();
    logger.info('godot-mcp', `Received ${signal}, shutting down...`);
    try {
      await server.close();    // 先关闭服务器（内部会记录 killProcess 等日志）
      logger.close();          // 最后 flush 缓冲区 + 关闭文件句柄
    } catch (err) {
      // logger 可能已关闭，用 console 兜底
      console.error(`Error during shutdown: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // MCP clients that die without signaling this child (crash, force-quit, a
  // closed terminal window) leave it running as an orphan: StdioServerTransport
  // only wires 'data'/'error' on process.stdin, never 'end', so nothing here
  // ever reacted to the pipe closing. 'end' fires once the client's write end
  // closes and this stream has been fully drained, which is the reliable EOF
  // signal on both a pipe and a TTY — treat it the same as a shutdown signal.
  process.stdin.on('end', () => gracefulShutdown('stdin-end'));

  server.run().then(() => {
    // Web GUI 三态已定(设计 §3.2 触发点 1):激活则跳过 TUI(guard 见 launcher 入口);
    // 禁用/失败照旧弹。行为微变(改善):run() reject 时不再给已死 server 弹监控窗。
    if (server.webGuiActive) {
      getLogger().info('godot-mcp', 'Web GUI active — skipping Dashboard TUI auto-launch');
      return;
    }
    import('./dashboard/launcher.js').then(({ launchDashboardOnce }) => {
      getLogger().info('godot-mcp', 'Auto-launching Dashboard TUI...');
      launchDashboardOnce();
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn('godot-mcp', `Dashboard auto-launch skipped: ${msg}`);
    });
  }).catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    getLogger().error('godot-mcp', 'Failed to run server', { error: msg });
    // I-CQ-01: Graceful cleanup before exit
    getLogger().close();
    process.exit(1);
  });

  // self-update: 异步查 npm 最新版，有更新 stderr 提示（失败静默，不阻塞 stdio 握手）
  import('./core/update-checker.js')
    .then(({ checkForUpdateCached }) => checkForUpdateCached())
    .then(r => {
      if (r.updateAvailable) {
        getLogger().warn('godot-mcp',
          `Update available: ${r.current} → ${r.latest}. Run: npm i -g godot-mcp-enhanced`);
      }
    })
    .catch(() => { /* 网络失败静默 */ });
}

// ── 入口分流 ──────────────────────────────────────────────
const args = process.argv.slice(2);

(async () => {
  const { isCliInvocation, isUnknownCommand, showHelp, showVersion, routeCommand } = await import('./cli/router.js');

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    await showVersion();
    process.exit(0);
  }
  if (isCliInvocation(args)) {
    await routeCommand(args);
    process.exit(0);
  }
  // 2026-08-21 架构审查 MAJOR-1:非 flag 且非子命令(拼错的命令/误传路径)此前静默
  // 启动 stdio MCP server 挂起等 stdin,显式报错退出。
  if (isUnknownCommand(args)) {
    console.error(`Unknown command: ${args[0]!}`);
    console.error('Run "godot-mcp-enhanced --help" for usage.');
    process.exit(1);
  }

  // 易用性批3 (2026-09-19):人类在终端直跑(非 MCP 客户端 spawn)时,stdio 挂起像死机。
  // stderr 引导一行——MCP 客户端 spawn 时 stderr 是 pipe(isTTY=false)不输出,stdout 协议通道不碰。
  if (process.stderr.isTTY) {
    console.error('godot-mcp-enhanced: stdio MCP 模式启动(供 AI 客户端连接,挂起等待 stdin 属正常行为)。');
    console.error('人类用户:Ctrl+C 退出;--help 查看子命令;`setup` 一键配置 AI 客户端。');
  }

  // 默认: MCP stdio 模式
  await startMcpServer(args);
})().catch((err: unknown) => {
  // 2026-08-21 架构审查 MINOR:入口 IIFE 无 catch——子命令抛错(如 install 网络失败)
  // 成为 unhandledRejection 而非干净的错误退出码。
  // 易用性批3 (2026-09-19):用户主动取消(install/web 的 confirm 拒绝)非错误——
  // 干净退出码 0 + 一行说明,不打 InternalError 堆栈。
  if (err instanceof Error && /cancelled by user/.test(err.message)) {
    console.log('\n已取消,未做任何改动。');
    // 用 exitCode + 自然退出而非 process.exit——installer 的进度句柄可能仍在活动,
    // 强杀会触发 libuv Windows 断言(UV_HANDLE_CLOSING)
    process.exitCode = 0;
    return;
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
