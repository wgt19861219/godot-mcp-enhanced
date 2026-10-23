// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';
import type { ToolResult } from '../types.js';
import { resolveEditorMethod } from './editor-method-map.js';
import type { HealthMonitor } from './health-monitor.js';
import { opsErrorResult } from './shared/errors.js';
import { classifyError } from './tool-errors.js';
import { getLogger } from './logger.js';

export class EditorToolExecutor {
  private syncActive = false;
  // I-PERF-04: Circular buffer instead of Array (avoids O(n) shift)
  private treeChangeRing: Array<{ type: string; path: string; node_type: string } | null> = [];
  private treeChangeHead = 0; // next write position
  private treeChangeCount = 0;
  private static readonly MAX_BUFFER_SIZE = 10000;
  private readonly conn: EditorConnection;
  // B-T3: 半开 HOL 预检——_executeInner 入口据 healthMonitor.getState() === 'reconnecting'
  // 即时返 NOT_CONNECTED，跳过 30s conn.request 等待（串行 executeChain ×30s HOL 放大）。
  // 可选：未注入时不预检（向后兼容既有 new EditorToolExecutor(conn) 调用点）。
  private readonly healthMonitor?: HealthMonitor;
  // P2-1R (2026-08-11 CMP-1 TOCTOU): 自动重连后 verifyEditorProject 校验期 gate。
  // GodotServer 注入 () => this._editorVerifying;校验期 _executeInner 入口即时返
  // VERIFICATION_IN_PROGRESS,防 editor 工具作用错误项目场景树(对齐 B-T3 HOL 预检范式)。
  private readonly isVerifying?: () => boolean;
  // security P1#2: editor 工具串行化链(防并发 ws.send 致 undo 栈 LIFO 错乱)
  private executeChain: Promise<unknown> = Promise.resolve();

  /** Bound handlers stored so we can remove them on destroy. */
  private readonly _disconnectHandler = (): void => {
    // D3: 不清 syncActive — 保留用户 sync 意图。重连时 _reconnectHandler 据 syncActive
    // re-subscribe(自动恢复);清了会致重连不 re-subscribe(语义错乱)+ handleSyncStop 误报 SYNC_NOT_ACTIVE。
    this.treeChangeRing = [];
    this.treeChangeHead = 0;
    this.treeChangeCount = 0;
  };
  private readonly _reconnectHandler = (): void => {
    if (this.syncActive) {
      this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
    }
  };

  constructor(conn: EditorConnection, healthMonitor?: HealthMonitor, isVerifying?: () => boolean) {
    this.conn = conn;
    this.healthMonitor = healthMonitor;
    this.isVerifying = isVerifying;
    this.conn.addOnDisconnectHandler(this._disconnectHandler);
    this.conn.addOnReconnectHandler(this._reconnectHandler);
  }

  /** Remove all handlers from the connection. Call when discarding this executor. */
  destroy(): void {
    this.conn.removeOnDisconnectHandler(this._disconnectHandler);
    this.conn.removeOnReconnectHandler(this._reconnectHandler);
    // L-12(2026-10-22 审查):sync 中途销毁时残留 scene_tree_changed handler——
    // 旧 executor 的 handleTreeChange 仍消费 ring buffer,新 executor 再注册即双重消费。
    // offNotification 幂等(未注册时无操作),sync 正常停止路径不受影响。
    this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    // security P1#2 fix: 串行化 editor 工具调用 - MCP SDK 异步并发派发多个 tools/call, 并发 ws.send 到达
    // GDScript 顺序不可靠, 致 undo 栈 LIFO 错乱(commit 顺序与逻辑依赖相反 -> undo 弹栈 target==null/undo 丢失).
    // Promise 链排队: 每个 execute 等前一个完成再发 request, 保证 commit_action 顺序确定.
    //
    // C-可靠性 (2026-08-09): 只读工具(get_scene_tree 等)也走此串行链,是有意决策非 bug。
    // 评估过"只读走独立通道"但被否:editor 是单 WebSocket 连接,并发 ws.send 到 GDScript 主循环
    // 的派发顺序仍不可靠(正是全串行的根因),只读独立通道需 GD 侧也支持并发派发 + 顺序保证,
    // 工作量大且引入新并发风险,收益有限。知情接受串行(2026-07-29 可靠性审查 P2-⑥ 决策)。
    const run = this.executeChain.then(
      () => this._executeInner(toolName, args),
      () => this._executeInner(toolName, args),  // 前一个 reject 不阻塞下一个
    );
    this.executeChain = run.then(
      () => undefined,
      () => undefined,  // chain 不因单失败而 reject, 保持后续可调度
    );
    return run;
  }

  private async _executeInner(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    // B-T3: 半开 HOL 预检——TCP 半开时 conn.connected=true 但 editor 主线程卡死，
    // conn.request 挂满 30s（串行 executeChain ×30s HOL 放大）。
    // healthMonitor 心跳已检测到 reconnecting 时，入口即时返 NOT_CONNECTED 跳过等待。
    if (this.healthMonitor && this.healthMonitor.getState() === 'reconnecting') {
      return opsErrorResult(
        'NOT_CONNECTED',
        'Editor is reconnecting (half-open precheck). Retry shortly.',
      );
    }
    // P2-1R: CMP-1 重连 TOCTOU 预检——自动重连后 verifyEditorProject 校验期(~5s RPC 超时)
    // editorExecutor 已就绪 + connected=true,但项目可能不匹配(端口被另一项目 editor 接管)。
    // 校验期即时返 VERIFICATION_IN_PROGRESS 跳过,防写操作作用错误场景树(对齐 B-T3 范式)。
    // verifyEditorProject finally 复位 _editorVerifying,校验完恢复。
    if (this.isVerifying?.()) {
      return opsErrorResult(
        'VERIFICATION_IN_PROGRESS',
        'Editor is verifying project match after reconnect. Retry shortly.',
      );
    }
    try {
      if (toolName === 'editor') {
        const action = args.action as string;
        if (action === 'sync_start') return this.handleSyncStart(args);
        if (action === 'sync_stop') return this.handleSyncStop(args);
        if (action === 'get_scene_tree') return this.handleGetSceneTree(args);
      }

      // Forward to plugin. The plugin-side handlers use undo_manager for
      // mutating operations (add_node, particles_create, etc.).
      // TODO: Future — add _use_undo flag for unified undo control across all handlers.

      // Default: forward to plugin. resolveEditorMethod 把 (tool,action) 映射到
      // command_handler 的扁平 method（asset→asset_create 等）；未命中 fallback 工具名。
      const entry = resolveEditorMethod(toolName, args);
      const method = entry?.method ?? toolName;
      const finalArgs = entry?.transformArgs ? entry.transformArgs(args) : args;

      // §7 A-lite: nav bake 长操作包 operation_start/end 暂停心跳（EditorConnection.ts:419-424 已有方法接线）。
      // 闭环 defects heartbeat-pause-timeout-disconnect（startOperation/endOperation 零生产调用）：
      // bake_mesh 挂起期心跳阻塞致 editor 误判断开；operation_start 通知 GD heartbeat.gd 暂停。
      // T_ts 对齐 §6 BAKE_WAIT_TIMEOUT_MS（110s 量级，clamp ≤600）。GD P1#3 hard timeout 兜底（heartbeat.gd:37-46）。
      // finalArgs.bake === true 严格等于依赖 nav 工具 schema 强制 bool（GD 侧 params.get("bake", false) 宽松，
      // 但 TS schema 校验在 GD 之前保证 bool 入参，故 === true 不会漏 truthy 非 bool 值）。
      const isNavBake = method === 'nav_bake_mesh'
        || (method === 'nav_create_region' && finalArgs.bake === true);
      const NAV_BAKE_OP_TIMEOUT_SEC = 110;  // < GD clamp 600，> §6 BAKE_WAIT_TIMEOUT_MS

      if (isNavBake) {
        // IPC-R3 (2026-08-08): _runWithOpTimeout 现在同时暂停 GD 侧 heartbeat.gd 和 TS 侧
        // health-monitor 心跳(双保险)。原风险(未来同步阻塞主循环时 TS ping 75s 误降级
        // 中断 110s 操作)已消除。nav bake 当前走 GD coroutine 不阻塞主循环,TS 侧暂停是
        // 防御性补充(若未来路径变同步阻塞,无需再改此处)。
        // NIT-3: 必须 return await（非 return）——async 函数中 return 未经 await 的 Promise
        // 会绕过当前 try/catch，致 _runWithOpTimeout 内 request 的 reject 逃出错误处理（I-1 失效）。
        return await this._runWithOpTimeout(method, finalArgs, NAV_BAKE_OP_TIMEOUT_SEC);
      }

      // P2-12 phase 2: test_run 走 GD async coroutine（websocket_server.gd 分流 handle_test_async，
      // suite 内每 test 后 await process_frame 让出主循环）。startOperation 暂停 GD heartbeat
      // inactivity 检测（防 30s 无活动误断）+ IPC-R3 暂停 TS 侧 hm 心跳（双保险）。
      // 290s 预算 < GD clamp 600（heartbeat.gd:69）+ websocket_server.gd:325，> 预期 suite 总耗时；
      // 多 suite 累积超 290s 时调用方应用 suite= 过滤分批。
      const isTestRun = method === 'test_run';
      const TEST_RUN_OP_TIMEOUT_SEC = 290;
      if (isTestRun) {
        return await this._runWithOpTimeout(method, finalArgs, TEST_RUN_OP_TIMEOUT_SEC);
      }

      const result = await this.conn.request(method, finalArgs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const errCode = (err instanceof Error && 'code' in err)
        ? (err as Record<string, unknown>).code
        : undefined;
      const message = err instanceof Error ? err.message : 'Unknown error';
      // B4: 连接类错误结构化判定（覆盖原字符串匹配漏项 Disconnected / JSON parse error）
      // 5 个 code 由 EditorConnection reject 站点挂载;字符串兜底保护外部 path 未挂 code 的回归。
      // T2-M1 (final review): 字符串兜底必须守 errCode===undefined，否则插件结构化错误（带 number code 如
      // -32602）其 message 恰含连接子串（最现实 "Disconnected"，如 "Node Disconnected from parent"）会被
      // 误判连接错误 → code/data 被吞 + 反挂 do_not_retry+editor_disconnected。已挂 code（string 连接 code
      // 或 number 插件 code）走第一分支;无 code 的旧 Error 走字符串兜底;两路径互斥。
      const CONN_ERROR_CODES = new Set([
        'CONNECTION_LOST', 'NOT_CONNECTED', 'REQUEST_TIMEOUT', 'DISCONNECTED', 'PARSE_ERROR',
      ]);
      const isConnectionError =
        (typeof errCode === 'string' && CONN_ERROR_CODES.has(errCode)) ||
        (errCode === undefined && (
          message.includes('Connection lost') ||
          message.includes('Not connected') ||
          message.includes('Request timeout') ||
          message.includes('Disconnected') ||
          message.includes('JSON parse error')
        ));

      // PII 护栏(G2 收尾): 连接错误 message 是连接语义(Not connected 等,非 PII),客户端需识别;
      // 非连接错误(GDScript 报错等)可能含绝对路径/项目名 = PII,用 classifyError 的 safeMessage。
      const classified = classifyError(err);
      const safeErrorText = isConnectionError ? message : classified.safeMessage;
      if (!isConnectionError) {
        // 完整 message 仅 log 到 server(诊断不丢),不外传 client
        getLogger().debug('editor', `Editor tool error [${classified.category}/${classified.code}]: ${message}`);
      }
      const errorPayload: Record<string, unknown> = { error: safeErrorText };
      // I-12: 保留插件结构化 code/data（连接类错误除外——它们的 code 是本地连接语义非插件语义,
      // 暴露给客户端会被误解为插件 JSON-RPC code 触发错误处理逻辑）
      if (!isConnectionError && err instanceof Error && 'code' in err) {
        errorPayload.code = (err as Record<string, unknown>).code;
      }
      if (!isConnectionError && err instanceof Error && 'data' in err) {
        errorPayload.data = (err as Record<string, unknown>).data;
      }
      if (isConnectionError) {
        errorPayload.editor_disconnected = true;
        // ipc P0-1: 连接断开期间 in-flight 调用结果未知(编辑器侧可能已执行并入 undo 栈),
        // 客户端不应自动重试 — 否则重试命中新连接会重复执行(add_node 同名冲突 / undo 栈多一项)。
        errorPayload.do_not_retry = true;
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload) }],
        isError: true,
      };
    }
  }

  /**
   * 包裹 startOperation/endOperation 的长操作执行（nav_bake / test_run 共用）。
   * startOperation 通知 GD 侧 heartbeat.gd 暂停 inactivity 检测；endOperation 恢复。
   * IPC-R3 (2026-08-08): startOperation 后还暂停 TS 侧 health-monitor 心跳,防 GD 主循环
   * 阻塞时 ping 5s 超时×5≈75s 误降级中断 110s/290s 操作。endOperation 后恢复(双保险)。
   * finally 块的 .catch(() => {}) 防清理错误覆盖 try 抛出的原始错误（I-1 审查 finding）。
   */
  private async _runWithOpTimeout(
    method: string,
    args: Record<string, unknown>,
    timeoutSec: number,
  ): Promise<ToolResult> {
    // 注：startOperation reject 时（CONNECTION_LOST）直接抛出，不会进入下方 try/finally，
    // 故 endOperation/resumeHeartbeat 不会被误调（finally 属于 startOperation 之后的 try，未开始则不触发）。
    // operation_start 若部分成功后 TS 侧 reject，GD 侧 heartbeat.gd 有 hard timeout 兜底。
    await this.conn.startOperation(timeoutSec);
    // IPC-R3: 暂停 TS 侧心跳(healthMonitor 未注入时 no-op,向后兼容)
    this.healthMonitor?.pauseHeartbeat();
    try {
      const result = await this.conn.request(method, args, { timeoutMs: timeoutSec * 1000 });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } finally {
      await this.conn.endOperation().catch(() => {});
      this.healthMonitor?.resumeHeartbeat();
    }
  }

  private handleTreeChange = (params: unknown): void => {
    if (typeof params !== 'object' || params === null) return;
    const p = params as { type: string; path: string; node_type: string };
    if (typeof p.type !== 'string' || typeof p.path !== 'string') return;
    // I-PERF-04: O(1) ring buffer write instead of O(n) shift
    if (this.treeChangeCount < EditorToolExecutor.MAX_BUFFER_SIZE) {
      this.treeChangeRing.push(p);
      this.treeChangeCount++;
    } else {
      this.treeChangeRing[this.treeChangeHead] = p;
    }
    this.treeChangeHead = (this.treeChangeHead + 1) % EditorToolExecutor.MAX_BUFFER_SIZE;
  };

  /** Drain all buffered changes in insertion order and reset the ring. */
  private drainChanges(): Array<{ type: string; path: string; node_type: string }> {
    if (this.treeChangeCount === 0) return [];
    const result: Array<{ type: string; path: string; node_type: string }> = [];
    const size = this.treeChangeCount;
    // If ring hasn't wrapped, just slice; otherwise iterate from oldest
    if (size < EditorToolExecutor.MAX_BUFFER_SIZE) {
      for (let i = 0; i < size; i++) {
        result.push(this.treeChangeRing[i]!);
      }
    } else {
      // Oldest is at treeChangeHead (next write position wraps around)
      for (let i = 0; i < EditorToolExecutor.MAX_BUFFER_SIZE; i++) {
        const idx = (this.treeChangeHead + i) % EditorToolExecutor.MAX_BUFFER_SIZE;
        result.push(this.treeChangeRing[idx]!);
      }
    }
    this.treeChangeRing = [];
    this.treeChangeHead = 0;
    this.treeChangeCount = 0;
    return result;
  }

  private async handleSyncStart(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_ALREADY_ACTIVE' }) }],
        isError: true,
      };
    }
    this.treeChangeRing = [];
    this.treeChangeHead = 0;
    this.treeChangeCount = 0;
    this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
    try {
      const result = await this.conn.request('editor_sync_start', args);
      this.syncActive = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
      // PII 护栏(G2 收尾): message 可能含 GDScript 报错路径 = PII,用 safeMessage;完整文本 log 到 server
      getLogger().debug('editor', `Editor tool error: ${err instanceof Error ? err.message : err}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: classifyError(err).safeMessage }) }],
        isError: true,
      };
    }
  }

  private async handleSyncStop(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_NOT_ACTIVE' }) }],
        isError: true,
      };
    }
    this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
    this.syncActive = false;
    const changes = this.drainChanges();
    try {
      const result = await this.conn.request('editor_sync_stop', args);
      const merged = typeof result === 'object' && result !== null
        ? { ...(result as Record<string, unknown>), buffered_changes: changes }
        : { result, buffered_changes: changes };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(merged) }],
      };
    } catch (err) {
      // 即使 request 失败（如已断连），仍然返回已缓冲的变更
      // PII 护栏(G2 收尾): warning 文本用 safeMessage,完整 message log 到 server
      getLogger().debug('editor', `sync_stop error: ${err instanceof Error ? err.message : err}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ warning: classifyError(err).safeMessage, buffered_changes: changes }) }],
      };
    }
  }

  private async handleGetSceneTree(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.conn.request('editor_get_scene_tree', args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      // PII 护栏(G2 收尾): message 可能含 GDScript 报错路径 = PII,用 safeMessage;完整文本 log 到 server
      getLogger().debug('editor', `Editor tool error: ${err instanceof Error ? err.message : err}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: classifyError(err).safeMessage }) }],
        isError: true,
      };
    }
  }
}
