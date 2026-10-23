// Web GUI 监控面板服务(设计 2026-09-14 v3.1):嵌 MCP server 进程,node:http + SSE,
// 127.0.0.1 恒绑定 + 共享 token(~/.godot-mcp/web-gui/token.txt,首实例生成后续复用;
// tokenEquals 恒定时间比较,批3 M-1)+ Origin 白名单 + 响应卫生(Inspector 壳)。
// 项目面板批(2026-09-15 spec §4/§5):GET /api/projects + POST scan/add/remove +
// POST /api/sessions/start 五端点 + SSE projects 事件 + hello 扩展。
// 资源工作台批(2026-09-15 spec §4/§5):GET files/file + POST file + GET /assets
// 固定清单四端点 + CSP(script/style self + img/media self;script-src 另以
// INDEX_SCRIPT_SHA256 精确放行唯一内联脚本,批3 去 'unsafe-inline')+ raw 响应头防线。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killPidTree, normalizeProjectKey, isAliveStatus, type RunSessionDetailed } from '../core/process-state.js';
import { connect as tcpConnect } from 'node:net';
import { execFile } from 'node:child_process';
import { removeRegistration, writeRegistration, sweepStaleRegistrations, getOrCreateSharedToken, listRegistrations, type RegistryOpts } from './registry.js';
import { ensurePortalPage, ensureProjectPortalEntry, ensurePackageRootEntry } from './portal.js';
import { INDEX_SCRIPT_SHA256 } from './html.js';
import { pickGuiLang, guiText } from './i18n.js';
import { ensurePackageRootAppLauncher } from './app-window.js';
import { getLogger, getServerId, resolveLogDir } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
// 批4-T8(五维评估 P2 抗抵赖): 写端点统一审计出口——sessions/process、projects/write
// 补线(批2 仅 files-api 一处),caller 细分 web-gui:<子系统>
import { auditWebGui } from './audit-helper.js';
// 实例管理批(2026-09-30):实例重启无项目归属,恒落机器级审计(见 auditInstanceAction)
import { appendMachineAuditLine, isAuditEnabled, recordAuditWriteFailure } from '../core/audit-log.js';
import { LogReader } from '../dashboard/log-reader.js';
import { Aggregator } from '../dashboard/aggregator.js';
import type { ToolStats, TimeSeriesBucket } from '../dashboard/aggregator.js';
import { isPathInAllowedRoots } from '../core/path-utils.js';
import { hasEnvGodotConfig } from '../core/user-settings.js';
import { PathError } from '../core/tool-errors.js';
import { FilesError, type FilesApi, type FilesErrorCode } from './files-api.js';
import { tryAcquireImportLock, releaseImportLock } from './import-mutex.js';
import type { ProjectView } from './projects-store.js';
import type { SettingsApi } from './settings-api.js';
import { KbError, type KbApi } from './kb-api.js';

/** 项目面板 store 注入面(spec 2026-09-15 §4;Task 5 接线传 ProjectsStore 四方法)。
 *  缺席 → 涉清单的项目端点 503,hello 的 projects 字段为 null(v2/M6)。 */
export interface ProjectsApi {
  list(): Promise<ProjectView[]>;
  scan(onProgress?: (found: number, scanned: number) => void): Promise<{ started: boolean; reason?: string; added?: number }>;
  add(path: string): Promise<{ ok: boolean; reason?: 'not_a_project' | 'duplicate' | 'full' | undefined }>;
  remove(path: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface WebGuiServerOptions {
  getSessions: () => RunSessionDetailed[];
  getIndexHtml: () => string;
  /** 端口起点(默认 9550;0 = 系统随机分配,测试用)。
   *  env GODOT_MCP_WEB_GUI_PORT 为用户配置起点通道,'0' 落默认 9550
   *  (随机分配语义仅构造器 portStart 注入通道支持,见 start() 的 ?? 链)。 */
  portStart?: number;
  /** token 注入(测试确定性);缺省 randomBytes(24) */
  token?: string;
  /** 登记目录注入(测试隔离);缺省 ~/.godot-mcp/web-gui/(registry.js 默认) */
  registryDir?: string;
  /** server 包根目录注入(测试隔离,2026-09-16 项目入口批);缺省从本模块位置向上三级
   *  推导(build/web-gui/ 或 src/web-gui/ 的上两级 = 包根/仓库根)——入口页落包根用。 */
  packageRootDir?: string;
  /** 资源工作台(spec 2026-09-15 §4):文件五方法注入;缺席 → files 端点 503。 */
  files?: FilesApi;
  /** 静态资产目录注入(测试隔离);缺省 build/web-gui/assets/(构造器定 assetsRoot)。 */
  assetsDir?: string;
  /** 日志目录注入(测试隔离);缺省 resolveLogDir()(logger 同款平台路径) */
  logDir?: string;
  /** 面板控制(2026-09-14 批准设计):POST /api/sessions/stop 回调;未注入时端点 503。 */
  stopSession?: (projectPath: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 面板控制:POST /api/sessions/remove 回调(移除 ended 态桶);未注入时端点 503。 */
  removeSession?: (projectPath: string) => { ok: boolean; reason?: 'alive' | 'not_found' };
  /** 会话进程输出查看(2026-10-08 输出查看批):GET /api/sessions/output 数据源——
   *  运行中桶读 outputBuffer、已结束桶读 lastFinishedRunOutput(崩溃后回查场景);
   *  桶不存在返回 null(→404);未注入 → 503。尾部截断由 server 侧统一保证,注入
   *  实现给全量 buffer 即可。 */
  getSessionOutput?: (projectPath: string) => { status: string; running: boolean; lines: string[] } | null;
  /** 项目面板(spec 2026-09-15 §4):清单四方法注入;缺席 → 项目端点 503 + hello projects=null。 */
  projects?: ProjectsApi;
  /** POST /api/sessions/start(mode=run)回调;缺席 → 503。 */
  runProject?: (projectPath: string) => Promise<unknown>;
  /** POST /api/sessions/start(mode=edit)回调;缺席 → 503。 */
  editProject?: (projectPath: string) => Promise<unknown>;
  /** POST /api/projects/reimport(资源重导入批 2026-10-08)回调:跑 godot --headless
   *  --import 引擎级扫描+重导入。端点 fire-and-forget,完成经 SSE import 事件推送;
   *  缺席 → 503。 */
  reimportProject?: (projectPath: string) => Promise<unknown>;
  /** READ_ONLY 判定(spec v2/IMP-3,接线层取 GODOT_MCP_READ_ONLY 同源状态);缺席视为非只读。 */
  isReadOnly?: () => boolean;
  /** 设置面板(2026-09-29 设置批):get/verify/save 三方法注入;缺席 → 设置端点 503。 */
  settings?: SettingsApi;
  /** 知识库联动(2026-10-08 批):overview/projectDetail/readFile 只读三方法注入;
   *  缺席 → kb 端点 503。 */
  kb?: KbApi;
  /** 实例管理批(2026-09-30):重启"本实例"的有序退出回调(先响应 200 再走 close 链,
   *  登记文件随 stop() 清理);缺席兜底 process.exit(0)。构造器注入,不新增模块级 setter。 */
  onSelfRestart?: () => void;
  /** daemon 批 B(2026-09-30 spec §3.7/Task 7):受控关停/重启回调(T2 CLI 通道,面板
   *  亦可触发)。POST /api/shutdown(?restart=1 → mode 'restart',缺省 'stop')先 200
   *  响应再异步 150ms 触发本回调(时序对齐 onSelfRestart 先例,防 stop 模式退出竞态
   *  吃掉响应)。未注入时端点 503(stdio 实例不注入,端点不活跃);由 src/daemon/main.ts
   *  接线注入。构造器注入,不新增模块级 setter。 */
  onControlledShutdown?: (mode: 'stop' | 'restart') => void;
  /** 实例管理批(2026-09-30):registry pid 探活注入(测试 mock);缺省 process.kill(pid,0)。 */
  isPidAlive?: (pid: number) => boolean;
  /** 2026-10-22 审查 Low-2:端口 Listening owner PID 查询注入(测试 mock)。
   *  缺省 = 生产实现(Windows Get-NetTCPConnection;L-21 后 POSIX 走 ss→lsof,
   *  工具缺失/查询失败返 null=无法判定,调用方回落纯探活语义)。
   *  构造器注入,不新增模块级 setter(对齐 isPidAlive 先例)。 */
  probePortOwner?: (port: number) => Promise<number | null>;
  /** daemon 批 A(2026-09-30 spec §3.4/M-2):严格端口。true = 只试 portStart 一个端口,
   *  EADDRINUSE 直接 reject 不吃 20 次顺延——respawn 交接的端口不漂移不变式(daemon
   *  旧进程死后新进程必须回到同端口,客户端重连地址才不漂移;顺延成功反而是静默故障)。 */
  strictPort?: boolean;
  /** daemon 批 A(spec §3.4):实例类型,登记进 registry kind 字段(stdio/daemon 区分,
   *  面板后续按 kind 渲染)。缺省不写 kind(JSON.stringify 跳过 undefined)——旧实例
   *  语义,对齐 version 字段先例。 */
  instanceKind?: 'stdio' | 'daemon';
  /** daemon 批 B(2026-09-30 spec §3.7):受控交接关联——新 daemon 以 --respawn-of
   *  启动时登记写入此字段,是前端/daemon status 对旧条目显示"交接中"的标注数据源。
   *  可选,旧登记无此字段向后兼容(parseRegistrationFile 不校验,对齐 kind 先例);
   *  由 src/daemon/main.ts 按 --respawn-of 参数透传。 */
  respawnOf?: number;
  /** daemon 前端批 C(2026-09-30 Task 12):MCP 会话占用活性注入——GET /api/instances
   *  本实例行 sessionActive 字段的数据源(他实例行面板无从得知,恒不携带)。缺省
   *  缺席 → 全部行无该字段(stdio 实例语义,前端不显示占用状态,不落误导性 false);
   *  daemon 侧由 src/daemon/main.ts 接 endpoint.hasLiveSession()(活性双轨判定,
   *  非 SDK 裸计数)。构造器注入,不新增模块级 setter。 */
  isMcpSessionActive?: () => boolean;
  /** daemon 批 A(spec §3.2 注入链):daemon 模式下 POST/GET/DELETE /mcp 三方法
   *  (Streamable HTTP transport 方法面)路由到它;缺席不挂该路由(/mcp 404)。
   *  由 src/daemon/main.ts 构造 WebGuiServer 时直接注入(两段式接线闭包,批 A 审查
   *  N-2 后 ServerOptions 不再有同名字段——注入不走 GodotServer 透传);
   *  web-gui 对 handler 内部零假设(鉴权/协议/响应头全归 handler)——本模块不
   *  import MCP SDK 的分层兑现,组装在 src/daemon/mcp-endpoint.ts(Task 4)。 */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void;
}

/** /api/stats 与 SSE stats 快照形态(html.ts 契约,设计 §3.3.4)。 */
interface ProjectStatsSnapshot {
  totalCalls: number;
  totalErrors: number;
  toolStats: ToolStats[];
  timeSeries: TimeSeriesBucket[];
}

interface StatsSnapshot extends ProjectStatsSnapshot {
  startTime: string;
  mode: string;
  projectPath: string;
  projects: Record<string, ProjectStatsSnapshot>;
}

const DEFAULT_PORT_START = 9550;
const PORT_ATTEMPTS = 20;

// 实例管理批(2026-09-30):本 server 版本,登记进 registry(面板区分新旧代码实例的判据)。
// createRequire idiom 同 GodotServer.ts pkgVersion;本模块在 src/web-gui/(build 后
// build/web-gui/)子目录,包根 package.json 在上两级——vitest 从 src 跑与 node 从
// build 跑的相对深度一致,同一路径双场景成立。
const PKG_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version ?? 'unknown';

/**
 * 面板主文档 CSP(按端口起点构建;WEB_GUI_CSP 导出为默认起点的实例,供测试精确断言)。
 * connect-src 除 'self' 外加端口段 portStart..portStart+19(2026-09-16 入口简化批):
 * 前端自愈探测跨端口 fetch /api/health——CSP 源表达式 'self' 含端口,跨端口即跨源
 * 被拦(真机实测)。端口段与 html.ts recoverPanel 的扫描范围(meta 注入,见 M6)对应;
 * 127.0.0.1 与 localhost 双 host 都放(用户书签可能用任一形态)。
 * M6(2026-10-14 审查): 端口段从模块加载期固化的 9550-9569 字面量改为按实际 portStart
 * 运行期推导——自定义 GODOT_MCP_WEB_GUI_PORT 后 CSP/ACAO/前端扫描三处同步跟随,
 * 迁移自愈链不再断。
 * CSP 加固(审查 Low,2026-09-17 批 3):script-src 去 'unsafe-inline' 改 sha256 精确
 * 放行 INDEX_HTML 内联脚本(hash 模块加载时计算,html.ts INDEX_SCRIPT_SHA256),
 * 注入的 HTML 与 INDEX_HTML 脚本不一致的测试场景仅 CSP 头与常量一致(浏览器才校验);
 * frame-ancestors 'none' 防被嵌入 iframe(clickjacking 面)。
 */
export function buildWebGuiCsp(portStart: number): string {
  return `default-src 'none'; script-src 'self' 'sha256-${INDEX_SCRIPT_SHA256}'; style-src 'unsafe-inline' 'self'; `
  // img-src data:(2026-10-01 NIT-1):head 内联 SVG favicon 走 data: URI,Chromium 将其纳入
  // img-src 管辖(实测被 'self'-only 拦截)。面板动态内容一律 textContent 无 img 注入面,
  // data: 图片仅此一处静态使用。
  + "img-src 'self' data:; media-src 'self'; connect-src 'self'"
  + Array.from({ length: PORT_ATTEMPTS }, (_, i) => portStart + i)
    .flatMap(p => [` http://127.0.0.1:${p}`, ` http://localhost:${p}`])
    .join('')
  + "; frame-ancestors 'none'";
}

/** 默认起点的 CSP 实例(兼容既有测试导入;运行期实例用 buildWebGuiCsp(实际 portStart))。 */
export const WEB_GUI_CSP: string = buildWebGuiCsp(DEFAULT_PORT_START);

/** /api/health ACAO 白名单(M-4,2026-09-17 审查批):仅 127.0.0.1|localhost 的
 *  端口段 Origin 回显(前端自愈跨端口探测可读)。M6: 按实际 portStart 构建。 */
export function buildHealthAcaoRe(portStart: number): RegExp {
  return new RegExp(
    `^http://(127\\.0\\.0\\.1|localhost):(${Array.from({ length: PORT_ATTEMPTS }, (_, i) => portStart + i).join('|')})$`,
  );
}

// assets 固定清单(spec §4/I-2):白名单枚举而非目录扫描——含路径分隔符/编码(如
// ..%2F)或不在清单的名字天然 404,无目录穿越面。Task 4 前端资源(Checkbox 任务书 §4)。
const ASSET_FILES: ReadonlySet<string> = new Set([
  'codemirror.js', 'codemirror.css', 'mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js',
]);

// FilesError code → HTTP 状态码(spec §4:forbidden→403/not_found→404/too_large→413/conflict→409/bad_request→400)
const FILE_ERR_STATUS: Record<FilesErrorCode, number> = {
  forbidden: 403, not_found: 404, too_large: 413, conflict: 409, bad_request: 400,
};

/** 通用 JSON body 上限(审查 Low,2026-09-17 批 3):除 file save(600KB 语义,I-6 独立
 *  预检)外的 POST body 统一 64KB——projectPath/path 等合法字段远小于此,超限即恶意/失控。 */
const JSON_BODY_MAX_BYTES = 64 * 1024;

/** 会话输出端点尾部行数上限(2026-10-08 输出查看批):内存桶上限 5000 行
 *  (process-state MAX_OUTPUT_BUFFER_SIZE),面板查看取尾部 500 行足够定位报错。 */
const SESSION_OUTPUT_TAIL_LINES = 500;

/** L-21(2026-10-22 审查): `ss -tlnpH` 输出解析——监听行含 `users:(("node",pid=1234,fd=20))`,
 *  取首个 pid=;无 pid=(无权限看进程名)或输出空 → null。纯函数,跨平台可单测。 */
export function parseSsOwnerPid(stdout: string): number | null {
  const m = /pid=(\d+)/.exec(stdout);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** L-21: `lsof -ti tcp:<port> -sTCP:LISTEN` 输出解析——纯 pid 列表(每行一个),
 *  取首行;空输出 → null。纯函数,跨平台可单测。 */
export function parseLsofOwnerPid(stdout: string): number | null {
  const first = stdout.trim().split('\n')[0] ?? '';
  if (!first) return null;
  const n = parseInt(first, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 模块级激活标志:只读查询导出(launcher guard 消费),由本类 start/stop 驱动——
// 非依赖注入 setter,不违反 AGENTS.md 模块级 setter 红线(设计 §3.1)。
let _active = false;
export function isWebGuiActive(): boolean {
  return _active;
}

export class WebGuiServer {
  readonly token: string;
  private readonly opts: WebGuiServerOptions;
  private httpServer: Server | null = null;
  private portValue = 0;
  // registry 登记时间戳用(start() 时定格;M-4 后 /api/health 响应不再携带,open.ts 列表仍消费)
  private startedAtIso = '';
  // ─── SSE + 日志数据流(设计 §3.3,Task 7) ───────────────────────────────────
  private sseClients = new Set<ServerResponse>();
  private reader: LogReader | null = null;
  private aggregator = new Aggregator();
  private pendingLogs: LogEntry[] = [];
  private logFlushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionsTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  // 项目面板 SSE(spec §5):扫描进度节流水位(每次 scan 启动时清零,首轮进度立即可见)
  private scanProgressLastPush = 0;
  // assets 根目录(spec §4):构造器定(注入优先,缺省本模块同目录 assets/,与 index.ts 同法取 __dirname)
  private readonly assetsRoot: string;
  // 包根目录(项目入口批 2026-09-16):入口页落包根(开发模式=仓库根,npm 模式=包安装目录)
  private readonly packageRoot: string;

  constructor(opts: WebGuiServerOptions) {
    this.opts = opts;
    // 共享持久 token(2026-09-16 入口简化批):同 registry 目录一份,重启/多实例不变
    // → cookie 持续有效,前端可跨实例自愈;显式注入优先(测试确定性)。
    this.token = opts.token ?? getOrCreateSharedToken(opts.registryDir ? { dir: opts.registryDir } : {});
    this.assetsRoot = opts.assetsDir ?? join(dirname(fileURLToPath(import.meta.url)), 'assets');
    // build/web-gui/server.js → 上两级 = 包根(src/web-gui/ 直跑同理,vitest 亦然)
    this.packageRoot = opts.packageRootDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    // M6(2026-10-14 审查): 实例级 CSP/ACAO 按实际端口起点构建(构造期与 start() 的
    // ?? 链同源),自定义 GODOT_MCP_WEB_GUI_PORT 后不再回落到 9550-9569 字面量段。
    // portStart=0 是"系统随机分配"语义(start() 消费),非端口段起点——随机端口无法
    // 预知段,CSP/ACAO/meta 回落默认段(测试实例与生产默认段实例互探)。
    const ps = this.resolveSelfHealPortStart();
    this.csp = buildWebGuiCsp(ps);
    this.healthAcaoRe = buildHealthAcaoRe(ps);
  }

  /** M6: 端口起点解析(与 start() 首行 ?? 链同源;抽方法防两处漂移)。 */
  private resolvePortStart(): number {
    return this.opts.portStart ?? (Number(process.env.GODOT_MCP_WEB_GUI_PORT) || DEFAULT_PORT_START);
  }

  /** M6: 自愈端口段起点——portStart 无效(0=随机分配/越界)时回落默认段。 */
  private resolveSelfHealPortStart(): number {
    const ps = this.resolvePortStart();
    return Number.isInteger(ps) && ps > 0 && ps <= 65535 - PORT_ATTEMPTS ? ps : DEFAULT_PORT_START;
  }

  /** M6: 实例级 CSP/ACAO(构造期按 resolvePortStart 构建)。 */
  private readonly csp: string;
  private readonly healthAcaoRe: RegExp;

  /** M6: 向面板 HTML 注入自愈扫描端口段 meta(实例 portStart..+19)。
   *  不能改 INDEX_HTML 脚本字面量——内联脚本受 CSP sha256 校验,发送期替换会破坏
   *  hash;meta 不在 script 内,注入零影响。脚本侧读 meta(缺省回落 9550-9569)。 */
  private injectSelfHealPortMeta(html: string): string {
    const lo = this.resolveSelfHealPortStart();
    const meta = `<meta name="mcp-self-heal-ports" content="${lo}-${lo + PORT_ATTEMPTS - 1}">`;
    if (html.includes('mcp-self-heal-ports')) return html; // 幂等(测试注入的 HTML 可能已带)
    return html.replace('<head>', `<head>${meta}`);
  }

  get port(): number {
    return this.portValue;
  }

  /** daemon 批 B(2026-09-30 spec §3.7):登记 startedAt 的同源只读暴露——受控交接
   *  删自身登记前 removeRegistrationVerified(pid, expectedStartedAt) 的期望值必须与
   *  登记文件逐字一致,取本值(start() 定格并写进登记文件的同一 string 引用)而非
   *  调用方另 new Date()(时间戳不同会导致 verified 永远 false)。 */
  get registrationStartedAt(): string {
    return this.startedAtIso;
  }

  async start(): Promise<void> {
    const start = this.resolvePortStart(); // M6: 与 CSP/ACAO/meta 注入同源,自定义起点全链一致
    // daemon 批 A(M-2):strictPort 只试起点一个端口,EADDRINUSE 直接 reject 到上层
    // (respawn 交接端口不漂移不变式);缺省维持 20 次顺延(历史行为,stdio 实例不动)。
    const attempts = this.opts.strictPort ? 1 : PORT_ATTEMPTS;
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      const candidate = start === 0 ? 0 : start + i;
      try {
        await this.listen(candidate);
        this.portValue = (this.httpServer!.address() as { port: number }).port;
        break;
      } catch (err) {
        lastErr = err;
        this.httpServer = null;
      }
    }
    if (!this.httpServer) throw new Error(`web-gui: no free port in ${start}..${start + attempts - 1}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    // 附属功能不阻塞进程退出(设计 §3.1,对齐 orphanScanTimer 先例);已建连接由 stop 统一收
    this.httpServer.unref();
    _active = true;
    // registry 调用参数统一走 regOpts()(注入优先)——start() 原先自拼字面量漏带
    // isPidAlive 注入,测试伪造 pid 的登记会被 fire-and-forget 清扫按真实探活误删
    // (2026-10-14 CI 事故:M1 用例 Windows 碰巧清扫先跑、Linux 慢 IO 下后跑 → 404 竞态)。
    // 生产环境 opts.isPidAlive 恒 undefined → 行为与原先完全一致(defaultIsPidAlive)。
    const regOpts = this.regOpts();
    this.startedAtIso = new Date().toISOString();
    // kind:instanceKind 注入时写入(缺省 undefined 被 JSON.stringify 跳过——旧实例语义,
    // parseRegistrationFile 不校验,对齐 version 字段先例);respawnOf 同款(§3.7 交接关联)
    await writeRegistration({ pid: process.pid, port: this.portValue, token: this.token, startedAt: this.startedAtIso, version: PKG_VERSION, kind: this.opts.instanceKind, respawnOf: this.opts.respawnOf }, regOpts);
    // 陈旧登记清扫(2026-09-15 独立批):自己登记已写且活着不会被删;fire-and-forget 不阻塞启动。
    // 动机:Windows 强杀不走 exit-hook,listRegistrations 顺手清仅 dashboard CLI 路径触达 → server 侧主动清。
    // 仅在未注入 isPidAlive 时执行(生产路径恒如此):注入是测试的读路径语义(伪造 pid 探活),
    // 拿注入探活做启动清扫会产生跨用例竞态——前用例(如 401 用例注入 ()=>false)的清扫
    // 晚于邻用例写自己登记才执行时,会把对方 <pid>.json 删掉(2026-10-14 CI 二轮事故)。
    if (!this.opts.isPidAlive) {
      void sweepStaleRegistrations(regOpts).catch(() => { /* 清扫失败不影响服务 */ });
    }
    // file:// 入口页幂等落盘(2026-09-16):server 启动即确保 portal.html 存在,
    // 用户的 file:/// 书签永远有一个能响应的本地入口(扫描跳转活实例)。
    // 根治批(2026-10-08):内嵌自身端口——新实例启动必写,入口页 preferred 即最近实例。
    try { ensurePortalPage(this.opts.registryDir, this.portValue); } catch { /* 入口页失败不影响服务 */ }
    // 项目目录入口页(2026-09-16 项目入口批):登记项目 + CWD(若为 Godot 项目)各放一份
    // 「面板入口.html」——registry 深路径难找的真机反馈,入口放用户天天开的项目文件夹。
    this.refreshProjectEntries();
    getLogger().info('web-gui', `Web GUI listening on http://127.0.0.1:${this.portValue}/ (pid ${process.pid})`);
    this.startDataStream();
    // log 增量帧:500ms 聚合(设计 §3.3.3;pollIntervalMs 硬下限 500 见 CHECK_DEBOUNCE_MS)。
    // 注册顺序 logFlush→sessions→stats 保证同 tick 内 log 帧先于快照写出(SSE 消费方帧序稳定)。
    this.logFlushTimer = setInterval(() => this.flushLogFrame(), 500);
    this.logFlushTimer.unref?.();
    this.sessionsTimer = setInterval(() => this.broadcastSnapshot('sessions'), 500);
    this.sessionsTimer.unref?.();
    this.statsTimer = setInterval(() => this.broadcastSnapshot('stats'), 1000);
    this.statsTimer.unref?.();
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => this.handle(req, res));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        this.httpServer = srv;
        // 附属功能不阻塞进程退出(设计 §3.1 纪律;listen 内统一挂,start/relisten
        // 两消费方同款语义,重复 unref 无害)
        srv.unref();
        resolve();
      });
    });
  }

  /** 关单个 HTTP server 的最小共享段(daemon 批 B 抽取):closeAllConnections 断
   *  keep-alive/SSE 已建连接(否则 close 回调被挂住、端口迟迟不释放)+ close 等完成。
   *  stop() 与 closeListener() 共用;与 stop 的边界:本段不动 _active/reader/定时器/
   *  SSE 集合/登记——那些是 stop 的全量收尾职责。 */
  private closeServer(srv: Server): Promise<void> {
    srv.closeAllConnections?.();
    return new Promise<void>((resolve) => { srv.close(() => resolve()); });
  }

  async stop(): Promise<void> {
    // 关闭顺序(设计 §3.1):数据流/定时器 → SSE end → closeAllConnections → close → 删登记。
    _active = false;
    this.reader?.stop();
    this.reader = null;
    for (const t of [this.logFlushTimer, this.sessionsTimer, this.statsTimer]) {
      if (t) clearInterval(t);
    }
    this.logFlushTimer = this.sessionsTimer = this.statsTimer = null;
    for (const res of this.sseClients) { try { res.end(); } catch { /* best-effort */ } }
    this.sseClients.clear();
    const srv = this.httpServer;
    this.httpServer = null;
    // srv 为 null = 未 start 过 或 §3.7 closeListener 已关——两种都只跳过 close 段,
    // 登记清理不可跳(closeListener 后接 stop 的交接边界,否则登记泄漏到下次探活清扫)
    if (srv) await this.closeServer(srv);
    await removeRegistration(process.pid, this.opts.registryDir ? { dir: this.opts.registryDir } : {});
  }

  /** daemon 批 B(2026-09-30 spec §3.7 步骤 1):只关 HTTP listener 释放端口,
   *  进程继续活着——不清登记(旧登记保留 = 交接窗口"交接中"标注数据源)、不置
   *  _active(模块级激活标志仍真)、不停 reader/定时器(回滚路径 relisten 后服务
   *  原样恢复)。SSE 连接随 closeAllConnections 的 socket 销毁摘除(req 'close'
   *  自动 delete,sendEvent 的 try/catch 吸收窗口期写入)。 */
  async closeListener(): Promise<void> {
    const srv = this.httpServer;
    this.httpServer = null;
    if (!srv) return;
    await this.closeServer(srv);
  }

  /** closeListener 的逆操作(§3.7 步骤 4 回滚):同端口重新监听(不变式 1:端口跨
   *  交接不漂移)。绑不上(EADDRINUSE,如新实例已占端口)时 reject——由受控交接
   *  的回滚序列决策,本层不自作顺延(strictPort 语义同源)。幂等:已在监听则直接返回。 */
  async relisten(): Promise<void> {
    if (this.httpServer) return;
    await this.listen(this.portValue);
  }

  // ─── 鉴权(设计 §5) ────────────────────────────────────────────────────────

  /** M-1(2026-09-17 审查):token 比较恒定时间——长度先守卫防长度泄露,
   *  timingSafeEqual 防逐前缀定时探测。全部 token 比较点(含 /api/auth 握手)
   *  必须经此方法,不得回退到 ===/!== 字面比较(源码契约测试锁定)。 */
  private tokenEquals(candidate: string | undefined | null): boolean {
    const a = Buffer.from(this.token, 'utf8');
    const b = Buffer.from(String(candidate ?? ''), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private extractToken(req: IncomingMessage, url: URL): string | null {
    // 优先级:query > X-GUI-Token 头 > cookie(空值一律视为未提供,继续走下一通道)
    const q = url.searchParams.get('token');
    if (q) return q;
    const h = req.headers['x-gui-token'];
    if (typeof h === 'string' && h) return h;
    // 第三通道:HttpOnly cookie(/api/auth 握手种下),免疫 URL query 被隐私扩展
    // 剥除/截断——真机事件 2026-09-14:用户浏览器 query 丢失导致面板全断。
    const cookie = req.headers.cookie;
    if (typeof cookie === 'string' && cookie) {
      for (const part of cookie.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === 'gui-token') {
          const v = part.slice(eq + 1).trim();
          if (v) return v;
        }
      }
    }
    return null;
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;   // 非浏览器客户端(curl)凭 token 放行
    return origin === `http://127.0.0.1:${this.portValue}` || origin === `http://localhost:${this.portValue}`;
  }

  /** L-20(2026-10-22 审查):Host 校验——防 DNS rebinding(攻击者域名解析到 127.0.0.1
   *  后,浏览器导航 GET 不带 Origin,originAllowed 拦不住;此类请求 Host 恒是攻击者
   *  域名)。仅放行 loopback 主机名(任意端口);无 Host(HTTP/1.0)拒绝。
   *  注意:有意不做「无 Origin 写请求拒绝」——浏览器跨站写必带 Origin 已被
   *  originAllowed 拦,无 Origin 的写请求是 curl/工具带 token 的合法通道,一刀切
   *  拒绝破坏 REST API 兼容(plan 字面项的偏离,理由见 P3 批审查文档)。 */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '') return false;
    const bare = host.toLowerCase().replace(/:\d+$/, '');
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]';
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    return this.tokenEquals(this.extractToken(req, url)) && this.originAllowed(req);
  }

  // ─── 请求路由 ──────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);
      // L-20:Host 校验先于一切路由(含未鉴权的 / 与 /api/health——rebinding 读面);
      // /mcp 例外(daemon 注入的 MCP 端点,鉴权与部署形态归 handler 自理,本类对其零假设)。
      if (url.pathname !== '/mcp' && !this.hostAllowed(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden: non-loopback Host header');
        return;
      }
      // daemon 批 A(2026-09-30 spec §3.2,Task 3):POST/GET/DELETE /mcp 三方法
      // (Streamable HTTP transport 方法面)路由到注入的 mcpHandler。必须先于 POST
      // 白名单分发注册——否则 POST /mcp 落未知路径 405、GET /mcp 落面板 token 鉴权,
      // MCP 客户端两处都过不去;鉴权/协议/响应头细节全归 handler 自理(web-gui 对
      // handler 内部零假设)。未注入 → 404(端点不活跃;不放行到面板鉴权链,避免
      // 语义混淆的 401)。非三方法的 /mcp(如 PUT)落后续通用 405 语义。
      if (url.pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
        const handler = this.opts.mcpHandler;
        if (handler) {
          handler(req, res);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: guiText(pickGuiLang(req.headers['accept-language']), 'err.mcpNotActive') }));
        return;
      }
      // 面板控制写路径(2026-09-14 + 项目面板批 2026-09-15):POST 先于 GET-only 拦截
      // 分发;未知 POST path → 405(原"非 GET 一律 405"语义对未知组合保持,仅放行
      // 已注册控制路径:stop/remove/start + projects scan/add/remove)。
      if (req.method === 'POST') {
        if (url.pathname === '/api/sessions/stop' || url.pathname === '/api/sessions/remove'
          || url.pathname === '/api/sessions/start' || url.pathname === '/api/projects/scan'
          || url.pathname === '/api/projects/add' || url.pathname === '/api/projects/remove'
          || url.pathname === '/api/projects/file' || url.pathname === '/api/settings'
          || url.pathname === '/api/settings/verify' || url.pathname === '/api/instances/restart'
          || url.pathname === '/api/projects/reimport' || url.pathname === '/api/shutdown') {
          void this.handleApiPost(req, res, url);
          return;
        }
        res.writeHead(405).end();
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      // /api/health 无鉴权探测端点(2026-09-16 入口简化批):前端自愈扫描端口段用。
      // M-4(2026-09-17 审查批):ACAO 从 `*` 收紧为 Origin 白名单回显——仅
      // http://127.0.0.1|localhost:9550-9569(自愈扫描范围,与 WEB_GUI_CSP 端口段
      // 一一对应)回显该 Origin 供跨端口探测读;其他/无 Origin 不发 ACAO 头。
      // 响应只报 {ok,port}——无 pid/token/startedAt 等字段(前端自愈只消费 r.ok)。
      if (url.pathname === '/api/health') {
        const origin = req.headers.origin;
        const acao = typeof origin === 'string' && this.healthAcaoRe.test(origin) ? origin : undefined;
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(acao ? { 'access-control-allow-origin': acao } : {}),
          'x-content-type-options': 'nosniff',
        });
        res.end(JSON.stringify({ ok: true, port: this.portValue }));
        return;
      }
      if (url.pathname === '/') {
        // 静态 HTML 无 token 要求(本体不含 token;token 经 CLI 打开的 URL query 进入)
        // no-store(2026-09-15):防浏览器缓存旧 HTML——面板是单文件应用,每次取新无成本;
        // 真机事件曾疑似叠加旧缓存 HTML 因素(按钮行为与最新版本不符)。
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // CSP 放宽(spec §5.2,资源工作台批):script/style 加 'self'(CodeMirror 资产经
          // /assets 同源载入)+ img/media 'self'(预览 png/svg/音频)。default-src 'none'
          // 底座不动,新增面全部限定 self。
          // connect-src 端口段(2026-09-16 入口简化批):自愈探测需跨端口 fetch /api/health
          // (CSP 的 'self' 含端口,跨端口即跨源被拦——真机实测)。端口段与前端 recoverPanel
          // 扫描范围(meta 注入,M6)一一对应;127.0.0.1 与 localhost 双 host 都放。
          'content-security-policy': this.csp,
        });
        res.end(this.injectSelfHealPortMeta(this.opts.getIndexHtml()));
        return;
      }
      // cookie 双通道握手端点(须在 authorized 之前注册:自身鉴权只用 query token):
      // 对 token → 200 + Set-Cookie 种 HttpOnly cookie,此后 EventSource/fetch 免 query
      // 也能过鉴权(免疫 URL query 被隐私扩展剥除/截断);错/缺 token → 401 不种 cookie。
      // M-1(2026-09-17 审查):补 Origin 闸门(403 先于 token 判定)——种 cookie 的
      // 端点不得响应非本机本端口的浏览器源,防 DNS rebinding/恶意页纵深探测。
      if (url.pathname === '/api/auth') {
        if (!this.originAllowed(req)) { res.writeHead(403).end(); return; }
        if (!this.tokenEquals(url.searchParams.get('token'))) { res.writeHead(401).end(); return; }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `gui-token=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (!this.authorized(req, url)) {
        const code = this.tokenEquals(this.extractToken(req, url)) ? 403 : 401;   // 对 token 错 Origin=403,错 token=401
        res.writeHead(code).end();
        return;
      }
      if (url.pathname === '/events') {
        this.handleSse(req, res);
        return;
      }
      if (url.pathname === '/api/stats') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.statsSnapshot()));
        return;
      }
      if (url.pathname === '/api/sessions') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.opts.getSessions()));
        return;
      }
      // 会话进程输出(2026-10-08 输出查看批):面板日志流只含 server 工具调用日志,
      // 游戏进程 stdout/stderr 在 process-state 内存桶——本端点是面板查看它的唯一通道
      if (url.pathname === '/api/sessions/output') {
        void this.handleSessionOutput(url, res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      // 设置面板读路径(2026-09-29 设置批):get() 异步 → 独立 async handler(鉴权已在上方过)
      if (url.pathname === '/api/settings') {
        void this.handleSettingsGet(res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      // 项目面板读路径(spec §4):list() 异步 → 独立 async handler(鉴权已在上方过)
      if (url.pathname === '/api/projects') {
        void this.handleProjectsList(res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      // 实例列表(2026-09-30 实例管理批):registry 直读(server.ts import registry 先例;
      // 实例清单非 GodotServer 状态,不走 opts 注入——计划决策 1)
      if (url.pathname === '/api/instances') {
        void this.handleInstancesList(res);
        return;
      }
      // 资源工作台读路径(spec §4,2026-09-15 v2):列目录 + 单文件三模式读(均异步 fs)
      if (url.pathname === '/api/projects/files') {
        void this.handleFilesList(url, res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      if (url.pathname === '/api/projects/file') {
        void this.handleFileGet(url, res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      // 知识库联动读路径(2026-10-08 批):总览/项目详情/日志正文,均异步 fs + 可能 spawn git
      if (url.pathname === '/api/kb/overview') {
        void this.handleKbOverview(res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      if (url.pathname === '/api/kb/project') {
        void this.handleKbProject(url, res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      if (url.pathname === '/api/kb/file') {
        void this.handleKbFile(url, res, pickGuiLang(req.headers['accept-language']));
        return;
      }
      // 静态资产(spec §4/I-2):同步读 + 固定清单白名单;与 GET / 的无 token 不同,
      // assets 走 authorized() 三通道(资源含完整 CodeMirror,不对外裸奔)
      if (url.pathname.startsWith('/assets/')) {
        this.handleAsset(url, res);
        return;
      }
      res.writeHead(404).end();
    } catch {
      // D-5 fix(2026-10-01 审查):headersSent 后再 writeHead 会二次抛且无人兜——
      // 当前调用面不可触发(本 catch 前无流式写),补守卫防未来演化踩雷。
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500).end();
    }
  }

  // ─── 面板控制写路径(2026-09-14 批准设计 + 2026-09-15 项目面板批)──────────
  // POST /api/sessions/{stop,remove,start} + /api/projects/{scan,add,remove}:
  // body JSON → 构造器注入回调。鉴权复用 authorized()(浏览器 POST 恒带 Origin 须匹配;
  // cookie SameSite=Strict 防跨站自动携带;无 Origin 的 curl 凭 token 放行)——写路径
  // 语义与读路径一致,不放松。

  /** POST body 读取共用(自原 handleSessionControl 的 for-await 模式抽出)。
   *  上限双守卫(审查 Low,2026-09-17 批 3):content-length 头预检 + chunked(无 CL)
   *  累计字节断流——超限即弃读返回,不整读进内存。file save 调用方显式传 600KB
   *  (I-6 语义),其余端点默认 64KB。
   *  解码(终审 R1,2026-09-18):chunk 收集为 Buffer[],读完后 Buffer.concat
   *  一次 toString('utf8')——for-await 的每个 chunk 是 Buffer,若逐段 `+=`(逐段
   *  隐式 toString)解码,多字节 UTF-8 序列(汉字 3 字节)跨 chunk 边界会被逐段
   *  替换为 U+FFFD,而 U+FFFD 在 JSON 内合法 → JSON.parse 成功 → 损坏内容静默
   *  落盘(file save 600KB 含中文注释场景)。
   *  JSON 解析失败 → reason bad_json(调用方 400);超限 → too_large(调用方 413)。 */
  private async readJsonBody(req: IncomingMessage, maxBytes: number = JSON_BODY_MAX_BYTES): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'bad_json' | 'too_large' }> {
    const cl = Number(req.headers['content-length'] ?? 0);
    if (cl > maxBytes) return { ok: false, reason: 'too_large' };
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();   // 丢弃剩余 body(防连接悬挂/内存驻留),上层回 413
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(chunk);
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
    } catch {
      return { ok: false, reason: 'bad_json' };
    }
  }

  // ─── 实例管理批(2026-09-30)─────────────────────────────────────────────────

  /** registry 调用参数归一(注入优先;start() 内 regOpts 同款字面量的读路径复用版)。 */
  private regOpts(): RegistryOpts {
    const o: RegistryOpts = {};
    if (this.opts.registryDir) o.dir = this.opts.registryDir;
    if (this.opts.isPidAlive) o.isPidAlive = this.opts.isPidAlive;
    return o;
  }

  /** GET /api/instances:registry 直读活实例清单。version/kind/respawnOf null = 早期
   *  实例(登记无对应字段,前端判据;kind/respawnOf 为 daemon 批 A/B 字段,向后兼容
   *  同 version 先例);current 标记本实例(前端"重启自己"走特殊提示)。token 不外发
   *  (响应无凭据字段)。sessionActive(daemon 前端批 C):仅本实例行携带,且仅注入
   *  isMcpSessionActive 时(他实例的会话占用面板无从得知;注入缺席 → 全部行无字段,
   *  前端不显示而非误报空闲)。 */
  private async handleInstancesList(res: ServerResponse): Promise<void> {
    try {
      const entries = await listRegistrations(this.regOpts());
      const body = JSON.stringify({
        me: process.pid,
        instances: entries.map(e => ({
          pid: e.pid,
          port: e.port,
          startedAt: e.startedAt,
          version: e.version ?? null,
          kind: e.kind ?? null,
          respawnOf: e.respawnOf ?? null,
          current: e.pid === process.pid,
          ...(e.pid === process.pid && this.opts.isMcpSessionActive ? { sessionActive: this.opts.isMcpSessionActive() } : {}),
        })),
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (err) {
      getLogger().warn('web-gui', `instances list failed: ${err instanceof Error ? err.message : err}`);
      res.writeHead(500).end();
    }
  }

  /** 实例操作审计:恒落机器级(~/.godot-mcp/machine-audit.jsonl)——实例重启无项目
   *  归属,语义对齐批6-N-e"安全事件归机器"判例。不复用 auditWebGui:其 projectPath
   *  语义绑定项目目录,空路径的成功调用会被 existsSync 守卫整条丢弃(audit-helper
   *  批6-N-e 分支),实例操作走它会零留痕。best-effort,失败不阻断 HTTP 响应。 */
  /** M1(2026-10-14 审查): TCP 探测端口是否有监听者(kill 前登记身份二次验证)。 */
  private probePortAlive(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = tcpConnect({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      const t = setTimeout(() => { sock.destroy(); resolve(false); }, 1_500);
      t.unref?.();
    });
  }

  /** Low-2(2026-10-22 审查): 端口 Listening owner PID(端口-PID 身份绑定,kill 前与
   *  登记 pid 比对)。TCP 探活只证"端口有服务",不证"服务属于登记 PID"——server 崩溃
   *  登记 + Windows PID 回收 + 端口恰被无关进程绑定三条件同时满足时仍会误杀无辜进程树。
   *  L-21(2026-10-22 审查): POSIX 补探测(Low-2 原仅 Windows)——linux 先 ss
   *  (iproute2 基本必装)再 lsof 回落;darwin 直 lsof(macOS 无 ss)。
   *  返回 null = 查询失败 / 工具缺失 / 无监听者(调用方回落纯探活语义,与 Windows
   *  失败分支对称,威胁模型内低危)。port 先过整数+范围校验再进命令行(登记 JSON
   *  解析值不可信);execFile 数组形式无 shell。 */
  private probePortOwnerPidDefault(port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const safePort = Number(port);
      if (!Number.isInteger(safePort) || safePort <= 0 || safePort > 65535) return resolve(null);
      if (process.platform === 'win32') {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            `Get-NetTCPConnection -LocalPort ${safePort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`],
          { timeout: 3_000 },
          (err, stdout) => {
            if (err) return resolve(null);
            const n = parseInt(String(stdout ?? '').trim(), 10);
            resolve(Number.isInteger(n) && n > 0 ? n : null);
          },
        );
        return;
      }
      if (process.platform === 'linux') {
        execFile('ss', ['-tlnpH', `sport = :${safePort}`], { timeout: 3_000 }, (err, stdout) => {
          if (!err) {
            const owner = parseSsOwnerPid(String(stdout ?? ''));
            if (owner !== null) return resolve(owner);
          }
          // ss 输出无 pid= 或 ss 本身不可用 → lsof 回落
          this.probePortOwnerViaLsof(safePort, resolve);
        });
        return;
      }
      this.probePortOwnerViaLsof(safePort, resolve);  // darwin / 其他 POSIX
    });
  }

  /** L-21: lsof 回落通道(ss 缺失的 Linux 容器 / macOS)。lsof 也不可用 → null。 */
  private probePortOwnerViaLsof(port: number, resolve: (v: number | null) => void): void {
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 3_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseLsofOwnerPid(String(stdout ?? '')));
    });
  }

  private auditInstanceAction(action: string, ok: boolean, details?: Record<string, unknown>): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
      tool: 'web-gui', action, risk: 'process',
      ok, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'web-gui:instances',
      ...(details && Object.keys(details).length ? { details } : {}),
    }).catch((e: unknown) => { recordAuditWriteFailure(e); });
  }

  /** daemon 生命周期操作审计(daemon 批 B 2026-09-30):恒落机器级,形态对齐
   *  auditInstanceAction(不复用它——其 caller 绑定 instances 子系统);caller 取
   *  'web-gui:daemon',与 'web-gui:instances'/'daemon:mcp' 同款「域:子系统」风格
   *  (见 src/daemon/mcp-endpoint.ts 同款注释)。成功路径落痕;鉴权拒绝走
   *  auditDaemonReject(N-1);503 未注入是配置态非安全事件,不落(对齐
   *  files/projects 未注入不落痕现状);best-effort,失败不阻断响应。 */
  private auditDaemonAction(details: Record<string, unknown>): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
      tool: 'web-gui', action: 'shutdown', risk: 'process',
      ok: true, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'web-gui:daemon',
      details,
    }).catch((e: unknown) => { recordAuditWriteFailure(e); });
  }

  /** daemon 关停指令鉴权拒绝审计(N-1,批级审查 2026-09-30):spec §3.9 "401 拒绝→
   *  机器级审计"。形态对齐批 A auditMcpReject(src/daemon/mcp-endpoint.ts):action
   *  'shutdown-auth-reject'、ok:false、details 不含 token 值(仅 error 语义 + hasAuth
   *  布尔)。403/401 分流:token 验对但 Origin 不符 → 'origin_forbidden',token 缺失
   *  或错误 → 'unauthorized'。best-effort,失败不阻断拒绝响应。 */
  private auditDaemonReject(error: 'unauthorized' | 'origin_forbidden', hasAuth: boolean): void {
    if (!isAuditEnabled()) return;
    void appendMachineAuditLine({
      trace_id: `web-gui-${randomUUID().slice(0, 16)}`,
      tool: 'web-gui', action: 'shutdown-auth-reject', risk: 'process',
      ok: false, project_path: '', changed_files: [],
      duration_ms: 0, caller: 'web-gui:daemon',
      details: { error, hasAuth },
    }).catch((e: unknown) => { recordAuditWriteFailure(e); });
  }

  private async handleApiPost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // M4(2026-10-14 审查): 端点级错误按请求语言返回(Accept-Language),zh 界面不再混排英文
    const lang = pickGuiLang(req.headers['accept-language']);
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!this.authorized(req, url)) {
        const presented = this.extractToken(req, url);
        const code = this.tokenEquals(presented) ? 403 : 401;   // 对 token 错 Origin=403,错 token=401
        // N-1(批级审查 2026-09-30):shutdown 鉴权失败落机器级审计(spec §3.9),403/401
        // 分流见 auditDaemonReject。仅 shutdown 分支——其余 POST /api/* 的 401/403
        // 零留痕是既有现状,不在本批扩面。hasAuth=任一通道(query/头/cookie)是否携带凭据。
        if (url.pathname === '/api/shutdown') {
          this.auditDaemonReject(code === 403 ? 'origin_forbidden' : 'unauthorized', presented !== null);
        }
        res.writeHead(code).end();
        return;
      }

      // ── POST /api/instances/restart(实例管理批 2026-09-30)─────────────────
      // 安全边界(计划决策 3):pid 必须是 registry 活实例——绝不裸收 pid 杀进程,
      // 防任意进程 kill 后门(过 listRegistrations 的 parseRegistrationFile 三字段
      // 判型 + token 字符集白名单 + isPidAlive 探活三重过滤)。
      // 不受 READ_ONLY 拦:重启是运维操作非项目写,对齐 sessions/stop 不被拦的现状。
      if (url.pathname === '/api/instances/restart') {
        const body = await this.readJsonBody(req);
        if (!body.ok) return json(400, { error: guiText(lang, 'err.badJson') });
        const pid = (body.value as { pid?: unknown } | null)?.pid;
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
          getLogger().info('web-gui', `action=instance_restart result=400_bad_pid`);
          return json(400, { error: guiText(lang, 'err.pidRequired') });
        }
        const entries = await listRegistrations(this.regOpts());
        const target = entries.find(e => e.pid === pid);
        if (!target) {
          getLogger().info('web-gui', `action=instance_restart pid=${pid} result=404_not_registered`);
          this.auditInstanceAction('restart', false, { pid, error: 'not_registered' });
          return json(404, { error: guiText(lang, 'err.notRegistered') });
        }
        if (pid === process.pid) {
          // 自重启:先响应 200,再走注入的有序退出(close 链清登记文件,前端收到响应后
          // SSE 断开自愈迁移);缺省兜底硬退出(登记由下次 listRegistrations 惰性清)。
          getLogger().info('web-gui', `action=instance_restart pid=${pid} result=200_self`);
          this.auditInstanceAction('restart', true, { pid, self: true });
          setTimeout(() => (this.opts.onSelfRestart ?? (() => process.exit(0)))(), 150);
          return json(200, { ok: true, self: true });
        }
        // 杀他实例:Windows 无跨进程优雅信号(taskkill /F /T 是唯一可行),MCP 客户端
        // 检测到子进程退出后重连拉起新进程——新代码生效即此路径。正在跑的 Godot 游戏
        // 会话随目标 server 退出被清理(前端 confirm 文案如实告知)。
        // D-2 fix(2026-10-01):daemon 实例例外——跨实例硬杀 daemon 绕过受控交接链
        // (killPidTree 后无人 respawn、登记残留靠惰性清),破坏「至多一个活 daemon/
        // 受控交接」不变式。此前仅前端换指引文案(html.ts inst-dim),服务端无闸;
        // 现服务端同步拒绝,与前端指引文案一致(daemon 自身面板/CLI 操作)。
        if (target.kind === 'daemon') {
          getLogger().info('web-gui', `action=instance_restart pid=${pid} kind=daemon result=403_cross_instance_daemon`);
          this.auditInstanceAction('restart', false, { pid, error: 'cross_instance_daemon' });
          return json(403, { error: guiText(lang, 'err.daemonHandoff') });
        }
        // M1(2026-10-14 审查): kill 前二次验证登记身份——isPidAlive 仅探活不校验身份,
        // server 崩溃后登记残留 + Windows PID 回收激进时,面板把无关进程显示为活实例,
        // 用户点「重启」即 taskkill /T 强杀无辜进程树。探测登记端口:TCP 可连 = 端口
        // 仍有服务(登记与进程互相印证);连不上 = 登记大概率陈旧(进程已死),PID 存活
        // 更可能是被复用的无关进程——拒绝 kill 并提示登记过期。
        const portAlive = await this.probePortAlive(target.port);
        if (!portAlive) {
          getLogger().info('web-gui', `action=instance_restart pid=${pid} port=${target.port} result=409_stale_registration`);
          this.auditInstanceAction('restart', false, { pid, error: 'stale_registration_port_dead' });
          return json(409, { error: guiText(lang, 'err.staleRegistration') });
        }
        // Low-2(2026-10-22 审查): 端口-PID 身份绑定——TCP 探活只证端口有服务,不证
        // 服务属于登记 PID;Windows 下比对 Get-NetTCPConnection 的 OwningProcess,
        // 不匹配 = 登记陈旧且端口被无关进程占用,拒绝 kill。null(探测工具缺失/查询失败)
        // 回落纯探活语义。注入优先(测试 mock),对齐 isPidAlive 先例。
        const ownerPid = await (this.opts.probePortOwner
          ? this.opts.probePortOwner(target.port)
          : this.probePortOwnerPidDefault(target.port));
        if (ownerPid !== null && ownerPid !== pid) {
          getLogger().info('web-gui', `action=instance_restart pid=${pid} port=${target.port} owner=${ownerPid} result=409_port_owner_mismatch`);
          this.auditInstanceAction('restart', false, { pid, error: 'port_owner_mismatch', ownerPid });
          return json(409, { error: guiText(lang, 'err.staleRegistration') });
        }
        // Nit-3(2026-10-22 审查): 成功日志/审计移到全部验证通过后(先判后记,对齐
        // 403/404/409 分支)——原实现在端口探测前落 ok:true 审计,陈旧登记场景会
        // 产生 ok:true+ok:false 矛盾双审计,且日志 200 与实返 409 不一致。
        getLogger().info('web-gui', `action=instance_restart pid=${pid} port=${target.port} version=${target.version ?? 'legacy'} result=200`);
        this.auditInstanceAction('restart', true, { pid, port: target.port, version: target.version ?? null });
        killPidTree(pid);
        return json(200, { ok: true });
      }

      // ── POST /api/shutdown(daemon 批 B 2026-09-30,spec §3.7/Task 7)─────────
      // daemon 受控停止/重启的指令入口(T2 CLI 通道,面板亦可触发)。无 body 契约——
      // mode 由 query 判别:?restart=1 → 'restart',缺省 'stop'。响应时序对齐
      // instances/restart 自重启先例:先 200 响应再 setTimeout 150ms 异步调回调
      // (stop 模式下回调若同步退进程,竞态会吃掉响应)。caller 判别落审计 details:
      // 无 Origin(CLI 形态)→ 'daemon-cli',有 Origin(浏览器)→ 'panel'。不受
      // READ_ONLY 拦:运维操作,对齐 sessions/stop / instances-restart 现状。
      if (url.pathname === '/api/shutdown') {
        const mode: 'stop' | 'restart' = url.searchParams.get('restart') === '1' ? 'restart' : 'stop';
        const caller = req.headers.origin === undefined ? 'daemon-cli' : 'panel';
        const cb = this.opts.onControlledShutdown;
        if (!cb) {
          getLogger().info('web-gui', `action=shutdown mode=${mode} result=503_not_configured`);
          return json(503, { error: guiText(lang, 'err.notConfigured') });
        }
        getLogger().info('web-gui', `action=shutdown mode=${mode} caller=${caller} result=200`);
        this.auditDaemonAction({ mode, caller });
        setTimeout(() => cb(mode), 150);
        return json(200, { ok: true, mode });
      }

      // ── POST /api/projects/file(spec §4:保存流,body 预检→乐观锁保存)──────
      if (url.pathname === '/api/projects/file') {
        // READ_ONLY 拦截(spec §3.3-1 第一重护栏,fix round 1):面板写路径不得绕过
        // AI 侧防线;对齐 sessions/start 的 403_readonly 形态。
        // 批6-N-e 边界:此处拦截在 readJsonBody 之前(body 不进内存即拒),拿不到
        // projectPath 无从落项目审计;挪后解析仅为审计会削弱早拒设计。readonly 403
        // 留痕覆盖以 sessions/start(路径已知)为准,此分支仅 logger 留痕——诚实边界。
        if (this.opts.isReadOnly?.()) {
          getLogger().info('web-gui', 'action=file_save result=403_readonly');
          return json(403, { error: guiText(lang, 'err.readonly') });
        }
        // I-6:content-length 预检在 readJsonBody 之前——超限 body 不进内存直接 413
        const cl = Number(req.headers['content-length'] ?? 0);
        if (cl > 600 * 1024) {
          getLogger().info('web-gui', `action=file_save result=413 content_length=${cl}`);
          return json(413, { error: guiText(lang, 'err.payloadTooLarge') });
        }
        const f = this.opts.files;
        if (!f) return json(503, { error: guiText(lang, 'err.notConfigured') });
        // readJsonBody 传 600KB(与上方 CL 预检同值):file save 语义上限独立于通用 64KB,
        // 且防 chunked 无 CL 绕过预检后整读进内存。
        const body = await this.readJsonBody(req, 600 * 1024);
        if (!body.ok) {
          if (body.reason === 'too_large') return json(413, { error: guiText(lang, 'err.payloadTooLarge') });
          return json(400, { error: guiText(lang, 'err.badJson') });
        }
        const fields = typeof body.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {};
        const { project, path, content, baseMtime } = fields as Partial<Record<'project' | 'path' | 'content' | 'baseMtime', unknown>>;
        if (typeof project !== 'string' || typeof path !== 'string' || typeof content !== 'string' || typeof baseMtime !== 'number') {
          return json(400, { error: guiText(lang, 'err.saveFieldsRequired') });
        }
        try {
          const r = await f.saveText(project, path, content, baseMtime, pickGuiLang(req.headers['accept-language']));
          getLogger().info('web-gui', `action=file_save project=${project} path=${path} result=200`);
          return json(200, { mtime: r.mtime });
        } catch (err) {
          if (err instanceof FilesError && err.code === 'conflict') {
            // 409 带最新内容+mtime,前端可提示覆盖/放弃(spec §4)
            getLogger().info('web-gui', `action=file_save project=${project} path=${path} result=409`);
            return json(409, { error: err.message, latest: { content: err.latestContent, mtime: err.latestMtime } });
          }
          const status = err instanceof FilesError ? FILE_ERR_STATUS[err.code] : 500;
          getLogger().info('web-gui', `action=file_save project=${project} path=${path} result=${status}`);
          this.filesErr(err, json);
          return;
        }
      }

      // ── POST /api/projects/scan(spec §4:异步起、立即返回;无 body 契约)───
      if (url.pathname === '/api/projects/scan') {
        const p = this.opts.projects;
        if (!p) return json(503, { error: guiText(lang, 'err.notConfigured') });
        this.scanProgressLastPush = 0;   // 新扫描首轮进度立即可见
        // store 的互斥/UNRESTRICTED 决策在调用时同步作出(spec §3.1.1-1);
        // 完成事件经 then 回调后台推送;下方 0-tick 探针只取"是否已启动"决策。
        const settled = p.scan((found, scanned) => this.onScanProgress(found, scanned)).then(
          (r) => {
            if (r.started) void this.pushScanDone(r.added ?? 0);
            this.refreshProjectEntries();   // 扫描新增项目后放入口页(项目入口批 2026-09-16)
            return r;
          },
          (err: unknown) => {
            getLogger().warn('web-gui', `projects scan failed: ${err instanceof Error ? err.message : err}`);
            this.broadcastProjectsEvent({ scanning: false, failed: true });   // 兜底解卡前端扫描态(F-1:failed 标记供前端区分失败与完成)
            throw err;
          },
        );
        try {
          const probe = await Promise.race([settled, new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), 0); })]);
          if (probe !== undefined && !probe.started) {
            return json(200, { started: false, reason: probe.reason ?? 'scanning' });
          }
          return json(200, { started: true });
        } catch (err) {
          // store 同步 throw(UNRESTRICTED 拒扫,Task 2 契约)→ 500 + 提示文案
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // 通用 body 读取:64KB 统一上限(审查 Low);超限 413 先于 JSON 解析
      const body = await this.readJsonBody(req);
      if (!body.ok) {
        if (body.reason === 'too_large') return json(413, { error: guiText(lang, 'err.payloadTooLarge') });
        return json(400, { error: guiText(lang, 'err.badJson') });
      }
      const fields = typeof body.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {};

      // ── POST /api/settings(2026-09-29 设置批:READ_ONLY 403 → 类型校验 →
      //    service 校验/持久化/热生效;失败 400 带 stage)────────────────────────
      if (url.pathname === '/api/settings') {
        const s = this.opts.settings;
        if (!s) return json(503, { error: guiText(lang, 'err.notConfigured') });
        // READ_ONLY 拦截(对齐 file_save 分支:设置写入不得绕过 AI 侧防线)
        if (this.opts.isReadOnly?.()) {
          getLogger().info('web-gui', 'action=settings_save result=403_readonly');
          return json(403, { error: guiText(lang, 'err.readonly') });
        }
        const godotPath = fields.godotPath;
        const allowed = fields.allowedProjectPaths;
        const vaultPath = fields.vaultPath;
        if (godotPath !== undefined && typeof godotPath !== 'string') {
          return json(400, { error: guiText(lang, 'err.godotPathType') });
        }
        if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some(p => typeof p !== 'string'))) {
          return json(400, { error: guiText(lang, 'err.allowedPathsType') });
        }
        if (vaultPath !== undefined && typeof vaultPath !== 'string') {
          return json(400, { error: guiText(lang, 'err.vaultPathType') });
        }
        const patch: { godotPath?: string; allowedProjectPaths?: string[]; vaultPath?: string } = {};
        if (godotPath !== undefined) patch.godotPath = godotPath;
        if (allowed !== undefined) patch.allowedProjectPaths = allowed as string[];
        if (vaultPath !== undefined) patch.vaultPath = vaultPath;
        const r = await s.save(patch, pickGuiLang(req.headers['accept-language']));
        if (!r.ok) {
          getLogger().info('web-gui', `action=settings_save result=400 stage=${r.stage ?? 'unknown'}`);
          return json(400, { error: r.error, ...(r.stage !== undefined ? { stage: r.stage } : {}) });
        }
        return json(200, { ok: true, persisted: r.persisted });
      }

      // ── POST /api/settings/verify(D-1 fix 2026-10-01:verify 会 spawn 候选路径
      //    --version(godot-finder execFileAsync)=进程创建动作,不再豁免 READ_ONLY——
      //    对齐 file_save/settings_save/sessions_start 的拦截惯例,面板不得绕过 AI 侧
      //    防线。探测结果即响应语义,非只读时恒 200 用 body.ok 区分)─────────────────
      if (url.pathname === '/api/settings/verify') {
        const s = this.opts.settings;
        if (!s) return json(503, { error: guiText(lang, 'err.notConfigured') });
        if (this.opts.isReadOnly?.()) {
          getLogger().info('web-gui', 'action=settings_verify result=403_readonly');
          return json(403, { error: guiText(lang, 'err.readonly') });
        }
        const path = fields.path;
        if (typeof path !== 'string' || path.length === 0) return json(400, { error: guiText(lang, 'err.pathRequired') });
        return json(200, await s.verify(path, pickGuiLang(req.headers['accept-language'])));
      }

      // ── POST /api/projects/add(spec §4:白名单 403 → store 校验/合并)────────
      if (url.pathname === '/api/projects/add') {
        const p = this.opts.projects;
        if (!p) return json(503, { error: guiText(lang, 'err.notConfigured') });
        const path = fields.path;
        if (typeof path !== 'string' || path.length === 0) return json(400, { error: guiText(lang, 'err.pathRequired') });
        if (!isPathInAllowedRoots(path)) {
          getLogger().info('web-gui', `action=projects_add path=${path} result=403`);
          auditWebGui('projects', 'add', 'write', path, { ok: false, error: 'path outside allowed roots' });   // 批6-N-e: 越权尝试留痕(403 覆盖对齐 PathError 形态)
          return json(403, { error: guiText(lang, 'err.outsideRoots') });
        }
        let r: { ok: boolean; reason?: string };
        try {
          r = await p.add(path);
        } catch (err) {
          getLogger().info('web-gui', `action=projects_add path=${path} result=500`);
          auditWebGui('projects', 'add', 'write', path, { ok: false, error: err instanceof Error ? err.message : String(err) });   // 批5-N4②: 失败留痕
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
        if (r.ok) {
          getLogger().info('web-gui', `action=projects_add path=${path} result=200`);
          auditWebGui('projects', 'add', 'write', path);   // 批4-T8: 改监控清单留痕(此前零审计)
          await this.broadcastProjects();
          this.refreshProjectEntries();   // 新项目目录放入口页(项目入口批 2026-09-16)
          return json(200, { ok: true });
        }
        if (r.reason === 'not_a_project') {
          getLogger().info('web-gui', `action=projects_add path=${path} result=404`);
          return json(404, { error: guiText(lang, 'err.notGodotProject404') });
        }
        if (r.reason === 'duplicate') {
          getLogger().info('web-gui', `action=projects_add path=${path} result=200_duplicate`);
          return json(200, { ok: false, reason: 'duplicate' });
        }
        // 满员:store {ok:false} 无 reason(Task 2 契约——200 上限逐出耗尽)→ 200 + full 提示
        getLogger().info('web-gui', `action=projects_add path=${path} result=200_full`);
        return json(200, { ok: false, reason: 'full' });
      }

      // ── POST /api/projects/remove(spec §4:仅清单移除,不删文件)──────────────
      if (url.pathname === '/api/projects/remove') {
        const p = this.opts.projects;
        if (!p) return json(503, { error: guiText(lang, 'err.notConfigured') });
        const path = fields.path;
        if (typeof path !== 'string' || path.length === 0) return json(400, { error: guiText(lang, 'err.pathRequired') });
        let r: { ok: boolean; reason?: string };
        try {
          r = await p.remove(path);
        } catch (err) {
          getLogger().info('web-gui', `action=projects_remove path=${path} result=500`);
          auditWebGui('projects', 'remove', 'write', path, { ok: false, error: err instanceof Error ? err.message : String(err) });   // 批5-N4②: 失败留痕
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
        if (r.ok) {
          getLogger().info('web-gui', `action=projects_remove path=${path} result=200`);
          auditWebGui('projects', 'remove', 'write', path);   // 批4-T8: 改监控清单留痕
          await this.broadcastProjects();
          return json(200, { ok: true });
        }
        getLogger().info('web-gui', `action=projects_remove path=${path} result=404`);
        return json(404, { error: guiText(lang, 'err.notFound') });
      }

      // ── POST /api/sessions/start(spec §4:503 → readOnly 403 → 白名单 403 →
      //    project.godot 存在 404 → 注入回调(PathError→403)→ 200)────────────
      if (url.pathname === '/api/sessions/start') {
        const projectPath = fields.projectPath;
        if (typeof projectPath !== 'string' || projectPath.length === 0) return json(400, { error: guiText(lang, 'err.projectPathRequired') });
        let mode: 'run' | 'edit' = 'run';   // mode 缺省 'run'(spec §4)
        if (fields.mode !== undefined) {
          if (fields.mode !== 'run' && fields.mode !== 'edit') return json(400, { error: "mode must be 'run' or 'edit'" });
          mode = fields.mode;
        }
        const fn = mode === 'run' ? this.opts.runProject : this.opts.editProject;
        if (!fn) return json(503, { error: guiText(lang, 'err.notConfigured') });
        if (this.opts.isReadOnly?.()) {   // READ_ONLY 拦截(spec v2/IMP-3):面板不得绕过 AI 侧防线
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=403_readonly`);
          auditWebGui('sessions', 'start', 'process', projectPath, { ok: false, details: { mode }, error: 'read-only mode' });   // 批6-N-e: 拒绝留痕(403 覆盖对齐)
          return json(403, { error: guiText(lang, 'err.readonly') });
        }
        if (!isPathInAllowedRoots(projectPath)) {
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=403`);
          auditWebGui('sessions', 'start', 'process', projectPath, { ok: false, details: { mode }, error: 'path outside allowed roots' });   // 批6-N-e: 越权尝试留痕(路径不存在时由 audit-helper 落机器级)
          return json(403, { error: guiText(lang, 'err.outsideRoots') });
        }
        if (!existsSync(join(projectPath, 'project.godot'))) {
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=404`);
          return json(404, { error: guiText(lang, 'err.notGodotProject404') });
        }
        try {
          await fn(projectPath);
        } catch (err) {
          if (err instanceof PathError) {   // executeRunProject 第二层白名单(Task 5 接线后真实触发)
            getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=403_path`);
            auditWebGui('sessions', 'start', 'process', projectPath, { ok: false, details: { mode }, error: `path rejected: ${err.message}` });   // 批5-N4②: 越权尝试留痕
            return json(403, { error: err.message });
          }
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=500`);
          auditWebGui('sessions', 'start', 'process', projectPath, { ok: false, details: { mode }, error: err instanceof Error ? err.message : String(err) });   // 批5-N4②: 失败留痕
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
        getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=200`);
        auditWebGui('sessions', 'start', 'process', projectPath, { details: { mode } });   // 批4-T8: 起进程留痕
        await this.broadcastProjects();
        return json(200, { ok: true });
      }

      const projectPath = fields.projectPath;
      if (typeof projectPath !== 'string' || projectPath.length === 0) {
        return json(400, { error: guiText(lang, 'err.projectPathRequired') });
      }
      // ── POST /api/projects/reimport(资源重导入批 2026-10-08:503 → readOnly 403 →
      //    白名单 403 → project.godot 404 → 运行中 409 → 互斥 → fire 200)─────────
      if (url.pathname === '/api/projects/reimport') {
        const fn = this.opts.reimportProject;
        if (!fn) return json(503, { error: guiText(lang, 'err.notConfigured') });
        if (this.opts.isReadOnly?.()) {   // 导入写 .godot/imported,属写路径(对齐 start 拦截)
          getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=403_readonly`);
          auditWebGui('projects', 'reimport', 'process', projectPath, { ok: false, error: 'read-only mode' });
          return json(403, { error: guiText(lang, 'err.readonly') });
        }
        if (!isPathInAllowedRoots(projectPath)) {
          getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=403`);
          auditWebGui('projects', 'reimport', 'process', projectPath, { ok: false, error: 'path outside allowed roots' });
          return json(403, { error: guiText(lang, 'err.outsideRoots') });
        }
        if (!existsSync(join(projectPath, 'project.godot'))) {
          getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=404`);
          return json(404, { error: guiText(lang, 'err.notGodotProject404') });
        }
        // 运行中拒绝(用户裁决 2026-10-08):importer 重写 .godot/imported 与运行中游戏
        // 并发访问会在 Windows 撞文件锁——先拒绝并提示停止。isAliveStatus/normalizeProjectKey
        // 与 server 侧会话语义同源(process-state);毫秒级竞态窗由 runImport 自身报错兜底。
        const key = normalizeProjectKey(projectPath);
        const running = this.opts.getSessions().some(
          (s) => normalizeProjectKey(s.projectPath) === key && isAliveStatus(s.status),
        );
        if (running) {
          getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=409`);
          return json(409, { error: guiText(lang, 'err.runningStopFirst') });
        }
        // 共享互斥(2026-10-08 审查 I-1 修复):tryAcquire 非阻塞——占用即 {started:false}
        // (占用方可能是本端点先前的 fire,也可能是 runProject 自动按需导入,两者共用
        // 模块级 import-mutex 锁;排队等待仅自动导入路径使用,端点恒非阻塞)。
        if (!tryAcquireImportLock(key)) {
          getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=200_duplicate`);
          return json(200, { started: false, reason: 'importing' });
        }
        // 异步起、立即返回(scan 先例):--import 可能耗时数十秒,同步等会挂起 fetch;
        // 完成/失败经 SSE import 事件推送(pushImportDone 释放锁)。
        // M5(2026-10-14 审查): race 超时兜底——godot --import 挂死时 fn 永不 settle,
        // pushImportDone 不执行 → import-mutex 永不释放 → 该项目后续 reimport 恒返
        // {started:false, reason:'importing'} 直到 MCP 进程重启。10min 宽裕值只兜真
        // 挂死(正常数十秒级导入不误伤);超时按失败走 pushImportDone 释放锁(fn 若
        // 稍后仍 settle,then 已消费,不会二次推送)。timer unref 防拖住进程退出。
        const REIMPORT_TIMEOUT_MS = 600_000;
        const reimportTask = Promise.race([
          Promise.resolve(fn(projectPath)),
          new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error(`reimport timed out after ${REIMPORT_TIMEOUT_MS / 60000}min (godot --import hung?)`)), REIMPORT_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
        void reimportTask.then(
          (r) => this.pushImportDone(projectPath, key, true, r),
          (err: unknown) => this.pushImportDone(projectPath, key, false, err),
        );
        getLogger().info('web-gui', `action=projects_reimport path=${projectPath} result=200`);
        auditWebGui('projects', 'reimport', 'process', projectPath);
        return json(200, { started: true });
      }
      // ── POST /api/sessions/stop(面板控制第一版既有语义)─────────────────────
      if (url.pathname === '/api/sessions/stop') {
        const fn = this.opts.stopSession;
        if (!fn) return json(503, { error: guiText(lang, 'err.notConfigured') });
        try {
          const r = await fn(projectPath);
          if (r.ok) {
            auditWebGui('sessions', 'stop', 'process', projectPath);   // 批4-T8: 杀进程留痕(MCP 同语义 stop_project 是 risk=process 有审计)
            return json(200, { ok: true });
          }
          if (r.reason === 'not_found') return json(404, { error: guiText(lang, 'err.notFound') });
          auditWebGui('sessions', 'stop', 'process', projectPath, { ok: false, error: r.reason ?? 'stop failed' });   // 批5-N4②: 失败留痕
          return json(500, { error: r.reason ?? guiText(lang, 'err.stopFailed') });
        } catch (err) {
          auditWebGui('sessions', 'stop', 'process', projectPath, { ok: false, error: err instanceof Error ? err.message : String(err) });   // 批5-N4②: 失败留痕
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      // ── POST /api/sessions/remove(面板控制第一版既有语义)───────────────────
      const rm = this.opts.removeSession;
      if (!rm) return json(503, { error: guiText(lang, 'err.notConfigured') });
      const r = rm(projectPath);
      if (r.ok) {
        auditWebGui('sessions', 'remove', 'process', projectPath);   // 批4-T8: 移除会话记录留痕
        return json(200, { ok: true });
      }
      if (r.reason === 'alive') return json(409, { error: guiText(lang, 'err.sessionRunning') });
      return json(404, { error: guiText(lang, 'err.notFound') });
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  // ─── 项目面板读路径(spec §4)───────────────────────────────────────────────

  /** GET /api/sessions/output?project=...(2026-10-08 输出查看批):读路径,不审计。
   *  注入缺席 503 / 缺 project 400 / 桶不存在 404 / 正常 200 {status,running,lines,total}。
   *  尾部截断(OUTPUT_TAIL_LINES)由本层统一保证——注入实现给全量 buffer。鉴权已在 handle() 过。 */
  private async handleSessionOutput(url: URL, res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const fn = this.opts.getSessionOutput;
    if (!fn) return json(503, { error: guiText(lang, 'err.notConfigured') });
    const project = url.searchParams.get('project') ?? '';
    if (project === '') return json(400, { error: guiText(lang, 'err.projectQueryRequired') });
    const out = fn(project);
    if (!out) return json(404, { error: guiText(lang, 'err.notFound') });
    const lines = out.lines.slice(-SESSION_OUTPUT_TAIL_LINES);
    return json(200, { status: out.status, running: out.running, lines, total: out.lines.length, truncated: out.lines.length > lines.length });
  }

  /** GET /api/projects:list() 异步快照;注入缺席 503。鉴权已在 handle() 过。 */
  private async handleProjectsList(res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    try {
      const p = this.opts.projects;
      if (!p) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: guiText(lang, 'err.notConfigured') }));
        return;
      }
      const list = await p.list();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(list));
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  /** GET /api/settings:设置视图快照(2026-09-29 设置批);注入缺席 503。鉴权已在 handle() 过。 */
  private async handleSettingsGet(res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    try {
      const s = this.opts.settings;
      if (!s) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: guiText(lang, 'err.notConfigured') }));
        return;
      }
      const view = await s.get();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(view));
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  // ─── 知识库联动(2026-10-08 批,只读三端点)──────────────────────────────────
  // KbError → HTTP 映射(filesErr 同模式);未知异常 → 500。name 参数在 kb-api
  // safeProjectName 内校验(单段/非 ..),bad_request → 400。
  private static readonly KB_ERR_STATUS: Record<KbError['code'], number> = {
    bad_request: 400,
    not_found: 404,
    forbidden: 403,
    too_large: 413,
    not_configured: 503,
  };

  private kbErr(e: unknown, json: (code: number, body: unknown) => void, lang: 'zh' | 'en' = 'zh'): void {
    if (e instanceof KbError) {
      json(WebGuiServer.KB_ERR_STATUS[e.code], { error: e.message, code: e.code });
      return;
    }
    // 审查 N-3:未知异常(fs EPERM/EBUSY 等)的 message 常含本地绝对路径——响应归一固定
    // 文本(PII-safe),详情进 server 日志(本机文件,非响应面)。
    getLogger().warn('web-gui', `action=kb_internal_error detail=${e instanceof Error ? e.message : String(e)}`);
    json(500, { error: guiText(lang, 'err.internal') });
  }

  /** GET /api/kb/overview:vault 项目总览 + 断流检测(未配置时 configured:false,非报错)。 */
  private async handleKbOverview(res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const kb = this.opts.kb;
      if (!kb) return json(503, { error: guiText(lang, 'err.notConfigured') });
      const view = await kb.overview();
      getLogger().info('web-gui', `action=kb_overview projects=${view.projects.length} stall=${view.projects.filter(p => p.stall).length}`);
      json(200, view);
    } catch (e) {
      this.kbErr(e, json, lang);
    }
  }

  /** GET /api/kb/project?name=:项目详情(日志列表 + 看板分节摘要)。 */
  private async handleKbProject(url: URL, res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const kb = this.opts.kb;
      if (!kb) return json(503, { error: guiText(lang, 'err.notConfigured') });
      const name = url.searchParams.get('name') ?? '';
      if (name === '') return json(400, { error: guiText(lang, 'err.nameRequired') });
      json(200, await kb.projectDetail(name));
    } catch (e) {
      this.kbErr(e, json, lang);
    }
  }

  /** GET /api/kb/file?name=&path=:开发日志正文(只读,防穿越在 kb-api resolveWithinRoot 链)。 */
  private async handleKbFile(url: URL, res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const kb = this.opts.kb;
      if (!kb) return json(503, { error: guiText(lang, 'err.notConfigured') });
      const name = url.searchParams.get('name') ?? '';
      const path = url.searchParams.get('path') ?? '';
      if (name === '' || path === '') return json(400, { error: guiText(lang, 'err.namePathRequired') });
      json(200, await kb.readFile(name, path));
    } catch (e) {
      this.kbErr(e, json, lang);
    }
  }

  // ─── 资源工作台(spec §4,2026-09-15 v2)────────────────────────────────────
  // 三 GET + 一 POST 共用的 FilesError → HTTP 映射;未知异常 → 500。
  private filesErr(e: unknown, json: (code: number, body: unknown) => void): void {
    if (e instanceof FilesError) {
      json(FILE_ERR_STATUS[e.code], { error: e.message });
      return;
    }
    json(500, { error: e instanceof Error ? e.message : String(e) });
  }

  /** GET /api/projects/files:列目录({entries});注入缺席 503(对齐 projects 语义)。 */
  private async handleFilesList(url: URL, res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const f = this.opts.files;
    if (!f) return json(503, { error: guiText(lang, 'err.notConfigured') });
    try {
      const { entries } = await f.listDir(url.searchParams.get('project') ?? '', url.searchParams.get('sub') ?? '');
      json(200, { entries });
    } catch (e) {
      this.filesErr(e, json);
    }
  }

  /** GET /api/projects/file:按 mode 分派 text(JSON)/raw(带 CSP 防线)/hex(JSON)。 */
  private async handleFileGet(url: URL, res: ServerResponse, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const f = this.opts.files;
    if (!f) return json(503, { error: guiText(lang, 'err.notConfigured') });
    const project = url.searchParams.get('project') ?? '';
    const path = url.searchParams.get('path') ?? '';
    const mode = url.searchParams.get('mode') ?? 'text';
    try {
      if (mode === 'text') {
        json(200, await f.readText(project, path));
        return;
      }
      if (mode === 'hex') {
        json(200, await f.readHex(project, path));
        return;
      }
      if (mode === 'raw') {
        // B-1 响应头防线:raw 内容直出 body,CSP 'none' + nosniff 防 SVG 等可执行
        // 载荷在面板源内被激活(内容与 HTML 页面同源,必须按文档级隔离对待)。
        const r = await f.readRaw(project, path);
        res.writeHead(200, {
          'content-type': r.contentType,
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
        });
        res.end(r.bytes);
        return;
      }
      json(400, { error: guiText(lang, 'err.modeInvalid') });
    } catch (e) {
      if (!res.headersSent) this.filesErr(e, json);
    }
  }

  /** GET /assets/{name}:固定清单枚举(spec §4/I-2);同步读。鉴权已在 handle() 过。 */
  private handleAsset(url: URL, res: ServerResponse): void {
    const name = url.pathname.slice('/assets/'.length);
    if (!ASSET_FILES.has(name)) { res.writeHead(404).end(); return; }   // 含 / 或 %2F 的名字天然不在清单
    const file = join(this.assetsRoot, name);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    try {
      const data = readFileSync(file);
      res.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  // ─── SSE + 日志数据流(设计 §3.3) ──────────────────────────────────────────

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.socket?.unref();   // 活跃 SSE 连接不阻塞进程退出(设计 §3.1 M-8)
    this.sseClients.add(res);
    req.on('close', () => { this.sseClients.delete(res); });   // 死连接自动摘除
    // 幂等全量(设计 I-4):每次连接建立(含自动重连)都发 hello,客户端整体重置。
    // projects 字段异步取(list() 是 fs 读,注入缺席为 null)——list() 是 ms 级本地读,
    // 理论上存在快照帧先于 hello 的交错窗,hello 全量重置语义自愈,无正确性影响。
    void this.sendHello(res);
  }

  private async sendHello(res: ServerResponse): Promise<void> {
    const projects = await this.safeProjectsList();
    const s = this.aggregator.getState();
    this.sendEvent(res, 'hello', {
      sessions: this.opts.getSessions(),
      stats: this.statsSnapshot(),
      logs: s.recentLogs.toArray().slice(-500),
      projects,   // spec §5:注入缺席 null(v2/M6)
      // 首启预检面板信号(终验收 V1,spec §3.10 条款 3):settings.json 与 env 均无
      // 有效 Godot 路径/白名单 → false,前端 cfgWarn 黄条显著提示。daemon/stdio 入口
      // 都经 runStartupSequence.applyUserSettingsAtStartup 把 settings 重放进 env,
      // env 即合并生效视图——hasEnvGodotConfig 判 env 即完备(CLI 壳侧 settings+env
      // 合并版见 cli/daemon.ts cmdStart,判定同源于 core/user-settings 纯函数族)。
      settingsConfigured: hasEnvGodotConfig(process.env),
    });
  }

  private startDataStream(): void {
    this.reader = new LogReader(this.opts.logDir ?? resolveLogDir(), { pollIntervalMs: 500 });
    this.reader.on('entries', (entries) => {
      for (const e of entries) {
        if (e.srv !== getServerId()) continue;   // 多 server 共写过滤(设计 §3.3.1)
        this.aggregator.process(e);
        this.pendingLogs.push(e);
      }
    });
    this.reader.on('error', () => { /* 轮询重试(LogReader 内建);GUI 黄条由前端按事件间隙判定 */ });
    this.reader.start().catch((err: Error) => getLogger().warn('web-gui', `LogReader start failed: ${err.message}`));
  }

  private statsSnapshot(): StatsSnapshot {
    const s = this.aggregator.getState();
    // 交接注意 a(Task 3 review):getStateFor 查询即注册——先 getProjectKeys() 快照再逐个取,
    // 绝不让外部输入直通 getStateFor。
    const projects: Record<string, ProjectStatsSnapshot> = {};
    for (const key of this.aggregator.getProjectKeys()) {
      const ps = this.aggregator.getStateFor(key);
      projects[key] = { totalCalls: ps.totalCalls, totalErrors: ps.totalErrors,
        toolStats: [...ps.toolStats.values()], timeSeries: ps.timeSeries };
    }
    return { startTime: s.startTime, mode: s.mode, projectPath: s.projectPath,
      totalCalls: s.totalCalls, totalErrors: s.totalErrors,
      toolStats: [...s.toolStats.values()], timeSeries: s.timeSeries, projects };
  }

  private sendEvent(res: ServerResponse, event: string, data: unknown): void {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 写失败由 close 摘除 */ }
  }

  private flushLogFrame(): void {
    if (this.pendingLogs.length === 0 || this.sseClients.size === 0) {
      this.pendingLogs = this.pendingLogs.length > 200 ? this.pendingLogs.slice(-200) : this.pendingLogs;
      return;
    }
    const entries = this.pendingLogs;
    this.pendingLogs = [];
    for (const res of this.sseClients) this.sendEvent(res, 'log', { entries });
  }

  private broadcastSnapshot(event: 'sessions' | 'stats'): void {
    if (this.sseClients.size === 0) return;
    const data = event === 'sessions' ? this.opts.getSessions() : this.statsSnapshot();
    for (const res of this.sseClients) this.sendEvent(res, event, data);
  }

  // ─── 项目面板 SSE(spec §5)─────────────────────────────────────────────────
  // events payload 约定(Task 4 前端契约):
  //   扫描进度  {scanning:true, found, scanned}      —— 500ms 节流
  //   扫描完成  {scanning:false, added, total, projects}
  //   扫描失败  {scanning:false, failed:true}        —— store 异步 reject 兜底(F-1)
  //   清单变更  {projects}                            —— add/remove/start 成功后的全量快照
  // 前端按字段在场性消费:'projects' 在场 → 整体重置列表;'scanning' 在场 → 更新扫描态
  // (快照事件不带 scanning,避免扫描进行中 add 的快照把扫描指示器误清)。

  /** 扫描进度节流推送(spec §5:500ms)。 */
  private onScanProgress(found: number, scanned: number): void {
    const now = Date.now();
    if (now - this.scanProgressLastPush < 500) return;
    this.scanProgressLastPush = now;
    this.broadcastProjectsEvent({ scanning: true, found, scanned });
  }

  /** 扫描完成:{scanning:false, added, total} + 最新快照(合并为单事件)。 */
  private async pushScanDone(added: number): Promise<void> {
    const list = await this.safeProjectsList();
    if (list === null) {
      this.broadcastProjectsEvent({ scanning: false, added });
      return;
    }
    this.broadcastProjectsEvent({ scanning: false, added, total: list.length, projects: list });
  }

  /** 清单变更(add/remove/start 成功)→ 全量快照推送(spec §5)。best-effort,不抛。 */
  private async broadcastProjects(): Promise<void> {
    const list = await this.safeProjectsList();
    if (list === null) return;
    this.broadcastProjectsEvent({ projects: list });
  }

  /** 注入缺席 → null;list() 失败 → warn + null(best-effort,不炸调用方)。 */
  private async safeProjectsList(): Promise<ProjectView[] | null> {
    if (!this.opts.projects) return null;
    try {
      return await this.opts.projects.list();
    } catch (err) {
      getLogger().warn('web-gui', `projects list failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** 为包根、CWD 与全部登记项目目录刷新「面板入口.html」(项目入口批 2026-09-16)。
   *  fire-and-forget:start/add/scan 完成后调用,不阻塞响应;单目录写失败跳过其余继续。
   *  包根版内嵌 token(零门槛授权,双击直达);CWD/登记项目走 project.godot 护栏不内嵌。
   *  包根另落双击件「面板独立窗口.bat」(独立窗口批 2026-09-16):App 模式直达入口页,
   *  bat 自身零敏感信息(token 由入口页内嵌),非 win32 平台内部自动跳过。 */
  private refreshProjectEntries(): void {
    // M-3(2026-09-17 审查):READ_ONLY 语义不得在"向用户项目目录写文件"维度被穿透
    // (start/scan 完成/add 成功三时点共用本方法,头部短路全覆盖);
    // GODOT_MCP_WEB_GUI_ENTRY=0 跳过项目目录/CWD 入口页落盘(不想被写入项目目录的用户
    // 出口);registry 目录 portal.html(start() 的 ensurePortalPage)不受本开关管辖,仍写。
    if (this.opts.isReadOnly?.()) return;
    if (process.env.GODOT_MCP_WEB_GUI_ENTRY === '0') return;
    try {
      ensurePackageRootEntry(this.packageRoot, this.token, this.portValue);
      ensurePackageRootAppLauncher(this.packageRoot);
    } catch { /* 包根写失败不影响其余 */ }
    const dirs = new Set<string>([process.cwd()]);
    void this.safeProjectsList().then((list) => {
      if (list) for (const p of list) dirs.add(p.path);
      let written = 0;
      for (const dir of dirs) {
        try { if (ensureProjectPortalEntry(dir, this.portValue)) written++; } catch { /* 单目录失败不影响其余 */ }
      }
      if (written > 0) getLogger().info('web-gui', `project portal entries refreshed: ${written}`);
    }).catch(() => { /* 刷新失败不影响服务 */ });
  }

  private broadcastProjectsEvent(data: unknown): void {
    if (this.sseClients.size === 0) return;
    for (const res of this.sseClients) this.sendEvent(res, 'projects', data);
  }

  // ─── 资源重导入 SSE(资源重导入批 2026-10-08)────────────────────────────────
  /** 导入完成/失败 → 释放共享锁 + `import` 事件广播。payload 契约(html.ts 消费):
   *  成功 {type:'done', projectPath, ok:true, report}——report 为回调返回的 integrity
   *  报告(gutted 非空 = .import 疑似被重写损坏,前端须显式警示);
   *  失败 {type:'done', projectPath, ok:false, error}。事件名 'import' 与既有五事件
   *  (hello/log/sessions/stats/projects)并列,前端 addEventListener('import')。
   *  N-3(2026-10-08 审查修复):异步失败补 auditWebGui 留痕——发起时的成功留痕
   *  不足以还原"导入实际失败",补 ok:false + error(对齐 sessions/start 失败留痕面;
   *  scan 无单一 projectPath,不适用本函数语义,维持现状)。 */
  private pushImportDone(projectPath: string, key: string, ok: boolean, payload: unknown): void {
    releaseImportLock(key);
    if (!ok) {
      const msg = payload instanceof Error ? payload.message : String(payload);
      getLogger().warn('web-gui', `projects reimport failed for ${projectPath}: ${msg}`);
      auditWebGui('projects', 'reimport', 'process', projectPath, { ok: false, error: msg.slice(0, 200) });
    }
    if (this.sseClients.size === 0) return;
    const data = ok
      ? { type: 'done', projectPath, ok: true, report: payload }
      : { type: 'done', projectPath, ok: false, error: payload instanceof Error ? payload.message : String(payload) };
    for (const res of this.sseClients) this.sendEvent(res, 'import', data);
  }
}
