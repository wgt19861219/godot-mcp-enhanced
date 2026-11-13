// B3(竞品综述落地批 2026-11-13): run_project 的 proc.on('close') 分支尾部补
// best-effort 死实例 secret 清理——覆盖"游戏崩溃/用户手杀窗口但 server 活"窗口
// (stop_project 通道只在显式 stop 时清)。
// 复用 runtime-stop-secret-cleanup.test.js 模式:真实临时目录 fixture + spy
// cleanDeadInstanceSecrets;不 mock fs(真实验证删除/保留语义)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// I-4 同款策略:仅 stub 断言目标/防真实杀进程项,分桶 API 透传真实模块
vi.mock('../src/core/process-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    killProcess: vi.fn(async () => {}),      // 防真实杀 fake proc
    forceKillTree: vi.fn(),
    killOrphanGodotProcesses: vi.fn(async () => 0),
  };
});

// cleanDeadInstanceSecrets 包装为 vi.fn:默认透传真实实现,异常用例用 mockImplementationOnce
vi.mock('../src/core/bridge-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, cleanDeadInstanceSecrets: vi.fn(actual.cleanDeadInstanceSecrets) };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

import { handleTool } from '../src/tools/runtime.js';
import { resetState, isPidAlive } from '../src/core/process-state.js';
import { cleanDeadInstanceSecrets } from '../src/core/bridge-client.js';
// 造死 pid 须用真实 spawn('child_process' 已 mock 拦截 run_project 的 spawn 调用)
const { spawn: realSpawn } = await vi.importActual('child_process');

const mockProc = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.killed = false;
  proc.unref = vi.fn();
  proc.pid = 54321;
  return proc;
};

function createMockCtx(overrides = {}) {
  return {
    findGodot: vi.fn(async () => '/fake/godot'),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    ...overrides,
  };
}

function writeRegistryEntry(registryDir, file, fields) {
  writeFileSync(join(registryDir, file), JSON.stringify({
    lastSeenMs: Date.now(),
    capabilities: ['registry-heartbeat'],
    ...fields,
  }));
}

function writeSecret(projectDir, port) {
  const p = join(projectDir, '.godot', `mcp_bridge_${port}.secret`);
  writeFileSync(p, `secret-${port}`);
  return p;
}

let projectDir;
let registryDir;
let prevRegistryEnv;

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  projectDir = mkdtempSync(join(tmpdir(), 'b3c-proj-'));
  registryDir = mkdtempSync(join(tmpdir(), 'b3c-reg-'));
  mkdirSync(join(projectDir, '.godot'), { recursive: true });
  mkdirSync(join(projectDir, 'project.godot'), { recursive: true });   // existsSync(join(p,'project.godot')) 通过
  prevRegistryEnv = process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = registryDir;
});

afterEach(() => {
  if (prevRegistryEnv === undefined) delete process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  else process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = prevRegistryEnv;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

async function runProjectAndClose() {
  const proc = mockProc();
  spawn.mockReturnValue(proc);
  const ctx = createMockCtx({ projectDir });
  const resultPromise = handleTool('runtime', {
    action: 'run_project',
    project_path: projectDir,
    timeout: 30,
  }, ctx);
  const result = await resultPromise;   // run_project 返回 → close handler 已注册(setRunSessionProc 先于返回)
  proc.emit('close', 0);                // 游戏进程退出(崩溃/手杀/正常),任意晚于启动的真实时序
  return result;
}

describe('run_project close handler — 死实例 secret 清理(B3)', () => {
  it('游戏进程 close → cleanDeadInstanceSecrets 以 (projectDir, undefined, isPidAlive) 被调', async () => {
    await runProjectAndClose();
    expect(cleanDeadInstanceSecrets).toHaveBeenCalledWith(projectDir, undefined, isPidAlive);
  });

  it('close 清理真实生效:死 pid secret 删、活 pid secret 保留(误删护栏)', async () => {
    const child = realSpawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise((res) => child.on('exit', res));
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9301, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive.json', { projectPath: projectDir, port: 9302, pid: process.pid });
    const sDead = writeSecret(projectDir, 9301);
    const sAlive = writeSecret(projectDir, 9302);

    await runProjectAndClose();

    expect(existsSync(sDead)).toBe(false);    // 游戏退出后的死实例 secret → 删
    expect(existsSync(sAlive)).toBe(true);    // 活实例 secret → 保留(清错在跑实例 = 事故)
  });

  it('清理抛异常不影响 close 收尾(handler 不向上抛,桶快照正常)', async () => {
    cleanDeadInstanceSecrets.mockImplementationOnce(() => { throw new Error('cleanup boom'); });
    let threw = false;
    try {
      await runProjectAndClose();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);   // close handler 内 try-catch 包裹,清理失败不拖垮收尾
  });
});
