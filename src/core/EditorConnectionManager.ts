// src/core/EditorConnectionManager.ts
//
// Editor 连接生命周期管理(2026-08-14 P1 架构修复:从 GodotServer.ts 抽出)。
// 持有 editor WebSocket 连接 + executor + heartbeat,封装建立/重建/降级/项目校验。
// 通过 EditorConnectionHost 与 GodotServer 交互(dispatcher 操作 + connectionMode 回调),
// 使 GodotServer 不再承担连接细节(原 establishEditorConnection/handleEditorStall/
// rebuildEditorConnection/verifyEditorProject 四方法 + 6 字段约 200 行均移入此处)。
//
// 纯移动重构:逻辑与原 GodotServer 等价,仅 this 引用重映射:
//   this.editorConn → this.conn; this.editorExecutor → this.executor;
//   this.editorPort → this.port; this.editorProjectPath → this.projectPath;
//   this.dispatcher → this.host.dispatcher; this.server.sendLoggingMessage → this.host.sendLoggingMessage;
//   this.connectionMode === 'editor' → this.conn !== null(onStateChange 判定);
//   establish 成功的 connectionMode='editor'+setConnectionMode → host.onConnected();
//   handleStall/init 降级的 connectionMode='headless' → host.onDegrade()。

import { EditorConnection } from './EditorConnection.js';
import { EditorToolExecutor } from './EditorToolExecutor.js';
import type { HealthMonitor } from './health-monitor.js';
import { dynamicSchema } from './dynamic-schema.js';
import { waitForEditorSecret } from './editor-auth.js';
import { getLogger } from './logger.js';
import { safeRealPath } from './path-utils.js';

const EDITOR_SECRET_TIMEOUT_MS = 5000;

/** SDK logging level union(对齐 @modelcontextprotocol/server sendLoggingMessage 的 level)。 */
type EditorLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

/** manager 需要的 dispatcher 操作窄接口(避免耦合 ToolDispatcher 全貌)。ToolDispatcher 结构兼容。 */
export interface EditorDispatcher {
  getHealthMonitor(): HealthMonitor;
  setEditorExecutor(executor: EditorToolExecutor | null): void;
  markEditorFallback(): void;
  degradeToHeadless(): void;
  setConnectionMode(mode: 'headless' | 'editor'): void;
}

/** manager 与 GodotServer 的交互边界。 */
export interface EditorConnectionHost {
  dispatcher: EditorDispatcher;
  /** 走 SDK 正规 logging 路径(notifications/message),用于重连后通知客户端。 */
  sendLoggingMessage(opts: { level: EditorLogLevel; logger: string; data: string }): unknown;
  /** 连接成功建立/重建 → GodotServer 同步 connectionMode='editor' + setConnectionMode('editor')。 */
  onConnected(): void;
  /** 连接降级(重连耗尽/心跳卡死/初始化失败)→ GodotServer 同步 connectionMode='headless'。 */
  onDegrade(): void;
}

export interface EditorConnectionOptions {
  port: number;
  projectPath: string | null;
  noFallback: boolean;
}

export class EditorConnectionManager {
  private conn: EditorConnection | null = null;
  private executor: EditorToolExecutor | null = null;
  // P2-1R (CMP-1 TOCTOU): 自动重连后 verifyProject 校验期 gate,EditorToolExecutor 入口即时返
  // VERIFICATION_IN_PROGRESS,防 editor 工具作用错误项目场景树。
  private _editorVerifying = false;
  /** B-T5: pingFn catch 保留 err.code,供 onStateChange 分流。 */
  private _lastPingErrCode: string | undefined;
  private readonly port: number;
  private readonly projectPath: string | null;
  private readonly noFallback: boolean;
  private readonly host: EditorConnectionHost;
  /** A-2: 并发 rebuild in-flight 去重锁(对齐 game-bridge _connectionLock)。 */
  private _rebuildPromise: Promise<{ connected: boolean; detail: string }> | null = null;

  constructor(host: EditorConnectionHost, opts: EditorConnectionOptions) {
    this.host = host;
    this.port = opts.port;
    this.projectPath = opts.projectPath;
    this.noFallback = opts.noFallback;
  }

  /** 当前 editor 连接(供 GodotServer 的 provider 读状态/发 RPC)。 */
  getConn(): EditorConnection | null {
    return this.conn;
  }

  isConnected(): boolean {
    return this.conn?.isConnected() ?? false;
  }

  /** editor 连接对应的项目路径(供 GodotServer.close 的 overrides 卸载用)。 */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /**
   * 初始化 editor 连接(run() editor 分支调用)。返回 {connected, detail};
   * 进程级 exit(noFallback)归 GodotServer。降级副作用(markEditorFallback +
   * setConnectionMode headless)在此处理,exit 前的 log 归 GodotServer。
   */
  async init(): Promise<{ connected: boolean; detail: string }> {
    let secret: string | undefined;
    if (this.projectPath) {
      secret = (await waitForEditorSecret(this.projectPath, EDITOR_SECRET_TIMEOUT_MS)) ?? undefined;
    }
    if (!secret) {
      getLogger().warn('auth', 'No editor secret found — plugin may not be running');
      this.initDegrade('Running in Headless mode (no editor auth).');
      return { connected: false, detail: 'No editor secret found — plugin may not be running.' };
    }
    const result = await this.establish(this.port, secret);
    if (result.connected) {
      getLogger().info('godot-mcp', result.detail);
      return result;
    }
    this.initDegrade(`${result.detail}. Running in Headless mode. UndoRedo disabled, no scene state persistence.`);
    return result;
  }

  /** run() 初始化期的降级(markEditorFallback + setConnectionMode headless;非 degradeToHeadless)。 */
  private initDegrade(reason: string): void {
    getLogger().warn('godot-mcp', reason);
    this.host.dispatcher.markEditorFallback();
    this.host.dispatcher.setConnectionMode('headless');
    this.host.onDegrade();
  }

  /**
   * 方案B: editor 降级后(conn=null),manage_tools reconnect 触发重建连接。
   * 重新读 secret(editor 可能重启换密钥)+ establish。失败保持 headless(不 exit)。
   *
   * A-2 (2026-08-14 findings :936): 并发 rebuild in-flight 去重(对齐 game-bridge 的
   * _connectionLock 模式)。并发两次调用时败者 establish 的清理会误伤胜者:
   * 败者 catch `this.conn=null` 误清纯者刚建的新 conn → 胜者 verifyProject 假 mismatch
   * "(no connection)" → mismatch 分支 `this.conn.disconnect()` 在 null 上 TypeError 被吞
   * → 胜者 ws 保持 OPEN 无人断(占 MAX_PEERS 槽 + 僵尸重连)。
   * 非有意 async: 返回共享 Promise 保持引用相等(败者拿到胜者同一 Promise),async 包装会新建。
   */
  rebuild(): Promise<{ connected: boolean; detail: string }> {
    if (this._rebuildPromise) return this._rebuildPromise;
    this._rebuildPromise = this._doRebuild()
      .finally(() => { this._rebuildPromise = null; });
    return this._rebuildPromise;
  }

  private async _doRebuild(): Promise<{ connected: boolean; detail: string }> {
    if (this.projectPath === null) {
      return { connected: false, detail: 'editor 连接信息丢失(未初始化),重启 MCP 服务端恢复' };
    }
    const secret = (await waitForEditorSecret(this.projectPath, EDITOR_SECRET_TIMEOUT_MS)) ?? undefined;
    if (!secret) {
      return { connected: false, detail: '未找到 editor secret(插件未运行?),用 launch_editor / F5 启动编辑器后重试 reconnect' };
    }
    return this.establish(this.port, secret);
  }

  /** close() 时清理:断连 + 清 dispatcher executor 引用(原 GodotServer.close 的 editor 段)。 */
  close(): void {
    if (this.conn) {
      this.conn.disconnect();
      this.conn = null;
      this.host.dispatcher.setEditorExecutor(null);
    }
  }

  /**
   * 建立 editor 连接:new EditorConnection + connect + executor 接线 + 挂降级 handler。
   * 成功 → host.onConnected();失败 → 清理 conn,返回 {connected:false}。
   * 不含 exit / init 降级语义;rebuild 复用此方法(失败不 exit,保持 headless)。
   * I-04: 降级用专用 reconnectExhausted handler(非 disconnect handler——后者每次 ws.close 触发会过早降级)。
   */
  private async establish(port: number, secret: string): Promise<{ connected: boolean; detail: string }> {
    // 清理旧连接(rebuild 场景:降级后可能有残留或并发重建)。显式 destroy 旧 executor 防 handler 残留。
    if (this.executor) {
      try { this.executor.destroy(); } catch { /* best-effort */ }
      this.executor = null;
    }
    if (this.conn) {
      try { this.conn.disconnect(); } catch { /* best-effort */ }
      this.conn = null;
    }
    const conn = new EditorConnection({
      port,
      reconnect: true,
      secret,
      maxReconnectAttempts: readPositiveIntEnv('GODOT_MCP_EDITOR_RECONNECT_ATTEMPTS', 20),
      reconnectInterval: readPositiveIntEnv('GODOT_MCP_EDITOR_RECONNECT_INTERVAL', 1000),
      maxReconnectInterval: readPositiveIntEnv('GODOT_MCP_EDITOR_RECONNECT_MAX_INTERVAL', 60000),
      // C4（反馈 2026-11-11）：editor 单请求 30s 硬超时可配——此前 establish 构造漏传
      // requestTimeout，EditorConnection 恒用默认 30000。默认不变（行为兼容）。
      requestTimeout: readPositiveIntEnv('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS', 30000),
    });
    this.conn = conn;
    try {
      await conn.connect();
      // CMP-1 (2026-08-08): 连接成功后立即校验 editor 对应的项目根,防跨项目误操作。
      // projectPath=null(无 project.godot 上下文)→ 跳过,不阻断。
      const projectCheck = await this.verifyProject();
      if (!projectCheck.ok) {
        // A-2: 断开的是本次新建的 conn(局部引用)。用 this.conn 会在并发重建把它换成
        // 新 conn 时误断胜者,且 this.conn=null 误清胜者 → 其 ws 孤儿。
        try { conn.disconnect(); } catch { /* best-effort */ }
        if (this.conn === conn) this.conn = null;
        const expected = projectCheck.expected ?? '(unknown)';
        const actual = projectCheck.actual ?? '(unreadable)';
        return { connected: false, detail: `Editor project mismatch: expected ${expected}, got ${actual}` };
      }
      // B-T3: hm 提前到 EditorToolExecutor 构造前复用,注入 _executeInner 半开 HOL 预检。
      const hm = this.host.dispatcher.getHealthMonitor();
      this.executor = new EditorToolExecutor(this.conn, hm, () => this._editorVerifying);
      this.host.dispatcher.setEditorExecutor(this.executor);
      // CMP-16-B: editor (重)连接成功 → 清 dynamic schema 缓存,下次 tools/list 重新拉取。
      dynamicSchema.invalidate();
      this.conn.addOnReconnectExhaustedHandler(() => {
        getLogger().warn('godot-mcp', 'Editor reconnect attempts exhausted — degrading to headless mode.');
        this.handleStall();
      });
      // B-T5: 编辑器重连成功 → 即刻复位 hm state=connected + 清 heartbeat 失败计数。
      this.conn.addOnReconnectHandler(() => {
        if (hm) hm.reset();
        // CMP-1 NIT-1: 自动重连后重新校验项目匹配(editor 可能重连到不同项目)。
        // fire-and-forget:mismatch 则 handleStall 降级。校验期 _editorVerifying=true 防 TOCTOU。
        this._editorVerifying = true;
        void this.verifyProject().then((check) => {
          if (!check.ok) {
            getLogger().warn('auth', `Editor project changed after reconnect: expected ${check.expected ?? '(unknown)'}, got ${check.actual ?? '(unreadable)'} — degrading to headless.`);
            this.handleStall();
          }
        }).catch((err: unknown) => {
          // P2-12(2026-08-21 七维度审核): verifyProject 自身全路径兜底 resolve,但
          // then 回调内 handleStall/degrade 链同步抛错时此链无 .catch 会成 unhandled
          // rejection(同文件其余 void 调用均带 .catch,唯独此链裸奔)。
          getLogger().warn('auth', `post-reconnect project verify chain failed: ${err instanceof Error ? err.message : String(err)}`);
        }).finally(() => {
          this._editorVerifying = false;
        });
        // IPC-R4: 重连后通知客户端场景树可能 stale(best-effort)。
        try {
          const maybePromise = this.host.sendLoggingMessage({
            level: 'warning',
            logger: 'server',
            data: 'Editor reconnected — scene tree may be stale. Re-run editor_get_scene_tree to refresh cached node paths.',
          });
          if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
            (maybePromise as Promise<void>).catch(() => {});
          }
        } catch { /* best-effort:通知失败不影响重连 */ }
      });
      // ipc P0-2: 接线 HealthMonitor 心跳 — 检测编辑器卡死(TCP OPEN 但主线程阻塞时 ping 超时 → 降级)。
      if (hm) {
        hm.startHeartbeat(
          () => (this.conn
            ? this.conn.request('ping', {}, { timeoutMs: 5000 })
                .then(() => { this._lastPingErrCode = undefined; return true; })
                .catch((err: unknown) => {
                  // B-T5: 保留 err.code 供 onStateChange 分流。
                  const e = err as { code?: string } | null | undefined;
                  this._lastPingErrCode = e?.code;
                  return false;
                })
            : Promise.resolve(false)),
        );
        // 2026-07-12 P0 控制回路 + B-T5 分流:
        // - REQUEST_TIMEOUT(TCP OPEN 主线程卡死)→ handleStall 降级。
        // - NOT_CONNECTED/CONNECTION_LOST(下线/瞬时不可达)→ 不降级,让 EditorConnection 自动重连兜底。
        //   this.conn !== null 等价原 this.connectionMode === 'editor'(conn 存在即 editor 活跃)。
        hm.onStateChange((_from, to) => {
          if (to === 'reconnecting' && this.conn !== null) {
            if (this._lastPingErrCode === 'REQUEST_TIMEOUT') {
              getLogger().warn('godot-mcp', 'Heartbeat REQUEST_TIMEOUT (editor main thread blocked) — degrading to headless.');
              this.handleStall();
            } else {
              getLogger().info('godot-mcp', `Heartbeat ${this._lastPingErrCode || 'unknown'} (editor down/refused) — letting auto-reconnect handle, not degrading.`);
            }
          }
        });
        // B6: 显式 setState('connected') 即刻复位(rebuild 后 hm 可能残留 'reconnecting')。首次连接为 no-op。
        hm.setState('connected');
      }
      this.host.onConnected();
      return { connected: true, detail: `Connected to Godot plugin on port ${port}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A-2: 仅当 this.conn 仍是本次新建的 conn 才清。无条件 `this.conn=null` 在并发
      // 重建场景会误清纯者刚建的新 conn → 胜者 verifyProject 假 mismatch + 孤儿 ws。
      if (this.conn === conn) this.conn = null;
      return { connected: false, detail: `Editor connection failed: ${msg}` };
    }
  }

  /** 编辑器不可用时的统一降级动作(WS 重连耗尽 / 心跳卡死 / 项目不匹配 共用)。 */
  private handleStall(): void {
    // B2: 清 zombie——旧 EditorConnection 的 WS 仍 OPEN + reconnectEnabled=true,
    // 不 disconnect 则闭包重连耗尽后跨实例触发 reconnectExhausted 再降级。
    try { this.conn?.disconnect(); } catch { /* best-effort */ }
    this.host.dispatcher.markEditorFallback();
    // I-04: atomic degradeToHeadless() 避免 two separate _pendingModeSwitch writes racing。
    this.host.dispatcher.degradeToHeadless();
    // 降级后停心跳:conn 置 null 后 pingFn 必返 false,继续 recordFailure 是噪声。
    this.host.dispatcher.getHealthMonitor().stopHeartbeat();
    this.conn = null;
    // CMP-16-B: editor 降级 → 清 dynamic schema 缓存(下次 tools/list 降级到 godot_advanced_tool 兜底)。
    dynamicSchema.invalidate();
    this.host.onDegrade();
  }

  /**
   * CMP-1 (2026-08-08): 校验 editor 连接对应的项目根与配置一致。
   * 发 editor_get_project_path RPC 读 editor 的 res:// 绝对路径,与 this.projectPath
   * 归一化比对。mismatch → ok:false(调用方 disconnect + 降级)。
   * projectPath=null(无 project.godot 上下文)→ 跳过校验(ok:true,不阻断)。
   */
  private async verifyProject(): Promise<{ ok: boolean; expected?: string; actual?: string }> {
    if (this.projectPath === null) {
      return { ok: true };
    }
    if (!this.conn) {
      return { ok: false, expected: this.projectPath, actual: '(no connection)' };
    }
    try {
      const resp = await this.conn.request('editor_get_project_path', {}, { timeoutMs: 5000 }) as Record<string, unknown> | null;
      const actual = String(resp?.project_path ?? '');
      if (!actual) {
        return { ok: false, expected: this.projectPath, actual: '(empty)' };
      }
      if (normalizeForCompare(actual) !== normalizeForCompare(this.projectPath)) {
        // NIT-3: 字面比对不等时,再做一次 realpath 归一化比对(防 junction/symlink 致两端表示不同)。
        try {
          const realActual = safeRealPath(actual);
          const realExpected = safeRealPath(this.projectPath);
          if (normalizeForCompare(realActual) === normalizeForCompare(realExpected)) {
            return { ok: true };
          }
        } catch { /* realpath 失败则用字面比对结果(保守拒绝) */ }
        return { ok: false, expected: this.projectPath, actual };
      }
      return { ok: true };
    } catch (err) {
      // RPC 超时 / error → 保守拒绝(读不到 project_path 不应静默通过)。
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, expected: this.projectPath, actual: `(unreadable: ${msg})` };
    }
  }
}

/** 运行时读 env(连接低频,且避免测试需在 import 前设 env;对齐原 GodotServer 实现)。
 * 非法值(非正整数)回落默认并 console.warn 一行(C4,反馈 2026-11-11——静默回落会让
 * 用户以为设大了超时而实际没生效)。 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn(`[godot-mcp] invalid ${name}="${raw}", falling back to ${fallback}`);
  return fallback;
}

/** CMP-1: 路径归一化用于跨端比对(editor res:// 绝对路径 vs 配置 projectPath)。 */
function normalizeForCompare(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}
