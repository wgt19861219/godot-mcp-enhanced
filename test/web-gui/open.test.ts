// Task 10(设计 §6):CLI `dashboard --web` 聚合逻辑——登记聚合 → 探活清死 →
// 单个直开/多个菜单/零个提示。opener/choose/registryDir/isPidAlive 全注入,不碰真实 stdin/浏览器。
//
// 另含 Task 9 review 交接的正式断言补齐(覆盖缺口:一次性验收脚本已删):
// 1. isWebGuiActive() 与真实 WebGuiServer 实例 start/stop 的同步关系;
// 2. writeRegistration 失败(ENOTDIR)降级:start() reject → catch+stop(生产 GodotServer.run
//    同款清理模式)后 isWebGuiActive()=false 且端口无泄漏(同 portStart 再起能成功)。
// GodotServer 层 env 门(GODOT_MCP_WEB_GUI='0' 不构造)在 env-gate.test.ts(vi.mock server.js)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openWebDashboard } from '../../src/web-gui/open.js';
import { writeRegistration } from '../../src/web-gui/registry.js';
import { WebGuiServer, isWebGuiActive } from '../../src/web-gui/server.js';

const ALIVE = () => true;

describe('dashboard --web(设计 §6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-open-')); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('零个活 server:打印提示,返回非 0', async () => {
    const urls: string[] = [];
    const code = await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
    expect(code).not.toBe(0);
    expect(urls).toHaveLength(0);
  });

  it('单个:opener 收到带 token 的 URL', async () => {
    await writeRegistration({ pid: process.pid, port: 9550, token: 'tok1', startedAt: 't' }, { dir });
    const urls: string[] = [];
    const code = await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
    expect(code).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:9550/?token=tok1']);
  });

  it('多个:choose 选择后被打开;取消返回非 0', async () => {
    await writeRegistration({ pid: 101, port: 9550, token: 'a', startedAt: 't' }, { dir });
    await writeRegistration({ pid: 102, port: 9551, token: 'b', startedAt: 't' }, { dir });
    const urls: string[] = [];
    const code = await openWebDashboard({
      opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE,
      choose: async (entries) => entries.find(e => e.port === 9551) ?? null,
    });
    expect(code).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:9551/?token=b']);
    const cancelled = await openWebDashboard({
      opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE,
      choose: async () => null,
    });
    expect(cancelled).not.toBe(0);
  });
});

// ─── Task 9 review 交接:webGuiActive 三态传播正式断言(真实实例驱动) ──────────

/** listen(0) 借一个空闲端口后立即释放(测试确定性:ENOTDIR 用例要固定 portStart)。 */
function borrowFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** 探测端口可监听(= 未被泄漏占用)。 */
function probePortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => { s.close(() => resolve()); });
  });
}

describe('webGuiActive 三态传播(Task 9 review 交接断言)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-active-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('isWebGuiActive() 与实例 start/stop 同步:start 后 true,stop 后 false', async () => {
    expect(isWebGuiActive()).toBe(false);
    const gui = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => '<!doctype html><html></html>',
      portStart: 0,           // 系统随机分配,不占生产默认 9550
      registryDir: dir,
      logDir: dir,
    });
    await gui.start();
    expect(isWebGuiActive()).toBe(true);
    await gui.stop();
    expect(isWebGuiActive()).toBe(false);
  });

  it('writeRegistration 失败(ENOTDIR):start() reject,catch+stop 降级后 active=false 且端口无泄漏', async () => {
    const port = await borrowFreePort();
    // registryDir 指向一个文件而非目录 → mkdir 递归失败 → writeRegistration 抛错
    const notADir = join(dir, 'occupier.txt');
    writeFileSync(notADir, 'x');
    const gui = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => '<!doctype html><html></html>',
      portStart: port,
      registryDir: notADir,
      logDir: dir,
      token: 't',
    });
    let rejected = false;
    try {
      await gui.start();
    } catch {
      rejected = true;
      // 生产 catch 模式(GodotServer.run() 同款):start() reject 时残留半激活态
      // (HTTP 已监听 + _active=true),必须补调 stop() 清理——防误报 + 端口泄漏。
      await gui.stop();
    }
    expect(rejected).toBe(true);
    expect(isWebGuiActive()).toBe(false);
    // 端口无泄漏:该端口可被再次监听,且同 portStart 再起新实例能成功
    await expect(probePortFree(port)).resolves.toBeUndefined();
    const gui2 = new WebGuiServer({
      getSessions: () => [],
      getIndexHtml: () => '<!doctype html><html></html>',
      portStart: port,
      registryDir: dir,
      logDir: dir,
      token: 't2',
    });
    await gui2.start();
    expect(gui2.port).toBe(port);
    await gui2.stop();
    expect(isWebGuiActive()).toBe(false);
  });
});
