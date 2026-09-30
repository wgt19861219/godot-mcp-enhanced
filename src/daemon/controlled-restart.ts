// src/daemon/controlled-restart.ts — daemon 受控交接序列(daemon 批 B 2026-09-30,spec §3.7)
//
// ── 两条不变式(置顶;实现任何分支不得违反)──────────────────────────────────
// 不变式 1(端口不漂移):daemon 的端口跨重启不漂移——spawn 新实例显式传
//   `--port=<旧端口>` 且新实例以 strictPort 语义启动(main.ts 构造,绑不上即败不
//   静默顺延)。MCP 客户端配置的是静态 URL,面板浏览器有 recoverPanel 跨端口自愈
//   但 MCP 客户端没有(spec 第 1 轮 B-1)——端口稳定优先于交接期间的秒级可用性。
// 不变式 2(至多一个活 daemon):任意时刻至多一个活 daemon,失败回滚路径也必须
//   维持(spec 第 2 轮 M-2)——回滚先 killTree 新实例并轮询确认其登记消失,再
//   relisten 原端口,绝不留双活。
//
// ── 分层声明 ────────────────────────────────────────────────────────────────
// default spawn(spawnDaemonDetached)是 daemon 进程内自用实现,与 CLI 壳
// (src/cli/daemon.ts defaultSpawnDaemon)互不 import——CLI 与 daemon 分层
// (spec §3.8:壳薄/入口厚,职责不同不混文件)。argv flags 形态两边保持一致
// (--port 恒传 + 可选 --respawn-of),由两侧测试各自锁定。
//
// ── 审计 ────────────────────────────────────────────────────────────────────
// 交接各步落机器级审计(caller 'web-gui:daemon',action 'controlled-restart',
// details 含 step/oldPid/newPid/port/result)——形态对齐 cli/daemon.ts
// defaultAuditKill(直调 appendMachineAuditLine + await 先于后续动作落盘 +
// 失败 warn 不阻断);一次交接共享同一 trace_id,多步可关联回放。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMachineAuditLine } from '../core/audit-log.js';
import type { WebGuiRegistration } from '../web-gui/registry.js';

// ── 常量(对齐 cli/daemon.ts 同名先例;deps 可注入缩小,测试零真实时钟)────────

/** 等新 daemon 完成登记的总预算(交接成功判定窗口)。 */
const READY_TIMEOUT_MS = 10_000;
/** 回滚后等新实例登记消失的预算。 */
const GONE_TIMEOUT_MS = 5_000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 250;

// ── 注入面 ──────────────────────────────────────────────────────────────────

/** gui 侧最小结构面(WebGuiServer 结构满足;测试注入 fake)。 */
export interface RestartGuiHandle {
  /** 实际监听端口(start() 定格的实际值,交接的"旧端口"真源)。 */
  readonly port: number;
  /** 登记文件同源 startedAt——removeRegistrationVerified 的期望值必须与登记文件
   *  逐字一致(WebGuiServer.start() 写登记与暴露本值用的是同一 string 引用),
   *  另 new Date() 会因时间戳不同导致 verified 永远 false。 */
  readonly registrationStartedAt: string;
  /** §3.7 步骤 1:只关 HTTP listener 释放端口(不清登记/不置 inactive/进程不退)。 */
  closeListener(): Promise<void>;
  /** closeListener 的逆操作:同端口重新监听(不变式 1 的回滚侧兑现)。 */
  relisten(): Promise<void>;
}

/** 单步审计注入面:ok=false 表示该步失败;details 的 step/oldPid/port 由序列统一垫。 */
export type ControlledRestartAudit = (ok: boolean, details: Record<string, unknown>) => void | Promise<void>;

/** 受控交接依赖(全注入,main.ts 接真实实现,测试注入 fake——不真跑 runDaemon:
 *  main.ts 有不 unref 的保活 setInterval,真跑会拖死测试进程)。 */
export interface ControlledRestartDeps {
  gui: RestartGuiHandle;
  /** 有序 close 链的 server 段(GodotServer 结构满足)。 */
  server: { close(): Promise<void> };
  /** spawn 新 daemon(注入式;flags = ['--port', N, '--respawn-of', 旧pid],不含入口)。 */
  spawnDaemon: (flags: string[]) => { pid: number };
  /** 进程树强杀(core/process-state killPidTree 同源)。 */
  killTree: (pid: number) => void;
  /** registry 读取注入(轮询交接成功判定/回滚确认登记消失)。 */
  listRegistrations: () => Promise<WebGuiRegistration[]>;
  /** Task 5:校验内容后删登记(PID 复用防误删)。 */
  removeRegistrationVerified: (pid: number, expectedStartedAt: string) => Promise<boolean>;
  /** 轮询 sleep 注入(测试零等待)。 */
  sleep: (ms: number) => Promise<void>;
  /** 进程退出注入(测试 fake 防杀测试进程;生产传 process.exit)。 */
  exit: (code: number) => void;
  /** 旧进程 pid(缺省 process.pid;测试注入定值)。 */
  oldPid?: number;
  /** 就绪轮询预算注入(缺省 READY_TIMEOUT_MS)。 */
  readyTimeoutMs?: number;
  /** 回滚登记消失预算注入(缺省 GONE_TIMEOUT_MS)。 */
  goneTimeoutMs?: number;
  /** 轮询间隔注入(缺省 POLL_INTERVAL_MS)。 */
  pollIntervalMs?: number;
  /** exit 前收尾钩子(main.ts 注入 logger flush;server.close 之后调用)。 */
  beforeExit?: () => Promise<void>;
  /** 审计注入(缺省直调 appendMachineAuditLine,形态对齐 defaultAuditKill)。 */
  audit?: ControlledRestartAudit;
}

// ── default 实现 ────────────────────────────────────────────────────────────

/** 一次交接共享 trace_id 的 default 审计(对齐 cli/daemon.ts defaultAuditKill:
 *  机器级恒写、await 先落盘、失败 warn 不阻断)。 */
function makeDefaultAudit(traceId: string): ControlledRestartAudit {
  return async (ok, details) => {
    await appendMachineAuditLine({
      trace_id: traceId,
      tool: 'web-gui', action: 'controlled-restart', risk: 'process',
      ok, project_path: '', changed_files: [], duration_ms: 0,
      caller: 'web-gui:daemon', details,
    }).catch((e: unknown) => {
      console.warn(`[godot-mcp] machine-audit write failed (best-effort): ${e instanceof Error ? e.message : e}`);
    });
  };
}

/** daemon 入口路径:本模块(build/daemon/controlled-restart.js)同目录 main.js;
 *  源布局(src/daemon)下 main.js 不存在 → existsSync 守卫报错(开发态先 npm run build)。 */
function daemonEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'main.js');
}

/** 本地时间戳文件名段:YYYYMMDD-HHmmss(与 cli/daemon.ts 同款独立副本,分层不 import)。 */
function timestampForLog(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * default spawn(§3.7 步骤 2):detached 新 daemon + stdout/stderr 落日志文件
 * (spec §3.9:防 Windows detached 输出悬空)+ unref(旧进程退出不拖新实例)。
 * flags 已含 --port=旧端口(不变式 1)与 --respawn-of=旧 pid(单例检测豁免,§3.4)。
 */
export function spawnDaemonDetached(flags: string[]): { pid: number } {
  const entry = daemonEntryPath();
  if (!existsSync(entry)) {
    throw new Error(`daemon 入口缺失:${entry}(开发态请先 npm run build)`);
  }
  const logDir = join(homedir(), '.godot-mcp', 'logs');
  mkdirSync(logDir, { recursive: true });
  // 日志名 timestamp(非 pid):日志文件必须先于 spawn 打开(stdio fd 是 spawn 参数),
  // 而 pid 在 spawn 之后才确定——与 cli/daemon.ts 同款偏差声明(spec §3.8 字面 daemon-<pid>.log)。
  const logFile = join(logDir, `daemon-${timestampForLog()}.log`);
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [entry, ...flags], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return { pid: child.pid ?? -1 };
  } finally {
    // fd 副本已由 spawn 复制给子进程,父进程关闭自己的副本防泄漏
    closeSync(fd);
  }
}

// ── 序列 ────────────────────────────────────────────────────────────────────

/** 轮询直到 fn 为 true 或超时。双保险退出:真实 deadline + 轮数上限
 *  (测试注入零等待 sleep 时不挂真实时钟,对齐 cli/daemon.ts pollUntil)。 */
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / pollMs) + 1;
  for (let i = 0; i < maxAttempts; i++) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return false;
}

/** 步骤 4:失败回滚(不变式 2)。newPid=null(spawn 失败,无新实例)跳过 kill/
 *  等登记消失,直接 relisten。relisten 本身失败属回滚残留(spec R5 理论场景),
 *  审计落痕后上抛——调用方兜底记录,进程继续活着(登记仍在,下次可再交接)。 */
async function rollback(
  deps: ControlledRestartDeps,
  audit: ControlledRestartAudit,
  oldPid: number,
  newPid: number | null,
  port: number,
  goneTimeoutMs: number,
  pollMs: number,
): Promise<void> {
  if (newPid !== null && newPid > 0) {
    const np = newPid;
    deps.killTree(np);
    await audit(true, { step: 'rollback-kill', oldPid, newPid, port, result: 'killed' });
    const gone = await pollUntil(
      async () => !(await deps.listRegistrations()).some(r => r.pid === np),
      goneTimeoutMs, deps.sleep, pollMs,
    );
    await audit(gone, { step: 'rollback-registration-gone', oldPid, newPid, port, result: gone ? 'gone' : 'still-present-after-timeout' });
  }
  try {
    await deps.gui.relisten();
    await audit(true, { step: 'rollback-relisten', oldPid, newPid, port, result: 'ok' });
  } catch (err) {
    await audit(false, { step: 'rollback-relisten', oldPid, newPid, port, result: 'relisten-failed', error: err instanceof Error ? err.message : String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * §3.7 受控交接序列(daemon 收到 restart 指令后自执行;失败以 throw 上报,
 * 回滚完成后旧进程继续服务):
 * 1. 先关 HTTP listener(不 exit,进程仍在),端口释放;
 * 2. detached-spawn 新 daemon,显式 --port=旧端口 + --respawn-of=旧pid;
 * 3. 交接成功判定:registry 出现新登记且 port===旧端口 且 kind==='daemon'
 *    (按登记文件比对,不用无鉴权 /api/health)→ removeRegistrationVerified
 *    删自身登记 → 有序 close → exit(0);端口不符立即回滚(不等满超时);
 * 4. 失败回滚:先 killTree 新实例并轮询确认其登记消失,再 relisten 原端口
 *    (不留双活)→ throw 失败详情。
 */
export async function controlledRestart(deps: ControlledRestartDeps): Promise<void> {
  const oldPid = deps.oldPid ?? process.pid;
  const port = deps.gui.port;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const goneTimeoutMs = deps.goneTimeoutMs ?? GONE_TIMEOUT_MS;
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const audit = deps.audit ?? makeDefaultAudit(`web-gui-${randomUUID().slice(0, 16)}`);

  // ── 步骤 1:关 listener 释放端口(登记保留 = 交接窗口"交接中"标注数据源)──────
  await deps.gui.closeListener();
  await audit(true, { step: 'close-listener', oldPid, port, result: 'ok' });

  // ── 步骤 2:spawn 新 daemon(不变式 1:--port 恒传旧端口;--respawn-of 豁免单例检测)──
  const flags = ['--port', String(port), '--respawn-of', String(oldPid)];
  let newPid: number | null = null;
  try {
    newPid = deps.spawnDaemon(flags).pid;
    await audit(true, { step: 'spawn', oldPid, newPid, port, result: 'ok' });
  } catch (err) {
    await audit(false, { step: 'spawn', oldPid, port, result: 'spawn-failed', error: err instanceof Error ? err.message : String(err) });
    // newPid 而非裸 null:spawn 成功后 audit 才失败时新实例已存在,回滚同样要杀它
    await rollback(deps, audit, oldPid, newPid, port, goneTimeoutMs, pollMs);
    throw err instanceof Error ? err : new Error(String(err));
  }
  const spawnedPid = newPid;

  // ── 步骤 3:轮询新登记(spec 第 2 轮 M-2 收紧:port===旧端口 且 kind==='daemon',
  //    按登记文件 pid 精确匹配——spawn 在自己手里,pid 已知,不猜)──────────────────
  const deadline = Date.now() + readyTimeoutMs;
  const maxAttempts = Math.ceil(readyTimeoutMs / pollMs) + 1;
  let fresh: WebGuiRegistration | undefined;
  let mismatch: WebGuiRegistration | undefined;
  for (let i = 0; i < maxAttempts && fresh === undefined && mismatch === undefined; i++) {
    const own = (await deps.listRegistrations()).find(r => r.pid === spawnedPid);
    if (own) {
      if (own.kind === 'daemon' && own.port === port) fresh = own;
      else mismatch = own;
      break;
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(pollMs);
  }
  if (!fresh) {
    const reason = mismatch ? 'port-mismatch' : 'timeout';
    await audit(false, {
      step: 'handover', oldPid, newPid: spawnedPid, port, result: reason,
      ...(mismatch ? { newPort: mismatch.port, newKind: mismatch.kind ?? null } : {}),
    });
    await rollback(deps, audit, oldPid, spawnedPid, port, goneTimeoutMs, pollMs);
    throw new Error(mismatch
      ? `controlled restart: 新 daemon(pid=${spawnedPid})登记端口 ${mismatch.port} !== 期望 ${port},已回滚`
      : `controlled restart: 新 daemon(pid=${spawnedPid})未在 ${readyTimeoutMs}ms 内完成登记,已回滚`);
  }
  await audit(true, { step: 'handover', oldPid, newPid: spawnedPid, port, result: 'verified' });

  // ── 步骤 3(续):删自身登记(verified:pid+startedAt 双校验防 PID 复用误删;
  //    false = 登记已被他者处理/PID 复用——不删他文件,继续自身退出,如实审计)─────
  const removed = await deps.removeRegistrationVerified(oldPid, deps.gui.registrationStartedAt);
  await audit(removed, { step: 'remove-registration', oldPid, newPid: spawnedPid, port, result: removed ? 'verified' : 'mismatch-pid-reuse-kept' });

  // ── 步骤 3(终):有序 close 链 → exit(0)。新实例已顶上,双登记窗口关闭。──────
  await deps.server.close();
  await deps.beforeExit?.();
  await audit(true, { step: 'exit', oldPid, newPid: spawnedPid, port, result: 'handover-complete' });
  deps.exit(0);
}
