// Web GUI 监控面板服务(设计 2026-09-14 v3.1):嵌 MCP server 进程,node:http + SSE,
// 127.0.0.1 恒绑定 + 共享 token(~/.godot-mcp/web-gui/token.txt,首实例生成后续复用;
// tokenEquals 恒定时间比较,批3 M-1)+ Origin 白名单 + 响应卫生(Inspector 壳)。
// 项目面板批(2026-09-15 spec §4/§5):GET /api/projects + POST scan/add/remove +
// POST /api/sessions/start 五端点 + SSE projects 事件 + hello 扩展。
// 资源工作台批(2026-09-15 spec §4/§5):GET files/file + POST file + GET /assets
// 固定清单四端点 + CSP(script/style self + img/media self;script-src 另以
// INDEX_SCRIPT_SHA256 精确放行唯一内联脚本,批3 去 'unsafe-inline')+ raw 响应头防线。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunSessionDetailed } from '../core/process-state.js';
import { removeRegistration, writeRegistration, sweepStaleRegistrations, getOrCreateSharedToken } from './registry.js';
import { ensurePortalPage, ensureProjectPortalEntry, ensurePackageRootEntry } from './portal.js';
import { INDEX_SCRIPT_SHA256 } from './html.js';
import { getLogger, getServerId, resolveLogDir } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
// 批4-T8(五维评估 P2 抗抵赖): 写端点统一审计出口——sessions/process、projects/write
// 补线(批2 仅 files-api 一处),caller 细分 web-gui:<子系统>
import { auditWebGui } from './audit-helper.js';
import { LogReader } from '../dashboard/log-reader.js';
import { Aggregator } from '../dashboard/aggregator.js';
import type { ToolStats, TimeSeriesBucket } from '../dashboard/aggregator.js';
import { isPathInAllowedRoots } from '../core/path-utils.js';
import { PathError } from '../core/tool-errors.js';
import { FilesError, type FilesApi, type FilesErrorCode } from './files-api.js';
import type { ProjectView } from './projects-store.js';

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
  /** 项目面板(spec 2026-09-15 §4):清单四方法注入;缺席 → 项目端点 503 + hello projects=null。 */
  projects?: ProjectsApi;
  /** POST /api/sessions/start(mode=run)回调;缺席 → 503。 */
  runProject?: (projectPath: string) => Promise<unknown>;
  /** POST /api/sessions/start(mode=edit)回调;缺席 → 503。 */
  editProject?: (projectPath: string) => Promise<unknown>;
  /** READ_ONLY 判定(spec v2/IMP-3,接线层取 GODOT_MCP_READ_ONLY 同源状态);缺席视为非只读。 */
  isReadOnly?: () => boolean;
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

/**
 * 面板主文档 CSP(导出供测试精确断言)。
 * connect-src 除 'self' 外加 9550-9569 端口段(2026-09-16 入口简化批):前端自愈探测
 * 跨端口 fetch /api/health——CSP 源表达式 'self' 含端口,跨端口即跨源被拦(真机实测)。
 * 端口段与 html.ts recoverPanel 的扫描范围(9550..9569)一一对应,改动须两处同步;
 * 127.0.0.1 与 localhost 双 host 都放(用户书签可能用任一形态)。
 * CSP 加固(审查 Low,2026-09-17 批 3):script-src 去 'unsafe-inline' 改 sha256 精确
 * 放行 INDEX_HTML 内联脚本(hash 模块加载时计算,html.ts INDEX_SCRIPT_SHA256),
 * 注入的 HTML 与 INDEX_HTML 脚本不一致的测试场景仅 CSP 头与常量一致(浏览器才校验);
 * frame-ancestors 'none' 防被嵌入 iframe(clickjacking 面)。
 */
export const WEB_GUI_CSP: string =
  `default-src 'none'; script-src 'self' 'sha256-${INDEX_SCRIPT_SHA256}'; style-src 'unsafe-inline' 'self'; `
  + "img-src 'self'; media-src 'self'; connect-src 'self'"
  + Array.from({ length: PORT_ATTEMPTS }, (_, i) => DEFAULT_PORT_START + i)
    .flatMap(p => [` http://127.0.0.1:${p}`, ` http://localhost:${p}`])
    .join('')
  + "; frame-ancestors 'none'";

/** /api/health ACAO 白名单(M-4,2026-09-17 审查批):仅 127.0.0.1|localhost 的
 *  9550-9569 段 Origin 回显(前端自愈跨端口探测可读)。端口段由 CSP 同源常量
 *  机械生成,与 WEB_GUI_CSP / html.ts recoverPanel 扫描范围天然同步不漂移。 */
const HEALTH_ACAO_ORIGIN_RE = new RegExp(
  `^http://(127\\.0\\.0\\.1|localhost):(${Array.from({ length: PORT_ATTEMPTS }, (_, i) => DEFAULT_PORT_START + i).join('|')})$`,
);

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
  }

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<void> {
    const start = this.opts.portStart ?? (Number(process.env.GODOT_MCP_WEB_GUI_PORT) || DEFAULT_PORT_START);
    let lastErr: unknown = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
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
    if (!this.httpServer) throw new Error(`web-gui: no free port in ${start}..${start + PORT_ATTEMPTS - 1}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    // 附属功能不阻塞进程退出(设计 §3.1,对齐 orphanScanTimer 先例);已建连接由 stop 统一收
    this.httpServer.unref();
    _active = true;
    const regOpts = this.opts.registryDir ? { dir: this.opts.registryDir } : {};
    this.startedAtIso = new Date().toISOString();
    await writeRegistration({ pid: process.pid, port: this.portValue, token: this.token, startedAt: this.startedAtIso }, regOpts);
    // 陈旧登记清扫(2026-09-15 独立批):自己登记已写且活着不会被删;fire-and-forget 不阻塞启动。
    // 动机:Windows 强杀不走 exit-hook,listRegistrations 顺手清仅 dashboard CLI 路径触达 → server 侧主动清。
    void sweepStaleRegistrations(regOpts).catch(() => { /* 清扫失败不影响服务 */ });
    // file:// 入口页幂等落盘(2026-09-16):server 启动即确保 portal.html 存在,
    // 用户的 file:/// 书签永远有一个能响应的本地入口(扫描跳转活实例)。
    try { ensurePortalPage(this.opts.registryDir); } catch { /* 入口页失败不影响服务 */ }
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
        resolve();
      });
    });
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
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => { srv.close(() => resolve()); });
    await removeRegistration(process.pid, this.opts.registryDir ? { dir: this.opts.registryDir } : {});
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

  private authorized(req: IncomingMessage, url: URL): boolean {
    return this.tokenEquals(this.extractToken(req, url)) && this.originAllowed(req);
  }

  // ─── 请求路由 ──────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);
      // 面板控制写路径(2026-09-14 + 项目面板批 2026-09-15):POST 先于 GET-only 拦截
      // 分发;未知 POST path → 405(原"非 GET 一律 405"语义对未知组合保持,仅放行
      // 已注册控制路径:stop/remove/start + projects scan/add/remove)。
      if (req.method === 'POST') {
        if (url.pathname === '/api/sessions/stop' || url.pathname === '/api/sessions/remove'
          || url.pathname === '/api/sessions/start' || url.pathname === '/api/projects/scan'
          || url.pathname === '/api/projects/add' || url.pathname === '/api/projects/remove'
          || url.pathname === '/api/projects/file') {
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
        const acao = typeof origin === 'string' && HEALTH_ACAO_ORIGIN_RE.test(origin) ? origin : undefined;
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
          // 扫描范围(9550-9569)一一对应;127.0.0.1 与 localhost 双 host 都放。
          'content-security-policy': WEB_GUI_CSP,
        });
        res.end(this.opts.getIndexHtml());
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
      // 项目面板读路径(spec §4):list() 异步 → 独立 async handler(鉴权已在上方过)
      if (url.pathname === '/api/projects') {
        void this.handleProjectsList(res);
        return;
      }
      // 资源工作台读路径(spec §4,2026-09-15 v2):列目录 + 单文件三模式读(均异步 fs)
      if (url.pathname === '/api/projects/files') {
        void this.handleFilesList(url, res);
        return;
      }
      if (url.pathname === '/api/projects/file') {
        void this.handleFileGet(url, res);
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

  private async handleApiPost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!this.authorized(req, url)) {
        res.writeHead(this.tokenEquals(this.extractToken(req, url)) ? 403 : 401).end();
        return;
      }

      // ── POST /api/projects/file(spec §4:保存流,body 预检→乐观锁保存)──────
      if (url.pathname === '/api/projects/file') {
        // READ_ONLY 拦截(spec §3.3-1 第一重护栏,fix round 1):面板写路径不得绕过
        // AI 侧防线;对齐 sessions/start 的 403_readonly 形态。
        if (this.opts.isReadOnly?.()) {
          getLogger().info('web-gui', 'action=file_save result=403_readonly');
          return json(403, { error: 'read-only mode' });
        }
        // I-6:content-length 预检在 readJsonBody 之前——超限 body 不进内存直接 413
        const cl = Number(req.headers['content-length'] ?? 0);
        if (cl > 600 * 1024) {
          getLogger().info('web-gui', `action=file_save result=413 content_length=${cl}`);
          return json(413, { error: 'payload too large' });
        }
        const f = this.opts.files;
        if (!f) return json(503, { error: 'not configured' });
        // readJsonBody 传 600KB(与上方 CL 预检同值):file save 语义上限独立于通用 64KB,
        // 且防 chunked 无 CL 绕过预检后整读进内存。
        const body = await this.readJsonBody(req, 600 * 1024);
        if (!body.ok) {
          if (body.reason === 'too_large') return json(413, { error: 'payload too large' });
          return json(400, { error: 'bad json' });
        }
        const fields = typeof body.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {};
        const { project, path, content, baseMtime } = fields as Partial<Record<'project' | 'path' | 'content' | 'baseMtime', unknown>>;
        if (typeof project !== 'string' || typeof path !== 'string' || typeof content !== 'string' || typeof baseMtime !== 'number') {
          return json(400, { error: 'project/path/content/baseMtime required' });
        }
        try {
          const r = await f.saveText(project, path, content, baseMtime);
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
        if (!p) return json(503, { error: 'not configured' });
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
        if (body.reason === 'too_large') return json(413, { error: 'payload too large' });
        return json(400, { error: 'bad json' });
      }
      const fields = typeof body.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {};

      // ── POST /api/projects/add(spec §4:白名单 403 → store 校验/合并)────────
      if (url.pathname === '/api/projects/add') {
        const p = this.opts.projects;
        if (!p) return json(503, { error: 'not configured' });
        const path = fields.path;
        if (typeof path !== 'string' || path.length === 0) return json(400, { error: 'path required' });
        if (!isPathInAllowedRoots(path)) {
          getLogger().info('web-gui', `action=projects_add path=${path} result=403`);
          return json(403, { error: 'path outside allowed roots' });
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
          return json(404, { error: 'not a godot project' });
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
        if (!p) return json(503, { error: 'not configured' });
        const path = fields.path;
        if (typeof path !== 'string' || path.length === 0) return json(400, { error: 'path required' });
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
        return json(404, { error: 'not found' });
      }

      // ── POST /api/sessions/start(spec §4:503 → readOnly 403 → 白名单 403 →
      //    project.godot 存在 404 → 注入回调(PathError→403)→ 200)────────────
      if (url.pathname === '/api/sessions/start') {
        const projectPath = fields.projectPath;
        if (typeof projectPath !== 'string' || projectPath.length === 0) return json(400, { error: 'projectPath required' });
        let mode: 'run' | 'edit' = 'run';   // mode 缺省 'run'(spec §4)
        if (fields.mode !== undefined) {
          if (fields.mode !== 'run' && fields.mode !== 'edit') return json(400, { error: "mode must be 'run' or 'edit'" });
          mode = fields.mode;
        }
        const fn = mode === 'run' ? this.opts.runProject : this.opts.editProject;
        if (!fn) return json(503, { error: 'not configured' });
        if (this.opts.isReadOnly?.()) {   // READ_ONLY 拦截(spec v2/IMP-3):面板不得绕过 AI 侧防线
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=403_readonly`);
          return json(403, { error: 'read-only mode' });
        }
        if (!isPathInAllowedRoots(projectPath)) {
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=403`);
          return json(403, { error: 'path outside allowed roots' });
        }
        if (!existsSync(join(projectPath, 'project.godot'))) {
          getLogger().info('web-gui', `action=sessions_start mode=${mode} path=${projectPath} result=404`);
          return json(404, { error: 'not a godot project' });
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
        return json(400, { error: 'projectPath required' });
      }
      // ── POST /api/sessions/stop(面板控制第一版既有语义)─────────────────────
      if (url.pathname === '/api/sessions/stop') {
        const fn = this.opts.stopSession;
        if (!fn) return json(503, { error: 'not configured' });
        try {
          const r = await fn(projectPath);
          if (r.ok) {
            auditWebGui('sessions', 'stop', 'process', projectPath);   // 批4-T8: 杀进程留痕(MCP 同语义 stop_project 是 risk=process 有审计)
            return json(200, { ok: true });
          }
          if (r.reason === 'not_found') return json(404, { error: 'not found' });
          auditWebGui('sessions', 'stop', 'process', projectPath, { ok: false, error: r.reason ?? 'stop failed' });   // 批5-N4②: 失败留痕
          return json(500, { error: r.reason ?? 'stop failed' });
        } catch (err) {
          auditWebGui('sessions', 'stop', 'process', projectPath, { ok: false, error: err instanceof Error ? err.message : String(err) });   // 批5-N4②: 失败留痕
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      // ── POST /api/sessions/remove(面板控制第一版既有语义)───────────────────
      const rm = this.opts.removeSession;
      if (!rm) return json(503, { error: 'not configured' });
      const r = rm(projectPath);
      if (r.ok) {
        auditWebGui('sessions', 'remove', 'process', projectPath);   // 批4-T8: 移除会话记录留痕
        return json(200, { ok: true });
      }
      if (r.reason === 'alive') return json(409, { error: 'session is still running' });
      return json(404, { error: 'not found' });
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  // ─── 项目面板读路径(spec §4)───────────────────────────────────────────────

  /** GET /api/projects:list() 异步快照;注入缺席 503。鉴权已在 handle() 过。 */
  private async handleProjectsList(res: ServerResponse): Promise<void> {
    try {
      const p = this.opts.projects;
      if (!p) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not configured' }));
        return;
      }
      const list = await p.list();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(list));
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
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
  private async handleFilesList(url: URL, res: ServerResponse): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const f = this.opts.files;
    if (!f) return json(503, { error: 'not configured' });
    try {
      const { entries } = await f.listDir(url.searchParams.get('project') ?? '', url.searchParams.get('sub') ?? '');
      json(200, { entries });
    } catch (e) {
      this.filesErr(e, json);
    }
  }

  /** GET /api/projects/file:按 mode 分派 text(JSON)/raw(带 CSP 防线)/hex(JSON)。 */
  private async handleFileGet(url: URL, res: ServerResponse): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const f = this.opts.files;
    if (!f) return json(503, { error: 'not configured' });
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
      json(400, { error: 'mode must be text, raw or hex' });
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
   *  包根版内嵌 token(零门槛授权,双击直达);CWD/登记项目走 project.godot 护栏不内嵌。 */
  private refreshProjectEntries(): void {
    // M-3(2026-09-17 审查):READ_ONLY 语义不得在"向用户项目目录写文件"维度被穿透
    // (start/scan 完成/add 成功三时点共用本方法,头部短路全覆盖);
    // GODOT_MCP_WEB_GUI_ENTRY=0 跳过项目目录/CWD 入口页落盘(不想被写入项目目录的用户
    // 出口);registry 目录 portal.html(start() 的 ensurePortalPage)不受本开关管辖,仍写。
    if (this.opts.isReadOnly?.()) return;
    if (process.env.GODOT_MCP_WEB_GUI_ENTRY === '0') return;
    try { ensurePackageRootEntry(this.packageRoot, this.token); } catch { /* 包根写失败不影响其余 */ }
    const dirs = new Set<string>([process.cwd()]);
    void this.safeProjectsList().then((list) => {
      if (list) for (const p of list) dirs.add(p.path);
      let written = 0;
      for (const dir of dirs) {
        try { if (ensureProjectPortalEntry(dir)) written++; } catch { /* 单目录失败不影响其余 */ }
      }
      if (written > 0) getLogger().info('web-gui', `project portal entries refreshed: ${written}`);
    }).catch(() => { /* 刷新失败不影响服务 */ });
  }

  private broadcastProjectsEvent(data: unknown): void {
    if (this.sseClients.size === 0) return;
    for (const res of this.sseClients) this.sendEvent(res, 'projects', data);
  }
}
