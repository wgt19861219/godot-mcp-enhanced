# 常驻守护进程(daemon)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 方案 A——daemon 常驻进程(内嵌单 GodotServer + `/mcp` streamable HTTP 端点 + 常驻 Web GUI 面板)+ `daemon start/stop/status/restart` CLI + 端口不漂移的受控交接,解三痛点(面板随 stdio server 生灭 / stdio 断连客户端不重连 / 面板不能拉起服务)。

**Architecture:** daemon 是独立 detached 进程,复用 `GodotServer` 全部能力,仅把 transport 从 stdio 参数化为 SDK `WebStandardStreamableHTTPServerTransport`(stateful 模式);面板与 `/mcp` 共用 `WebGuiServer` 的单端口 HTTP 监听(`/mcp` 经 GodotServer options `mcpHandler` 透传注入,web-gui 不 import MCP SDK);配置真相源 = `~/.godot-mcp/settings.json`(GUI 设置面板即 daemon 配置界面,保存热生效);重启走受控交接(先关 listener → spawn 传 `--port`+`--respawn-of` → 登记 port 比对 → 旧进程删登记退出,失败回滚杀新实例)。

**Tech Stack:** TypeScript(ES2022/strict/ESM,import 带 `.js`)+ `@modelcontextprotocol/server` 2.x(`WebStandardStreamableHTTPServerTransport`) + Node 全局 `Request`/`Response` + `Readable.toWeb`/`fromWeb` wiring + Vitest。

**Spec:** `docs/plans/2026-09-30-daemon-spec.md`(两轮审查处置后版本;本 plan 实现其 §3 设计与 §5 验收,两轮审查处置的硬约束全部内化到下方 Global Constraints 与各任务)。

**用户决策(2026-09-30 定案):** D1 方案 A / D2 /mcp 强制共享 token / D3 单会话独占 / D4 `--open` 旗标——四项全采纳推荐。

## Global Constraints

- 工作目录 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced`;master 不开 commit——三批各起分支:**批 A `feat/daemon-core`(Task 1-6)/ 批 B `feat/daemon-lifecycle`(Task 7-10)/ 批 C `feat/daemon-frontend-accept`(Task 11-14)**,每批全绿后合回 `feat/web-gui-instance-management`(spec 所属特性链)。
- TypeScript:`strict` + `noUncheckedIndexedAccess`,禁 `any`(CI error),未使用变量 error;ESM import 必须带 `.js` 扩展名。
- **分层**:core 不 import tools/web-gui(eslint 门禁);web-gui 不 import MCP SDK(/mcp 由 daemon 侧组装后以 `mcpHandler` 回调注入);daemon 组合层 `src/daemon/` 合法。**禁止新增模块级 setter**——一切注入走构造器/options(存量 26 个 setter 是历史债,不添新)。
- **/mcp 鉴权(spec §3.5)**:仅认 `Authorization: Bearer <token>`——独立取值分支,**不复用 `extractToken`**(其优先级 query>header>cookie,query/cookie 一并拒);401 不回 token 值;失败落审计。Host 校验按**中间件**形式(SDK rebinding 选项已 `@deprecated`,用导出的 `validateHostHeader`/`localhostAllowedHostnames` 作底层构件)。
- **不变式(spec §3.7)**:①daemon 端口跨重启不漂移(strictPort:EADDRINUSE 即败,不走 `start()` 20 次顺延);②任意时刻至多一个活 daemon(回滚也要先杀新实例并确认其登记消失)。
- **触发通道(spec §3.7)**:T1 = daemon 自身面板重启(isSelf,同端口 Origin 放行);T2 = CLI 直连 `POST /api/shutdown?restart=1`(无 Origin 头放行)。跨实例面板重启 daemon **维持 403**(不破同源闸门),前端改指引文案。
- **daemon 进程纪律(spec §3.3)**:不注册 `process.stdin.on('end')` 钩子;不拉 Dashboard TUI;不跑 self-update;启动序走共享 `runStartupSequence({dashboard:false, selfUpdate:false})`。
- 测试落位:web-gui 系测试在 `test/web-gui/`;daemon 入口/交接测试同目录(与被测对象约定);CLI 测试落 `test/` 根(对齐既有 cli 测试惯例)。覆盖率 CI 阈值:statements 76% / branches 67% / functions 80% / lines 77%。
- 新增 CLI exit code 语义须登记进 `test/p2-exit-path-repair.test.ts` 的注册表扫描;审计 caller 需区分 `daemon-cli` / `panel`。
- **不触碰**:`.claude/rules/`、`src/tools/rule-templates.ts`(不触发版本 bump 门禁)、`src/core/instance-manager.ts`、`docs/capability-matrix.*`(不加 MCP 工具,不跑 build-matrix)、`addons/`。
- 每任务完成跑该任务测试;每批收尾跑 `npm run lint`(0)+ `npm run build` + `npm test`(全绿)后才许合并;每批产出 code-reviewer 审查文档 `docs/reviews/`+ memory 登记(AGENTS.md 强制流程)。
- commit 走 Conventional Commits(`feat(daemon):` / `test(daemon):` / `docs(daemon):`,subject 中文)。

---

## Spike 结论记录(Task 1 产出回填处)

> Task 1 执行后在此登记三项结论;后续任务若与结论冲突,以实测为准修订对应任务代码块再实施。

- [x] **S-1 Node↔Web wiring**:`IncomingMessage → Request`(含 body 流,duplex:'half')与 `Response → ServerResponse`(含 SSE 流式 body)的转换在本仓 Node 版本下可用(预期:Node ≥18 全局 Request/Response + `Readable.toWeb/fromWeb`)。实测:Node v24.14.0 下全链路可用——`Readable.toWeb(req)` + `duplex:'half'` 作 Request body,tools/call 参数无损到达(echo:hi 原样返回);`Readable.fromWeb(webRes.body).pipe(res)` 回写 SSE 长流(POST 响应 content-type: `text/event-stream`)成功读回 JSON-RPC result。**关键细节:SDK 2.0.0 的 exports 无 `/mcp.js`、`/streamablehttp.js` 子路径,`McpServer`/`WebStandardStreamableHTTPServerTransport`/`registerTool`(实例方法)/`validateHostHeader`/`localhostAllowedHostnames` 一律从主入口 `@modelcontextprotocol/server` 导入**(Task 4 代码块现写法已正确)。探针:`scripts/spike-daemon-transport.mjs`(11/11 PASS,复跑 2 次稳定)。
- [x] **S-2 stateful 会话语义**:`sessionIdGenerator: () => randomUUID()` 时 Initialize 响应带 `mcp-session-id` 头;无 session 的非初始化请求 400;`onsessioninitialized`/`onsessionclosed`(仅 DELETE 触发 closed)回调时序符合"中间件层拦第二 Initialize"的实现假设。实测:全部符合——initialize 响应头 `mcp-session-id`(UUID,如 `54cb6f4a-…`)+ `mcp-protocol-version: 2025-11-25`;无 session 头的 tools/list POST → 400;`onsessioninitialized` 在 initialize 后恰好 1 次;`onsessionclosed` 仅 DELETE(返回 200)触发 1 次,SSE 流提前 abort 断开**不**触发 closed(批 C 单会话拦截可放心用这对计数)。notification POST(initialized)返回 202 无响应体。
- [x] **S-3 SDK client 直连**:探针脚本用 `Client` + HTTP transport 对 spike server 完成 initialize → tools/list 往返。实测:**降级验证通过**——本仓未安装 `@modelcontextprotocol/client`(node_modules 与 package.json 均无,按 brief 预案不盲装),改用原生 fetch 手写 JSON-RPC(initialize → notifications/initialized → tools/list → tools/call → DELETE)走同一条 Node↔Web↔transport wiring,全链路往返成功(tools=[spike_echo]、echo:hi)。SDK Client 侧行为留待批 C 真机验收(真 MCP 客户端连 daemon)覆盖。

---

# 批 A:`feat/daemon-core`——daemon 能起、面板常驻、/mcp 能握手

### Task 1: Spike——transport wiring 与会话语义验证

**Files:**
- Create: `scripts/spike-daemon-transport.mjs`(探针脚本,不进 build、不进 git 依赖链,批 A 完成后可留可删)

**Interfaces:**
- Produces: 本 plan「Spike 结论记录」节的 S-1/S-2/S-3 三条实测结论(后续任务 wiring 代码的依据)。

- [ ] **Step 1:起分支**

```bash
cd "D:/GitHub/godot-mcp-series/godot-mcp-enhanced"
git checkout -b feat/daemon-core
```

- [ ] **Step 2:写探针脚本(Node http + WebStandardStreamableHTTPServerTransport + 最小 McpServer)**

```js
// scripts/spike-daemon-transport.mjs — daemon 专项 R1/R3 spike(spec §6)
// 验证三件事(S-1/S-2/S-3,结论回填 docs/plans/2026-09-30-daemon-plan.md):
//   S-1 Node IncomingMessage/ServerResponse ↔ Web Request/Response 双向转换(含 POST body 与 SSE 流)
//   S-2 stateful 会话语义(mcp-session-id 响应头 / 400 / onsessioninitialized|closed 时序)
//   S-3 SDK Client 经 streamable HTTP 完成 initialize→tools/list 往返
// 用法:node scripts/spike-daemon-transport.mjs   (自跑自验,退出码 0=全部通过)
import { createServer, } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server/mcp.js';
import { registerTool } from '@modelcontextprotocol/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/server/streamablehttp.js';   // 导入路径若 404,回退 '@modelcontextprotocol/server' 主入口(下同)
import { Client } from '@modelcontextprotocol/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client/streamablehttp.js';
import { z } from 'zod';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

// ── S-1/S-2:server 侧 ─────────────────────────────────────────────
const mcp = new McpServer({ name: 'spike', version: '0.0.0' });
mcp.registerTool('spike_echo', { description: 'echo', inputSchema: z.object({ v: z.string() }) },
  async ({ v }) => ({ content: [{ type: 'text', text: 'echo:' + v }] }));

let sessionEvents = { init: 0, closed: 0 };
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),               // stateful 模式
  onsessioninitialized: () => { sessionEvents.init++; },
  onsessionclosed: () => { sessionEvents.closed++; },
});
await mcp.connect(transport);

// Node ↔ Web 转换(daemon/mcp-endpoint.ts Task 4 的同款逻辑,此处先行验证)
async function nodeReqToWebRequest(req) {
  const url = `http://127.0.0.1:${PORT}${req.url}`;
  const headers = { ...req.headers }; delete headers.host; headers.host = `127.0.0.1:${PORT}`; // 固定 Host
  const method = req.method;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  return new Request(url, {
    method, headers,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
  });
}
async function writeWebResponseToNode(webRes, res) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webRes.status, headers);
  if (!webRes.body) { res.end(); return; }
  Readable.fromWeb(webRes.body).pipe(res);              // SSE 长流同样走 pipe
}

const PORT = 9871;
const httpServer = createServer(async (req, res) => {
  try {
    const webReq = await nodeReqToWebRequest(req);
    const webRes = await transport.handleRequest(webReq);
    await writeWebResponseToNode(webRes, res);
  } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
});

// ── S-3:client 侧(同一个进程内起 Client 打自己) ─────────────────
await new Promise((r) => httpServer.listen(PORT, '127.0.0.1', r));
const client = new Client({ name: 'spike-client', version: '0.0.0' });
const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
try {
  await client.connect(clientTransport);
  check('S-3 client initialize', true);
  const tools = await client.listTools();
  check('S-3 tools/list 往返', tools.tools.some(t => t.name === 'spike_echo'));
  const call = await client.callTool({ name: 'spike_echo', arguments: { v: 'hi' } });
  check('S-3 tools/call 往返', call.content[0].text === 'echo:hi');
  check('S-2 onsessioninitialized 触发', sessionEvents.init === 1, `init=${sessionEvents.init}`);
  // 无 session 头的非初始化请求 → 400(stateful 语义)
  const raw = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
  });
  check('S-2 无 session 非初始化请求 400', raw.status === 400, `status=${raw.status}`);
  await client.close();                                  // DELETE
  await new Promise(r => setTimeout(r, 200));
  check('S-2 onsessionclosed(DELETE)触发', sessionEvents.closed === 1, `closed=${sessionEvents.closed}`);
} catch (e) {
  check('S-3 链路', false, String(e && e.message));
} finally {
  httpServer.close();
}
const failed = results.filter(r => !r.ok);
console.log(failed.length === 0 ? '\nSPIKE ALL PASS' : `\nSPIKE FAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
```

- [ ] **Step 3:跑探针并回填结论**

Run: `node scripts/spike-daemon-transport.mjs`
Expected: `SPIKE ALL PASS`(退出码 0)。任何 FAIL:先修探针(导入路径按 `node_modules/@modelcontextprotocol/server/package.json` 的 exports 实测调整),仍 FAIL 则把失败项如实写进「Spike 结论记录」并按实测修订 Task 4 代码块后再实施后续任务。

- [ ] **Step 4:Commit**

```bash
git add scripts/spike-daemon-transport.mjs docs/plans/2026-09-30-daemon-plan.md
git commit -m "test(daemon): transport wiring 与会话语义 spike 探针(R1/R3)"
```

---

### Task 2: GodotServer transport 参数化 + 启动序共享段抽取

**Files:**
- Modify: `src/GodotServer.ts:543-560` 附近(`run()` 内 transport 构造段)
- Modify: `src/GodotServer.ts:90-130` 附近(`ServerOptions` 接口加 2 字段)
- Modify: `src/index.ts:25-80`(抽 `runStartupSequence`)、`src/index.ts:160-200`(stdio 入口接回去)
- Test: `test/web-gui/daemon-core.test.ts`(新建,本任务先放 transport 参数化用例)

**Interfaces:**
- Produces(API 后续任务依赖,签名固定):
  - `ServerOptions` 新增:`mode?: 'stdio' | 'daemon'`(缺省 `'stdio'`)、`mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void`
  - `GodotServer.connectTransport(transport: Transport): Promise<void>`——从 `run()` 拆出;`run()` 保持原签名原行为(stdio 路径内部调 `connectTransport(new StdioServerTransport())`)
  - `src/index.ts` 新导出:`runStartupSequence(opts: { dashboard: boolean; selfUpdate: boolean }): Promise<void>`——含 env 安全门(H-08)+ `applyUserSettingsAtStartup()` + C-08 白名单提示 + 审计关闭告警;不含 Dashboard TUI / self-update / stdin 钩子 / `server.run()`(这些留在 stdio 入口,daemon 入口按 opts 裁剪)

- [ ] **Step 1:写失败测试——connectTransport 注入点与 run() stdio 回归**

```ts
// test/web-gui/daemon-core.test.ts(节选;transport 参数化部分)
import { describe, it, expect, vi } from 'vitest';
import { GodotServer } from '../../src/GodotServer.js';

describe('GodotServer transport 参数化(daemon 批 A)', () => {
  it('connectTransport 接受外部 transport 并 connect', async () => {
    const server = new GodotServer('res://ops.gd', { mode: 'daemon' });
    const fake = { start: vi.fn(), send: vi.fn(), close: vi.fn() };
    await server.connectTransport(fake as unknown as Transport);
    expect(fake.start).toHaveBeenCalledOnce();
    // connectTransport 不碰 process.stdin(daemon 纪律:不注册 stdin-end 钩子)
    // (stdin 监听器计数在调用前后不变——daemon/stdio 差异在入口层,见 Task 5)
  });
  it('mode 缺省 stdio:ServerOptions 向后兼容(不传 mode 不抛)', () => {
    expect(() => new GodotServer('res://ops.gd', {})).not.toThrow();
  });
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run test/web-gui/daemon-core.test.ts`
Expected: FAIL(`connectTransport is not a function`)。

- [ ] **Step 3:实现——GodotServer 拆 connectTransport + options 加字段**

```ts
// src/GodotServer.ts — ServerOptions 加(现有 readOnly? 同区块):
  /** daemon 批(2026-09-30 spec §3.3):进程模式。stdio=缺省,行为与历史完全一致;
   *  daemon=由 src/daemon/main.ts 组装(HTTP transport + mcpHandler 透传 + 不注册 stdin 钩子)。 */
  mode?: 'stdio' | 'daemon';
  /** daemon 模式:/mcp HTTP 处理器,经 run() 构造 WebGuiServer 时透传挂载(§3.2 注入链)。
   *  web-gui 不 import MCP SDK——本字段类型只用 node:http,组装在 src/daemon/mcp-endpoint.ts。 */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void;

// run() 内(原 :543-544 两行)改为:
  async connectTransport(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }
// run() 原位:
  await this.connectTransport(new StdioServerTransport());
```

- [ ] **Step 4:抽 runStartupSequence(index.ts)**

把 `startMcpServer` 开头的 env 安全门 + `applyUserSettingsAtStartup()` + C-08 提示 + 审计关闭告警四段整体搬入新导出函数 `runStartupSequence(opts)`;`startMcpServer` 调 `runStartupSequence({ dashboard: true, selfUpdate: true })` 后接原样剩余逻辑(Dashboard TUI 拉起、self-update、stdin 钩子、`server.run()`)。**stdio 行为零变化**——`test/` 下 index 相关既有测试全绿即回归证明。

- [ ] **Step 5:跑测试 + lint**

Run: `npx vitest run test/web-gui/daemon-core.test.ts && npm run lint`
Expected: PASS + 0 problems。

- [ ] **Step 6:Commit**

```bash
git add src/GodotServer.ts src/index.ts test/web-gui/daemon-core.test.ts
git commit -m "feat(daemon): GodotServer transport 参数化 + 启动序共享段抽取"
```

---

### Task 3: WebGuiServer strictPort + instanceKind(registry kind 字段)+ mcpHandler 路由骨架

**Files:**
- Modify: `src/web-gui/server.ts:45-84`(`WebGuiServerOptions` 加 3 字段)
- Modify: `src/web-gui/server.ts:194-214`(`start()` 顺延循环 + 登记调用)
- Modify: `src/web-gui/registry.ts:17-27`(`WebGuiRegistration` 加 kind)+ `writeRegistration` 无需改签名(entry 类型自带)
- Test: `test/web-gui/daemon-core.test.ts`(追加)、`test/web-gui/registry.test.ts`(追加 kind 用例)

**Interfaces:**
- Produces:
  - `WebGuiServerOptions` 新增:`strictPort?: boolean`(true = 只试 `portStart` 一个端口,EADDRINUSE 直接 reject,不吃 20 次顺延——spec M-2)、`instanceKind?: 'stdio' | 'daemon'`(缺省 `'stdio'`,登记时写入 `kind`)、`mcpHandler?: (req, res) => void`(POST/GET/DELETE `/mcp` 三方法路由到它;缺席不挂该路由;**web-gui 对 handler 内部零假设**)
  - `WebGuiRegistration.kind?: 'stdio' | 'daemon'`(向后兼容:旧文件无字段,`parseRegistrationFile` 不校验——对齐 version 字段先例)

- [ ] **Step 1:写失败测试**

```ts
// test/web-gui/daemon-core.test.ts(追加节选)
describe('WebGuiServer strictPort / instanceKind / mcpHandler(批 A)', () => {
  it('strictPort:端口被占时 start() 直接 reject(不静默顺延)', async () => {
    const holder = createServer(); await new Promise<void>(r => holder.listen(19551, '127.0.0.1', r));
    const gui = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>',
      portStart: 19551, strictPort: true, token: 'x'.repeat(43) });
    await expect(gui.start()).rejects.toThrow(/EADDRINUSE/);
    holder.close();
  });
  it('非 strictPort:行为不变(顺延到下一端口)', /* 用 portStart=19561 起 two 实例断言 second.port===19562 */);
  it('mcpHandler 注入:POST /mcp 路由到 handler;未注入时 /mcp 404', async () => {
    // 起 gui(注入 fake handler 返回 200 'ok'),fetch POST /mcp → 200 'ok';
    // 另起未注入的 gui,fetch POST /mcp → 404
  });
  it('instanceKind:"daemon" 登记进 registry kind 字段;缺省不写 kind(旧实例语义)', /* registryDir 注入临时目录,读回登记文件断言 */);
});
```

- [ ] **Step 2:跑测试确认失败**(strictPort 选项不存在 → TS 报错/测试 FAIL)。

- [ ] **Step 3:实现**

```ts
// src/web-gui/server.ts — options 加:
  strictPort?: boolean;     // spec M-2:respawn 交接的端口不漂移不变式
  instanceKind?: 'stdio' | 'daemon';
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void;

// start() 内顺延循环改造:
    const attempts = this.opts.strictPort ? 1 : PORT_ATTEMPTS;
    for (let i = 0; i < attempts; i++) { /* 原 body 不变 */ }
// 登记行(:214)加 kind:
    await writeRegistration({ pid: process.pid, port: this.portValue, token: this.token,
      startedAt: this.startedAtIso, version: PKG_VERSION, kind: this.opts.instanceKind }, regOpts);
// 路由分发处(现有 /api/ 路由判定旁)加:
    if (url.pathname === '/mcp' && ['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      if (this.opts.mcpHandler) return this.opts.mcpHandler(req, res);
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'mcp endpoint not active' }));
    }
// registry.ts — WebGuiRegistration 加:
  /** daemon 批(spec §3.4):实例类型。可选——旧登记无此字段,前端按"早期实例"语义兼容。 */
  kind?: 'stdio' | 'daemon';
```

- [ ] **Step 4:跑测试 + lint + Commit**

Run: `npx vitest run test/web-gui/daemon-core.test.ts test/web-gui/registry.test.ts && npm run lint`

```bash
git add src/web-gui/server.ts src/web-gui/registry.ts test/web-gui/daemon-core.test.ts test/web-gui/registry.test.ts
git commit -m "feat(daemon): WebGuiServer strictPort/instanceKind/mcpHandler 注入 + registry kind 字段"
```

---

### Task 4: src/daemon/mcp-endpoint.ts——/mcp 端点组装(transport + wiring + 鉴权 + Host 校验)

**Files:**
- Create: `src/daemon/mcp-endpoint.ts`
- Test: `test/web-gui/daemon-mcp-endpoint.test.ts`

**Interfaces:**
- Consumes: Task 2 `GodotServer.connectTransport(transport)`、Task 3 `mcpHandler` 注入、spike S-1/S-2 wiring 结论。
- Produces:
  - `createMcpEndpoint(deps: { mcpServer: McpServer; token: string; port: number }): { handler(req, res): Promise<void>; activeSessionCount(): number; transport: WebStandardStreamableHTTPServerTransport }`
  - handler 即 `WebGuiServerOptions.mcpHandler` 的实现(单会话拦截在批 C Task 11 加,本任务 handler 全量放行——**但鉴权/Host 闸门本任务就要**)

- [ ] **Step 1:写失败测试(鉴权与 Host 闸门优先,wiring 用注入的 fake transport)**

```ts
// test/web-gui/daemon-mcp-endpoint.test.ts(节选)
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createMcpEndpoint } from '../../src/daemon/mcp-endpoint.js';

const TOKEN = 'a'.repeat(43);
// fake transport:handleRequest 收 Web Request 回固定 Web Response(绕开 SDK,单测 wiring/鉴权;
// 真 transport 的端到端在 Task 1 spike 脚本 + 批 C 真机验收覆盖)
function makeFakeEndpoint() {
  return createMcpEndpoint({
    mcpServer: { connect: async () => {} } as never,   // 不真连
    token: TOKEN, port: 19661,
    _transportForTest: { handleRequest: async () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }) } as never,
  });
}
describe('/mcp 鉴权闸门(spec §3.5)', () => {
  it('无 Authorization → 401,响应不含 token 值', async () => { /* fetch POST /mcp 裸打 → 401;body 无 TOKEN */ });
  it('Authorization: Bearer <token> → 放行到 transport', async () => { /* → 200 {"ok":1} */ });
  it('query ?token=... 与 cookie 均不放行(仅认 header)', async () => { /* 两条各断言 401 */ });
  it('Host 非 127.0.0.1/localhost → 403(rebinding 闸)', async () => { /* fetch 带 Host: evil.example → 403 */ });
});
```

- [ ] **Step 2:跑测试确认失败**(模块不存在)。

- [ ] **Step 3:实现(wiring 代码即 spike 验证过的同款)**

```ts
// src/daemon/mcp-endpoint.ts — /mcp 端点组装(spec §3.2/§3.5)
// 分层:本文件是 daemon 组合层(web-gui 不 import MCP SDK 的约定由此兑现——
// WebGuiServer 只见 (req,res)=>void)。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';   // 导入路径按 spike S-1 实测
import { validateHostHeader, localhostAllowedHostnames } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

export interface McpEndpointDeps {
  mcpServer: McpServer;
  token: string;
  port: number;
  /** 测试注入假 transport;缺省构造真 stateful transport。 */
  _transportForTest?: WebStandardStreamableHTTPServerTransport;
}

export function createMcpEndpoint(deps: McpEndpointDeps) {
  const transport = deps._transportForTest ?? new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),           // stateful(spec §3.6 单会话的判定基础)
    // allowedHosts/enableDnsRebindingProtection 不用——@deprecated,Host 校验走本文件中间件
  });
  let activeSessions = 0;                              // onsessioninitialized/closed 维护(批 C 拦截用)
  // 注:回调挂接需 transport 构造选项,真 transport 在构造处直接带上:
  //   onsessioninitialized: () => { activeSessions++; },
  //   onsessionclosed:     () => { activeSessions--; },

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 闸门 1:Host(rebinding)——仅认本机回环 host
    const hostCheck = validateHostHeader(req.headers.host ?? null, localhostAllowedHostnames());
    if (!hostCheck.valid) { res.writeHead(403).end(JSON.stringify({ error: 'host not allowed' })); return; }
    // 闸门 2:鉴权——仅 Authorization: Bearer <token>(§3.5:query/cookie 一并拒,不复用 extractToken)
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${deps.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
         .end(JSON.stringify({ error: 'unauthorized: /mcp requires Authorization: Bearer <token>' }));  // 不回 token 值
      return;
    }
    // wiring:Node ↔ Web(spike S-1 同款)
    const url = `http://127.0.0.1:${deps.port}${req.url}`;
    const method = req.method ?? 'GET';
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const webReq = new Request(url, { method, headers: req.headers as HeadersInit,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    const webRes = await transport.handleRequest(webReq);
    const headers: Record<string, string> = {};
    webRes.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(webRes.status, headers);
    if (!webRes.body) { res.end(); return; }
    Readable.fromWeb(webRes.body).pipe(res);           // SSE 长流同路径
  }

  return { handler, transport,
    activeSessionCount: () => activeSessions,
    async connect() { await deps.mcpServer.connect(transport); } };
}
```

- [ ] **Step 4:跑测试 + lint + Commit**

Run: `npx vitest run test/web-gui/daemon-mcp-endpoint.test.ts && npm run lint`

```bash
git add src/daemon/mcp-endpoint.ts test/web-gui/daemon-mcp-endpoint.test.ts
git commit -m "feat(daemon): /mcp 端点组装——stateful transport + Node/Web wiring + 双闸门"
```

---

### Task 5: src/daemon/main.ts——daemon 进程入口

**Files:**
- Create: `src/daemon/main.ts`
- Modify: `src/web-gui/registry.ts`(追加 `removeRegistrationVerified`)
- Test: `test/web-gui/daemon-main.test.ts`、`test/web-gui/registry.test.ts`(追加)

**Interfaces:**
- Consumes: Task 2 `runStartupSequence`/`connectTransport`/`ServerOptions.mode|mcpHandler`;Task 3 `WebGuiServerOptions.strictPort|instanceKind|mcpHandler`;Task 4 `createMcpEndpoint`;registry `getOrCreateSharedToken`/`writeRegistration`/`listRegistrations`。
- Produces:
  - `runDaemon(args: string[]): Promise<void>`——进程入口(`node build/daemon/main.js [--port N] [--respawn-of <pid>]`);导出供测试注入。
  - `removeRegistrationVerified(pid: number, expectedStartedAt: string, opts?: RegistryOpts): Promise<boolean>`(registry.ts)——删登记前校验文件内容 pid+startedAt 与期望一致(spec m-7,PID 复用防误删),不匹配返回 false 不删。

- [ ] **Step 1:写失败测试(入口决策逻辑,不真起进程)**

```ts
// test/web-gui/daemon-main.test.ts(节选——纯逻辑用例;全链路起进程留批 C 真机)
describe('daemon 入口(批 A)', () => {
  it('GODOT_MCP_WEB_GUI=0 时拒绝启动(面板必起,spec §3.3)', async () => {
    // stubEnv 后调 runDaemon([]) → 抛错信息含"daemon 模式依赖面板端口"
  });
  it('--respawn-of <pid> 豁免单例检测:registry 有旧活 daemon 也放行(spec §3.4)', async () => {
    // registryDir 注入含假旧登记(活 pid 用本测试进程 pid)→ runDaemon 不因单例拒绝
  });
  it('无 --respawn-of 且 registry 有活 daemon → 拒绝(入口层单例检测)', /* 断言拒绝信息含已有实例 pid */);
  it('removeRegistrationVerified:startedAt 不匹配时不删(返回 false,文件仍在)', /* registry.test.ts */);
});
```

- [ ] **Step 2:实现入口**

```ts
// src/daemon/main.ts — daemon 进程入口(spec §3.1/§3.3/§3.10)
// 与 CLI 壳(src/cli/daemon.ts,批 B)的分工:壳薄(参数组装+spawn+轮询),本文件厚(进程内组装)。
import { runStartupSequence } from '../index.js';
import { GodotServer } from '../GodotServer.js';
import { WebGuiServer } from '../web-gui/server.js';
import { createMcpEndpoint } from './mcp-endpoint.js';
import { getOrCreateSharedToken, listRegistrations } from '../web-gui/registry.js';
import { isPidAlive } from '../web-gui/registry.js';   // 若 registry 未导出,就地实现 process.kill(pid,0) 同款(以现有导出为准)

export async function runDaemon(args: string[]): Promise<void> {
  const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined;
  const respawnOf = args.includes('--respawn-of') ? Number(args[args.indexOf('--respawn-of') + 1]) : undefined;

  if (process.env.GODOT_MCP_WEB_GUI === '0') {
    throw new Error('daemon 模式依赖面板端口(实例管理失明),不支持 GODOT_MCP_WEB_GUI=0;请去掉该 env');
  }
  await runStartupSequence({ dashboard: false, selfUpdate: false });   // §3.3 裁剪:无 TUI/无 self-update/无 stdin 钩子

  // 入口层单例检测(spec §3.4 双层之②;CLI 壳是①)——respawn 豁免
  if (respawnOf === undefined) {
    const alive = (await listRegistrations()).filter(r => r.kind === 'daemon' && isPidAlive(r.pid));
    if (alive.length > 0) throw new Error(`daemon already running: pid=${alive[0]!.pid} port=${alive[0]!.port}`);
  }

  const token = getOrCreateSharedToken();
  const server = new GodotServer('res://ops.gd', { mode: 'daemon' });
  // /mcp 端点:端口在 WebGuiServer listen 后才知(strictPort 指定下 = portArg),
  // 故 endpoint 构造放 WebGuiServer.start() 之后、GodotServer.run() 之前由入口胶水完成。
  const gui = new WebGuiServer({
    getSessions: () => [],                             // 占位说明:实际接 server 的 processState,见下方胶水段
    getIndexHtml: () => '',                            // 同上——这两行在实现时按 GodotServer.ts:577 现有注入块原样复制
    strictPort: portArg !== undefined,
    portStart: portArg,
    instanceKind: 'daemon',
    /* mcpHandler 在 endpoint 构造后补挂(gui.setMcpHandler 不存在——WebGuiServer 构造期注入;
       实现方式:endpoint 先以 port=portArg 构造(strictPort 保证一致),再随其余注入一起 new WebGuiServer) */
  });
  // …… 完整注入块(getSessions/stopSession/projects/settings/onSelfRestart 等)从
  // GodotServer.ts:577-655 现有 WebGuiServer 构造处原样复制——mode='daemon' 时该构造
  // 移交本入口(实现取舍:把 GodotServer 内的构造段抽为共享工厂函数 buildWebGuiOptions(server),
  // stdio 的 run() 与本入口共用,避免复制十余注入点——spec N-3 同款透传原则)。
  await gui.start();
  const endpoint = createMcpEndpoint({ mcpServer: server.server, token, port: gui['portValue'] });
  await endpoint.connect();
  // 注册退出链:SIGINT/SIGTERM(POSIX)+ exit 钩子 → gui.stop()(清登记)+ server.close()
  // Windows 跨进程停止不走信号(走 /api/shutdown,批 B)——spec B-3。
}
process.argv[1]?.endsWith('daemon/main.js') && runDaemon(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
```

> **实现说明(非占位)**:上例 `getSessions/getIndexHtml` 两行标注的"复制注入块"是明确的机械动作——`src/GodotServer.ts:577-655` 现有 `new WebGuiServer({...})` 的十余个注入点整体抽为 `buildWebGuiOptions(server: GodotServer, overrides)` 工厂(放 GodotServer.ts 导出),`run()` 与 `runDaemon()` 共用。这是 spec N-3 透传原则的落地,Task 5 的核心重构点,测试以"`run()` 构造的 WebGuiServer 注入面与重构前等价"断言(既有 server-http 测试即守护)。

- [ ] **Step 3:registry 加 removeRegistrationVerified(m-7)**

```ts
// src/web-gui/registry.ts 追加:
/** daemon 批(spec m-7):校验内容后删登记——PID 复用场景下防误删他人登记。
 *  文件不存在/解析失败 → false(视为已清);pid 或 startedAt 不匹配 → false 且不删。 */
export async function removeRegistrationVerified(pid: number, expectedStartedAt: string, opts: RegistryOpts = {}): Promise<boolean> {
  const dir = opts.dir ?? webGuiRegistryDir();
  const parsed = await parseRegistrationFile(dir, `${pid}.json`);
  if (!parsed) return false;
  if (parsed.pid !== pid || parsed.startedAt !== expectedStartedAt) return false;
  await removeRegistration(pid, opts);
  return true;
}
```

- [ ] **Step 4:跑测试 + lint + Commit**

Run: `npx vitest run test/web-gui/ && npm run lint`

```bash
git add src/daemon/main.ts src/web-gui/registry.ts src/GodotServer.ts test/web-gui/
git commit -m "feat(daemon): 进程入口——启动序裁剪/单例检测+respawn 豁免/受控登记清理"
```

---

### Task 6: 批 A 收尾——全绿门禁 + 手动冒烟 + code-reviewer 审查

- [ ] **Step 1:全绿门禁**:`npm run lint && npm run build && npm test`——零错误全绿才继续。
- [ ] **Step 2:手动冒烟(不进 CI)**:`node build/daemon/main.js` → 手动开面板 URL 确认常驻;`npx @modelcontextprotocol/inspector` 连 `http://127.0.0.1:<port>/mcp`(带 Authorization header)完成 initialize/tools list;Ctrl+C(POSIX 语义在 Git Bash 下经 winpty)或直接杀进程后确认 registry 惰性清。
- [ ] **Step 3:派 code-reviewer 子代理审查批 A 全部 commit**(隔离视角,声明实测;审查文档 `docs/reviews/2026-09-30-daemon-core.md`,格式对齐实例管理批先例)。
- [ ] **Step 4:处置审查意见 → commit → 合回 `feat/web-gui-instance-management` → memory 登记批 A 决策与教训。**

---

# 批 B:`feat/daemon-lifecycle`——CLI 生命周期 + 受控交接

### Task 7: /api/shutdown 端点(受控关停/重启指令通道)

**Files:**
- Modify: `src/web-gui/server.ts`(路由表加 `/api/shutdown`;`WebGuiServerOptions` 加 `onControlledShutdown?: (mode: 'stop' | 'restart') => void`)
- Test: `test/web-gui/server-http.test.ts`(追加用例 + **CSP 锚不变**——本任务不改 INDEX_HTML,锚值零变动,若测试红先查是否误触内联脚本)

**Interfaces:**
- Produces:
  - `POST /api/shutdown`(query `?restart=1` → mode `'restart'`,缺省 `'stop'`)——鉴权走现有 `authorized()`(token+Origin 同端口/无 Origin 放行,spec M-1 T2 通道);`onControlledShutdown` 未注入 → 503;已注入 → **先 200 响应再异步调回调**(对齐 onSelfRestart 时序先例)
  - 审计:落机器级 `web-gui:instances`,caller 维度 `'panel'`(面板触发)/`'daemon-cli'`(无 Origin 的 CLI 触发,按 `req.headers.origin === undefined` 判)

- [ ] **Step 1:写失败测试**——`POST /api/shutdown` ①无 token 401 ②有 token 无 Origin(CLI 形态)→ 200 且回调收到 mode='stop' ③`?restart=1` → mode='restart' ④跨端口 Origin → 403(M-1 语义)⑤未注入回调 → 503 ⑥审计行落盘(caller=daemon-cli)。
- [ ] **Step 2:实现**(路由分发 + 注入字段,模式抄 `/api/instances/restart` 现有端点的鉴权/审计/响应时序)。
- [ ] **Step 3:跑测试 + lint + Commit**

```bash
git checkout -b feat/daemon-lifecycle   # 自 feat/daemon-core 合并后的 feat/web-gui-instance-management
git add ... && git commit -m "feat(daemon): /api/shutdown 受控关停/重启端点(T1/T2 通道)"
```

---

### Task 8: src/cli/daemon.ts——CLI 四命令 + router 挂载

**Files:**
- Create: `src/cli/daemon.ts`
- Modify: `src/cli/router.ts`(case 'daemon')
- Modify: `test/p2-exit-path-repair.test.ts`(exit code 注册表登记)
- Test: `test/daemon-cli.test.ts`(test/ 根,对齐 cli 测试惯例)

**Interfaces:**
- Consumes: Task 7 `/api/shutdown`;registry `listRegistrations`;`killPidTree`(经 GodotServer 的 processState 同源实现——CLI 直接 import `src/core/process-state.js` 现有导出,以 grep 实测为准)。
- Produces:
  - `runDaemonCli(args: string[]): Promise<void>`——子命令:
    - `start [--open]`:双层单例检测(CLI 侧①)→ detached spawn `node build/daemon/main.js`(stdio:stdin ignore + stdout/stderr → `~/.godot-mcp/logs/daemon-<timestamp>.log` 文件 fd;`detached:true` + `unref`)→ 轮询 registry 新登记(pid 变化 + kind=daemon)就绪 → 打印面板 URL + `/mcp` URL + token 获取方式(`daemon status --show-token`);`--open` 调 `openWebDashboard` 同款跨平台 opener
    - `stop [--force]`:registry 找活 daemon → `POST /api/shutdown`(带共享 token,5s 超时)→ 超时或 `--force` → `killPidTree`
    - `status [--show-token]`:列 registry 清单(kind/端口/pid/存活/交接中),exit 0=有活 daemon
    - `restart`:活 daemon → `POST /api/shutdown?restart=1`(T2);死 → 等价 start
  - exit code 语义:0=成功/有活 daemon,1=操作失败,2=用法错误(登记进 p2-exit-path-repair 注册表)

- [ ] **Step 1:写失败测试**(spawn 用注入的 fakeSpawner,不发真进程):start 单例拒绝/spawn 参数(--port/--respawn-of 透传/detached/unref/stdin ignore)/就绪轮询按 registry 登记(非 /api/health)/stop 走 shutdown 端点超时兜底 killPidTree/status exit code。
- [ ] **Step 2:实现**(CLI 壳薄层,所有重活在注入依赖上)。
- [ ] **Step 3:跑测试 + lint + p2-exit-path-repair + Commit**(`feat(daemon): CLI daemon start/stop/status/restart`)。

---

### Task 9: src/daemon/controlled-restart.ts——受控交接序列(§3.7 全序列)

**Files:**
- Create: `src/daemon/controlled-restart.ts`
- Modify: `src/daemon/main.ts`(入口单例检测接 `--respawn-of` 关联"交接中"标记;`onControlledShutdown` 注入 restart 分支)
- Test: `test/web-gui/daemon-restart.test.ts`

**Interfaces:**
- Consumes: Task 3 `strictPort`;Task 5 `removeRegistrationVerified`;Task 7 `onControlledShutdown('restart')`;registry `listRegistrations`/`writeRegistration`。
- Produces:
  - `controlledRestart(deps: { gui: WebGuiServer; server: GodotServer; spawnDaemon(args: string[]): ChildProcess; killTree(pid: number): void; registryDir?: string }): Promise<void>`——§3.7 四步:
    1. `await gui.closeListener()`(WebGuiServer 需加此方法:只 `httpServer.close()` 不清登记不置 inactive——Task 3 顺带加,或本任务加,接口 `closeListener(): Promise<void>`)
    2. `spawnDaemon(['--port', String(oldPort), '--respawn-of', String(oldPid)])`
    3. 轮询 registry(限时可注入):新登记出现且 `port === oldPort` 且 `kind === 'daemon'` → `removeRegistrationVerified(oldPid, ownStartedAt)` → `server.close()` 有序链 → `process.exit(0)`
    4. 任一步失败:先 `killTree(newPid)` → 轮询新登记消失 → `await gui.relisten()`(closeListener 的逆操作)→ 向调用方报告失败(**不留双活**)
  - 前端"交接中"标注的数据源:交接窗口内旧登记仍在 + 新登记带 `--respawn-of` 派生的关联(登记内容加 `respawnOf?: number` 可选字段——registry 类型顺带扩,向后兼容)

- [ ] **Step 1:写失败测试**——四条主干用例(每条注入 fake gui/spawn/registry):①成功交接(spawn 收到 --port+--respawn-of;旧登记被 verified 删除;exit(0) 被调)②新实例报到但端口不符 → 回滚(杀新 + 等登记消失 + relisten,不 exit)③新实例未报到超时 → 回滚同上 ④removeRegistrationVerified 返回 false(PID 复用)→ **不删他文件但继续自身退出路径**(自身登记已被清理者处理,如实记录)。
- [ ] **Step 2:实现序列**(严格按上面 Produces 的四步与回滚,不变式注释置顶)。
- [ ] **Step 3:跑测试 + lint + Commit**(`feat(daemon): 受控交接——端口不漂移+无双活+失败回滚`)。

---

### Task 10: 批 B 收尾——全绿 + 真机交接验证 + code-reviewer 审查

- [ ] **Step 1:全绿门禁**:`npm run lint && npm run build && npm test`。
- [ ] **Step 2:真机交接验证(开发机 Windows)**:`daemon start` → `daemon restart`(T2)→ 断言:面板 URL 端口不变、旧登记消失新登记在场、`tasklist` 无双 daemon 进程;再测 T1(daemon 自身面板点重启)同断言;失败注入(手动占住端口后 restart)→ 观察回滚与失败详情。记录进审查文档。
- [ ] **Step 3:code-reviewer 审查批 B**(`docs/reviews/2026-09-30-daemon-lifecycle.md`)→ 处置 → commit → 合回 → memory 登记。**

---

# 批 C:`feat/daemon-frontend-accept`——单会话 + 前端 + 文档 + 终验收

### Task 11: 单会话独占(409 拒绝第二 Initialize)

**Files:**
- Modify: `src/daemon/mcp-endpoint.ts`(Task 4 预留的 `activeSessions` 计数接线 + Initialize 拦截中间件)
- Test: `test/web-gui/daemon-mcp-endpoint.test.ts`(追加)

**Interfaces:**
- Produces: handler 闸门 0(在 Host/鉴权之后、transport 之前):POST 且 body 首个 JSON-RPC `method === 'initialize'` 且 `activeSessionCount() > 0` → `409` + `{"error":"mcp endpoint busy: one session at a time (spec §3.6); connect a stdio instance or start another daemon"}`。**body 嗅探的实现约束**:Initialize 拦截需要读 body——读后须重建 Request(body 只能读一次,`webReq.clone()` 后原样传递;或先缓冲 POST body(`await webReq.arrayBuffer()` 再 `new Request(url, {body})`)——采用缓冲方案,简单且 POST body 本就有界(MCP 消息)。

- [ ] **Step 1:写失败测试**:fake transport 计数注入(`activeSessionCount: () => 1`)→ Initialize POST → 409;`activeSessionCount: () => 0` → 放行到 transport;非 Initialize(tools/list)在有活跃会话时**放行**(拦截只针对新会话建立)。
- [ ] **Step 2:实现缓冲嗅探 + 409 闸门。Step 3:跑测试 + lint + Commit**(`feat(daemon): /mcp 单会话独占——第二 Initialize 409`)。

---

### Task 12: html.ts 前端——kind 徽标/占用/交接中/指引 + CSP 第六次重锚

**Files:**
- Modify: `src/web-gui/html.ts`(实例区渲染 `renderInstances` + recoverPanel 不动)
- Modify: `test/web-gui/server-http.test.ts`(**CSP 锚第六次重锚**:锚值 + 独立重算双通道 + 注释链加第六次条目)
- Test: `test/web-gui/daemon-html.test.ts`(或 html 契约既有文件追加)

**Interfaces:**
- Consumes: `GET /api/instances` 透传的 `kind` / `respawnOf` 字段(Task 3/9)。

- [ ] **Step 1:写失败测试(html 契约)**:实例行含 kind 徽标(`daemon`/`stdio`/早期实例三态)、daemon 行含会话占用状态(`/api/stats` 侧新增或以 instances 数据呈现——实现按数据可得性,若无会话数据源则显示 kind 徽标 + 交接态,占用显示降级为 daemon 侧 `/api/instances` 自报字段 `sessionActive`,由 server.ts 从 mcpHandler 端点查询注入);跨实例对 daemon 行的重启按钮 → 指引文案("在 daemon 自身面板或 CLI restart")。
- [ ] **Step 2:实现前端三态 + 指引文案;`server.ts` instances 端点补 `sessionActive` 字段(mcpHandler 持有者才知道,经 WebGuiServerOptions 新增 `isMcpSessionActive?: () => boolean` 注入,daemon main 组装时接 endpoint.activeSessionCount()>0)。**
- [ ] **Step 3:CSP 第六次重锚**(流程对齐实例管理批先例:改 INDEX_HTML 内联脚本 → 重算 sha256 → 更新 `WEB_GUI_CSP` 与测试锚值 → 注释链追加"第六次(daemon 前端批)")。
- [ ] **Step 4:跑测试 + lint + Commit**(`feat(daemon): 面板实例区 daemon 三态/占用/交接中/跨实例指引+CSP 六次重锚`)。

---

### Task 13: 文档 + CHANGELOG

**Files:**
- Modify: `README.md`(daemon 章节:三命令区分 `daemon` vs `web` vs `dashboard --web`、ZCode/Claude Code `type:"http"` 配置片段含 Authorization header、§3.10 配置说明"GUI 设置面板即 daemon 配置界面")
- Modify: `docs/使用指南.md` + `docs/使用指南-ZCode.md`(同主题,ZCode 侧重 config.json 片段)
- Modify: `CHANGELOG.md`(`[Unreleased]` 段,Keep a Changelog 格式)

- [ ] **Step 1:写文档**(配置片段必须含:`{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}`;token 获取 `daemon status --show-token`;诚实边界:R6 daemon 崩溃需手动重拉、单会话约束、localhost 客户端行为以 V3 实测为准)。
- [ ] **Step 2:`npm run check:changelog-sync` 过 → Commit**(`docs(daemon): daemon 使用文档+客户端 http 配置指引`)。

---

### Task 14: 终验收 V1-V8 + 第三方审查 + memory + 批间收尾

- [ ] **Step 1:全绿门禁 + 真机验收走查(spec §5 V1-V8 逐条)**——重点:V3 ZCode 以 `type:"http"` 连 daemon 真机工具调用(R2 的 localhost 未知项,一次定案);V4 受控重启后 ZCode 重连恢复;V5 stop 日志含 close 链完成证据;V8 二次 start 拒绝。截图/输出存证进审查文档。
- [ ] **Step 2:code-reviewer 终审查(整专项三批)**——`docs/reviews/2026-09-30-daemon-final.md`,格式对齐实例管理批(总体判定 + 逐维度 + Blocking/Nits + 教训);重点请审查者核:不变式 1/2 的实现与测试守护、/mcp 鉴权旁路面、交接竞态窗口、§3.10 env 契约完整性。
- [ ] **Step 3:处置 → commit → 三批合回 `feat/web-gui-instance-management` → memory 登记(feature-decision-log:commit 清单/关键决策/deferred 诚实标注)+ Obsidian 开发日志收口 + 项目待办回标。**

---

## Self-Review 记录(2026-09-30,writing-plans 清单)

1. **Spec 覆盖对照**:spec §3.1(进程模型/stop HTTP 主路)→ Task 5/7/8;§3.2(单端口双路由+mcpHandler 透传)→ Task 3/4;§3.3(transport 参数化/面板必起/启动序裁剪/stdin 钩子)→ Task 2/5;§3.4(kind/双层单例/respawn 豁免/跨实例强杀语义)→ Task 3/5/8(html 指引文案 Task 12);§3.5(双闸门+Host 中间件)→ Task 4;§3.6(单会话 409)→ Task 11;§3.7(受控交接四步+回滚+不变式)→ Task 9;§3.8(CLI 四命令/URL 打印/exit code)→ Task 8;§3.9(日志文件/审计 caller)→ Task 5/7/8;§3.10(env 契约/首启预检)→ Task 5(启动序重放)+ Task 13(文档)——**首启预检提示的具体实现落 Task 5 的 runStartupSequence 之后**(settings.json 与 env 均无配置 → CLI 输出提示;面板提示在 Task 12 的 hello 数据带未配置旗标,Task 12 实现时一并)。§4 改动面 10 行全部有任务承接;§5 V1-V8 在 Task 14 逐条走查。**无缺口。**
2. **占位符扫描**:Task 5 的"注入块复制"不是 TBD——已给明确机械动作(抽 `buildWebGuiOptions` 工厂 + 等价性断言);Task 4/Task 1 的 SDK 导入路径标注"以 spike 实测为准"是**验证步骤**而非占位(代码块完整可跑)。无 TBD/TODO/"适当处理"字样。
3. **类型一致性**:`connectTransport(transport: Transport)`(Task 2 产/Task 4 消费)、`mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void`(Task 2 options/Task 3 透传/Task 4 实现——三处签名一致)、`strictPort`/`instanceKind`(Task 3 产/Task 5/9 消费)、`removeRegistrationVerified(pid, expectedStartedAt)`(Task 5 产/Task 9 消费)、`onControlledShutdown(mode)`(Task 7 产/Task 9 消费)、`createMcpEndpoint` 返回的 `handler`/`activeSessionCount`(Task 4 产/Task 11/12 消费)——核对一致。
