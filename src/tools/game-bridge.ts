/**
 * game_bridge MCP 工具 —— Bridge 安装/查询/输入/写入/等待/监控/信号/UI 发现/确定性 playtest。
 *
 * 2026-08-21 架构审查 MAJOR-3:客户端核心(TCP 连接/认证/NDJSON 协议/keepalive/订阅重发/
 * 端口 registry 解析)下沉到 src/core/bridge-client.ts——CLI 子命令(gif 等)复用 bridge
 * 不再需要 import tools 层;本文件保留 MCP 工具定义,并 re-export 客户端符号使既有消费方
 * (GodotServer/CLI/测试)import 路径零改动。
 */
import { readFileSync, existsSync, copyFileSync, unlinkSync, readdirSync } from 'fs';
import { writeFileAtomic } from '../core/fs-atomic.js';
import { join, dirname } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult, getErrorMessage } from '../types.js';
import { opsErrorResult } from './shared.js';
import { requireProjectPath } from '../helpers.js';
import { PathError } from '../core/tool-errors.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getLogger } from '../core/logger.js';
import {
  BRIDGE_PORT,
  BRIDGE_HOST,
  BRIDGE_SCRIPT_NAME,
  AUTOLOAD_KEY,
  ERROR_CODES,
  BridgeNotConnectedError,
  BridgeTimeoutError,
  clampTimeoutMs,
  resolveBridgePort,
  bridgeSecretPathFor,
  getBridgeProjectDir,
  invalidateBridgeSecret,
  invalidateBridgeConnection,
  registerBridgePushHandler,
  liveHeartbeatPortsFor,
  type BridgeResponse,
  setBridgeProjectDir,
  sendToBridge,
  _registerSubscription,
  _removeSubscription,
} from '../core/bridge-client.js';

// Re-export(消费方兼容:GodotServer import registerBridgePushHandler/setBridgeProjectDir;
// 测试 import clampTimeoutMs/BridgeNotConnectedError 等——签名与迁移前逐一相同)
export {
  BRIDGE_PORT,
  BRIDGE_HOST,
  BRIDGE_SCRIPT_NAME,
  AUTOLOAD_KEY,
  ERROR_CODES,
  BridgeNotConnectedError,
  BridgeTimeoutError,
  clampTimeoutMs,
  resolveBridgePort,
  bridgeSecretPathFor,
  getBridgeProjectDir,
  invalidateBridgeSecret,
  invalidateBridgeConnection,
  registerBridgePushHandler,
  setBridgeProjectDir,
  sendToBridge,
  type BridgeResponse,
};
export { machineRegistryInstancesDir, normalizeProjectKey, setOnBridgeConnected, _markPortFailed, _isPortFailed, liveHeartbeatPortsFor } from '../core/bridge-client.js';

// ─── A2 (2026-09-16 反馈批): bridge 版本指纹比对 ─────────────────────────────
// GD 侧 mcp_bridge.gd 顶部 BRIDGE_SCRIPT_VERSION 常量(与 package.json version 同步,
// version-sync bridgeGd target 管理)随 ping 响应与 registry entry 回传。TS 侧从 bundled
// 脚本(opsScript 同目录)提取期望值比对 —— 项目内拷贝旧版未同步(send_drag 五踩 /
// registry 断链 / button_mask 复踩的共同根源)在 ping 一发内一眼可辨。
const BRIDGE_SCRIPT_VERSION_RE = /^const BRIDGE_SCRIPT_VERSION := "([^"\r]*)"/m;

/** 从 mcp_bridge.gd 内容提取 BRIDGE_SCRIPT_VERSION(纯函数,单测直测);无匹配返回 null。 */
export function extractBridgeScriptVersion(content: string): string | null {
  return BRIDGE_SCRIPT_VERSION_RE.exec(content)?.[1] ?? null;
}

/** 读 opsScript 同目录的 bundled mcp_bridge.gd 提取版本;缺失/无匹配返回 null。
 *  ping 是低频显式调用(keepalive 的 ping 走 core 层不经此注解),每次直读几 KB
 *  文件开销可忽略 —— 刻意不做模块级缓存(defects module-level-mutable-state 防恶化门禁)。 */
function bundledBridgeVersion(ctx: ToolContext): string | null {
  try {
    return extractBridgeScriptVersion(readFileSync(join(dirname(ctx.opsScript), BRIDGE_SCRIPT_NAME), 'utf-8'));
  } catch { return null; }
}

/** ping 响应注解(纯函数,单测直测):附加 bundledBridgeVersion,与远端 bridgeVersion 不一致
 *  时加 versionWarning(旧版项目拷贝的可操作指引)。返回注解后的新对象,不改入参。 */
export function annotatePingWithVersion(
  result: Record<string, unknown>,
  bundled: string | null,
): Record<string, unknown> {
  if (!bundled) return result;
  const annotated: Record<string, unknown> = { ...result, bundledBridgeVersion: bundled };
  const remote = typeof result.bridgeVersion === 'string'
    ? result.bridgeVersion
    : 'unknown (old GD without version fingerprint)';
  if (remote !== bundled) {
    annotated.versionWarning =
      `bridge GD ${remote} != bundled ${bundled} — the project's mcp_bridge.gd is an outdated copy. ` +
      'Re-run game_bridge_install with force: true and restart the game to sync (new tools like send_drag/send_input_sequence live only in the bundled version).';
  }
  return annotated;
}

// 首次连接成功自动拉起 Dashboard 的装配已迁往 GodotServer.run()(O2 归位,2026-09-17
// 审查 H-3):模块顶层副作用不受 close() 管辖,迁入控制面后 close() 可对称置 null 清理;
// dashboard⇄game-bridge 的 import 链在控制面汇合,方向不变(core/bridge-client 仍不依赖 dashboard)。

// G-5: 识别/迁移旧版(≤0.23.x)误写的带前缀 autoload 键(仅工具层 install/uninstall 用)
const AUTOLOAD_KEY_LEGACY = 'autoload/MCPBridge';

// ─── Tool definitions ──────────────────────────────────────────────────────

const ACTIONS = [
  'game_bridge_install',
  'game_bridge_uninstall',
  'install_override',
  'uninstall_override',
  'game_query',
  'game_write',
  'game_input',
  'game_wait',
  'game_playtest',
  'monitor_start',
  'monitor_stop',
  'monitor_poll',
  'watch_start',
  'watch_stop',
  'watch_poll',
  'find_ui_elements',
  'click_button',
  'network_conditioner',
  'custom_command',
  'sync_state',
] as const;

// ─── P10: sync_state 快照存储与比对(多人状态同步,masteryee 移植) ─────────────

interface SyncSnapshot {
  instances: Record<string, unknown>;
  count: number;
  game_time_ms: number;
  taken_at: number;
  /** 全仓审查(2026-09-12): GD 侧 256 节点上限截断标志(P10 审查 N-2 产出,原 TS 消费侧
   * 丢弃)——截断快照参与比对时结果不可信(两侧同截断→假阳性/不同截断→假阴性)。 */
  truncated: boolean;
}

/** 内存快照表(进程生命周期;label → snapshot)。agent 断连重连不清——快照是比对原语不是会话态。 */
const _syncSnapshots = new Map<string, SyncSnapshot>();

export interface SyncCompareReport {
  in_sync: boolean;
  paths_compared: number;
  missing_in_b: string[];
  missing_in_a: string[];
  diffs: Array<{ path: string; key: string; a: unknown; b: unknown }>;
}

/**
 * 递归比对两份 collect_state 快照(浮点容差)。
 * 数值 |a-b|<=tolerance 视为相等(浮点位置类不逐位相等是多人比对必然——host/client
 * 各自物理步进后 position 必有微差,masteryee 原版 dict 严格相等在真实多人游戏永远
 * false,亲读发现的坑,本函数是该坑的修复);其余类型严格相等;dict 逐键/数组逐项+长度。
 */
export function compareStates(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  tolerance: number,
): SyncCompareReport {
  const missingInB: string[] = [];
  const missingInA: string[] = [];
  const diffs: Array<{ path: string; key: string; a: unknown; b: unknown }> = [];
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  let compared = 0;
  for (const path of paths) {
    if (!(path in b)) { missingInB.push(path); continue; }
    if (!(path in a)) { missingInA.push(path); continue; }
    compared += 1;
    const da = (a[path] ?? {}) as Record<string, unknown>;
    const db = (b[path] ?? {}) as Record<string, unknown>;
    // __present__/__error__ 元标记也参与比对(存在性标记 diff 用键名呈现)
    const keys = new Set([...Object.keys(da), ...Object.keys(db)]);
    for (const key of keys) {
      if (!(key in db)) { diffs.push({ path, key, a: da[key], b: undefined }); continue; }
      if (!(key in da)) { diffs.push({ path, key, a: undefined, b: db[key] }); continue; }
      if (!valuesEqual(da[key], db[key], tolerance)) {
        diffs.push({ path, key, a: da[key], b: db[key] });
      }
    }
  }
  return {
    in_sync: missingInB.length === 0 && missingInA.length === 0 && diffs.length === 0,
    paths_compared: compared,
    missing_in_b: missingInB,
    missing_in_a: missingInA,
    diffs,
  };
}

function valuesEqual(va: unknown, vb: unknown, tolerance: number): boolean {
  if (typeof va === 'number' && typeof vb === 'number') {
    // 先严格短路:同值(含 ±Infinity/同 NaN 位形)不经容差算术——Math.abs(Inf-Inf)=NaN<=tol
    // 恒 false 会让同值 Infinity 误判 diff(P10 审查 B-1 衍生,CMP-g 锚定)
    if (va === vb) return true;
    if (Number.isNaN(va) || Number.isNaN(vb)) return false;
    return Math.abs(va - vb) <= tolerance;
  }
  if (va && typeof va === 'object' && !Array.isArray(va)
    && vb && typeof vb === 'object' && !Array.isArray(vb)) {
    const dva = va as Record<string, unknown>;
    const dvb = vb as Record<string, unknown>;
    const keys = new Set([...Object.keys(dva), ...Object.keys(dvb)]);
    for (const k of keys) {
      if (!(k in dvb) || !(k in dva)) return false;
      if (!valuesEqual(dva[k], dvb[k], tolerance)) return false;
    }
    return true;
  }
  if (Array.isArray(va) && Array.isArray(vb)) {
    if (va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) {
      if (!valuesEqual(va[i], vb[i], tolerance)) return false;
    }
    return true;
  }
  return va === vb;
}

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'game',
      description: '游戏桥接操作(游戏运行时经 bridge 通信):安装/卸载 bridge、查询场景树/节点属性/截图、写入属性/调方法、模拟输入、等待条件、确定性 playtest(seed/锁步长/单步/快照)、freeze 控制、monitor 属性采样、watch 信号记录、UI 元素发现与点击、弱网注入、项目自定义命令。完整用法见规则文档(或 help 工具)。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          port: { type: 'number', description: 'game_bridge_install: 期望的起始监听端口(实际端口由游戏侧 env GODOT_MCP_BRIDGE_PORT 设起点,被占自动递增避让;此参数不影响行为,保留兼容)。实际端口见 ping 响应与实例 registry', default: 9081 },
          force: { type: 'boolean', description: 'install: 项目内 mcp_bridge.gd 与自带版本不同(旧版未同步)时 force=true 覆盖刷新,重启游戏生效。send_drag 等报 Method not found 时用本参数', default: false },
          clean_stale_secrets: { type: 'boolean', description: 'install: 清理 .godot/ 陈旧 mcp_bridge_*.secret(按 registry 新鲜心跳判活,无心跳拒清防误删)。多实例 auth 失败/连错实例时用', default: false },
          source_script_path: { type: 'string', description: 'install_override/uninstall_override: 源调试脚本绝对路径（必须在 ALLOWED_PROJECT_PATHS 白名单内,拷贝到项目根注册为 MCPOVERRIDE_<basename> autoload;插入 [autoload] 段末尾=在游戏 autoload 之后加载,脚本 _ready 可直接访问游戏单例,无需 await <Singleton>.ready）' },
          sub_action: {
            type: 'string',
            enum: ['snapshot', 'compare', 'list', 'clear'],
            description: 'sync_state 子操作:snapshot=收集当前 bridge 状态存快照|compare=比对两快照(浮点容差)|list=快照清单|clear=清空快照。',
          },
          label: {
            type: 'string',
            description: 'sync_state snapshot: 快照标签(如 host/client);进程内全局——跨实例场景建议带实例前缀(如 gameA-host)防静默覆盖;compare 时用 label_a/label_b。',
          },
          label_a: {
            type: 'string',
            description: 'sync_state compare: 比对快照 A 的标签。',
          },
          label_b: {
            type: 'string',
            description: 'sync_state compare: 比对快照 B 的标签。',
          },
          tolerance: {
            type: 'number',
            description: 'sync_state compare: 浮点容差(默认 0.0001,数值 |a-b|<=tolerance 视为相等;Vector2/3/4 自动转 {x,y,z} dict 分量级容差;浮点位置类不逐位相等是多人比对必然,masteryee 亲读坑)。',
          },
          group: {
            type: 'string',
            description: 'sync_state snapshot: 可选组名(如 mcp_watch)——组内无 _mcp_state 的成员记存在性标记参与节点集比对。',
          },
          method: {
            type: 'string',
            description: '方法名(按 action 选)。game_query: ping/get_tree/find_nodes/get_node_properties/get_node_layout/get_performance/get_viewport_info/take_screenshot/get_errors/clear_errors。game_write: set_node_property/call_method。game_input: send_key/send_mouse_click/send_mouse_move/send_text/send_touch/send_drag/send_input_sequence。game_wait: wait_for_node/wait_for_property。game_playtest: playtest.seed/playtest.fixed_delta/playtest.step/playtest.snapshot/playtest.restore/playtest.freeze/playtest.unfreeze/playtest.step_until。细节见规则文档。',
          },
          params: {
            type: 'object',
            description: '方法参数(紧凑形状,完整说明见规则文档)。find_nodes{pattern?,type?,group?,limit?,root?,near_node?,max_distance?,observation_profile?}(near_node 近邻:同维度升序,锚点排除;player 档下 position 有字段规则的锚点/候选不参与测距);get_node_properties{path,observation_profile?};get_node_layout{path,observation_profile?};get_errors{since_seq?,clear?};set_node_property{path,property,value};call_method{path,method,args}(白名单+GDA_CALLABLE+预检-10 见规则);send_key{key,pressed};send_mouse_click{x,y,button,pressed};send_mouse_move{x,y,button_mask?};send_text{text};send_touch{x,y,pressed,index};send_drag{x,y,index,relative,speed};send_input_sequence{timeline[{at_frame(1-600),type,...}],settle_frames?(0-600),wall_budget_ms?(1000-50000)};wait_for_node{path};wait_for_property{path,property,value};playtest.seed{seed};fixed_delta{hz};step{frames};step_until{conditions[{path,property,op,value}],max_frames?(1-600),wall_budget_ms?(1000-50000,默认30000)};network set{latency_ms,loss_pct,jitter_ms};custom 命令参数由游戏方定义。',
          },
          timeout: { type: 'number', description: 'game_query/game_write/game_input/game_wait: 超时时间（毫秒，默认 10000）。game_wait 的 timeout 用作整个轮询窗口的总预算（在窗口内反复探测直到条件成立）。send_input_sequence 延迟响应,timeout 自动放宽至 wall_budget+10s(上限 65000)' },
          interval_ms: { type: 'number', description: 'game_wait 专用：轮询探测间隔（毫秒，默认 200，范围 50-2000）。仅 wait_for_node/wait_for_property 生效', default: 200 },
          node_path: { type: 'string', description: 'monitor_start: 要监控的节点路径（如 /root/Player）' },
          properties: { type: 'array', items: { type: 'string' }, description: 'monitor_start: 要监控的属性名列表（如 ["position", "health"]）;被安全过滤的属性会在返回 dropped_blocked 中逐个点名' },
          interval_frames: { type: 'number', description: 'monitor_start: 采样间隔(60fps 基准下的标称帧数,默认 10,最小 1,最大 300;实际按游戏时间毫秒调度,帧率变化节奏不漂移,paused/freeze 期间游戏时间停走不采样,样本含 t_game_ms 游戏时间戳)' },
          signal_name: { type: 'string', description: 'watch_start: 要监听的信号名（如 "pressed"、"health_changed"）' },
          max_events: { type: 'number', description: 'watch_start: 最大记录事件数（默认 1000，最大 5000）' },
          push: { type: 'boolean', description: 'P3-6 watch_start/monitor_start: 启用 push 模式（事件/采样产生时主动推送 MCP notification，无需 poll）。client 需订阅 resources/subscribe 才能收到' },
          observation_profile: { type: 'string', enum: ['debug', 'player'], description: 'P7 观察档位(默认 debug;player 需游戏侧 env GODOT_MCP_BRIDGE_ALLOWED_PROFILES 授权,节点 meta 级联隐藏 + agent_field_rules 字段投影生效,详见规则文档)', default: 'debug' },
          pattern: { type: 'string', description: 'find_ui_elements: 名称/文字匹配模式（Godot match 语法）' },
          type: { type: 'string', description: 'find_ui_elements: 按类型过滤（如 "Button"、"Label"）' },
          visible_only: { type: 'boolean', description: 'find_ui_elements: 仅返回可见元素（默认 true）' },
          limit: { type: 'number', description: 'find_ui_elements: 最大返回数（默认 200，上限 500）' },
          text: { type: 'string', description: 'click_button: 按钮文字（和 path 二选一）' },
          path: { type: 'string', description: 'click_button: 按钮节点路径（和 text 二选一）' },
          real_event: { type: 'boolean', description: 'click_button: 走真实输入事件路径(默认 false=emit_signal)。true 时注入 press/release InputEventMouseButton 到 viewport,走完整引擎输入管道(切换 button_pressed 状态/触发 button_group 互斥/focus),等 4 帧后返回 signal_counts 信号计数与 verified;延迟响应(同 call_method await_completion)。修复"点击成功但 CheckBox 没勾上"类问题' },
          op: { type: 'string', enum: ['set', 'clear', 'status'], description: 'network_conditioner: 子操作。set=包装当前 MultiplayerPeer 注入弱网(latency_ms/loss_pct/jitter_ms 参数),clear=拆除恢复原 peer,status=查询当前状态' },
          latency_ms: { type: 'number', description: 'network_conditioner set: 注入延迟毫秒(>=0,默认 0)' },
          loss_pct: { type: 'number', description: 'network_conditioner set: 丢包百分比 0-100(默认 0)' },
          jitter_ms: { type: 'number', description: 'network_conditioner set: 抖动毫秒(>=0,默认 0,实际延迟 = latency ± jitter)' },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export const QUERY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_node_layout',
  'get_performance', 'get_viewport_info', 'take_screenshot',
  // CMP-2 (2026-08-08): runtime error 捕获——查询/清除游戏运行时错误
  'get_errors', 'clear_errors',
]);

/** Read-only query methods excluding take_screenshot (handled separately via bridge.screenshot). */
export const BRIDGE_READ_ONLY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_node_layout',
  'get_performance', 'get_viewport_info',
  // CMP-2: get_errors/clear_errors 只操作 bridge 内部 buffer 不影响游戏,归只读集合
  'get_errors', 'clear_errors',
]);

const WRITE_METHODS = new Set([
  'set_node_property', 'call_method',
]);

export const INPUT_METHODS = new Set([
  'send_key', 'send_mouse_click', 'send_mouse_move', 'send_text',
  'send_touch', 'send_drag',
  // H1 (2026-08-20) 帧定时输入时间线:开窗+逐帧 at_frame 注入,延迟响应(同 step_until)
  'send_input_sequence',
]);

const WAIT_METHODS = new Set([
  'wait_for_node', 'wait_for_property',
]);

// P2-4 确定性 playtest 四原语(snapshot/restore 同步;step 走 coroutine 延迟响应)
export const PLAYTEST_METHODS = new Set([
  'playtest.seed', 'playtest.fixed_delta', 'playtest.snapshot', 'playtest.restore', 'playtest.step',
]);

// G1 (2026-08-13) control-first satellite 层(附录 F.1):freeze/unfreeze/step_until
// 与 determinism-first(PLAYTEST_METHODS)正交叠加。step_until 走同款 coroutine 延迟响应(条件多帧满足)。
export const CONTROL_METHODS = new Set([
  'playtest.freeze', 'playtest.unfreeze', 'playtest.step_until',
]);

/**
 * G-3 (:942② + 批D移交): 计算 game_playtest 各 method 的 TS 侧请求 timeout(纯函数,无 IO)。
 *
 * step_until 的竞态根因: 原 `min(max(raw,30000),60000)` 与 GD 侧 idle 60s(mcp_bridge.gd
 * INACTIVITY_TIMEOUT)同界 — wall_budget_ms=60000 时 TS 先到期销毁常驻 socket(响应丢失 +
 * 订阅断线)。批 D 已把 GD 侧 wall_budget clamp 到 50s,TS 侧对齐:
 * `wall_budget + 5s 余量`(默认 30000 → 35000;wall=60000 超界入参 → 65000 不再先到期),
 * 并与用户显式 timeout 取 max(用户显式更长时尊重显式意图,不被 wall 公式压短)。
 *
 * 其余 method 保持原行为: step 走 max(raw,30000) cap 60000;非长跑 method 原样。
 */
export function computePlaytestTimeoutMs(method: string, wallBudgetMs: unknown, rawTimeoutMs: number): number {
  // 延迟响应族(playtest.step/step_until/send_input_sequence):基础下限 30s,
  // 默认 10s 会先于 GD 侧 wall(默认 30s)超时致响应丢失
  const isDelayed = method === 'playtest.step' || method === 'playtest.step_until' || method === 'send_input_sequence';
  const base = isDelayed
    ? Math.min(Math.max(rawTimeoutMs, 30000), 60000)
    : Math.min(rawTimeoutMs, 60000);
  if (method !== 'playtest.step_until' && method !== 'send_input_sequence') return base;
  const n = Number(wallBudgetMs);
  const wall = (wallBudgetMs === undefined || wallBudgetMs === null || !Number.isFinite(n))
    ? 30000
    : Math.max(0, Math.round(n));
  // wall + 余量,clamp 到 [1000,65000]。
  // step_until 余量 5s(65000 容纳 GD 超界入参 60000+5000);
  // send_input_sequence 余量 10s(GD clamp 50000+10000=60000,与 base 上界一致)
  const margin = method === 'send_input_sequence' ? 10000 : 5000;
  const byBudget = clampTimeoutMs(wall + margin, 1000, 65000, 35000);
  return Math.max(byBudget, base);
}

/**
 * CRITICAL-3 fix: poll a Bridge wait condition until it holds or the budget
 * runs out. Bridge (`mcp_bridge.gd` `_cmd_wait_for_node`/`_cmd_wait_for_property`)
 * is a single synchronous snapshot, so "waiting" must be implemented by the
 * caller polling within a time window.
 *
 * `probe` is parameterized so tests can inject a mock without touching the
 * real socket. Each probe call should return the BridgeResponse from a single
 * `wait_for_node`/`wait_for_property` snapshot.
 *
 * Condition resolution:
 *   - `wait_for_node`   → holds when result.exists === true
 *   - `wait_for_property` → holds when result.match === true
 *   - any result.error  → abort immediately, surface the error
 *
 * The returned object spreads the last Bridge result and augments it with
 * `wait_completed` / `elapsed_ms` / `timed_out`, so existing fields stay
 * backward compatible.
 */
export async function pollWaitCondition(
  method: 'wait_for_node' | 'wait_for_property',
  probe: () => Promise<BridgeResponse>,
  totalMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const isNode = method === 'wait_for_node';

  let last: BridgeResponse;
  for (;;) {
    // 全仓审查(2026-09-12): probe **throw**(BridgeTimeoutError/BridgeNotConnectedError)
    // 原样向上传播会烧掉整个等待预算——游戏主线程卡顿超过单次探测超时(interval×2,
    // 默认 400ms)即立即失败,30s 总预算只消耗 0.4s,与"poll until budget runs out"
    // 设计初衷相悖。视为"本轮探测不可用"继续下一轮:预算耗尽走正常 timed_out 路径,
    // 断连场景下次 _ensureConnection 自动重连后可恢复探测。响应内 error 字段仍立即中止
    // (game-bridge-wait.test.ts 锁定的既有语义,不放松)。
    let probeErr: unknown = null;
    try {
      last = await probe();
    } catch (e) {
      probeErr = e;
      last = {} as BridgeResponse;
    }
    if (probeErr === null && last.error) {
      return {
        ...(last.result as Record<string, unknown> | undefined),
        error: last.error,
        wait_completed: false,
        elapsed_ms: Date.now() - startedAt,
      };
    }
    const result = (last.result ?? {}) as Record<string, unknown>;
    const satisfied = probeErr === null && (isNode ? result.exists === true : result.match === true);
    if (satisfied) {
      return { ...result, wait_completed: true, elapsed_ms: Date.now() - startedAt };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalMs) {
      return { ...result, wait_completed: false, timed_out: true, elapsed_ms: elapsed };
    }

    // Sleep the interval, but never past the remaining budget.
    const remaining = totalMs - elapsed;
    await sleep(Math.min(intervalMs, remaining));
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 确保项目目录已设置：优先用 ctx.projectDir，回退到 args.project_path */
function ensureProjectDir(ctx: ToolContext, args: Record<string, unknown>): void {
  if (ctx.projectDir) {
    setBridgeProjectDir(ctx.projectDir);
  } else if (!getBridgeProjectDir()) {
    try { if (args.project_path) setBridgeProjectDir(requireProjectPath({ project_path: args.project_path })); } catch (e) { getLogger().debug('bridge', `project_path fallback failed: ${e instanceof Error ? e.message : e}`); }
  }
}

/** T-1 (2026-06-24 审查): game_write/wait/query 的 path 参数须 /root/ 绝对路径(文档 godot-mcp-bridge.md
 *  声称必须,原 TS 端下放 GDScript 端)。无 path 的 method(ping/get_tree/get_performance 等)不校验。
 *  返回错误消息或 null(校验通过)。纯函数,无 IO/socket,测试见 game-bridge-validation.test.ts。
 *  反馈 2026-08-22 (CardGame2): take_screenshot 的 path 是文件路径语义(user://…,GD 侧自有
 *  "must start with user://" 校验),曾被本函数误扫为节点路径——两层校验互相矛盾,任意取值必失败。
 *  修:method 为 take_screenshot 时跳过 path 键(其 path 非节点路径);node_path 键仍校验(该方法无此参数)。 */
export function validateBridgePath(params: Record<string, unknown>, method?: string): string | null {
  // I-1 (审查反馈): 节点路径字段名混用——game_write/wait/query 用 path,monitor/watch 用 node_path,
  // click_button 用 path。统一检查两者。无节点路径的方法(ping/get_tree/find_ui_elements 的 pattern)不校验。
  // take_screenshot 的 path=user:// 文件路径豁免,但 node_path(若误传)仍校验(I-1 有意防御,既有用例锁定)。
  // P3-3: custom.* 命令参数由游戏开发者在 res://mcp_commands/*.gd 自定义,path 语义
  // 不一定是节点路径(可能是文件路径/资源路径),整体豁免路径断言。
  if (method?.startsWith('custom.') ?? false) return null;
  const skipPathKey = method === 'take_screenshot';
  for (const key of ['path', 'node_path'] as const) {
    if (key === 'path' && skipPathKey) continue;
    const p = params[key];
    if (typeof p === 'string' && p.length > 0 && p !== '/root' && !p.startsWith('/root/')) {
      return `${key} must be an absolute path starting with "/root/" (got "${p}"). game tools require /root/-prefixed node paths; see godot-mcp-bridge.md.`;
    }
  }
  return null;
}

/** I-2 (审查 follow-up): wait_for_property 需 property + value;wait_for_node 只需 path 不校验。
 *  返回错误消息或 null(校验通过)。纯函数,无 IO/socket,测试见 game-bridge-validation.test.ts。
 *  抽自 handleTool case 'game_wait' 内联逻辑(2026-08-09 待办 #3,恢复 Linux CI 覆盖)。 */
export function validateWaitPropertyParams(method: string, params: Record<string, unknown>): string | null {
  if (method === 'wait_for_property') {
    if (typeof params.property !== 'string' || !params.property) {
      return 'wait_for_property requires a non-empty "property" string in params';
    }
    if (params.value === undefined) {
      return 'wait_for_property requires a "value" in params';
    }
  }
  return null;
}

/** Shared helper: set project dir, send to bridge, format response. */
async function bridgeAction(method: string, params: Record<string, unknown>, ctx: ToolContext, timeout: number): Promise<ToolResult> {
  ensureProjectDir(ctx, params);
  const pathErr = validateBridgePath(params, method);  // I-1(审查): 覆盖 monitor/watch/click_button 的 node_path/path;take_screenshot 的 path(文件路径)豁免
  if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);
  const resp = await sendToBridge(method, params, timeout);
  // T-2 (2026-06-24 审查): bridge 返回 error 时(密钥失效 -32001/-32002/方法不存在等)用 errorResult
  // (isError=true),否则 MCP 客户端误判成功吞掉错误。原 textResult 默认 isError=false。
  if (resp.error) {
    return errorResult(`Bridge error (${resp.error.code}): ${resp.error.message}`);
  }
  // A2 注:ping 版本注解在 game_query 直连路径(本函数不被 game_query 走到,见 case 注释)
  // G-1: 订阅登记表维护 — start 成功登记(重连后重发),stop 成功移除(不再重发)
  if (method === 'watch.start' || method === 'monitor.start') {
    _registerSubscription(method, params);
  } else if (method === 'watch.stop' || method === 'monitor.stop') {
    _removeSubscription(method === 'watch.stop' ? 'watch.start' : 'monitor.start');
  }
  return textResult(JSON.stringify(resp.result, null, 2));
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'game') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    switch (action) {
      case 'game_bridge_install': {
        const projectPath = requireProjectPath(args);
        const scriptsDir = dirname(ctx.opsScript);
        const bridgeSrc = join(scriptsDir, BRIDGE_SCRIPT_NAME);

        if (!existsSync(bridgeSrc)) {
          return textResult(`Error: Bridge script not found at ${bridgeSrc}`);
        }

        const configPath = join(projectPath, 'project.godot');
        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        let config = readFileSync(configPath, 'utf-8');
        // G-5: 幂等/迁移检查用行首精确匹配(键名短,裸 includes 会误命中注释等文本)。
        // 新键存在 → 已注册跳过;仅旧带前缀键存在 → 迁移(删旧行写新行,旧项目自愈)。
        const hasNewKey = new RegExp(`^${AUTOLOAD_KEY}\\s*=`,'m').test(config);
        const hasLegacyKey = new RegExp(`^${AUTOLOAD_KEY_LEGACY}\\s*=`,'m').test(config);

        // A2 (2026-08-18 反馈): mcp_bridge.gd 托管语义 —— 目标已存在且内容与工具自带版本不同
        // (项目自管/git tracked + 本地修改)时**不覆盖**,保留现有文件并明确告知;内容一致
        // (工具拷贝的原样)才覆盖刷新(升级场景)。拷贝放在幂等检查前只做一次,已注册同样遵守。
        // A1 (2026-09-16 反馈批): drift 场景加 force 刷新入口 —— 项目内旧版未同步是 send_drag
        // 五踩/registry 断链/button_mask 复踩的共同根源,kept-as-is 无刷新路径迫使用户手删。
        // force=true 显式覆盖;默认 false 保留项目内版本但指引可操作(旧文案"delete it manually"
        // 藏在括号里且无精确路径)。
        const destScript = join(projectPath, BRIDGE_SCRIPT_NAME);
        const forceRefresh = args.force === true;
        let scriptNote = '';
        if (existsSync(destScript)) {
          if (readFileSync(bridgeSrc, 'utf-8') !== readFileSync(destScript, 'utf-8')) {
            if (forceRefresh) {
              copyFileSync(bridgeSrc, destScript);
              scriptNote = `existing ${BRIDGE_SCRIPT_NAME} was outdated and has been overwritten (force: true) — restart the game to load the new version.`;
            } else {
              scriptNote = `existing ${BRIDGE_SCRIPT_NAME} at ${destScript} differs from bundled version — kept as-is (project may manage its own copy). To refresh to the bundled version: re-run with force: true, or delete that file and re-run game_bridge_install.`;
            }
          } else {
            copyFileSync(bridgeSrc, destScript);
          }
        } else {
          copyFileSync(bridgeSrc, destScript);
        }

        // A4 (2026-09-16 反馈批): 陈旧 secret 检测/清理入口 —— 多实例端口避让后死实例的
        // mcp_bridge_*.secret 残留会误导端口解析(mtime 语义)与 auth(连错/删错)。判活依据 =
        // machine registry 按项目过滤的新鲜心跳(liveHeartbeatPortsFor,与 resolveBridgePort
        // 同源位置;审查 B-1 修复:勿读 {project}/.godot/mcp-instances——GD 的 project-level
        // 心跳在 user:// 不可达);无任何新鲜心跳时拒绝清理(防误删仍存活但不写心跳的旧版 GD
        // 实例)。默认只检测列出,clean_stale_secrets 才删。
        let secretCleanupNote = '';
        {
          const godotDir = join(projectPath, '.godot');
          const secretFiles: string[] = [];
          try {
            for (const name of readdirSync(godotDir)) {
              if (/^mcp_bridge_\d+\.secret$/.test(name)) secretFiles.push(name);
            }
          } catch { /* .godot 不存在(未跑过游戏)→ 无残留可处理 */ }
          if (secretFiles.length > 0) {
            // A4 判活:machine registry(与 resolveBridgePort 同源位置;审查 B-1 修复——
            // 勿读 {project}/.godot/mcp-instances,GD 的 project-level 心跳在 user:// 不可达)
            const livePorts = liveHeartbeatPortsFor(projectPath);
            if (args.clean_stale_secrets === true) {
              if (livePorts.size === 0) {
                secretCleanupNote = ` stale secret cleanup skipped: no fresh registry heartbeat (cannot prove which instances are live — game not running, or old GD without heartbeat). Start the game once (new GD writes heartbeats) then retry, or delete .godot/mcp_bridge_*.secret manually when no game is running.`;
              } else {
                const deleted: string[] = [];
                for (const name of secretFiles) {
                  const port = Number(/^mcp_bridge_(\d+)\.secret$/.exec(name)?.[1]);
                  if (!livePorts.has(port)) {
                    try { unlinkSync(join(godotDir, name)); deleted.push(name); } catch { /* best-effort */ }
                  }
                }
                secretCleanupNote = deleted.length > 0
                  ? ` stale secrets deleted: ${deleted.join(', ')} (live heartbeat ports: ${[...livePorts].join('/')}; note: an old-GD instance without heartbeats keeps no secret file after this — its in-memory auth still works, but TS-side reconnect to it would need a re-run).`
                  : ` no stale secrets (all match live heartbeat ports ${[...livePorts].join('/')}).`;
              }
            } else if (livePorts.size > 0) {
              const stale = secretFiles.filter(name => !livePorts.has(Number(/^mcp_bridge_(\d+)\.secret$/.exec(name)?.[1])));
              if (stale.length > 0) {
                secretCleanupNote = ` stale secret candidates (ports not in live heartbeat set ${[...livePorts].join('/')}): ${stale.join(', ')} — can mislead port resolution; clean via clean_stale_secrets: true.`;
              }
            }
          }
        }

        if (hasNewKey) {
          return textResult(`MCP Bridge autoload already registered. ${scriptNote || `Script copied to ${destScript}.`}${secretCleanupNote}`);
        }
        if (hasLegacyKey) {
          config = config.split('\n').filter(line => !line.startsWith(AUTOLOAD_KEY_LEGACY + '=')).join('\n');
        }

        const autoloadEntry = `${AUTOLOAD_KEY}="*res://${BRIDGE_SCRIPT_NAME}"`;
        const autoloadRegex = /^\[autoload\]/m;
        if (autoloadRegex.test(config)) {
          config = config.replace(autoloadRegex, `[autoload]\n${autoloadEntry}`);
        } else {
          config += `\n[autoload]\n${autoloadEntry}\n`;
        }

        // Atomic write: write to temp file then rename
        // A-ATOMIC 存量收口:走共享原子写(mode 保持+随机 tmp+Windows 锁定降级)
        writeFileAtomic(configPath, config);
        return textResult(JSON.stringify({
          success: true,
          // A1: 端口自动避让(默认起始候选在 9081-9090 内 crypto 随机——竞态缓解,env GODOT_MCP_BRIDGE_PORT 可固定起点;实际端口见 instance registry + ping 响应 pid/project 指纹)
          message: `MCP Bridge installed. Listens in the 9081-9090 range (randomized start candidate, auto-increments when occupied; ping response carries pid/project to verify target instance).${scriptNote ? ' ' + scriptNote : ''}${secretCleanupNote}`,
          script_path: `res://${BRIDGE_SCRIPT_NAME}`,
          autoload_key: AUTOLOAD_KEY,
        }));
      }

      case 'game_bridge_uninstall': {
        const projectPath = requireProjectPath(args);
        const configPath = join(projectPath, 'project.godot');

        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        const config = readFileSync(configPath, 'utf-8');
        // G-5: 新键与旧带前缀键任一存在即可卸载(双键兼容,旧行为只认旧长键)
        const hasNewKey = new RegExp(`^${AUTOLOAD_KEY}\\s*=`,'m').test(config);
        const hasLegacyKey = new RegExp(`^${AUTOLOAD_KEY_LEGACY}\\s*=`,'m').test(config);
        if (!hasNewKey && !hasLegacyKey) {
          return textResult('MCP Bridge autoload not found in project.godot.');
        }

        // 双键清理:新键行 + 旧带前缀键行都移除
        const lines = config.split('\n').filter(line =>
          !line.startsWith(AUTOLOAD_KEY + '=') && !line.startsWith(AUTOLOAD_KEY_LEGACY + '='));
        writeFileAtomic(configPath, lines.join('\n'));  // A-ATOMIC 存量收口

        // A2 (2026-08-18 反馈): 仅当脚本内容与工具自带版本一致(工具托管拷贝)才删除;
        // 内容不同(项目自管/git tracked + 用户修改)则保留并提示,防 uninstall 删掉 tracked 文件。
        // N-5(审查): bundled 脚本缺失(工具安装损坏)时无法证明是工具托管 → 保守不删。
        const scriptPath = join(projectPath, BRIDGE_SCRIPT_NAME);
        let uninstallNote = '';
        if (existsSync(scriptPath)) {
          const bundledScript = join(dirname(ctx.opsScript), BRIDGE_SCRIPT_NAME);
          const toolManaged = existsSync(bundledScript)
            && readFileSync(bundledScript, 'utf-8') === readFileSync(scriptPath, 'utf-8');
          if (toolManaged) {
            unlinkSync(scriptPath);
            // P2-4: Godot 4.4+ 为 .gd 生成 .uid 伴随文件,漏删留孤儿(uid 复用风险);
            // 与脚本同生命周期(来源 Erodenn bridge-manager.ts cleanup 第③步)
            const uidPath = scriptPath + '.uid';
            if (existsSync(uidPath)) {
              try { unlinkSync(uidPath); } catch { /* best effort */ }
            }
          } else {
            uninstallNote = ` ${BRIDGE_SCRIPT_NAME} differs from bundled version (or bundled copy missing) — kept (delete manually if unwanted).`;
          }
        }

        // A-07 + A1: 清理端口的 secret(端口避让后 9081..909x 均可能有残留)。
        // M-5 (2026-09-17 审查): 删前判活——与 install 侧 clean_stale_secrets 的护栏哲学对称。
        // 原行为无条件删光全部:同项目多实例在跑时,在跑实例的 secret 被一并删掉(进程内 auth
        // 仍有效,但 TS 侧重连即断且无提示)。判活依据与 install 同源(liveHeartbeatPortsFor,
        // machine registry 新鲜心跳);有活实例时只删无心跳端口的 secret 并点名保留项,
        // 无任何新鲜心跳(游戏全停/旧版 GD/registry 不可读)才删光——uninstall 的移除语义
        // 不被护栏阻塞(与 clean_stale_secrets 的"无法判活即拒清"相反,是有意的不对称:
        // 后者目标是清理残留,删错活实例代价高;前者目标是卸载,游戏全停后残留必须能清)。
        const godotDir = join(projectPath, '.godot');
        let secretNote = '';
        if (existsSync(godotDir)) {
          try {
            const secretFiles = readdirSync(godotDir).filter(n => /^mcp_bridge_\d+\.secret$/.test(n));
            if (secretFiles.length > 0) {
              const livePorts = liveHeartbeatPortsFor(projectPath);
              const deleted: string[] = [];
              const kept: string[] = [];
              for (const name of secretFiles) {
                const port = Number(/^mcp_bridge_(\d+)\.secret$/.exec(name)?.[1]);
                if (livePorts.size > 0 && livePorts.has(port)) {
                  kept.push(name);  // 活实例:保留 secret,TS 侧重连不断
                  continue;
                }
                try { unlinkSync(join(godotDir, name)); deleted.push(name); } catch { /* best effort */ }
              }
              if (kept.length > 0) {
                secretNote = ` Kept ${kept.join(', ')} (fresh heartbeat — live instance(s) still running; their in-memory auth works, TS-side reconnect stays intact. Stop the game and re-run game_bridge_uninstall to remove them). Deleted: ${deleted.join(', ') || 'none'}.`;
              } else if (deleted.length > 0) {
                secretNote = ` Secrets removed: ${deleted.join(', ')}.`;
              }
            }
          } catch { /* best effort */ }
        }
        invalidateBridgeSecret();
        invalidateBridgeConnection();

        return textResult(JSON.stringify({ success: true, message: `MCP Bridge uninstalled.${uninstallNote}${secretNote}` }));
      }

      // P2-1: Autoload overrides —— 启动游戏前注入任意调试脚本(日志钩子/状态快照等)
      case 'install_override': {
        const projectPath = requireProjectPath(args);
        const sourceScriptPath = args.source_script_path as string | undefined;
        if (!sourceScriptPath) {
          return opsErrorResult('INVALID_PARAMS', 'install_override requires source_script_path (absolute path to .gd script)');
        }
        try {
          const { installOverride } = await import('../core/overrides.js');
          const entry = installOverride(sourceScriptPath, projectPath);
          // D4 (2026-09-17 反馈批次D, 09-06 CardGame2 反馈): 三种安装形态都明示卸载义务——
          // 取证脚本忘卸载 → autoload 残留 project.godot,GUT 等共享 project.godot 的测试门禁
          // 同样执行 _ready(改存档/切场景)污染用例环境(2483/2484 一例)。
          const mustUninstall = '取证/调试完成后必须 uninstall_override(同一 source_script_path)——'
            + 'autoload 残留在 project.godot 会在共享它的测试门禁(GUT 等)里同样执行 _ready,污染用例环境;'
            + 'uninstall 会一并清理 dest script 与伴生 .gd.uid 残留。';
          if (entry === null) {
            return textResult(JSON.stringify({ success: true, message: 'Override already registered and content identical, skipped. ' + mustUninstall, already_installed: true }));
          }
          if (entry.updated) {
            // 反馈 2026-08-30: 源脚本内容漂移时重拷贝,autoload 注册不动
            return textResult(JSON.stringify({
              success: true,
              message: `Override already registered; dest script updated to match source (content drift). Restart the game to load the new version. ${mustUninstall}`,
              autoload_key: entry.autoloadKey,
              dest_script: `res://${entry.destScriptName}`,
              updated: true,
            }));
          }
          return textResult(JSON.stringify({
            success: true,
            message: `Override installed: ${entry.autoloadKey} (autoload 段末尾,游戏 autoload 之后加载,_ready 可直接访问游戏单例)。${mustUninstall}`,
            autoload_key: entry.autoloadKey,
            dest_script: `res://${entry.destScriptName}`,
            project_root: entry.projectRoot,
          }));
        } catch (err) {
          // 审查 I-D: assertSourceAllowed/assertProjectAllowed 已收口 PathError——识别透传其
          // 结构化 code(不再一律 OVERRIDE_INSTALL_FAILED 掩盖 PATH_NOT_ALLOWED 语义)。
          if (err instanceof PathError) return opsErrorResult(err.code, err.message);
          return opsErrorResult('OVERRIDE_INSTALL_FAILED', getErrorMessage(err));
        }
      }

      case 'uninstall_override': {
        const projectPath = requireProjectPath(args);
        const sourceScriptPath = args.source_script_path as string | undefined;
        if (!sourceScriptPath) {
          return opsErrorResult('INVALID_PARAMS', 'uninstall_override requires source_script_path (absolute path to .gd script)');
        }
        try {
          const { uninstallOverride, deriveOverrideEntry } = await import('../core/overrides.js');
          const removed = uninstallOverride(sourceScriptPath, projectPath);
          const entry = deriveOverrideEntry(sourceScriptPath, projectPath);
          return textResult(JSON.stringify({ success: true, removed, autoload_key: entry.autoloadKey }));
        } catch (err) {
          if (err instanceof PathError) return opsErrorResult(err.code, err.message); // 审查 I-D: 同 install_override
          return opsErrorResult('OVERRIDE_UNINSTALL_FAILED', getErrorMessage(err));
        }
      }

      case 'game_query':
      case 'game_write':
      case 'game_input': {
        // Always update project dir so switching projects between calls works
        ensureProjectDir(ctx, args);
        const methodSets: Record<string, Set<string>> = {
          game_query: QUERY_METHODS,
          game_write: WRITE_METHODS,
          game_input: INPUT_METHODS,
        };
        const allowed = methodSets[action]!;
        const method = args.method as string;
        if (!allowed.has(method)) {
          return textResult(`Error: Unknown bridge method "${method}". Supported: ${[...allowed].join(', ')}. 业务方法（如 take_damage/emit_signal）请用 game_write method=call_method params={method:"业务方法名", args:[...]}（bridge 运行时白名单校验，可通过 GODOT_MCP_BRIDGE_EXTRA_METHODS env 扩展）`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        const rawTimeout = clampTimeoutMs(args.timeout);
        // H1 (2026-08-20): send_input_sequence 延迟响应,超时经 computePlaytestTimeoutMs
        // 统一放宽(wall+10s,审查 N-4 收敛——与 step_until 同一纯函数,不再内联公式)
        const timeout = computePlaytestTimeoutMs(method, params.wall_budget_ms, rawTimeout);
        const pathErr = validateBridgePath(params, method);  // T-1: path /root/ 前置校验(take_screenshot 的文件路径豁免)
        if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);  // T-1: path /root/ 前置校验
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
          // Clear cached secret on auth failure so next call re-reads from disk
          // Bridge error codes: -32001 (auth required), -32002 (locked out)
          if (response.error.code === -32001 || response.error.code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${response.error.code}): ${response.error.message}`);  // T-2: textResult→errorResult(isError=true)
        }
        // A2 (2026-09-16 跨项目验证接线修正): game_query/write/input 走本直连路径而非
        // bridgeAction(共享 helper 只服务 watch/monitor 等)——ping 版本注解必须接在这里,
        // 首版误接 bridgeAction 导致真机 ping 无 bundledBridgeVersion/versionWarning。
        if (method === 'ping' && response.result !== null && typeof response.result === 'object' && !Array.isArray(response.result)) {
          const annotated = annotatePingWithVersion(response.result as Record<string, unknown>, bundledBridgeVersion(ctx));
          return textResult(JSON.stringify(annotated, null, 2));
        }
        return textResult(JSON.stringify(response.result, null, 2));
      }

      case 'game_wait': {
        // CRITICAL-3 fix: Bridge wait_for_* is a single snapshot; poll within
        // the timeout window so "wait" actually waits for the condition.
        ensureProjectDir(ctx, args);
        const method = args.method as string;
        if (!WAIT_METHODS.has(method)) {
          return textResult(`Error: Unknown method "${method}". Supported: ${[...WAIT_METHODS].join(', ')}`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        const totalMs = clampTimeoutMs(args.timeout);
        const intervalMs = clampTimeoutMs(args.interval_ms, 50, 2000, 200);

        const pathErr = validateBridgePath(params, method);  // T-1: path /root/ 前置校验
        if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);

        // I-2: wait_for_property 还需 property + value;wait_for_node 不校验(纯函数抽离,见模块顶)。
        const waitParamErr = validateWaitPropertyParams(method, params);
        if (waitParamErr) return opsErrorResult('INVALID_PARAMS', waitParamErr);

        const result = await pollWaitCondition(
          method as 'wait_for_node' | 'wait_for_property',
          () => sendToBridge(method, params, Math.min(intervalMs * 2, totalMs)),
          totalMs,
          intervalMs,
        );

        if (result.error) {
          const code = (result.error as { code?: number }).code;
          if (code === -32001 || code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${code}): ${(result.error as { message?: string }).message ?? 'wait failed'}`);  // T-2: textResult→errorResult(isError=true)
        }
        return textResult(JSON.stringify(result, null, 2));
      }

      // P2-4 确定性 playtest 四原语:seed/fixed_delta/snapshot/restore 同步;step 走 coroutine 延迟响应
      case 'game_playtest': {
        ensureProjectDir(ctx, args);
        const method = args.method as string;
        if (!PLAYTEST_METHODS.has(method) && !CONTROL_METHODS.has(method)) {
          return textResult(`Error: Unknown playtest method "${method}". Supported: ${[...PLAYTEST_METHODS, ...CONTROL_METHODS].join(', ')}`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        // step/step_until 走 coroutine 延迟响应,需要更长 timeout(N 帧推进 / 条件多帧才满足)。
        // G-3: step_until 的 timeout 由 wall_budget + 5s 余量决定(防 TS 先于 GD idle 60s 到期销毁 socket)
        const timeout = computePlaytestTimeoutMs(method, params.wall_budget_ms, clampTimeoutMs(args.timeout));
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
          if (response.error.code === -32001 || response.error.code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${response.error.code}): ${response.error.message}`);
        }
        return textResult(JSON.stringify(response.result, null, 2));
      }

      case 'monitor_start': {
        if (!args.node_path || typeof args.node_path !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'node_path is required for monitor_start');
        }
        if (!Array.isArray(args.properties) || (args.properties as string[]).length === 0) {
          return opsErrorResult('INVALID_PARAMS', 'properties must be a non-empty array');
        }
        return await bridgeAction('monitor.start', {
          node_path: args.node_path as string,
          properties: args.properties as string[],
          interval_frames: (args.interval_frames as number) ?? 10,
          push: args.push === true,  // P3-6: 传递 push 模式标志到 addon
          observation_profile: (args.observation_profile as string) ?? 'debug',  // P7: 观察档位
        }, ctx, clampTimeoutMs(args.timeout));
      }
      case 'monitor_stop':
        return await bridgeAction('monitor.stop', {}, ctx, clampTimeoutMs(args.timeout));
      case 'monitor_poll':
        return await bridgeAction('monitor.poll', {}, ctx, clampTimeoutMs(args.timeout));
      case 'watch_start': {
        if (!args.node_path || typeof args.node_path !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'node_path is required for watch_start');
        }
        if (!args.signal_name || typeof args.signal_name !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'signal_name is required for watch_start');
        }
        return await bridgeAction('watch.start', {
          node_path: args.node_path as string,
          signal_name: args.signal_name as string,
          max_events: (args.max_events as number) ?? 1000,
          push: args.push === true,  // P3-6: 传递 push 模式标志到 addon
          observation_profile: (args.observation_profile as string) ?? 'debug',  // P7: 观察档位
        }, ctx, clampTimeoutMs(args.timeout));
      }
      case 'watch_stop':
        return await bridgeAction('watch.stop', {}, ctx, clampTimeoutMs(args.timeout));
      case 'watch_poll':
        return await bridgeAction('watch.poll', {}, ctx, clampTimeoutMs(args.timeout));
      case 'find_ui_elements':
        return await bridgeAction('find_ui_elements', {
          pattern: (args.pattern as string) ?? '',
          type: (args.type as string) ?? '',
          visible_only: args.visible_only !== false,
          limit: (args.limit as number) ?? 200,
          observation_profile: (args.observation_profile as string) ?? 'debug',  // P7: 观察档位
        }, ctx, clampTimeoutMs(args.timeout));
      case 'click_button': {
        const hasText = args.text && typeof args.text === 'string';
        const hasPath = args.path && typeof args.path === 'string';
        if (!hasText && !hasPath) {
          return opsErrorResult('INVALID_PARAMS', 'click_button requires "text" or "path" parameter');
        }
        return await bridgeAction('click_button', {
          text: (args.text as string) ?? '',
          path: (args.path as string) ?? '',
          real_event: args.real_event === true,  // P3-2: 真实输入事件路径(信号计数验证)
        }, ctx, clampTimeoutMs(args.timeout));
      }
      case 'network_conditioner': {
        // P3-1: 弱网注入(masteryee network_conditioner 移植)。set 需游戏已配置多人 peer
        // (ENet/WebSocket host/join 后),无 peer 诚实报错不装空壳。
        const op = (args.op as string) ?? '';
        if (op === 'set') {
          return await bridgeAction('network.set_conditions', {
            latency_ms: (args.latency_ms as number) ?? 0,
            loss_pct: (args.loss_pct as number) ?? 0,
            jitter_ms: (args.jitter_ms as number) ?? 0,
          }, ctx, clampTimeoutMs(args.timeout));
        }
        if (op === 'clear') {
          return await bridgeAction('network.clear', {}, ctx, clampTimeoutMs(args.timeout));
        }
        if (op === 'status') {
          return await bridgeAction('network.status', {}, ctx, clampTimeoutMs(args.timeout));
        }
        return opsErrorResult('INVALID_PARAMS', 'network_conditioner requires op=set|clear|status');
      }
      case 'custom_command': {
        // P3-3: 项目本地命令(res://mcp_commands/*.gd 声明面,custom. 前缀)。
        // TS 侧只拦前缀;命令存在性由 bridge dispatch 表判定(未声明 → -32601)。
        const name = (args.method as string) ?? '';
        if (!name.startsWith('custom.')) {
          return opsErrorResult('INVALID_PARAMS', 'custom_command method must start with "custom." (commands are declared by the game project in res://mcp_commands/*.gd)');
        }
        const userParams = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
          ? (args.params as Record<string, unknown>)
          : {};
        return await bridgeAction(name, userParams, ctx, clampTimeoutMs(args.timeout));
      }

      case 'sync_state': {
        // P10: 多人状态同步(masteryee sync_state 移植裁剪)——快照/比对两段式,不做进程编排
        // (多游戏实例由用户/agent 起在各端口,bridge 端口避让已有;借连接切换打多个快照)。
        const sub = (args.sub_action as string) ?? '';
        if (sub === 'snapshot') {
          const label = String(args.label ?? '').trim();
          if (!label) return opsErrorResult('INVALID_PARAMS', 'sync_state snapshot requires label (e.g. host/client)');
          const group = String(args.group ?? '').trim();
          const res = await bridgeAction('collect_state', group ? { group } : {}, ctx, clampTimeoutMs(args.timeout));
          const text = res.content?.map((c) => ('text' in c ? String(c.text) : '')).join('') ?? '';
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return opsErrorResult('BRIDGE_ERROR', `collect_state response not JSON: ${text.slice(0, 200)}`);
          }
          if (res.isError === true || parsed.error) {
            return res;
          }
          const truncated = parsed.truncated === true;
          _syncSnapshots.set(label, {
            instances: (parsed.instances ?? {}) as Record<string, unknown>,
            count: Number(parsed.count ?? 0),
            game_time_ms: Number(parsed.game_time_ms ?? 0),
            taken_at: Date.now(),
            truncated,
          });
          // 全仓审查: 透传截断标志并附警告——静默截断会让 compare 结果不可信(N-2 修复
          // 的消费侧接线,原 GD 产出但 TS 丢弃)。
          return textResult(JSON.stringify({
            label, count: parsed.count ?? 0, collected: parsed.collected ?? [], truncated,
            ...(truncated ? { warning: 'state collection hit the 256-node cap and was truncated; compare results will not cover all nodes' } : {}),
          }, null, 2));
        }
        if (sub === 'compare') {
          const labelA = String(args.label_a ?? '').trim();
          const labelB = String(args.label_b ?? '').trim();
          if (!labelA || !labelB) return opsErrorResult('INVALID_PARAMS', 'sync_state compare requires label_a and label_b');
          const snapA = _syncSnapshots.get(labelA);
          const snapB = _syncSnapshots.get(labelB);
          if (!snapA) return opsErrorResult('INVALID_PARAMS', `snapshot "${labelA}" not found (take it with sub_action=snapshot first)`);
          if (!snapB) return opsErrorResult('INVALID_PARAMS', `snapshot "${labelB}" not found (take it with sub_action=snapshot first)`);
          const tolerance = typeof args.tolerance === 'number' && args.tolerance >= 0 ? args.tolerance : 0.0001;
          const report = compareStates(snapA.instances, snapB.instances, tolerance);
          // 全仓审查: 任一侧截断则比对结果不可信——显式标注 unreliable,防 agent 据此
          // 做同步判定(同截断→in_sync 假阳性;不同截断→missing 假阴性)。
          const truncatedA = snapA.truncated;
          const truncatedB = snapB.truncated;
          return textResult(JSON.stringify({
            label_a: labelA, label_b: labelB, tolerance,
            game_time_a: snapA.game_time_ms, game_time_b: snapB.game_time_ms,
            truncated_a: truncatedA, truncated_b: truncatedB,
            ...(truncatedA || truncatedB ? { unreliable: true, warning: 'one or both snapshots were truncated at the 256-node cap; in_sync/missing fields do not cover all nodes' } : {}),
            ...report,
          }, null, 2));
        }
        if (sub === 'list') {
          const items = [..._syncSnapshots.entries()].map(([label, snap]) => ({
            label, count: snap.count, game_time_ms: snap.game_time_ms, taken_at: new Date(snap.taken_at).toISOString(), truncated: snap.truncated,
          }));
          return textResult(JSON.stringify({ snapshots: items, total: items.length }, null, 2));
        }
        if (sub === 'clear') {
          _syncSnapshots.clear();
          return textResult(JSON.stringify({ cleared: true }, null, 2));
        }
        return opsErrorResult('INVALID_PARAMS', 'sync_state requires sub_action=snapshot|compare|list|clear');
      }

      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (err instanceof BridgeNotConnectedError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, msg, {
        suggestion: '游戏未运行或 Bridge 未正确响应。先 run_project 启动游戏,确认 game_bridge_install 已执行',
      });
    }
    if (err instanceof BridgeTimeoutError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_TIMEOUT, msg, {
        suggestion: '游戏在运行但无响应(可能被 runtime error 卡住)——这不是连接问题。检查游戏是否报错,或加大 timeout 重试',
      });
    }
    return opsErrorResult(ERROR_CODES.BRIDGE_ERROR, msg);
  }
}

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  game: {
    readonly: false,
    long_running: false,
    actionRisks: {
      game_query: 'read',
      game_input: 'read',
      game_wait: 'read',
      monitor_start: 'read',
      monitor_stop: 'read',
      monitor_poll: 'read',
      watch_start: 'read',
      watch_stop: 'read',
      watch_poll: 'read',
      find_ui_elements: 'read',
      click_button: 'read',
      game_bridge_install: 'write',
      game_bridge_uninstall: 'write',
      install_override: 'write',
      uninstall_override: 'write',
      game_write: 'process',
      game_playtest: 'process',  // P2-4: playtest 改引擎时间/帧推进/snapshot restore
      network_conditioner: 'write',  // P3-1: 改变多人网络行为(注入丢包/延迟)
      custom_command: 'write',
        sync_state: 'read',  // P10: 只收集+本地比对,不改游戏状态(_mcp_state 是游戏方声明面,与 custom_command 的 write 定级差异:sync_state 无执行路径,纯读通道)
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
// 客户端状态重置/就绪探测(re-export,消费方兼容:runtime.ts 的 run_project
// wait_for_bridge 用 isBridgeReady;测试用 resetBridgeState/_testBridgeCacheState)
export { resetBridgeState, isBridgeReady, _testBridgeCacheState, type BridgeReadyResult } from '../core/bridge-client.js';
