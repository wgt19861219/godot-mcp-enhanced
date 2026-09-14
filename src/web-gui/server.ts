// Web GUI 监控面板服务(设计 2026-09-14 v3.1):嵌 MCP server 进程,node:http + SSE,
// 127.0.0.1 恒绑定 + per-process token + Origin 白名单 + 响应卫生(Inspector 壳)。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RunSessionDetailed } from '../core/process-state.js';
import { removeRegistration, writeRegistration } from './registry.js';
import { getLogger } from '../core/logger.js';

export interface WebGuiServerOptions {
  getSessions: () => RunSessionDetailed[];
  getIndexHtml: () => string;
  /** 端口起点(默认 9550;0 = 系统随机分配,测试用) */
  portStart?: number;
  /** token 注入(测试确定性);缺省 randomBytes(24) */
  token?: string;
  /** 登记目录注入(测试隔离);缺省 ~/.godot-mcp/web-gui/(registry.js 默认) */
  registryDir?: string;
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
    // 关闭顺序(设计 §3.1):SSE 连接 end → closeAllConnections → close → 删登记。
    // SSE 连接管理在 Task 7 扩展;本 Task 先 closeAllConnections 兜底。
    _active = false;
    const srv = this.httpServer;
    this.httpServer = null;
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => { srv.close(() => resolve()); });
    await removeRegistration(process.pid, this.opts.registryDir ? { dir: this.opts.registryDir } : {});
  }

  // ─── 鉴权(设计 §5) ────────────────────────────────────────────────────────

  private extractToken(req: IncomingMessage, url: URL): string | null {
    const q = url.searchParams.get('token');
    if (q) return q;
    const h = req.headers['x-gui-token'];
    return typeof h === 'string' ? h : null;
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
      if (!this.authorized(req, url)) {
        const code = this.extractToken(req, url) === this.token ? 403 : 401;   // 对 token 错 Origin=403,错 token=401
        res.writeHead(code).end();
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
}
