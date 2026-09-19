/**
 * Bridge 客户端核心 —— TCP 连接/认证/NDJSON 协议/keepalive/订阅重发/端口 registry 解析。
 *
 * 2026-08-21 架构审查 MAJOR-3 下沉:原在 src/tools/game-bridge.ts 的客户端基础设施
 * (1-565 行)抽出,使 CLI 子命令(gif 等)不必 import tools 层即可使用 bridge;
 * tools/game-bridge.ts 保留 MCP 工具定义并 re-export 本模块符号(消费方零改动)。
 *
 * 依赖边界(与 core 层约束一致):
 * - 不依赖 tools(lint 门禁 no-restricted-imports 拦截)
 * - 不依赖 dashboard:连接成功时的 Dashboard 自动拉起经 setOnBridgeConnected
 *   回调注入(由 GodotServer.run() 装配——2026-09-17 H-3/O2 归位),避免 core→dashboard→helpers→core 环
 * - parseAutoloadNames 取自 src 根 gdscript-executor(autoload 健康预检;
 *   gdscript-executor→tools/shared 的既有环是历史债,非本下沉引入)
 */
import { createConnection, Socket } from 'net';
import { createHmac } from 'crypto';
import { readFileSync, existsSync, lstatSync, chmodSync, statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { userInfo } from 'os';
import { execFileSync, type ChildProcess } from 'child_process';
import { getErrorMessage } from '../types.js';
import { parseAutoloadNames } from '../gdscript-executor.js';
import { getLogger } from './logger.js';
import { getDefaultRegistryDir, DEFAULT_PORT_START, DEFAULT_PORT_END } from './instance-manager.js';
// 批4-T2: 与 EditorConnection 共用降级记忆 TTL(单一常量防两处 drift)
import { LEGACY_AUTH_RETRY_TTL_MS } from './EditorConnection.js';

export const BRIDGE_PORT = 9081;
export const BRIDGE_HOST = 'localhost';
export const BRIDGE_SCRIPT_NAME = 'mcp_bridge.gd';
// G-5 (2026-08-14 批D实测发现): autoload 段的键名就是 Godot 节点名,不得带 'autoload/' 前缀 —
// 旧版(≤0.23.x)误写 'autoload/MCPBridge',Godot 截断为同名 "autoload" 节点(MCPBridge 与
// MCPOVERRIDE_* 冲突 → override 未加载)。写入键已去前缀;LEGACY 常量仅用于识别/迁移旧键。
export const AUTOLOAD_KEY = 'MCPBridge';
const DEFAULT_TIMEOUT = 10000;

/** Bridge 连不上 / 未正常工作(游戏未运行、未装 autoload、认证失败)。agent 自愈:启动游戏 / 确认安装。 */
export class BridgeNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeNotConnectedError';
  }
}
/** Bridge 连上 + 认证成功后请求无响应(游戏被 runtime error 卡住)。agent 自愈:查游戏报错 / 加大 timeout。 */
export class BridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTimeoutError';
  }
}

export const ERROR_CODES = {
  BRIDGE_NOT_CONNECTED: 'BRIDGE_NOT_CONNECTED',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  BRIDGE_ERROR: 'BRIDGE_ERROR',
} as const;

/** Clamp a millisecond timeout value. Returns default on invalid/zero input.
 *  Exported for pure-function unit tests (game-bridge-validation.test.ts)。 */
export function clampTimeoutMs(value: unknown, min = 1000, max = 60000, def = 10000): number {
  if (value === undefined || value === null) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ─── A1 (2026-08-19 反馈 bridge 9081 多实例劫持): 实际端口解析 ────────────────
// GD 侧 mcp_bridge.gd 启动时把 projectPath/port/pid/lastSeen 写入 machine-level
// registry(30s 心跳,退出删除),端口被占时自动递增避让。TS 侧按 projectPath 匹配
// 最新存活条目取实际端口;registry 不可读/无匹配/条目全部超龄(崩溃残留)时回落 9081,
// 对旧版 GD(不写 machine registry)完全兼容。
const BRIDGE_REGISTRY_MAX_AGE_MS = 5 * 60 * 1000;  // 心跳 30s,容 10 个心跳周期
export { BRIDGE_REGISTRY_MAX_AGE_MS };  // A4 (2026-09-16): game-bridge install 清残留 secret 的判活窗口与此同源

// ─── A3 (2026-09-16 反馈批): 连接失败端口记忆 ───────────────────────────────
// 多实例/残留 secret 场景: registry 命中或 mtime 扫描选中的端口可能属于刚死掉的实例
// (被 kill 的进程不走 _exit_tree,secret 与超龄心跳均残留;PERSISTENT_SECRET 模式
// secret 恒不删且 mtime 恒旧,被任何陈旧文件压过 — 2026-09-03 反馈)。ECONNREFUSED
// 时把端口记入失败集合(TTL 内端口解析自动避开、降级到次新候选),下次调用即恢复,
// 无需人工删 secret。TTL 有限防"端口复活后永久拉黑"。
const PORT_FAILURE_TTL_MS = 60_000;
const _failedPorts = new Map<number, number>();  // port → failedAt(ms)

/** 标记端口连接失败(ECONNREFUSED)——TTL 内 resolveBridgePort/scanSecretWindow 避开它。 */
export function _markPortFailed(port: number): void {
  _failedPorts.set(port, Date.now());
}

/** 端口是否处于失败记忆期内。 */
export function _isPortFailed(port: number): boolean {
  const at = _failedPorts.get(port);
  if (at === undefined) return false;
  if (Date.now() - at > PORT_FAILURE_TTL_MS) {
    _failedPorts.delete(port);  // 惰性过期
    return false;
  }
  return true;
}

/** 镜像 GD 侧 machine registry 目录。GD: OS.get_data_dir().get_base_dir().get_base_dir()/
 *  .godot-mcp/instances —— 实测三平台(Win %APPDATA%/Linux ~/.local/share/mac ~/Library/
 *  Application Support)两次 base_dir 都归一到用户主目录,与 instance-manager.getDefaultRegistryDir
 *  (既有实现,~/.godot-mcp/instances)一致,直接复用防两处推导漂移。
 *  env GODOT_MCP_BRIDGE_REGISTRY_DIR 可重定向(测试注入;发现类信息源,重定向不涉安全边界)。 */
export function machineRegistryInstancesDir(): string {
  const override = process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  if (override && override.trim() !== '') return override;
  return getDefaultRegistryDir();
}

/** 项目路径归一化(分隔符统一 + Windows 大小写不敏感)用于跨进程 projectPath 匹配。 */
export function normalizeProjectKey(p: string): string {
  const r = resolve(p).replace(/[/\\]+/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Task 4.4(2026-09-17 审查 Low): registry 条目新鲜度取值(epoch ms)——优先 lastSeenMs
 *  (新版 GD 心跳写入,Time.get_unix_time_from_system()*1000,UTC epoch 毫秒精度),旧条目
 *  回落无时区 ISO 串(秒级,JS 按本地时区解析——GD 写本地墙钟、TS 同机读,同机一致)。
 *  两形态均为 epoch ms,rolling upgrade 混居可直接比较。无有效时间返回 NaN(调用方跳过)。 */
function entryLastSeenMs(entry: { lastSeen?: unknown; lastSeenMs?: unknown }): number {
  if (typeof entry.lastSeenMs === 'number' && Number.isFinite(entry.lastSeenMs)) return entry.lastSeenMs;
  return typeof entry.lastSeen === 'string' ? Date.parse(entry.lastSeen) : NaN;
}

/** 解析 projectPath 对应 bridge 实例的实际监听端口(见区块注释);失败回落 BRIDGE_PORT。
 *  registryDir 参数仅供单测注入,生产走 machineRegistryInstancesDir()。 */
export function resolveBridgePort(projectPath: string, registryDir: string = machineRegistryInstancesDir()): number {
  // N-d(批5审查挂账): 显式端口覆盖(测试注入,先例对齐 GODOT_MCP_BRIDGE_REGISTRY_DIR;
  // 发现类信息——只改连接目标端口,auth 语义防线不变,不涉安全边界)。测试 mock server 用
  // listen(0) 动态端口,出 scanSecretWindow 固定窗口 9081-9090(GD 侧 mcp_bridge.gd 环形
  // 绑定同窗口,是生产硬约束,不为测试扩窗)——无此覆盖时固定绑 9090 与 e2e editor 测试
  // (E2E_EDITOR=1 同端口)仅靠测试门控隔离。生产无人设此 env,零行为变化。
  const forced = Number(process.env.GODOT_MCP_BRIDGE_PORT_OVERRIDE);
  if (Number.isInteger(forced) && forced >= 1 && forced <= 65535) return forced;
  if (!projectPath) return BRIDGE_PORT;
  try {
    const dir = registryDir;
    const want = normalizeProjectKey(projectPath);
    const now = Date.now();
    let best: { port: number; lastSeen: number; pid: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let entry: { projectPath?: unknown; port?: unknown; lastSeen?: unknown; lastSeenMs?: unknown; pid?: unknown; capabilities?: unknown };
      try {
        entry = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as typeof entry;
      } catch { continue; }  // 损坏条目(崩溃 .tmp 残留等)容错跳过
      if (typeof entry.port !== 'number') continue;
      // 同目录还住着 server 自注册条目(capabilities=['ts-http-receiver']),只认 bridge 心跳条目
      if (!Array.isArray(entry.capabilities) || !entry.capabilities.includes('registry-heartbeat')) continue;
      if (typeof entry.projectPath !== 'string' || normalizeProjectKey(entry.projectPath) !== want) continue;
      const lastSeen = entryLastSeenMs(entry);
      if (!Number.isFinite(lastSeen) || now - lastSeen > BRIDGE_REGISTRY_MAX_AGE_MS) continue;
      // A3: 失败记忆期内的端口跳过(刚 ECONNREFUSED 过的实例条目仍可能新鲜),降级次新心跳。
      if (_isPortFailed(entry.port)) continue;
      // Task 4.4(2026-09-17 审查 Low): lastSeen 相同(旧串同秒/同毫秒双开)→ pid 决胜——
      // 高 pid=后起进程;此前平票靠 readdir 目录顺序摇摆取胜利者(非确定,Windows/Linux
      // 顺序不同),现平票语义固定。pid 缺失(旧条目)按 0 参与,不改变先后判定。
      const pid = typeof entry.pid === 'number' && Number.isFinite(entry.pid) ? entry.pid : 0;
      if (!best || lastSeen > best.lastSeen || (lastSeen === best.lastSeen && pid > best.pid)) {
        best = { port: entry.port, lastSeen, pid };
      }
    }
    if (best) return best.port;
    return scanSecretWindow(projectPath);
  } catch {
    // registry 目录不可读/漂移:同样走窗口扫描而非盲回落(见 scanSecretWindow 注释)
    return scanSecretWindow(projectPath);
  }
}

/** A4 (2026-09-16 反馈批,审查 B-1 修复): 读 machine-level registry,返回 projectPath 的
 *  新鲜心跳端口集合 —— clean_stale_secrets 的判活依据。位置契约:与 resolveBridgePort 同源
 *  (GD machine_dir = OS.get_data_dir() 两次 base_dir → ~/.godot-mcp/instances,跨进程对齐
 *  已被 resolveBridgePort 长期验证)。⚠️ 勿读 {project}/.godot/mcp-instances —— GD 的
 *  project-level 心跳写在 user://(app_userdata,非项目目录),TS 侧不可达(审查 B-1 教训:
 *  首版误按项目目录读,判活恒空集致清理永不执行)。过滤同 resolveBridgePort:capabilities
 *  含 registry-heartbeat(排除 server 自注册条目)+ projectPath 归一化匹配 + lastSeen 新鲜。
 *  registry 不可读/全损坏 → 空集(调用方按"无法判活"保守处理)。 */
export function liveHeartbeatPortsFor(
  projectPath: string,
  registryDir: string = machineRegistryInstancesDir(),
): Set<number> {
  const ports = new Set<number>();
  try {
    const want = normalizeProjectKey(projectPath);
    const now = Date.now();
    for (const name of readdirSync(registryDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(registryDir, name), 'utf-8')) as {
          port?: unknown; projectPath?: unknown; lastSeen?: unknown; lastSeenMs?: unknown; capabilities?: unknown;
        };
        if (typeof entry.port !== 'number') continue;
        if (!Array.isArray(entry.capabilities) || !entry.capabilities.includes('registry-heartbeat')) continue;
        if (typeof entry.projectPath !== 'string' || normalizeProjectKey(entry.projectPath) !== want) continue;
        const lastSeen = entryLastSeenMs(entry);  // Task 4.4: lastSeenMs 优先(同 resolveBridgePort)
        if (!Number.isFinite(lastSeen) || now - lastSeen > BRIDGE_REGISTRY_MAX_AGE_MS) continue;
        ports.add(entry.port);
      } catch { /* 损坏条目容错跳过 */ }
    }
  } catch { /* registry 目录不可读 → 空集(调用方按无法判活保守处理) */ }
  return ports;
}

/** registry 未命中时的回落:按 secret 文件存在性扫 DEFAULT_PORT_START..END(9081-9090)。
 *  2026-08-21 PR#57 CI 实测暴露:mcp_bridge.gd 缓解批起始候选随机化后 GD 大概率不绑 9081,
 *  盲回落 9081 从「无害」变「连不上」(Linux CI registry 未命中是首个受害面,即缓解批审查
 *  盲回落 9081 从「无害」变「连不上」(Linux CI registry 未命中是首个受害面,即缓解批审查
 *  披露的 Important-B 残留缝)。secret 文件名含避让后端口且位于 projectDir/.godot/ 内,
 *  按存在性扫天然精确;多个共存(同项目多实例竞态)取 mtime 最新,连错由 auth 语义防线拒绝
 *  (与缓解批立场一致)。全窗口无 secret(bridge 未跑/旧版 GD)仍回落 9081(旧版确定性绑定)。 */
function scanSecretWindow(projectDir: string): number {
  let scan: { port: number; mtime: number } | null = null;
  let fallback: { port: number; mtime: number } | null = null;  // A3: 全部候选都失败时的 mtime 最新(避无可避,维持候选语义)
  for (let p = DEFAULT_PORT_START; p <= DEFAULT_PORT_END; p++) {
    try {
      const st = statSync(bridgeSecretPathFor(projectDir, p));
      if (!fallback || st.mtimeMs > fallback.mtime) fallback = { port: p, mtime: st.mtimeMs };
      // A3: 失败记忆期内的端口跳过(陈旧 secret 压过活实例的 mtime 误导场景,2026-09-03 反馈)
      if (_isPortFailed(p)) continue;
      if (!scan || st.mtimeMs > scan.mtime) scan = { port: p, mtime: st.mtimeMs };
    } catch { /* 该端口无 secret,继续 */ }
  }
  return scan?.port ?? fallback?.port ?? BRIDGE_PORT;
}

/** 按实际端口拼 secret 文件路径(GD 侧 secret 文件名含避让后的端口)。 */
export function bridgeSecretPathFor(projectDir: string, port: number): string {
  return join(projectDir, '.godot', `mcp_bridge_${port}.secret`);
}

export interface BridgeResponse {
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

let _nextRequestId = 1;
let _permWarned = false;
let _cachedSecret: string | null = null;
let _projectDir: string | null = null;
let _cachedSecretAt: number = 0;
// A-06: 5-minute TTL balances file I/O overhead vs attack window exposure.
// Shorter TTL increases fs reads; longer TTL extends the window if secret is compromised.
// For local-only TCP (127.0.0.1), this is an acceptable tradeoff.
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Persistent connection state
let _socket: Socket | null = null;
let _socketAuthenticated = false;
let _socketBuffer = '';
let _connectionLock: Promise<Socket> | null = null;
// 3A (2026-09-19 安全加固批3): 明文 auth 降级记忆——auth_begin 收到旧 bridge 的 error
// 响应后置 true,本进程后续连接直接走 legacy(免每次探测)。见 _doConnect。
// 批4-T2(五维评估 P2): 配套 _bridgeLegacyAuthSince 时间戳,TTL 过期后下次连接重试 CR
// (成功即复位)——缩窄"一次诱导降级 → 进程生命周期内持续明文"的窗口(N-2 残余面收敛)。
let _bridgeLegacyAuth = false;
let _bridgeLegacyAuthSince = 0;

// 首次连接成功回调(由 GodotServer.run() 装配 launchDashboardOnce——2026-09-17 H-3/O2 归位;core 不依赖 dashboard)
let _onBridgeConnected: (() => void) | null = null;

/** 注入"首次 bridge 连接成功"回调(控制面 GodotServer.run() 接线 Dashboard 自动拉起);传 null 注销。 */
export function setOnBridgeConnected(cb: (() => void) | null): void {
  _onBridgeConnected = cb;
}

// P3-6: push 模式。常驻 data handler 收到 bridge/event 消息时调此回调。
// 由 GodotServer 注册(转发为 MCP notification)。null 时 push 消息被忽略。
let _pushMessageHandler: ((params: Record<string, unknown>) => void) | null = null;
// 常驻 push handler 的缓冲区(独立于 sendToBridge 的临时 buffer,避免互相消费)
let _pushBuffer = '';

// Request serialization: ensures only one sendToBridge uses the socket at a time.
// Without this, concurrent calls register overlapping 'data' handlers on the shared
// socket, causing each handler to see partial/mixed response data.
let _sendLock: Promise<unknown> = Promise.resolve();
// in-flight 计数器(d20b1ff 移植,2026-08-20 可靠性审查):原用 Promise.resolve() ===
// _sendLock 引用比较检测,首次请求后 _sendLock 永远是 new 出的实例,恒判 in-flight
// (setBridgeProjectDir 每次 warn,监控价值归零)。计数器在锁链 run() 开始 ++ /
// finally --,resetBridgeState 对称重置。C 组下沉 core 时此修复未随迁,本次补齐。
let _sendInflight = 0;

// G-1 (2026-08-14 审查 :935 P1): 订阅登记表 — bridge 断线重连后自动重发 watch/monitor 订阅。
// 根因: GD 侧 mcp_bridge.gd 60s idle 断线(_cleanup_peer_state 清 per-peer 订阅状态)或 TS 侧
// 请求超时销毁 socket → 重连后无机制重发 watch.start/monitor.start → push 事件从此静默消失、
// watch_poll 返 not watching 无报错。登记成功订阅,_doConnect 成功后重发,恢复推送语义。
interface BridgeSubscription {
  method: 'watch.start' | 'monitor.start';
  params: Record<string, unknown>;
}
let _subscriptions: BridgeSubscription[] = [];
let _resendInFlight: Promise<void> | null = null;

/** 登记订阅(同 method 仅保留最新一条 — GD 侧 per-peer 单例,重复 start 覆盖;登记表同步覆盖防重发重复订阅) */
export function _registerSubscription(method: 'watch.start' | 'monitor.start', params: Record<string, unknown>): void {
  _subscriptions = _subscriptions.filter(s => s.method !== method);
  _subscriptions.push({ method, params: { ...params } });
}

/** 移除订阅登记(watch_stop/monitor_stop 成功或重发被游戏侧拒绝时) */
export function _removeSubscription(method: 'watch.start' | 'monitor.start'): void {
  _subscriptions = _subscriptions.filter(s => s.method !== method);
}

/** 重发登记表中的订阅。fire-and-forget: 经 _sendLock 排队(不与当前 in-flight 请求死锁),
 *  单条失败仅 warn;游戏侧返回 error(节点已销毁等永久失败)时移除登记,防重连重试风暴。 */
function _resendSubscriptions(): void {
  if (_subscriptions.length === 0) return;
  if (_resendInFlight) return;  // 重发自身触发的重连不再叠加
  const pending = [..._subscriptions];
  _resendInFlight = (async () => {
    for (const sub of pending) {
      try {
        const resp = await sendToBridge(sub.method, sub.params, DEFAULT_TIMEOUT);
        if (resp.error) {
          getLogger().warn('bridge', `Resend ${sub.method} after reconnect rejected (${resp.error.code}): ${resp.error.message} — dropping subscription`);
          _removeSubscription(sub.method);
        }
      } catch (err) {
        getLogger().warn('bridge', `Resend ${sub.method} after reconnect failed: ${getErrorMessage(err)} — keeping subscription for next reconnect`);
      }
    }
  })().finally(() => { _resendInFlight = null; });
}

// G-1: 30s ping keepalive — 连接空闲时定期发轻量请求,刷新游戏侧 idle 计时
// (mcp_bridge.gd INACTIVITY_TIMEOUT=60s 无字节即断连),防长 idle 后订阅静默丢失。
const KEEPALIVE_INTERVAL_MS = 30_000;
let _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function _startKeepalive(): void {
  if (_keepaliveTimer) return;
  _keepaliveTimer = setInterval(() => {
    // 注:保持分支形态不合并为单行 `||` 短路——2026-08-21 拆分实测,
    // 单行形态在 game-bridge.test.ts 的 fake-timers keepalive 用例下稳定复现
    // tick 不发 ping(V8 对闭包的 inlining 形状影响 mock 环境的微任务链);
    // 两形态语义等价,生产行为无差异。
    if (!_socket) return;
    if (!_socketAuthenticated) return;
    if (_socket.destroyed) return;
    if (!_socket.writable) return;
    // 失败由 error/close 路径自愈(_invalidateSocket → 下次业务调用重连 + 重发订阅)
    sendToBridge('ping', {}, 5000).catch(() => { /* best-effort: 断线自愈 */ });
  }, KEEPALIVE_INTERVAL_MS);
  _keepaliveTimer.unref?.();  // 不阻塞进程退出
}

function _stopKeepalive(): void {
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
}

/** 读 bridge secret 文件内容(5min TTL 缓存)。Task 4.4(2026-09-17 审查 Low): port 参数由
 *  _doConnect 单次解析后显式传入(secret 读取与 TCP 连接同端口);未传时现解析(旧语义)。
 *  多实例起停会使 registry 解析出的端口变化,路径不缓存(secret 内容缓存不受影响)。 */
function readBridgeSecret(port?: number): string | null {
  if (_cachedSecret !== null && Date.now() - _cachedSecretAt < SECRET_CACHE_TTL) return _cachedSecret;
  _cachedSecret = null;
  if (!_projectDir) {
    throw new Error('Bridge secret path requested before game_bridge_install set project directory');
  }
  const secretPath = bridgeSecretPathFor(_projectDir, port ?? resolveBridgePort(_projectDir));
  try {
    // A4 (2026-07-23 审查): symlink 检查必须在权限收紧之前——否则 secretPath 若是 symlink
    // 指向受害者文件,icacls/chmod 已篡改其 ACL/mode 才被拒(DoS)。对齐 editor-auth.ts:75-81。
    const lstat = lstatSync(secretPath);
    if (lstat.isSymbolicLink()) {
      getLogger().error('security', `Bridge secret file ${secretPath} is a symlink — refusing to read.`);
      return null;
    }
    // Tighten permissions: owner-only
    if (process.platform === 'win32') {
      try {
        // C-ARC-01: Use os.userInfo().username (no env spoofing), strict regex (no backslash)
        // K-4 (2026-08-15): :R → :M。三副本同步漏改——GD 侧 mcp_bridge.gd/websocket_server.gd
        // 的 _restrict_secret_permissions 已从 :R 改 :M(R 是 anti-pattern: e2e 结束后清理删不掉
        // R-only secret → beforeAll 清 .godot 报 EPERM → 后续 e2e L2 整 suite 静默 skip,本地复现),
        // 本读路径每次 readBridgeSecret 都把 ACL 收紧回 R,把 GD 侧的 M 白改了。:M 与
        // editor-auth.ts:32 / instance-api-auth 对齐(M=Read+Write+Delete,owner 可删,其他用户无 ACE)。
        const username = userInfo().username;
        if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
          execFileSync('icacls', [secretPath, '/inheritance:r', '/grant:r', `${username}:M`], { stdio: 'ignore' });
        }
      } catch (err) { getLogger().debug('bridge', `restrict Windows file permissions: ${err}`); }
    } else {
      try {
        chmodSync(secretPath, 0o600);
      } catch (err) { getLogger().debug('bridge', `chmod secret file: ${err}`); }
    }
    const stat = statSync(secretPath);
    if (!_permWarned && process.platform !== 'win32' && (stat.mode & 0o007) !== 0) {
      _permWarned = true;
      getLogger().error('security', `Bridge secret file ${secretPath} is world-readable. Attempted chmod 0600.`);
    }
    _cachedSecret = readFileSync(secretPath, 'utf-8').trim();
    _cachedSecretAt = Date.now();
    return _cachedSecret;
  } catch (err) {
    // ENOENT is normal (bridge not installed yet); other errors are serious
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      getLogger().debug('bridge', `bridge secret not found (expected before install): ${secretPath}`);
    } else {
      getLogger().error('bridge', `read bridge secret failed (${getErrorMessage(err)}): ${secretPath}`);
    }
    return null;
  }
}

function _invalidateSocket(): void {
  if (_socket) {
    try { _socket.destroy(); } catch (err) { getLogger().debug('bridge', `destroy socket: ${err}`); }
    _socket = null;
  }
  _socketAuthenticated = false;
  _socketBuffer = '';
  _pushBuffer = '';  // P3-6: 清理 push buffer
}

/**
 * P3-6: 注册 push 消息回调。Bridge addon 在 watch/monitor push 模式下,
 * 事件产生时主动推送 {method:"bridge/event", params:{type, data}} 消息。
 * 此回调由 GodotServer 注册,将 push 事件转发为 MCP notification。
 * 传 null 注销回调。
 */
export function registerBridgePushHandler(handler: ((params: Record<string, unknown>) => void) | null): void {
  _pushMessageHandler = handler;
}

/** Perform the actual TCP connection and auth handshake.
 *  3A (2026-09-19 安全加固批3): challenge-response 握手编排——auth_begin 探测(默认)→
 *  收到 JSON-RPC error 响应(旧 bridge 版本)→ 记忆降级重连一次明文 auth;探测超时
 *  (哑占位者不回应)**不降级**(防把 secret 主动送给占端口的假监听进程)。
 *  [已知残余面]协议感知的假监听者可伪造 -32001 诱降级收 secret——localhost 明文模型
 *  下不可根除,GODOT_MCP_REQUIRE_CR_AUTH=true 可硬锁拒一切降级。 */
async function _doConnect(timeout: number): Promise<Socket> {
  // 批4-T2: 降级记忆 TTL 内直接明文;过期则重试 CR(成功复位,失败按降级矩阵处置)
  if (_bridgeLegacyAuth && Date.now() - _bridgeLegacyAuthSince < LEGACY_AUTH_RETRY_TTL_MS) {
    return _openSocket(timeout, true);
  }
  try {
    const sock = await _openSocket(timeout, false);
    // 批4-T2: CR 重试成功(降级记忆过期后 bridge 已升级的场景)→ 复位降级记忆
    if (_bridgeLegacyAuth) {
      _bridgeLegacyAuth = false;
      _bridgeLegacyAuthSince = 0;
      getLogger().info('bridge', 'challenge-response retry succeeded — legacy auth fallback memory cleared');
    }
    return sock;
  } catch (err) {
    const e = err as Error & { authPhase?: string };
      if (e.authPhase === 'cr-probe' && !_requireBridgeCrAuth()) {
      _bridgeLegacyAuth = true;
      _bridgeLegacyAuthSince = Date.now();
      getLogger().warn('bridge',
        'auth_begin rejected with JSON-RPC error (old bridge) — falling back to legacy plaintext auth ' +
        '(mcp_bridge.gd 版本过旧?). secret 将明文经 TCP 传输(localhost 模型);' +
        '批4-T2: 降级记忆带 TTL(' + (LEGACY_AUTH_RETRY_TTL_MS / 60000) + 'min),过期后自动重试 proof 模式,无需重启.');
      return _openSocket(timeout, true);
    }
    throw err;
  }
}

/** 强制 challenge-response 模式(高安全 opt-in,与 EditorConnection 共用 env):拒绝明文降级。 */
function _requireBridgeCrAuth(): boolean {
  return process.env.GODOT_MCP_REQUIRE_CR_AUTH === 'true'
      || process.env.GODOT_MCP_BRIDGE_REQUIRE_CR_AUTH === 'true';
}

async function _openSocket(timeout: number, legacyAuth: boolean): Promise<Socket> {
  _invalidateSocket();

  // CMP-5 (2026-08-08): autoload 健康预检——读磁盘 project.godot 的 [autoload] 段,
  // 确认 MCPBridge 在里面。防"游戏进程未加载 bridge autoload"的静默失败
  // (secret 文件存在但 autoload 被 git revert/checkout 删了)。
  if (_projectDir) {
    const autoloads = parseAutoloadNames(_projectDir);
    // G-4 (批D实测发现): 旧版 install 写入带 'autoload/' 前缀的键 → parseAutoloadNames 返回
    // 原始键名(带前缀),裸 includes('MCPBridge') 恒不匹配 → BRIDGE_NOT_CONNECTED 误报
    // (疑致 e2e L2 suite 静默 skip)。去前缀比较,新旧两种写入形态都正确判定。
    if (autoloads.length > 0 && !autoloads.some(name => name.replace(/^autoload\//, '') === AUTOLOAD_KEY)) {
      throw new BridgeNotConnectedError(
        `Bridge autoload 'MCPBridge' missing from ${_projectDir}/project.godot [autoload] section. ` +
        'The game may have started without the Bridge autoload. Run game_bridge_install or re-run the game.',
      );
    }
  }

  // Task 4.4(2026-09-17 审查 Low): 端口单次解析——secret 读取与 TCP 连接此前各调一次
  // resolveBridgePort,两次解析间隙 registry 变化(新实例心跳写入/旧条目超龄淘汰)会
  // secret 读 A 端口、TCP 连 B 端口 → auth 必败(secret 按端口分文件)。单次解析后
  // readBridgeSecret 与 createConnection 共用同一端口(TOCTOU 窗口消除)。
  const port = resolveBridgePort(_projectDir ?? '');
  const secret = readBridgeSecret(port);
  if (!secret) {
    if (!_projectDir) {
      throw new BridgeNotConnectedError(
        'Bridge project directory not set. Use run_project to start the game, or pass project_path parameter. ' +
        'Manual F5 launch requires project_path to locate the Bridge secret.'
      );
    }
    throw new BridgeNotConnectedError(
      `Bridge secret not found at ${bridgeSecretPathFor(_projectDir, port)}. ` +
      'Ensure the game is running with the MCP Bridge autoload installed.'
    );
  }

  return new Promise((resolve, reject) => {
    // A1: 实际端口来自上方单次解析(多实例避让后可能非 9081;Task 4.4 与 secret 同源)
    const sock = createConnection({ port, host: BRIDGE_HOST }, () => {
      // 3A: 默认发 auth_begin(challenge-response 探测);legacy 模式发旧明文 auth
      if (legacyAuth) {
        sock.write(JSON.stringify({ id: 0, method: 'auth', params: { secret } }) + '\n');
      } else {
        sock.write(JSON.stringify({ id: 0, method: 'auth_begin' }) + '\n');
      }
    });

    // 3A: 认证阶段跟踪——cr-probe(探测)/cr-proof(proof 验证)/legacy(明文)。
    // cr-probe 收 error → 旧端(可降级重连);其余阶段 error = 真失败(secret 错/锁定)。
    let authPhase: 'cr-probe' | 'cr-proof' | 'legacy' = legacyAuth ? 'legacy' : 'cr-probe';
    let authDone = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new BridgeNotConnectedError(`Bridge auth timed out after ${timeout}ms`));
    }, timeout);

    sock.on('data', (data: Buffer) => {
      _socketBuffer += data.toString();
      let idx: number;
      while ((idx = _socketBuffer.indexOf('\n')) !== -1) {
        const line = _socketBuffer.substring(0, idx).trim();
        _socketBuffer = _socketBuffer.substring(idx + 1);
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          // N-1(批4审查挂账,批5处置): cr-proof 阶段对端回 result 但 authenticated 非
          // truthy(空 result/显式 false/再发 challenge 等异形)——与 EditorConnection
          // 批4-T1 同语义 `!== true` 立即拒,收敛为单点判定(此前分散在 N-4/:567 两分支,
          // 且 :537 的 auth_begin 措辞在 proof 阶段误导)。proof 阶段失败不降级
          // (authPhase='cr-proof',_doConnect 仅对 'cr-probe' 降级——语义不变)。
          if (!authDone && !legacyAuth && authPhase === 'cr-proof'
              && resp.result !== undefined && resp.result.authenticated !== true) {
            clearTimeout(timer);
            sock.destroy();
            reject(Object.assign(
              new BridgeNotConnectedError(
                `Bridge auth_proof rejected (authenticated is not true${resp.result.authenticated === false ? ': secret mismatch' : ''}). `
                + 'Re-run the game or check the bridge secret file.'),
              { authPhase },
            ));
            return;
          }
          // N-4(审查): 对端回 result 但既无 challenge 也非 authenticated(非本协议 JSON-RPC 端)
          // → 与 EditorConnection 同语义按"有响应可降级"处理(限 auth_begin 探测阶段——
          // proof 阶段的同形态已被上方 N-1 分支拦截);
          // 此前落到 Auth failure 分支产出 "Bridge auth failed (undefined): undefined" 不可读
          if (!authDone && !legacyAuth && authPhase === 'cr-probe'
              && resp.result && resp.result.challenge === undefined
              && resp.result.authenticated === undefined) {
            clearTimeout(timer);
            sock.destroy();
            reject(Object.assign(
              new BridgeNotConnectedError('Bridge auth_begin got result without challenge (old/foreign bridge)'),
              { authPhase },
            ));
            return;
          }
          // N-5(审查): challenge 形态校验对齐 EditorConnection(≥16)——畸形 challenge 拒绝进 proof
          if (!authDone && !legacyAuth && resp.result?.challenge !== undefined
              && (typeof resp.result.challenge !== 'string' || String(resp.result.challenge).length < 16)) {
            clearTimeout(timer);
            sock.destroy();
            reject(Object.assign(
              new BridgeNotConnectedError('Bridge auth_begin got malformed challenge (expected hex string >=16 chars)'),
              { authPhase },
            ));
            return;
          }
          // 3A: challenge-response —— auth_begin 的响应带 challenge → 发 HMAC proof(secret 不上线)
          if (!authDone && !legacyAuth && resp.result?.challenge) {
            authPhase = 'cr-proof';
            const proof = createHmac('sha256', secret).update(String(resp.result.challenge), 'utf8').digest('hex');
            sock.write(JSON.stringify({ id: 1, method: 'auth_proof', params: { proof } }) + '\n');
            return;
          }
          // P3(2026-08-21 七维度审核): auth 被拒(secret 不匹配,authenticated=false)
          // 立即失败——此前干等 auth timeout,secret 错误与 bridge 无响应不可区分。
          if (!authDone && resp.result?.authenticated === false) {
            clearTimeout(timer);
            sock.destroy();
            reject(new BridgeNotConnectedError('Bridge auth rejected: secret mismatch (authenticated=false). Re-run the game or check the bridge secret file.'));
            return;
          }
          if (!authDone && resp.result?.authenticated) {
            authDone = true;
            clearTimeout(timer);
            _socket = sock;
            _socketAuthenticated = true;
            // Detach per-auth handlers — response handling moves to sendToBridge
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            sock.removeAllListeners('close');
            // P3-6: 注册常驻 push data handler(与 sendToBridge 临时 handler 共存)。
            // 只处理 method 字段存在的 push 消息(bridge/event);有 id 的响应由 sendToBridge
            // 的临时 handler 处理(两者各自维护独立 buffer,EventEmitter 广播不互相消费)。
            _pushBuffer = '';
            sock.on('data', (data: Buffer) => {
              if (_socket !== sock) return;  // P1-8 守卫
              _pushBuffer += data.toString();
              let idx: number;
              while ((idx = _pushBuffer.indexOf('\n')) !== -1) {
                const line = _pushBuffer.substring(0, idx).trim();
                _pushBuffer = _pushBuffer.substring(idx + 1);
                if (!line) continue;
                try {
                  const msg = JSON.parse(line) as { method?: string; params?: Record<string, unknown>; id?: number };
                  // 只处理 push 消息(有 method 无 id);响应消息(id 存在)交给 sendToBridge
                  if (msg.method && msg.id === undefined && _pushMessageHandler) {
                    _pushMessageHandler(msg.params ?? {});
                  }
                } catch {
                  // 非 JSON 或部分数据,忽略(sendToBridge 的临时 handler 会处理响应行)
                }
              }
            });
            // Register persistent monitors so a dead/lost connection is detected automatically
            // P1-8: 守卫 _socket === sock — 防止已废弃 socket 的延迟 close/error 事件错误 invalidate
            // 新 socket(A 被 B 替换后,A.destroy() 的 close 异步触发,此时 _socket 已是 B,无守卫会 destroy B)。
            sock.on('close', () => { if (_socket === sock) _invalidateSocket(); });
            sock.on('error', () => { if (_socket === sock) _invalidateSocket(); });
            // G-1: 连接成功 → 启动 keepalive(防 60s idle 断连) + 重发登记的订阅(恢复 push/轮询语义)。
            // 重发经 _sendLock 排队(当前请求 settle 后执行),不与 in-flight 请求死锁。
            _startKeepalive();
            _resendSubscriptions();
            // 首次 Bridge 连接成功回调(Dashboard 自动拉起,由 tools 层注入;core 不依赖 dashboard)
            try { _onBridgeConnected?.(); } catch { /* best-effort */ }
            resolve(sock);
            return;
          }
          // Auth failure response
          clearTimeout(timer);
          sock.destroy();
          if (resp.error?.code === -32001 || resp.error?.code === -32002) {
            _cachedSecret = null;
          }
          // 3A: 挂 authPhase——cr-probe 阶段的 error(旧 bridge 对 auth_begin 回 -32001 后断连)
          // 由 _doConnect 判定降级重连;cr-proof/legacy 阶段的 error = 真失败不降级
          reject(Object.assign(
            new BridgeNotConnectedError(`Bridge auth failed (${resp.error?.code}): ${resp.error?.message}`),
            { authPhase },
          ));
          return;
        } catch {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`Invalid JSON from bridge: ${line}`));
          return;
        }
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ECONNREFUSED') {
        // A3 (2026-09-16 反馈批): 记入失败记忆,下次端口解析自动避开、降级次新候选
        // (registry 心跳超龄前残留 / 陈旧 secret 的 mtime 误导场景,2026-09-03 反馈:
        // "ping 秒败 + netstat 见端口在听"的多 secret 并存形态)。文案带端口可诊断。
        _markPortFailed(port);
        reject(new BridgeNotConnectedError(
          `Cannot connect to MCP Bridge on port ${port} (connection refused). ` +
          'This port is now avoided for 60s — a stale bridge secret or dead instance may own it. ' +
          'Retry the call to fall back to another candidate port; if it persists, run game_bridge_install with clean_stale_secrets: true.'
        ));
      } else {
        reject(new Error(`Bridge connection error: ${err.message}`));
      }
    });

    sock.on('close', () => {
      clearTimeout(timer);
      if (!authDone) reject(new BridgeNotConnectedError('Bridge connection closed during auth'));
    });
  });
}

/** Ensure we have an authenticated persistent connection, serializing concurrent attempts. */
function _ensureConnection(timeout: number): Promise<Socket> {
  if (_socket && _socketAuthenticated && !_socket.destroyed && _socket.writable) {
    return Promise.resolve(_socket);
  }
  if (_connectionLock) return _connectionLock;
  _connectionLock = _doConnect(timeout)
    .then(sock => {
      if (_socket !== sock || !_socketAuthenticated) {
        throw new Error('Connection invalidated during setup');
      }
      return sock;
    })
    // P1-8: 删除 catch 内冗余 _connectionLock=null(finally 必执行已覆盖;catch 仅 re-throw 等价无操作,整个 catch 块移除)。
    .finally(() => { _connectionLock = null; });
  return _connectionLock;
}

/** Set the project directory for bridge secret lookup. Invalidates all cached bridge state.
 *
 * 2026-08-06 审查测试-P2(可靠性 §setBridgeProjectDir race):
 * 若 _sendLock 链上有 in-flight sendToBridge 请求(未 settle),直接 _invalidateSocket 会销毁
 * in-flight 请求持有的 socket → 响应丢失 → 该请求在 timer 后 reject。跨项目切换的并发场景
 * (client A 调 P1,client B 调 setBridgeProjectDir(P2))下,A 失败但 B 可继续,无原子性保证。
 *
 * 本修复:检测到 in-flight 时记录 warn(可视化),仍 invalidate(保持现有契约——bridge 是
 * per-server 单项目,跨项目切换是异常用法,由调用方保证不并发)。彻底修复需引入 per-project
 * 锁 + per-project socket 状态,属架构级改造,超本轮 scope(留 follow-up)。
 */
/** 当前生效的 bridge 项目目录(未设置时 null;工具层 ensureProjectDir 回退判断用)。 */
export function getBridgeProjectDir(): string | null {
  return _projectDir;
}

/** 清除缓存的 bridge secret(auth 失败 -32001/-32002 或 uninstall 后,下次调用重读磁盘)。 */
export function invalidateBridgeSecret(): void {
  _cachedSecret = null;
}

/** 销毁当前连接(状态重置;uninstall 等语义终结场景用,业务代码一般走自动重连)。 */
export function invalidateBridgeConnection(): void {
  _invalidateSocket();
}

export function setBridgeProjectDir(projectDir: string | null): void {
  // P3(2026-08-21 七维度审核): null(清理/close 语义)总是走完整重置——早退分支会让
  // 已置 null 后的二次 null 跳过 _stopKeepalive/_invalidateSocket,与 resetBridgeState
  // 的完整清理不对称(uninstall 路径先 invalidate 再置 null 时残留 keepalive 空转)。
  if (_projectDir === projectDir && projectDir !== null) return;
  // 检测 in-flight:_sendLock 未 settle 意味着有 sendToBridge 正在用 _socket
  // (_sendLock 在 sendToBridge:385-388 获取,.finally(resolveLock) 释放)
  // Promise.resolve() === _sendLock 时表示无 in-flight(初始 settled state)
  const inflightDetected = _sendInflight > 0;
  if (inflightDetected) {
    getLogger().warn('bridge',
      `setBridgeProjectDir('${projectDir}') called while sendToBridge in-flight — ` +
      `in-flight request will be invalidated (socket destroyed). ` +
      `Ensure no concurrent cross-project bridge calls (bridge is per-server single-project).`);
  }
  _projectDir = projectDir;
  _cachedSecret = null;
  _connectionLock = null;
  // G-1: 切项目 = 旧连接语义终结 — 清订阅登记(旧项目订阅对新项目无意义) + 停 keepalive
  _subscriptions = [];
  _stopKeepalive();
  _invalidateSocket();
}

export function sendToBridge(method: string, params: Record<string, unknown> = {}, timeout = DEFAULT_TIMEOUT): Promise<BridgeResponse> {
  // Serialize requests so only one uses the shared socket at a time.
  // Each call chains onto _sendLock, preventing concurrent data handlers.
  const run = () => {
      // Fast-fail if socket is known dead — skip reconnection queue
    if (_socket && _socket.destroyed) {
      _invalidateSocket();
    }
    return _ensureConnection(timeout).then(sock => {
      return new Promise<BridgeResponse>((resolve, reject) => {
        const id = _nextRequestId++;
        let settled = false;
        let buffer = '';

        function doResolve(resp: BridgeResponse) { if (!settled) { settled = true; clearTimeout(timer); resolve(resp); } }
        function doReject(err: Error) { if (!settled) { settled = true; clearTimeout(timer); reject(err); } }

        const timer = setTimeout(() => {
          if (_socket === sock) _invalidateSocket();  // P1-8: 只在 sock 仍是当前 socket 时 invalidate
          doReject(new BridgeTimeoutError(`Bridge request timed out after ${timeout}ms`));
        }, timeout);

        const onData = (data: Buffer) => {
          buffer += data.toString();
          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, idx).trim();
            buffer = buffer.substring(idx + 1);
            if (!line) continue;
            try {
              const resp = JSON.parse(line) as BridgeResponse;
              // P3-6 修复: push 消息(method 存在、id 为空)不是响应,跳过(由常驻 push handler 处理)。
              // 原逻辑 resp.id != null 在 push(无 id)时为 false → 不 continue → 误把 push 当响应 resolve。
              // 修正:响应必须有 id 且匹配当前 request id;无 id 的消息(push/通知)一律跳过。
              if (resp.id == null || resp.id !== id) continue;
              sock.removeListener('data', onData);
              // N-1 (2026-06-24 审查): 成功 resolve 后移除本次 once 监听器。持久 _socket 上 error/close
              // 健康时永不触发,once 不移除 → 每请求泄漏 2 listener → 长连接累积至 MaxListenersExceededWarning。
              // reject 路径(onError/onClose/timeout)由 once 自动移除 + _invalidateSocket 废弃 sock,不累积。
              sock.removeListener('error', onError);
              sock.removeListener('close', onClose);
              // If bridge returns auth error, invalidate cached secret
              if (resp.error?.code === -32001 || resp.error?.code === -32002) {
                _cachedSecret = null;
                _invalidateSocket();
              }
              doResolve(resp);
              return;
            } catch {
              // Log unparseable lines instead of silently discarding (I-10)
              getLogger().warn('bridge', `sendToBridge: unparseable JSON line (request ${id}): ${line.substring(0, 120)}`);
              continue;
            }
          }
        };

        const onError = (err: Error) => {
          if (_socket === sock) _invalidateSocket();  // P1-8: 只在 sock 仍是当前 socket 时 invalidate
          doReject(new Error(`Bridge connection error: ${err.message}`));
        };

        const onClose = () => {
          if (_socket === sock) _invalidateSocket();  // P1-8: 只在 sock 仍是当前 socket 时 invalidate
          doReject(new Error('Bridge connection closed before response'));
        };

        sock.on('data', onData);
        sock.once('error', onError);
        sock.once('close', onClose);

        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });
    }).catch(err => {
      // 子类(BridgeNotConnectedError / BridgeTimeoutError)从 _doConnect / sendToBridge 穿透,原样抛
      return Promise.reject(err);
    });
  };

  // Chain onto the send lock — next request waits for this one to settle.
  // 入口同步 ++(覆盖「排队中+运行中」两态:锁链上有未 settle 请求即 in-flight),
  // settle 后 finally 归零——原 Promise.resolve() 引用比较首次请求后恒 false 恒误报,已弃。
  const prev = _sendLock;
  let resolveLock: () => void = () => {};
  _sendLock = new Promise<void>(r => { resolveLock = r; });
  _sendInflight++;
  return prev.then(() => run()).finally(() => { _sendInflight--; resolveLock(); });
}

/** Reset all module state — for test isolation and service restart. */
export function resetBridgeState(): void {
  // 2026-08-07 审查 P1 修复：P3-6 引入的 push 子系统状态（_pushBuffer/_pushMessageHandler/_socket）
  // 与 socket 独立，原注释"active socket NOT closed here"误导——这三者是模块级状态非 active socket。
  // 不清会导致：(1) 测试隔离泄漏（旧 push handler 持有已销毁 mock server 引用，push 事件错误路由）；
  // (2) _pushBuffer 残留半行 JSON 致下次连接解析异常；(3) _socket 句柄泄漏（FD/内存）。
  // _invalidateSocket() 统一清 _socket + _socketBuffer + _pushBuffer（见 :142-150）。
  _invalidateSocket();
  _pushMessageHandler = null;
  _nextRequestId = 1;
  _permWarned = false;
  _cachedSecret = null;
  _projectDir = null;
  _cachedSecretAt = 0;
  _connectionLock = null;
  _sendLock = Promise.resolve();
  _sendInflight = 0;
  // G-1: 订阅登记表 + keepalive timer 一并清(服务重启语义:旧订阅不复存在;timer 防测试隔离泄漏)
  _subscriptions = [];
  _resendInFlight = null;
  _stopKeepalive();
  // A3: 失败端口记忆一并清(测试隔离/服务重启语义:进程重启后旧失败无意义)
  _failedPorts.clear();
}

// ─── Bridge readiness probe (M4) ────────────────────────────────────────────
// 零接触:自读 secret + 独立短 socket,绝不碰模块级 _projectDir/_cachedSecret/_socket。
// 供 run_project(wait_for_bridge=true) 使用。

export interface BridgeReadyResult {
  ready: boolean;
  reason: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** 单次 TCP auth 探测(独立 socket,即建即毁)。成功返回 true。
 *  A1: port 由调用方传入(registry 解析的实际端口,secret 文件与监听端口必须一致)。 */
function probeOnce(secretPath: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let secret: string;
    try {
      secret = readFileSync(secretPath, 'utf-8').trim();
    } catch {
      resolve(false);
      return;
    }
    const sock = createConnection({ port, host: BRIDGE_HOST }, () => {
      sock.write(JSON.stringify({ id: 0, method: 'auth', params: { secret } }) + '\n');
    });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; sock.destroy(); resolve(false); }
    }, 1000);
    // M2: 累积 buffer 按 \n 分割,防 auth 响应跨 TCP 包(partial)导致 JSON.parse 失败
    let buffer = '';
    sock.on('data', (data: Buffer) => {
      if (settled) return;
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx === -1) return; // 等待完整行(bridge 响应以 \n 结尾)
      try {
        const resp = JSON.parse(buffer.substring(0, idx).trim());
        if (resp?.result?.authenticated) {
          settled = true; clearTimeout(timer); sock.destroy(); resolve(true);
        }
      } catch { /* 部分/非 JSON 数据,忽略 */ }
    });
    sock.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
    });
  });
}

/**
 * 探测 bridge autoload 是否已启动并接受 auth。轮询直到就绪/进程退出/超时。
 * 全程零接触模块级缓存:secret 由 projectDir 自拼路径自读。
 */
export async function isBridgeReady(
  projectDir: string,
  timeoutMs: number,
  opts?: { proc?: ChildProcess; isCancelled?: () => boolean },
): Promise<BridgeReadyResult> {
  // A1: 实际端口来自 registry 解析(避让端口下 secret 文件名同步变化)。
  // 每轮循环重解析:启动早期 registry 条目/secret 文件尚未落盘,钉死首轮结果会把后续窗口
  // 扫描(缓解批随机端口后的回落)也锁死在错误端口上(2026-08-21 PR#57 CI 实测)。
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const interval = 500;

  for (;;) {
    const port = resolveBridgePort(projectDir);
    const secretPath = bridgeSecretPathFor(projectDir, port);
    if (opts?.proc?.killed) {
      return { ready: false, reason: 'process exited during probe' };
    }
    if (opts?.isCancelled?.()) {
      // ctx 状态变化(runningProcess !== proc)不等于 bridge 不可用:当前 proc 可能仍活。
      // 多 godot/端口冲突场景:新 spawn 的 proc 因 bind 失败 exit 触发 close,但另一 godot 的 bridge
      // 仍服务 9081。先 probeOnce 探测实际可用性,避免误报 process exited 而漏判 bridge ready。
      if (existsSync(secretPath) && await probeOnce(secretPath, port)) {
        return { ready: true, reason: 'bridge ready' };
      }
      return { ready: false, reason: 'process exited during probe' };
    }
    if (existsSync(secretPath)) {
      if (await probeOnce(secretPath, port)) return { ready: true, reason: 'bridge ready' };
    }
    if (Date.now() >= deadline) {
      return existsSync(secretPath)
        ? { ready: false, reason: 'bridge auth did not succeed within timeout' }
        : { ready: false, reason: 'secret not found (bridge not installed?)' };
    }
    await sleep(Math.min(interval, deadline - Date.now()));
  }
}

/** 测试专用:模块缓存快照,用于断言 isBridgeReady 零接触。 */
export function _testBridgeCacheState(): {
  projectDir: string | null;
  cachedSecret: string | null;
  socketNotNull: boolean;
} {
  return { projectDir: _projectDir, cachedSecret: _cachedSecret, socketNotNull: _socket !== null };
}
