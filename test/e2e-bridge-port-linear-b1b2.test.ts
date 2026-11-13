/**
 * 反馈批次 2026-11-12 Task B1 e2e:显式端口起点线性避让——行为级真机锚定
 * (headless spawn + Node 侧 TCP 探测,不经 TS bridge client,auth/解析层不在本测范围)。
 *
 * env GODOT_MCP_BRIDGE_PORT=9095 起两实例:修复前环形取模把 9095 钳回 [9081,9090] 窗
 * (9095→9085),CI 连跑无法按次错开(2026-11-07 反馈症状①);修复后两实例分别监听
 * 9095/9096(第二实例探测到 9095 被占后线性 +1)。
 *
 * fixture:tmp 目录最小骨架(autoload 预注册 + 空 main.tscn + 拷入 bundled mcp_bridge.gd),
 * headless spawn(--headless 下 bridge 照常启动,不弹窗)。
 * 守卫:GODOT_PATH(skipIf;CI 无 Godot 时 skip)。源码契约见
 * test/bridge-feedback-batch-b1b2-contract.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);

if (!hasGodot) {
  process.stderr.write('[skip] B1 port-linear e2e skipped — Godot not found (GODOT_PATH).\n');
}

/** 等待端口出现监听(能建立 TCP 连接 = 占用,与 GD _port_in_use 同判据)。 */
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveDone) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolveDone(true); });
      sock.once('error', () => {
        if (Date.now() > deadline) resolveDone(false);
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

interface Spawned { proc: ChildProcess; getStdout(): string }

/** Windows GUI 版 exe 不回 stdout——对齐 validation.ts 模式换 _console.exe 伴生二进制。 */
function spawnBinary(): string {
  if (process.platform === 'win32' && !GODOT_PATH.endsWith('_console.exe')) {
    const consolePath = GODOT_PATH.replace(/\.exe$/, '_console.exe');
    if (existsSync(consolePath)) return consolePath;
  }
  return GODOT_PATH;
}

/** headless spawn 游戏实例,收集 stdout+stderr(bridge print 走 stdout)。 */
function spawnGame(envExtra: Record<string, string>): Spawned {
  const proc = spawn(spawnBinary(), ['--headless', '--path', FIXTURE], {
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  proc.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
  return { proc, getStdout: () => output };
}

function killProc(sp: Spawned): void {
  try { sp.proc.kill(); } catch { /* best-effort */ }
  try { sp.proc.kill('SIGKILL'); } catch { /* best-effort */ }
}

const WAIT_BRIDGE_MS = 40_000; // 首次 --headless 可能触发 import,放宽
let FIXTURE = '';

describe.skipIf(!hasGodot)('B1 端口线性避让 e2e', { timeout: 240_000, sequential: true }, () => {
  const instances: Spawned[] = [];
  let projectGodotSnap = '';
  let _initError: string | null = null;

  beforeAll(() => {
    try {
      // tmp fixture:self-destruct-e2e 的 project.godot 骨架(autoload 预注册)+ 空 main 场景
      // + bundled mcp_bridge.gd——不直接改 fixtures 目录(其它 e2e 共用)
      FIXTURE = resolve(tmpdir(), `b1b2-port-e2e-${Date.now()}`);
      rmSync(FIXTURE, { recursive: true, force: true });
      mkdirSync(FIXTURE, { recursive: true });
      const config = readFileSync(resolve(__dirname, 'fixtures', 'self-destruct-e2e', 'project.godot'), 'utf-8');
      projectGodotSnap = config;
      writeFileSync(resolve(FIXTURE, 'project.godot'),
        config.replace('config/name="self-destruct-e2e"', 'config/name="b1b2-port-e2e"'));
      // 最小 main 场景(空 Node 根——本测只验 bridge 生命周期,无需 UI)
      writeFileSync(resolve(FIXTURE, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node"]\n');
      copyFileSync(resolve(REPO, 'src', 'scripts', 'mcp_bridge.gd'), resolve(FIXTURE, 'mcp_bridge.gd'));
    } catch (e) {
      _initError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[skip] B1 e2e beforeAll failed — ${_initError}\n`);
    }
  }, 60_000);

  afterAll(() => {
    for (const sp of instances) killProc(sp);
    try {
      if (FIXTURE) writeFileSync(resolve(FIXTURE, 'project.godot'), projectGodotSnap);
      rmSync(FIXTURE, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it('B1: env PORT=9095 起两实例 → 9095/9096 线性监听(不被钳回 9081-9090 窗)', async (ctx) => {
    if (_initError) return ctx.skip(_initError);

    const a = spawnGame({ GODOT_MCP_BRIDGE_PORT: '9095' });
    instances.push(a);
    const up1 = await waitForPort(9095, WAIT_BRIDGE_MS);
    process.stderr.write(`[B1] instance-a stdout tail: ${a.getStdout().slice(-500)}\n`);
    expect(up1, `实例 A 须监听 9095(线性起点)。stdout 尾部: ${a.getStdout().slice(-400)}`).toBe(true);

    const b = spawnGame({ GODOT_MCP_BRIDGE_PORT: '9095' });
    instances.push(b);
    const up2 = await waitForPort(9096, WAIT_BRIDGE_MS);
    process.stderr.write(`[B1] instance-b stdout tail: ${b.getStdout().slice(-500)}\n`);
    expect(up2, `实例 B 须线性避让到 9096(9095 被占 +1)。stdout 尾部: ${b.getStdout().slice(-400)}`).toBe(true);
    expect(b.getStdout().includes('Listening on 127.0.0.1:9096'), '实例 B 监听日志须为 9096').toBe(true);
    // 钳窗回归锚:监听日志不得落在 9081-9090 窗(修复前 9095 被环形取模钳回 9085/9086)
    for (const sp of [a, b]) {
      const m = /Listening on 127\.0\.0\.1:(\d+)/.exec(sp.getStdout());
      expect(m, '须有 Listening 监听日志').toBeTruthy();
      const port = Number(m![1]);
      expect(port >= 9095, `修复前环形取模会把 9095 钳回窗内(实际 ${port})`).toBe(true);
    }
  }, 120_000);
});
