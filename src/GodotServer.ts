import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";

// P1-3: legacy era 版本列表(SDK core SUPPORTED_PROTOCOL_VERSIONS 的快照,避免测试 mock 耦合)。
// SDK 更新此列表时需同步(低频,约每年新版本);核实命令:
//   node -e "console.log(require('@modelcontextprotocol/server').SUPPORTED_PROTOCOL_VERSIONS)"
// 追加 '2026-07-28' 实现双时代 opt-in(modern era)。
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
] as const;
import { join } from 'path';
import { z } from 'zod';
import { readInstructions } from './core/instructions.js';
import { registerBridgePushHandler, setBridgeProjectDir } from './tools/game-bridge.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';
import { listPrompts, getPrompt, handleCompletion } from './prompts.js';

// ─── Import and register tool modules ────────────────────────────────────────
// C-ARCH-01: All tool modules centralized in module-loader.ts
import { registerAllModules } from './module-loader.js';
import { setToolCallDelegate, setDynamicSender } from './tools/advanced-proxy.js';
import { setMcpServer, clearMcpServer } from './core/tool-registry.js';
registerAllModules();


import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkgVersion = require('../package.json').version;
import { ReadOnlyGuard } from './core/ReadOnlyGuard.js';
import { ToolDispatcher } from './core/ToolDispatcher.js';
import { reportOrphanedInflight, clearAllInflight } from './core/inflight.js';
import * as guard from './core/guard.js';
import { EditorConnectionManager } from './core/EditorConnectionManager.js';
import { dynamicSchema } from './core/dynamic-schema.js';
import { getAllToolNames, registerDynamicTools } from './core/tool-registry.js';
import { findGodot, clearGodotPathCache, getCachedGodotPath } from './core/godot-finder.js';
import { setOnGroupsChanged, setConnectionStatusProvider, setReconnectEditor, buildConnectionStatus, buildReconnectEditor } from './tools/manage-tools.js';
import { setGetContextConnectionProvider, setEditorSceneProvider } from './tools/get-context.js';
import { InstanceManager, buildInstanceInfo } from './core/instance-manager.js';
import { InstanceRouter, type RouterDependencies } from './core/instance-router.js';
import { setInstanceManager, setInstanceRouter } from './tools/instance-tools.js';
import { cancelAndAwaitWorkingRun, getRun, listRuns, requestCancel, setTerminalNotifier } from './tools/qa/registry.js';
import { toWireTask, toTaskPayload, assertTaskWire } from './tools/qa/task-view.js';
import { appendAuditLine, isAuditEnabled } from './core/audit-log.js';
import { buildAuthHeaders } from './core/instance-api-auth.js';
import { InstanceHttpServer } from './core/instance-http-server.js';
import { isFeatureEnabled } from './core/feature-flags.js';
import * as ps from './core/process-state.js';
import { WebGuiServer } from './web-gui/server.js';
import { INDEX_HTML } from './web-gui/html.js';
import { getLogger, setLoggerServer, setLoggerClientReady } from './core/logger.js';
import { setProgressSender, setProgressClientReady } from './core/progress.js';
import { setElicitServer } from './core/elicit.js';
import { resolveProjectPath } from './core/path-utils.js';
import { AgentContextManager } from './core/agent-context.js';
import { FileStateStore } from './core/state-store.js';

// Re-export for backward compatibility (tests import from GodotServer)
export { clearGodotPathCache, getCachedGodotPath };

const DEBUG = process.env.DEBUG === 'true';

function log(...args: unknown[]): void {
  if (!DEBUG) return;
  getLogger().debug('godot-mcp', args.map(a => String(a)).join(' '));
}

// ─── GodotServer class ───────────────────────────────────────────────────────

// ─── Server options ───────────────────────────────────────────────────────────

export interface ServerOptions {
  mode?: string;
  connectionMode?: 'headless' | 'editor';
  readOnly?: boolean;
  noFallback?: boolean;
  /** P2-1: --overrides CLI flag 指定的默认 override 脚本路径列表,graceful shutdown 时批量卸载 */
  overrides?: string[];
}

export class GodotServer {
  private server: Server;
  private opsScript: string;
  private options: ServerOptions;
  private readOnlyGuard: ReadOnlyGuard;
  private dispatcher: ToolDispatcher | null = null;
  private connectionMode: 'headless' | 'editor';
  // P1 架构修复: editor 连接生命周期(WS + executor + heartbeat + 降级)抽到 EditorConnectionManager。
  // 通过 host 回调(onConnected/onDegrade)同步本类的 connectionMode 字段。
  private editorMgr: EditorConnectionManager | null = null;
  private noFallback: boolean;
  private agentCtx: AgentContextManager;
  private stateStore: FileStateStore | null = null;
  // 报告②P0：周期性 orphan 扫描定时器。60s 间隔（规避 killOrphanGodotProcesses 内部 30s 节流）。
  // unref 不阻塞进程退出；close() 时 clearInterval。参考 agent-context.ts:46 / health-monitor.ts:320。
  private orphanScanTimer: ReturnType<typeof setInterval> | null = null;
  // 行225 MULTI_INSTANCE 接收端：HTTP server + 心跳 + 本实例 id（initMultiInstance 启动，close 清理）。
  private httpReceiver: InstanceHttpServer | null = null;
  private instanceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private selfInstanceId: string | null = null;
  // K-1 (:942①): 已订阅资源 URI 集合。resources/subscribe 记录 / unsubscribe 与 close 清除。
  // push 事件(notifications/resources/updated)只发 Set 内 URI 的订阅者,对齐 MCP 协议
  // "should only be sent if the client previously sent a resources/subscribe request"
  // 与 watch_start/monitor_start push 模式文档"client 需订阅 resources/subscribe 才能收到"。
  // stdio 单客户端:断连即进程退出,无跨连接泄漏;close() 仍 clear 以支持热重启/测试隔离。
  private resourceSubscriptions = new Set<string>();
  // Web GUI(spec 2026-09-14 §3.2):server 进程内嵌监控面板;附属功能,启动失败降级禁用。
  private webGuiServer: WebGuiServer | null = null;
  /** run() 完成后已定(设计 B-2):index.ts 的 TUI 决策查询点。 */
  webGuiActive = false;

  constructor(opsScript: string, options: ServerOptions = {}) {
    this.opsScript = opsScript;
    this.options = options;
    this.readOnlyGuard = new ReadOnlyGuard(options.readOnly ?? false);
    // P4-3 (2026-09-11): 启动时报丧——上个 server 进程非正常退出时留下的 in-flight 记录
    // 走 stderr(stdout 是 MCP transport),把"进程被杀的静默损失"变成可诊断事件。
    reportOrphanedInflight();
    this.connectionMode = options.connectionMode ?? 'headless';
    this.noFallback = options.noFallback ?? false;
    this.agentCtx = new AgentContextManager();
    this.server = new Server(
      { name: 'godot-mcp-enhanced', version: pkgVersion },
      {
        // P1-4: 补全 listChanged 声明。enhanced 实际会发 notifications/tools/list_changed
        // (manage_tools activate/deactivate 触发),但此前 capabilities 未声明 → 客户端可能
        // 忽略通知。声明后客户端才会订阅,配合 ttlMs 让缓存能在切组时立即失效。
        capabilities: {
          tools: { listChanged: true },
          // K-1 (:942①): 补 subscribe:true 声明。enhanced 实际处理 resources/subscribe(:267 附近
          // 记录订阅 URI),push 事件(notifications/resources/updated)只发已订阅客户端;
          // 此前未声明 → 规范客户端不订阅,push 广播违反 MCP 协议"should only be sent if
          // the client previously sent a resources/subscribe request"。
          resources: { listChanged: true, subscribe: true },
          prompts: { listChanged: true },
          completions: {},
          // P1-7 (SEP-2577): emit notifications/message 的 server MUST 声明 logging capability。
          // 此前未声明 → SDK sendLoggingMessage 静默 no-op(logger.ts:155 warn/error 推送失效),
          // 且 GodotServer 直发 notification(notifications/message) 抛 SdkError 被 catch 吞。
          // K-2 (:942④): setLevel handler 无需显式注册——SDK 2.x Server 构造时若声明 logging
          // capability 会自动注册内置 logging/setLevel handler(维护 per-session _loggingLevels,
          // sendLoggingMessage 的 isMessageIgnored 按它过滤)。实测(build 后 InMemoryTransport)
          // 客户端调用返回 {"result":{}},不会 method not found。⚠️ 此处若再 setRequestHandler
          // ('logging/setLevel',...) 会 Map.set 覆盖内置 handler → 丢 _loggingLevels 状态维护,
          // 引入回归。勿重复注册(见 test/k-subscribe-setlevel.test.ts 行为锁定测试)。
          logging: {},
          // PR-2 (2025-11-25 tasks wire):tasks 族协议 method 上线(qa run 注册表 → wire Task)。
          // era-gated——2026 era 客户端在 SDK 分发层即 METHOD_NOT_FOUND,无害(spec §3.2);
          // SDK 无 task 运行时(类型层将 tasks 词汇从 RequestMethod 排除),handler 自建。
          // 通知能否真正发出由 _notificationViaCodec 的协商 era 检查决定(2024 era 客户端连
          // tasks/status 通知也收不到,codec 拒后由外层 catch 吞);assertNotificationCapability
          // 的 switch 无该 case,不构成门控(T3 审查 Minor-1 纠偏)。声明本身是协议正确性要求。
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
          // P2-5 (SEP-2133): extensions 声明让 modern-era 客户端发现 enhanced 的 runtime-bridge 能力。
          // ⚠️ era-gated:extensions 是 2026-07-28 引入,legacy-era 客户端不认识 → SDK encode 时 strip,对 legacy 无害。
          // runtime-bridge:TCP 通道(game_query/input/write/wait + 确定性 playtest 四原语 P2-4)。
          // 注:具体 method(如 bridge.status)待 SDK extensions method routing 成熟后补,当前为发现性声明。
          extensions: {
            'io.godot-mcp/runtime-bridge': {
              description: 'Godot runtime bridge: TCP channel for game queries/inputs/asserts and deterministic playtest (seed/fixed_delta/step/snapshot/restore)',
              version: '1',
              capabilities: ['game_query', 'game_input', 'game_write', 'game_wait', 'game_playtest', 'install_override'],
            },
          },
        },
        instructions: readInstructions(),
        // P1-4 (SEP-2549): 为 cacheable result 提供 ttlMs/cacheScope 提示。
        // ⚠️ era-gated:SDK v2 的 fillCacheFields 只在 modern-era(2026-07-28+)encodeResult 跑。
        // enhanced 当前默认 supportedProtocolVersions 仅 legacy era,故 cacheHints 当前对客户端是 no-op
        // (配置合法,SDK 不报错;面向未来准备 —— enhanced opt-in modern era 或 SDK 默认支持 modern 版本后生效)。
        // 策略依据:工具/prompts/模板清单启动后基本静态(仅 manage_tools 主动切组时变,
        // 已配 listChanged 通知立即失效缓存);resources 依赖 project_path 且文件可变,短 TTL + private。
        cacheHints: {
          'tools/list': { ttlMs: 300_000, cacheScope: 'public' },         // 5min,工具清单所有用户相同
          'prompts/list': { ttlMs: 600_000, cacheScope: 'public' },        // 10min,prompts 启动后静态
          'resources/list': { ttlMs: 60_000, cacheScope: 'private' },      // 1min,依赖 project_path(用户特定)
          'resources/templates/list': { ttlMs: 600_000, cacheScope: 'public' }, // 10min,模板静态
          'resources/read': { ttlMs: 30_000, cacheScope: 'private' },      // 30s,读取特定资源,短 TTL
          'server/discover': { ttlMs: 300_000, cacheScope: 'public' },     // 5min,服务器能力静态
        },
        // P1-3 (SEP-2575): opt-in modern era(2026-07-28)。SDK 检测到 modern 版本后:
        // 1) 自动注册 server/discover handler(_ondiscover,返 supportedVersions+capabilities)
        // 2) 启用 modern codec → fillCacheFields(cacheHints 上 wire)+ envelope lift(logLevel 等 reserved key 搬到 ctx.mcpReq.envelope)
        // 双时代自动:legacy 客户端仍走 initialize 握手 + oninitialized;modern 客户端走 server/discover + per-request _meta。
        // Roots 影响:v0.30 D 批已退役 MCP Roots 动态授权(2026-07-28 规范废弃),
        // 路径白名单统一走 ALLOWED_PROJECT_PATHS env——详见 docs/protocol-debt-2026-07-28.md。
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, '2026-07-28'],
      }
    );
    setMcpServer(this.server);
    setLoggerServer(this.server);
    setProgressSender(this.server);
    setElicitServer(this.server);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // PR-2 (2025-11-25 tasks wire): 终态通知——仅当客户端声明 tasks 能力时发(协议要求);best-effort。
    // 通知通道单点 as never:'notifications/tasks/status' 不在 SDK NotificationMethod
    // (类型层排除 2025-11-25 词汇),运行时通道可用(InMemoryTransport 实测客户端可收)。
    setTerminalNotifier((runId, status) => {
      try {
        const caps = this.server.getClientCapabilities();
        if (!caps?.tasks) return;
        const r = getRun(runId);
        if (!r) return;
        void this.server.notification({
          method: 'notifications/tasks/status',
          params: {
            taskId: r.taskId, status,
            ttl: Math.round(r.ttl / 1000),
            createdAt: r.createdAt, lastUpdatedAt: r.lastUpdatedAt,
          },
        } as never).catch(() => { /* best-effort:transport send 中途失败(如对端刚断)静默 */ });
      } catch { /* best-effort:通知失败不影响注册表状态写入 */ }
    });

    const dispatcher = new ToolDispatcher({
      readOnly: this.options.readOnly ?? false,
      mode: this.options.mode ?? 'full',  // G7 审查 O1 defer: 兜底保持 full(godot-server.test 假设;生产经 index.ts 默认 basic,O1 一致性 defer 到未来统一)
      readOnlyGuard: this.readOnlyGuard,
      connectionMode: this.connectionMode,
      noFallback: this.noFallback,
      opsScript: this.opsScript,
      findGodot,
      toolCallDelegate: setToolCallDelegate,
      agentContext: this.agentCtx,
    });
    this.dispatcher = dispatcher;

    this.server.setRequestHandler('tools/list', async () => {
      // CMP-16-B (2026-08-08): merge 动态工具(live schema 从 editor addon 拉取)。
      // 静态工具先过滤(getFilteredTools),再追加动态工具(经 isToolAllowed 在调用层放行)。
      const staticTools = dispatcher.getFilteredTools();
      const dynamicTools = await mergeDynamicTools(staticTools);
      return { tools: [...staticTools, ...dynamicTools] };
    });

    this.server.setRequestHandler('tools/call', (request, ctx) =>
      // PR-2 Task 4: per-request 读客户端 tasks 能力(tools/call task-augmented 协商)传入
      // dispatcher → ctx.taskAugmented(qa run 据此自动 async + _meta.relatedTask 回指)。
      // initialize 握手后才有值;未声明/未握手 → false,保持 sync 现状。
      dispatcher.handleCall(request, ctx, !!this.server.getClientCapabilities()?.tasks)
    );

    // ── PR-2 (2025-11-25 tasks wire):tasks/get|list|cancel|result ─────────────
    // SDK 类型层将 tasks 族 method 从 RequestMethod 排除(2025-11-25 词汇无 SDK 运行时,
    // wire schema 仅为互操作保留解析),故走 3 参 schema 重载的字符串 method 通道:
    // params 由 SDK zod 校验(缺 taskId → -32602),handler 抛普通 Error → SDK 转 -32603。
    // era 门控由 SDK 分发层兜底:未注册(本 server)或 2026 era 客户端 → METHOD_NOT_FOUND。
    const TaskIdParams = z.object({ taskId: z.string() });

    this.server.setRequestHandler('tasks/get', { params: TaskIdParams }, async ({ taskId }) => {
      const r = getRun(taskId);
      if (!r) throw new Error(`task not found: ${taskId}(server 可能已重启;qa report 可读落盘报告)`);
      const t = toWireTask(r);
      assertTaskWire(t);
      return t;
    });

    this.server.setRequestHandler('tasks/list', { params: z.object({}) }, async () => ({
      tasks: listRuns().map(r => { const t = toWireTask(r); assertTaskWire(t); return t; }),
    }));

    this.server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async ({ taskId }) => {
      const r = getRun(taskId);
      if (!r) throw new Error(`task not found: ${taskId}`);
      const res = requestCancel(taskId);
      if (!res.ok) throw new Error(`cannot cancel: ${res.message}`);
      // B-3 裁定:免二次 elicitation(启动已过 confirm 门)但必须 audit 留痕。
      // AuditEntry 字段照 src/cli/qa.ts auditRun 先例同构(best-effort,失败由 catch 吞)。
      if (isAuditEnabled()) {
        try {
          await appendAuditLine(r.project_path, {
            timestamp: new Date().toISOString(),
            trace_id: `tasks-cancel-${taskId}`,
            tool: 'qa',
            action: 'tasks/cancel',
            risk: 'process',
            ok: true,
            project_path: r.project_path,
            changed_files: [],
            duration_ms: 0,
          });
        } catch { /* best-effort(与 dispatcher 审计哲学一致:失败由 catch 吞) */ }
      }
      const t = toWireTask(r);
      assertTaskWire(t);
      return t;
    });

    this.server.setRequestHandler('tasks/result', { params: TaskIdParams }, async ({ taskId }) => {
      const r = getRun(taskId);
      if (!r) throw new Error(`task not found: ${taskId}`);
      return { payload: toTaskPayload(r) };  // working 时 toTaskPayload 抛 → SDK 转 JSON-RPC error
    });

    // ── MCP Resources handlers ──────────────────────────────────────────────
    this.server.setRequestHandler('resources/list', async () => {
      const projectPath = resolveProjectPath();
      const resources = listMcpResources(projectPath);
      return { resources };
    });

    this.server.setRequestHandler('resources/templates/list', async () => {
      const templates = listMcpResourceTemplates();
      return { resourceTemplates: templates };
    });

    this.server.setRequestHandler('resources/read', async (request) => {
      const { uri } = request.params;
      const projectPath = resolveProjectPath();
      const content = await readMcpResource(uri, projectPath);
      return { contents: [content] };
    });

    // Connect manage-tools notification callback
    setOnGroupsChanged(() => this.sendToolListChanged());
    // P1 架构修复: editor 连接访问统一经 editorMgr.getConn()(editor 模式 run() 时构造,headless 时为 null)。
    setConnectionStatusProvider(() => buildConnectionStatus(this.editorMgr?.getConn() ?? null, this.dispatcher?.getHealthMonitor() ?? null));
    setGetContextConnectionProvider(() => buildConnectionStatus(this.editorMgr?.getConn() ?? null, this.dispatcher?.getHealthMonitor() ?? null));
    setEditorSceneProvider(async () => {
      const conn = this.editorMgr?.getConn();
      if (!conn?.isConnected()) return null;
      try {
        const result = await conn.request('editor_get_scene_stats', {});
        return (result as { stats?: { path: string; root: string; nodeCount: number; typeTopN?: Array<{ type: string; n: number }>; truncated?: boolean } | null })?.stats ?? null;
      } catch {
        return null;  // editor error（如 NO_SCENE -32005）→ null 降级
      }
    });
    // CMP-16-B (2026-08-08): 注入 dynamic-schema fetcher(live schema 从 editor addon 拉 param docs)。
    // editor 离线时 fetcher 返回 null → dynamicSchema 降级空数组(只留 godot_advanced_tool 兜底)。
    dynamicSchema.setFetcher(async () => {
      const conn = this.editorMgr?.getConn();
      if (!conn?.isConnected()) return null;
      try {
        const result = await conn.request('list_param_docs', {});
        return (result as { result?: Record<string, unknown> } | null)?.result as Record<string, { description: string; params: Array<{ name: string; type: string; required: boolean; desc: string }> }> ?? null;
      } catch {
        return null;  // editor 离线/超时 → null 降级
      }
    });
    setReconnectEditor(buildReconnectEditor(
      () => this.editorMgr?.getConn() ?? null,
      () => this.editorMgr?.rebuild() ?? Promise.resolve({ connected: false, detail: 'editor manager not initialized' }),
    ));

    // ── MCP Prompts handlers (Phase 5b) ────────────────────────────────────────
    this.server.setRequestHandler('prompts/list', async () => ({
      prompts: listPrompts(),
    }));

    this.server.setRequestHandler('prompts/get', async (request) => {
      const { name, arguments: promptArgs } = request.params;
      return getPrompt(name, (promptArgs ?? {}) as Record<string, string>);
    });

    // ── MCP Prompt Completion handler（Phase P2-6）──────────────────────────
    this.server.setRequestHandler('completion/complete', async (request) => {
      const { ref, argument } = request.params;
      return handleCompletion(
        ref as { type: string; name: string },
        argument as { name: string; value: string },
        resolveProjectPath(),
      );
    });

    // P3-6 + K-1 (:942①): Subscriptions/listen — bridge 事件主动推送
    // resources/subscribe: 客户端订阅(K-1 起记录 URI,返回 EmptyResult;重复订阅幂等——Set.add 天然去重)
    // resources/unsubscribe: 取消订阅(URI 出 Set 后 push 不再发)
    // bridge/event push:addon 侧 watch/monitor push 模式产生的事件 → 转发为 MCP notification
    this.server.setRequestHandler('resources/subscribe', async (request) => {
      this.resourceSubscriptions.add(request.params.uri);
      return {};
    });
    this.server.setRequestHandler('resources/unsubscribe', async (request) => {
      this.resourceSubscriptions.delete(request.params.uri);
      return {};
    });
    registerBridgePushHandler((params) => {
      // K-1: 只发已订阅客户端(bridge://events 在订阅 Set 中才转发)。
      // 此前无条件广播违反 MCP 协议(未订阅客户端不应收到 resources/updated);
      // bridge addon → server 的 TCP push 链路不受影响,仅 server→client 转发加过滤。
      // 客户端订阅 bridge://events 后,事件到达即推送(无需轮询 watch_poll/monitor_poll)。
      if (!this.resourceSubscriptions.has('bridge://events')) return;
      try {
        this.server.notification({
          method: 'notifications/resources/updated',
          params: { uri: 'bridge://events', ...params },
        });
      } catch {
        // notification 发送可能因 client 断连而抛 SdkError,吞掉不中断
      }
    });

    // Phase 2b: Multi-instance initialization moved to initMultiInstance() (async fs)

    // D 批（v0.30）：MCP Roots 动态授权已退役（2026-07-28 规范正式废弃 Roots，
    // 12 个月窗口；SDK 的 roots 拉取在 modern era 直接抛错，legacy 侧官方迁移路径是
    // configuration 即 ALLOWED_PROJECT_PATHS env——与 modern era 实际行为一致）。
    // oninitialized 保留：承载 logger/progress 的 client-ready 信号（与 Roots 无关）。
    this.server.oninitialized = () => {
      setLoggerClientReady(true);
      setProgressClientReady(true);
    };
  }

  /** Phase 2b: Multi-instance initialization (async fs — C-02).
   *  2026-08-10 行225：补全接收端 HTTP server——此前 send-side only，现 verifyApiToken 闭环。 */
  private async initMultiInstance(): Promise<void> {
    if (!isFeatureEnabled('MULTI_INSTANCE')) return;
    const projectDir = ps.getProjectDir();
    const manager = new InstanceManager({
      projectRegistryDir: projectDir
        ? join(projectDir, '.godot', 'mcp-instances')
        : undefined,
    });
    // 行225：启动 HTTP 接收端（verifyApiToken 闭环）。
    // 分配端口 → 注册自己到 registry → 启动 InstanceHttpServer → 30s 心跳。
    // 失败不阻断发送端（sendToInstance 仍可工作，只是本实例不被发现/不可被 route 到）。
    try {
      const instances = await manager.loadFromRegistry();
      const usedPorts = instances.map(i => i.port);
      const port = manager.allocatePort(usedPorts);
      const projectPath = resolveProjectPath() ?? projectDir ?? process.cwd();
      const projectName = projectPath.split(/[\\/]/).pop() ?? 'unknown';
      const selfInfo = buildInstanceInfo({ port, projectPath, projectName });
      this.selfInstanceId = selfInfo.id;
      await manager.registerSelf(selfInfo);
      if (this.dispatcher) {
        this.httpReceiver = new InstanceHttpServer({
          port,
          instanceId: selfInfo.id,
          dispatcher: this.dispatcher,
        });
        await this.httpReceiver.start();
      }
      // 30s 心跳刷 lastSeen（stale timeout 70s，留余量）。unref 不阻塞退出。
      this.instanceHeartbeatTimer = setInterval(() => {
        if (this.selfInstanceId) {
          void manager.updateLastSeen(this.selfInstanceId).catch(() => { /* best-effort */ });
        }
      }, 30_000);
      this.instanceHeartbeatTimer.unref?.();
      getLogger().info('instance', `Multi-instance receiver started on 127.0.0.1:${port} (id=${selfInfo.id}, HMAC auth verified via verifyApiToken)`);
    } catch (err) {
      getLogger().warn('instance', `Multi-instance receiver failed to start (send-side still works): ${err instanceof Error ? err.message : err}`);
    }
    const sendToInstance: RouterDependencies['sendToInstance'] = async (instance, toolName, args) => {
      // 安全：拒绝非法 tool name（防路径注入）
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(toolName)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid tool name: ${toolName}` }],
          isError: true,
        };
      }
      const url = `http://127.0.0.1:${instance.port}/api/${toolName}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: buildAuthHeaders(instance.id),
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Instance ${instance.id} error: HTTP ${response.status}` }],
            isError: true,
          };
        }
        const data = await response.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Instance ${instance.id} unreachable: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    };
    const router = new InstanceRouter({
      instances: await manager.loadFromRegistry(),
      sendToInstance,
    });
    setInstanceManager(manager);
    setInstanceRouter(router);
    // Phase 3: Wire dynamic route sender — resolves selected instance and POSTs to route
    setDynamicSender(async (route: string, toolArgs: Record<string, unknown>) => {
      // C-01 安全：校验 route 仅含安全字符（防路径注入）
      if (!/^[a-zA-Z0-9\-/]+$/.test(route)) {
        return { content: [{ type: 'text' as const, text: 'Invalid route: access denied' }], isError: true };
      }
      const selected = router.getSelectedInstance();
      if (!selected) {
        return { content: [{ type: 'text' as const, text: 'No instance selected for dynamic routing.' }], isError: true };
      }
      const url = `http://127.0.0.1:${selected.port}/api/${route}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: buildAuthHeaders(selected.id),
        body: JSON.stringify(toolArgs),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        return { content: [{ type: 'text' as const, text: `Dynamic route ${route} error: HTTP ${response.status}` }], isError: true };
      }
      const data = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    });
    getLogger().info('instance', 'Multi-instance mode enabled');
  }

    /** Send tools/list_changed notification to client. Called when active groups change. */
  sendToolListChanged(): void {
    this.server.notification({
      method: 'notifications/tools/list_changed',
    });
  }

  
  // ─── Run ───────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('Godot MCP Enhanced server running on stdio');

    // Web GUI(设计 §3.2):connect 后即起,run() resolve 前三态已定(消除 index.ts 决策竞态)。
    // env=0 关闭(与 GODOT_MCP_NO_DASHBOARD 同模式);任何异常降级禁用,绝不拖垮主流程。
    if (process.env.GODOT_MCP_WEB_GUI !== '0') {
      try {
        this.webGuiServer = new WebGuiServer({
          getSessions: () => ps.listRunSessionsDetailed(),
          getIndexHtml: () => INDEX_HTML,
          // 面板控制(2026-09-14 批准设计):stop 与 runtime.ts stop_project 核心三步一致
          // (markSessionStopping → killProcess → releaseRunSessionBusy);killProcess 后
          // 退出钩子自动走 markSessionExited + clearRunSession 快照挪移(分桶批已建)。
          stopSession: async (projectPath) => {
            const key = ps.normalizeProjectKey(projectPath);
            const proc = ps.getRunSessionProc(key);
            if (!proc) return { ok: false, reason: 'not_found' };
            ps.markSessionStopping(key);
            await ps.killProcess(proc);
            ps.releaseRunSessionBusy(key);
            return { ok: true };
          },
          removeSession: (projectPath) => ps.removeRunSession(projectPath),
        });
        await this.webGuiServer.start();
        this.webGuiActive = true;
      } catch (err) {
        // Task 6 review 交接:start() 在 writeRegistration 抛错时残留半激活态
        // (HTTP 已监听 + _active=true 但 start() reject)——必须补调 stop() 清理,
        // 防 isWebGuiActive 误报 + 端口泄漏(stop 幂等,清理再失败仅吞)。
        const gui = this.webGuiServer;
        this.webGuiServer = null;
        this.webGuiActive = false;
        if (gui) { try { await gui.stop(); } catch { /* best-effort 清理 */ } }
        getLogger().warn('godot-mcp', `Web GUI disabled: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 报告②P0：周期性 orphan 扫描。killOrphanGodotProcesses 内部有 30s 节流，故 60s 间隔保证每次
    // tick 真正扫描。第一层只扫本会话 _spawnedGodotPids（不误杀用户 Godot）。unref 不阻塞退出。
    this.orphanScanTimer = setInterval(() => {
      void ps.killOrphanGodotProcesses(ps.getProjectDir() || undefined).catch(() => { /* best-effort */ });
    }, 60_000);
    this.orphanScanTimer.unref?.();

    // 状态持久化 — 加载已保存的 agent 状态
    const projectPath = resolveProjectPath();

    // 报告②P1：启动时清理上一会话残留 Godot 进程（opt-in，默认关）。
    // 2026-08-07 审查 P1 修复：原 STARTUP_CLEANUP 单独开启时是 no-op（_spawnedGodotPids
    // 新会话为空 → 第一层 0 kill，需 FULL_SYSTEM_SCAN 才触发第二层）。用户按文档开
    // STARTUP_CLEANUP 期望清理崩溃残留，实际无效果（虚假安全感）。
    // 修复：STARTUP_CLEANUP 启用时传 { fullSystemScan: true }，让第二层
    // fullSystemScanGodot 也跑（只扫命令行含 projectPath 的 Godot，跳过 --editor，15s
    // 超时，unref 不阻塞，安全过滤在 process-state.ts fullSystemScanGodot 内置）。
    // IPC-R1/R5 (2026-08-08): 原实现临时设 process.env + finally 恢复(进程级全局状态),
    // 与 60s 周期 orphan 扫描 tick 存在竞态(全系统扫跑满 15s 时 env 污染周期 tick)。
    // 改用显式 options 参数,消除 env 隐式全局状态。
    if (isFeatureEnabled('STARTUP_CLEANUP') && projectPath) {
      void ps.killOrphanGodotProcesses(projectPath, { fullSystemScan: true }).catch(() => { /* best-effort */ });
    }
    if (projectPath) {
      this.stateStore = new FileStateStore(projectPath);
      const saved = await this.stateStore.load();
      if (saved) {
        for (const [id, agentState] of Object.entries(saved.agents)) {
          const state = this.agentCtx.getOrCreate(id);
          state.selectedInstance = agentState.selectedInstance;
          state.activeProfile = agentState.activeProfile;
          state.isEphemeral = false;
        }
        this.markStateDirty();
      }
    }

    // Phase 2b: Multi-instance initialization (async fs — C-02)
    await this.initMultiInstance();

    // Phase 5d: Project context notification
    // P1-7 (SEP-2577): 改用 sendLoggingMessage(走 SDK 正规 logging 路径)。
    // 此前用 notification({method:'notifications/message'}) 直发,被 SDK assertNotificationCapability
    // 抛 SdkError(因 capabilities 未声明 logging)→ 被 catch 吞,通知没发出。
    // 声明 logging capability + 改用 sendLoggingMessage 后,SDK 正常发通知。
    setImmediate(() => {
      try {
        const maybePromise = this.server.sendLoggingMessage({
          level: 'info',
          logger: 'server',
          data: '[Godot MCP] Project context available at godot://project-context. Read it for coding guidelines and architecture notes.',
        });
        if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
          (maybePromise as Promise<void>).catch(() => {});
        }
      } catch { /* best-effort */ }
    });

    if (this.connectionMode === 'editor') {
      // P1 架构修复: editor 连接生命周期委托 EditorConnectionManager。
      // 进程级 exit(noFallback)留本类;连接/降级/heartbeat/项目校验归 manager。
      const port = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);
      const projectPath = resolveProjectPath();
      this.editorMgr = new EditorConnectionManager({
        dispatcher: this.dispatcher!,
        sendLoggingMessage: (opts) => this.server.sendLoggingMessage(opts),
        onConnected: () => {
          this.connectionMode = 'editor';
          this.dispatcher?.setConnectionMode('editor');
        },
        onDegrade: () => {
          this.connectionMode = 'headless';
        },
      }, { port, projectPath: projectPath ?? null, noFallback: this.noFallback });
      const result = await this.editorMgr.init();
      if (!result.connected && this.noFallback) {
        getLogger().error('auth', `Editor mode required but failed: ${result.detail}`);
        getLogger().error('auth', 'Set GODOT_MCP_NO_FALLBACK=false to allow fallback, or install the plugin.');
        getLogger().close();
        process.exit(1);
      }
    }
  }

  /** 标记状态为脏，触发防抖刷盘。 */
  private markStateDirty(): void {
    if (!this.stateStore) return;
    this.stateStore.markDirty(() => ({
      version: 1,
      savedAt: Date.now(),
      agents: Object.fromEntries(
        this.agentCtx.getPersistableAgents()
          .map(([id, s]) => [id, {
            selectedInstance: s.selectedInstance,
            activeProfile: s.activeProfile,
            contextMeta: null,
          }]),
      ),
      globalProfile: 'full',
      lastConnectedPort: null,
    }));
  }

  async close(): Promise<void> {
    // P2: 整体 try/finally 兜底，finally 保证 server.close + 模块级引用清理必执行。
    // 各步骤虽多 best-effort，但 agentCtx.destroy()/server.close() 抛错会中断后续清理 →
    // 模块级引用残留（影响测试隔离与重启）。finally 用 serverClosed 标志防重复 close。
    // G-2 (2026-08-14 审查 :65+:942③): 清理链逐项 try —— 单点抛错记 warn 不阻断后续清理
    // 与 killProcess(原 editorMgr.close()/stateStore.flush 裸调,抛错则孤儿 Godot 无兜底杀)。
    const safeStep = async (label: string, step: () => void | Promise<void>): Promise<void> => {
      try { await step(); } catch (err) {
        getLogger().warn('godot-mcp', `close step "${label}" failed (best effort): ${err instanceof Error ? err.message : err}`);
      }
    };
    let serverClosed = false;
    try {
      // P4-3: 清本进程 in-flight 记录文件(正常退出不留孤儿;异常死亡才留 → 下个启动报丧)
      await safeStep('clearInflight', () => clearAllInflight());
      // Web GUI 停机(设计 §3.2):SSE end → closeAllConnections → close → 删登记(顺序在 WebGuiServer.stop 内)
      if (this.webGuiServer) {
        const gui = this.webGuiServer;
        this.webGuiServer = null;
        this.webGuiActive = false;
        await safeStep('stopWebGui', () => gui.stop());
      }
      // P2-1: 自动卸载 overrides(graceful shutdown 时清理,防半装状态)。
      // 仅对已知项目路径卸载(editorProjectPath);headless 模式下项目路径不持久化,
      // agent 须手动调 uninstall_override action。
      const editorProjectPath = this.editorMgr?.getProjectPath() ?? null;
      if (this.options.overrides && this.options.overrides.length > 0 && editorProjectPath) {
        await safeStep('auto-uninstall overrides', async () => {
          const { uninstallAllOverrides } = await import('./core/overrides.js');
          const n = uninstallAllOverrides(editorProjectPath);
          if (n > 0) getLogger().info('godot-mcp', `Auto-uninstalled ${n} overrides from ${editorProjectPath}`);
        });
      }
      // Task 5(PR-1b): 优雅收尾进行中 QA run——置取消并等待 settle(报告落 CANCELLED +
      // 录制证据落盘)。须在 killProcess 前:run loop 收尾依赖 bridge/游戏进程仍活着;
      // 等待上限 min(60s, ttl) 见 cancelAndAwaitWorkingRun;超时放弃等,killProcess 兜底。
      await safeStep('cancel running qa run', async () => {
        const { cancelled, settled } = await cancelAndAwaitWorkingRun();
        if (cancelled && !settled) getLogger().warn('godot-mcp', `qa run ${cancelled} 未在收尾窗口内 settle(进程级兜底兜住)`);
      });
      // 报告②P0：先停周期扫描，防与下方 kill 逻辑竞争。
      if (this.orphanScanTimer) {
        clearInterval(this.orphanScanTimer);
        this.orphanScanTimer = null;
      }
      // 行225：停 MULTI_INSTANCE 接收端（HTTP server + 心跳 + 清 registry）。
      if (this.instanceHeartbeatTimer) {
        clearInterval(this.instanceHeartbeatTimer);
        this.instanceHeartbeatTimer = null;
      }
      if (this.httpReceiver) {
        try { await this.httpReceiver.stop(); } catch { /* best-effort */ }
        this.httpReceiver = null;
      }
      if (this.selfInstanceId) {
        const projectDir = ps.getProjectDir();
        const mgr = new InstanceManager({
          projectRegistryDir: projectDir
            ? join(projectDir, '.godot', 'mcp-instances')
            : undefined,
        });
        try { await mgr.unregisterSelf(this.selfInstanceId); } catch { /* best-effort */ }
        this.selfInstanceId = null;
      }
      if (this.editorMgr) {
        const mgr = this.editorMgr;
        this.editorMgr = null;
        await safeStep('editorMgr.close', () => mgr.close());
      }
      // Task 3(设计 §5):close 走 killAllRunSessions——杀全部桶活进程并清桶
      // (per-project 分桶后非活跃桶的进程也一并收尾,不留孤儿)。等价旧逻辑
      // (killProcess 活跃 proc + setProcessBusy(false) + setRunningProcess(null))
      // 的 per-key 超集:status→stopping、killProcess、快照挪移均由其内部承接。
      await safeStep('killAllRunSessions', () => ps.killAllRunSessions());
      // B-T4: 清理 in-flight short-running gdscript spawn（gdscript-executor 注册）。
      // 原 close 只 kill run_project 长进程,挂起脚本 + close → 孤儿无兜底。
      // getSpawnedGodotPids 此时通常已空（exit/error/timeout 三路径均 unregister），
      // 仅异常路径（注册后 close 抢占 / forceKillTree 后 exit 未触发）残留 PID → best-effort kill。
      for (const pid of ps.getSpawnedGodotPids()) {
        try {
          ps.killPidTree(pid);
          ps.unregisterSpawnedGodotPid(pid);
        } catch { /* best-effort: 已退出 / killPidTree 内部吞错 */ }
      }
      // Clean up guard cleanup timer and pending tokens
      await safeStep('guard.cleanup', () => guard.cleanup());
      // Stop health monitor heartbeat
      await safeStep('healthMonitor.stopHeartbeat', () => this.dispatcher?.getHealthMonitor().stopHeartbeat());
      // 状态持久化 — 刷盘并清理(flush 抛错不阻断 destroy 与后续 server.close)
      if (this.stateStore) {
        const store = this.stateStore;
        this.stateStore = null;
        await safeStep('stateStore.flush', () => store.flush());
        await safeStep('stateStore.destroy', () => store.destroy());
      }
      try { this.agentCtx.destroy(); } catch { /* best-effort: 不阻断 server.close + 引用清理 */ }
      await this.server.close();
      serverClosed = true;
    } finally {
      // 必执行：模块级引用清理（防测试隔离泄漏 / 重启残留）+ server.close 兜底
      if (!serverClosed) {
        try { await this.server.close(); } catch { /* best-effort: 已损坏或重复关闭 */ }
      }
      setOnGroupsChanged(null);
      setConnectionStatusProvider(null);
      setGetContextConnectionProvider(null);
      setEditorSceneProvider(null);
      setReconnectEditor(null);
      clearMcpServer();
      setLoggerServer(null);          // 批 P1: MCP Logging 干净关闭 + 测试隔离
      setLoggerClientReady(false);
      setProgressSender(null);
      setProgressClientReady(false);
      setElicitServer(null);
      // 架构修复 P0-2: 补齐 tools 侧模块级引用清理(close 原本漏清这 5 个,
      // 致 instance-tools/advanced-proxy/game-bridge 持有上一 server 闭包 → 测试隔离泄漏 / 热重启残留)
      setInstanceManager(null);
      setInstanceRouter(null);
      setDynamicSender(null);
      setToolCallDelegate(null);
      setBridgeProjectDir(null);
      // G-2 (:942③): 补漏两个模块级注入点 —— registerBridgePushHandler(:269 注册的
      // push handler 闭包持已 close 旧 server,不注销则热重启后 push 事件错路由到死 server)
      // 与 dynamicSchema.setFetcher(:229 注入的 fetcher 同样持旧 editorMgr 闭包)。
      registerBridgePushHandler(null);
      dynamicSchema.setFetcher(null);
      // PR-2 (tasks wire): 注销终态通知钩子(闭包持已 close 旧 server,防测试隔离泄漏/热重启残留)。
      setTerminalNotifier(null);
      // K-1: 清空资源订阅集合(热重启/测试隔离时防旧订阅状态残留)
      this.resourceSubscriptions.clear();
      log('Server shut down');
    }
  }
}

/**
 * CMP-16-B (2026-08-08): 拉取动态工具(live schema)并注册到 tool-registry,返回要 merge 进 tools/list 的工具列表。
 *
 * 流程:
 * 1. 设置静态工具名集合(冲突检测:动态工具名撞静态工具名则跳过)
 * 2. 拉取动态工具(dynamicSchema.getDynamicTools,带缓存+降级)
 * 3. 注册到 tool-registry(registerDynamicTools,让 isToolAllowed 放行)
 * 4. 返回工具列表(调用方 merge 进 tools/list)
 *
 * editor 离线时返回空数组(降级,只留 godot_advanced_tool 兜底代理)。
 */
async function mergeDynamicTools(staticTools: Tool[]): Promise<Tool[]> {
  // 静态工具名集合(含 inline 工具如 confirm_and_execute + 所有注册工具)
  const staticNames = new Set<string>(staticTools.map(t => t.name));
  for (const name of getAllToolNames()) {
    staticNames.add(name);
  }
  dynamicSchema.setStaticToolNames(staticNames);

  // 拉取动态工具(带缓存;editor 离线返空)
  const dynamicTools = await dynamicSchema.getDynamicTools();

  // 注册到 tool-registry(让 isToolAllowed 在 dynamic 组激活时放行)
  registerDynamicTools(dynamicTools.map(t => t.name));

  return dynamicTools;
}

