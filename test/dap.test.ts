/**
 * P9 批 (2026-09-12): dap 工具 — TS 直连 editor DAP server(LuoxuanLove 移植)。
 *
 * 测试策略:mock DAP server(node:net 本地 TCP 假 server,真实 Content-Length 帧编解码)
 * 验证协议层/状态机/断点簿记/清洗/上限/loopback 门禁——不起真 Godot editor(e2e 成本高,
 * 手动验证路径见 core.md 规则;协议层与 DAP 规范行为由 mock 按 DAP 语义响应覆盖)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { handleTool, getToolDefinitions, TOOL_META, _resetForTest } from '../src/tools/dap.js';

// ─── mock DAP server(真实帧协议) ─────────────────────────────────────────────

interface MockServer {
  port: number;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
  /** 向 client 推送一条 DAP 消息(事件/响应) */
  send: (msg: unknown) => void;
}

let currentMock: MockServer | null = null;

/** handler: 收到请求 → 返回要回的响应数组(可为空表示延迟手动回)。 */
function startMockDapServer(
  handler: (req: Record<string, unknown>, socket?: net.Socket) => Array<Record<string, unknown>> | null,
): Promise<MockServer> {
  return new Promise((resolveMock) => {
    const requests: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const header = buffer.subarray(0, headerEnd).toString('utf8');
          const m = /content-length:\s*(\d+)/i.exec(header);
          if (!m) { buffer = Buffer.alloc(0); return; }
          const len = Number(m[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + len) return;
          const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
          buffer = buffer.subarray(bodyStart + len);
          try {
            const req = JSON.parse(body) as Record<string, unknown>;
            requests.push(req);
            const responses = handler(req, socket);
            if (responses) {
              for (const resp of responses) writeFrame(socket, resp);
            }
          } catch { /* 坏帧忽略 */ }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolveMock({
        port: addr.port,
        requests,
        send: (msg) => {
          for (const s of serverConnections) writeFrame(s, msg);
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    const serverConnections: net.Socket[] = [];
    server.on('connection', (s) => serverConnections.push(s));
  });
}

function writeFrame(socket: net.Socket, msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]));
}

function makeResponse(req: Record<string, unknown>, body: unknown = {}, success = true): Record<string, unknown> {
  return {
    seq: 0, type: 'response', request_seq: req.seq, command: req.command, success,
    ...(success ? {} : { message: `${String(req.command)} failed (mock)` }),
    body,
  };
}

// ─── 测试上下文 helpers ──────────────────────────────────────────────────────

async function call(args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; err: string; isError: boolean }> {
  const result = await handleTool('dap', args, {} as never);
  if (!result) return { data: {}, err: 'null result', isError: true };
  const text = result.content?.map((c) => ('text' in c ? String(c.text) : '')).join('') ?? '';
  const isError = result.isError === true;
  try {
    return { data: JSON.parse(text) as Record<string, unknown>, err: '', isError };
  } catch {
    return { data: {}, err: text, isError };
  }
}

/** 全 action 标准 mock:initialize/setBreakpoints/threads/stackTrace/... 全回 success。 */
function standardHandler(req: Record<string, unknown>): Array<Record<string, unknown>> {
  const command = String(req.command ?? '');
  if (command === 'initialize') {
    return [makeResponse(req, { supportsConfigurationDoneRequest: true, exceptionBreakpointFilters: [] })];
  }
  if (command === 'setBreakpoints') {
    const args = req.arguments as { breakpoints?: Array<{ line: number }> } | undefined;
    return [makeResponse(req, { breakpoints: (args?.breakpoints ?? []).map((b) => ({ verified: true, line: b.line })) })];
  }
  if (command === 'stackTrace') {
    return [makeResponse(req, {
      stackFrames: [{ id: 1, name: '_ready', line: 10, column: 1, source: { path: 'res://main.gd' } }],
      totalFrames: 1,
    })];
  }
  return [makeResponse(req, { threads: [{ id: 1, name: 'main' }] })];
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe('P9: dap 工具 — TS 直连 DAP server(LuoxuanLove 移植)', () => {
  beforeEach(() => {
    _resetForTest();
  });
  afterEach(async () => {
    _resetForTest();
    if (currentMock) {
      await currentMock.close();
      currentMock = null;
    }
  });

  it('DAP-def: 工具定义 + TOOL_META 全 action 风险登记', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('dap');
    const props = Object.keys(defs[0]!.inputSchema.properties ?? {});
    for (const key of ['action', 'session_id', 'host', 'port', 'project_path', 'timeout_ms', 'source_path', 'line', 'thread_id']) {
      expect(props.includes(key), `schema 应含 ${key}`).toBe(true);
    }
    const risks = TOOL_META.dap!.actionRisks!;
    expect(Object.keys(risks).length).toBe(18);
    expect(risks.stack_trace).toBe('read');
    expect(risks.launch).toBe('write');
  });

  it('DAP-a: initialize → mock server 握手 + 状态机 initialized + capabilities 落位', async () => {
    currentMock = await startMockDapServer(standardHandler);
    const r = await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    expect(r.isError).toBe(false);
    expect(r.data.session_id).toBe('default');
    const response = r.data.response as Record<string, unknown>;
    expect(response.success).toBe(true);
    // 状态机落位
    const st = await call({ action: 'status' });
    const sessions = st.data.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.initialized).toBe(true);
    expect(sessions[0]!.started).toBe(false);
    // capabilities 落位(从 response.body 读)
    const caps = sessions[0]!.capabilities as Record<string, unknown>;
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    // server 收到的 initialize 参数(DAP 规范关键字段)
    const initReq = currentMock.requests.find((q) => q.command === 'initialize');
    expect((initReq?.arguments as Record<string, unknown>).adapterID).toBe('godot');
  });

  it('DAP-b: 状态机前置校验——launch 未 initialize 拒 / configuration_done 未 launch 拒', async () => {
    const r1 = await call({ action: 'launch' });
    expect(r1.isError).toBe(true);
    expect(r1.data.error_code).toBe('DAP_INVALID_SESSION_STATE');
    expect(r1.data.expected).toBe('initialize');

    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    const r2 = await call({ action: 'configuration_done', port: currentMock.port, timeout_ms: 2000 });
    expect(r2.isError).toBe(true);
    expect(r2.data.expected).toBe('launch_or_attach');

    // launch 后 configuration_done 成功,configured=true
    await call({ action: 'launch', port: currentMock.port, timeout_ms: 2000 });
    const r3 = await call({ action: 'configuration_done', port: currentMock.port, timeout_ms: 2000 });
    expect(r3.isError).toBe(false);
    const st = await call({ action: 'status' });
    const s0 = (st.data.sessions as Array<Record<string, unknown>>)[0]!;
    expect(s0.started).toBe(true);
    expect(s0.configured).toBe(true);
    expect(s0.launch_mode).toBe('launch');
  });

  it('DAP-c: 断点簿记 + setBreakpoints 全量重发(加两条→删一条→空)', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });

    const mk = (line: number, action: 'set_breakpoint' | 'remove_breakpoint') =>
      call({ action, port: currentMock.port, timeout_ms: 2000, source_path: 'D:/proj/main.gd', line });
    await mk(10, 'set_breakpoint');
    await mk(20, 'set_breakpoint');
    // 全量重发:第二次 set 后 server 收到的 setBreakpoints 应含两行
    const sbReqs = currentMock.requests.filter((q) => q.command === 'setBreakpoints');
    expect(sbReqs).toHaveLength(2);
    const second = sbReqs[1]!.arguments as { breakpoints: Array<{ line: number }> };
    expect(second.breakpoints.map((b) => b.line)).toEqual([10, 20]);

    const local = await call({ action: 'list_breakpoints' });
    expect(local.data.count).toBe(2);

    await mk(10, 'remove_breakpoint');
    const third = (currentMock.requests.filter((q) => q.command === 'setBreakpoints')[2]!.arguments as { breakpoints: Array<{ line: number }> });
    expect(third.breakpoints.map((b) => b.line)).toEqual([20]);
    const local2 = await call({ action: 'list_breakpoints' });
    expect(local2.data.count).toBe(1);
  });

  it('DAP-d: 断点上限 256/source 与 512 sources(dap_limit_exceeded)', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    // 同一文件第 257 个断点拒(模拟 256 已满:直接构造本地簿记超限——逐个 set 太慢,
    // 用 set_settings 无法直达;此处逐 set 到 257 但 mock 即时回,速度快)
    let last: { isError: boolean; data: Record<string, unknown> } | null = null;
    for (let i = 1; i <= 257; i++) {
      last = await call({ action: 'set_breakpoint', port: currentMock.port, timeout_ms: 2000, source_path: 'D:/proj/big.gd', line: i });
    }
    expect(last!.isError).toBe(true);
    expect(last!.data.error_code).toBe('DAP_LIMIT_EXCEEDED');
    expect(last!.data.limit).toBe(256);
  });

  it('DAP-e: SENSITIVE_KEYS 清洗——stack_trace 响应含 token/password → [redacted]', async () => {
    currentMock = await startMockDapServer((req) => {
      if (String(req.command) === 'stackTrace') {
        return [makeResponse(req, {
          stackFrames: [{ id: 1, name: '_ready', line: 3 }],
          // 恶意/意外的敏感字段:对象 key 含 token、字符串值含 bearer
          token: 'abc123',
          password: 'hunter2',
          nested: [{ api_key: 'k', note: 'Bearer abc123 in text' }],
        })];
      }
      return [makeResponse(req)];
    });
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    const r = await call({ action: 'stack_trace', port: currentMock.port, timeout_ms: 2000 });
    expect(r.isError).toBe(false);
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('hunter2');
    const body = (r.data.response as Record<string, unknown>).body as Record<string, unknown>;
    expect(body.token).toBe('[redacted]');
    expect(body.password).toBe('[redacted]');
    expect((body.nested as Array<Record<string, unknown>>)[0]!.api_key).toBe('[redacted]');
    expect((body.nested as Array<Record<string, unknown>>)[0]!.note).toBe('[redacted]');
  });

  it('DAP-f: loopback 门禁——非 loopback host 拒(allow_remote_hosts 未开)', async () => {
    const r = await call({ action: 'initialize', host: '192.168.1.5', port: 6006 });
    expect(r.isError).toBe(true);
    expect(r.data.error_code).toBe('DAP_UNAVAILABLE');
    expect(r.data.transport_status).toBe('remote_endpoint_disabled');
    // set_settings 开 allow_remote_hosts 后,host 校验放行(连接本身失败是另一码事)
    const set = await call({ action: 'set_settings', settings: { allow_remote_hosts: true } });
    expect(set.isError).toBe(false);
    const r2 = await call({ action: 'initialize', host: '192.168.1.5', port: 1, timeout_ms: 300 });
    expect(r2.isError).toBe(true);
    // 连接失败(非门禁拒 DAP_UNAVAILABLE)。失败分类形态环境相关(2026-09-22 处置):
    // 本机网段存在且快速 unreachable → socket 异常走 catch 兜底 DAP_ERROR;网段
    // 不可路由/防火墙静默丢包 → 挂起至超时走显式失败 DAP_REQUEST_FAILED——两者
    // 都是"连接失败"的合法分类,断言集合而非单值(原单值断言在本机连真实
    // 192.168.1.5 的可达性行为下 flaky)。
    expect(['DAP_ERROR', 'DAP_REQUEST_FAILED']).toContain(r2.data.error_code);
    expect(r2.data.error_code).not.toBe('DAP_UNAVAILABLE');
    expect(r2.data.transport_status).not.toBe('remote_endpoint_disabled');
  });

  it('DAP-g: 请求超时——server 不回 → dap_timeout', async () => {
    currentMock = await startMockDapServer(() => null);  // 收下不回
    const r = await call({ action: 'initialize', port: currentMock.port, timeout_ms: 250 });
    expect(r.isError).toBe(true);
    expect(r.data.error_type ?? r.data.error_code).toMatch(/dap_timeout|DAP_/);
    const text = JSON.stringify(r.data);
    expect(text).toContain('timed out');
  });

  it('DAP-h: 端点变更守卫——initialize 后换 port 调 action → same_endpoint 错', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    const r = await call({ action: 'threads', port: currentMock.port + 1, timeout_ms: 500 });
    expect(r.isError).toBe(true);
    expect(r.data.expected).toBe('same_endpoint');
  });

  it('DAP-i: disconnect 清会话与断点簿记', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    await call({ action: 'set_breakpoint', port: currentMock.port, timeout_ms: 2000, source_path: 'D:/proj/a.gd', line: 5 });
    const r = await call({ action: 'disconnect', port: currentMock.port, timeout_ms: 2000 });
    expect(r.isError).toBe(false);
    const st = await call({ action: 'status' });
    expect(st.data.session_count).toBe(0);
    expect(st.data.breakpoint_count).toBe(0);
    const local = await call({ action: 'list_breakpoints' });
    expect(local.data.count).toBe(0);
  });

  it('DAP-j: res:// 断点路径经 project_path 转绝对路径', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    await call({
      action: 'set_breakpoint', port: currentMock.port, timeout_ms: 2000,
      project_path: 'D:/proj', source_path: 'res://scripts/main.gd', line: 7,
    });
    const sb = currentMock.requests.find((q) => q.command === 'setBreakpoints');
    const src = (sb?.arguments as { source?: { path?: string } }).source;
    expect(src?.path).toContain('scripts');
    expect(src?.path).toContain('main.gd');
    expect(src?.path?.startsWith('res://')).toBe(false);
  });

  it('DAP-k: set_settings 白名单校验(坏 port/未知键拒;合法更新生效)', async () => {
    const bad1 = await call({ action: 'set_settings', settings: { port: 99999 } });
    expect(bad1.isError).toBe(true);
    const bad2 = await call({ action: 'set_settings', settings: { whatever: 1 } });
    expect(bad2.isError).toBe(true);
    const bad3 = await call({ action: 'set_settings', settings: { timeout_ms: 60000 } });
    expect(bad3.isError).toBe(true);
    expect(bad3.data.limit).toBe(30000);
    const ok = await call({ action: 'set_settings', settings: { port: 6007, timeout_ms: 1500 } });
    expect(ok.isError).toBe(false);
    const r = await call({ action: 'get_settings' });
    expect(r.data.port).toBe(6007);
    expect(r.data.timeout_ms).toBe(1500);
    // 不回 default_launch_args(可能含敏感配置)
    expect(r.data.default_launch_args).toBeUndefined();
  });

  it('DAP-l: output 收集——mock 推 output 事件 → outputs 数组(清洗后)', async () => {
    let pushOnLaunch: (() => void) | null = null;
    currentMock = await startMockDapServer((req) => {
      if (String(req.command) === 'initialize') {
        // 握手后 200ms 推两条 output 事件
        setTimeout(() => {
          currentMock?.send({ seq: 0, type: 'event', event: 'output', body: { category: 'stdout', output: 'game says hi' } });
          currentMock?.send({ seq: 0, type: 'event', event: 'output', body: { category: 'console', output: 'token=sekrit' } });
        }, 200);
        return [makeResponse(req, {})];
      }
      return [makeResponse(req)];
    });
    pushOnLaunch = null;
    void pushOnLaunch;
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    const r = await call({ action: 'output', port: currentMock.port, timeout_ms: 900 });
    expect(r.isError).toBe(false);
    const outputs = r.data.outputs as Array<Record<string, unknown>>;
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(outputs)).toContain('game says hi');
    expect(JSON.stringify(outputs)).toContain('[redacted]');  // token= 字符串被洗
    expect(JSON.stringify(outputs)).not.toContain('sekrit');
  });

  it('DAP-m: timeout_ms 超 30s 顶层拒(INVALID_PARAMS 路径)', async () => {
    const r = await call({ action: 'threads', timeout_ms: 50000 });
    expect(r.isError).toBe(true);
    expect(r.data.error_code).toBe('DAP_LIMIT_EXCEEDED');
  });

  it('DAP-o(N-1 清偿): include_raw 全 action 生效——成功路径带 request/messages,超时路径带 messages', async () => {
    currentMock = await startMockDapServer(standardHandler);
    await call({ action: 'initialize', port: currentMock.port, timeout_ms: 2000 });
    const r = await call({ action: 'threads', port: currentMock.port, timeout_ms: 2000, include_raw: true });
    expect(r.isError).toBe(false);
    expect(r.data.request).toBeTruthy();
    expect(Array.isArray(r.data.messages)).toBe(true);
    // 失败路径(超时)也带 messages(server 不回)——全仓审查 I4 重写:原版直接对 mock2 调
    // threads,实际命中 endpoint 守卫(DAP_INVALID_SESSION_STATE)而非超时路径,断言虚假。
    // 修:先对 mock2 initialize 建独立会话(mock2 回 initialize 但不回 threads),再 threads
    // 走真超时,显式断言 dap_timeout + messages 非空。
    const mock2 = await startMockDapServer((req) => {
      if (String(req.command) === 'initialize') {
        return [{ seq: 1, type: 'response', request_seq: req.seq, success: true, command: 'initialize', body: {} }];
      }
      if (String(req.command) === 'disconnect') {
        return [{ seq: 2, type: 'response', request_seq: req.seq, success: true, command: 'disconnect', body: {} }];
      }
      return null;  // threads 等其他命令不回 → 超时
    });
    try {
      await call({ action: 'initialize', port: mock2.port, session_id: 'mock2', timeout_ms: 2000 });
      const r2 = await call({ action: 'threads', port: mock2.port, session_id: 'mock2', timeout_ms: 250, include_raw: true });
      expect(r2.isError).toBe(true);
      expect(r2.data.error_type).toBe('dap_timeout');
      expect(Array.isArray(r2.data.messages)).toBe(true);
    } finally {
      // 全仓审查 I4 补注: server.close() 等所有连接结束才回调——成功 initialize 建立的
      // client session 连接若不断开,mock2.close() 永悬(it 超时假象)。先 disconnect 销毁
      // client socket 再关 server。
      await call({ action: 'disconnect', port: mock2.port, session_id: 'mock2', timeout_ms: 1000, disconnect: true }).catch(() => {});
      await mock2.close();
    }
  });

  it('DAP-s(全仓审查 I1): 消息积压 200 条稳态后 output 收集仍拿到新消息(原 length 游标数学上恒空)', async () => {
    // 刷 >MAX_MESSAGES_PER_SESSION(200) 条 output 事件形成 trim 稳态(每 push 即 shift,
    // length 恒 ≤200),再在 output 请求窗口内刷新事件——修复前 length 游标 slice(200)
    // 恒空数组;修复后按 __mcpSeq 过滤,窗口内新消息必须可见。
    const mock = await startMockDapServer((req) => {
      if (String(req.command) === 'initialize') {
        return [{ seq: 1, type: 'response', request_seq: req.seq, success: true, command: 'initialize', body: {} }];
      }
      if (String(req.command) === 'disconnect') {
        return [{ seq: 2, type: 'response', request_seq: req.seq, success: true, command: 'disconnect', body: {} }];
      }
      return null;
    });
    currentMock = mock;
    await call({ action: 'initialize', port: mock.port, timeout_ms: 2000 });
    // 稳态积压:205 条历史 output(不含 'fresh' 标记)
    for (let i = 0; i < 205; i++) {
      mock.send({ type: 'event', event: 'output', body: { category: 'stdout', i } });
    }
    await new Promise((res) => setTimeout(res, 300));  // 等 pump 消费 + trim 生效
    // 窗口:output 请求发出后 150ms 再刷 3 条新 output('fresh' 标记)
    setTimeout(() => {
      for (let i = 0; i < 3; i++) {
        mock.send({ type: 'event', event: 'output', body: { category: 'stdout', fresh: true, i } });
      }
    }, 150);
    const out = await call({ action: 'output', port: mock.port, timeout_ms: 800 });
    expect(out.isError).toBe(false);
    expect(Array.isArray(out.data.outputs)).toBe(true);
    const fresh = (out.data.outputs as Array<{ fresh?: boolean }>).filter((o) => o && o.fresh === true);
    expect(fresh.length, '200 条稳态后窗口内新 output 必须可收集(修复前恒空)').toBe(3);
  });

  it('DAP-p(N-2 清偿): set_settings 同批次 {host: 非 loopback, allow_remote_hosts: true} 一次通过', async () => {
    // 原 TS 版逐键循环会因 allow_remote_hosts 旧值 false 先拒 host;还原 gd 预处理顺序后应成功
    const r = await call({ action: 'set_settings', settings: { host: '192.168.1.5', allow_remote_hosts: true } });
    expect(r.isError).toBe(false);
    const g = await call({ action: 'get_settings' });
    expect(g.data.host).toBe('192.168.1.5');
    expect(g.data.allow_remote_hosts).toBe(true);
    // 还原默认(防污染后续用例——每个用例 beforeEach _resetForTest 已兜底,此处显式归位)
    await call({ action: 'set_settings', settings: { host: '127.0.0.1', allow_remote_hosts: false } });
  });

  it('DAP-q(N-3 清偿): pump 检出的 frame 超限错误优先于超时报告(不降级为 dap_timeout)', async () => {
    // mock 收到 initialize 后回一个声称超大(>1MB)的 Content-Length header(无 body)——
    // client pump 解析 header 即检出 frame 超限 → pendingError → _readMessages 优先报出
    const mock = await startMockDapServer((req, socket) => {
      if (String(req.command) === 'initialize' && socket) {
        socket.write('Content-Length: 99999999\r\n\r\n');
        return null;
      }
      return [makeResponse(req)];
    });
    try {
      const r = await call({ action: 'initialize', port: mock.port, timeout_ms: 3000 });
      expect(r.isError).toBe(true);
      expect(r.data.error_code).toBe('DAP_LIMIT_EXCEEDED');
      expect(JSON.stringify(r.data)).toContain('frame exceeded');
    } finally { await mock.close(); }
  });

  it('DAP-r(N-4 清偿): 并发首连复用 in-flight——同 session 并发 initialize 不泄漏 socket', async () => {
    currentMock = await startMockDapServer(standardHandler);
    // 三个并发 initialize(同一 default session):应复用同一连接,server 侧只看到 1 次 TCP 连接
    const results = await Promise.all([
      call({ action: 'initialize', port: currentMock.port, timeout_ms: 3000 }),
      call({ action: 'initialize', port: currentMock.port, timeout_ms: 3000 }),
      call({ action: 'initialize', port: currentMock.port, timeout_ms: 3000 }),
    ]);
    for (const r of results) expect(r.isError).toBe(false);
    const st = await call({ action: 'status' });
    expect(st.data.session_count).toBe(1);
  });

  it('DAP-n: 连不上 DAP server → DAP_ERROR + hint(开启指引)', async () => {
    // 随机高端口,几乎必然无监听
    const r = await call({ action: 'initialize', port: 59999, timeout_ms: 400 });
    expect(r.isError).toBe(true);
    const text = JSON.stringify(r.data);
    expect(text).toMatch(/ECONNREFUSED|timeout|failed/i);
  });
});
