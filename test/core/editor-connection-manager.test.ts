// test/core/editor-connection-manager.test.ts
//
// A-2 (2026-08-14 findings :936): 并发 manage_tools(reconnect) 竞态修复测试。
// 根因: 并发两次 rebuild 无 in-flight 锁 ——
//   败者 establish 的 catch `this.conn=null` 误清纯者刚建的新 conn
//   → 胜者 verifyProject 假 mismatch "(no connection)"(:284)
//   → :176 `this.conn.disconnect()` 在 null 上 TypeError 被吞
//   → 胜者 ws 保持 OPEN 无人断(占 MAX_PEERS 槽 + 僵尸重连)。
// 修复: ①rebuild 加 _rebuildPromise in-flight 去重(对齐 game-bridge _connectionLock);
//       ②establish 清理(catch/mismatch)仅在 this.conn === 本次新建 conn 才执行。
// 本文件是 mock 层(vi.mock EditorConnection + editor-auth);
// A-3 真连接集成链(secret 轮换→rebuild 恢复)见 editor-connection-manager-recovery.test.ts。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EditorConnection } from '../../src/core/EditorConnection.js';
import type { EditorConnectionHost } from '../../src/core/EditorConnectionManager.js';

// ─── mock 基建 ───────────────────────────────────────────────────────────────

/** establish 内部 new EditorConnection 产生的 mock 实例(hoisted 供 vi.mock factory 写入)。 */
const mockInstances = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** establish 内部调 conn.connect() 时从队首取 Promise(空则立即 resolve)——手动控制 in-flight 时序。 */
const connectQueue = vi.hoisted(() => [] as Array<Promise<void>>);

/** 手动 defer 工具(控制 connect() 的 settle 时机)。 */
function defer(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

vi.mock('../../src/core/EditorConnection.js', () => ({
  EditorConnection: class {
    connect = vi.fn((): Promise<void> => {
      const queued = connectQueue.shift();
      return queued ?? Promise.resolve();
    });
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);
    request = vi.fn(async () => ({ project_path: 'D:/proj/fixture' }));
    addOnReconnectExhaustedHandler = vi.fn();
    addOnReconnectHandler = vi.fn();
    addOnDisconnectHandler = vi.fn();
    removeOnDisconnectHandler = vi.fn();
    removeOnReconnectHandler = vi.fn();
    /** C4: establish 构造参数透传断言用——捕获 constructor opts 供测试读取。 */
    constructorOpts: unknown = null;
    constructor(opts: unknown) {
      this.constructorOpts = opts;
      mockInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock('../../src/core/editor-auth.js', () => ({
  waitForEditorSecret: vi.fn(async () => 'mock-secret'),
}));

import { waitForEditorSecret } from '../../src/core/editor-auth.js';
import { EditorConnectionManager } from '../../src/core/EditorConnectionManager.js';

const PROJECT = 'D:/proj/fixture';

function makeHost(): EditorConnectionHost {
  return {
    dispatcher: {
      getHealthMonitor: vi.fn(() => null),
      setEditorExecutor: vi.fn(),
      markEditorFallback: vi.fn(),
      degradeToHeadless: vi.fn(),
      setConnectionMode: vi.fn(),
    },
    sendLoggingMessage: vi.fn(),
    onConnected: vi.fn(),
    onDegrade: vi.fn(),
  } satisfies EditorConnectionHost;
}

function makeManager(): EditorConnectionManager {
  return new EditorConnectionManager(makeHost(), {
    port: 12345,
    projectPath: PROJECT,
    noFallback: false,
  });
}

/** 绕过 TS private(编译期)直接调 establish —— ownership 场景需外部控制 in-flight 时序。 */
type EstablishFn = (port: number, secret: string) => Promise<{ connected: boolean; detail: string }>;
function callEstablish(mgr: EditorConnectionManager): Promise<{ connected: boolean; detail: string }> {
  return (mgr as unknown as { establish: EstablishFn }).establish(12345, 's');
}
function setConn(mgr: EditorConnectionManager, conn: EditorConnection): void {
  (mgr as unknown as { conn: unknown }).conn = conn;
}

// ─── 测试 ────────────────────────────────────────────────────────────────────

describe('EditorConnectionManager A-2: 并发 rebuild 竞态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
    connectQueue.length = 0;
  });

  it('并发两次 rebuild() 去重为单次 in-flight establish(不重复读 secret/建连接/互断)', async () => {
    const mgr = makeManager();
    const pA = mgr.rebuild();
    const pB = mgr.rebuild();

    // 同一 in-flight Promise(第二次调用共享第一次的结果,不再启动第二个 establish)
    expect(pB).toBe(pA);

    const [ra, rb] = await Promise.all([pA, pB]);
    expect(ra.connected).toBe(true);
    expect(rb).toEqual(ra);

    // 只有一次 secret 读取 + 一次连接建立
    // (修复前: 两次调用各跑一遍,第二次 establish 入口还会 disconnect 第一次的 conn)
    expect(waitForEditorSecret).toHaveBeenCalledTimes(1);
    expect(mockInstances).toHaveLength(1);

    // 胜者 conn 存活且未被断开
    const conn = mockInstances[0] as unknown as { disconnect: ReturnType<typeof vi.fn> };
    expect(mgr.getConn()).toBe(conn);
    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('establish 失败(catch)仅当 this.conn 仍是本次新建的 conn 才清(不误清并发新 conn)', async () => {
    const mgr = makeManager();
    const d = defer();
    connectQueue.push(d.promise); // connA.connect() 挂起

    const p = callEstablish(mgr);
    // establish 已同步执行到 await connA.connect(): this.conn === 实例0
    const connA = mockInstances[0] as unknown as { disconnect: ReturnType<typeof vi.fn> };
    expect(mgr.getConn()).toBe(connA);

    // 模拟并发场景:另一路已把 this.conn 换成更新的 connB(胜者)
    const connB = {
      disconnect: vi.fn(),
      isConnected: () => true,
    } as unknown as EditorConnection;
    setConn(mgr, connB);

    // connA 连接失败 → catch。
    // 修复前: `this.conn = null` 误清 connB → 胜者 verifyProject 假 mismatch "(no connection)"。
    d.reject(new Error('boom'));
    const r = await p;
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('boom');

    // 胜者 connB 不被误清、不被断开(修复前 getConn()===null)
    expect(mgr.getConn()).toBe(connB);
    expect((connB as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).not.toHaveBeenCalled();
  });

  it('verifyProject mismatch 断开的是本次新建的 conn,不动并发替换进来的新 conn', async () => {
    const mgr = makeManager();
    const d = defer();
    connectQueue.push(d.promise);

    const p = callEstablish(mgr);
    const connA = mockInstances[0] as unknown as { disconnect: ReturnType<typeof vi.fn> };
    expect(mgr.getConn()).toBe(connA);

    // 并发替换: this.conn=connB,其 request 返回别的项目 → verifyProject(:284 经 this.conn) mismatch
    const connB = {
      disconnect: vi.fn(),
      isConnected: () => true,
      request: vi.fn(async () => ({ project_path: 'D:/other/project' })),
    } as unknown as EditorConnection;
    setConn(mgr, connB);

    // connA connect 成功 → verifyProject(经 this.conn=connB)→ mismatch
    d.resolve();
    const r = await p;
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('mismatch');

    // 败者 connA 自己被断开(修复前: disconnect 的是 this.conn=connB,connA 的 ws 孤儿)
    expect(connA.disconnect).toHaveBeenCalledTimes(1);
    // 胜者 connB 不被断开、不被清(修复前: connB.disconnect 被调 + this.conn=null)
    expect((connB as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).not.toHaveBeenCalled();
    expect(mgr.getConn()).toBe(connB);
  });
});

// ─── C4: editor requestTimeout env 可配（反馈 2026-11-11，30s 硬超时收口）────
// 定谳背景：stdio 主路径 deadline 本就是 1h（GODOT_MCP_TOOL_DEADLINE_MS），
// 真实 30s 硬编码之一是 EditorConnection requestTimeoutMs 默认 30000——
// EditorConnectionManager.establish 构造时漏传 requestTimeout，env 无法覆盖。
// 修复：establish 透传 readPositiveIntEnv('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS', 30000)。
describe('C4: GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS → establish 透传 requestTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
    connectQueue.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** 跑一次 establish，返回捕获的 constructor opts（含 requestTimeout）。 */
  async function establishOpts(): Promise<Record<string, unknown>> {
    const mgr = makeManager();
    await callEstablish(mgr);
    expect(mockInstances).toHaveLength(1);
    return mockInstances[0]!.constructorOpts as Record<string, unknown>;
  }

  it('env 设 60000 → requestTimeout=60000 透传给 EditorConnection', async () => {
    vi.stubEnv('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS', '60000');
    const opts = await establishOpts();
    expect(opts.requestTimeout).toBe(60000);
  });

  it('env 未设 → 默认 30000（行为兼容）', async () => {
    vi.stubEnv('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS', undefined);
    const opts = await establishOpts();
    expect(opts.requestTimeout).toBe(30000);
  });

  it('env 非法值 → 回落 30000 + console.warn 一行提示', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });
    vi.stubEnv('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS', 'not-a-number');
    const opts = await establishOpts();
    expect(opts.requestTimeout).toBe(30000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0])).toContain('GODOT_MCP_EDITOR_REQUEST_TIMEOUT_MS');
  });
});
