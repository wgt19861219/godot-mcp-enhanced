// Task 10(设计 §6):CLI `dashboard --web` 聚合逻辑——登记聚合 → 探活清死 →
// 单个直开/多个菜单/零个提示。opener/choose/registryDir/isPidAlive 全注入,不碰真实 stdin/浏览器。
//
// 另含 Task 9 review 交接的正式断言补齐(覆盖缺口:一次性验收脚本已删):
// 1. isWebGuiActive() 与真实 WebGuiServer 实例 start/stop 的同步关系;
// 2. writeRegistration 失败(ENOTDIR/EEXIST 按平台)降级:start() reject → catch+stop(生产 GodotServer.run
//    同款清理模式)后 isWebGuiActive()=false 且端口无泄漏(同 portStart 再起能成功)。
// GodotServer 层 env 门(GODOT_MCP_WEB_GUI='0' 不构造)在 env-gate.test.ts(vi.mock server.js)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openWebDashboard, parseChooseLine } from '../../src/web-gui/open.js';
import { writeRegistration } from '../../src/web-gui/registry.js';
import { WebGuiServer, isWebGuiActive } from '../../src/web-gui/server.js';

const ALIVE = () => true;

describe('dashboard --web(设计 §6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webgui-open-')); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('零个活 server:打印提示,返回非 0,并打开 file:// 入口页(2026-09-16 行为变更)', async () => {
    const urls: string[] = [];
    const code = await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
    expect(code).not.toBe(0);
    // 新行为:零实例时打开本地入口页(portal.html 扫描跳转页),不再是纯文字提示
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^file:\/\/\/.*portal\.html$/);
    expect(existsSync(join(dir, 'portal.html'))).toBe(true);
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

  // ── M-2(2026-09-17 审查批):CLI 输出默认打码,--show-token 显式全量 ──────────
  it('M-2 打码:默认 console 输出不含全量 token(opener 仍收全量 URL);showToken=true 输出全量', async () => {
    const LONG = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';   // 43 字符,真实形状
    await writeRegistration({ pid: process.pid, port: 9550, token: LONG, startedAt: 't' }, { dir });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const urls: string[] = [];
    try {
      await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE });
      const out = logs.join('\n');
      expect(out).not.toContain(LONG);   // 全量 token 不落终端(终端日志/录屏泄露面)
      expect(out).toContain(`${LONG.slice(0, 4)}****`);   // 打码形态:前 4 位 + ****
      expect(urls).toEqual([`http://127.0.0.1:9550/?token=${LONG}`]);   // 浏览器打开功能不变(仍带全量)

      logs.length = 0; urls.length = 0;
      await openWebDashboard({ opener: u => urls.push(u), registryDir: dir, isPidAlive: ALIVE, showToken: true });
      expect(logs.join('\n')).toContain(`http://127.0.0.1:9550/?token=${LONG}`);   // --show-token 显式全量
      expect(urls).toEqual([`http://127.0.0.1:9550/?token=${LONG}`]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Task 9 review 交接:webGuiActive 三态传播正式断言(真实实例驱动) ──────────

/** listen(0) 借一个空闲端口后立即释放(测试确定性:写失败用例要固定 portStart)。 */
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

  it('writeRegistration 失败(ENOTDIR/EEXIST 按平台):start() reject,catch+stop 降级后 active=false 且端口无泄漏', async () => {
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

// ─── follow-up: parseChooseLine 纯函数(defaultChoose 行文本解析) ──────────────

describe('parseChooseLine(菜单行文本 → 编号)', () => {
  it('有效数字:范围内返回数字(带空白容忍)', () => {
    expect(parseChooseLine('1', 3)).toBe(1);
    expect(parseChooseLine(' 2 ', 3)).toBe(2);
    expect(parseChooseLine('3', 3)).toBe(3);
  });
  it('越界:超出 1..count 返回 null', () => {
    expect(parseChooseLine('0', 3)).toBeNull();
    expect(parseChooseLine('4', 3)).toBeNull();
  });
  it('空行:回车取消返回 null', () => {
    expect(parseChooseLine('', 3)).toBeNull();
    expect(parseChooseLine('   ', 3)).toBeNull();
  });
  it('非数字:无法解析返回 null', () => {
    expect(parseChooseLine('abc', 3)).toBeNull();
    expect(parseChooseLine('#2', 3)).toBeNull();
  });
});
