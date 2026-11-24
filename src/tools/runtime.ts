import { spawn, type ChildProcess } from 'child_process';
import { DebuggerProfiler } from '../core/function-profiler.js';
import { opsErrorResult } from './shared.js';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { maybeWrapUntrusted } from '../core/untrusted-wrap.js';
import { textResult, errorResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses, registerSpawnedGodotPid, unregisterSpawnedGodotPid, normalizeProjectKey, ensureSessionCapacity, getRunSessionProc, setRunSessionProc, releaseRunSessionBusy, clearRunSession, markSessionStopping, markSessionExited, setSessionStatus, listRunSessions, getSession, isPidAlive } from '../core/process-state.js';
import { cleanDeadInstanceSecrets } from '../core/bridge-client.js';
import type { RunSession } from '../core/process-state.js';
import { requireProjectPath } from '../core/args-validation.js';
import { checkVersionMismatch, buildSafeEnv } from '../core/godot-finder.js';
import { isBridgeReady } from './game-bridge.js';
import { detectGodotVersion } from '../core/godot-finder.js';
import { handleRecordingAction } from './recording.js';
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/tool-registry.js';
// 内存治理一期 Task 4:spawn 漏斗准入(game_window/editor 档)——run_project 与 launch_editor
import { acquireLease, bindLeasePid, releaseLease, projectPathFromArgs, type SpawnKind } from '../core/memory-guard.js';
// 内存治理一期 Task 5:看门狗杀归因——runGutProcess/run_project close 命中 wasMemKilled
// 时优先报 MEM_BUDGET_EXCEEDED(单片 denial 同通道;会话行进 errors 分类可见)
import { wasMemKilled, formatMemKillMessage } from '../core/mem-watchdog.js';

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

// 内存治理一期 Task 4:game_window 租约登记(sessionKey → leaseId)。停旧段凭它
// 主动归还被停会话的租约(不等 close 事件兜底——新一轮 acquire 前旧租约就该出预算);
// close/error 释放走闭包 leaseId(条件删除防旧回调误删新一轮条目)。
const gameWindowLeases = new Map<string, string>();

// 内存治理一期 Task 5:看门狗杀归因行(sessionKey → 归因报文)。run_project close 命中
// wasMemKilled 时记录,供杀后的 get_debug_output/stop 附结构化 mem_budget_exceeded 字段
// (归因行同时 appendOutput 进快照,errors 分类可见);新一轮 run 重置。归因源头
// (wasMemKilled)自带 10min TTL,本 Map 单进程生命周期、重跑覆盖,无泄漏面。
const recentMemKills = new Map<string, string>();

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'runtime',
      description: '启动编辑器、运行/停止项目、取调试输出、跑测试、查 Godot 版本、录制回放。run_project: timeout 0/-1=不自动停(手动 stop_project), wait_for_bridge=轮询等 bridge 就绪, preview=窗口常驻, profiling=绑调试端口。需 GODOT_PATH(或项目级 .godot/mcp-godot.json)。详见 help 工具。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['launch_editor', 'run_project', 'stop_project', 'get_debug_output', 'run_tests', 'get_godot_version', 'record_start', 'record_stop', 'record_save', 'record_load', 'record_play'],
            description: '操作类型。launch_editor=开编辑器, run_project/stop_project=运行/停止游戏, get_debug_output=取调试输出, run_tests=跑测试, get_godot_version=查版本, record_*=录制回放(start/stop/save/load/play)',
          },
          project_path: { type: 'string', description: '项目目录（默认 GODOT_PROJECT_PATH 或当前目录）。多项目并行按项目分桶(同项目重跑互杀,跨项目并存);stop_project/get_debug_output 缺省操作最近 run 的项目,传本参数可指定其他会话桶' },
          timeout: { type: 'number', description: 'run_project: 自动停止秒数(默认 30;0/-1=不自动停,由 stop_project 手动控——bridge 逐步交互会话推荐 0,冷启动>30s 的项目传更大值如 120;wait_for_bridge 时正数自动取 max(bridge_timeout+10, timeout) 防 race)。run_tests: 单次 GUT 进程超时秒数(默认 120,分片时 per-shard 计时)', default: 30 },
          wait_for_bridge: { type: 'boolean', default: false, description: 'true 时 spawn 后轮询 bridge 就绪(默认 false,向后兼容)' },
          profiling: { type: 'boolean', default: false, description: 'true 时 spawn 前绑 debugger 端口并传 --remote-debug(函数级 profiling 前置,之后用 profiler capture_functions 采样;仅 spawn 模式,attach/已运行会话无 debugger 通道)' },
          bridge_timeout: { type: 'number', default: 10, description: 'wait_for_bridge 轮询总预算(秒,默认 10)' },
          preview: { type: 'boolean', default: false, description: '预览模式:禁用自动停止,游戏窗口常驻,用户关窗即结束(AI 改完代码/场景后的人工视觉验证);默认不与 wait_for_bridge 组合(bridge 未就绪会终止游戏,见规则)' },
          test_script: { type: 'string', description: '测试脚本或目录路径（默认 res://test/）', default: 'res://test/' },
          quit_flag: { type: 'string', enum: ['gquit', 'gexit'], default: 'gquit', description: 'run_tests 的 GUT 退出标志。默认 gquit(GUT ≤9.5);GUT 9.6+ 移除 -gquit(报 Unknown arguments: -gquit)时切 gexit' },
          shards: { type: 'integer', default: 1, description: 'run_tests 分片数(默认 1=单进程现有行为)。>1 时:TS 侧枚举 test_script 目录下 *.gd(递归,排除 addons/ 段与 _ 前缀),蛇形均衡分 N 片,逐片生成临时 gutconfig 经 -gconfig= 显式覆盖项目 .gutconfig.json(防 dirs 附加合并),串行执行,失败/超时片不中断,汇总各片 Tests/Failed。大测试集防单进程 OOM(2026-11-12 反馈:单进程全量跑 22.5GB 死机)。GODOT_TEST_MODE env 透传到子进程(调用方 shell 设了才传)' },
          // ── Recording parameters (merged, v0.18.0) ──
          events_json: { type: 'string', description: '录制：JSON 格式的事件序列字符串' },
          file_name: { type: 'string', description: '录制保存:始终自动命名 recording_YYYYMMDD_HHmmss.json(file_name 入参被忽略);但 file_name 须匹配 recording_*.json 格式(否则 INVALID_FILE_NAME),禁止含 / \\\\ ..' },
          speed: { type: 'number', description: '录制：回放速度倍率（默认 1.0）' },
          load_autoloads: { type: 'boolean', description: '加载 Autoload（默认 true）' },
          godot_path: { type: 'string', description: 'Godot 路径覆盖（可选，优先于配置/env）' },
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
  // 反馈批 20261122 Task 4:本次 run 真的发信号去杀的旧实例才记 pid,响应尾部附注(此前
  // 「先停旧」完全静默,用户无从知道哪个窗口被换掉;见下方 killedNote)。桶里有 proc ≠ 进程
  // 还活着:close 事件送达前(用户刚关窗、stop_project 的 kill 在途、exit 已到而 close 被残留
  // stdio 句柄拖住)旧 proc 仍在桶里,但 killProcess 对已 killed / 已退出的进程直接 resolve
  // 不发信号——那种情况本次 run 什么都没杀,记成被杀会把用户自己关掉的窗口归因给 MCP。
  const killedPreviousPids: number[] = [];
  const existingProc = getRunSessionProc(p);
  if (existingProc) {
    // 与 killProcess 的早退同款判据(严格 === null:活进程的 exitCode 恒为 null)
    const willSignal = !existingProc.killed && existingProc.exitCode === null;
    if (existingProc.pid && willSignal) killedPreviousPids.push(existingProc.pid);
    markSessionStopping(p);
    releaseRunSessionBusy(p);
    await killProcess(existingProc);
    clearRunSession(p);
  }
  // 被杀尾注(终审 M-3):紧跟停旧段算好,供下方**全部**出口共用——四条成功响应(经 sessionNote)
  // 与杀旧之后的五个失败出口(槽位 busy / 内存守卫拒绝 / profiler 端口绑定失败 / spawn 同步抛 /
  // bridge 未就绪)。旧窗口已被本次调用杀掉时,失败响应同样必须说出来(否则就是 11-22「窗口
  // 消失」反馈的形态:窗口没了,错误里却没提)。没杀旧实例时为空串,拼接后文案零变化;只追加
  // 在响应最尾部,`Error:` 前缀与 isError 判定不受影响。
  const killedNote = killedPreviousPids.length > 0
    ? ` (killed previous instance pid: ${killedPreviousPids.join(',')})`
    : '';

  // 内存治理 Task 4:被停会话的 game_window 租约立即归还(不等旧进程 close 事件——
  // kill 后 close 可能延迟,旧租约挂账会让下方 acquireLease 被自家历史占预算)。
  {
    const oldLeaseId = gameWindowLeases.get(sessionKey);
    if (oldLeaseId !== undefined) {
      releaseLease(oldLeaseId);
      gameWindowLeases.delete(sessionKey);
    }
  }

  // 内存治理 Task 5:新会话开始,旧会话的杀归因不再挂账(防新一轮 get_debug_output
  // 误报上一轮的 MEM_BUDGET_EXCEEDED)。
  recentMemKills.delete(sessionKey);

  // Atomically acquire the process slot after clearing any existing process
  // (显式传 p 锁目标桶——acquire 先于 setProjectDir,按活跃桶锁会锁错桶,设计 §4.2)
  if (!await acquireProcessSlot('run_project', p)) {
    return textResult(buildBusyErrorMessage(sessionKey) + killedNote);
  }

  // 内存治理 Task 4:spawn 前准入(game_window 档,3GB)。拒则不 spawn,释放 busy 槽
  // 后透传 denial(Bazel 报文自含占用清单与建议)。preview 本期不特判(Review Focus 6)。
  const admit = acquireLease('game_window', p);
  if ('denial' in admit) {
    releaseRunSessionBusy(sessionKey);
    setSessionStatus(sessionKey, 'errored');
    return opsErrorResult(admit.denial.code, admit.denial.message + killedNote);
  }
  const gameLeaseId = admit.lease.id;
  gameWindowLeases.set(sessionKey, gameLeaseId);
  /** 释放本次租约 + 条件删登记(旧回调不得误删新一轮条目;releaseLease 幂等)。 */
  const releaseGameLease = () => {
    releaseLease(gameLeaseId);
    if (gameWindowLeases.get(sessionKey) === gameLeaseId) gameWindowLeases.delete(sessionKey);
  };

  ctx.setProjectDir(p);   // 活跃指针切换(唯一切换点)
  clearOutputBuffer(sessionKey);
  // processStartTime 由 setRunSessionProc 写入桶(设计 §4.3)

  // P2 (2026-09-11) 函数级 profiling:spawn 前绑端口(顺序关键——引擎启动后回拨),
  // --remote-debug 必须在命令行上,attach/已运行会话无此通道。实例挂 ctx(长寿命,
  // 进程 close 时清理),profiler 工具 capture_functions 从 ctx 读。
  // I-1(设计 §4.5):仅当现有 profiler 的属主 key === 本次 key 才关闭——
  // A(profiling)运行中 run B 不得销毁 A 的 profiler(单选跟随 ≠ 可被非属主销毁)。
  // 反馈批 20261122 Task 4(实例归属):spawn 注入 GODOT_MCP_BRIDGE_OWNER_PID = 本 server pid。
  // GODOT_MCP_BRIDGE_ 前缀本就是 buildSafeEnv 的透传域(该函数不改),在下面两个 spawn 点
  // 显式叠加,且置于展开之后(本 server 进程自身若带着上游注入的同名 env,以本进程 pid
  // 为准)。GD 侧 _owner_pid() 读它写进 registry 心跳与 ping 响应(ownerPid),TS 侧
  // resolveBridgePort 偏好本 server 起的实例、annotatePingOwner 对他人实例告警——多会话
  // 并行时不再被「最新心跳胜出」吸到别的会话起的游戏。手动起的游戏无此 env,行为不变。
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
        env: { ...buildSafeEnv(), GODOT_MCP_BRIDGE_OWNER_PID: String(process.pid) },
      });
    } catch (err) {
      releaseRunSessionBusy(sessionKey);   // C-1:按 key 释放(不落活跃桶)
      if (profilerOwnerKey === sessionKey) {
        ctx.functionProfiler?.close();  // N-1(审查): spawn 同步抛异常时释放已绑端口
        ctx.functionProfiler = undefined;
      }
      setSessionStatus(sessionKey, 'errored');
      releaseGameLease();   // Task 4: spawn 未成,租约无 close 兜底,主动归还
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`Error: failed to bind profiler debugger port: ${msg}` + killedNote);
    }
  } else {
  // P1.1: spawn() 同步抛异常时,'error' handler 尚未注册 → 必须主动释放槽,
  // 否则 acquireProcessSlot 获取的 busy 槽永久泄漏,后续 run_project 永远 busy。
  // C-1:按 key 释放 + 桶终态 errored;:219 的 ctx.setRunningProcess(null) 已删除
  // (proc 从未 setRunSessionProc,X 桶无需清——设计 §4.3 点名)。
  try {
    proc = spawn(godot, ['--path', p, '--debug'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildSafeEnv(), GODOT_MCP_BRIDGE_OWNER_PID: String(process.pid) },
    });
  } catch (err) {
    releaseRunSessionBusy(sessionKey);
    setSessionStatus(sessionKey, 'errored');
    releaseGameLease();   // Task 4: spawn 未成,租约无 close 兜底,主动归还
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput([`Spawn error: ${msg}`], sessionKey);
    return textResult(`Error: failed to spawn Godot: ${msg}` + killedNote);
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
    // Task 4:进程退出归还租约(守卫外——无论 proc 是否仍是桶内活跃,它退出即释放
    // 自己的租约;条件删防旧回调误删新一轮条目,releaseLease 幂等可重复)。
    releaseGameLease();
    // P2 + I-1: profiling 进程退出 → 关 debugger listener(捕获结果已可读,
    // close 只释放 socket)——属主守卫:仅清本桶属主的 profiler。
    if (ctx.functionProfiler && profilerOwnerKey === sessionKey) {
      ctx.functionProfiler.close();
      ctx.functionProfiler = undefined;
    }
    // Imp-4 (2026-06-24 审查): 守卫同 autoStopTimer,按桶内 proc 身份比对,
    // 避免进程被替换后误清新进程的桶状态(坑 4:判断与体内动作都按 sessionKey)
    if (getRunSessionProc(sessionKey) === proc) {
      // 内存治理 Task 5:看门狗杀归因——命中则在快照挪移前进桶(随 clearRunSession 持久
      // 到 lastFinishedRunOutput,杀后 get_debug_output/stop 的 errors 分类可见),并记
      // recentMemKills 供两路径附结构化 mem_budget_exceeded 字段。
      if (proc.pid) {
        const memKill = wasMemKilled(proc.pid);
        if (memKill) {
          const msg = formatMemKillMessage(memKill);
          recentMemKills.set(sessionKey, msg);
          appendOutput([`ERROR: [MEM_BUDGET_EXCEEDED] ${msg}`], sessionKey);
        }
      }
      markSessionExited(p, code);   // exited_early/errored/exited 判定(设计 §4.1)
      clearRunSession(sessionKey);  // 快照挪移 + busy 释放,桶保留可查
    }
    if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外（ADVISORY-3）：旧 proc 被替换时守卫 false 但仍需移除
    if (autoStopTimer) clearTimeout(autoStopTimer);
    // B3(竞品综述落地批 2026-11-13): 游戏进程退出(崩溃/用户手杀窗口/正常退出)时补
    // best-effort 死实例 secret 清理——覆盖"游戏死了但 server 活"窗口(stop_project 通道
    // 只在显式 stop 时清,游戏自然死亡不走它)。复用 B3 通道 cleanDeadInstanceSecrets
    // 判活护栏(只清 pid 已死者,活实例 secret 保留);try-catch 包裹,清理失败仅记
    // 日志不影响 close 收尾(fire-and-forget)。正常 stop 路径 stop_project 已清过一轮,
    // 此处幂等空跑无害。
    try {
      cleanDeadInstanceSecrets(p, undefined, isPidAlive);
    } catch (err) {
      getLogger().warn('runtime', `dead-instance secret cleanup after game exit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  proc.on('error', (err) => {
    releaseGameLease();   // Task 4: 异步 error 事件路径归还租约(与 close 双路幂等)
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
  // 内存治理二期 Task 1:preview 落桶(IdleTimer 空闲回收豁免判据;重跑同桶直接覆盖刷新)。
  {
    const sess = getSession(sessionKey);
    if (sess) sess.preview = preview;
  }
  if (proc.pid) {
    registerSpawnedGodotPid(proc.pid, sessionKey);   // 归属化(设计 §4.4)
    bindLeasePid(gameLeaseId, proc.pid);   // Task 4: 租约回填 pid(此后清理判定切 pid 探测)
  }

  // 多项目提示(设计 §4.3):成功消息附当前在跑会话数(N>1 时)
  const running = listRunSessions().filter(x => isAliveStatus(x.status)).length;
  // 反馈批 20261122 Task 4:被杀旧实例 pid 的尾注(killedNote 在停旧段之后算好)接在会话数提示
  // 之后——四条成功响应共用本 sessionNote,没杀过旧实例不追加(首跑文案零变化)。做成文本尾注
  // 而非结构化字段:四条响应是纯文本前缀契约(web 面板/QA runner 按前缀/子串匹配),新信息只能
  // 追加在尾部;杀旧之后的失败出口各自直接拼 killedNote(见上方各 return)。
  const sessionNote = (running > 1 ? ` (${running} sessions running)` : '') + killedNote;

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
      return errorResult(`${warnPrefix}Bridge not ready (${r.reason}). Game stopped. ${timeoutNote}, bridge_timeout=${bridgeTimeout}s. 确认已 game_bridge_install 且游戏运行.` + killedNote);
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

// ─── run_tests 加固(D6, 2026-11-12 反馈批次)──────────────────────────────────
// 反馈背景:① 2026-11-12 单进程全量跑 GUT 22.5GB 内存死机——大测试集需分片降峰值;
// ② 2026-09-19 GODOT_TEST_MODE 被 spawn 边界剥掉,游戏测试代码无从区分测试/生产存档
//   (直写真实存档的数据风险)——透传修在 buildSafeEnv(godot-finder.ts)。

/** 蛇形(round-robin)分片:文件排序后轮流发牌到 N 片,片间均衡(非连续切块——连续切块
 *  在按名字聚簇的测试集(同模块前缀)下片大小失衡)。导出供测试。 */
export function shardFiles(files: string[], shards: number): string[][] {
  const n = Math.max(1, Math.floor(shards));
  const sorted = [...files].sort();
  const buckets: string[][] = Array.from({ length: n }, () => []);
  sorted.forEach((f, i) => { const b = buckets[i % n]; if (b) b.push(f); });
  return buckets;
}

/** 递归枚举 test_script 目录下 *.gd(TS 侧磁盘枚举),返回 res:// 风格路径(排序)。
 *  排除:addons/ 目录段(GUT 自带测试不进用户分片)、_ 前缀 basename(GUT 惯例帮助脚本)、
 *  点开头(隐藏/.godot)、非 .gd。单 .gd 文件入参直接返回单元素列表。
 *  目录不存在/不可读返回 [](调用方按"无测试文件"报错,不静默空跑)。 */
export function enumerateTestScripts(projectDir: string, resScript: string): string[] {
  const rel = resScript.slice('res://'.length);
  if (rel.endsWith('.gd')) return [resScript];
  const rootRel = rel.replace(/\/+$/, '');
  const out: string[] = [];
  const walk = (diskDir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(diskDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      if (e.isDirectory()) {
        if (e.name === 'addons') continue;
        walk(join(diskDir, e.name), `${relDir}/${e.name}`);
      } else if (e.isFile() && e.name.endsWith('.gd')) {
        out.push(`res://${relDir}/${e.name}`);
      }
    }
  };
  walk(join(projectDir, rootRel), rootRel);
  return out.sort();
}

/** GUT 计数解析(双格式,D6 真机实证 2026-11-12 GUT 9.7.1):≤9.5 行式 "Tests: N"/
 *  "Failed: N";9.7 Totals 对齐空格式 "Tests<sp>N"/"Failing Tests<sp>N"(Failing 行
 *  非零才打印,缺行=0)。新格式行首锚定防误匹配 "Passing Tests";输出实含 ANSI 色码,
 *  解析前剥离。返回全部匹配的数字串(调用方按需 join 或求和)。 */
// eslint-disable-next-line no-control-regex -- 有意匹配 ANSI ESC 控制符:GUT 输出剥色码(D6),\x1b 是 ESC 本体,纯本地解析非注入面
const ANSI_COLOR_RE = /\x1b\[[0-9;]*m/g;
const GUT_TESTS_PATTERNS = [/Tests:\s*(\d+)/g, /^Tests[ \t]+(\d+)/gm];
const GUT_FAILED_PATTERNS = [/Failed:\s*(\d+)/g, /^Failing Tests[ \t]+(\d+)/gm];

function gutCountMatches(out: string, patterns: RegExp[]): string[] {
  const plain = out.replace(ANSI_COLOR_RE, '');
  const values: string[] = [];
  for (const p of patterns) {
    const rx = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(plain)) !== null) { if (m[1] !== undefined) values.push(m[1]); }
  }
  return values;
}

/** 单次 GUT 进程执行(P1-1 PID 注册 / 输出收集 / 超时强杀 / close-error 双路 resolve)。
 *  shards=1 与分片模式共用;超时返回 timedOut=true(exitCode null),spawn 同步抛/异步
 *  error 事件返回 spawnError。
 *  内存治理一期 Task 4:spawn 前准入(gut_shard 档,8GB——单进程全量 GUT 22.5GB 死机的
 *  主炸弹链)。拒则不 spawn,denial 随返回值上抛由调用方(整轮 run_tests)透传;
 *  过则 spawn 后 bindLeasePid,四条退出路径(spawn 同步抛/timeout/close/error)各释放。 */
function runGutProcess(
  godot: string,
  args: string[],
  timeoutSecs: number,
): Promise<{ exitCode: number | null; out: string; timedOut: boolean; spawnError?: string; denial?: { code: string; message: string }; memKill?: { readingBytes: number; declaredMB: number; kind: SpawnKind } }> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const MAX_OUTPUT = 500_000;
    const admit = acquireLease('gut_shard', projectPathFromArgs(args));
    if ('denial' in admit) {
      resolve({ exitCode: null, out: '', timedOut: false, denial: { code: admit.denial.code, message: admit.denial.message } });
      return;
    }
    const leaseId = admit.lease.id;
    let proc: ChildProcess;
    try {
      proc = spawn(godot, args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      releaseLease(leaseId);
      resolve({ exitCode: null, out: '', timedOut: false, spawnError: msg });
      return;
    }
    if (proc.pid) {
      registerSpawnedGodotPid(proc.pid);
      bindLeasePid(leaseId, proc.pid);
    }
    const unregisterSpawn = () => { if (proc.pid) unregisterSpawnedGodotPid(proc.pid); };

    proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        forceKillTree(proc);
        unregisterSpawn();  // P1-1: timeout 强杀后注销(exit 事件可能不触发)
        releaseLease(leaseId);   // Task 4: 强杀后 close 可能不来,显式归还租约
        resolve({ exitCode: null, out, timedOut: true });
      }
    }, timeoutSecs * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      unregisterSpawn();
      releaseLease(leaseId);
      // 内存治理 Task 5:看门狗杀归因——命中则随返回值上抛(单片消费方报
      // MEM_BUDGET_EXCEEDED,分片消费方片级标注);未命中原样返回(回归锚)。
      const memKill = proc.pid ? wasMemKilled(proc.pid) : null;
      resolve({ exitCode: code, out, timedOut: false, ...(memKill ? { memKill } : {}) });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      unregisterSpawn();
      releaseLease(leaseId);
      resolve({ exitCode: null, out, timedOut: false, spawnError: err.message });
    });
  });
}

/** 分片执行主循环:逐片写临时 gutconfig → spawn(-gconfig= 显式覆盖,不传 -gdir——
 *  cmd 层 -gdir 优先级最高会盖回 config dirs)→ 汇总。失败/超时片不中断后续片。
 *
 *  -gconfig 语义依据(GUT 9.7.1 源码):gut_cli.gd GutCliOptionResolver 以 cmd>config>base
 *  优先级解析 config_file 自身——显式传 -gconfig=X 时项目 .gutconfig.json 完全不加载
 *  (替换语义,防 dirs 附加合并,反馈坑③);selected 是单子串匹配不能传集合,tests(完整
 *  路径列表)经 gut.add_script 逐个加载才是选片通道;FileAccess.open 接受 OS 绝对路径,
 *  临时文件放 tmpdir 可行。 */
async function runShardedTests(opts: {
  godot: string;
  projectDir: string;
  testScript: string;
  quitFlag: string;
  shards: number;
  timeoutSecs: number;
}): Promise<ToolResult> {
  const { godot, projectDir, testScript, quitFlag, shards, timeoutSecs } = opts;
  const files = enumerateTestScripts(projectDir, testScript);
  if (files.length === 0) {
    return textResult(
      `Error: no test scripts (*.gd) found under ${testScript} for sharding `
      + '(addons/ dirs and _-prefixed files are excluded). Check test_script or run with shards=1.',
    );
  }
  const buckets = shardFiles(files, shards).filter(b => b.length > 0);
  const SHARD_TAIL = 4_000;   // 每片 raw_output 尾部截断(汇总多片防 MCP 通道超限,I-11 同款)

  const shardResults = [];
  for (const [i, shardTests] of buckets.entries()) {
    const configFile = join(
      tmpdir(),
      `gutconfig-mcp-shard-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`,
    ).split('\\').join('/');   // 正斜杠:FileAccess 与 optparse split('=') 均安全
    writeFileSync(configFile, JSON.stringify({ dirs: [], tests: shardTests }), 'utf-8');

    let r;
    try {
      r = await runGutProcess(godot, [
        '--headless', '--path', projectDir,
        '--script', 'addons/gut/gut_cmdln.gd',
        `-gconfig=${configFile}`,
        `-${quitFlag}`,
      ], timeoutSecs);
    } finally {
      try { unlinkSync(configFile); } catch { /* best-effort 清理 */ }
    }

    // 内存治理 Task 4:准入被拒 → 整轮 run_tests 中止返回 denial(后续片不再起,
    // 已跑片的租约已在各自 runGutProcess 退出时归还,无泄漏;Bazel 快拒绝语义)
    if (r.denial) {
      return opsErrorResult(r.denial.code, r.denial.message);
    }

    const tests = gutCountMatches(r.out, GUT_TESTS_PATTERNS).reduce((s, v) => s + (Number(v) || 0), 0);
    const failed = gutCountMatches(r.out, GUT_FAILED_PATTERNS).reduce((s, v) => s + (Number(v) || 0), 0);
    shardResults.push({
      shard: i + 1,
      files: shardTests.length,
      exit_code: r.exitCode,
      tests,
      failed,
      // 内存治理 Task 5:被看门狗杀的片标 mem_killed(失败片不中断后续片——其余片统计
      // 仍有价值,归因报文片级附上,首个被杀片升格进汇总顶层)。
      status: r.memKill ? 'mem_killed'
        : (r.timedOut ? 'timeout' : (r.spawnError ? 'error' : (r.exitCode === 0 && failed === 0 ? 'ok' : 'failed'))),
      spawn_error: r.spawnError,
      ...(r.memKill ? { mem_kill: formatMemKillMessage(r.memKill) } : {}),
      raw_output: r.out.length > SHARD_TAIL
        ? r.out.slice(r.out.length - SHARD_TAIL) + `\n... [tail ${SHARD_TAIL}/${r.out.length} bytes]`
        : r.out,
    });
  }

  const totalTests = shardResults.reduce((s, x) => s + x.tests, 0);
  const totalFailed = shardResults.reduce((s, x) => s + x.failed, 0);
  // 内存治理 Task 5:首个被杀片的归因升格顶层(agent 单看汇总即见,不必逐片翻)
  const firstMemKill = shardResults.find(x => x.status === 'mem_killed' && typeof x.mem_kill === 'string');
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        mode: 'sharded',
        requested_shards: shards,
        shards: shardResults.length,
        total_tests: totalTests,
        total_failed: totalFailed,
        all_passed: totalFailed === 0 && shardResults.every(x => x.status === 'ok'),
        timeout_per_shard_s: timeoutSecs,
        ...(firstMemKill ? { mem_budget_exceeded: firstMemKill.mem_kill } : {}),
        shard_results: shardResults,
      }, null, 2),
    }],
  };
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
      // 终审 I-1(b):findGodot 前置于 acquireLease——消除「acquire 成功→findGodot 抛→
      // 租约悬空」的环境级触发面(GODOT_PATH 配错/PATH 无 godot 即中,非编程错误)。
      const godot = await ctx.findGodot();
      // 内存治理 Task 4:editor 档准入——exemptChecks:true 跳三查(用户显式起编辑器
      // 不受机器水位约束)但仍记账(占用清单/计数可见);租约绑 pid 后由 close/error
      // 归还,若事件不达由读时清理(pid 死→删)兜底。
      const admit = acquireLease('editor', p, { exemptChecks: true });
      if ('denial' in admit) {
        return opsErrorResult(admit.denial.code, admit.denial.message);
      }
      const leaseId = admit.lease.id;
      // 终审 I-1(c):spawn 同步抛时 error/close handler 均未注册——归还租约再抛,防泄漏。
      try {
        const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore', env: buildSafeEnv() });
        if (child.pid) bindLeasePid(leaseId, child.pid);
        child.on('error', (err) => {
          releaseLease(leaseId);
          getLogger().error('runtime', `Failed to launch editor: ${err.message}`);
        });
        child.on('close', () => releaseLease(leaseId));
        child.unref();
      } catch (err) {
        releaseLease(leaseId);
        throw err;
      }
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
        // 内存治理 Task 5:无在跑进程但目标桶最近一次运行被看门狗杀——附归因与档位
        // 上调指引(杀后 stop 常见路径:close 已清 proc,归因仍可查)。
        const noRunKillNote = recentMemKills.get(stopTargetKey);
        if (noRunKillNote) {
          return textResult(`No project is currently running. Last run was killed by memory watchdog: [MEM_BUDGET_EXCEEDED] ${noRunKillNote}`);
        }
        return textResult('No project is currently running.');
      }
      markSessionStopping(stopTargetKey);
      await killProcess(targetProc);
      releaseRunSessionBusy(stopTargetKey);

      // B3(反馈批次 2026-11-12): kill 成功后 best-effort 清本项目死实例 secret——判死=
      // registry 条目 pid 进程探测(有意不用 lastSeen 新鲜度:刚 kill 的实例心跳仍新鲜会
      // 误保留),pid 活/缺失一律保留;try/catch 包裹,失败仅附告警不阻断 stop 主流程。
      let secretsCleaned: number[] = [];
      let secretCleanupWarning: string | undefined;
      const stopProjectDir = (typeof rawStopPath === 'string' && rawStopPath.length > 0 ? rawStopPath : '') || ctx.projectDir || '';
      try {
        if (stopProjectDir) secretsCleaned = cleanDeadInstanceSecrets(stopProjectDir, undefined, isPidAlive);
      } catch (err) {
        secretCleanupWarning = `dead-instance secret cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // per-key 读数(设计 §4.3 M-3):source/runtime/total_lines 来自目标桶 session
      const s = getSession(stopTargetKey);
      const { lines: stopLines, fromSnapshot: stopFromSnapshot } = resolveReadableOutputFor(s);
      const classified = classifyOutput(stopLines);
      // I-10: Guard against processStartTime=0 producing absurd runtime values
      const runtimeMs = s && s.processStartTime > 0 ? Date.now() - s.processStartTime : 0;
      // 内存治理 Task 5:目标桶最近一次看门狗杀归因(结构化字段对齐 get_debug_output)
      const stopMemKillMsg = recentMemKills.get(stopTargetKey);
      const result = {
        status: 'stopped',
        source: stopFromSnapshot ? 'last_finished_run' : 'current_run',
        runtime: `${(runtimeMs / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: stopLines.length,
        secretsCleaned,
        ...(secretCleanupWarning ? { secret_cleanup_warning: secretCleanupWarning } : {}),
        ...(stopMemKillMsg ? { mem_budget_exceeded: stopMemKillMsg } : {}),
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
      // 内存治理 Task 5:本桶最近一次看门狗杀归因(结构化字段,快照 errors 行之外的显式通道)
      const memKillMsg = recentMemKills.get(debugTargetKey);
      const result = {
        running: s.proc !== null,
        runtime: `${(debugRuntimeMs / 1000).toFixed(1)}s`,
        source: fromSnapshot ? 'last_finished_run' : 'current_run',
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: lines.length,
        ...(memKillMsg ? { mem_budget_exceeded: memKillMsg } : {}),
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
      try {
        const rawTestScript = (args.test_script as string) || 'res://test/';
        // I-SEC-08: Validate test_script starts with res:// to prevent filesystem traversal
        if (!rawTestScript.startsWith('res://')) {
          return textResult(`Error: test_script must start with "res://", got: "${rawTestScript}"`);
        }
        // B5(竞品综述落地批 2026-11-13): 段级 ".." 拒绝——前缀检查挡不住 res://../<项目外>
        // 枚举越界;对齐 path-utils.ts:196 段级精确形态(分隔符先统一防 ..\ 混合形态漏网,
        // 含 .. 的合法文件名如 foo..bar.gd 不误伤)。
        if (rawTestScript.replace(/\\/g, '/').split('/').some(seg => seg === '..')) {
          return textResult(`Error: test_script must not contain ".." path segments, got: "${rawTestScript}"`);
        }
        const testScript = rawTestScript;
        const godot = await ctx.findGodot();
        // A4 (2026-07-04 反馈): GUT 退出标志参数化。默认 -gquit(GUT ≤9.5 惯例,GUT 9.6+ 移除);
        // 白名单二选一,非法值回落 gquit(值只拼进 spawn args 数组,无注入面,白名单是行为兜底)。
        const quitFlag = args.quit_flag === 'gexit' ? 'gexit' : 'gquit';
        // D6 (2026-11-12): timeout 参数取代 120s 硬编码(未传/非法/0/负数 → 120 向后兼容;
        // 分片时 per-shard 计时)。I-1(D6 审查): 归一须用 isFinite+>0 显式判定——`|| 120`
        // 只挡 0/NaN,负数 truthy 直通后 max(1,·) 会把 run_project 惯例输入 -1
        // ("0/-1=不自动停")归一成 1s 几乎必超时;正数下取 floor。
        const rawTimeout = Number(args.timeout);
        const timeoutSecs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 120;
        const shards = Math.max(1, Math.floor(Number(args.shards) || 1));

        if (shards > 1) {
          return await runShardedTests({ godot, projectDir: p, testScript, quitFlag, shards, timeoutSecs });
        }

        // shards=1:现有单进程行为(-gdir 直传;输出结构不变),仅超时可配化
        const r = await runGutProcess(godot, [
          '--headless', '--path', p,
          '--script', 'addons/gut/gut_cmdln.gd',
          '-gdir', testScript,
          `-${quitFlag}`,
        ], timeoutSecs);
        if (r.denial) {
          return opsErrorResult(r.denial.code, r.denial.message);
        }
        // 内存治理 Task 5:被看门狗杀 → 优先报 MEM_BUDGET_EXCEEDED(报文含峰值/档位上调
        // 指引;注册表 retryable:false——原样重试必再被杀)。
        if (r.memKill) {
          return opsErrorResult('MEM_BUDGET_EXCEEDED', formatMemKillMessage(r.memKill));
        }
        if (r.timedOut) {
          return textResult(`run_tests timed out after ${timeoutSecs}s`);
        }
        if (r.spawnError) {
          return { content: [{ type: 'text', text: `Error: ${r.spawnError}` }], isError: true };
        }
        const passed = gutCountMatches(r.out, GUT_TESTS_PATTERNS).join(', ');
        const failed = gutCountMatches(r.out, GUT_FAILED_PATTERNS).join(', ');
        // I-11: Truncate raw_output to prevent excessive MCP channel bandwidth
        const MAX_RAW_OUTPUT = 50_000;
        const rawOutput = r.out.length > MAX_RAW_OUTPUT
          ? r.out.slice(0, MAX_RAW_OUTPUT) + `\n... [truncated, ${r.out.length} total bytes]`
          : r.out;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              exit_code: r.exitCode,
              passed,
              failed,
              raw_output: rawOutput,
            }, null, 2),
          }],
        };
      } finally {
        releaseShortRunningSlot();
      }
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
