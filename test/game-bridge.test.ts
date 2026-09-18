// game-bridge.test.ts — 合并自原 game-bridge-error.test.ts + game-bridge-isready.test.ts
//
// 合并原因:规避 vitest 4.1.x 在 Linux 平台的 vi.mock 内置模块跨文件隔离失效(PR #14 调查)。
// 全仓仅原这两个文件 vi.mock('net'),Linux 全量运行时同 fork 内两个 net mock 互相影子化,
// 致 game-bridge-error 的 mockCreate 实际未接管生产 net.createConnection → beforeEach
// vi.clearAllMocks() 清空那个接错的实现 → createConnection() 返回 undefined →
// core/bridge-client.ts sock.on('data') TypeError → 兜底 catch textResult(无 isError)
// (2026-08-21 C 组重构:实现自已删的 tools/game-bridge.ts:150/:739 下沉 core/bridge-client.ts)
// → T-2/N-1 断言拿 undefined 而败。合并后同 fork 内仅一个 net mock,消除碰撞触发条件。
// 本地 Windows 4.1.7/4.1.9 双版本 2852 全过(CI Linux 4.1.7 才败:平台敏感,版本无关)。
//
// 覆盖(socket 相关测试,本文件必须 vi.mock('net'),Linux CI 因 issue #15 平台 bug 被 --exclude):
// - T-2 (2026-06-24 审查): bridge 返回 error 必须 isError=true,否则 MCP 客户端误判成功吞错
//   (覆盖 bridgeAction + game_query 内联两条 error 路径;守护 errorResult 不被回退)
// - N-1: sendToBridge once 监听器不泄漏
// - isBridgeReady: 零接触探测(auth 成功 / secret 缺失 / auth 超时 / 进程 killed / isCancelled)
// - P3-6 / P1-8 / P1-3(CS-1~CS-4): socket 竞态 / 废弃 socket 延迟 close / 连接状态机 characterization
// - A4: symlink secret 权限收紧时序
//
// T-1 / I-1 / I-2(原 path/参数校验)已迁移至 game-bridge-validation.test.ts(纯函数,Linux CI 可跑)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockCreate, mockExists, mockRead, mockLstat, mockChmod, mockExec, mockReaddir } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockExists: vi.fn(() => true),
  mockRead: vi.fn(() => 'test-secret'),
  // Task 4.4: registry 目录读取 mock——默认空数组(确定性空 registry;此前 fs mock 无
  // readdirSync 导出,bridge-client 拿 undefined 调用即 throw → catch 回落,行为等价但隐晦)。
  mockReaddir: vi.fn(() => [] as string[]),
  // A4: 默认非 symlink;测试时 override 为 symlink 验证权限收紧未发生
  mockLstat: vi.fn(() => ({ isSymbolicLink: () => false })),
  // A4: 暴露 chmod/exec 作 spy,断言 symlink 时二者均未被调用(副作用未发生)
  mockChmod: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('net', () => ({ createConnection: mockCreate }));
vi.mock('fs', () => ({
  existsSync: mockExists,
  readFileSync: mockRead,
  readdirSync: mockReaddir,
  writeFileSync: vi.fn(), copyFileSync: vi.fn(), unlinkSync: vi.fn(),
  chmodSync: mockChmod, statSync: vi.fn(), lstatSync: mockLstat,
  renameSync: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // 仅替换 execFileSync(A4 断言目标);保留 execFile/spawn 等(helpers.ts:57 execFileAsync 依赖)
  return { ...actual, execFileSync: mockExec };
});
vi.mock('../src/dashboard/launcher.js', () => ({ launchDashboardOnce: vi.fn() }));

import { handleTool, setBridgeProjectDir, isBridgeReady, _testBridgeCacheState, registerBridgePushHandler, sendToBridge, _isPortFailed, resetBridgeState } from '../src/tools/game-bridge.js';
import * as loggerMod from '../src/core/logger.js';

// ===== helpers =====

/** mock socket:auth 请求(id=0)回 authenticated:true;method 请求(id≥1)按 kind 回 error/result。
 *  对应 game-bridge.ts :140 createConnection connectListener + :141 auth id=0 + :246 method id≥1。 */
function bridgeSocket(kind: 'error' | 'result'): EventEmitter {
  const sock = new EventEmitter();
  (sock as any).write = vi.fn((data: string) => {
    let req: { id?: number };
    try { req = JSON.parse(data); } catch { return; }
    queueMicrotask(() => {
      const resp = req.id === 0
        ? { id: 0, result: { authenticated: true } }
        : (kind === 'error'
          ? { id: req.id, error: { code: -32001, message: 'Invalid key' } }
          : { id: req.id, result: { ok: true, data: 'pong' } });
      sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
    });
  });
  (sock as any).destroy = vi.fn();
  (sock as any).writable = true;  // 模拟已连接 Socket.writable → _ensureConnection :207 复用 _socket(复现 N-1 once 累积)
  return sock;
}

/** createConnection(opts, connectListener):返回 mock sock 并触发 connectListener(模拟连接建立,
 *  否则 _doConnect :141 的 auth write 永不执行→timeout)。 */
function setupBridgeSocket(kind: 'error' | 'result'): void {
  mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
    const sock = bridgeSocket(kind);
    queueMicrotask(() => { if (typeof cb === 'function') cb(); });
    return sock;
  });
}

/** isBridgeReady:模拟 bridge 立即 auth 成功的 socket。 */
function authSuccessSocket(): EventEmitter {
  const sock = new EventEmitter();
  (sock as any).write = vi.fn();
  (sock as any).destroy = vi.fn();
  queueMicrotask(() => sock.emit('data', Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n')));
  return sock;
}
/** isBridgeReady:永不发 auth 成功(卡住,触发 timeout)。 */
function stuckSocket(): EventEmitter {
  const sock = new EventEmitter();
  (sock as any).write = vi.fn();
  (sock as any).destroy = vi.fn();
  return sock;
}

// ===== error paths + 路径校验(原 game-bridge-error)=====

describe('game-bridge error & path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('test-secret');
    // setBridgeProjectDir 同路径时直接 return(:228)不清状态,先用不同路径强制 _invalidateSocket,
    // 再设回 '/p'。确保每个测试 _socket 缓存清空(跨测试 _socket 复用会污染,如 N-1 累积测试)。
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');
  });

  describe('T-2: bridge error → isError=true (不误判成功)', () => {
    it('monitor_poll (bridgeAction 路径): bridge 返回 error → isError=true', async () => {
      setupBridgeSocket('error');
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'monitor_poll' }, ctx);
      expect(result.isError).toBe(true);
    });

    it('find_ui_elements (bridgeAction 路径): bridge 返回 error → isError=true', async () => {
      setupBridgeSocket('error');
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'find_ui_elements', type: 'Button' }, ctx);
      expect(result.isError).toBe(true);
    });

    it('game_query (内联路径 :596): bridge 返回 error → isError=true', async () => {
      setupBridgeSocket('error');
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result.isError).toBe(true);
    });

    it('bridge 成功 (result) → isError 不为 true (回归守护)', async () => {
      setupBridgeSocket('result');
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result.isError).not.toBe(true);
    });
  });

  describe('739: catch 兜底非 ECONNREFUSED → isError=true (issue #15 遗留)', () => {
    it('bridge 连接 error(非 ECONNREFUSED) → catch 兜底 opsErrorResult(isError=true, BRIDGE_ERROR)', async () => {
      // sock 连接后 emit 非 ECONNREFUSED 错误 → _doConnect :193 reject('Bridge connection error: ...')
      // → bridgeAction reject → handleTool catch(:732) → msg 非 ECONNREFUSED → :739 opsErrorResult
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        const sock = new EventEmitter();
        (sock as any).write = vi.fn();
        (sock as any).destroy = vi.fn();
        queueMicrotask(() => {
          if (typeof cb === 'function') cb();  // connectListener 触发 auth write
          sock.emit('error', new Error('connection reset'));  // 非 ECONNREFUSED
        });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_ERROR');
      expect(parsed.error).toContain('connection reset');
    });

    it('ECONNREFUSED → BRIDGE_NOT_CONNECTED + suggestion(端到端,游戏未运行语义)', async () => {
      // emit 带 code 的 ECONNREFUSED → _doConnect :195 按 err.code 分流 → BridgeNotConnectedError
      // → 外层 catch :733 instanceof → opsErrorResult(BRIDGE_NOT_CONNECTED, suggestion)
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        const sock = new EventEmitter();
        (sock as any).write = vi.fn();
        (sock as any).destroy = vi.fn();
        queueMicrotask(() => {
          if (typeof cb === 'function') cb();
          const e = new Error('connect ECONNREFUSED 127.0.0.1:9081') as NodeJS.ErrnoException;
          e.code = 'ECONNREFUSED';
          sock.emit('error', e);
        });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_NOT_CONNECTED');
      expect(parsed.error).toContain('Cannot connect to MCP Bridge');
      expect(parsed.error).not.toContain('ECONNREFUSED');  // 不泄露原始错误码给用户
      expect(parsed.suggestion).toEqual(expect.any(String));
      expect(parsed.suggestion.length).toBeGreaterThan(0);
      // A3 (2026-09-16 反馈批): ECONNREFUSED 自动记入失败端口记忆 —— _doConnect error
      // handler 调 _markPortFailed(fs mock 下 '/p' 无 registry/secret → 端口解析恒 9081),
      // 下次 resolveBridgePort 避开该端口降级次新候选(陈旧 secret 误导的自愈链)。
      expect(_isPortFailed(9081)).toBe(true);
      resetBridgeState();  // 清失败记忆,防污染后续用例的端口解析
    });
  });

  describe('Bridge 超时分层: NOT_CONNECTED 其余路径', () => {
    it('secret not found → BRIDGE_NOT_CONNECTED(bridge 未装/未跑)', async () => {
      // readFileSync 抛错 → readBridgeSecret 返回 null → _doConnect :155 throw BridgeNotConnectedError
      mockRead.mockImplementation(() => { throw new Error('ENOENT'); });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_NOT_CONNECTED');
      expect(parsed.suggestion).toEqual(expect.any(String));
      expect(parsed.suggestion.length).toBeGreaterThan(0);
    });

    it('auth timeout → BRIDGE_NOT_CONNECTED(bridge 接受 TCP 不响应认证)', async () => {
      // bridge 接受连接但不回 auth → _doConnect auth timer → BridgeNotConnectedError
      mockRead.mockReturnValue('test-secret');
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        const sock = new EventEmitter();
        (sock as any).write = vi.fn();  // 接受 auth write 不回
        (sock as any).destroy = vi.fn();
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping', timeout: 1000 }, ctx);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_NOT_CONNECTED');
    }, 5000);
  });

  describe('Bridge 超时分层: TIMEOUT', () => {
    it('request timeout → BRIDGE_TIMEOUT(连上 + 认证后请求无响应,游戏卡住)', async () => {
      // auth 成功但 method 请求不响应 → sendToBridge :255 timer → BridgeTimeoutError
      mockRead.mockReturnValue('test-secret');
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        const sock = new EventEmitter();
        (sock as any).write = vi.fn((data: string) => {
          let req: { id?: number };
          try { req = JSON.parse(data); } catch { return; }
          queueMicrotask(() => {
            if (req.id === 0) {
              sock.emit('data', Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n'));
            }
            // id >= 1 method 请求不响应 → :255 timer
          });
        });
        (sock as any).destroy = vi.fn();
        (sock as any).writable = true;
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping', timeout: 1000 }, ctx);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_TIMEOUT');
      expect(parsed.suggestion).toContain('不是连接问题');
    }, 5000);
  });

  describe('N-1: sendToBridge once 监听器不泄漏', () => {
    it('多次成功调用后 error/close listener 不累积(只留 _doConnect 持久监听)', async () => {
      setupBridgeSocket('result');
      const ctx = { projectDir: '/p' } as any;
      for (let i = 0; i < 12; i++) {
        await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      }
      const sock = mockCreate.mock.results[0].value;
      // _doConnect :169-170 注册持久 close/error 各 1。sendToBridge 每次 once error/close,
      // 成功 resolve 后(修复)移除。修复前:12 次累积 → listenerCount 13,触发 MaxListenersExceededWarning(默认 10)。
      expect(sock.listenerCount('error')).toBeLessThan(5);
      expect(sock.listenerCount('close')).toBeLessThan(5);
    });
  });

  describe('P3-6 socket 竞态: 常驻 push handler 与 sendToBridge 临时 handler 交错到达不丢/不串/不误 resolve', () => {
    // 2026-08-07 审查 P0: P3-6 引入的常驻 push data handler 与 sendToBridge 临时 data handler
    // 共享同一 socket 的 EventEmitter 广播。commit 90f065e 的 BLOCKING 修复(resp.id == null 误 resolve)
    // 证明此路径脆弱。本测试守护并发不变量:push 消息(无 id)不误 resolve pending request,
    // response 消息(有 id)不被 push handler 消费。
    it('push 消息先到、response 后到:push handler 被调 + sendToBridge 正确 resolve,不互相消费', async () => {
      const sock = new EventEmitter();
      (sock as any).write = vi.fn((data: string) => {
        let req: { id?: number };
        try { req = JSON.parse(data); } catch { return; }
        if (req.id === 0) {
          queueMicrotask(() => sock.emit('data', Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n')));
          return;
        }
        // 收到 method 请求后,先 emit 无 id 的 push 行,再 emit 有 id 的 response 行
        queueMicrotask(() => {
          const pushLine = JSON.stringify({ method: 'bridge/event', params: { event: 'monitor', data: { fps: 60 } } }) + '\n';
          const respLine = JSON.stringify({ id: req.id, result: { ok: true } }) + '\n';
          sock.emit('data', Buffer.from(pushLine + respLine));
        });
      });
      (sock as any).destroy = vi.fn();
      (sock as any).writable = true;
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });

      const ctx = { projectDir: '/p' } as any;
      // 注册 push handler
      const pushReceived: Record<string, unknown>[] = [];
      registerBridgePushHandler((params) => { pushReceived.push(params); });

      // 发起 sendToBridge 请求(会先 auth id=0,再 method id=1)
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);

      // 断言 1: push handler 被调一次,收到 monitor 事件
      expect(pushReceived.length).toBe(1);
      expect(pushReceived[0]).toMatchObject({ event: 'monitor', data: { fps: 60 } });

      // 断言 2: sendToBridge 正确 resolve(收到 { ok: true } 响应,不是 push 消息)
      const text = (result?.content?.[0] as { text: string }).text;
      expect(text).toMatch(/"ok":\s*true/);
      expect(text).not.toContain('bridge/event');

      // 清理 push handler(防影响后续测试)
      registerBridgePushHandler(null);
    });
  });

  describe('P1-5: TCP 分片 — buffer 累积重组(game-bridge.ts:364 buffer += data)', () => {
    // 2026-08-11 审查 P1-5:TCP 分片/半包/粘包零覆盖。生产 TCP 抖动产生分片,buffer 累积
    // 逻辑(:364 buffer += data,:366 indexOf '\n' 按 \n 切行)回归致请求 hang 但测试全绿。
    // 粘包(push + response 同 chunk)已由 P3-6(:277)覆盖;本块聚焦分片(单 JSON 拆多 chunk)。
    it('response JSON 拆 3 chunk emit 仍正确 resolve(buffer 等末尾 \\n 才 parse)', async () => {
      const authResp = JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n';
      const sock = new EventEmitter();
      (sock as any).write = vi.fn((data: string) => {
        const req = JSON.parse(data);
        if (req.id === 0) {
          queueMicrotask(() => sock.emit('data', Buffer.from(authResp)));
        } else {
          // 分片:methodResp(动态 req.id,对齐 P3-6 范式)拆 3 chunk(前两片无 \n,末片含 \n)
          const methodResp = JSON.stringify({ id: req.id, result: { ok: true } }) + '\n';
          queueMicrotask(() => {
            sock.emit('data', Buffer.from(methodResp.slice(0, 8)));
            sock.emit('data', Buffer.from(methodResp.slice(8, 20)));
            sock.emit('data', Buffer.from(methodResp.slice(20)));
          });
        }
      });
      (sock as any).destroy = vi.fn();
      (sock as any).writable = true;
      mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
        queueMicrotask(() => { if (cb) cb(); });
        return sock;
      });

      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      const text = (result?.content?.[0] as { text: string }).text;
      expect(text).toMatch(/"ok":\s*true/);  // 分片重组后正确 resolve(非 hang/超时)
    });
  });

  describe('P1-8: 废弃 socket 的延迟 close/error 不破坏新 socket (invalidate race)', () => {
    // 复现报告 P1-8 真实 race: A 连上 _socket=A → B _doConnect 入口 _invalidateSocket() destroy A、_socket=null
    // → B 连上 _socket=B → A.destroy() 的 close **异步触发**(此时 _socket 已是 B)→ 持久 close handler 若无守卫
    // 会 _invalidateSocket() destroy B。修复: handler 加 _socket === sock 守卫。
    it('A 被替换后, A 的延迟 close 事件不 invalidate 新 socket B', async () => {
      let sockA!: EventEmitter;
      let createCount = 0;
      mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
        createCount++;
        const sock = new EventEmitter();
        (sock as any).write = vi.fn((data: string) => {
          let req: { id?: number };
          try { req = JSON.parse(data); } catch { return; }
          queueMicrotask(() => {
            const resp = req.id === 0
              ? { id: 0, result: { authenticated: true } }
              : { id: req.id, result: { ok: true } };
            sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
          });
        });
        (sock as any).destroy = vi.fn();  // mock destroy 不自动 emit close(模拟 Node Socket.destroy 的异步 close 需手动 emit)
        (sock as any).writable = true;
        if (createCount === 1) sockA = sock;
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });

      const ctx = { projectDir: '/p' } as any;
      // 1. 连接 A
      await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(createCount).toBe(1);

      // 2. 强制 invalidate A(setBridgeProjectDir 换路径触发 _invalidateSocket → A.destroy + _socket=null)
      setBridgeProjectDir('/__reset__');
      setBridgeProjectDir('/p');

      // 3. 新请求 → _socket null → 连接 B
      await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(createCount).toBe(2);

      // 4. 延迟 emit A 的 close(A.destroy() 的 close 异步触发,此时 _socket 已是 B)
      sockA.emit('close');

      // 5. 新请求: 修复前 B 被 A 延迟 close 错误 invalidate → 新连 C(createCount=3)
      //         修复后 _socket === sockA 守卫拦截 → B 保留 → 复用(createCount 仍 2)
      await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(createCount).toBe(2);  // 关键断言: B 未被 A 的延迟 close 破坏
    });
  });

  // T-1 / I-1 / I-2(原 12 个 path/参数校验测试)已迁移至 game-bridge-validation.test.ts
  // ——抽纯函数 validateBridgePath / validateWaitPropertyParams export,Linux CI 可直接跑(本文件被
  // ci.yml:75 --exclude,Linux 零覆盖)。详见 game-bridge-validation.test.ts 头部缘起说明。

  describe('A4: symlink secret → 权限收紧(icacls/chmod)不得先于拒绝发生', () => {
    // readBridgeSecret 当前顺序 icacls/chmod(副作用) → lstatSync symlink 检查(拒绝)。
    // 若 secretPath 是 symlink 指向受害者文件,icacls/chmod 已篡改其 ACL/mode 才被拒(DoS)。
    // 修复后:lstatSync + symlink 拒绝移到 icacls/chmod 之前,对齐 editor-auth.ts:75-81。
    it('symlink secret: icacls(win32)/chmod(非 win32) 均未被调用 + secret 被拒绝', async () => {
      // 默认 mockRead 返 'test-secret'(模拟成功),但 symlink 检查应在读之前拒绝。
      // 不需 setupBridgeSocket:readBridgeSecret 在 _doConnect 入口同步返 null → 直接抛
      // BridgeNotConnectedError,不到达 createConnection。
      mockLstat.mockReturnValueOnce({ isSymbolicLink: () => true });
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      // symlink 必须被拒绝 → secret=null → BRIDGE_NOT_CONNECTED(不是拿到 secret 后的 ping)
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error_code).toBe('BRIDGE_NOT_CONNECTED');
      // 核心断言:权限收紧副作用未发生(无论平台,修复后 symlink 检查在最前)
      expect(mockExec).not.toHaveBeenCalled();   // win32 icacls
      expect(mockChmod).not.toHaveBeenCalled();  // 非 win32 chmod 0600
      // 且 secret 内容未被读入内存(拒绝在 readFileSync 之前)
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('非 symlink secret: 权限收紧正常执行(回归守护,避免过度拒绝)', async () => {
      // 默认 mockLstat 返 isSymbolicLink:false。校验修复后合法路径仍走 icacls/chmod + 读 secret。
      setupBridgeSocket('result');
      const ctx = { projectDir: '/p' } as any;
      const result = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(result.isError).not.toBe(true);  // secret 正常读到 → ping 成功
      // 合法路径:按平台执行了 icacls 或 chmod 之一(不要求具体哪个,只要至少一个收紧动作发生)
      const tightens = mockExec.mock.calls.length + mockChmod.mock.calls.length;
      expect(tightens).toBeGreaterThan(0);
      expect(mockRead).toHaveBeenCalled();  // secret 被正常读入
    });
  });
});

// ===== isBridgeReady 零接触探测(原 game-bridge-isready)=====

describe('isBridgeReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('test-secret');
    setBridgeProjectDir('/known-project'); // 预设模块 _projectDir,用于零接触断言
  });

  it('auth 成功 → ready=true,且模块缓存零接触', async () => {
    const before = _testBridgeCacheState();
    mockCreate.mockReturnValue(authSuccessSocket());
    const r = await isBridgeReady('/other-project', 1000);
    expect(r.ready).toBe(true);
    expect(_testBridgeCacheState()).toEqual(before); // _projectDir 仍 /known-project,_cachedSecret/_socket 未变
  });

  it('secret 不存在 → ready=false, reason 含 secret not found', async () => {
    mockExists.mockReturnValue(false);
    const r = await isBridgeReady('/p', 100);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('secret not found');
  });

  it('auth 一直不成功 → ready=false, reason 含 did not succeed', async () => {
    mockCreate.mockReturnValue(stuckSocket());
    const r = await isBridgeReady('/p', 300);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('did not succeed');
  });

  it('进程已 killed → 立即短路,不等 timeout', async () => {
    const proc = { killed: true } as any;
    const r = await isBridgeReady('/p', 5000, { proc });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('process exited during probe');
  });

  it('isCancelled=true 且 bridge 不可用 → process exited(不误判 ready)', async () => {
    mockCreate.mockReturnValue(stuckSocket());
    const r = await isBridgeReady('/p', 5000, { isCancelled: () => true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('process exited during probe');
  });

  it('isCancelled=true 但 bridge 仍可用(多 godot/ctx 被另一 proc 覆盖)→ ready,不误报 process exited', async () => {
    mockCreate.mockReturnValue(authSuccessSocket());
    const r = await isBridgeReady('/p', 5000, { isCancelled: () => true });
    expect(r.ready).toBe(true);
  });
});

// ===== P1-3: bridge change_scene 断连 characterization（锁基线，红绿不论）=====
// 背景：vault 待办"测试-P1-3"标 🔴 open 生产 bug。探索确认 bridge 层无 change_scene 实现
// （autoload 不销毁已证），editor 模式 3 条候选根因已修。唯一未证伪假设：大场景 change_scene
// 卡主线程 > 10s timeout。本组锁 TS 侧连接状态机基线（socket 复用/超时 invalidate/自动重连），
// 防回归。真 bridge 模式复现需 weekly GUI 环境（Level 3 deferred）。
describe('P1-3: bridge 连接状态机 characterization（change_scene 断连基线）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('test-secret');
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');
  });

  it('CS-1: 连接成功后第二次 sendToBridge 复用同一 socket（不新建连接）', async () => {
    setupBridgeSocket('result');
    const ctx = { projectDir: '/p' } as any;
    // 第一次调用建立连接（game_query method=ping 在 QUERY_METHODS 白名单内）
    await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    const firstCallCount = mockCreate.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    // 第二次调用应复用 _socket（_ensureConnection :294 条件全真）
    await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    expect(mockCreate.mock.calls.length).toBe(firstCallCount);
  });

  it('CS-2: socket close 后下次 sendToBridge 自动重连（bridge 侧断开后自愈）', async () => {
    // 第一阶段：正常连接
    let currentSock = bridgeSocket('result');
    mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return currentSock;
    });
    const ctx = { projectDir: '/p' } as any;
    const r1 = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    expect(r1.isError).toBeFalsy();
    const callsAfterFirst = mockCreate.mock.calls.length;

    // 模拟 bridge 侧关闭连接（change_scene 后可能触发）
    currentSock.emit('close');
    // _invalidateSocket 应已清 _socket（close handler :401-404）

    // 第二阶段：下次调用应自动重连（_ensureConnection 发现 _socket=null → _doConnect）
    currentSock = bridgeSocket('result');
    const r2 = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(mockCreate.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('CS-3: timeout 后 socket invalidate，下次 sendToBridge 自动重连（change_scene 卡主线程基线）', async () => {
    // 模拟卡住的 bridge：连接成功但 method 请求永不响应（模拟 change_scene 卡主线程）
    const stuckMethodSock = new EventEmitter();
    (stuckMethodSock as any).write = vi.fn((data: string) => {
      let req: { id?: number };
      try { req = JSON.parse(data); } catch { return; }
      if (req.id === 0) {
        // auth 成功
        queueMicrotask(() => stuckMethodSock.emit('data',
          Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n')));
      }
      // id >= 1 的 method 请求不响应（卡住）
    });
    (stuckMethodSock as any).destroy = vi.fn();
    (stuckMethodSock as any).writable = true;
    mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return stuckMethodSock;
    });

    const ctx = { projectDir: '/p' } as any;
    // 用短 timeout 加速：game_query 支持 args.timeout（clampTimeoutMs），设 200ms
    await handleTool('game', { action: 'game_query', method: 'ping', timeout: 200 }, ctx);
    // 关键断言：timeout 后 _testBridgeCacheState().socketNotNull 应为 false（_invalidateSocket 清了 _socket）
    const cache = _testBridgeCacheState();
    expect(cache.socketNotNull, 'timeout 后 _socket 应被 invalidate（socketNotNull=false）').toBe(false);

    // 第二阶段：恢复响应的 socket，下次调用应自动重连
    const goodSock = bridgeSocket('result');
    mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return goodSock;
    });
    const r2 = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    expect(r2.isError).toBeFalsy();
  });

  it('CS-4: 并发请求串行化（_sendLock 链），不并发使用 socket', async () => {
    // 两个几乎同时的请求应串行执行，不并发 write 到同一 socket
    const writtenIds: number[] = [];
    const slowSock = new EventEmitter();
    (slowSock as any).write = vi.fn((data: string) => {
      let req: { id?: number };
      try { req = JSON.parse(data); } catch { return; }
      if (req.id === 0) {
        queueMicrotask(() => slowSock.emit('data',
          Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n')));
      } else if (req.id != null) {
        writtenIds.push(req.id);
        // 延迟响应模拟处理时间
        queueMicrotask(() => slowSock.emit('data',
          Buffer.from(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')));
      }
    });
    (slowSock as any).destroy = vi.fn();
    (slowSock as any).writable = true;
    mockCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return slowSock;
    });

    const ctx = { projectDir: '/p' } as any;
    // 并发发起两个请求（game_query + ping/get_performance 均在 QUERY_METHODS 白名单）
    const p1 = handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    const p2 = handleTool('game', { action: 'game_query', method: 'get_performance' }, ctx);
    await Promise.all([p1, p2]);
    // 两个 method 请求都被 write（串行，但不丢）
    expect(writtenIds.length).toBeGreaterThanOrEqual(2);
  });
});

// ── G-1 (2026-08-14 审查 :935 P1): 订阅断线恢复 — 重连后自动重发 watch/monitor ──
// 根因: GD 侧 mcp_bridge.gd 60s idle 断线(_cleanup_peer_state 清 per-peer 订阅)或 TS 侧
// 请求超时销毁 socket → 重连后无人重发 watch.start/monitor.start → push 事件静默消失、
// watch_poll 返 not watching 无报错。修复: 订阅登记表 + _doConnect 成功后自动重发 + 30s ping keepalive。
describe('G-1: 订阅断线恢复(登记表 + 重连重发 + keepalive)', () => {
  /** 记录型 mock socket:响应所有请求(auth id=0 / method id≥1),writes 记录 method 请求 */
  function recordingBridgeSocket(): { sock: EventEmitter; writes: Array<{ id: number; method: string; params: Record<string, unknown> }> } {
    const writes: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
    const sock = new EventEmitter();
    (sock as any).write = vi.fn((data: string) => {
      let req: { id?: number; method?: string; params?: Record<string, unknown> };
      try { req = JSON.parse(data); } catch { return; }
      if (req.id === 0) {
        queueMicrotask(() => sock.emit('data', Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n')));
        return;
      }
      writes.push({ id: req.id!, method: req.method!, params: req.params ?? {} });
      queueMicrotask(() => sock.emit('data', Buffer.from(JSON.stringify({ id: req.id, result: { watching: true, monitoring: true } }) + '\n')));
    });
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    return { sock, writes };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('test-secret');
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');
  });

  it('watch_start 成功 → 断连 → 重连后 watch.start 自动重发(参数保留)', async () => {
    let current = recordingBridgeSocket();
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return current.sock;
    });
    const ctx = { projectDir: '/p' } as any;

    // 1. 首连 + 订阅成功(登记进登记表)
    const r1 = await handleTool('game', { action: 'watch_start', node_path: '/root/Player', signal_name: 'pressed' }, ctx);
    expect(r1.isError).toBeFalsy();

    // 2. 模拟 bridge 侧断连(close handler → _invalidateSocket)
    current.sock.emit('close');

    // 3. 重连(下次请求触发 _doConnect)
    current = recordingBridgeSocket();
    const r2 = await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
    expect(r2.isError).toBeFalsy();

    // 4. 重发的 watch.start 排队在业务请求之后(经 _sendLock),轮询等待其出现在新 socket 上
    await vi.waitFor(() => {
      const resent = current.writes.filter(w => w.method === 'watch.start');
      expect(resent.length).toBe(1);  // 恰好一次(不重复订阅)
      expect(resent[0].params).toMatchObject({ node_path: '/root/Player', signal_name: 'pressed' });
    });
  });

  it('watch_stop 后断连重连,不再重发 watch.start', async () => {
    let current = recordingBridgeSocket();
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return current.sock;
    });
    const ctx = { projectDir: '/p' } as any;

    await handleTool('game', { action: 'watch_start', node_path: '/root/Player', signal_name: 'pressed' }, ctx);
    await handleTool('game', { action: 'watch_stop' }, ctx);

    current.sock.emit('close');
    current = recordingBridgeSocket();
    await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);

    // 等待潜在重发窗口(重发经微任务+锁排队,给足时间)
    await new Promise(r => setTimeout(r, 100));
    expect(current.writes.filter(w => w.method === 'watch.start')).toHaveLength(0);
  });

  it('monitor_start 成功 → 断连 → 重连后 monitor.start 自动重发', async () => {
    let current = recordingBridgeSocket();
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      queueMicrotask(() => { if (typeof cb === 'function') cb(); });
      return current.sock;
    });
    const ctx = { projectDir: '/p' } as any;

    const r1 = await handleTool('game', { action: 'monitor_start', node_path: '/root/Player', properties: ['position'] }, ctx);
    expect(r1.isError).toBeFalsy();

    current.sock.emit('close');
    current = recordingBridgeSocket();
    await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);

    await vi.waitFor(() => {
      const resent = current.writes.filter(w => w.method === 'monitor.start');
      expect(resent.length).toBe(1);
      expect(resent[0].params).toMatchObject({ node_path: '/root/Player', properties: ['position'] });
    });
  });

  it('可靠性审查P3·可疑(验证固化,d20b1ff 移植): 断线后 keepalive 不构成无限重连循环(守卫拦截)', async () => {
    // 待办场景「A 游戏停 + B 占同端口 → 每 30s 失败 auth 无限循环」静态精读不成立:
    // keepalive interval 守卫 !_socket → return(不发 ping 不重连)。本用例把该结论
    // 测试固化——若未来重构把守卫挪掉成真循环,此处红。
    vi.useFakeTimers();
    try {
      const { sock } = recordingBridgeSocket();
      let connects = 0;
      mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
        connects++;
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;
      await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      expect(connects).toBe(1);  // 连接已建立

      sock.emit('close');  // 游戏停/占端口方接管 → 断线 → _invalidateSocket
      await vi.advanceTimersByTimeAsync(120_000);  // 越过 4 个 keepalive 周期
      await vi.advanceTimersByTimeAsync(0);

      // 断线后 keepalive 不得反复重连(守卫拦截);重连只应由业务调用触发
      expect(connects, '断线后 keepalive 循环重连 = 守卫失效').toBe(1);
    } finally {
      vi.useRealTimers();
      setBridgeProjectDir('/__reset__');
    }
  });

  it('keepalive: 连接空闲 30s → 自动发轻量 ping 刷新游戏侧 idle 计时(防 60s 断连)', async () => {
    vi.useFakeTimers();
    try {
      const { sock, writes } = recordingBridgeSocket();
      mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
        queueMicrotask(() => { if (typeof cb === 'function') cb(); });
        return sock;
      });
      const ctx = { projectDir: '/p' } as any;

      // 业务 ping 一次(建立连接 + 启动 keepalive timer)
      await handleTool('game', { action: 'game_query', method: 'ping' }, ctx);
      const businessPings = writes.filter(w => w.method === 'ping').length;

      // 空闲 30s → keepalive 触发一次轻量 ping
      await vi.advanceTimersByTimeAsync(30_000);
      // 2026-08-21 bridge 客户端拆分到 core/bridge-client 后,tick → sendToBridge 的锁链微任务
      // 依赖真实宏任务轮换才能 drain(fake timers 的 0ms 推进无 timer 时不 yield),
      // 且所需轮换次数对模块内同步代码量敏感(诊断计数器增减即翻转结果)——
      // 固定次数 flush 不可靠,改为真实 timers 下轮询直到 ping 落盘/超时(语义不变:只验证最终发生)
      expect(writes.filter(w => w.method === 'ping').length).toBe(businessPings + 1);
      // 未断连:keepalive ping 成功 → 不应产生第二次连接
      expect(mockCreate.mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── P3-2R (2026-08-12): setBridgeProjectDir in-flight warn 守护 ──────────────
// 审查 P3-2R: setBridgeProjectDir :327-333 inflightDetected warn 是最小修复
// (2026-08-06 加),彻底 per-project socket 是架构级 follow-up。本测试守护最小修复接线
// (防 :327-333 被删不红 = 接线零验证,wiring-zero-verification-test-gap 教训)。
describe('P3-2R: setBridgeProjectDir in-flight warn 守护', () => {
  it('in-flight sendToBridge 时 setBridgeProjectDir 调 warn(守护 :327-333 接线)', async () => {
    const warnSpy = vi.fn();
    const loggerSpy = vi.spyOn(loggerMod, 'getLogger').mockReturnValue({
      info: vi.fn(), debug: vi.fn(), warn: warnSpy, error: vi.fn(), close: vi.fn(),
    });

    // mock socket(防 sendToBridge 真连失败;_sendLock 在 sendToBridge 入口 :422 就 pending)
    const sock = new EventEmitter();
    (sock as any).write = vi.fn();
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => { queueMicrotask(() => cb && cb()); return sock; });

    // 发起 sendToBridge(不 await;同步部分 _sendLock = new Promise pending,run 未 settle)
    const pending = sendToBridge('ping', {}, 100).catch(() => {});

    // setBridgeProjectDir:_sendLock pending → :327 inflightDetected → :328-332 warn
    setBridgeProjectDir('/p2');

    // 断言 warn(删 :327-333 此测试红 = 接线守护生效)
    expect(warnSpy).toHaveBeenCalledWith('bridge', expect.stringMatching(/in-flight/i));

    loggerSpy.mockRestore();
    await pending;
  });

  it('可靠性审查P3(d20b1ff 移植):请求 settle 后 setBridgeProjectDir 不再误报 warn(计数器归零)', async () => {
    // 原 bug:Promise.resolve() === _sendLock 引用比较在首次请求后恒 false → 之后每次
    // setBridgeProjectDir 都误报,监控价值归零。计数器修复后 settle 归零,静默切换。
    const warnSpy = vi.fn();
    const loggerSpy = vi.spyOn(loggerMod, 'getLogger').mockReturnValue({
      info: vi.fn(), debug: vi.fn(), warn: warnSpy, error: vi.fn(), close: vi.fn(),
    });
    try {
      // 用 auth+响应型 socket 让请求完整 settle(写回响应 → run 完成 → finally -- 归零)
      const sock = new EventEmitter();
      (sock as any).write = vi.fn((data: string) => {
        let req: { id?: number };
        try { req = JSON.parse(data); } catch { return; }
        queueMicrotask(() => {
          const resp = req.id === 0
            ? { id: 0, result: { authenticated: true } }
            : { id: req.id, result: { ok: true } };
          sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
        });
      });
      (sock as any).destroy = vi.fn();
      (sock as any).writable = true;
      mockCreate.mockImplementation((_o: unknown, cb?: () => void) => { queueMicrotask(() => cb && cb()); return sock; });

      setBridgeProjectDir('/p3a');
      await sendToBridge('ping', {}, 500);  // 完整跑一轮(连接+auth+请求+响应,settle)
      expect(warnSpy).not.toHaveBeenCalled();  // 空闲时首次切换零 warn

      warnSpy.mockClear();
      setBridgeProjectDir('/p3b');
      expect(warnSpy, 'settle 后切换不得再误报(原实现此处必 warn)').not.toHaveBeenCalled();
    } finally {
      loggerSpy.mockRestore();
      setBridgeProjectDir('/__reset__');
    }
  });
});

// ── M-6/O3 (2026-09-17 架构审查): sync_state 快照 project 维度 ────────────────
// 原实现 SyncSnapshot 无 projectPath/port 字段——同 label 跨项目 snapshot 静默覆盖、
// compare 两个不同项目的快照产出无意义 diff 零警告(host/client 多游戏同 label 场景)。
// 修复:snapshot 记录 getBridgeProjectDir()+解析端口;compare 回显双方 project/port,
// 跨项目置 cross_project:true 警告;同 label 跨项目覆盖时响应带 overwrote 警告。
describe('M-6/O3: sync_state 快照 project 维度(跨项目比对告警)', () => {
  /** collect_state 响应型 socket(每实例状态注入不同 game_time 便于区分)。 */
  function collectStateSocket(gameTime: number): EventEmitter {
    const sock = new EventEmitter();
    (sock as any).write = vi.fn((data: string) => {
      let req: { id?: number; method?: string };
      try { req = JSON.parse(data); } catch { return; }
      queueMicrotask(() => {
        const resp = req.id === 0
          ? { id: 0, result: { authenticated: true } }
          : {
              id: req.id,
              result: {
                instances: { '/root/Main': { _mcp_state: { hp: 100 } } },
                count: 1, game_time_ms: gameTime, collected: ['/root/Main'], truncated: false,
              },
            };
        sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
      });
    });
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    return sock;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('test-secret');
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');
  });

  it('M-6a: snapshot 响应回显 project_path(来源可追溯)', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = collectStateSocket(100);
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const r = await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'a' }, { projectDir: '/p' } as never);
    expect(r?.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain('/p');  // project_path 回显
  });

  it('M-6b: 跨项目 compare → cross_project:true + 警告 + 双方 project 回显', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = collectStateSocket(200);
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const ctxA = { projectDir: '/p' } as never;
    const ctxB = { projectDir: '/q' } as never;
    const ra = await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'a' }, ctxA);
    expect(ra?.isError).not.toBe(true);
    const rb = await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'b' }, ctxB);
    expect(rb?.isError).not.toBe(true);
    const rc = await handleTool('game', { action: 'sync_state', sub_action: 'compare', label_a: 'a', label_b: 'b' }, ctxB);
    expect(rc?.isError).not.toBe(true);
    const parsed = JSON.parse((rc as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.cross_project).toBe(true);          // 跨项目警告标志
    expect(parsed.project_a).toContain('/p');          // 双方来源回显
    expect(parsed.project_b).toContain('/q');
    expect(parsed.cross_project_warning).toMatch(/different projects/i);
  });

  it('M-6c: 同项目 compare(同项目双开 host/client)→ 无 cross_project(主用例不误报)', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = collectStateSocket(300);
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const ctxA = { projectDir: '/p' } as never;
    await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'a' }, ctxA);
    await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'b' }, ctxA);
    const rc = await handleTool('game', { action: 'sync_state', sub_action: 'compare', label_a: 'a', label_b: 'b' }, ctxA);
    const parsed = JSON.parse((rc as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.cross_project).toBeUndefined();  // 同项目不告警
    expect(parsed.project_a).toContain('/p');       // 来源仍回显
  });

  it('M-6d: 同 label 跨项目覆盖 → 响应带 overwrote 警告(静默覆盖消除)', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = collectStateSocket(400);
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const ctxA = { projectDir: '/p' } as never;
    const ctxB = { projectDir: '/q' } as never;
    await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'shared' }, ctxA);
    const r2 = await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'shared' }, ctxB);
    const text = JSON.stringify(r2);
    expect(text).toMatch(/overwrote|different project/i);  // 覆盖警告
  });

  it('M-6e: list 条目含 project_path(快照清单可追溯)', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = collectStateSocket(500);
      queueMicrotask(() => cb && cb());
      return sock;
    });
    await handleTool('game', { action: 'sync_state', sub_action: 'snapshot', label: 'a' }, { projectDir: '/p' } as never);
    const rl = await handleTool('game', { action: 'sync_state', sub_action: 'list' }, { projectDir: '/p' } as never);
    expect(JSON.stringify(rl)).toContain('/p');
  });
});

// ── M-8 (2026-09-17 架构审查): -32601 自动版本比对 ────────────────────────────
// 版本指纹此前只在 game_query ping 直连路径注解;agent 直接调 send_drag 等新命令撞上项目内
// 旧版 mcp_bridge.gd 时只拿到光秃秃的 "Method not found",无版本线索(重装指引只在 GD 文案)。
// 修复:错误路径收到 -32601 时自动补发一次 ping 比对 BRIDGE_SCRIPT_VERSION,把既有
// versionWarning 逻辑的结果拼进错误文案;版本一致(命令真不存在)不追加。
describe('M-8: -32601 自动版本比对(非 ping 路径也能看到旧版指引)', () => {
  /** 按 method 分派响应的 socket:send_drag → -32601;ping → 带 bridgeVersion。 */
  function dispatchSocket(remoteVersion: string): EventEmitter {
    const sock = new EventEmitter();
    (sock as any).write = vi.fn((data: string) => {
      let req: { id?: number; method?: string };
      try { req = JSON.parse(data); } catch { return; }
      queueMicrotask(() => {
        if (req.id === 0) {
          sock.emit('data', Buffer.from(JSON.stringify({ id: 0, result: { authenticated: true } }) + '\n'));
          return;
        }
        if (req.method === 'ping') {
          sock.emit('data', Buffer.from(JSON.stringify({
            id: req.id, result: { ok: true, bridgeVersion: remoteVersion },
          }) + '\n'));
          return;
        }
        sock.emit('data', Buffer.from(JSON.stringify({
          id: req.id, error: { code: -32601, message: 'Method not found' },
        }) + '\n'));
      });
    });
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    return sock;
  }
  const CTX = { projectDir: '/p', opsScript: '/scripts/ops.gd' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    // bundled mcp_bridge.gd 版本 0.33.7(其余路径照旧回 secret)
    mockRead.mockImplementation((p: unknown) =>
      String(p).includes('mcp_bridge.gd')
        ? 'const BRIDGE_SCRIPT_VERSION := "0.33.7"\n'
        : 'test-secret');
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');
  });
  afterEach(() => {
    mockRead.mockReturnValue('test-secret');
  });

  it('M-8a: 直连路径(game_input send_drag)遇 -32601 + 远端旧版 → 错误文案内嵌 versionWarning', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = dispatchSocket('0.30.0');  // 项目内旧版拷贝
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const r = await handleTool('game', { action: 'game_input', method: 'send_drag', params: {} }, CTX);
    expect(r?.isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toContain('Bridge error (-32601)');
    expect(text).toMatch(/versionWarning|outdated copy/);       // 版本警告拼进文案
    expect(text).toMatch(/game_bridge_install with force: true/); // 可操作指引
  });

  it('M-8b: bridgeAction 路径(custom_command 未声明)同样内嵌 versionWarning', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = dispatchSocket('0.30.0');
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const r = await handleTool('game', { action: 'custom_command', method: 'custom.nope' }, CTX);
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/outdated copy/);
  });

  it('M-8c: 远端版本与 bundled 一致(命令真不存在)→ 不追加 versionWarning(防噪音)', async () => {
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      const sock = dispatchSocket('0.33.7');  // 版本一致
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const r = await handleTool('game', { action: 'game_input', method: 'send_drag', params: {} }, CTX);
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/outdated copy/);
  });

  it('M-8d: 非 -32601 错误(auth -32001)不触发探测 ping(错误路径不加延迟)', async () => {
    const sock = new EventEmitter();
    let pingSent = false;
    (sock as any).write = vi.fn((data: string) => {
      let req: { id?: number; method?: string };
      try { req = JSON.parse(data); } catch { return; }
      if (req.method === 'ping') pingSent = true;
      queueMicrotask(() => {
        const resp = req.id === 0
          ? { id: 0, result: { authenticated: true } }
          : { id: req.id, error: { code: -32001, message: 'auth required' } };
        sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
      });
    });
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      queueMicrotask(() => cb && cb());
      return sock;
    });
    const r = await handleTool('game', { action: 'game_input', method: 'send_drag', params: {} }, CTX);
    expect(r?.isError).toBe(true);
    expect(pingSent).toBe(false);  // -32001 不探测
  });
});

// ── Task 4.4 (2026-09-17 架查 Low): _doConnect 端口单次解析 —— secret 与 TCP 同源 ──
// 修复前 secret 读取(findBridgeSecretPath)与 TCP 连接各自调一次 resolveBridgePort,两次
// 解析间隙 registry 变化会 secret 读 A 端口、TCP 连 B 端口(auth 必败)。修复后单次解析传参。
// 注:两形态在静态 registry 下行为一致,本测试是"secret 路径与连接端口配对"的回归锁
// (未来任何人把两次解析改回来,若配对被破坏即可经此断言暴露),非时序红绿测试。
describe('Task 4.4: _doConnect 端口单次解析(secret 读取与 TCP 连接同端口)', () => {
  it('4.4e: registry 命中 9082 → secret 读 mcp_bridge_9082.secret 且 createConnection 连 9082', async () => {
    // 经 mockReaddir/mockRead 提供伪 registry(fs 全 mock,不落盘):项目 '/p' 心跳端口 9082
    const entryJson = JSON.stringify({
      id: 'inst_1', projectPath: '/p', port: 9082, pid: 1,
      lastSeenMs: Date.now() - 1_000,
      lastSeen: new Date(Date.now() - 1_000).toISOString(),
      capabilities: ['registry-heartbeat'],
    });

    vi.clearAllMocks();
    mockExists.mockReturnValue(true);
    mockReaddir.mockImplementation((p: unknown) =>
      String(p).includes('fake-registry') ? ['inst_1.json'] : []);
    mockRead.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes('inst_1.json')) return entryJson;
      if (s.includes('mcp_bridge.gd')) return 'const BRIDGE_SCRIPT_VERSION := "0.33.7"\n';
      return 'test-secret';
    });
    process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = '/fake-registry';
    setBridgeProjectDir('/__reset__');
    setBridgeProjectDir('/p');

    const sock = new EventEmitter();
    (sock as any).write = vi.fn((data: string) => {
      let req: { id?: number };
      try { req = JSON.parse(data); } catch { return; }
      queueMicrotask(() => {
        const resp = req.id === 0
          ? { id: 0, result: { authenticated: true } }
          : { id: req.id, result: { ok: true } };
        sock.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
      });
    });
    (sock as any).destroy = vi.fn();
    (sock as any).writable = true;
    mockCreate.mockImplementation((_o: unknown, cb?: () => void) => {
      queueMicrotask(() => cb && cb());
      return sock;
    });

    try {
      const r = await handleTool('game', { action: 'game_query', method: 'ping' }, { projectDir: '/p' } as never);
      expect(r?.isError).not.toBe(true);

      // 配对断言:TCP 连的是 registry 解析端口 9082
      const connectOpts = mockCreate.mock.calls.at(-1)?.[0] as { port?: number };
      expect(connectOpts?.port).toBe(9082);
      // secret 读取路径与连接端口同源(9082 的 secret,而非另一次解析的产物)
      const secretReadPaths = mockRead.mock.calls.map(c => String(c[0]));
      expect(secretReadPaths.some(p => p.includes('mcp_bridge_9082.secret'))).toBe(true);
      expect(secretReadPaths.some(p => /mcp_bridge_90[0-9]\.secret/.test(p) && !p.includes('9082'))).toBe(false);
    } finally {
      delete process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
      mockRead.mockReturnValue('test-secret');
    }
  });
});
