import { expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { EditorConnection, LEGACY_AUTH_RETRY_TTL_MS } from '../src/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorConnection', () => {
  let wss;
  let port;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
  });

  it('should have onNotification and offNotification methods', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(typeof conn.onNotification).toBe('function');
    expect(typeof conn.offNotification).toBe('function');
  });

  it('should have onDisconnect property', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(conn.onDisconnect).toBe(null);
  });

  it('connects and sends JSON-RPC request', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const result = await conn.request('test_method', { key: 'value' });
    expect(result).toEqual({ status: 'ok' });
    conn.disconnect();
  });

  it('handles connection refused gracefully', async () => {
    const conn = new EditorConnection({ port: 59999, reconnect: false, connectTimeout: 1000 });
    await expect(() => conn.connect()).rejects.toThrow(/connect/i);
  });

  it('handles request timeout', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // Reply to auth but ignore other requests to simulate timeout
        // 3A (2026-09-19 批3): auth_begin 按真旧插件语义回 -32001(未认证的非 auth 消息) → TS 降级明文
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required' } }));
          return;
        }
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        }
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, requestTimeout: 500, secret: 'test-secret' });
    await conn.connect();
    await expect(() => conn.request('slow_method', {})).rejects.toThrow(/timeout/i);
    conn.disconnect();
  });

  it('sends operation_start for long running operations', async () => {
    let received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    await conn.startOperation(300);
    expect(received.some(m => m.method === 'operation_start')).toBe(true);
    await conn.endOperation();
    expect(received.some(m => m.method === 'operation_end')).toBe(true);
    conn.disconnect();
  });

  it('does not reconnect on auth timeout (C-01)', { timeout: 15_000 }, async () => {
    // Server accepts connection but never replies to auth
    wss.on('connection', (ws) => {
      // intentionally ignore auth messages — simulate timeout
    });

    const reconnectSpy = vi.fn();
    const conn = new EditorConnection({
      port,
      reconnect: true,
      secret: 'test-secret',
      connectTimeout: 1000,
    });
    conn.onDisconnect = reconnectSpy;

    // connect should reject due to auth timeout
    await expect(() => conn.connect()).rejects.toThrow(/auth/i);

    // Give a small window for any async reconnect scheduling
    await new Promise((r) => setTimeout(r, 200));

    // onDisconnect may be called once for the close event, but
    // the key point: no reconnect should be scheduled.
    // We verify by checking that the connection is in a clean state.
    expect(conn.connected).toBe(false);
  });

  it('rejects connection without secret', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });
    const conn = new EditorConnection({ port, reconnect: false });
    await expect(() => conn.connect()).rejects.toThrow(/no secret configured/i);
  });

  it('rejects connection with wrong secret', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'wrong-secret', connectTimeout: 1000 });
    await expect(() => conn.connect()).rejects.toThrow();
  });

  it('locks out after repeated auth failures', async () => {
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
        }
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'wrong', connectTimeout: 500 });
    // Fail 5 times to trigger lockout
    for (let i = 0; i < 5; i++) {
      await expect(() => conn.connect()).rejects.toThrow();
    }
    // 6th attempt should be locked out immediately
    await expect(() => conn.connect()).rejects.toThrow(/locked out/i);
  });

  // IMP-8: 认证失败(wrong secret)后 close handler 不该调度重连。
  // wasConnected = !connectAttempt && authenticated && !authFailed → 认证失败时三者合力为 false。
  it('does not reconnect after auth failure (IMP-8)', { timeout: 8_000 }, async () => {
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
        }
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: true,
      secret: 'wrong-secret',
      connectTimeout: 1000,
      reconnectInterval: 100,
      maxReconnectInterval: 200,
    });

    // connect 应因认证失败 reject(authFailed=true,reconnectEnabled=false)
    await expect(() => conn.connect()).rejects.toThrow();

    // 等待足够窗口让潜在重连发生(reconnectInterval=100ms,等 600ms 覆盖几次)
    await new Promise((r) => setTimeout(r, 600));

    // IMP-8 核心断言:认证失败后不重连 — server 端只应有 1 次连接(初始 connect)
    expect(connections).toBe(1);

    conn.disconnect();
  });

  // 审查可疑项闭环: EditorConnection 重连机制(connectGeneration 防复活 / scheduleReconnect
  // 指数退避 / fireReconnect) 此前零"成功重连"覆盖(全 reconnect:false, 仅测 auth 失败不重连)。
  // 本测试验证: 已认证连接被 server 端关闭 → scheduleReconnect → 重连成功 → fireReconnect
  // → 新连接可正常 request(generation 防复活, 新 ws 不被旧 connect 丢弃)。
  it('reconnects after server-side close and fires onReconnect (ipc P1)', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    let latestWs = null;
    wss.on('connection', (ws) => {
      connectionCount++;
      latestWs = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: true,
      reconnectInterval: 50,
      maxReconnectInterval: 100,
      secret: 'test-secret',
    });
    let reconnected = false;
    conn.onReconnect = () => { reconnected = true; };

    await conn.connect();
    expect(connectionCount).toBe(1);
    expect(conn.connected).toBe(true);

    // 模拟编辑器崩溃: server 端关闭当前连接 → client ws 'close' → scheduleReconnect
    latestWs.close();

    // 等重连(attempt1 backoff=min(50*2,100)=100 + jitter[0,50] + connect/auth 开销)
    await new Promise((r) => setTimeout(r, 1000));
    expect(reconnected).toBe(true);
    expect(connectionCount).toBe(2);
    expect(conn.connected).toBe(true);

    // generation 防复活: 重连后的新连接可正常 request(新 ws 不被旧 connect 的 gen 检查丢弃)
    const result = await conn.request('test_method', {});
    expect(result).toEqual({ status: 'ok' });

    conn.disconnect();
  });

  // B3: request() 支持 options.timeoutMs 短超时（心跳 ping 用 5s 而非业务默认 30s）。
  // bug: GodotServer.ts:460 pingFn 复用 request('ping') 的 30s 默认超时——
  // 编辑器主线程卡死时 ping 要等 30s 才失败，连续 5 次 = ~150s 才触发降级。
  it('B3: request() honors options.timeoutMs (short heartbeat timeout)', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // 仅回 auth，不回 ping —— 模拟编辑器卡死（TCP OPEN 但主线程无响应）
        // 3A (2026-09-19 批3): auth_begin 按真旧插件语义回 -32001 → TS 降级明文
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required' } }));
          return;
        }
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        }
      });
    });

    // requestTimeout=30000 (业务默认) —— 模拟生产配置；心跳传 timeoutMs=500 覆盖
    const conn = new EditorConnection({ port, reconnect: false, requestTimeout: 30000, secret: 'test-secret' });
    await conn.connect();

    const start = Date.now();
    // options.timeoutMs=500 应覆盖默认 30000
    await expect(conn.request('ping', {}, { timeoutMs: 500 })).rejects.toThrow(/Request timeout/);
    const elapsed = Date.now() - start;
    // 应在 ~500ms 超时，远小于 30000ms
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5000); // 5s buffer（CI 慢机器宽容），但绝不应接近 30s

    conn.disconnect();
  });

  // B5: fireDisconnect/fireReconnect 单 handler 抛错不应阻断后续 handler
  // (对齐 health-monitor:156-160 容错模式)。原实现裸 for-of 迭代,首个抛错即中断迭代。
  it('B5: a throwing disconnect handler does not block other handlers', () => {
    const conn = new EditorConnection({ port: 9999 });
    const called = [];
    conn.addOnDisconnectHandler(() => { called.push('first'); throw new Error('boom'); });
    conn.addOnDisconnectHandler(() => { called.push('second'); });
    // fireDisconnect 私有,通过 as any 直访(单测 handler 迭代逻辑,绕过 ws close 事件路径)
    conn.fireDisconnect();
    // 两个都跑,不因首个抛错中断
    expect(called).toEqual(['first', 'second']);
  });

  it('B5: fireDisconnect guard prevents duplicate firing (second call no-op)', () => {
    const conn = new EditorConnection({ port: 9999 });
    const called = [];
    conn.addOnDisconnectHandler(() => { called.push('one'); });
    // _disconnectFired 守卫:第二次 fireDisconnect 应早返回
    conn.fireDisconnect();
    conn.fireDisconnect();
    expect(called).toEqual(['one']);
  });

  it('B5: a throwing reconnect handler does not block other handlers', () => {
    const conn = new EditorConnection({ port: 9999 });
    const called = [];
    conn.addOnReconnectHandler(() => { called.push('first'); throw new Error('boom'); });
    conn.addOnReconnectHandler(() => { called.push('second'); });
    conn.fireReconnect();
    expect(called).toEqual(['first', 'second']);
  });

  // P0-1: 重连耗尽致命路径。编辑器崩溃/kill-9 后若重连耗尽,reconnectExhaustedHandler
  // 必须恰好触发一次(I-04 去重不变量——不因 ws close 的 fireDisconnect 重复),且
  // reconnectEnabled=false 后不再尝试。此前全文 0 处覆盖 maxReconnectAttempts /
  // reconnectExhausted,唯一重连测试只覆盖 attempt 1。编辑器崩溃后 MCP 瘫痪且测试无法捕获。
  it('fires reconnectExhausted exactly once after maxReconnectAttempts then stops (P0-1)', { timeout: 30_000 }, async () => {
    let connectionCount = 0;
    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: true,
      reconnectInterval: 20,
      maxReconnectInterval: 40,
      maxReconnectAttempts: 3,
      connectTimeout: 400,
      secret: 'test-secret',
    });

    let exhaustedCalls = 0;
    conn.addOnReconnectExhaustedHandler(() => { exhaustedCalls++; });

    // 初始 connect 必须成功(authenticated=true),否则 close handler wasConnected=false 不进重连链
    await conn.connect();
    expect(connectionCount).toBe(1);
    expect(conn.connected).toBe(true);

    // 模拟编辑器崩溃:终止现有连接 + 关 server → client ws close → scheduleReconnect;
    // 后续每次重连 ECONNREFUSED,由 reconnectTimer 的 catch 递归驱动 scheduleReconnect,
    // 直到 attempt >= max。先 terminate 现有连接——wss.close 的 callback 会等所有活跃连接,
    // 不 terminate 则 client 以为连着不断开,callback 永挂。
    for (const client of wss.clients) client.terminate();
    await new Promise((res) => wss.close(res));

    // 3 次重连尝试 × (backoff 20~40ms + ECONNREFUSED 即时/最多 connectTimeout 400ms)
    await new Promise((r) => setTimeout(r, 4000));

    // I-04 核心:reconnectExhausted 恰好 1 次(去重,不重复)
    expect(exhaustedCalls).toBe(1);
    // 耗尽后连接断开
    expect(conn.connected).toBe(false);

    // 再等 1s 确认不再重复触发(reconnectEnabled=false,重连链已止)
    await new Promise((r) => setTimeout(r, 1000));
    expect(exhaustedCalls).toBe(1);

    conn.disconnect();
  });

  // P1-2（2026-07-31 补）：WS 断连 pending 批量 reject 故障注入。
  // EditorConnection.ts:257-263 close handler 遍历 pending 全 reject 挂 CONNECTION_LOST。
  // 核实：现有测试无并发 request + 中途 close 的故障注入。本测试补：3 并发 request +
  // server 端 close → 断言全 reject 带 code='CONNECTION_LOST'。
  it('rejects all pending requests with CONNECTION_LOST on server-side close (P1-2)', async () => {
    let latestWs = null;
    wss.on('connection', (ws) => {
      latestWs = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // 只响应 auth(id=-1)，业务 request 不响应 → 保持 pending
        // 3A (2026-09-19 批3): auth_begin 按真旧插件语义回 -32001 → TS 降级明文
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required' } }));
          return;
        }
        if (msg.id === -1) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        }
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: false,  // 关重连，聚焦批量 reject
      secret: 'test-secret',
      requestTimeout: 5000,  // 长超时，确保 reject 来自 close 而非 timeout
    });
    await conn.connect();
    expect(conn.connected).toBe(true);

    // 发 3 个并发业务 request（server 不响应，全进 pending）
    const reqs = [
      conn.request('method_a', { n: 1 }),
      conn.request('method_b', { n: 2 }),
      conn.request('method_c', { n: 3 }),
    ];

    // 等待 request 真正发出并进 pending（让 server 收到 message）
    await new Promise((r) => setTimeout(r, 100));

    // server 端关闭连接 → client 'close' → 批量 reject pending
    latestWs.close();

    // 3 个 request 应全 reject，且 err.code === 'CONNECTION_LOST'
    const results = await Promise.allSettled(reqs);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      expect(r.reason.code).toBe('CONNECTION_LOST');
    }

    conn.disconnect();
  });

  // A-1 (2026-08-14 finding :937): backoff 挂起期手动 connect 成功后必须清掉遗留 reconnectTimer。
  // bug: scheduleReconnect 的 timer 回调(:516-526)不检查 connected——手动 connect 成功后 timer 照样
  // 触发 connect(),而 connect 入口(:164-169)无条件 terminate 现有 ws → 弹跳健康连接,
  // in-flight editor 工具请求全部丢失。修复:open 成功段(与 reconnectAttempt=0 同处)clearTimeout+置空。
  it('A-1: manual connect success clears pending reconnectTimer (no healthy-connection bounce)', { timeout: 8_000 }, async () => {
    let connectionCount = 0;
    let latestWs = null;
    wss.on('connection', (ws) => {
      connectionCount++;
      latestWs = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: true,
      reconnectInterval: 300,
      maxReconnectInterval: 400,
      secret: 'test-secret',
    });

    // 初始连接成功
    await conn.connect();
    expect(connectionCount).toBe(1);
    expect(conn.connected).toBe(true);

    // 模拟编辑器掉线 → client close handler → scheduleReconnect → reconnectTimer 挂起(300~700ms)
    latestWs.close();
    await new Promise((r) => setTimeout(r, 50));

    // backoff 窗口内手动 connect 成功(编辑器已恢复场景)
    await conn.connect();
    expect(connectionCount).toBe(2);
    expect(conn.connected).toBe(true);

    // 核心断言 1: 遗留 backoff timer 已被清(修复前非 null → timer 迟早触发第二次 connect)
    expect(conn.reconnectTimer).toBe(null);

    // 核心断言 2: 越过原 timer 触发时刻(300~700ms + 余量)后,无第三次 connect 弹跳健康连接
    await new Promise((r) => setTimeout(r, 1200));
    expect(connectionCount).toBe(2);
    expect(conn.connected).toBe(true);

    conn.disconnect();
  });

  // A-3 (2026-08-14 finding :932, P0): secret 轮换后的 auth 失败必须 fire reconnectExhaustedHandlers。
  // 场景: editor 重启(PERSISTENT_SECRET 默认 false,每次换 secret)→ ws close → scheduleReconnect →
  // connect → performAuth 失败(旧 secret) → 原实现仅置 reconnectEnabled=false + authFailed,
  // 不 fire exhaustion → Manager 的 handleStall 无触发路径 → conn 永不置 null →
  // manage_tools(reconnect) 只走 ec.connect()(旧 secret)永远失败并累计 authFailureCount,
  // 5 次后 5 分钟 lockout —— 重连链死,只能重启 MCP 服务端。
  // 修复: auth 失败处同样 fire 专用 exhaustion handlers(_authExhaustedFired 去重,仅一次)。
  it('A-3: auth failure after secret rotation fires reconnectExhausted (exactly once)', { timeout: 10_000 }, async () => {
    let serverSecret = 'old-secret';
    let connectionCount = 0;
    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          if (msg.params.secret === serverSecret) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Auth failed' } }));
          }
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        }
      });
    });

    const conn = new EditorConnection({
      port,
      reconnect: true,
      reconnectInterval: 50,
      maxReconnectInterval: 100,
      connectTimeout: 1000,
      secret: 'old-secret',
    });

    let exhaustedCalls = 0;
    conn.addOnReconnectExhaustedHandler(() => { exhaustedCalls++; });

    // 初始连接成功(旧 secret 匹配)
    await conn.connect();
    expect(connectionCount).toBe(1);

    // 模拟编辑器重启: secret 轮换 + 断开现有连接
    serverSecret = 'new-secret';
    for (const client of wss.clients) client.close();

    // 自动重连链: close → scheduleReconnect(50~100ms) → connect → auth 失败 → fire
    await new Promise((r) => setTimeout(r, 800));

    // A-3 核心: auth 失败触发 reconnectExhausted 恰好 1 次
    // (修复前 0 次 → Manager 无法降级,重连链死)
    expect(exhaustedCalls).toBe(1);
    // IMP-8 不变量保持: auth 失败后不再有新的连接尝试(1 初始 + 1 次 auth 失败尝试)
    expect(connectionCount).toBe(2);
    expect(conn.connected).toBe(false);

    conn.disconnect();
  });

  // P2-9（2026-07-31 补）：resetReconnectState() 直接单测。
  // EditorConnection.ts:543-550 全文唯一被 requestReconnect(:557) 间接调用，无直接单测。
  // 4 个行为分支：reconnectAttempt 归 0 / reconnectEnabled 重置到 shouldReconnect /
  // reconnectTimer 清理 / 无 timer 时不报错。
  // 关键语义：reconnect:false → shouldReconnect=false → resetReconnectState 后
  // reconnectEnabled 仍 false（e2e-resilience-editor.test.ts:13 注释的"reconnect:false
  // 行不通"根因即此，reset 不强制开 enabled，只回到 shouldReconnect）。
  it('resetReconnectState() resets attempt/enabled and clears timer (P2-9)', () => {
    // ─ 场景 A：reconnect:true，耗尽后 reset 应回到可重连状态 ─────────────────
    const connA = new EditorConnection({
      port,
      reconnect: true,
      maxReconnectAttempts: 3,
      secret: 'test-secret',
    });
    // 模拟重连耗尽后的状态：attempt 拉高 + reconnectEnabled 被置 false（:481 耗尽分支）
    connA.reconnectAttempt = 5;
    connA.reconnectEnabled = false;
    // 模拟有挂起的 reconnectTimer（真 setTimeout handle，reset 后应被 clearTimeout 清）
    connA.reconnectTimer = setTimeout(() => {}, 100_000);

    connA.resetReconnectState();

    // 分支 1：reconnectAttempt 归 0（:544）
    expect(connA.reconnectAttempt).toBe(0);
    // 分支 2：reconnectEnabled 重置到 shouldReconnect（reconnect:true → true，:545）
    expect(connA.reconnectEnabled).toBe(true);
    // 分支 3：reconnectTimer 被清为 null（:548，证明进了 if 分支并 clearTimeout）
    expect(connA.reconnectTimer).toBe(null);

    // ─ 场景 B：reconnect:false，reset 不应强制开 enabled（关键不变量）────────
    const connB = new EditorConnection({
      port,
      reconnect: false,   // → shouldReconnect=false
      secret: 'test-secret',
    });
    connB.reconnectEnabled = true;  // 假设被外部异常置 true
    connB.reconnectTimer = setTimeout(() => {}, 100_000);

    connB.resetReconnectState();
    // reconnectEnabled 应回到 shouldReconnect=false，不是强制 true
    expect(connB.reconnectEnabled).toBe(false);
    expect(connB.reconnectTimer).toBe(null);

    // ─ 场景 C：无 timer 时调 reset 不应报错（边界，:546 if 守卫）────────────
    const connC = new EditorConnection({ port, reconnect: true, secret: 'test-secret' });
    connC.reconnectTimer = null;  // 确保无 timer
    expect(() => connC.resetReconnectState()).not.toThrow();
    expect(connC.reconnectTimer).toBe(null);
  });

  // ── 3A (2026-09-19 安全加固批3): challenge-response 握手协议行为锁 ──────────

  it('3A: challenge-response 握手成功——secret 全程不上线路(收到的消息不含 secret 字段)', async () => {
    const SECRET = 'cr-secret-0123456789abcdef';
    const receivedRaw = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const raw = data.toString();
        receivedRaw.push(raw);
        const msg = JSON.parse(raw);
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { challenge: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } }));
          return;
        }
        if (msg.method === 'auth_proof') {
          // 服务端同款校验:HMAC-SHA256(secret, challenge)
          const expected = createHmac('sha256', SECRET).update('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'utf8').digest('hex');
          if (msg.params?.proof === expected) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authenticated: true } }));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication failed' } }));
          }
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: SECRET });
    await conn.connect();  // proof 模式认证成功
    const result = await conn.request('test_method', {});
    expect(result).toEqual({ status: 'ok' });
    conn.disconnect();
    // 核心断言:整个握手过程网络上从未出现 secret(防假监听者窃取凭证)
    expect(receivedRaw.some((r) => r.includes(SECRET))).toBe(false);
    expect(receivedRaw.some((r) => r.includes('"proof"'))).toBe(true);
  });

  it('3A: 旧端降级——auth_begin 收 -32001 后记忆降级,第二次连接直接明文 auth(不再探测)', async () => {
    const methodsFirst = [];
    const methodsSecond = [];
    let connCount = 0;
    wss.on('connection', (ws) => {
      connCount++;
      const seen = connCount === 1 ? methodsFirst : methodsSecond;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        seen.push(msg.method);
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required' } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    expect(methodsFirst).toEqual(['auth_begin', 'auth']);  // 首连:探测 + 降级明文
    conn.disconnect();
    // 模拟重连(降级记忆生效:直接明文,不再发 auth_begin)
    const conn2 = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    conn2._useLegacyAuth = conn._useLegacyAuth;  // 复制降级记忆(测试模拟同实例重连语义)
    conn2._legacyAuthSince = conn._legacyAuthSince;  // 批4-T2: 配套时间戳必须同复制(缺省 0 会被判 TTL 已过期而重试探测)
    await conn2.connect();
    expect(methodsSecond).toEqual(['auth']);
    conn2.disconnect();
  });

  it('3A: 哑占位者不降级——对端占端口但不回应,connect 失败且明文 secret 从未上线', async () => {
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        // 不回应任何消息(哑占位者)
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'secret-never-leak', authTimeout: 3000 });
    await expect(() => conn.connect()).rejects.toThrow(/不降级|challenge-response/i);
    // 核心断言:只发过 auth_begin,明文 auth(secret)从未发出
    expect(receivedMethods).toEqual(['auth_begin']);
    conn.disconnect();
  }, 10_000);

  // ── 批4-T1(五维评估 P2): auth_proof 响应语义校验(对齐 bridge 侧) ──────────

  it('批4-T1: auth_proof 回 authenticated:false → 认证失败且不降级(明文 auth 不发)', async () => {
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { challenge: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } }));
          return;
        }
        if (msg.method === 'auth_proof') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authenticated: false } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'proof-rejected-secret' });
    await expect(() => conn.connect()).rejects.toThrow(/authenticated is not true/i);
    // proof 阶段失败不降级:无明文 auth(secret 不上线)
    expect(receivedMethods).toEqual(['auth_begin', 'auth_proof']);
    conn.disconnect();
  });

  it('批4-T1: 半协议异构端恒回空 result → 认证失败(不再"任何 result 即认证成功")', async () => {
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { challenge: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } }));
          return;
        }
        if (msg.method === 'auth_proof') {
          // 半协议异构端:proof 也回空 result(不带 authenticated 字段)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'empty-result-secret' });
    await expect(() => conn.connect()).rejects.toThrow(/authenticated is not true/i);
    expect(receivedMethods).toEqual(['auth_begin', 'auth_proof']);
    conn.disconnect();
  });

  // ── 批4-T2(五维评估 P2): 降级记忆 TTL 复位 ──────────

  it('批4-T2: 降级记忆 TTL 过期后重连——先重试 auth_begin,新端 proof 成功即恢复 CR 模式', async () => {
    const SECRET = 'ttl-retry-secret';
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        if (msg.method === 'auth_begin') {
          // TTL 过期后插件已升级:回 challenge
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { challenge: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' } }));
          return;
        }
        if (msg.method === 'auth_proof') {
          const expected = createHmac('sha256', SECRET).update('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'utf8').digest('hex');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authenticated: msg.params?.proof === expected } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: SECRET });
    // 预置"已降级且 TTL 已过期"状态(模拟:曾降级过,10 分钟已过)
    conn._useLegacyAuth = true;
    conn._legacyAuthSince = Date.now() - LEGACY_AUTH_RETRY_TTL_MS - 1;
    await conn.connect();
    // TTL 过期 → 不直接明文,先重试 CR 且成功
    expect(receivedMethods).toEqual(['auth_begin', 'auth_proof']);
    expect(conn._useLegacyAuth).toBe(false);  // 降级记忆已复位
    expect(conn._legacyAuthSince).toBe(0);
    const result = await conn.request('test_method', {});
    expect(result).toEqual({ status: 'ok' });
    conn.disconnect();
  });

  it('批4-T2: 降级记忆 TTL 过期后重连——对端仍是旧端(-32001)→ 再次降级并重置 TTL', async () => {
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        if (msg.method === 'auth_begin') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Authentication required' } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'still-old-secret' });
    conn._useLegacyAuth = true;
    conn._legacyAuthSince = Date.now() - LEGACY_AUTH_RETRY_TTL_MS - 1;
    await conn.connect();
    // TTL 过期 → 重试 auth_begin 被拒 → 再次降级明文
    expect(receivedMethods).toEqual(['auth_begin', 'auth']);
    expect(conn._useLegacyAuth).toBe(true);
    expect(conn._legacyAuthSince).toBeGreaterThan(Date.now() - 5000);  // TTL 已重置为当下
    conn.disconnect();
  });

  it('批4-T2: 降级记忆 TTL 内重连——直接明文不再探测(既有行为兼容锁)', async () => {
    const receivedMethods = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMethods.push(msg.method);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false, secret: 'within-ttl-secret' });
    conn._useLegacyAuth = true;
    conn._legacyAuthSince = Date.now();  // 刚降级,TTL 未过
    await conn.connect();
    expect(receivedMethods).toEqual(['auth']);  // 直接明文,无 auth_begin
    conn.disconnect();
  });
});
