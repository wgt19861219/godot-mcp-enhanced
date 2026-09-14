// Web GUI 监控面板服务(设计 2026-09-14 v3.1):嵌 MCP server 进程,node:http + SSE,
// 127.0.0.1 恒绑定 + per-process token + Origin 白名单 + 响应卫生(Inspector 壳)。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RunSessionDetailed } from '../core/process-state.js';
import { removeRegistration, writeRegistration } from './registry.js';
import { getLogger, getServerId, resolveLogDir } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
import { LogReader } from '../dashboard/log-reader.js';
import { Aggregator } from '../dashboard/aggregator.js';
import type { ToolStats, TimeSeriesBucket } from '../dashboard/aggregator.js';

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
  /** 日志目录注入(测试隔离);缺省 resolveLogDir()(logger 同款平台路径) */
  logDir?: string;
  /** 面板控制(2026-09-14 批准设计):POST /api/sessions/stop 回调;未注入时端点 503。 */
  stopSession?: (projectPath: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 面板控制:POST /api/sessions/remove 回调(移除 ended 态桶);未注入时端点 503。 */
  removeSession?: (projectPath: string) => { ok: boolean; reason?: 'alive' | 'not_found' };
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
  // ─── SSE + 日志数据流(设计 §3.3,Task 7) ───────────────────────────────────
  private sseClients = new Set<ServerResponse>();
  private reader: LogReader | null = null;
  private aggregator = new Aggregator();
  private pendingLogs: LogEntry[] = [];
  private logFlushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionsTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WebGuiServerOptions) {
    this.opts = opts;
    this.token = opts.token ?? randomBytes(24).toString('hex');
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
    await writeRegistration({ pid: process.pid, port: this.portValue, token: this.token, startedAt: new Date().toISOString() }, regOpts);
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
    return this.extractToken(req, url) === this.token && this.originAllowed(req);
  }

  // ─── 请求路由 ──────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);
      // 面板控制写路径(2026-09-14):POST 先于 GET-only 拦截分发;未知 POST path → 405
      // (原"非 GET 一律 405"语义对未知组合保持,仅放行两条已注册控制路径)。
      if (req.method === 'POST') {
        if (url.pathname === '/api/sessions/stop' || url.pathname === '/api/sessions/remove') {
          void this.handleSessionControl(req, res, url);
          return;
        }
        res.writeHead(405).end();
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/') {
        // 静态 HTML 无 token 要求(本体不含 token;token 经 CLI 打开的 URL query 进入)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        });
        res.end(this.opts.getIndexHtml());
        return;
      }
      // cookie 双通道握手端点(须在 authorized 之前注册:自身鉴权只用 query token):
      // 对 token → 200 + Set-Cookie 种 HttpOnly cookie,此后 EventSource/fetch 免 query
      // 也能过鉴权(免疫 URL query 被隐私扩展剥除/截断);错/缺 token → 401 不种 cookie。
      if (url.pathname === '/api/auth') {
        if (url.searchParams.get('token') !== this.token) { res.writeHead(401).end(); return; }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `gui-token=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (!this.authorized(req, url)) {
        const code = this.extractToken(req, url) === this.token ? 403 : 401;   // 对 token 错 Origin=403,错 token=401
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
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  }

  // ─── 面板控制写路径(2026-09-14 批准设计)──────────────────────────────────
  // POST /api/sessions/stop + /api/sessions/remove:body { projectPath } → 构造器注入
  // 回调。鉴权复用 authorized()(浏览器 POST 恒带 Origin 须匹配;cookie SameSite=Strict
  // 防跨站自动携带;无 Origin 的 curl 凭 token 放行)——写路径语义与读路径一致,不放松。

  private async handleSessionControl(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!this.authorized(req, url)) {
        res.writeHead(this.extractToken(req, url) === this.token ? 403 : 401).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed: { projectPath?: unknown };
      try {
        parsed = JSON.parse(body) as { projectPath?: unknown };
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (typeof parsed.projectPath !== 'string' || parsed.projectPath.length === 0) {
        return json(400, { error: 'projectPath required' });
      }
      if (url.pathname === '/api/sessions/stop') {
        const fn = this.opts.stopSession;
        if (!fn) return json(503, { error: 'not configured' });
        try {
          const r = await fn(parsed.projectPath);
          if (r.ok) return json(200, { ok: true });
          if (r.reason === 'not_found') return json(404, { error: 'not found' });
          return json(500, { error: r.reason ?? 'stop failed' });
        } catch (err) {
          return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      const rm = this.opts.removeSession;
      if (!rm) return json(503, { error: 'not configured' });
      const r = rm(parsed.projectPath);
      if (r.ok) return json(200, { ok: true });
      if (r.reason === 'alive') return json(409, { error: 'session is still running' });
      return json(404, { error: 'not found' });
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
    // 幂等全量(设计 I-4):每次连接建立(含自动重连)都发 hello,客户端整体重置
    const s = this.aggregator.getState();
    this.sendEvent(res, 'hello', {
      sessions: this.opts.getSessions(),
      stats: this.statsSnapshot(),
      logs: s.recentLogs.toArray().slice(-500),
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
}
