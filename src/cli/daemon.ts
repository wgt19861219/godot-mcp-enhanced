// src/cli/daemon.ts — daemon 生命周期 CLI 壳(daemon 批 B 2026-09-30,spec §3.8,Task 8)
// 四命令:start / stop / status / restart。壳薄——参数组装 + detached spawn + registry
// 就绪轮询 + 受控关停调用,重活全在注入依赖上(测试 fake 注入,真机验收批 C):
//   - spawnDaemon:detached:true + stdio ['ignore', fd, fd](stdout/stderr →
//     ~/.godot-mcp/logs/daemon-<YYYYMMDD-HHmmss>.log append)+ unref;
//     --port 恒传(批 A ledger:strictPort 语义,防非 respawn 场景顺延漂移)。
//   - 就绪判定 = registry 登记比对(kind=daemon 且 pid=新进程 pid),不用 /api/health
//     (批 A M-2 裁定:health 分不清谁的实例)。
//   - 受控关停 = POST /api/shutdown?token=<登记 token>(Task 7 ⚠️ 交接:query 是
//     server.ts extractToken 第一优先级通道;Node http 原生请求无 Origin 头天然放行,
//     不发明 Origin)。超时/残留 → killPidTree 兜底。

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { request } from 'node:http';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../core/exit-codes.js';
import { killPidTree as defaultKillPidTree } from '../core/process-state.js';
import { defaultOpener } from '../web-gui/open.js';
import type { WebGuiRegistration } from '../web-gui/registry.js';

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 端口起点缺省值(server.ts portStart 同款默认)。 */
const DEFAULT_PORT_BASE = 9550;
/** 端口占用递增候选上限(9550~9569 = 面板自愈扫描端口段,对齐 server.ts M-4 注释)。 */
const PORT_PROBE_LIMIT = 20;
/** 单端口 net.connect 探测超时(保守:超时视为占用,防误选)。 */
const PORT_PROBE_TIMEOUT_MS = 400;
/** start/restart 后等 registry 出现新登记的总预算(spec §3.8)。 */
const READY_TIMEOUT_MS = 10_000;
/** 受控关停 HTTP 请求超时(dispatch 契约:5s)。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** 受控停止/kill 后等登记消失的预算。 */
const GONE_TIMEOUT_MS = 5_000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 250;

// ─── 注入面 ────────────────────────────────────────────────────────────────

export interface DaemonSpawnOptions {
  /** 恒传给 daemon 入口(--port,strictPort 语义)。 */
  port: number;
  /** --respawn-of 受控交接豁免旗标(§3.7;CLI 命令面未用,respawn 链复用)。 */
  respawnOf?: number;
}

export interface DaemonSpawnResult {
  pid: number;
  logFile: string;
}

export interface DaemonCliDeps {
  /** env 注入(端口起点 GODOT_MCP_WEB_GUI_PORT;缺省 process.env)。 */
  env?: NodeJS.ProcessEnv;
  /** registry 目录注入(透传真实 listRegistrations;缺省 ~/.godot-mcp/web-gui/)。 */
  registryDir?: string;
  /** registry 读取注入(测试序列可控;缺省真 listRegistrations 绑 registryDir)。 */
  listRegistrations?: (opts: { dir?: string }) => Promise<WebGuiRegistration[]>;
  /** daemon spawn 注入(测试 fake;缺省真实 detached spawn + 日志 fd)。 */
  spawnDaemon?: (opts: DaemonSpawnOptions) => DaemonSpawnResult;
  /** 受控关停 HTTP 注入(测试 fake;缺省真实 node:http POST,超时 reject)。 */
  postShutdown?: (opts: { port: number; token: string; restart: boolean; timeoutMs: number }) => Promise<{ status: number }>;
  /** 进程树强杀注入(缺省 core/process-state killPidTree 同源实现)。 */
  killPidTree?: (pid: number) => void;
  /** 端口空闲探测注入(缺省 net.connect 127.0.0.1,connect 成功=占用)。 */
  isPortFree?: (port: number) => Promise<boolean>;
  /** --open 浏览器 opener(缺省 open.ts defaultOpener 同源复用)。 */
  opener?: (url: string) => void;
  /** 轮询 sleep 注入(测试零等待)。 */
  sleep?: (ms: number) => Promise<void>;
  /** 进程退出注入(缺省 process.exit;exit code 经 EXIT_CODES 注册表)。 */
  exit?: (code: number) => never;
}

// ─── 纯函数 ────────────────────────────────────────────────────────────────

/** spawn 完整 argv(含入口)。--port 恒在(批 A ledger:防非 respawn 场景顺延漂移)。 */
export function buildDaemonArgv(entry: string, port: number, respawnOf?: number): string[] {
  const argv = [entry, '--port', String(port)];
  if (respawnOf !== undefined) argv.push('--respawn-of', String(respawnOf));
  return argv;
}

/** 受控关停 URL:token 走 query 第一优先级通道(server.ts extractToken:306 先例),
 *  不发明 Origin——Node http 原生请求无 Origin 头,originAllowed 无 Origin 放行。 */
export function buildShutdownUrl(port: number, token: string, restart: boolean): string {
  const base = `http://127.0.0.1:${port}/api/shutdown?token=${encodeURIComponent(token)}`;
  return restart ? `${base}&restart=1` : base;
}

/** 端口起点:GODOT_MCP_WEB_GUI_PORT 合法数字透传;'0'/非数字/缺席 → 9550
 *  (对齐 server.ts WebGuiServerOptions.portStart 注释的同款 env 语义)。 */
export function resolveBasePort(env: NodeJS.ProcessEnv): number {
  const raw = env.GODOT_MCP_WEB_GUI_PORT;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT_BASE;
}

/** token 打码(open.ts M-2 先例:前 4 位 + ****,全量 token 不落终端)。 */
function maskToken(token: string): string {
  return `${token.slice(0, 4)}****`;
}

/** daemon 入口路径:本模块(build/cli/daemon.js)同级 daemon/main.js;
 *  源布局(src/cli)下 main.js 不存在 → defaultSpawnDaemon 的 existsSync 守卫报错。 */
export function daemonEntryPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'daemon', 'main.js');
}

// ─── 真实依赖缺省实现 ──────────────────────────────────────────────────────

/** 本地时间戳文件名段:YYYYMMDD-HHmmss。 */
function timestampForLog(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function defaultSpawnDaemon(opts: DaemonSpawnOptions): DaemonSpawnResult {
  const entry = daemonEntryPath();
  if (!existsSync(entry)) {
    throw new Error(`daemon 入口缺失:${entry}(开发态请先 npm run build)`);
  }
  const logDir = join(homedir(), '.godot-mcp', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `daemon-${timestampForLog()}.log`);
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, buildDaemonArgv(entry, opts.port, opts.respawnOf), {
      detached: true,
      // stdin ignore(daemon 无交互面);stdout/stderr 落日志文件 fd(append)
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return { pid: child.pid ?? -1, logFile };
  } finally {
    // fd 副本已由 spawn 复制给子进程,父进程关闭自己的副本防泄漏
    closeSync(fd);
  }
}

/** net.connect 探测端口占用:连接建立=占用;ECONNREFUSED=空闲;超时保守视为占用。
 *  选型说明(报告 §端口探测):registry 只见本工具实例,第三方进程占用(如别的服务
 *  常驻 9550)registry 看不见;net.connect 单一机制同时覆盖两类占用,最简且完备。 */
function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: PORT_PROBE_TIMEOUT_MS });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { /* ECONNREFUSED = 空闲 */ resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function defaultPostShutdown(opts: { port: number; token: string; restart: boolean; timeoutMs: number }): Promise<{ status: number }> {
  const url = buildShutdownUrl(opts.port, opts.token, opts.restart);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', timeout: opts.timeoutMs }, (res) => {
      res.resume();  // 丢弃响应体,只取状态码
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('timeout', () => req.destroy(new Error(`POST ${opts.port}/api/shutdown timed out after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

// ─── 内部工具 ──────────────────────────────────────────────────────────────

interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  listRegistrations: () => Promise<WebGuiRegistration[]>;
  spawnDaemon: (opts: DaemonSpawnOptions) => DaemonSpawnResult;
  postShutdown: (opts: { port: number; token: string; restart: boolean; timeoutMs: number }) => Promise<{ status: number }>;
  killPidTree: (pid: number) => void;
  isPortFree: (port: number) => Promise<boolean>;
  opener: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  exit: (code: number) => never;
}

async function resolveDeps(deps: DaemonCliDeps): Promise<ResolvedDeps> {
  // 真实 listRegistrations 惰性 import(避免本模块加载即拉起 registry fs 副作用的
  // 依赖面;与 router.ts 动态 import 先例同款)。
  const { listRegistrations: realList } = await import('../web-gui/registry.js');
  return {
    env: deps.env ?? process.env,
    listRegistrations: () => (deps.listRegistrations
      ? deps.listRegistrations({})
      : realList(deps.registryDir ? { dir: deps.registryDir } : {})),
    spawnDaemon: deps.spawnDaemon ?? defaultSpawnDaemon,
    postShutdown: deps.postShutdown ?? defaultPostShutdown,
    killPidTree: deps.killPidTree ?? defaultKillPidTree,
    isPortFree: deps.isPortFree ?? defaultIsPortFree,
    opener: deps.opener ?? defaultOpener,
    sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
  };
}

/** 轮询直到 fn 返回非 undefined 或超时;超时返回 undefined。双保险退出:真实
 *  deadline(生产语义)+ 轮数上限(测试注入零等待 sleep 时不挂真实时钟等待)。 */
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  d: ResolvedDeps,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / POLL_INTERVAL_MS) + 1;
  for (let i = 0; i < maxAttempts; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await d.sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

function findDaemon(list: WebGuiRegistration[]): WebGuiRegistration | undefined {
  return list.find(r => r.kind === 'daemon');
}

/** 端口选取:base 起步占用则 +1 递增,最多 PORT_PROBE_LIMIT 个候选;全占 → undefined。 */
async function pickFreePort(base: number, d: ResolvedDeps): Promise<number | undefined> {
  for (let i = 0; i < PORT_PROBE_LIMIT; i++) {
    if (await d.isPortFree(base + i)) return base + i;
  }
  return undefined;
}

/** URL 打印义务(spec §3.8 n-4):面板 + /mcp 地址 + token 获取方式;token 打码
 *  (open.ts M-2 先例)。/mcp 鉴权是 Bearer 头(mcp-endpoint 闸门 2),一并提示。 */
function printDaemonReady(r: WebGuiRegistration, extra?: string): void {
  console.log(`✓ daemon 已就绪:pid=${r.pid} port=${r.port}`);
  console.log(`  面板: http://127.0.0.1:${r.port}/#token=${maskToken(r.token)}(完整地址:daemon status --show-token)`);
  console.log(`  MCP 端点: http://127.0.0.1:${r.port}/mcp(Authorization: Bearer <token>)`);
  console.log('  token 获取:godot-mcp-enhanced daemon status --show-token');
  if (extra) console.log(`  ${extra}`);
}

// ─── 子命令(返回 exit code,runDaemonCli 统一退出——deps.exit 注入 fake 不真
//      终止进程,子命令内直调 exit 会穿透后续分支,故收口到单一调用点)──────────────

/** start:单例检测① → 端口选取 → detached spawn → registry 就绪轮询 → URL 打印。 */
async function cmdStart(d: ResolvedDeps, open: boolean): Promise<number> {
  const existing = findDaemon(await d.listRegistrations());
  if (existing) {
    console.error(`daemon 已在运行:pid=${existing.pid} port=${existing.port}(如需重启用 daemon restart)`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  const base = resolveBasePort(d.env);
  const port = await pickFreePort(base, d);
  if (port === undefined) {
    console.error(`端口 ${base}~${base + PORT_PROBE_LIMIT - 1} 均被占用,daemon 启动放弃(可用 GODOT_MCP_WEB_GUI_PORT 换起点)`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  // spawn 抛错(入口缺失/权限等)冒到 runDaemonCli 外层 catch:打印 + exit 1
  const spawned = d.spawnDaemon({ port });
  const reg = await pollUntil(
    async () => {
      const cur = findDaemon(await d.listRegistrations());
      return cur !== undefined && cur.pid === spawned.pid ? cur : undefined;
    },
    READY_TIMEOUT_MS,
    d,
  );
  if (!reg) {
    console.error(`daemon 未在 ${READY_TIMEOUT_MS / 1000}s 内完成登记(pid=${spawned.pid});启动日志:${spawned.logFile}`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  printDaemonReady(reg, `日志: ${spawned.logFile}`);
  if (open) d.opener(`http://127.0.0.1:${reg.port}/#token=${reg.token}`);
  return EXIT_CODES.EXIT_OK;
}

/** 等某 daemon 登记从 registry 消失(受控停止 gui.stop() 清登记;kill 后探活顺手清)。
 *  判定按 pid 精确匹配而非"无 daemon"——respawn 交接窗口新旧登记可能短暂并存。 */
async function waitForDaemonGone(pid: number, d: ResolvedDeps): Promise<boolean> {
  const gone = await pollUntil(
    async () => ((await d.listRegistrations()).some(r => r.kind === 'daemon' && r.pid === pid) ? undefined : true),
    GONE_TIMEOUT_MS,
    d,
  );
  return gone === true;
}

/** stop:受控 /api/shutdown 主路;--force / 超时 / 受控后残留 → killPidTree 兜底;
 *  503(受控回调未注入)不自作主张硬杀,如实提示 --force。 */
async function cmdStop(d: ResolvedDeps, force: boolean): Promise<number> {
  const target = findDaemon(await d.listRegistrations());
  if (!target) {
    console.log('没有运行中的 daemon(无需停止)。');
    return EXIT_CODES.EXIT_OK;
  }
  if (force) {
    console.log(`已发送强制终止(pid=${target.pid},进程树)。`);
    d.killPidTree(target.pid);
    await waitForDaemonGone(target.pid, d);
    return EXIT_CODES.EXIT_OK;
  }
  let status: number;
  try {
    ({ status } = await d.postShutdown({ port: target.port, token: target.token, restart: false, timeoutMs: SHUTDOWN_TIMEOUT_MS }));
  } catch (err) {
    console.error(`受控停止请求失败(${err instanceof Error ? err.message : err})→ 强制终止 pid=${target.pid}`);
    d.killPidTree(target.pid);
    await waitForDaemonGone(target.pid, d);
    return EXIT_CODES.EXIT_OK;
  }
  if (status === 503) {
    // Task 9 接线前中间态:daemon 侧 onControlledShutdown 未注入——如实报错,
    // 不静默也不硬杀(受控通道不可用时让用户显式选 --force)
    console.error('daemon 版本未支持受控停止(503:回调未配置)。可用 daemon stop --force 强制终止。');
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  if (status !== 200) {
    console.error(`受控停止被拒(HTTP ${status};token 失配时可 daemon stop --force)`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  if (await waitForDaemonGone(target.pid, d)) {
    console.log(`✓ daemon 已停止(pid=${target.pid},受控退出)。`);
    return EXIT_CODES.EXIT_OK;
  }
  console.error(`受控停止已确认但登记未清(pid=${target.pid})→ 强制终止兜底`);
  d.killPidTree(target.pid);
  await waitForDaemonGone(target.pid, d);
  return EXIT_CODES.EXIT_OK;
}

/** status:列 registry 全部实例(daemon 优先);exit 0=有活 daemon。 */
async function cmdStatus(d: ResolvedDeps, showToken: boolean): Promise<number> {
  const list = await d.listRegistrations();
  if (list.length === 0) {
    console.log('没有运行中的 MCP 实例(daemon 或 stdio 均无)。');
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  // daemon 优先展示;组内保持 registry 读序
  const sorted = [...list.filter(r => r.kind === 'daemon'), ...list.filter(r => r.kind !== 'daemon')];
  console.log(`运行中的 MCP 实例(${sorted.length} 个;死登记已自动清理):`);
  for (const r of sorted) {
    const kind = r.kind ?? '早期';
    console.log(`  [${kind}] pid=${r.pid}  port=${r.port}  version=${r.version ?? '早期'}  started=${r.startedAt}  token=${showToken ? r.token : `${maskToken(r.token)}(--show-token 显示全量)`}`);
  }
  return findDaemon(list) ? EXIT_CODES.EXIT_OK : EXIT_CODES.EXIT_OPERATION_FAILED;
}

/** restart:活 daemon → /api/shutdown?restart=1 受控交接(503 = Task 9 前中间态,
 *  如实报错);死 daemon / 交接超时后 → 等价 start。 */
async function cmdRestart(d: ResolvedDeps, open: boolean): Promise<number> {
  const target = findDaemon(await d.listRegistrations());
  if (!target) return cmdStart(d, open);
  let status: number;
  try {
    ({ status } = await d.postShutdown({ port: target.port, token: target.token, restart: true, timeoutMs: SHUTDOWN_TIMEOUT_MS }));
  } catch (err) {
    // 受控交接超时 → kill 兜底后退化为重新 start(目标:重启完成)
    console.error(`受控重启请求失败(${err instanceof Error ? err.message : err})→ 强制终止 pid=${target.pid} 后重新启动`);
    d.killPidTree(target.pid);
    await waitForDaemonGone(target.pid, d);
    return cmdStart(d, open);
  }
  if (status === 503) {
    console.error('daemon 版本未支持受控重启(503:回调未配置)。请 stop + start(或 daemon stop --force 后再 start)。');
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  if (status !== 200) {
    console.error(`受控重启被拒(HTTP ${status};token 失配时先 daemon stop --force)`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  // 交接中:等新 pid 登记(daemon respawn 带新 pid 回同端口,strictPort 不变式)。
  // 交接窗口新旧登记可能短暂并存,按 pid !== 旧 pid 找新实例(不能用 findDaemon
  // 取首个——旧登记在前会永远挡住判定)。
  const fresh = await pollUntil(
    async () => (await d.listRegistrations()).find(r => r.kind === 'daemon' && r.pid !== target.pid),
    READY_TIMEOUT_MS,
    d,
  );
  if (!fresh) {
    console.error(`重启指令已被接受,但新实例未在 ${READY_TIMEOUT_MS / 1000}s 内完成登记;用 daemon status 查看。`);
    return EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  printDaemonReady(fresh);
  if (open) d.opener(`http://127.0.0.1:${fresh.port}/#token=${fresh.token}`);
  return EXIT_CODES.EXIT_OK;
}

// ─── 入口 ──────────────────────────────────────────────────────────────────

const USAGE = `用法:
  godot-mcp-enhanced daemon start [--open]   启动后台 daemon(--open 顺手开面板)
  godot-mcp-enhanced daemon stop [--force]   停止(--force 跳过受控通道直接强杀)
  godot-mcp-enhanced daemon status [--show-token]  查看实例清单(--show-token 显示全量 token)
  godot-mcp-enhanced daemon restart [--open] 重启(活实例走受控交接;死实例等价 start)`;

/** CLI 入口(router case 'daemon' 接线)。用法错误 exit 2;操作失败 exit 1;成功 exit 0
 *  (EXIT_CODES 注册表;test/p2-exit-path-repair.test.ts EX-b 静态扫描自动覆盖本文件:
 *  扫描递归 src/cli 全目录 + 本文件全用常量,无字面值,天然合规无需改该测试)。 */
export async function runDaemonCli(args: string[], deps: DaemonCliDeps = {}): Promise<void> {
  const d = await resolveDeps(deps);
  const cmd = args[0];
  const has = (name: string): boolean => args.some(a => a === `--${name}` || a.startsWith(`--${name}=`));
  let code: number;
  try {
    switch (cmd) {
      case 'start':
        code = await cmdStart(d, has('open'));
        break;
      case 'stop':
        code = await cmdStop(d, has('force'));
        break;
      case 'status':
        code = await cmdStatus(d, has('show-token'));
        break;
      case 'restart':
        code = await cmdRestart(d, has('open'));
        break;
      default:
        console.error(cmd === undefined ? USAGE : `未知子命令:${cmd}\n${USAGE}`);
        code = EXIT_CODES.EXIT_USAGE;
    }
  } catch (err) {
    console.error(`daemon ${cmd ?? ''} 失败:${err instanceof Error ? err.message : err}`);
    code = EXIT_CODES.EXIT_OPERATION_FAILED;
  }
  d.exit(code);
}
