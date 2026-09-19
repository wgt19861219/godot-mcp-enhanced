// src/core/ToolDispatcher.ts
import type { ToolResult, HandlerResult, ToolContext, DispatchContext, Middleware, ToolCallDelegate } from '../types.js';
import type { ChildProcess } from 'child_process';
import type { ReadOnlyGuard } from './ReadOnlyGuard.js';
import type { Tool, ServerContext } from "@modelcontextprotocol/server";
import { inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import type { EditorToolExecutor } from './EditorToolExecutor.js';
import { executeMiddleware, createRateLimitMiddleware, createElicitationMiddleware } from './middleware.js';
import { createElicitFn, type ElicitFn } from './elicit.js';
import { getCallRecorder, extractErrorMessage } from './call-recorder.js';
import { HealthMonitor } from './health-monitor.js';
import { isFeatureEnabled } from './feature-flags.js';
import {
  requiresConfirmation,
  createPendingToken,
  consumeToken,
  peekToken,
  TOKEN_TTL_MS,
} from './guard.js';
import { isActionGated, isActionAllowed, resolveEnabledGroups } from './action-gate.js';
// A1 (2026-08-11 审查 P1):动态工具名反查静态 (tool, action),堵 confirm/action-gate 双绕过
import { resolveDynamicTool } from './dynamic-risk-map.js';
import {
  isDynamicToolName,
  getAllToolDefinitions,
  getActionRisk,
  getModuleForTool,
  getToolDefinition,
  isReadOnly,
  isToolAllowed,
  LITE_TOOLS,
  MINIMAL_TOOLS,
  registerInlineTool,
  resolveProfile,
  skipProjectPath,
  tryLegacyMapping,
} from './tool-registry.js';
import { validateArgs } from './args-validator.js';
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
import { opsErrorResult, COMMON_ERROR_CODES } from './shared/errors.js';
import { classifyError, newTraceId, InternalError } from './tool-errors.js';
import { isAuditEnabled, appendAuditLine, inferChangedFiles, isTokenRequestResult, recordAuditWriteFailure, isAuditStrict, extractAuditHint } from './audit-log.js';
import { truncateResponse } from './response-limiter.js';
import { isErrorText } from './response-format.js';
import * as ps from './process-state.js';
import { getLogger, withRequestLogLevelAsync, withRequestLogFn, type LogLevel } from './logger.js';
import { resolveProjectPath } from './path-utils.js';
import { record as recordTelemetry, hashProject, isTelemetryEnabled } from '../telemetry/index.js';
import type { AgentContextManager } from './agent-context.js';
import { createProgressEmitter, withToolHeartbeat, type ProgressEmitter, type ProgressToken } from './progress.js';
import { markInflight, clearInflight } from './inflight.js';

/** Known profile names for IDE autocomplete. Unknown strings fall through to resolveProfile(). */
type KnownProfile = 'full' | 'basic' | 'lite' | 'minimal' | 'bridge_dev' | '3d_dev';

const DEBUG = process.env.DEBUG === 'true';
function log(...args: unknown[]): void {
  if (DEBUG) getLogger().debug('dispatcher', args.map(a => String(a)).join(' '));
}

export interface DispatcherOptions {
  // 模式控制
  readOnly: boolean;
  mode: KnownProfile | string;  // 'full' | 'lite' | 'minimal' | profile name | comma-separated groups
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;

  // 依赖注入
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  opsScript: string;
  findGodot: (projectPath?: string) => Promise<string>;
  toolCallDelegate: (fn: ToolCallDelegate | null) => void;
  agentContext?: AgentContextManager;
  /** CRITICAL(2026-07-13 安全): out-of-band 用户确认函数(堵 AI 自确认 token)。默认 createElicitFn()。 */
  elicitFn?: ElicitFn;
}

export class ToolDispatcher {
  private readonly options: DispatcherOptions;
  private readonly readOnlyGuard: ReadOnlyGuard;
  private connectionMode: 'headless' | 'editor';
  private editorExecutor: EditorToolExecutor | null;
  private readonly ctx: ToolContext;
  private _editorFallback = false;
  private _editorFallbackWarned = false;
  private healthMonitor: HealthMonitor;
  private readonly middleware: Middleware[];

  /** CRITICAL(2026-07-13 安全): out-of-band elicitation — confirm_and_execute 强制用户确认(堵 AI 自确认)。 */
  private readonly elicitFn: ElicitFn;

  /** Deferred mode switch — applied at the start of the next handleCall. Prevents
   *  editor disconnect callbacks from switching mode mid-request (C-01). */
  private _pendingModeSwitch: { mode: 'headless' | 'editor'; executor: EditorToolExecutor | null } | null = null;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.readOnlyGuard = options.readOnlyGuard;
    this.connectionMode = options.connectionMode;
    this.editorExecutor = options.editorExecutor ?? null;
    this.elicitFn = options.elicitFn ?? createElicitFn();

    // 构建 ctx — 直接 import process-state（内部实现细节）
    this.ctx = {
      opsScript: options.opsScript,
      findGodot: options.findGodot,
      get runningProcess() { return ps.getRunningProcess(); },
      setRunningProcess(proc: ChildProcess | null, skipBusyCheck?: boolean) { ps.setRunningProcess(proc, skipBusyCheck); },
      get outputBuffer() { return ps.getOutputBuffer(); },
      setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
      get processStartTime() { return ps.getProcessStartTime(); },
      setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
      get projectDir() { return ps.getProjectDir(); },
      setProjectDir(d: string) { ps.setProjectDir(d); },
      parseGodotConfig,
    };

    // 注册内联工具的元数据（confirm_and_execute 不属于任何 ToolModule）
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });

    // Health monitor for middleware pipeline
    this.healthMonitor = new HealthMonitor({ heartbeatIntervalMs: 15_000 });  // ipc P0-2: 心跳 15s < 编辑器侧 INACTIVITY_TIMEOUT(30s), 避免边界竞争误杀
    this.middleware = this.buildMiddleware();

    // Phase 3a: Wire proxy delegate through handleCall for full middleware chain
    // (ReadOnlyGuard, path validation, confirmation tokens, etc.)
    this.options.toolCallDelegate(async (targetTool, toolArgs) => {
      // Recursion guard: proxy must not delegate to itself
      if (targetTool === 'godot_advanced_tool') {
        return opsErrorResult('PROXY_RECURSION', 'Cannot proxy godot_advanced_tool through itself');
      }
      // PR-2 Task 4 诚实边界:代理再分发不透传 clientTasksCapable(拿不到 GodotServer 的
      // per-request 能力快照)→ 代理链上 taskAugmented=false。qa 不经 godot_advanced_tool
      // 代理,当前零影响;若未来经代理调 qa 需要传第 3 参。
      return this.handleCall({ params: { name: targetTool, arguments: toolArgs } }) as Promise<ToolResult>;
    });
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  /** Web GUI 面板注入用(spec 2026-09-15 §6):只读暴露真实 ToolContext——
   *  面板直调 executeRunProject 复用真实链路(findGodot/setProjectDir 活跃指针等),零复刻。 */
  getContext(): ToolContext { return this.ctx; }

  getFilteredTools(): Tool[] {
    let allTools = getAllToolDefinitions();

    // 内联工具: confirm_and_execute
    allTools.push({
      name: 'confirm_and_execute',
      description: 'Execute a previously blocked tool using a confirmation token. Use this when a tool returns a confirmation_token.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: { type: 'string', description: 'Confirmation token from the blocked tool response' },
        },
        required: ['token'],
      },
    });

    // READ_ONLY_MODE 过滤
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !this.readOnlyGuard.check(t.name).blocked);
      log('READ_ONLY_MODE: %d tools available', allTools.length);
    }

    // LITE / MINIMAL / PROFILE 模式过滤
    if (this.options.mode === 'lite') {
      allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
      log('LITE mode: %d tools available', allTools.length);
    } else if (this.options.mode === 'minimal') {
      allTools = allTools.filter(t => MINIMAL_TOOLS.has(t.name));
      log('MINIMAL mode: %d tools available', allTools.length);
    } else if (this.options.mode !== 'full') {
      // Profile mode: resolve profile name or comma-separated groups
      const profileTools = resolveProfile(this.options.mode);
      if (profileTools.size > 0) {
        allTools = allTools.filter(t => profileTools.has(t.name));
        log('PROFILE mode (%s): %d tools available', this.options.mode, allTools.length);
      } else {
        // R2 slim-profile-silent-full-fallback: 未知/拼写错 profile 解析空集时 fail-closed 回退 minimal(非 full),
        // 防 --profile=slim 等配置失效时静默暴露全部写/执行工具(违反最小权限 + fail-open)。
        getLogger().warn('dispatcher', `Profile "${String(this.options.mode)}" resolved to empty set — failing closed to MINIMAL. Check for typos.`);
        allTools = allTools.filter(t => MINIMAL_TOOLS.has(t.name));
      }
    }

    // slim mode: ensure proxy tool is always present (it belongs to core group,
    // but guard against edge cases where filtering might exclude it)
    if (this.options.mode === 'slim') {
      const hasProxy = allTools.some(t => t.name === 'godot_advanced_tool');
      if (!hasProxy) {
        allTools.push(...getAllToolDefinitions().filter(t => t.name === 'godot_advanced_tool'));
      }
    }

    // activeGroups 过滤（Phase 1 动态管理）。A-3(审查): 改用 flag 系统(原直接读 env 绕过 isFeatureEnabled)
    if (isFeatureEnabled('TOOL_GROUPS')) {
      allTools = allTools.filter(t => isToolAllowed(t.name));
      log('activeGroups filter: %d tools available', allTools.length);
    }

    return allTools;
  }

  async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }, srvCtx?: ServerContext, clientTasksCapable?: boolean): Promise<HandlerResult> {
    // Apply deferred mode switch before processing
    this._applyPendingModeSwitch();

    const { name, arguments: rawArgs } = request.params;
    const startTime = Date.now();
    let args: Record<string, unknown> = {};
    try {
      args = this.normalizeArgs(rawArgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('normalizeArgs error:', name, msg);
      return opsErrorResult('TOOL_ERROR', `Argument normalization failed: ${msg}`);
    }

    // 从 _meta 中提取 agent 身份标识
    // 注意：agentId / agent_id 是对未文档化客户端行为的假设——MCP 规范未定义
    // tools/call._meta 中的 caller 身份字段，主流客户端亦未承诺注入。
    // 跟踪 anthropics/claude-code#32514；落地前此值通常为 undefined（多 Agent 路径不可用）。
    const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
    const agentId = (meta?.agentId ?? meta?.agent_id) as string | undefined;
    if (this.options.agentContext) {
      this.options.agentContext.getOrCreate(agentId);
    }
    // Task 3: 提取 progressToken → 创建 per-request emitter（C-CONC-1：局部变量，照抄 findGodotOverride 透传）
    const progressToken = meta?.progressToken as ProgressToken | undefined;
    const progressEmitter: ProgressEmitter | undefined =
      progressToken !== undefined ? createProgressEmitter(progressToken) : undefined;

    // P1-7 (SEP-2577): 提取 per-request logLevel(io.modelcontextprotocol/logLevel)。
    // ⚠️ 关键:SDK v2 在 dispatch 前 liftWireOnlyMaterial 会把 RESERVED_ENVELOPE_META_KEYS
    // (含 logLevel)从 request.params._meta **delete 掉**搬到 ctx.mcpReq.envelope
    // (node_modules/.../src-CX2iR2pK.mjs:6003-6041)。故必须从 srvCtx.mcpReq.envelope 读,
    // 从 request.params._meta 读恒得 undefined(第三方审查 I1 发现)。
    // envelope 是 Partial<RequestMetaEnvelope>(运行时含 reserved key,类型上是空对象),用字符串索引读。
    const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
    const envelope = srvCtx?.mcpReq?.envelope as Record<string, unknown> | undefined;
    const rawLogLevel = envelope?.['io.modelcontextprotocol/logLevel'] as string | undefined;
    const requestLogLevel: LogLevel | 'off' | null =
      rawLogLevel === undefined ? null
      : rawLogLevel === 'off' ? 'off'
      : VALID_LOG_LEVELS.has(rawLogLevel) ? (rawLogLevel as LogLevel)
      : null;  // 非法值视为 null(旧行为);SEP-2577 建议返 -32602 但 enhanced 在 middleware 层不阻断

    // 批4-T4(五维评估 P1): caller 归因归一——通道前缀(mcp / web-gui:<子系统> / cli:<命令>)
    // 使审计可区分操作来源(批4 前唯一数据源 _meta.agentId 通常 undefined,caller 恒缺省,
    // "AI 经 MCP vs 用户 CLI vs HTTP 面"不可分辨)。agentId 是 MCP 规范未定义字段(见上注),
    // 客户端注入时自动升级为 mcp:<agentId> 细粒度归因。
    const callerLabel = agentId !== undefined && agentId !== '' ? `mcp:${agentId}` : 'mcp';

    const ctx: DispatchContext = { toolName: name, args, startTime, phase: 'before', traceId: newTraceId(), caller: callerLabel };

    // P1-7 (SEP-2577): per-request logLevel 包裹整个工具调用链(middleware + executeToolCall +
    // dispatchTool + confirm_and_execute)。withRequestLogLevelAsync 在 await 期间保持
    // _currentRequestLogLevel,emitToClient 据此过滤 notifications/message。
    // null = 客户端未设 _meta['io.modelcontextprotocol/logLevel'],保持旧行为(仅 warn/error 发)。
    //
    // P1-3 完整推进: 叠加 withRequestLogFn 注入 SDK 官方 ctx.mcpReq.log(自动处理 era + severity)。
    // emitToClient 优先用 _requestLogFn(SDK 官方),无它时降级到 _currentRequestLogLevel(自管)。
    // srvCtx.mcpReq.log 由 SDK buildContext 构造,may be undefined(legacy 无 envelope / 非 request 上下文)。
    const requestLogFn = srvCtx?.mcpReq?.log as ((level: string, data: unknown, logger?: string) => Promise<void>) | undefined;
    return withRequestLogFn(requestLogFn ?? null, () =>
      withRequestLogLevelAsync(requestLogLevel, () =>
        executeMiddleware(this.middleware, ctx, async () => {
          // 心跳保活(2026-09-11 P1 批):长工具每 20s 发 progress 心跳防客户端 idle 杀;
          // 无 progressToken 时 no-op。详见 progress.ts withToolHeartbeat。
          // P4-3 (2026-09-11): in-flight 登记——进程被杀后下个 server 启动时 stderr 报丧
          // (BuildersGate 取消经济学:把"静默损失"变成可诊断事件)。见 core/inflight.ts。
          markInflight(name);
          try {
            return await withToolHeartbeat(progressEmitter, name, () =>
              this.executeToolCall(name, args, startTime, ctx.traceId, progressEmitter, srvCtx, clientTasksCapable, callerLabel));
          } finally {
            clearInflight(name);
          }
        }),
      ),
    );
  }

  private async executeToolCall(name: string, args: Record<string, unknown>, startTime: number, traceId: string, progressEmitter?: ProgressEmitter, srvCtx?: ServerContext, clientTasksCapable?: boolean, callerAgentId?: string): Promise<HandlerResult> {
    // ── Task 3 (A-RCE #3): profile 硬隔离入口强制 ──
    // isToolAllowed 原只在 getFilteredTools 广告层(:183),被转发 MCP 客户端(拿完整
    // tools/list 或硬编码工具名)仍可调用 TOOL_GROUPS/slim 过滤的工具。此处对称补强:
    // 主路径也强制。非 RCE(ReadOnlyGuard 兜底),是隔离弱。默认 activeGroups 全激活,
    // 对所有已知顶层工具名返 true,零误拒;manage_tools deactivate 收窄后才生效。
    if (!isToolAllowed(name)) {
      log('executeToolCall: tool %s not in active groups (profile enforcement)', name);
      return opsErrorResult('TOOL_NOT_ALLOWED', `Tool "${name}" is not available in the active tool groups (TOOL_GROUPS/slim profile).`);
    }

    // P0-3 action-gate：action 级权限拦截（默认 gate RCE action）
    // 与 profile（工具级编译时）+ manage_tools（工具级运行时）互补：
    // action-gate 是最细粒度——tools/list 仍暴露工具，仅 gated action 调用被拒。
    // A1 (2026-08-11 审查 P1): 动态注册的平铺工具(如 debug_evaluate)不在静态 metaRegistry,
    // isActionGated('debug_evaluate','') 永不命中 → gated action 经动态通道绕过。经
    // METHOD_TO_TOOL 反查回静态 (tool, action) 再判定;执行仍用原平铺名(editor 转发需要)。
    const _action = typeof args.action === 'string' ? args.action : '';
    const _dyn = isDynamicToolName(name) ? resolveDynamicTool(name) : undefined;
    const _gateTool = _dyn?.tool ?? name;
    const _gateAction = _dyn?.action ?? _action;
    if (isActionGated(_gateTool, _gateAction) && !isActionAllowed(_gateTool, _gateAction, resolveEnabledGroups())) {
      log('executeToolCall: action %s.%s gated by capability gate', _gateTool, _gateAction);
      return opsErrorResult('ACTION_GATED',
        `action '${_gateAction}' is gated (security: code-execution). Set GODOT_MCP_PRIVILEGED_GROUPS=code-execution to enable.`);
    }
    // Snapshot current mode + executor for consistent routing throughout this call
    const currentMode = this.connectionMode;
    const currentExecutor = this.editorExecutor;

    try {
      // ── 0.5. Default project_path injection ──
      // issue #11: list_projects/list_templates 是搜索/列表语义,不需 project_path。
      // skipProjectPath 按工具名(无法区分 project 工具的 action),故此处 action 级豁免。
      if (!args.project_path && !skipProjectPath(name) && !(name === 'project' && (args.action === 'list_projects' || args.action === 'list_templates'))) {
        const resolved = resolveProjectPath();
        if (!resolved) {
          return opsErrorResult(
            COMMON_ERROR_CODES.INVALID_PARAMS,
            'project_path is required but not provided, and no default could be resolved. ' +
            'Set GODOT_PROJECT_PATH env var, run from a Godot project directory, or pass project_path explicitly.',
          );
        }
        args.project_path = resolved;
      }

      // ── 0.6. Project-aware findGodot injection ──
      // C-CONC-1: findGodot override 作为局部变量,沿调用链显式传入 dispatchTool。
      // 不能用实例字段 — MCP SDK 经 Promise.resolve().then(handler) 异步派发多个 tools/call,
      // 请求并发执行,实例字段会被互相覆盖(旧注释"MCP serializes so no race"为错误前提)。
      // CR-2: confirm_and_execute 分支须基于 pending.args(原始工具 args)重算,而非
      // confirm_and_execute 自身 args(只有 token)—— 见该分支内 resolveFindGodotOverride 调用。
      const { override: findGodotOverride, error: findGodotErr } = await this.resolveFindGodotOverride(args);
      if (findGodotErr) return findGodotErr;

      // ── 0. Common arg type validation ──
      const typeErr = this.validateCommonArgs(args);
      if (typeErr) return typeErr;

      // ── 0.x Schema validation (args vs inputSchema) ──
      // spec §3:normalizeArgs 后 args key 已 snake_case,与 inputSchema 一致。
      // inline tool(confirm_and_execute)getToolDefinition 返 undefined → 跳过;godot_advanced_tool 实为完整 ToolModule(advanced-proxy),正常走 validateArgs(inputSchema 宽松:tool_name required / arguments 可选)。
      const schemaDef = getToolDefinition(name);
      if (schemaDef?.inputSchema) {
        const { ok, errors } = validateArgs(args, schemaDef.inputSchema);
        if (!ok) {
          return opsErrorResult(
            COMMON_ERROR_CODES.INVALID_PARAMS,
            `参数校验失败: ${errors.join('; ')}`,
          );
        }
      }

      // ── 1. ReadOnlyGuard ──
      // 批4-T5: 传 action 做 action 级只读判定(readonly 工具的非 read action 拒)
      const guardResult = this.readOnlyGuard.check(name, typeof args.action === 'string' ? args.action : undefined);
      if (guardResult.blocked) {
        return opsErrorResult(String(guardResult.errorCode ?? 'READ_ONLY'), guardResult.message ?? 'Operation blocked in read-only mode');
      }

      // ── 1.5. Path allowlist validation (all modes) ──
      const pathErr = this.validatePathArgs(args);
      if (pathErr) return pathErr;

      // ── 2. confirm_and_execute 分支（P0-2 MRTR 改造）──
      if (name === 'confirm_and_execute') {
        const token = args.token as string;
        if (!token || typeof token !== 'string') {
          return opsErrorResult('MISSING_TOKEN', 'confirmation_token is required');
        }

        // P0-2 MRTR：读第二轮的用户响应（SDK LegacyInputRequiredShim 在 2025-era 自动收集）。
        // confirmed === undefined 表示第一轮（无 inputResponses）；非 undefined 表示第二轮。
        const confirmed = srvCtx?.mcpReq?.inputResponses
          ? acceptedContent<{ confirm: boolean }>(srvCtx.mcpReq.inputResponses, 'confirm')
          : undefined;

        // opt-in 降级 — GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true 时跳过 elicitation（保留现有语义）。
        // 降级路径在第一轮就消费 token + 执行，不走 MRTR。
        if (process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM === 'true' && confirmed === undefined) {
          const pending = consumeToken(token);
          if (!pending) return opsErrorResult('INVALID_TOKEN', 'Invalid or expired confirmation token');
          if (pending.wasTruncated) return opsErrorResult('ARGS_TRUNCATED',
            `Confirmation token args were truncated (exceeded 10KB limit). ` +
            `Please call the original tool again — the server will re-generate a fresh token with the full args.`);
          console.warn(`[SECURITY] GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true — confirm_and_execute 跳过 elicitation (token:${String(token).slice(0, 8)} tool:${pending.toolName})。仅可信本地/CI,生产保持默认未设。`);
          // 跳到执行段（下面 confirmedPending 赋值后共用）
          const __confirmedResult = await this._confirmExecute(pending, startTime, progressEmitter, currentMode, currentExecutor, clientTasksCapable);
          const __audit = await this._auditConfirmedExecution(pending, startTime, __confirmedResult, traceId, callerAgentId);
          if (__audit.strict) {
            // 1A STRICT:审计落盘失败 → 操作判失败(副作用可能已发生,诚实标注)
            return opsErrorResult('AUDIT_WRITE_FAILED',
              `Tool "${pending.toolName}" executed but audit write failed in STRICT mode (GODOT_MCP_AUDIT_STRICT=true). ` +
              `Side effects may already have occurred — verify manually.`);
          }
          return __audit.result;  // 批4-T3: 剥离 _audit 后的结果
        }

        if (confirmed === undefined) {
          // ── 第一轮：peek token + 返回 InputRequiredResult ──
          const pending = peekToken(token);
          if (!pending) return opsErrorResult('INVALID_TOKEN', 'Invalid or expired confirmation token');
          if (pending.wasTruncated) return opsErrorResult('ARGS_TRUNCATED',
            `Confirmation token args were truncated (exceeded 10KB limit). ` +
            `Please call the original tool again — the server will re-generate a fresh token with the full args.`);

          // CRITICAL(2026-07-13 安全 P0): out-of-band 用户确认 — 堵 AI 自读自确认 token。
          // P0-2 MRTR: 返回 InputRequiredResult，SDK 自动处理双时代：
          //   2025-era：LegacyInputRequiredShim 自动转 elicitation/create push（server→client→user UI）
          //   2026-era：直接放 InputRequiredResult 到 wire，client 弹 UI 后重发请求
          const argsJson = JSON.stringify(pending.args);
          const argsPreview = argsJson.length > 500 ? argsJson.slice(0, 500) + '...(截断)' : argsJson;
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `确认执行 "${pending.toolName}" (action: ${String(pending.args.action ?? 'n/a')})?\n参数摘要: ${argsPreview}\n此操作经 confirm_and_execute,需用户 out-of-band 确认(防 AI 自确认)。拒绝请点 cancel/decline。`,
                requestedSchema: { type: 'object' as const, properties: { confirm: { type: 'boolean' } }, required: ['confirm'] },
              }),
            },
            requestState: token,
          });
        }

        // ── 第二轮：用户已响应 ──
        if (!confirmed || confirmed.confirm !== true) {
          consumeToken(token);  // 消费掉防止重放
          return opsErrorResult('ELICITATION_DENIED',
            `执行需用户经 elicitation out-of-band 确认。Elicitation 被 decline/cancel/不支持或返回非确认,中止(堵 AI 自确认)。可信环境可设 GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true 降级。`);
        }

        const pending = consumeToken(token);
        if (!pending) return opsErrorResult('TOKEN_EXPIRED', 'Confirmation token expired during MRTR round-trip');
        const __confirmedResult2 = await this._confirmExecute(pending, startTime, progressEmitter, currentMode, currentExecutor, clientTasksCapable);
        const __audit2 = await this._auditConfirmedExecution(pending, startTime, __confirmedResult2, traceId, callerAgentId);
        if (__audit2.strict) {
          // 1A STRICT:审计落盘失败 → 操作判失败(副作用可能已发生,诚实标注)
          return opsErrorResult('AUDIT_WRITE_FAILED',
            `Tool "${pending.toolName}" executed but audit write failed in STRICT mode (GODOT_MCP_AUDIT_STRICT=true). ` +
            `Side effects may already have occurred — verify manually.`);
        }
        return __audit2.result;  // 批4-T3: 剥离 _audit 后的结果
      }

      // ── 3. 确认令牌检查（IMP-6: 前置 legacy 映射，防 legacy name 如 remove_node 绕过 guard）──
      // A1 (2026-08-11 审查 P1): 动态工具名同样前置反查——guard 对动态工具名查 metaRegistry
      // 返 undefined(永不确认),等价静态调用(engine+call_method,write)经动态通道绕门。
      // 反查优先级:legacy 映射 > 动态映射 > 原名。未映射的动态方法风险未知 → fail-closed
      // 直接要求确认(防 GD 新增 method 漏登记 METHOD_TO_TOOL 时静默绕门)。
      const legacyMap = tryLegacyMapping(name);
      const dynMap = isDynamicToolName(name) ? resolveDynamicTool(name) : undefined;
      const guardName = legacyMap?.tool ?? dynMap?.tool ?? name;
      const guardArgs = (legacyMap ?? dynMap) ? { ...args, action: legacyMap?.action ?? dynMap?.action } : args;
      const confirmRequired = (isDynamicToolName(name) && !dynMap) || requiresConfirmation(guardName, guardArgs);
      if (confirmRequired) {
        const token = createPendingToken(name, args);  // 原始 name/args(confirm_and_execute 执行用)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              requires_confirmation: true,
              tool: name,
              confirmation_token: token,
              message: `Tool "${name}" requires confirmation. Call confirm_and_execute with this token to proceed.`,
              ttl_seconds: TOKEN_TTL_MS / 1000,
              expires_at: Date.now() + TOKEN_TTL_MS,
            }),
          }],
        };
      }

      // ── 4+5. editor/headless dispatch(抽到 _dispatchEditorOrHeadless,与 _confirmExecute 复用)──
      return await this._dispatchEditorOrHeadless(name, args, currentMode, currentExecutor, startTime, findGodotOverride, progressEmitter, clientTasksCapable);
    } catch (err) {
      // G2 (2026-08-13): 结构化错误分类 + PII 护栏。classifyError 从异常【类型】映射,
      // 绝不读 err.message。safeMessage 进 client 响应(PII-safe);完整 err.message 只 log。
      const { category, retryable, code, safeMessage } = classifyError(err);
      log('Tool error:', name, traceId, category, err instanceof Error ? err.message : String(err));
      // G2: error_category/retryable/trace_id 进 content JSON(opsErrorResult,AI 可读)。
      // 注:telemetry 仍固定 TOOL_ERROR(defects.ts telemetry-error-category-pii-leak 硬约束),
      // response 侧已升级结构化 category;telemetry 升级待 defect 检测器认可结构化模式。
      return opsErrorResult(code, safeMessage, { retryable, errorCategory: category, traceId });
    }
  }

  private buildMiddleware(): Middleware[] {
    const mw: Middleware[] = [];

    // Health sample middleware (after hook — runs on both success and failure)
    mw.push({
      name: 'healthSample',
      before: async () => ({ passed: true }),
      after: async (ctx, result) => {
        const duration = Date.now() - ctx.startTime;
        // Phase 1(对标 unity response-format.js):用 isErrorText 识别逻辑失败,
        // 覆盖 {success:false} / {ok:false} / {error:string} / {error:{message}} / {error_code,message} 多种 shape。
        // 旧 checkJsonSuccessFalse 只认 {success:false} 一种,漏判其他形态的逻辑失败。
        const detectedError = result.isError === true || this.checkJsonSuccessFalse(result);
        const isError = detectedError;
        const recorder = getCallRecorder();
        if (isError) {
          this.healthMonitor.recordFailure('TOOL_ERROR', `Tool ${ctx.toolName} failed`);
          recorder.record(ctx.toolName, false, duration, 'TOOL_ERROR', extractErrorMessage(result));
          // Phase 1(对标 unity index.js:466-469):把逻辑失败的 isError flag 写回 result,
          // 让客户端(CallToolResult.isError)能正确识别。之前只用于监控,客户端拿不到。
          // 只在 result 未显式设置 isError 时补打(不覆盖 handler/editor 已设的值)。
          if (result.isError === undefined) {
            result.isError = true;
          }
        } else {
          this.healthMonitor.recordSuccess(duration);
          recorder.record(ctx.toolName, true, duration);
        }
        // G2: trace_id/duration_ms 注入 _meta(MCP 标准,SDK ResultMetaObjectSchema looseObject 透传到 wire)。
        // TS caveat:CallToolResult._meta 推断类型只声明 serverInfo key,用断言放宽(运行时/wire 已验证)。
        const __g2Meta = (result as ToolResult & { _meta?: Record<string, unknown> })._meta ?? {};
        return { ...result, _meta: { ...__g2Meta, trace_id: ctx.traceId, duration_ms: duration } } as ToolResult;
      },
    });

    // Telemetry after-hook（opt-in，与 healthSample 并列；review B-1 正确包装点）。
    // endpoint 空（默认）时 record 内部立即 return，零开销。
    mw.push({
      name: 'telemetry',
      before: async () => ({ passed: true }),
      after: async (ctx, result) => {
        // T2: opt-out 前置守卫——必须在 recordTelemetry 参数求值前早 return。
        // 否则 hashProject(ctx.args.project_path) 在 record() 入口前先跑 → getInstallUUID
        // （config.ts:28 首次 mint 创建 ~/.godot-mcp/telemetry-uuid.txt），违反 docs/telemetry.md
        // 「零副作用」承诺。守卫在 callee 内部无效（参数已求值），须在调用方 before-arg-eval。
        // 根因 [[feature-gate-inside-callee-defeated-by-arg-eval]]。
        if (!isTelemetryEnabled()) return result;
        // 与 healthSample 判定对齐：{success:false} JSON 无 isError 时也算失败，
        // 否则 telemetry success 虚高、与 recorder/health 口径不一致。
        const isError = result.isError === true || this.checkJsonSuccessFalse(result);
        recordTelemetry({
          tool: ctx.toolName,
          success: !isError,
          duration_ms: Date.now() - ctx.startTime,
          // T1: 固定枚举 'TOOL_ERROR'。原 safeErrorCategory(extractErrorMessage(result)) 会把
          // 原始错误文本（含路径/项目名 PII）仅替标点后塞进 error_category，Stage 1 接 endpoint
          // 即外传 PII。result 无结构化 code，按错误文本推断 category 主观且 YAGNI，故固定枚举。
          // G2 注:结构化 error_category 已在 response content JSON(opsErrorResult)给 AI;telemetry
          // 维持固定是 defects.ts telemetry-error-category-pii-leak 硬约束,待检测器升级认可结构化。
          error_category: isError ? 'TOOL_ERROR' : undefined,
          project_hash: typeof ctx.args.project_path === 'string' ? hashProject(ctx.args.project_path) : undefined,
        });
        return result;
      },
    });

    // IMPORTANT-5: 全局 rate limit(防 AI 失控循环耗尽资源)。默认 60 次/秒软限。
    // G3 (2026-08-13): 操作级审计 after middleware(借鉴 devtool,appendFile 原子修复 writeFile 竞态)。
    // 只审计 write/destructive/process(getActionRisk 复用 guard 数据源);read 跳过。
    // 1B (2026-09-19): risk 未知(未映射动态工具/漏声明)按 write 保守落审计(fail-closed,对齐确认门)。
    // audit 是 side effect,默认不改 result;1A:审计失败计数+首次 warn,STRICT env 下操作判失败。
    // ⚠️ 顺序约定(审查 Nit-5): audit 须保持为 buildMiddleware 中**最后一个带 after 的 hook**——
    // 1A STRICT 靠改写 result 生效,若在其后注册带 after 的 middleware,改判结果会被覆盖。
    mw.push({
      name: 'audit',
      before: async () => ({ passed: true }),
      after: async (ctx, result) => {
        if (!isAuditEnabled()) return result;
        // C-3 (2026-08-14): 动态工具名(如 engine_call_method)不在静态 metaRegistry,
        // 平铺名 getActionRisk 恒 undefined → 动态通道所有写操作静默零审计。
        // 经 resolveDynamicTool 反查回静态 (tool, action)(复用 executeToolCall 既有解析),
        // 与 confirm/action-gate 两道门的 A1 反查对齐。落盘也记解析后的名字
        // (audit get_log 的 `${tool}.${action}` key 与静态调用一致)。
        const auditDynMap = isDynamicToolName(ctx.toolName) ? resolveDynamicTool(ctx.toolName) : undefined;
        const unmappedDynamic = isDynamicToolName(ctx.toolName) && !auditDynMap;
        const auditTool = auditDynMap?.tool ?? ctx.toolName;
        const auditAction = auditDynMap?.action ?? String(ctx.args.action ?? '');
        let risk = getActionRisk(auditTool, auditAction);
        // 1B (2026-09-19): fail-closed——risk 未知(未映射动态工具/静态漏声明)按保守档
        // (write)落审计而非静默跳过,与确认门"未映射动态工具强制确认"(:434-441)语义对齐。
        let unmappedDetails: Record<string, unknown> | undefined;
        if (!risk) {
          // I-1(2026-09-19 审查修复): 豁免两类"天然 undefined 且工具级已声明只读"的调用形态,
          // 防审计语义污染——a) readonly 平铺工具(help/godot_get_context 的 `_: 'read'` 占位键,
          // action='' 查不中 `_` 键恒 undefined,派生 readonly=true);b) confirm_and_execute
          // (registerInlineTool 显式 readonly=true,真实执行的审计由 _auditConfirmedExecution
          // 补记,带真实 tool/action + confirmed 标记,middleware 层落 risk_unknown 只会双写)。
          // 未映射动态工具名不在 registry → isReadOnly=false → 仍走 fail-closed(1B 核心目标)。
          if (isReadOnly(auditTool)) return result;
          risk = 'write';
          unmappedDetails = unmappedDynamic ? { dynamic_unmapped: true } : { risk_unknown: true };
        }
        if (risk === 'read') return result;
        // B-1 修复(审查):令牌请求响应(返回 requires_confirmation,操作未执行)不记虚假 ok=true。
        // 真实执行经 confirm_and_execute → _auditConfirmedExecution 补审计(_confirmExecute 绕过 middleware)。
        if (isTokenRequestResult(result)) return result;
        // project_path fallback(elicitation 浅拷贝 footgun:after hook args.project_path 可能丢注入值)
        // I-2(设计 §6):fallback 链中间插活跃桶——args.project_path 缺失时审计落活跃项目而非
        // env 项目,防多桶并存下 runtime 域 risk='process' 操作(stop_project 等)审计归属漂移。
        const projectPath = (typeof ctx.args.project_path === 'string' && ctx.args.project_path)
          ? ctx.args.project_path : (ps.getProjectDir() || resolveProjectPath());
        if (!projectPath) return result;
        const isError = result.isError === true || this.checkJsonSuccessFalse(result);
        // 批4-T3: 提取工具上报的审计提示(structuredContent._audit.before_values)并入 details,
        // 返回剥离 _audit 后的 result(防其传回 MCP 客户端成为半公共 API)
        const { hint: auditHint, result: cleanedResult } = extractAuditHint(result);
        const { files, batch } = inferChangedFiles(auditTool, auditAction, ctx.args, projectPath);
        const auditDetails: Record<string, unknown> | undefined =
          (batch || unmappedDetails || auditHint?.before_values)
            ? {
                ...(batch ? { batch: true } : {}),
                ...(unmappedDetails ?? {}),
                ...(auditHint?.before_values ? { before_values: auditHint.before_values } : {}),
              }
            : undefined;
        try {
          await appendAuditLine(projectPath, {
            timestamp: new Date().toISOString(),
            trace_id: ctx.traceId,
            tool: auditTool,
            action: auditAction,
            risk,
            ok: !isError,
            project_path: projectPath,
            changed_files: files,
            duration_ms: Date.now() - ctx.startTime,
            ...(ctx.caller !== undefined ? { caller: ctx.caller } : {}),  // 1C: best-effort 调用者归因
            ...(auditDetails ? { details: auditDetails } : {}),
          });
        } catch (e) {
          // 1A (2026-09-19): 失败可观测(计数+首次 warn);默认仍不影响工具结果(G2 catch 哲学)。
          recordAuditWriteFailure(e);
          if (isAuditStrict()) {
            // STRICT 模式:审计落盘失败 → 操作判失败(副作用可能已发生,诚实标注)。
            // 不能靠 throw——middleware 框架对 after 抛错是静默吞掉(middleware.ts Phase 3 catch)。
            return opsErrorResult('AUDIT_WRITE_FAILED',
              `Audit write failed in STRICT mode (GODOT_MCP_AUDIT_STRICT=true). ` +
              `The tool's side effects may already have occurred — verify manually. ` +
              `Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return cleanedResult;
      },
    });

    mw.push(createRateLimitMiddleware());

    // B2: 接线 elicitation 强制顶层 required 校验。elicitFn=createElicitFn()(GodotServer
    //     注入 server 后经 MCP elicitInput 协议问用户;未注入时降级纯 required 强制→
    //     顶层 required 缺失返回 MISSING_PARAM)。补 validateCommonArgs 漏检的 action 键
    //     完全缺失 + 为新增工具提供 required 兜底。条件分支 required (oneOf/anyOf)不在此
    //     校验,仍由各工具 handler 自行处理。
    mw.push(createElicitationMiddleware(
      (name: string) => getAllToolDefinitions().find(t => t.name === name) ?? null,
      createElicitFn(),
    ));

    return mw;
  }

  /** Schedule a connection mode change. Applied at the start of the next handleCall
   *  to prevent mid-request mode switches from editor disconnect callbacks (C-01). */
  setConnectionMode(mode: 'headless' | 'editor'): void {
    this._pendingModeSwitch = { mode, executor: this._resolvePendingExecutor() };
  }

  /** Schedule an executor change. Destroys the old executor immediately to release
   *  resources (WebSocket listeners, etc.), but defers the instance assignment to the
   *  next handleCall entry (C-01). This ensures a running handleCall keeps its snapshot
   *  executor reference stable throughout the async operation. */
  setEditorExecutor(executor: EditorToolExecutor | null): void {
    // Destroy old executor immediately — no point keeping dead listeners around
    const currentExec = this._resolvePendingExecutor();
    if (currentExec) {
      currentExec.destroy();
    }
    this._pendingModeSwitch = { mode: this.connectionMode, executor };
  }

  /** I-04: Atomically degrade to headless mode. Avoids two separate calls to
   *  setConnectionMode + setEditorExecutor racing on _pendingModeSwitch. */
  degradeToHeadless(): void {
    const currentExec = this._resolvePendingExecutor();
    if (currentExec) {
      currentExec.destroy();
    }
    this._pendingModeSwitch = { mode: 'headless', executor: null };
  }

  /** Get the effective executor: pending switch takes precedence over current instance. */
  private _resolvePendingExecutor(): EditorToolExecutor | null {
    return this._pendingModeSwitch?.executor ?? this.editorExecutor;
  }

  /** Apply any deferred mode switch. Called at the top of handleCall, outside of any await. */
  private _applyPendingModeSwitch(): void {
    if (this._pendingModeSwitch) {
      this.connectionMode = this._pendingModeSwitch.mode;
      this.editorExecutor = this._pendingModeSwitch.executor;
      this._pendingModeSwitch = null;
    }
  }

  /** 标记 editor fallback 状态（由 GodotServer.run() 调用） */
  markEditorFallback(): void {
    this._editorFallback = true;
  }

  /** I-05: Convert camelCase arg keys to snake_case, recursively for nested plain objects. */
  private static readonly MAX_NORMALIZE_DEPTH = 20;
  private normalizeArgs(rawArgs: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
    if (!rawArgs) {
      return {};
    }
    if (depth > ToolDispatcher.MAX_NORMALIZE_DEPTH) {
      throw new InternalError(`normalizeArgs depth limit (${ToolDispatcher.MAX_NORMALIZE_DEPTH}) exceeded — flatten nested args`);
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      // M-2: 原型污染防护。JSON.parse 会把 {"__proto__":{...}} 作为自有属性保留，Object.entries
      // 列出后 args[snake]=value 对 __proto__ 触发原型 setter（改写对象原型链）；constructor/prototype
      // 同属经典污染入口。直接丢弃这些键（无工具以它们为合法参数名），纵深防御。
      if (snake === '__proto__' || snake === 'constructor' || snake === 'prototype') {
        continue;
      }
      // Recursively normalize nested plain objects (e.g. layout/flex params in UI tools)
      // A-16: Skip class instances (Error, etc.) — only recurse into plain objects
      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
          && Object.getPrototypeOf(value) === Object.prototype) {
        args[snake] = this.normalizeArgs(value as Record<string, unknown>, depth + 1);
      } else {
        args[snake] = value;
      }
    }
    return args;
  }

  /** Validate common arg types (project_path, action). Returns error ToolResult or null. */
  private validateCommonArgs(args: Record<string, unknown>): ToolResult | null {
    if ('project_path' in args) {
      const v = args.project_path;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `project_path must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    if ('action' in args) {
      const v = args.action;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `action must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    return null;
  }

  /**
   * A-10 (advisory): 仅校验根级路径字段(project_path/search_dir)是否在 ALLOWED_PROJECT_PATHS。
   * 其余路径参数(file_path/script_path/scene_path 等)语义多样(res://、项目内相对、绝对路径),
   * 由各工具自行调 resolveWithinRoot 校验——**新增工具须确保其路径参数经过 resolveWithinRoot**,
   * 否则绕过根限制。未做通用扩展因 file_path 等字段语义不一,通用 isPathInAllowedRoots 会误伤。
   */
  private validatePathArgs(args: Record<string, unknown>): ToolResult | null {
    if (typeof args.project_path === 'string' && !isPathInAllowedRoots(args.project_path)) {
      // G2: PII 护栏 — 不把 project_path 原值拼进 message(含绝对路径=PII)。errorCategory 走结构化枚举。
      return opsErrorResult('PATH_NOT_ALLOWED', 'project_path is not in ALLOWED_PROJECT_PATHS. Check your setting.', { errorCategory: 'path' });
    }
    if (typeof args.search_dir === 'string' && !isPathInAllowedRoots(args.search_dir)) {
      return opsErrorResult('PATH_NOT_ALLOWED', 'search_dir is not in ALLOWED_PROJECT_PATHS. Check your setting.', { errorCategory: 'path' });
    }
    return null;
  }

  /**
   * CR-1/CR-2: 基于 args 计算本次调用的 findGodot override。
   * - 有 godot_path → 校验绝对路径 + Godot 二进制后返回固定值
   * - 无 godot_path → 返回项目感知 findGodot(基于 project_path)
   * 抽取为独立方法以便 executeToolCall 入口和 confirm_and_execute 分支
   * (后者须基于 pending.args 而非 confirm_and_execute 自身 args)各自调用。
   */
  private async resolveFindGodotOverride(
    args: Record<string, unknown>,
  ): Promise<{ override: ((projectPath?: string) => Promise<string>) | undefined; error: ToolResult | null }> {
    const godotOverride = typeof args.godot_path === 'string' ? args.godot_path.trim() : undefined;
    const projectPathForGodot = typeof args.project_path === 'string' ? args.project_path : undefined;
    if (godotOverride) {
      // H-02: Validate godot_path is an absolute path (security — prevent relative path tricks)
      // Absolute paths on Windows start with drive letter (C:\), on POSIX with /
      const isAbsolute = godotOverride.startsWith('/') || /^[A-Za-z]:[\\/]/.test(godotOverride);
      if (!isAbsolute) {
        return {
          override: undefined,
          error: opsErrorResult('INVALID_PARAMS', `godot_path must be an absolute path, got: "${godotOverride}"`),
        };
      }
      // H-01: Validate the binary is actually Godot before allowing override
      // D3 (2026-09-17 反馈批次D, 09-06 fr2 反馈): 失败时用分层 stage 组装诊断线索
      // (校验器做了什么/为何判非法)——此前单句 "not a valid Godot binary" 对合法
      // 4.7.2 console exe 被拒场景不给任何排查方向,被迫手动 spawn 绕过(>5min)。
      const { validateGodotBinaryDetailed } = await import('../core/godot-finder.js');
      const check = await validateGodotBinaryDetailed(godotOverride);
      if (!check.ok) {
        // stage 是结构化枚举;stdoutPreview 是 --version 输出(版本串,非路径,无 PII)
        const why = check.stage === 'path-not-allowed'
          ? 'path is outside the GODOT_MCP_ALLOWED_GODOT_PATHS whitelist (env or ~/.godot-mcp/godot-paths.json). Fix: add the binary directory to the whitelist, or unset/clear the stale whitelist.'
          : check.stage === 'is-directory'
            ? 'path is a directory, not the Godot executable. Fix: point at the binary file itself (e.g. Godot_v4.7.2-stable_win64.exe).'
            : check.stage === 'version-run-failed'
              ? 'could not execute the binary with --version (spawn error / non-zero exit / 5s timeout). Fix: verify the file runs from a shell and is not blocked/quarantined.'
              : `--version ran but its output did not match a Godot version signature${check.stdoutPreview ? ` (got: "${check.stdoutPreview}")` : ''}. Expected e.g. "4.7.2.stable.official...".`;
        return {
          override: undefined,
          error: opsErrorResult(
            'INVALID_PARAMS',
            `godot_path failed validation: ${why} ` +
            `(validator pipeline: whitelist check → directory check → run --version (5s timeout) → Godot signature check; path: "${godotOverride}")`,
          ),
        };
      }
      return { override: () => Promise.resolve(godotOverride), error: null };
    }
    // Project-aware findGodot — uses .godot/mcp-godot.json, project.godot [godot_mcp], etc.
    return { override: () => this.options.findGodot(projectPathForGodot), error: null };
  }

  /**
   * P0-2 MRTR: confirm_and_execute 的执行段（从 executeToolCall 提取）。
   * 第一轮（inputRequired 返回）和第二轮（用户确认后）共用此方法。
   * 含二次 guard 检查 + 路径校验 + findGodotOverride + editor/headless 分支。
   */
  private async _confirmExecute(
    pending: { toolName: string; args: Record<string, unknown>; wasTruncated?: boolean },
    startTime: number,
    progressEmitter: ProgressEmitter | undefined,
    currentMode: 'headless' | 'editor',
    currentExecutor: EditorToolExecutor | null,
    clientTasksCapable?: boolean,
  ): Promise<ToolResult> {
    // 二次 guard 检查
    // 批4-T5: 传 pending action 做 action 级只读判定
    const confirmedGuardResult = this.readOnlyGuard.check(pending.toolName, typeof pending.args.action === 'string' ? pending.args.action : undefined);
    if (confirmedGuardResult.blocked) {
      return opsErrorResult(String(confirmedGuardResult.errorCode ?? 'READ_ONLY'), confirmedGuardResult.message ?? 'Operation blocked in read-only mode');
    }

    // 二次路径校验（pending.args 可能包含与外层 args 不同的 project_path）
    const confirmedPathErr = this.validatePathArgs(pending.args);
    if (confirmedPathErr) return confirmedPathErr;

    // CR-2: 基于 pending.args 重新计算 findGodotOverride
    const { override: confirmedFindGodotOverride, error: confirmedFindGodotErr } =
      await this.resolveFindGodotOverride(pending.args);
    if (confirmedFindGodotErr) return confirmedFindGodotErr;

    // editor/headless 分支逻辑复用 _dispatchEditorOrHeadless(与 executeToolCall 共用)
    log('[CONFIRM] Executing confirmed tool: %s', pending.toolName);
    return this._dispatchEditorOrHeadless(pending.toolName, pending.args, currentMode, currentExecutor, startTime, confirmedFindGodotOverride, progressEmitter, clientTasksCapable);
  }

  /** B-1 修复(审查):confirm_and_execute 真实执行后补审计。
   *  _confirmExecute → dispatchTool 绕过 executeMiddleware,audit middleware 接不到;
   *  且外层 confirm_and_execute 的 ctx.action='' 会被 audit 跳过。故此处用 pending 的
   *  真实 tool/action/risk + 真实执行结果显式补一条审计(details.confirmed=true 标记)。
   *  1A (2026-09-19): 返回 auditFailed——STRICT 模式下调用方据此把结果改判失败。 */
  private async _auditConfirmedExecution(
    pending: { toolName: string; args: Record<string, unknown> },
    startTime: number,
    result: ToolResult,
    traceId: string,
    callerAgentId?: string,
  ): Promise<{ strict: boolean; result: ToolResult }> {
    // 全 body 包 try/catch:审计是 best-effort side effect,任何失败(含 mock 环境 getActionRisk
    // 未提供 / 路径不可写 / inferChangedFiles 异常)都不影响工具结果(对齐 G2 catch 哲学;
    // 1A:失败计数+首次 warn,STRICT 模式返回 strict=true 由调用方改判)。
    // 批4-T3: 返回剥离 _audit 后的 result——confirm 路径绕过 middleware,由本函数统一
    // 完成审计提示提取(与 middleware after hook 同款 extractAuditHint)与剥离。
    try {
      if (!isAuditEnabled()) return { strict: false, result: extractAuditHint(result).result };  // N-2(审查): early-return 也剥离 _audit
      // C-3 (2026-08-14): 与 audit middleware 同步接 resolveDynamicTool 反查 ——
      // pending.toolName 可能是动态平铺名(engine_call_method),平铺名 getActionRisk
      // 恒 undefined → 确认执行的动态写操作零审计。反查回静态 (tool, action) 再判风险/落盘。
      const auditDynMap = isDynamicToolName(pending.toolName) ? resolveDynamicTool(pending.toolName) : undefined;
      const unmappedDynamic = isDynamicToolName(pending.toolName) && !auditDynMap;
      const auditTool = auditDynMap?.tool ?? pending.toolName;
      const auditAction = auditDynMap?.action ?? String(pending.args.action ?? '');
      let risk = getActionRisk(auditTool, auditAction);
      // 1B (2026-09-19): 与 audit middleware 的 fail-closed 对齐——risk 未知按保守档落审计。
      // (确认门未映射动态工具 fail-closed 强制确认在先,此处正常不可达,防御性对齐;
      //  I-1 同款 readonly 豁免:readonly 工具不可能进 confirm 路径,防御性 return。)
      let unmappedDetails: Record<string, unknown> | undefined;
      if (!risk) {
        if (isReadOnly(auditTool)) return { strict: false, result: extractAuditHint(result).result };  // N-2(审查): early-return 也剥离 _audit
        risk = 'write';
        unmappedDetails = unmappedDynamic ? { dynamic_unmapped: true } : { risk_unknown: true };
      }
      if (risk === 'read') return { strict: false, result: extractAuditHint(result).result }; // confirm 的都是非 read,防御;仍剥离 _audit
      const projectPath = (typeof pending.args.project_path === 'string' && pending.args.project_path)
        ? pending.args.project_path : resolveProjectPath();
      if (!projectPath) return { strict: false, result: extractAuditHint(result).result };
      const isError = result.isError === true || this.checkJsonSuccessFalse(result);
      const { hint: auditHint, result: cleanedResult } = extractAuditHint(result);
      const { files } = inferChangedFiles(auditTool, auditAction, pending.args, projectPath);
      await appendAuditLine(projectPath, {
        timestamp: new Date().toISOString(),
        trace_id: traceId,
        tool: auditTool,
        action: auditAction,
        risk,
        ok: !isError,
        project_path: projectPath,
        changed_files: files,
        duration_ms: Date.now() - startTime,
        ...(callerAgentId !== undefined ? { caller: callerAgentId } : {}),  // 1C: best-effort 调用者归因
        details: {
          confirmed: true, // 标记:确认后真实执行(区别于令牌请求的虚假记录)
          ...(unmappedDetails ?? {}),
          ...(auditHint?.before_values ? { before_values: auditHint.before_values } : {}),  // 批4-T3
        },
      });
      return { strict: false, result: cleanedResult };
    } catch (e) {
      // 1A:审计失败可观测(计数+首次 warn);默认不影响工具结果
      recordAuditWriteFailure(e);
      return { strict: isAuditStrict(), result: extractAuditHint(result).result };
    }
  }

  /**
   * editor/headless dispatch 共用逻辑(executeToolCall 与 _confirmExecute 复用,消除重复)。
   * editor 模式:currentExecutor.execute;-32601 unknown method 自动回退 headless(P1-1:
   *  command_handler 只认扁平 method,TS 工具 (tool,action) 命名转发落 -32601 静默失效,
   *  检测到 -32601 回退让非编辑器原生工具在 editor 模式仍可用;isError 前置避免误判)。
   * headless 模式:dispatchTool(findGodotOverride 必传,CR-1)。
   */
  private async _dispatchEditorOrHeadless(
    toolName: string,
    args: Record<string, unknown>,
    currentMode: 'headless' | 'editor',
    currentExecutor: EditorToolExecutor | null,
    startTime: number,
    findGodotOverride: ((projectPath?: string) => Promise<string>) | undefined,
    progressEmitter: ProgressEmitter | undefined,
    taskAugmented?: boolean,
  ): Promise<ToolResult> {
    if (currentMode === 'editor' && currentExecutor) {
      const logger = getLogger();
      const callId = logger.toolStart(toolName, args, this._toolLogProject(args));
      const editorResult = await currentExecutor.execute(toolName, args);
      // isError 前置:只在 editor 报错时才检测 -32601,避免 plugin 成功响应顶层带数字 code
      // 被误判 unknown method 触发静默降级(见 ToolDispatcher.test「isError guard」负面用例)。
      if (editorResult.isError === true && this._isUnknownMethod(editorResult)) {
        logger.toolEnd(callId, toolName, Date.now() - startTime, 'editor_unknown_method_fallback');
        return this.attachFallbackWarning(await this.dispatchTool(toolName, args, startTime, findGodotOverride, progressEmitter, taskAugmented));
      }
      const duration = Date.now() - startTime;
      logger.toolEnd(callId, toolName, duration);
      // I-08: Only append _duration_ms if the editor plugin didn't already include it
      const hasDuration = editorResult.content?.some((c: { type?: string; text?: string }) =>
        typeof c.text === 'string' && c.text.startsWith('_duration_ms:'));
      const content = hasDuration
        ? editorResult.content
        : [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }];
      return this.attachFallbackWarning(truncateResponse({ ...editorResult, content }));
    }
    // CR-1: 必须传入 findGodotOverride,否则 perCallCtx 回退 this.ctx.findGodot,
    // 导致 godot_path 参数和项目感知 findGodot 在最常用路径失效。
    return this.attachFallbackWarning(await this.dispatchTool(toolName, args, startTime, findGodotOverride, progressEmitter, taskAugmented));
  }

  /** §4.6(设计):tool 日志的 project 归属——args.project_path 优先(runtime 域工具自然
   *  携带),缺省活跃桶;均无则 undefined(logger 不写该字段,勿强造)。 */
  private _toolLogProject(args: Record<string, unknown>): string | undefined {
    const p = args.project_path;
    if (typeof p === 'string' && p) return p;
    return ps.getProjectDir() || undefined;
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number, findGodotOverride?: ((projectPath?: string) => Promise<string>), progressEmitter?: ProgressEmitter, taskAugmented?: boolean): Promise<ToolResult> {
    let targetMod = getModuleForTool(toolName);
    let effectiveToolName = toolName;
    let effectiveArgs = args;

    // ── Legacy fallback: 旧工具名 → 新 (tool, action) ──
    if (!targetMod) {
      const legacy = tryLegacyMapping(toolName);
      if (legacy) {
        effectiveToolName = legacy.tool;
        effectiveArgs = { ...args, action: legacy.action };
        targetMod = getModuleForTool(effectiveToolName);
      }
    }

    if (!targetMod) {
      return opsErrorResult('UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
    }

    const logger = getLogger();
    const callId = logger.toolStart(effectiveToolName, effectiveArgs, this._toolLogProject(effectiveArgs));

    let result: ToolResult | null;
    try {
      // C-CONC-1: per-call findGodot 经参数传入(局部变量),避免实例字段被并发请求覆盖
      // 用 buildPerCallCtx(Object.create)而非 spread,保留 ctx getter(见该函数注释)
      // PR-2 Task 4: taskAugmented 同为 per-request 态(C-CONC-1 模式),随调用链显式传入
      const perCallCtx = buildPerCallCtx(this.ctx, findGodotOverride, progressEmitter, taskAugmented);
      // P1-2 (2026-07-06 review): editor 文本资源/场景写守卫注入。editorExecutor 可用(非 null)时
      // 注入回调; script.ts/scene 写前调, 经 WS 调编辑器 guard_text_resource_write/guard_offline_scene_save,
      // 防 TS writeFileSync 绕过编辑器内存状态守卫致磁盘/内存版本撕裂。headless 模式 editorExecutor=null 不注入。
      if (this.editorExecutor) {
        perCallCtx.checkEditorTextResourceWrite = (p: string) => this._checkEditorGuard('guard_text_resource_write', p);
        perCallCtx.checkEditorSceneSave = (p: string) => this._checkEditorGuard('guard_offline_scene_save', p);
      }
      // P1-7 (SEP-2577): per-request logLevel 包裹在 handleCall 层(withRequestLogLevelAsync
      // 包裹 executeMiddleware),此处 dispatchTool 内的工具调用自动继承 _currentRequestLogLevel。
      result = await targetMod.handleTool(effectiveToolName, effectiveArgs, perCallCtx);
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.toolEnd(callId, effectiveToolName, duration, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const duration = Date.now() - startTime;

    if (result !== null) {
      // 判断是否有错误（使用 MCP 标准的 isError 字段）
      const hasError = result.isError === true;
      logger.toolEnd(callId, effectiveToolName, duration, hasError ? 'tool_error' : undefined);
      return truncateResponse({ ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
    }
    logger.toolEnd(callId, effectiveToolName, duration, 'handler_null');
    return opsErrorResult('HANDLER_NULL', `Tool "${effectiveToolName}" registered but handler returned null`);
  }

  /** P1-1 (2026-07-06 review): 检测 editor 返回是否 -32601 Unknown method
   * (command_handler 不认此 method — TS (tool,action) 工具转发后常见)。 */
  private _isUnknownMethod(result: ToolResult): boolean {
    for (const block of result.content ?? []) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const parsed = JSON.parse(block.text) as { error?: { code?: number }; code?: number };
        // 认嵌套 {error:{code}} 与平铺 {error,code}（后者是 EditorToolExecutor I-12
        // 对 WS error 的结构化拍平形态，见 EditorToolExecutor.ts catch 分支）。
        if (parsed.error?.code === -32601 || parsed.code === -32601) return true;
      } catch { /* not JSON */ }
    }
    return false;
  }

  /**
   * P1-2 (2026-07-06 review): 经 WS 调编辑器 guard, 返回是否阻塞写。
   * - editorExecutor 不可用(null) → 放行(headless 无编辑器状态可守)
   * - 编辑器返回 -32009(状态冲突: 打开的脚本/缓存 Resource/打开的场景) → 阻塞
   * - 其他(guard 放行 ok / -32003 guards 不可用 / 连接错误) → 放行(不静默吞, 调用方据 blocked 决定)
   */
  private async _checkEditorGuard(
    method: 'guard_text_resource_write' | 'guard_offline_scene_save',
    path: string,
  ): Promise<{ blocked: boolean; code?: number; message?: string }> {
    if (!this.editorExecutor) return { blocked: false };
    try {
      const result = await this.editorExecutor.execute(method, { path });
      const first = result.content?.[0];
      const text = first?.type === 'text' ? first.text : '{}';
      const parsed = JSON.parse(text) as { error?: { code?: number; message?: string } };
      if (parsed.error?.code === -32009) {
        return { blocked: true, code: -32009, message: parsed.error.message };
      }
      return { blocked: false };
    } catch {
      return { blocked: false };
    }
  }

  private attachFallbackWarning(result: ToolResult): ToolResult {
    if (this._editorFallback && !this._editorFallbackWarned) {
      this._editorFallbackWarned = true;
      const first = result.content?.[0];
      if (first?.type === 'text') {
        // H-04: Create new content array and text block instead of mutating original
        return {
          ...result,
          content: [
            { type: 'text' as const, text: first.text + '\n\n⚠️ [EDITOR_FALLBACK] Running in Headless mode — Editor features (UndoRedo, live scene sync) unavailable.' },
            ...result.content.slice(1),
          ],
        };
      }
    }
    return result;
  }

  /** Parse content blocks and check for logical failure.
   *
   * Phase 1 升级:改用 response-format.ts 的 isErrorText,覆盖多种 error shape。
   * 旧实现只检测 {success:false} 一种,漏判 {ok:false} / {error:string} / {error:{message}} /
   * {error_code, message} 形态的逻辑失败(对标 unity-mcp-server response-format.js:31-41)。
   */
  private checkJsonSuccessFalse(result: ToolResult): boolean {
    if (!result.content) return false;
    // F-2: JSON shape 检测对所有 block 启用(结构化错误可在任意 block);
    // 但 /^Error[:\s]/ 纯文本前缀检测仅对首个 text block 启用,避免工具返回的
    // 用户文本(如 screenshot question="Error: ...")被误判为工具失败。
    let seenTextBlock = false;
    for (const block of result.content) {
      if ("text" in block && typeof block.text === "string") {
        const isFirst = !seenTextBlock;
        seenTextBlock = true;
        if (isErrorText(block.text, { checkTextPrefix: isFirst })) return true;
      }
    }
    return false;
  }
}

/**
 * 构建每次工具调用的 ctx 副本(覆盖 findGodot)。
 *
 * 必须用 Object.create(继承 this.ctx 原型),而非 spread {...this.ctx}:ctx 上的
 * runningProcess/outputBuffer/processStartTime/projectDir 是连 process-state 模块的 getter,
 * spread 会把它们展平成调用时刻的快照。dispatch 入口 _runningProcess=null,spread 后
 * perCallCtx.runningProcess 被冻结成 null —— 即便 run_project 内 setRunningProcess(proc) 改了
 * 模块 state,perCallCtx.runningProcess 仍为 null,isCancelled(runningProcess !== proc)永远 true,
 * 导致 wait_for_bridge 误报 "process exited during probe"。Object.create 让 perCallCtx 继承 getter,
 * runningProcess 实时反映模块 state。
 */
export function buildPerCallCtx(
  baseCtx: ToolContext,
  findGodotOverride?: (projectPath?: string) => Promise<string>,
  progressEmitter?: ProgressEmitter,
  taskAugmented?: boolean,
): ToolContext {
  const perCallCtx = Object.create(baseCtx) as ToolContext;
  perCallCtx.findGodot = findGodotOverride ?? baseCtx.findGodot;
  // Task 3: 注入 per-request progress emitter（progress 是新增字段非 getter，不破坏 Object.create 继承机制）
  if (progressEmitter) {
    perCallCtx.progress = progressEmitter;
  }
  // PR-2 Task 4: 注入 per-request taskAugmented(同为新增字段非 getter)。仅 true 时显式
  // 赋值,false/undefined 时保持继承态(baseCtx 不设此字段 → undefined),避免遮蔽。
  if (taskAugmented === true) {
    perCallCtx.taskAugmented = true;
  }
  return perCallCtx;
}
