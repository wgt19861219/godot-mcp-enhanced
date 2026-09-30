// test/web-gui/daemon-restart.test.ts
// daemon 批 B(2026-09-30 spec §3.7,plan Task 9):受控交接序列——决策段全注入,
// 不真跑 runDaemon(main.ts 有不 unref 的保活 setInterval,真跑会拖死测试进程),
// 不真 spawn / 不真 listen。四条主干用例(plan Task 9 Step 1):
//   ① 成功交接:spawn flags 恒含 --port=<旧端口> + --respawn-of=<旧pid>;
//     verified 删自身登记;有序 close;exit(0)。
//   ② 新实例报到但端口不符 → 回滚:杀新 + 等登记消失 + relisten,不 exit(无双活)。
//   ③ 超时未报到 → 回滚同上。
//   ④ removeRegistrationVerified false(PID 复用)→ 不删他文件但继续退出路径。
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { controlledRestart, type ControlledRestartDeps, type ControlledRestartAudit } from '../../src/daemon/controlled-restart.js';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { parseRegistrationFile, type WebGuiRegistration } from '../../src/web-gui/registry.js';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OLD_PID = 4100;
const NEW_PID = 4200;
const OLD_PORT = 9550;
const STARTED_AT = '2026-09-30T08:00:00.000Z';

interface HarnessOpts {
  /** 新实例登记端口(缺省 OLD_PORT = 交接成功);设不同值触发端口不符回滚。 */
  newDaemonPort?: number;
  /** spawn 后新登记是否出现(缺省 true;false = 超时未报到)。 */
  spawnRegisters?: boolean;
  /** removeRegistrationVerified 返回值(缺省 true;false = PID 复用路径)。 */
  verifiedResult?: boolean;
}

interface Harness {
  deps: ControlledRestartDeps;
  calls: {
    closeListener: number;
    relisten: number;
    spawnFlags: string[][];
    kills: number[];
    serverClose: number;
    exits: number[];
    verified: Array<{ pid: number; startedAt: string }>;
    audits: Array<{ ok: boolean; details: Record<string, unknown> }>;
  };
}

/** 全注入 harness:listRegistrations 读可变闭包数组(killTree 模拟探活顺手清),
 *  sleep 零等待 + 超时/轮询参数压到最小(纯逻辑不挂真实时钟)。 */
function makeHarness(opts: HarnessOpts = {}): Harness {
  const calls: Harness['calls'] = {
    closeListener: 0, relisten: 0, spawnFlags: [], kills: [],
    serverClose: 0, exits: [], verified: [], audits: [],
  };
  let registrations: WebGuiRegistration[] = [
    { pid: OLD_PID, port: OLD_PORT, token: 'tok_old_daemon_x', startedAt: STARTED_AT, kind: 'daemon' },
  ];
  const deps: ControlledRestartDeps = {
    gui: {
      port: OLD_PORT,
      registrationStartedAt: STARTED_AT,
      closeListener: async () => { calls.closeListener++; },
      relisten: async () => { calls.relisten++; },
    },
    server: { close: async () => { calls.serverClose++; } },
    spawnDaemon: (flags) => {
      calls.spawnFlags.push(flags);
      if (opts.spawnRegisters !== false) {
        registrations.push({
          pid: NEW_PID, port: opts.newDaemonPort ?? OLD_PORT,
          token: 'tok_new_daemon_x', startedAt: '2026-09-30T08:00:05.000Z',
          kind: 'daemon', ...(opts.newDaemonPort === undefined ? { respawnOf: OLD_PID } : {}),
        });
      }
      return { pid: NEW_PID };
    },
    killTree: (pid) => {
      calls.kills.push(pid);
      // kill 后登记消失(listRegistrations 默认探活清死条目的模拟)
      registrations = registrations.filter(r => r.pid !== pid);
    },
    listRegistrations: async () => [...registrations],
    removeRegistrationVerified: async (pid, startedAt) => {
      calls.verified.push({ pid, startedAt });
      return opts.verifiedResult ?? true;
    },
    sleep: async () => { /* 零等待 */ },
    exit: (code) => { calls.exits.push(code); },
    oldPid: OLD_PID,
    readyTimeoutMs: 40,
    goneTimeoutMs: 40,
    pollIntervalMs: 10,
    audit: (async (ok: boolean, details: Record<string, unknown>) => {
      calls.audits.push({ ok, details });
    }) satisfies ControlledRestartAudit,
  };
  return { deps, calls };
}

describe('controlledRestart(spec §3.7 受控交接,plan Task 9)', () => {
  it('① 成功交接:spawn flags 含 --port=旧端口 + --respawn-of=旧pid;verified 删登记;有序 close;exit(0);不回滚', async () => {
    const h = makeHarness();
    await controlledRestart(h.deps);

    // 不变式 1(端口不漂移):flags 恒传旧端口 + respawn 关联
    expect(h.calls.spawnFlags).toEqual([['--port', String(OLD_PORT), '--respawn-of', String(OLD_PID)]]);
    // 步骤 1:先关 listener(进程不退)
    expect(h.calls.closeListener).toBe(1);
    // 步骤 3:verified 删自身登记(pid + startedAt 双校验值来自登记同源真值)
    expect(h.calls.verified).toEqual([{ pid: OLD_PID, startedAt: STARTED_AT }]);
    // 步骤 3(续):有序 close 链 → exit(0)
    expect(h.calls.serverClose).toBe(1);
    expect(h.calls.exits).toEqual([0]);
    // 成功路径不触碰回滚面(无双活维持:新实例顶上,旧进程退出)
    expect(h.calls.kills).toEqual([]);
    expect(h.calls.relisten).toBe(0);
    // 审计:各步落痕,含 step/oldPid/port
    const steps = h.calls.audits.map(a => a.details['step']);
    expect(steps).toContain('close-listener');
    expect(steps).toContain('spawn');
    expect(steps).toContain('handover');
    expect(steps).toContain('remove-registration');
    expect(steps).toContain('exit');
    const handover = h.calls.audits.find(a => a.details['step'] === 'handover');
    expect(handover?.details['newPid']).toBe(NEW_PID);
    expect(handover?.details['port']).toBe(OLD_PORT);
  });

  it('② 新实例报到但端口不符 → 回滚:杀新实例 + 等登记消失 + relisten;不 exit 不 close server(不变式 2)', async () => {
    const h = makeHarness({ newDaemonPort: OLD_PORT + 1 });
    await expect(controlledRestart(h.deps)).rejects.toThrow(/端口/);

    // 先关 listener 再 spawn(序列顺序)
    expect(h.calls.closeListener).toBe(1);
    expect(h.calls.spawnFlags).toHaveLength(1);
    // 回滚:杀新实例(kill 在 relisten 之前——先消除双活再恢复服务)
    expect(h.calls.kills).toEqual([NEW_PID]);
    expect(h.calls.relisten).toBe(1);
    // 旧进程继续活着:不走退出链
    expect(h.calls.exits).toEqual([]);
    expect(h.calls.serverClose).toBe(0);
    // 交接未确认 → 不删自身登记
    expect(h.calls.verified).toEqual([]);
    // 审计:端口不符步落痕(ok=false)
    const mismatch = h.calls.audits.find(a => a.details['step'] === 'handover');
    expect(mismatch?.ok).toBe(false);
    expect(mismatch?.details['result']).toBe('port-mismatch');
    expect(h.calls.audits.some(a => a.details['step'] === 'rollback-relisten')).toBe(true);
  });

  it('③ 新实例超时未报到 → 回滚:杀新实例(可能还活着只是没登记)+ relisten;不 exit', async () => {
    const h = makeHarness({ spawnRegisters: false });
    await expect(controlledRestart(h.deps)).rejects.toThrow(/登记/);

    expect(h.calls.closeListener).toBe(1);
    // 超时路径同样杀新实例(spec §3.7 步骤 4:"新实例未起/未在限时报到")
    expect(h.calls.kills).toEqual([NEW_PID]);
    expect(h.calls.relisten).toBe(1);
    expect(h.calls.exits).toEqual([]);
    expect(h.calls.serverClose).toBe(0);
    const timeout = h.calls.audits.find(a => a.details['step'] === 'handover');
    expect(timeout?.details['result']).toBe('timeout');
  });

  it('④ removeRegistrationVerified false(PID 复用)→ 不删他文件但继续退出路径(close + exit 0,如实审计)', async () => {
    const h = makeHarness({ verifiedResult: false });
    await controlledRestart(h.deps);

    // verified 被调且参数正确(pid + 登记同源 startedAt),返回 false 不阻断退出
    expect(h.calls.verified).toEqual([{ pid: OLD_PID, startedAt: STARTED_AT }]);
    expect(h.calls.serverClose).toBe(1);
    expect(h.calls.exits).toEqual([0]);
    expect(h.calls.relisten).toBe(0);
    // 如实审计:verified=false 落痕但不按失败处理(交接本身已成功)
    const reg = h.calls.audits.find(a => a.details['step'] === 'remove-registration');
    expect(reg?.details['result']).toBe('mismatch-pid-reuse-kept');
  });
});

// ── server 侧配套直测(真 WebGuiServer;closeListener/relisten 是 Task 9 加在
//    server.ts 的真实逻辑,主干用例只经 fake 覆盖,此处验证真实现)────────────────
describe('WebGuiServer.closeListener/relisten(§3.7 步骤 1/4 的 server 侧实现)', () => {
  let dir: string;
  let active: WebGuiServer | null = null;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'web-gui-daemon-restart-')); });
  afterEach(async () => { if (active) { await active.stop(); active = null; } });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function startGui(): Promise<WebGuiServer> {
    const srv = new WebGuiServer({
      getSessions: () => [], getIndexHtml: () => '<!doctype html><html></html>',
      portStart: 0, registryDir: dir, token: 'tok_restart_srv_0123456789',
    });
    await srv.start();
    return srv;
  }

  it('closeListener 后拒连 → relisten 回同端口(port 不漂移)且恢复服务;登记全程保留(交接中标注数据源)', async () => {
    const srv = await startGui(); active = srv;
    const portBefore = srv.port;
    await srv.closeListener();
    // listener 已关:面板/CLI 表现为 ECONNREFUSED(spec n-5:与"端口无 daemon"同表现)
    await expect(fetch(`http://127.0.0.1:${srv.port}/`)).rejects.toThrow();
    // 登记未清(closeListener 不 stop):交接窗口"交接中"标注的数据源在场
    const regDuringHandover = await parseRegistrationFile(dir, `${process.pid}.json`);
    expect(regDuringHandover?.port).toBe(portBefore);
    await srv.relisten();
    expect(srv.port).toBe(portBefore);
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(res.status).toBe(200);
  });

  it('registrationStartedAt getter === 登记文件 startedAt(同源真源,verified 校验值不漂移)', async () => {
    const srv = await startGui(); active = srv;
    const reg = await parseRegistrationFile(dir, `${process.pid}.json`);
    expect(srv.registrationStartedAt).toBe(reg?.startedAt);
    expect(srv.registrationStartedAt).not.toBe('');
  });

  it('closeListener 后 stop() 不抛(双 close 无害边界)且登记被清', async () => {
    const srv = await startGui();
    await srv.closeListener();
    await expect(srv.stop()).resolves.toBeUndefined();
    expect(await parseRegistrationFile(dir, `${process.pid}.json`)).toBeNull();
  });

  it('relisten 遇端口被第三方占用 → reject,不自作顺延(strictPort 语义同源,不变式 1)', async () => {
    const srv = await startGui(); active = srv;
    const port = srv.port;
    await srv.closeListener();
    // 第三方(net 原生 server)占住同端口,模拟新实例残留
    const squatter = net.createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      await expect(srv.relisten()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('respawnOf 注入 → 登记写入受控交接关联字段(前端"交接中"数据源;parse 向后兼容)', async () => {
    const srv = new WebGuiServer({
      getSessions: () => [], getIndexHtml: () => '<!doctype html><html></html>',
      portStart: 0, registryDir: dir, token: 'tok_restart_srv_0123456789',
      respawnOf: 4100,
    });
    await srv.start(); active = srv;
    const reg = await parseRegistrationFile(dir, `${process.pid}.json`);
    expect(reg?.respawnOf).toBe(4100);
  });
});
