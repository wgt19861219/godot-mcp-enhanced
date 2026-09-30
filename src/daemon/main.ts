// src/daemon/main.ts — daemon 进程入口(daemon 批 A 2026-09-30,spec §3.1/§3.3/§3.4/§3.9/§3.10)
// 与 CLI 壳(src/cli/daemon.ts,批 B)的分工:壳薄(参数组装 + detached spawn + 就绪轮询),
// 本文件厚(进程内组装:启动序裁剪 → GodotServer(daemon 模式)→ 面板 → /mcp 端点 → 退出链)。
// 运行形态:node build/daemon/main.js [--port N] [--respawn-of <旧pid>](源 src/daemon/main.ts,
// 第 2 轮 m-3 路径统一);被 import 时不跑入口(底部守卫,供测试注入)。

import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
// ⚠️ import ../index.js 只取 runStartupSequence(启动序共享段,Task 2)——index.ts 底部
// 入口 IIFE 已有 argv[1] 守卫(直接执行 index.js 才分流,被 import 不起 stdio server)。
import { runStartupSequence } from '../index.js';
import { GodotServer } from '../GodotServer.js';
import { WebGuiServer } from '../web-gui/server.js';
import { createMcpEndpoint } from './mcp-endpoint.js';
import { controlledRestart, spawnDaemonDetached } from './controlled-restart.js';
import { getOrCreateSharedToken, listRegistrations, removeRegistrationVerified } from '../web-gui/registry.js';
import { killPidTree } from '../core/process-state.js';
import { getLogger } from '../core/logger.js';
import { appendMachineAuditLine, isAuditEnabled } from '../core/audit-log.js';

/** CLI 壳(spawn)与受控交接(§3.7 respawn)传入的进程参数。 */
export interface DaemonArgs {
  /** --port N:面板+/mcp 共用监听端口(spec §3.2 单端口双路由);缺席走面板端口链。 */
  port?: number;
  /** --respawn-of <旧pid>:单例检测豁免旗标(§3.4 交接窗口)。 */
  respawnOf?: number;
}

/** 参数解析(纯函数,测试直测)。值缺失/非数字 → undefined(Number→NaN 过滤),
 *  不抛——拼参失误的兜底语义是"按未传处理",非法端口值让 listen 阶段显式失败。 */
export function parseDaemonArgs(args: string[]): DaemonArgs {
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
  const respawnIdx = args.indexOf('--respawn-of');
  const respawnOf = respawnIdx >= 0 ? Number(args[respawnIdx + 1]) : undefined;
  return {
    port: port !== undefined && Number.isFinite(port) ? port : undefined,
    respawnOf: respawnOf !== undefined && Number.isFinite(respawnOf) ? respawnOf : undefined,
  };
}

/** 启动门依赖(可测性拆分:决策段零副作用注入,组装段才碰真实进程设施)。 */
export interface DaemonStartupGateDeps {
  /** env 注入(缺省生产侧传 process.env;测试传字面量对象)。 */
  env: NodeJS.ProcessEnv;
  respawnOf?: number;
  /** registry 目录注入(测试隔离);缺省 ~/.godot-mcp/web-gui/。 */
  registryDir?: string;
}

/**
 * daemon 启动门(spec §3.3 面板必起 + §3.4 入口层单例检测,双层之②;CLI 壳是①)。
 * 违规抛 Error(拒绝启动);通过则 resolve。零副作用——不构造 server、不监听端口,
 * 单测直接覆盖决策分支;runDaemon 在一切组装之前调它。
 * 活 daemon 判定复用 listRegistrations 内置探活(默认 process.kill(pid,0) 同款
 * try/catch,死条目顺手清)——返回集内即已探活,不另抄一份 isPidAlive。
 */
export async function runDaemonStartupGate(deps: DaemonStartupGateDeps): Promise<void> {
  if (deps.env.GODOT_MCP_WEB_GUI === '0') {
    throw new Error('daemon 模式依赖面板端口(实例管理失明),不支持 GODOT_MCP_WEB_GUI=0;请去掉该 env');
  }
  // respawn 豁免(§3.4):--respawn-of 在场 = 受控交接窗口,旧登记(活/已死)都不算冲突
  if (deps.respawnOf === undefined) {
    const alive = (await listRegistrations(deps.registryDir ? { dir: deps.registryDir } : {}))
      .filter(r => r.kind === 'daemon');
    if (alive.length > 0) {
      throw new Error(`daemon already running: pid=${alive[0]!.pid} port=${alive[0]!.port}`);
    }
  }
}

/** ops 脚本路径:本模块上两级 scripts/(build/daemon/main.js → build/scripts,
 *  源 src/daemon/main.ts → src/scripts,vitest 同深度)——registry.ts 包根推导同款惯例。 */
function daemonOpsScript(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'godot_operations.gd');
}

/**
 * daemon 进程组装(薄壳,批 A;端到端真机验收批 C)。
 * 顺序(spec §3.1):启动门 → 启动序裁剪(无 TUI/无 self-update/无 stdin 钩子,m-1/m-2)
 * → token → GodotServer(daemon 模式,不 connect stdio)→ 面板(单端口双路由)
 * → /mcp 端点 → 保活/审计/退出链。
 */
export async function runDaemon(args: string[]): Promise<void> {
  const { port, respawnOf } = parseDaemonArgs(args);
  // N-3(批 A 审查)后启动门不再收 port(决策段零消费,端口语义归组装段 gui 构造)。
  await runDaemonStartupGate({ env: process.env, respawnOf });
  await runStartupSequence({ dashboard: false, selfUpdate: false });

  const token = getOrCreateSharedToken();
  // N-2(批 A 审查)后 ServerOptions 不再携带 processMode/mcpHandler——daemon 与 stdio
  // 的差异全部落在本入口的组装方式(daemon 不调 run()/connect stdio,自走 buildWebGuiOptions
  // 工厂 + connectTransport),构造参数与 stdio 侧一致。
  const server = new GodotServer(daemonOpsScript());

  // /mcp 端点与面板的鸡生蛋(spec §3.2):mcpHandler 须在 WebGuiServer 构造期注入
  // (构造器注入面,无 setMcpHandler),而 endpoint 的 deps.port 要 gui.start() 后
  // 才知(gui.port 实际监听值)。两段式接线:先挂转发闭包(start 到回填之间的窗口
  // 请求回 503,诚实表达"端点未就绪"),start 后按实际端口构造 endpoint 再回填实现。
  let mcpHandlerImpl: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  let shuttingDown = false;
  const gui = new WebGuiServer(server.buildWebGuiOptions({
    // daemon 特化键(spec §3.4/§3.7/§3.5):
    // strictPort=respawn 交接端口不漂移不变式(M-2,EADDRINUSE 即败不静默顺延);
    // portStart=指定 --port 时作为唯一候选(缺席时 undefined 落 server.ts 的 env/默认链);
    // instanceKind=登记 kind 字段;token=与 /mcp 端点共用同一份(构造期显式注入,
    // 防 getOrCreateSharedToken 并发首启窗口内两处读到不同值);
    // onSelfRestart=daemon 的 gui 由本入口持有(不挂 GodotServer 的 webGuiServer 字段,
    // close() 停不到它),退出统管权移交本入口的 shutdownDaemon。
    strictPort: port !== undefined,
    portStart: port,
    instanceKind: 'daemon',
    // respawnOf:登记写入受控交接关联字段(§3.7"交接中"标注数据源);条件展开遵守
    // "daemon 侧仅传确定值键"惯例(spread 的 undefined 会覆盖基座,见 GodotServer 注释)。
    ...(respawnOf !== undefined ? { respawnOf } : {}),
    token,
    mcpHandler: (req, res) => {
      if (mcpHandlerImpl) { mcpHandlerImpl(req, res); return; }
      res.writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'mcp endpoint not ready' }));
    },
    onSelfRestart: () => { void shutdownDaemon(); },
    // 受控关停/重启回调(§3.7 T1 面板 + T2 CLI 通道的服务端执行点,Task 7 注入端):
    // stop = 既有有序退出链;restart = 受控交接四步序列(close listener → spawn 新
    // daemon(--port+--respawn-of)→ 登记比对 → verified 删登记退出;失败回滚杀新
    // 实例 + relisten,不留双活)。失败以 throw 上报后由 catch 落日志——旧进程继续服务。
    onControlledShutdown: (mode) => {
      if (mode !== 'restart') { void shutdownDaemon(); return; }
      void controlledRestart({
        gui,
        server,
        spawnDaemon: spawnDaemonDetached,
        killTree: killPidTree,
        listRegistrations: () => listRegistrations(),
        removeRegistrationVerified: (pid, startedAt) => removeRegistrationVerified(pid, startedAt),
        sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
        exit: (code) => process.exit(code),
        // 有序 close 链收尾:logger flush 对齐 shutdownDaemon 的 close 顺序(server.close 后)
        beforeExit: async () => { getLogger().close(); },
      }).catch((err: unknown) => {
        getLogger().error('daemon', `controlled restart 失败(已回滚,继续服务): ${err instanceof Error ? err.message : err}`);
      });
    },
  }));

  /** 有序退出:面板停(清登记)→ server 完整清理链 → logger flush → exit 0。
   *  二次触发强制退(对齐 index.ts gracefulShutdown 的 A-2 语义)。 */
  async function shutdownDaemon(): Promise<void> {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    try {
      await gui.stop();
      await server.close();
      getLogger().close();
    } catch (err) {
      console.error(`daemon shutdown error: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  }

  try {
    await gui.start();
  } catch (err) {
    // Task 6 review 交接同款:start() reject 可能残留半激活态(HTTP 已监听 + 登记未写),
    // 补 stop() 清理再上抛(strictPort 端口冲突场景走此路径,入口 catch 转 exit 1)。
    try { await gui.stop(); } catch { /* best-effort 清理 */ }
    throw err;
  }

  const endpoint = createMcpEndpoint({
    // connect 走 GodotServer.connectTransport(Task 2 注入点,daemon 纪律:不注册 stdin
    // 钩子)——不触达 GodotServer 的私有 server 字段;mcpServer 形状即 mcp-endpoint 的
    // 结构最小接口 McpConnectable。
    mcpServer: { connect: (transport) => server.connectTransport(transport) },
    token,
    port: gui.port,
  });
  mcpHandlerImpl = (req, res) => { void endpoint.handler(req, res); };
  await endpoint.connect();

  // 进程保活:WebGuiServer 的 listener 与定时器全 unref(附属功能纪律,stdio 进程靠
  // transport 持有事件循环)——daemon 无 stdio transport,不显式持有则启动完成即自然退出。
  setInterval(() => { /* daemon 存在性持有 */ }, 60_000);

  // daemon 启动机器级审计(spec §3.9 生命周期事件留痕;对齐 web-gui auditInstanceAction
  // 先例:isAuditEnabled 守卫 + best-effort,失败不阻断启动)。
  if (isAuditEnabled()) {
    void appendMachineAuditLine({
      trace_id: `daemon-startup-${Date.now().toString(36)}`,
      tool: 'web-gui', action: 'daemon-startup', risk: 'process',
      ok: true, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'daemon',
      details: { pid: process.pid, port: gui.port, respawn_of: respawnOf ?? null },
    }).catch(() => { /* best-effort */ });
  }

  // URL 打印义务(spec §3.8 n-4):面板 + /mcp 地址与 token 获取方式,daemon 日志侧。
  const logger = getLogger();
  logger.info('daemon', `daemon ready: panel=http://127.0.0.1:${gui.port}/ mcp=http://127.0.0.1:${gui.port}/mcp pid=${process.pid}`);
  logger.info('daemon', 'token 获取:godot-mcp-enhanced daemon status --show-token(或 daemon 自身面板设置页)');

  // 退出链(spec §3.1/§3.3):POSIX 信号有序 close;SIGBREAK=Windows Ctrl+Break 同类;
  // Windows 跨进程优雅停止主路走 /api/shutdown(批 B 接线,本入口的 onSelfRestart 即其
  // 服务端执行点)——kill(pid) 在 Windows 是硬终止不走本链(spec B-3)。
  process.on('SIGINT', () => { void shutdownDaemon(); });
  process.on('SIGTERM', () => { void shutdownDaemon(); });
  process.on('SIGBREAK', () => { void shutdownDaemon(); });
}

// ── 入口守卫(直接执行 build/daemon/main.js 才跑;被 import 不跑,供测试注入)─────
// 跨平台精确比对:Windows argv[1] 是反斜杠绝对路径(endsWith('daemon/main.js') 不成立),
// resolve 后与 import.meta.url 的文件路径逐字比对,无误放行(他包同名入口不匹配)。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDaemon(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
