// scripts/spike-daemon-transport.mjs — daemon 专项 R1/R3 spike(spec §6)
// 验证三件事(S-1/S-2/S-3,结论回填 docs/plans/2026-09-30-daemon-plan.md):
//   S-1 Node IncomingMessage/ServerResponse ↔ Web Request/Response 双向转换(含 POST body 与 SSE 流)
//   S-2 stateful 会话语义(mcp-session-id 响应头 / 400 / onsessioninitialized|closed 时序)
//   S-3 MCP streamable HTTP 端到端往返(initialize → tools/list → tools/call → DELETE 终止)
// 用法:node scripts/spike-daemon-transport.mjs   (自跑自验,退出码 0=全部通过)
//
// ⚠️ 与 task-1-brief 脚本的实测差异(依据 node_modules 实测,详见 task-1-report.md):
//   1. @modelcontextprotocol/server@2.0.0 的 exports 无 '/mcp.js' '/streamablehttp.js' 子路径
//      → McpServer / WebStandardStreamableHTTPServerTransport / LATEST_PROTOCOL_VERSION 全部从主入口导入。
//   2. registerTool 是 McpServer 实例方法(非独立导出函数),brief 的 `import { registerTool }` 删除。
//   3. 本仓未安装 @modelcontextprotocol/client(node_modules 无此包、package.json 亦未声明)
//      → S-3 降级为原生 fetch 手写 JSON-RPC 往返(含 SSE 响应解析),等价覆盖同一条 Node↔Web↔transport 链路。

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { McpServer, WebStandardStreamableHTTPServerTransport, LATEST_PROTOCOL_VERSION }
  from '@modelcontextprotocol/server';
import { z } from 'zod';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const PORT = 9871;
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

// ── S-1/S-2:server 侧 ─────────────────────────────────────────────
const mcp = new McpServer({ name: 'spike', version: '0.0.0' });
mcp.registerTool('spike_echo',
  { description: 'echo', inputSchema: z.object({ v: z.string() }) },
  async ({ v }) => ({ content: [{ type: 'text', text: 'echo:' + v }] }));

const sessionEvents = { init: 0, closed: 0 };
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),               // stateful 模式
  onsessioninitialized: () => { sessionEvents.init++; },
  onsessionclosed: () => { sessionEvents.closed++; },
});
await mcp.connect(transport);

// Node ↔ Web 转换(daemon/mcp-endpoint.ts Task 4 的同款逻辑,此处先行验证)
async function nodeReqToWebRequest(req) {
  const url = `http://127.0.0.1:${PORT}${req.url}`;
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${PORT}`;                   // 固定 Host(rebinding 闸在 endpoint 层另做)
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

const httpServer = createServer(async (req, res) => {
  try {
    const webReq = await nodeReqToWebRequest(req);
    const webRes = await transport.handleRequest(webReq);
    await writeWebResponseToNode(webRes, res);
  } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
});

// ── S-3(降级:原生 fetch 手写 JSON-RPC,同进程打自己) ────────────
// 从 POST 响应里读出第一条 JSON-RPC 消息:content-type 兼容 application/json 与
// text/event-stream(SDK 默认 enableJsonResponse=false,POST 响应走 SSE 流)。
// 拿到消息即 abort,释放 SSE 长连接(等价 SDK Client 读到响应后结束该请求流)。
async function readFirstJsonRpc(controller, res) {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const json = await res.json();
    controller.abort();
    return json;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/)) !== null) {    // SSE 事件块以空行分隔
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = block.split(/\r?\n/)
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          const msg = JSON.parse(data);
          controller.abort();
          return msg;
        } catch { /* 半截块,继续攒 */ }
      }
    }
  }
  throw new Error('stream ended before any JSON-RPC message (content-type: ' + ct + ')');
}

await new Promise((r) => httpServer.listen(PORT, '127.0.0.1', r));

let sessionId = '';
let protocolVersion = LATEST_PROTOCOL_VERSION;
try {
  // 1) initialize → 拿 mcp-session-id + 协议版本
  {
    const ctl = new AbortController();
    const res = await fetch(URL_, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'spike-client', version: '0.0.0' },
      } }),
    });
    const sid = res.headers.get('mcp-session-id');
    check('S-2 initialize 响应带 mcp-session-id 头', !!sid, sid ? sid.slice(0, 13) + '…' : 'missing');
    sessionId = sid ?? '';
    protocolVersion = res.headers.get('mcp-protocol-version') ?? LATEST_PROTOCOL_VERSION;
    const msg = await readFirstJsonRpc(ctl, res);       // ← SSE 流经 fromWeb pipe 回来的实证
    check('S-3(降级)initialize 往返', msg?.result?.serverInfo?.name === 'spike',
      `serverInfo=${msg?.result?.serverInfo?.name}, pv=${msg?.result?.protocolVersion}`);
    check('S-1 SSE 流经 fromWeb 回写成功(读到了 JSON-RPC result)', msg?.result !== undefined);
  }
  await new Promise(r => setTimeout(r, 50));
  check('S-2 onsessioninitialized 触发', sessionEvents.init === 1, `init=${sessionEvents.init}`);

  // 2) notifications/initialized(无响应体,预期 202)
  {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    check('S-3(降级)initialized notification 被接受', res.status === 202, `status=${res.status}`);
  }

  // 3) tools/list(带 session 头)
  {
    const ctl = new AbortController();
    const res = await fetch(URL_, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const msg = await readFirstJsonRpc(ctl, res);
    const names = (msg?.result?.tools ?? []).map(t => t.name).join(',');
    check('S-3(降级)tools/list 往返', (msg?.result?.tools ?? []).some(t => t.name === 'spike_echo'), `tools=[${names}]`);
  }

  // 4) tools/call(带参数 POST body,验证 Readable.toWeb body 流无损)
  {
    const ctl = new AbortController();
    const res = await fetch(URL_, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'spike_echo', arguments: { v: 'hi' } } }),
    });
    const msg = await readFirstJsonRpc(ctl, res);
    const text = msg?.result?.content?.[0]?.text;
    check('S-3(降级)tools/call 往返', text === 'echo:hi', `text=${text}`);
    check('S-1 POST body 流(toWeb)无损', text === 'echo:hi', 'tools/call 参数经 body 流完整到达');
  }

  // 5) 无 session 头的非初始化请求 → 400(stateful 语义)
  {
    const raw = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    check('S-2 无 session 非初始化请求 400', raw.status === 400, `status=${raw.status}`);
  }

  // 6) DELETE 终止会话 → onsessionclosed
  {
    const res = await fetch(URL_, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion },
    });
    check('S-3(降级)DELETE 终止会话', res.status === 200, `status=${res.status}`);
  }
  await new Promise(r => setTimeout(r, 200));
  check('S-2 onsessionclosed(DELETE)触发', sessionEvents.closed === 1, `closed=${sessionEvents.closed}`);
} catch (e) {
  check('S-3(降级)链路', false, String(e && e.message));
} finally {
  httpServer.close();
}

const failed = results.filter(r => !r.ok);
console.log(failed.length === 0 ? '\nSPIKE ALL PASS' : `\nSPIKE FAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
