// test/qa-tasks-wire.test.ts — PR-2 Task 3: GodotServer tasks wire 层全链
//
// 真实 SDK + InMemoryTransport(照 K-2 Part 2 先例;仓库无 @modelcontextprotocol/client
// 直接依赖,客户端侧手写 initialize 握手声明 clientCapabilities.tasks)。不 mock SDK——
// 本测试的价值恰在真实分发层:capabilities 回显 / 字符串 method 路由 / handler 抛错转
// JSON-RPC error / notification 直达客户端 transport。
//
// 实测锚点(2026-08-17,SDK 2.x):
// - Server.prototype.notification(...)(无 sendNotification);声明 tasks capability 后
//   直发 notifications/tasks/status 不被 assertNotificationCapability 拦,客户端可收。
// - tasks/* 未注册时 SDK 分发层返回 -32601(era 门控兜底);已注册字符串 method 优先分发。
// - 3 参 schema 重载:缺 taskId → SDK 自动 -32602;handler 抛普通 Error → -32603(消息保留)。
// - 测试不依赖 tools/call qa run(会真跑 bridge;全链留 Task 4)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GodotServer } from '../src/GodotServer.js';
import { registerRun, updateProgress, finishRun, clearRegistry } from '../src/tools/qa/registry.js';
import { AUDIT_LOG_REL } from '../src/core/audit-log.js';
// guard(token)是进程级模块单例:GodotServer.close() 会 cleanup() 置 _shutdown=true,
// 同文件内先跑的 T3 用例 finally { gs.close() } 会关掉它 → 后续 createPendingToken 抛
// InternalError('Token system has been shut down')。resetState() 是 guard.ts 预留的
// 测试隔离钩子(注释:Allow restart after test reset)。
import { resetState as resetTokenState } from '../src/core/guard.js';

// PR-2 Task 4：qa run 经 dispatcher 会真跑 bridge（runQaSuite 装 bridge + 起游戏）。
// 同 qa-index.test.ts 惯例 mock runner——集成价值在 wire 层（capabilities 协商 → dispatcher
// → ctx.taskAugmented → qa index 分流 → _meta.relatedTask 上 wire），不在执行链。
// 现有 T3 用例只触 registry/tasks handler，不调 runner，mock 对其零影响。
vi.mock('../src/tools/qa/runner.js', () => ({
  runQaSuite: vi.fn(),
}));

import { runQaSuite } from '../src/tools/qa/runner.js';
import type { QaReport } from '../src/tools/qa/report.js';

// ─── 测试侧最小 JSON-RPC 客户端(手写握手,替代 SDK Client) ───────────────────

interface JsonRpcResponse { result?: unknown; error?: { code: number; message: string } }
interface WireNotification { method: string; params?: Record<string, unknown> }

interface TestClient {
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  notifications: WireNotification[];
}

/**
 * 起真实 GodotServer + InMemoryTransport,完成 initialize 握手。
 * clientCapabilities 声明形态由调用方控制(tasks 能力门控测试的关键)。
 */
async function startServer(clientCapabilities?: Record<string, unknown>): Promise<{ gs: GodotServer; tc: TestClient }> {
  const gs = new GodotServer('/fake/ops.gd');
  const server = (gs as unknown as { server: Server }).server;
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);

  // T3 审查 Minor-3 前置警告修复（Task 4 落实）：response 按 id 匹配（顺序无关，并发在途
  // 不错配）；server→client request（有 id 有 method，如 elicitation/create）分流应答
  // -32601，不当 response resolve 也不悬挂 SDK 侧 promise；notification（无 id 有 method）收集。
  const pending = new Map<number, (m: unknown) => void>();
  const notifications: WireNotification[] = [];
  cT.onmessage = (m: unknown) => {
    const msg = m as { id?: number; method?: string };
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        void cT.send({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: `test client has no handler: ${msg.method}` },
        } as never).catch(() => { /* best-effort */ });
      } else {
        notifications.push(msg as WireNotification); // server→client notification（无 id）
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve?.(m); // response：按 id 匹配 resolve
    }
  };

  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve as (m: unknown) => void);
      void cT.send({ jsonrpc: '2.0', id, method, params } as never);
    });

  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: clientCapabilities ?? {},
    clientInfo: { name: 'tasks-wire-test', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  await cT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  return { gs, tc: { request, notifications } };
}

// ─── 测试 ────────────────────────────────────────────────────────────────────

describe('tasks wire layer(PR-2 Task 3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearRegistry();
    delete process.env.GODOT_MCP_AUDIT; // 默认开(isAuditEnabled: undefined → true)
    tmpDir = mkdtempSync(join(tmpdir(), 'qa-tasks-wire-'));
  });

  afterEach(() => {
    clearRegistry();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initialize 后 server capabilities 含 tasks(细粒度 list/cancel/requests.tools.call)', async () => {
    const { gs, tc } = await startServer();
    try {
      const init = await tc.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 're-init', version: '1.0.0' },
      });
      const caps = (init.result as { capabilities?: { tasks?: unknown } }).capabilities;
      expect(caps?.tasks).toEqual({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
    } finally {
      await gs.close();
    }
  });

  it('tasks/list 返回注册表条目(wire 五字段,ttl 秒)', async () => {
    const { gs, tc } = await startServer();
    try {
      registerRun('run-list-1', 'suite-x', tmpDir, 3);
      const res = await tc.request('tasks/list');
      const tasks = (res.result as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
      expect(tasks).toHaveLength(1);
      const t = tasks[0]!;
      expect(t.taskId).toBe('run-list-1');
      expect(t.status).toBe('working');
      expect(t.ttl).toBe(3600); // registry 3_600_000ms → wire 秒
      expect(typeof t.createdAt).toBe('string');
      expect(typeof t.lastUpdatedAt).toBe('string');
    } finally {
      await gs.close();
    }
  });

  it('tasks/get:working 带 statusMessage;终态 status 直映', async () => {
    const { gs, tc } = await startServer();
    try {
      registerRun('run-get-1', 'suite-x', tmpDir, 3);
      updateProgress('run-get-1', 1, 3, 'wait_for_node');
      const working = await tc.request('tasks/get', { taskId: 'run-get-1' });
      expect(working.error).toBeUndefined();
      expect((working.result as { status?: string }).status).toBe('working');
      expect((working.result as { statusMessage?: string }).statusMessage).toBe('step 1/3: wait_for_node');

      finishRun('run-get-1', 'completed');
      const done = await tc.request('tasks/get', { taskId: 'run-get-1' });
      expect((done.result as { status?: string }).status).toBe('completed');
      expect((done.result as { statusMessage?: string }).statusMessage).toBeUndefined();
    } finally {
      await gs.close();
    }
  });

  it('tasks/get 未知 taskId → JSON-RPC error(code/-32603,消息含 taskId);缺 taskId → SDK 校验 -32602', async () => {
    const { gs, tc } = await startServer();
    try {
      const notFound = await tc.request('tasks/get', { taskId: 'no-such-task' });
      expect(notFound.error).toBeDefined();
      expect(notFound.error!.code).toBe(-32603); // SDK 默认:handler 抛普通 Error → internal error
      expect(notFound.error!.message).toContain('no-such-task');

      const missingParam = await tc.request('tasks/get', {});
      expect(missingParam.error!.code).toBe(-32602); // 3 参 schema 重载:SDK zod 校验
      expect(missingParam.error!.message).toContain('taskId');
    } finally {
      await gs.close();
    }
  });

  it('tasks/cancel working → ok(taskId 回显,仍 working);且写 audit line(action:"tasks/cancel")', async () => {
    const { gs, tc } = await startServer();
    try {
      registerRun('run-cancel-1', 'suite-x', tmpDir, 2);
      const res = await tc.request('tasks/cancel', { taskId: 'run-cancel-1' });
      expect(res.error).toBeUndefined();
      expect((res.result as { taskId?: string }).taskId).toBe('run-cancel-1');
      // cancel 置 cancelRequested,不改 status(cancelled 由终态通知送)→ wire 仍 working
      expect((res.result as { status?: string }).status).toBe('working');

      const auditPath = join(tmpDir, ...AUDIT_LOG_REL);
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      expect(entry.action).toBe('tasks/cancel');
      expect(entry.tool).toBe('qa');
      expect(entry.ok).toBe(true);
      expect(entry.trace_id).toContain('run-cancel-1');
    } finally {
      await gs.close();
    }
  });

  it('tasks/cancel 终态/未知 → JSON-RPC error', async () => {
    const { gs, tc } = await startServer();
    try {
      registerRun('run-cancel-2', 'suite-x', tmpDir, 2);
      finishRun('run-cancel-2', 'completed');
      const terminal = await tc.request('tasks/cancel', { taskId: 'run-cancel-2' });
      expect(terminal.error).toBeDefined();
      expect(terminal.error!.message).toContain('不可取消');

      const unknown = await tc.request('tasks/cancel', { taskId: 'no-such-task' });
      expect(unknown.error).toBeDefined();
      expect(unknown.error!.message).toContain('no-such-task');
    } finally {
      await gs.close();
    }
  });

  it('tasks/result:终态返回 payload(run_id/summary/error);working → error', async () => {
    const { gs, tc } = await startServer();
    try {
      registerRun('run-result-1', 'suite-x', tmpDir, 2);
      const working = await tc.request('tasks/result', { taskId: 'run-result-1' });
      expect(working.error).toBeDefined();
      expect(working.error!.message).toContain('not terminal');

      finishRun('run-result-1', 'failed', undefined, undefined, 'boom: suite 执行异常');
      const done = await tc.request('tasks/result', { taskId: 'run-result-1' });
      expect(done.error).toBeUndefined();
      const payload = (done.result as { payload?: Record<string, unknown> }).payload;
      expect(payload!.run_id).toBe('run-result-1');
      expect(payload!.error).toBe('boom: suite 执行异常');
    } finally {
      await gs.close();
    }
  });

  it('终态通知:客户端声明 tasks 能力 → finishRun 触发 notifications/tasks/status(五字段)', async () => {
    const { gs, tc } = await startServer({ tasks: { listChanged: true } });
    try {
      registerRun('run-notify-1', 'suite-x', tmpDir, 2);
      finishRun('run-notify-1', 'completed');
      await new Promise((r) => setTimeout(r, 50)); // 等 notification 异步派发

      const notes = tc.notifications.filter((n) => n.method === 'notifications/tasks/status');
      expect(notes).toHaveLength(1);
      const p = notes[0]!.params!;
      expect(p.taskId).toBe('run-notify-1');
      expect(p.status).toBe('completed');
      expect(p.ttl).toBe(3600);
      expect(typeof p.createdAt).toBe('string');
      expect(typeof p.lastUpdatedAt).toBe('string');
    } finally {
      await gs.close();
    }
  });

  it('终态通知:未声明 tasks 能力的客户端 → 不发(协议门控)', async () => {
    const { gs, tc } = await startServer(); // 无 clientCapabilities.tasks
    try {
      registerRun('run-notify-2', 'suite-x', tmpDir, 2);
      finishRun('run-notify-2', 'completed');
      await new Promise((r) => setTimeout(r, 50));
      expect(tc.notifications.filter((n) => n.method === 'notifications/tasks/status')).toHaveLength(0);
    } finally {
      await gs.close();
    }
  });

  it('无 tasks 能力客户端的现状零破坏:tools/list 照旧返回工具清单', async () => {
    const { gs, tc } = await startServer(); // 无 tasks 能力声明
    try {
      const res = await tc.request('tools/list');
      expect(res.error).toBeUndefined();
      const tools = (res.result as { tools?: Array<{ name: string }> }).tools ?? [];
      expect(tools.length).toBeGreaterThan(0); // 工具清单照常可列
    } finally {
      await gs.close();
    }
  });
});

// ─── PR-2 Task 4：taskAugmented 自动 async（客户端能力协商 → _meta.relatedTask）──────

describe('taskAugmented 自动 async（PR-2 Task 4）', () => {
  let tmpDir: string;
  let reportsDir: string;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
  const prevReportsDir = process.env.GODOT_MCP_QA_REPORTS_DIR;
  const prevUnsafeConfirm = process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM;

  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  beforeEach(() => {
    clearRegistry();
    resetTokenState(); // 见 import 处注释:恢复同文件先跑用例 close() 关掉的 token 系统
    tmpDir = mkdtempSync(join(tmpdir(), 'qa-task4-'));
    reportsDir = mkdtempSync(join(tmpdir(), 'qa-task4-reports-'));
    process.env.ALLOWED_PROJECT_PATHS = tmpDir;
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportsDir;
    // qa run 的 risk='process' 过 confirm 门（guard.ts requiresConfirmation）→ 返回
    // confirmation_token。confirm_and_execute 在此降级下免 elicitation 直接执行（CI/测试
    // 可信环境语义，ToolDispatcher I-2）；手写客户端无法应答 server→client elicitation。
    process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM = 'true';
    vi.mocked(runQaSuite).mockReset();
  });

  afterEach(() => {
    clearRegistry();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(reportsDir, { recursive: true, force: true });
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
    else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    if (prevReportsDir === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
    else process.env.GODOT_MCP_QA_REPORTS_DIR = prevReportsDir;
    if (prevUnsafeConfirm === undefined) delete process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM;
    else process.env.GODOT_MCP_ALLOW_UNSAFE_CONFIRM = prevUnsafeConfirm;
  });

  function fakeReport(runId: string, name: string, projectPath: string, status: 'PASSED' | 'CANCELLED'): QaReport {
    const cancelled = status === 'CANCELLED';
    return {
      version: 1,
      run_id: runId,
      suite: { name, project_path: projectPath, started_at: new Date().toISOString(), spec_source: 'inline' },
      options: {},
      summary: { total: 1, passed: cancelled ? 0 : 1, failed: 0, errors: 0, skipped: cancelled ? 1 : 0, status, duration_ms: 5 },
      steps: [
        cancelled
          ? { index: 0, label: 's1', type: 'sleep', status: 'SKIPPED' as const, elapsed_ms: 0, skip_reason: 'cancelled by user' }
          : { index: 0, label: 's1', type: 'sleep', status: 'PASSED' as const, elapsed_ms: 2 },
      ],
    };
  }

  /** tools/call 返回的 CallToolResult 首个 text block 的 JSON（dispatcher 会附加 _duration_ms block） */
  function firstJson(res: unknown): Record<string, unknown> {
    const r = res as { content?: Array<{ type: string; text: string }> };
    return JSON.parse(r.content![0]!.text) as Record<string, unknown>;
  }

  /** qa run 两步走：confirm 门拿 token → confirm_and_execute（降级）真执行，返回执行结果。 */
  async function runQaViaConfirm(tc: TestClient['request'], spec: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c1 = await tc('tools/call', {
      name: 'qa',
      arguments: { action: 'run', spec, project_path: tmpDir },
    });
    expect(c1.error).toBeUndefined();
    const j1 = firstJson(c1.result);
    expect(j1.requires_confirmation).toBe(true); // risk='process' 过 confirm 门
    const c2 = await tc('tools/call', {
      name: 'confirm_and_execute',
      arguments: { token: j1.confirmation_token },
    });
    expect(c2.error).toBeUndefined();
    return c2.result as Record<string, unknown>;
  }

  it('声明 tasks 能力的客户端：qa run → 立即返回 + _meta.relatedTask.taskId = run_id；tasks/get 轮询到终态', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) => {
      await sleep(2000); // 模拟慢套件：async 分流应在完成前返回
      return fakeReport(runIdOverride!, suite.name, tmpDir, 'PASSED');
    });
    const { gs, tc } = await startServer({ tasks: { listChanged: true } });
    try {
      const t0 = Date.now();
      const result = await runQaViaConfirm(tc.request, { name: 'task4-auto', steps: [{ type: 'sleep', ms: 100 }] });
      // 未等后台套件完成就返回。阈值要明显小于上面模拟的套件时长才有区分力(实现若改成等套件
      // 完成再返回,耗时 ≥ 套件时长);同时要给机器负载留余量——原阈值与套件时长同为 150ms,
      // 零余量,全量并发下事件循环停顿一次就误报(2026-11-25 全量实测 159ms,超订阅复现 403ms)。
      expect(Date.now() - t0).toBeLessThan(1000);

      const j = firstJson(result);
      expect(j.success).toBe(true);
      const data = j.data as { run_id: string; status: string };
      expect(data.status).toBe('working'); // taskAugmented → 自动 async（未传 mode）

      // 验收核心：wire 上 result._meta.relatedTask.taskId === content JSON 里 data.run_id
      const meta = (result as { _meta?: Record<string, unknown> })._meta;
      const rel = (meta?.relatedTask ?? {}) as { taskId?: string; status?: string };
      expect(rel.taskId).toBe(data.run_id);
      expect(rel.status).toBe('working');
      // 3c 实测锚点：G2 展开透传——dispatcher healthSample after 用 {...result._meta,
      // trace_id, duration_ms}，relatedTask（未知键）与 G2 键共存于同一 _meta 对象
      expect(typeof meta?.trace_id).toBe('string');
      expect(typeof meta?.duration_ms).toBe('number');

      // tasks/get 轮询至 completed（同一 taskId）
      const deadline = Date.now() + 10_000;
      for (;;) {
        const g = await tc.request('tasks/get', { taskId: data.run_id });
        expect(g.error).toBeUndefined();
        const status = (g.result as { status?: string }).status;
        if (status === 'completed') break;
        if (Date.now() > deadline) throw new Error(`task ${data.run_id} 未在 10s 内到 completed（last: ${String(status)}）`);
        await sleep(50);
      }
    } finally {
      await gs.close();
    }
  });

  it('未声明 tasks 能力的客户端：qa run → sync 现状（无 _meta.relatedTask，响应结构同 PR-1b）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, tmpDir, 'PASSED'));
    const { gs, tc } = await startServer(); // 无 clientCapabilities.tasks
    try {
      const result = await runQaViaConfirm(tc.request, { name: 'task4-sync', steps: [{ type: 'sleep', ms: 100 }] });
      const j = firstJson(result);
      expect(j.success).toBe(true);
      const data = j.data as Record<string, unknown>;
      // sync 响应结构（PR-1b 回归红线）：summary 在 data 上，无 status:'working' 快照
      expect((data.summary as { status?: string }).status).toBe('PASSED');
      const meta = (result as { _meta?: { relatedTask?: unknown } })._meta;
      expect(meta?.relatedTask).toBeUndefined(); // 未声明能力 → 不回指
      expect(typeof meta?.trace_id).toBe('string'); // G2 _meta 照常（既有行为零变化）
    } finally {
      await gs.close();
    }
  });
});

// ── PR-2 Task 5: era 门控断言(N-8 以 SDK 版本锁形式固化)──────────────────
// SDK 的 era 编解码:2026-07-28 客户端的 tasks/* 在分发层即 METHOD_NOT_FOUND(到不了 handler)。
// 该行为依赖 SDK 的 SUPPORTED_PROTOCOL_VERSIONS 仍以 2025-11-25 为最新——SDK 升级引入
// 2026 era 时此测试红,提醒复核 tasks wire 层的 era 门控与 handler 自查必要性。
describe('tasks wire era gate(版本锁)', () => {
  it('LATEST_PROTOCOL_VERSION 仍为 2025-11-25(tasks 词汇可用 era;SDK 升级到 2026 era 时此断言红=复核提醒)', async () => {
    const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/core/internal');
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('GodotServer 的 4 个 tasks/* handler 已注册(wire 层在位)', async () => {
    const src = readFileSync(new URL('../src/GodotServer.ts', import.meta.url), 'utf-8');
    for (const m of ['tasks/get', 'tasks/list', 'tasks/cancel', 'tasks/result']) {
      expect(src).toContain(`'${m}'`);
    }
  });
});
