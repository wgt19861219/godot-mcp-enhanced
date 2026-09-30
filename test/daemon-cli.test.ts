// test/daemon-cli.test.ts
// daemon 批 B(2026-09-30 spec §3.8)Task 8——CLI 四命令壳(start/stop/status/restart)。
// 纪律:spawn/postShutdown/killPidTree/端口探测全部注入 fake(不真起进程——main.ts 有
// 不 unref 的保活 setInterval,真跑会挂测试,批 A ⚠️ 交接);registry 读取也注入
// (轮询序列可控)。真实 fs/spawn 路径的验收留批 C 真机。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  runDaemonCli,
  buildDaemonArgv,
  buildShutdownUrl,
  resolveBasePort,
  type DaemonCliDeps,
  type DaemonSpawnOptions,
} from '../src/cli/daemon.js';
import type { WebGuiRegistration } from '../src/web-gui/registry.js';
import { EXIT_CODES } from '../src/core/exit-codes.js';

/** 测试用登记工厂(不落盘——listRegistrations 已注入,真实 fs 路径不在本测试面)。 */
function reg(over: Partial<WebGuiRegistration>): WebGuiRegistration {
  return { pid: 100, port: 9550, token: 'tok_daemon_xxxxxxxxxxxxxxxx', startedAt: '2026-09-30T00:00:00Z', kind: 'daemon', ...over };
}

interface Harness {
  deps: DaemonCliDeps;
  out: string[];
  err: string[];
  exitCodes: number[];
  spawnCalls: DaemonSpawnOptions[];
  shutdownCalls: Array<{ port: number; token: string; restart: boolean; timeoutMs: number }>;
  killCalls: number[];
  auditKillCalls: Array<{ pid: number; reason: string }>;
  openedUrls: string[];
  portProbes: number[];
  log: MockInstance;
  logErr: MockInstance;
}

/** 组一套全 fake deps + console 采集。list 序列由用例装填。 */
function harness(listSeq: WebGuiRegistration[][]): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const spawnCalls: DaemonSpawnOptions[] = [];
  const shutdownCalls: Array<{ port: number; token: string; restart: boolean; timeoutMs: number }> = [];
  const killCalls: number[] = [];
  const auditKillCalls: Array<{ pid: number; reason: string }> = [];
  const openedUrls: string[] = [];
  const portProbes: number[] = [];
  let listIdx = 0;
  const deps: DaemonCliDeps = {
    env: {},
    listRegistrations: vi.fn(async () => {
      // 序列消费:耗尽后停在第 4 步快照——用例无特殊声明时不重复改写返回值
      const step = listSeq[Math.min(listIdx, listSeq.length - 1)] ?? [];
      listIdx++;
      return step;
    }),
    spawnDaemon: vi.fn((o: DaemonSpawnOptions) => {
      spawnCalls.push(o);
      return { pid: 4321, logFile: 'D:/tmp/daemon-test.log' };
    }),
    postShutdown: vi.fn(async (o: { port: number; token: string; restart: boolean; timeoutMs: number }) => {
      shutdownCalls.push(o);
      return { status: 200 };
    }),
    killPidTree: vi.fn((pid: number) => { killCalls.push(pid); }),
    // 审查 Important(2026-09-30):kill 兜底审计注入 fake——真实直调 appendMachineAuditLine
    // 会写真审计文件,测试断言"被调 + reason 归因"而非审计文件内容(文件落盘验收归批 C 真机)
    auditKill: vi.fn((pid: number, reason: string) => { auditKillCalls.push({ pid, reason }); }),
    isPortFree: vi.fn(async (p: number) => { portProbes.push(p); return true; }),
    opener: vi.fn((u: string) => { openedUrls.push(u); }),
    sleep: vi.fn(async () => { /* 测试零等待 */ }),
    exit: vi.fn(((code: number) => { exitCodes.push(code); return undefined as never; }) as (code: number) => never),
  };
  const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  const logErr = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m)); });
  return { deps, out, err, exitCodes, spawnCalls, shutdownCalls, killCalls, auditKillCalls, openedUrls, portProbes, log, logErr };
}

describe('daemon CLI(批 B Task 8)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // ── 纯函数 ──────────────────────────────────────────────────────────────

  describe('buildDaemonArgv(批 A ledger:--port 恒传,strictPort 语义)', () => {
    it('--port 恒在(防非 respawn 场景顺延漂移);--respawn-of 可选追加', () => {
      expect(buildDaemonArgv('D:/pkg/build/daemon/main.js', 9550))
        .toEqual(['D:/pkg/build/daemon/main.js', '--port', '9550']);
      expect(buildDaemonArgv('D:/pkg/build/daemon/main.js', 9551, 1234))
        .toEqual(['D:/pkg/build/daemon/main.js', '--port', '9551', '--respawn-of', '1234']);
    });
  });

  describe('buildShutdownUrl(Task 7 ⚠️ 交接:token 走 query 第一优先级通道)', () => {
    it('token 进 query(encodeURIComponent);restart=1 按需追加', () => {
      const stop = buildShutdownUrl(9550, 'tok_abcd', false);
      expect(stop).toBe('http://127.0.0.1:9550/api/shutdown?token=tok_abcd');
      const restart = buildShutdownUrl(9550, 'tok_abcd', true);
      expect(restart).toBe('http://127.0.0.1:9550/api/shutdown?token=tok_abcd&restart=1');
    });
    it('token 特殊字符被编码(token 字符集白名单外防御)', () => {
      expect(buildShutdownUrl(9550, 'a b&c', false)).toContain('token=a%20b%26c');
    });
  });

  describe('resolveBasePort(env 对齐 server.ts 语义)', () => {
    it('GODOT_MCP_WEB_GUI_PORT 缺席 / 非数字 / "0" → 默认 9550(与 server.ts 同款)', () => {
      expect(resolveBasePort({})).toBe(9550);
      expect(resolveBasePort({ GODOT_MCP_WEB_GUI_PORT: 'abc' })).toBe(9550);
      expect(resolveBasePort({ GODOT_MCP_WEB_GUI_PORT: '0' })).toBe(9550);
    });
    it('合法数字起点透传', () => {
      expect(resolveBasePort({ GODOT_MCP_WEB_GUI_PORT: '9600' })).toBe(9600);
    });
  });

  // ── 用法错误(exit 2)───────────────────────────────────────────────────

  it('无子命令 / 未知子命令 → 用法提示 + exit 2', async () => {
    for (const args of [[], ['bogus']] as string[][]) {
      const h = harness([]);
      await runDaemonCli(args, h.deps);
      expect(h.exitCodes, `args=${JSON.stringify(args)}`).toEqual([EXIT_CODES.EXIT_USAGE]);
      expect(h.err.join('\n')).toContain('用法');
      expect(h.spawnCalls.length).toBe(0);
    }
  });

  // ── start ───────────────────────────────────────────────────────────────

  it('start:CLI 侧单例检测①——已有活 daemon(kind=daemon)→ 拒绝 exit 1,不 spawn', async () => {
    const h = harness([[reg({ pid: 777, port: 9550 })]]);
    await runDaemonCli(['start'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.err.join('\n')).toContain('daemon 已在运行');
    expect(h.err.join('\n')).toContain('pid=777');
    expect(h.spawnCalls.length).toBe(0);
  });

  it('start:stdio 实例不算 daemon 单例,照常启动', async () => {
    const stdio = reg({ pid: 555, port: 9551, kind: 'stdio' });
    const ready = reg({ pid: 4321, port: 9550 });
    const h = harness([[stdio], [stdio], [stdio, ready]]);
    await runDaemonCli(['start'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.spawnCalls.length).toBe(1);
  });

  it('start:端口选取——base 起自 9550,占用则 +1 递增(≤20 次),选定值恒传给 spawn(--port)', async () => {
    const ready = reg({ pid: 4321, port: 9551 });
    const h = harness([[], [], [ready]]);
    const free = new Set([9551]);
    h.deps.isPortFree = vi.fn(async (p: number) => { h.portProbes.push(p); return free.has(p); });
    await runDaemonCli(['start'], h.deps);
    expect(h.portProbes).toEqual([9550, 9551]);
    expect(h.spawnCalls).toEqual([{ port: 9551 }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  it('start:env GODOT_MCP_WEB_GUI_PORT=9600 → 起点跟随(与 server.ts 用户配置通道一致)', async () => {
    const ready = reg({ pid: 4321, port: 9600 });
    const h = harness([[], [ready]]);
    h.deps.env = { GODOT_MCP_WEB_GUI_PORT: '9600' };
    await runDaemonCli(['start'], h.deps);
    expect(h.portProbes).toEqual([9600]);
    expect(h.spawnCalls).toEqual([{ port: 9600 }]);
  });

  it('start:20 个候选端口全占 → 报错 exit 1,不 spawn', async () => {
    const h = harness([[]]);
    h.deps.isPortFree = vi.fn(async () => false);
    await runDaemonCli(['start'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.err.join('\n')).toContain('9550');
    expect(h.err.join('\n')).toContain('占用');
    expect(h.spawnCalls.length).toBe(0);
  });

  it('start:就绪轮询按 registry 登记(非 /api/health)——前两轮空第三轮登记出现 → 成功;打印面板/mcp/token 三件套', async () => {
    const ready = reg({ pid: 4321, port: 9550, token: 'abcdzzzzzzzzzzzzzzzzzzzz' });
    const h = harness([[], [], [ready]]);
    await runDaemonCli(['start'], h.deps);
    const text = h.out.join('\n');
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    // URL 打印义务(spec §3.8 n-4)
    expect(text).toContain('http://127.0.0.1:9550/');
    expect(text).toContain('http://127.0.0.1:9550/mcp');
    expect(text).toContain('daemon status --show-token');
    // token 打码对齐 open.ts 先例(前 4 位 + ****,全量不落终端)
    expect(text).toContain('abcd****');
    expect(text).not.toContain('abcdzzzzzzzzzzzzzzzzzzzz');
    // 轮询确实发生(空转两轮 list + 至少一次 sleep 间隔)
    expect((h.deps.sleep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('start:登记迟迟不出现(超时)→ 失败 exit 1,提示日志文件路径', async () => {
    const h = harness([[]]);
    await runDaemonCli(['start'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.err.join('\n')).toContain('daemon-test.log');
  });

  it('start --open:成功后 opener 收全量 token URL(opener 恒全量,对齐 open.ts)', async () => {
    const ready = reg({ pid: 4321, port: 9550, token: 'abcdzzzzzzzzzzzzzzzzzzzz' });
    const h = harness([[], [ready]]);
    await runDaemonCli(['start', '--open'], h.deps);
    expect(h.openedUrls).toEqual(['http://127.0.0.1:9550/#token=abcdzzzzzzzzzzzzzzzzzzzz']);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  // ── stop ────────────────────────────────────────────────────────────────

  it('stop:无 daemon → 幂等成功 exit 0(受控通道不触发)', async () => {
    const h = harness([[], []]);
    await runDaemonCli(['stop'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.shutdownCalls.length).toBe(0);
    expect(h.killCalls.length).toBe(0);
  });

  it('stop:受控路径——POST /api/shutdown(query token=登记 token)→ 登记消失 → exit 0,不 kill;kill 审计不落(正常路径零噪音)', async () => {
    const d = reg({ pid: 777, port: 9550, token: 'tok_stop_123' });
    const h = harness([[d], [], []]);
    await runDaemonCli(['stop'], h.deps);
    expect(h.shutdownCalls).toEqual([{ port: 9550, token: 'tok_stop_123', restart: false, timeoutMs: 5000 }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.killCalls.length).toBe(0);
    expect(h.auditKillCalls).toEqual([]);
    expect(h.out.join('\n')).toContain('已停止');
  });

  it('stop:HTTP 超时/网络错误 → killPidTree 兜底 → 登记消失 → exit 0;kill 前落审计(reason=timeout)', async () => {
    const d = reg({ pid: 777, port: 9550 });
    const h = harness([[d], [], []]);
    h.deps.postShutdown = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    await runDaemonCli(['stop'], h.deps);
    expect(h.killCalls).toEqual([777]);
    expect(h.auditKillCalls).toEqual([{ pid: 777, reason: 'timeout' }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.err.join('\n')).toContain('强制');
  });

  it('stop --force:跳过受控通道直接 killPidTree;kill 前落审计(reason=force)', async () => {
    const d = reg({ pid: 777, port: 9550 });
    const h = harness([[d], [], []]);
    await runDaemonCli(['stop', '--force'], h.deps);
    expect(h.shutdownCalls.length).toBe(0);
    expect(h.killCalls).toEqual([777]);
    expect(h.auditKillCalls).toEqual([{ pid: 777, reason: 'force' }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  it('stop:503(受控回调未注入,Task 9 前中间态)→ 如实报错提示 --force,不自作主张硬杀', async () => {
    const d = reg({ pid: 777, port: 9550 });
    const h = harness([[d]]);
    h.deps.postShutdown = vi.fn(async () => ({ status: 503 }));
    await runDaemonCli(['stop'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.err.join('\n')).toContain('--force');
    expect(h.killCalls.length).toBe(0);
  });

  it('stop:200 后登记迟迟不消失 → killPidTree 兜底(目标达成优先);kill 前落审计(reason=stale_registry)', async () => {
    const d = reg({ pid: 777, port: 9550 });
    const h = harness([[d], [d], [d], [d], [d], [d]]);
    await runDaemonCli(['stop'], h.deps);
    expect(h.killCalls).toEqual([777]);
    expect(h.auditKillCalls).toEqual([{ pid: 777, reason: 'stale_registry' }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  // ── status ──────────────────────────────────────────────────────────────

  it('status:列全部实例,daemon 优先;有活 daemon → exit 0', async () => {
    const d = reg({ pid: 777, port: 9550, version: '0.23.0' });
    const s = reg({ pid: 555, port: 9551, kind: 'stdio' });
    const h = harness([[s, d], [s, d]]);
    await runDaemonCli(['status'], h.deps);
    const text = h.out.join('\n');
    expect(text.indexOf('pid=777')).toBeLessThan(text.indexOf('pid=555'));
    expect(text).toContain('9550');
    expect(text).toContain('9551');
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  it('status:只有 stdio 实例 → exit 1(语义:无活 daemon)', async () => {
    const s = reg({ pid: 555, port: 9551, kind: 'stdio' });
    const h = harness([[s]]);
    await runDaemonCli(['status'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
  });

  it('status:无任何实例 → 提示 + exit 1', async () => {
    const h = harness([[]]);
    await runDaemonCli(['status'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.out.join('\n')).toContain('没有');
  });

  it('status --show-token:打印全量 token;默认打码(前 4 位)', async () => {
    const d = reg({ pid: 777, port: 9550, token: 'wxyzzzzzzzzzzzzzzzzzzzzz' });
    const masked = harness([[d], [d]]);
    await runDaemonCli(['status'], masked.deps);
    expect(masked.out.join('\n')).toContain('wxyz****');
    expect(masked.out.join('\n')).not.toContain('wxyzzzzzzzzzzzzzzzzzzzzz');

    const full = harness([[d], [d]]);
    await runDaemonCli(['status', '--show-token'], full.deps);
    expect(full.out.join('\n')).toContain('wxyzzzzzzzzzzzzzzzzzzzzz');
    expect(full.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });

  // ── restart ─────────────────────────────────────────────────────────────

  it('restart:死 daemon(无登记)→ 等价 start(spawn + 就绪轮询 + URL 打印)', async () => {
    const ready = reg({ pid: 4321, port: 9550, token: 'abcdzzzzzzzzzzzzzzzzzzzz' });
    const h = harness([[], [], [ready]]);
    await runDaemonCli(['restart'], h.deps);
    expect(h.spawnCalls).toEqual([{ port: 9550 }]);
    expect(h.shutdownCalls.length).toBe(0);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.out.join('\n')).toContain('http://127.0.0.1:9550/mcp');
  });

  it('restart:活 daemon + 503(Task 9 接线前中间态)→ 如实报错提示 stop+start,不静默', async () => {
    const d = reg({ pid: 777, port: 9550 });
    const h = harness([[d]]);
    h.deps.postShutdown = vi.fn(async () => ({ status: 503 }));
    await runDaemonCli(['restart'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OPERATION_FAILED]);
    expect(h.err.join('\n')).toContain('stop');
    expect(h.err.join('\n')).toContain('start');
    expect(h.killCalls.length).toBe(0);
    expect(h.spawnCalls.length).toBe(0);
  });

  it('restart:活 daemon + 200 → 请求带 restart=1,轮询到新 pid 登记 → 打印新 URL,exit 0', async () => {
    const old = reg({ pid: 777, port: 9550, token: 'tok_restart_a' });
    const fresh = reg({ pid: 4321, port: 9550, token: 'tok_restart_b' });
    const h = harness([[old], [old], [old, fresh]]);
    await runDaemonCli(['restart'], h.deps);
    expect(h.shutdownCalls).toEqual([{ port: 9550, token: 'tok_restart_a', restart: true, timeoutMs: 5000 }]);
    expect(h.out.join('\n')).toContain('http://127.0.0.1:9550/mcp');
    expect(h.out.join('\n')).toContain('pid=4321');
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.killCalls.length).toBe(0);
    expect(h.spawnCalls.length).toBe(0);
  });

  it('restart:交接窗口新旧登记并存——轮询按 pid ≠ 旧 pid 找新实例(findDaemon 取首个会永远撞旧登记)', async () => {
    const old = reg({ pid: 777, port: 9550 });
    const fresh = reg({ pid: 4321, port: 9550 });
    // 并存序列:target 检测后 registry 恒为 [old, fresh](旧登记先删是新进程交接序步骤 3)
    const h = harness([[old], [old, fresh]]);
    await runDaemonCli(['restart'], h.deps);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
    expect(h.out.join('\n')).toContain('pid=4321');
  });

  it('restart:活 daemon + HTTP 超时 → killPidTree 后退化为重新 start;kill 前落审计(reason=restart_fallback)', async () => {
    const old = reg({ pid: 777, port: 9550 });
    const fresh = reg({ pid: 4321, port: 9550 });
    // 序列:target 检测 [old] → gone 轮询 [] → start 单例检测 [] → 就绪轮询 [fresh]
    const h = harness([[old], [], [], [fresh]]);
    h.deps.postShutdown = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    await runDaemonCli(['restart'], h.deps);
    expect(h.killCalls).toEqual([777]);
    expect(h.auditKillCalls).toEqual([{ pid: 777, reason: 'restart_fallback' }]);
    expect(h.spawnCalls).toEqual([{ port: 9550 }]);
    expect(h.exitCodes).toEqual([EXIT_CODES.EXIT_OK]);
  });
});
