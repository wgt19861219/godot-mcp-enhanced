import { spawn, type ChildProcess } from 'child_process';
import { DebuggerProfiler } from '../core/function-profiler.js';
import { opsErrorResult } from './shared.js';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { maybeWrapUntrusted } from '../core/untrusted-wrap.js';
import { textResult, errorResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses, registerSpawnedGodotPid, unregisterSpawnedGodotPid, normalizeProjectKey, ensureSessionCapacity, getRunSessionProc, setRunSessionProc, releaseRunSessionBusy, clearRunSession, markSessionStopping, markSessionExited, setSessionStatus, listRunSessions, getSession } from '../core/process-state.js';
import type { RunSession } from '../core/process-state.js';
import { requireProjectPath, checkVersionMismatch, buildSafeEnv } from '../helpers.js';
import { isBridgeReady } from './game-bridge.js';
import { detectGodotVersion } from '../core/godot-finder.js';
import { handleRecordingAction } from './recording.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/tool-registry.js';

const ACTIONS = [
  'launch_editor',
  'run_project',
  'stop_project',
  'get_debug_output',
  'run_tests',
  'get_godot_version',
  // ── Recording actions (merged from recording.ts, v0.18.0) ──
  'record_start',
  'record_stop',
  'record_save',
  'record_load',
  'record_play',
] as const;

// ─── classifyOutput helper ──────────────────────────────────────────────────

// A-06: Use precise pattern matching to avoid false positives like "no errors found"
const ERROR_PATTERNS = [
  /^\s*error:/i,           // "ERROR:" or "  error:" at line start
  /\berror\b(?!\s+found)/i, // "error" but not "error found" or "errors found"
  /traceback/i,
  /exception/i,
  /SCRIPT ERROR/i,
  /\*\*ERROR\*\*/i,
];

const WARN_PATTERNS = [
  /^\s*warn(?:ing)?:/i,    // "WARNING:" or "warn:" at line start
  /\bwarn(?:ing)?\b(?!\s+found)/i, // "warning"/"warn" but not "warning found" or "warnings found"
  /\*\*WARNING\*\*/i,
];

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      errors.push(line);
    } else if (WARN_PATTERNS.some(p => p.test(line))) {
      warnings.push(line);
    } else {
      prints.push(line);
    }
  }

  return { errors, warnings, prints };
}

// ─── B-1 修复:输出读取回落(设计 §4.3 M-3 分桶版)──────────────────────────
// 桶输出缓冲非空、或有进程在跑 → 读当前缓冲;否则回落读该桶最近结束运行的快照
// (RunSession.lastFinishedRunOutput)。游戏结束后(用户关窗/秒崩/被杀)
// get_debug_output / stop_project 仍能报出该次运行的错误。
// 消费 per-key session(不再读 ctx.* 活跃桶字段——stop/get_debug_output 指定
// project_path 时字段读数全部改读 X 桶,设计 §4.3 M-3)。
function resolveReadableOutputFor(s: RunSession | undefined): { lines: string[]; fromSnapshot: boolean } {
  if (!s) return { lines: [], fromSnapshot: false };
  if (s.outputBuffer.length > 0 || s.proc !== null) {
    return { lines: s.outputBuffer, fromSnapshot: false };
  }
  return { lines: s.lastFinishedRunOutput, fromSnapshot: s.lastFinishedRunOutput.length > 0 };
}

// ─── per-project 会话守卫总纲 helpers(设计 §4.3)────────────────────────────

/** 谓词(与 process-state isAliveStatus 同集):starting/running/stopping 算在跑。 */
const isAliveStatus = (st: string) => st === 'starting' || st === 'running' || st === 'stopping';

/** 活跃桶 key:活跃指针(ctx.projectDir)非空时归一化,否则 ''(惰性兼容桶)。 */
function activeProjectKeyOf(ctx: ToolContext): string {
  return ctx.projectDir ? normalizeProjectKey(ctx.projectDir) : '';
}

// I-1(设计 §4.5):profiler 属主弱关联——ctx.functionProfiler 保留最近一次
// profiling 会话且不被无关 run 销毁;属主 key 与销毁点(新 run 的预清理段 +
// close handler 清理段)比对后才允许 close。
let profilerOwnerKey: string | undefined;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'runtime',
      description: '启动编辑器、运行/停止项目、获取调试输出、运行测试、获取 Godot 版本。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['launch_editor', 'run_project', 'stop_project', 'get_debug_output', 'run_tests', 'get_godot_version', 'record_start', 'record_stop', 'record_save', 'record_load', 'record_play'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）。多项目并行:run_project 按项目分桶(同项目重跑互杀旧进程,跨项目并存互不杀);stop_project/get_debug_output 缺省操作最近 run 的项目,传本参数可指定其他项目的会话桶' },
          timeout: { type: 'number', description: '自动停止秒数（默认 30。0 或负数 = 不自动停，由 stop_project 手动控制——bridge 交互会话逐步 game_write/game_query 驱动时推荐 0，总时长超冷启动不会被到点静默 kill；游戏冷启动 >30s 的项目传更大值如 120；wait_for_bridge 时正数自动取 max(bridge_timeout+10, timeout) 防与 bridge 就绪 race，0/-1 优先短路不抬升）', default: 30 },
          wait_for_bridge: { type: 'boolean', default: false, description: 'true 时 spawn 后轮询 bridge 就绪(默认 false,向后兼容)' },
          profiling: { type: 'boolean', default: false, description: 'true 时 spawn 前绑 debugger 端口并传 --remote-debug(函数级 profiling 前置;之后用 profiler 工具 action=capture_functions 采样;仅 spawn 模式,attach/已运行会话无 debugger 通道)' },
          bridge_timeout: { type: 'number', default: 10, description: 'wait_for_bridge 轮询总预算(秒,默认 10)' },
          preview: { type: 'boolean', default: false, description: '预览模式:禁用自动停止,游戏窗口常驻,用户关闭窗口即结束验证。适用于 AI 改完代码/场景后的人工视觉验证(替代打开编辑器)。默认不与 wait_for_bridge 组合(bridge 未就绪会终止游戏,见规则说明)' },
          test_script: { type: 'string', description: '测试脚本或目录路径（默认 res://test/）', default: 'res://test/' },
          quit_flag: { type: 'string', enum: ['gquit', 'gexit'], default: 'gquit', description: 'run_tests 的 GUT 退出标志。默认 gquit(GUT ≤9.5);GUT 9.6+ 移除 -gquit(报 Unknown arguments: -gquit)时切 gexit' },
          // ── Recording parameters (merged, v0.18.0) ──
          events_json: { type: 'string', description: '录制：JSON 格式的事件序列字符串' },
          file_name: { type: 'string', description: '录制保存:始终自动命名 recording_YYYYMMDD_HHmmss.json(file_name 入参被忽略);但 file_name 须匹配 recording_*.json 格式(否则 INVALID_FILE_NAME),禁止含 / \\\\ ..' },
          speed: { type: 'number', description: '录制：回放速度倍率（默认 1.0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// computeRunTimeout:run_project 的 auto-stop timeout 计算(提取为纯函数便于测试)。
// wait_for_bridge 时 timeout 至少 bridge_timeout + 10,防 auto-stop 与 bridge 就绪 race
// (修复前默认 timeout=30 与 bridge_timeout=30 同量级,游戏在 bridge 就绪前被 auto-stop kill)。
// 反馈批次D (2026-09-17, fr2 2026-09-02 反馈): 显式 0/-1 = 不自动停——bridge 交互会话
// (每步 game_write/game_query 慢慢驱动,大图装载单步 10s+)总时长天然超冷启动时长,
// 到点静默 kill 游戏呈 BRIDGE_NOT_CONNECTED 假象(排障 8 分钟);交 stop_project 手动控制。
export function computeRunTimeout(rawTimeout: unknown, bridgeTimeout: number, waitForBridge: boolean): number {
  const raw = Number(rawTimeout);
  // 显式 <=0 (0/-1) 归一为 0 = 不设 auto-stop timer(消费方 `timeout > 0` 守卫已就位);
  // undefined/NaN/空串/null 不算显式(未传参防误伤,仍走默认 30)。
  if (rawTimeout != null && rawTimeout !== '' && Number.isFinite(raw) && raw <= 0) {
    return 0;
  }
  const base = Math.max(5, raw || 30);
  return waitForBridge ? Math.max(bridgeTimeout + 10, base) : base;
}

/** run_project 核心链(Web GUI 项目面板 spec §6:工具与面板双消费)。
 *  行为零变:case 体逐字搬入;含 requireProjectPath(第二层白名单防线,PathError 由调用方转 403)。
 *  依赖面:ctx.findGodot/ctx.setProjectDir(真实活跃指针)/ctx.functionProfiler(可选);
 *  模块级 profilerOwnerKey 同文件共享(I-1 属主弱关联)。 */
export async function executeRunProject(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  const p = requireProjectPath(args);
  if (!existsSync(join(p, 'project.godot'))) {
    return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
  }
  const waitForBridge = args.wait_for_bridge === true;
  const bridgeTimeout = Math.max(1, Number(args.bridge_timeout) || 10);
  const timeout = computeRunTimeout(args.timeout, bridgeTimeout, waitForBridge);
  // 反馈批次D: timeout=0/-1 时响应文本明示「不自动停」,不再显示误导性的 "timeout: 0s"
  const timeoutNote = timeout > 0 ? `timeout: ${timeout}s` : 'no auto-stop (timeout=0/-1; stop via stop_project)';
  const preview = args.preview === true;
  const godot = await ctx.findGodot();

  // Version mismatch warning
  const versionWarning = await checkVersionMismatch(p, godot);
  const warnPrefix = versionWarning ? versionWarning + '\n' : '';

  // ── 守卫总纲(设计 §4.3,坑 1/4/5/6 + C-1 统一解法)───────────────────
  // 本次执行的全部状态读写——同步主流程与异步回调——都只认闭包级 sessionKey,
  // 不读活跃指针;活跃指针仅服务"缺省参数的工具调用"层的一次 setProjectDir 切换。
  const sessionKey = normalizeProjectKey(p);

  // 运行中进程上限(设计 §4.1:同项目覆盖豁免——ensureSessionCapacity 内部处理;
  // 溢出拒绝并列出在跑会话,不自动逐出)
  try {
    ensureSessionCapacity(p);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`);
  }

  // Stop existing:只杀 X 桶旧进程(设计 §4.3)——活跃是 A 时 run_project(B)
  // 只杀 B 桶旧进程,A 不动(单项目场景 X=活跃,语义与改造前一致)。
  const existingProc = getRunSessionProc(p);
  if (existingProc) {
    markSessionStopping(p);
    releaseRunSessionBusy(p);
    await killProcess(existingProc);
    clearRunSession(p);
  }

  // Atomically acquire the process slot after clearing any existing process
  // (显式传 p 锁目标桶——acquire 先于 setProjectDir,按活跃桶锁会锁错桶,设计 §4.2)
  if (!await acquireProcessSlot('run_project', p)) {
    return textResult(buildBusyErrorMessage(sessionKey));
  }

  ctx.setProjectDir(p);   // 活跃指针切换(唯一切换点)
  clearOutputBuffer(sessionKey);
  // processStartTime 由 setRunSessionProc 写入桶(设计 §4.3)

  // P2 (2026-09-11) 函数级 profiling:spawn 前绑端口(顺序关键——引擎启动后回拨),
  // --remote-debug 必须在命令行上,attach/已运行会话无此通道。实例挂 ctx(长寿命,
  // 进程 close 时清理),profiler 工具 capture_functions 从 ctx 读。
  // I-1(设计 §4.5):仅当现有 profiler 的属主 key === 本次 key 才关闭——
  // A(profiling)运行中 run B 不得销毁 A 的 profiler(单选跟随 ≠ 可被非属主销毁)。
  const profiling = args.profiling === true;
  if (ctx.functionProfiler && profilerOwnerKey === sessionKey) {
    ctx.functionProfiler.close();
    ctx.functionProfiler = undefined;
  }
  let proc: ChildProcess;
  if (profiling) {
    try {
      const profiler = await DebuggerProfiler.create();
      ctx.functionProfiler = profiler;
      profilerOwnerKey = sessionKey;   // 属主弱关联(I-1)
      const dbgArgs = ['--path', p, '--debug', '--remote-debug', `tcp://127.0.0.1:${profiler.port}`];
      proc = spawn(godot, dbgArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv(),
      });
    } catch (err) {
      releaseRunSessionBusy(sessionKey);   // C-1:按 key 释放(不落活跃桶)
      if (profilerOwnerKey === sessionKey) {
        ctx.functionProfiler?.close();  // N-1(审查): spawn 同步抛异常时释放已绑端口
        ctx.functionProfiler = undefined;
      }
      setSessionStatus(sessionKey, 'errored');
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`Error: failed to bind profiler debugger port: ${msg}`);
    }
  } else {
  // P1.1: spawn() 同步抛异常时,'error' handler 尚未注册 → 必须主动释放槽,
  // 否则 acquireProcessSlot 获取的 busy 槽永久泄漏,后续 run_project 永远 busy。
  // C-1:按 key 释放 + 桶终态 errored;:219 的 ctx.setRunningProcess(null) 已删除
  // (proc 从未 setRunSessionProc,X 桶无需清——设计 §4.3 点名)。
  try {
    proc = spawn(godot, ['--path', p, '--debug'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });
  } catch (err) {
    releaseRunSessionBusy(sessionKey);
    setSessionStatus(sessionKey, 'errored');
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput([`Spawn error: ${msg}`], sessionKey);
    return textResult(`Error: failed to spawn Godot: ${msg}`);
  }
  }
  // 坑 1(设计 §4.3):输出流 handler 闭包捕获 sessionKey——活跃指针切走后
  // A 的输出继续写 A 桶,不串桶。
  proc.stdout?.on('data', (data: Buffer) => {
    appendOutput(data.toString().split('\n'), sessionKey);
  });
  proc.stderr?.on('data', (data: Buffer) => {
    appendOutput(data.toString().split('\n'), sessionKey);
  });

  // Auto-stop after timeout(坑 5:守卫判断按 key)
  let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeout > 0 && !preview) {
    autoStopTimer = setTimeout(() => {
      if (getRunSessionProc(sessionKey) === proc) {
        releaseRunSessionBusy(sessionKey);
        markSessionStopping(p);
        void killProcess(proc);
        clearRunSession(sessionKey);
      }
      if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外：该 proc 退出即移除自身 pid
    }, timeout * 1000);
  }

  proc.on('close', (code) => {
    // P2 + I-1: profiling 进程退出 → 关 debugger listener(捕获结果已可读,
    // close 只释放 socket)——属主守卫:仅清本桶属主的 profiler。
    if (ctx.functionProfiler && profilerOwnerKey === sessionKey) {
      ctx.functionProfiler.close();
      ctx.functionProfiler = undefined;
    }
    // Imp-4 (2026-06-24 审查): 守卫同 autoStopTimer,按桶内 proc 身份比对,
    // 避免进程被替换后误清新进程的桶状态(坑 4:判断与体内动作都按 sessionKey)
    if (getRunSessionProc(sessionKey) === proc) {
      markSessionExited(p, code);   // exited_early/errored/exited 判定(设计 §4.1)
      clearRunSession(sessionKey);  // 快照挪移 + busy 释放,桶保留可查
    }
    if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外（ADVISORY-3）：旧 proc 被替换时守卫 false 但仍需移除
    if (autoStopTimer) clearTimeout(autoStopTimer);
  });

  proc.on('error', (err) => {
    // Imp-4: 同上守卫(坑 4)
    if (getRunSessionProc(sessionKey) === proc) {
      setSessionStatus(sessionKey, 'errored');
      clearRunSession(sessionKey);
    }
    if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外
    if (autoStopTimer) clearTimeout(autoStopTimer);
    appendOutput([`Spawn error: ${err.message}`], sessionKey);   // 坑 1(:268 error 路径):错误行写本桶
  });

  // C-1 核心:按 key 写入 proc(禁用 ctx.setRunningProcess——其 forceKillTree
  // 对"活跃桶旧 proc"生效,并发+活跃切换下杀错窗;setRunSessionProc 仅杀本桶旧 proc)。
  // 传原始 p(内部 normalize 到同 key):setRunSessionProc 顺带把桶 displayPath
  // 刷新为原始写法,供上限/会话清单显示(设计 §4.1 displayPath)。
  setRunSessionProc(p, proc, true); // skip busy check — slot acquired via acquireProcessSlot above
  if (proc.pid) registerSpawnedGodotPid(proc.pid, sessionKey);   // 归属化(设计 §4.4)

  // 多项目提示(设计 §4.3):成功消息附当前在跑会话数(N>1 时)
  const running = listRunSessions().filter(x => isAliveStatus(x.status)).length;
  const sessionNote = running > 1 ? ` (${running} sessions running)` : '';

  if (waitForBridge) {
    // M3: 显式命名 ms(isBridgeReady 接收 ms;bridgeTimeout 是秒)
    const bridgeTimeoutMs = bridgeTimeout * 1000;
    const r = await isBridgeReady(p, bridgeTimeoutMs, {
      proc,
      isCancelled: () => getRunSessionProc(sessionKey) !== proc,   // 坑 6:按 key
    });
    if (!r.ready) {
      // 问题 2 修复:bridge 未就绪 → isError(此前 textResult isError:false 误报,
      // 到 game_query ping 才暴露 BRIDGE_NOT_CONNECTED)。清理进程(游戏无 bridge 无用)。
      if (getRunSessionProc(sessionKey) === proc) {
        markSessionStopping(p);
        releaseRunSessionBusy(sessionKey);
        void killProcess(proc);
        clearRunSession(sessionKey);
      }
      return errorResult(`${warnPrefix}Bridge not ready (${r.reason}). Game stopped. ${timeoutNote}, bridge_timeout=${bridgeTimeout}s. 确认已 game_bridge_install 且游戏运行.`);
    }
    // P1-6 关联修复(2026-08-21 七维度审核): "Bridge ready." 是 bridge-session.ts /
    // qa/runner.ts 的 load-bearing 判据(子串匹配),仅在真的探测过 isBridgeReady 后
    // 才宣称——此前 wait_for_bridge=false(默认)时也无条件假宣称,误导直接调工具的 AI。
    if (preview) {
      return textResult(warnPrefix + 'Preview mode: bridge ready, game window open at ' + p + ', no auto-stop. It stays open until the user closes the window. After the user closes it, call get_debug_output to check for runtime errors.' + sessionNote);
    }
    return textResult(warnPrefix + 'Bridge ready. ' + `Running project at ${p} (${timeoutNote}). Use get_debug_output or stop_project to check.` + sessionNote);
  }
  if (preview) {
    return textResult(warnPrefix + 'Preview mode: game window is now open at ' + p + '. It stays open until the user closes the window (no auto-stop). After the user closes it, call get_debug_output to check for runtime errors.' + sessionNote);
  }
  return textResult(warnPrefix + `Running project at ${p} (${timeoutNote}; bridge not probed — wait_for_bridge=false). Use game_query(method="ping") to check bridge, or get_debug_output / stop_project.` + sessionNote);
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'runtime') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  switch (action) {
    case 'launch_editor': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const godot = await ctx.findGodot();
      const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore', env: buildSafeEnv() });
      child.on('error', (err) => {
        getLogger().error('runtime', `Failed to launch editor: ${err.message}`);
      });
      child.unref();
      return textResult(`Launched Godot editor for project: ${p}`);
    }

    case 'run_project':
      return executeRunProject(args, ctx);

    case 'stop_project': {
      // 多项目(设计 §4.3):缺省=活跃桶;指定 project_path=X=杀 X 桶活进程并返回其输出
      const rawStopPath = args.project_path;
      const stopTargetKey = (typeof rawStopPath === 'string' && rawStopPath.length > 0)
        ? normalizeProjectKey(rawStopPath)
        : activeProjectKeyOf(ctx);
      const targetProc = getRunSessionProc(stopTargetKey);
      if (!targetProc) {
        // V-01 second layer: scan for orphaned Godot processes
        // orphan 分支按 args.project_path ?? ctx.projectDir(现状语义,X 的 key 对照注册表归属)
        const projectDir = (typeof rawStopPath === 'string' && rawStopPath.length > 0 ? rawStopPath : '') || ctx.projectDir || '';
        const orphanKilled = await killOrphanGodotProcesses(projectDir);
        if (orphanKilled > 0) {
          return textResult(`Cleaned up ${orphanKilled} orphaned Godot process(es) from this session.`);
        }
        // 多项目提示(Task 4 审查 Minor 修正):显式传了 project_path 时目标已明确,不再
        // 引导再传参;未传参(目标=活跃桶)保持引导句式,首句消除"无项目在跑"与"会话在跑"矛盾。
        const alive = listRunSessions().filter(x => isAliveStatus(x.status));
        if (alive.length > 0) {
          const aliveList = alive.map(x => x.displayPath).join(', ');
          const explicitStop = typeof rawStopPath === 'string' && rawStopPath.length > 0;
          return textResult(explicitStop
            ? `Project ${rawStopPath} has no running process. Other sessions: ${aliveList}.`
            : `Active project has no running process. Sessions still running: ${aliveList}. Pass project_path to target one.`);
        }
        return textResult('No project is currently running.');
      }
      markSessionStopping(stopTargetKey);
      await killProcess(targetProc);
      releaseRunSessionBusy(stopTargetKey);

      // per-key 读数(设计 §4.3 M-3):source/runtime/total_lines 来自目标桶 session
      const s = getSession(stopTargetKey);
      const { lines: stopLines, fromSnapshot: stopFromSnapshot } = resolveReadableOutputFor(s);
      const classified = classifyOutput(stopLines);
      // I-10: Guard against processStartTime=0 producing absurd runtime values
      const runtimeMs = s && s.processStartTime > 0 ? Date.now() - s.processStartTime : 0;
      const result = {
        status: 'stopped',
        source: stopFromSnapshot ? 'last_finished_run' : 'current_run',
        runtime: `${(runtimeMs / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: stopLines.length,
      };
      clearRunSession(stopTargetKey);   // 快照挪移 + busy/proc 清理(桶保留可查)
      return textResult(maybeWrapUntrusted('runtime.stop_output', 'godot-process', JSON.stringify(result, null, 2)))
    }

    case 'get_debug_output': {
      // 多项目(设计 §4.3):缺省=活跃桶;指定 project_path=X=X 桶当前输出或快照
      const rawDebugPath = args.project_path;
      const debugTargetKey = (typeof rawDebugPath === 'string' && rawDebugPath.length > 0)
        ? normalizeProjectKey(rawDebugPath)
        : activeProjectKeyOf(ctx);
      const s = getSession(debugTargetKey);
      if (!s || (s.outputBuffer.length === 0 && !s.proc && s.lastFinishedRunOutput.length === 0)) {
        // 逐出桶/未知项目返回明确错误(设计 §4.1:不静默回落活跃桶)
        const note = (!s && typeof rawDebugPath === 'string' && rawDebugPath.length > 0)
          ? ` (session evicted or unknown project: ${rawDebugPath})`
          : '';
        return textResult(`No debug output available. Run a project first.${note}`);
      }
      const { lines, fromSnapshot } = resolveReadableOutputFor(s);
      const classified = classifyOutput(lines);
      // per-key 读数(设计 §4.3 M-3)
      const debugRuntimeMs = s.processStartTime > 0 ? Date.now() - s.processStartTime : 0;
      const result = {
        running: s.proc !== null,
        runtime: `${(debugRuntimeMs / 1000).toFixed(1)}s`,
        source: fromSnapshot ? 'last_finished_run' : 'current_run',
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: lines.length,
      };
      // P1-1: 引擎/游戏输出 nonce 信封(prints/errors/warnings 含项目 print 任意文本,输出侧防注入)
      return textResult(maybeWrapUntrusted('runtime.debug_output', 'godot-process', JSON.stringify(result, null, 2)));
    }

    case 'run_tests': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      const rawTestScript = (args.test_script as string) || 'res://test/';
      // I-SEC-08: Validate test_script starts with res:// to prevent filesystem traversal
      if (!rawTestScript.startsWith('res://')) {
        releaseShortRunningSlot();
        return textResult(`Error: test_script must start with "res://", got: "${rawTestScript}"`);
      }
      const testScript = rawTestScript;
      const godot = await ctx.findGodot();
      // A4 (2026-07-04 反馈): GUT 退出标志参数化。默认 -gquit(GUT ≤9.5 惯例,GUT 9.6+ 移除);
      // 白名单二选一,非法值回落 gquit(值只拼进 spawn args 数组,无注入面,白名单是行为兜底)。
      const quitFlag = args.quit_flag === 'gexit' ? 'gexit' : 'gquit';

      return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', 'addons/gut/gut_cmdln.gd',
          '-gdir', testScript,
          `-${quitFlag}`,
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
        // P1-1: 注册到 _spawnedGodotPids，close/崩溃可清理 in-flight run_tests spawn。
        // 原 only-run_project 注册（runtime.ts:224）致 close() 清不到 run_tests 进程 +
        // 非 detached 非 unref 阻止 Node 退出最多 120s。对齐 gdscript-executor.ts:1198-1199。
        // 系 07-29 P1-② gdscript-executor spawn orphan 修复的遗漏分支。
        if (proc.pid) registerSpawnedGodotPid(proc.pid);
        const unregisterSpawn = () => { if (proc.pid) unregisterSpawnedGodotPid(proc.pid); };

        let out = '';
        const MAX_OUTPUT = 500_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            unregisterSpawn();  // P1-1: timeout 强杀后注销（exit 事件可能不触发）
            releaseShortRunningSlot();
            resolve(textResult('run_tests timed out after 120s'));
          }
        }, 120000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          unregisterSpawn();  // P1-1: 正常 close 注销 PID
          releaseShortRunningSlot();
          const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
          const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
          // I-11: Truncate raw_output to prevent excessive MCP channel bandwidth
          const MAX_RAW_OUTPUT = 50_000;
          const rawOutput = out.length > MAX_RAW_OUTPUT
            ? out.slice(0, MAX_RAW_OUTPUT) + `\n... [truncated, ${out.length} total bytes]`
            : out;
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                exit_code: code,
                passed: passed.join(', '),
                failed: failed.join(', '),
                raw_output: rawOutput,
              }, null, 2),
            }],
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          unregisterSpawn();  // P1-1: spawn 错误（ENOENT 等）注销 PID
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        });
      });
    }

    case 'get_godot_version': {
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const godot = await ctx.findGodot();
        const v = await detectGodotVersion(godot);
        return textResult(v);
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      } finally {
        releaseShortRunningSlot();
      }
    }

    // ── Recording actions (merged from recording.ts, v0.18.0) ──
    case 'record_start':
    case 'record_stop':
    case 'record_save':
    case 'record_load':
    case 'record_play': {
      return handleRecordingAction(action, args, ctx);
    }

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  runtime: {
    readonly: false,
    long_running: true,
    actionRisks: {
      get_debug_output: 'read',
      get_godot_version: 'read',
      record_load: 'read',
      launch_editor: 'process',
      run_project: 'process',
      stop_project: 'process',
      run_tests: 'process',
      record_start: 'write',
      record_stop: 'write',
      record_save: 'write',
      record_play: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
