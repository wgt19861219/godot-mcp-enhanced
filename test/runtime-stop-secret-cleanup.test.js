// Task B3(反馈批次 2026-11-12): stop_project kill 成功后 best-effort 清本项目死实例 secret。
// 判死依据 = machine registry 条目 pid 的进程探测(isPidAlive),非 lastSeen 新鲜度。
// 本文件刻意**不 mock fs/path**(与 runtime.test.js 相反)——registry 条目与 secret 文件
// 用真实临时目录验证删除/保留的真实文件系统语义。
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

import { handleTool } from '../src/tools/runtime.js';
import { setRunSessionProc, resetState } from '../src/core/process-state.js';
import { cleanDeadInstanceSecrets } from '../src/core/bridge-client.js';
import { stripEnvelope } from '../src/core/untrusted-wrap.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/** 取一个保证已死的真实 pid(spawn 短命子进程并等其退出;pid 复用窗口内实测安全)。 */
async function getDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((res) => child.on('exit', res));
  return pid;
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

const stopAndParse = async (projectDir) => {
  const r = await handleTool('runtime', { action: 'stop_project', project_path: projectDir }, createMockCtx());
  return { text: r.content[0].text, parsed: JSON.parse(stripEnvelope(r.content[0].text)) };
};

// ─── Tests ──────────────────────────────────────────────────────────────────

let projectDir;
let registryDir;
let prevRegistryEnv;

beforeEach(() => {
  resetState();
  projectDir = mkdtempSync(join(tmpdir(), 'b3-proj-'));
  registryDir = mkdtempSync(join(tmpdir(), 'b3-reg-'));
  mkdirSync(join(projectDir, '.godot'), { recursive: true });
  prevRegistryEnv = process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = registryDir;
});

afterEach(() => {
  if (prevRegistryEnv === undefined) delete process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR;
  else process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = prevRegistryEnv;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('stop_project — 死实例 secret 清理(B3)', () => {
  it('死 pid 条目 secret 删除、活 pid/pid 缺失/非心跳条目保留,响应含 secretsCleaned', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9101, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive.json', { projectPath: projectDir, port: 9102, pid: process.pid });
    writeRegistryEntry(registryDir, 'nopid.json', { projectPath: projectDir, port: 9103 });
    writeRegistryEntry(registryDir, 'server.json', { projectPath: projectDir, port: 9104, pid: deadPid, capabilities: ['ts-http-receiver'] });
    const s9101 = writeSecret(projectDir, 9101);
    const s9102 = writeSecret(projectDir, 9102);
    const s9103 = writeSecret(projectDir, 9103);
    const s9104 = writeSecret(projectDir, 9104);

    setRunSessionProc(projectDir, mockProc(), true);
    const { parsed } = await stopAndParse(projectDir);

    expect(parsed.status).toBe('stopped');
    expect(parsed.secretsCleaned).toEqual([9101]);
    expect(existsSync(s9101)).toBe(false);   // 死条目 → 删
    expect(existsSync(s9102)).toBe(true);    // 活实例 → 保留
    expect(existsSync(s9103)).toBe(true);    // pid 缺失无法判死 → 保守保留
    expect(existsSync(s9104)).toBe(true);    // server 自注册条目(非 registry-heartbeat)→ 不在判死面
  });

  it('清理抛异常不影响 stop 主响应(附告警,secretsCleaned 空清单)', async () => {
    cleanDeadInstanceSecrets.mockImplementationOnce(() => { throw new Error('cleanup boom'); });
    setRunSessionProc(projectDir, mockProc(), true);

    const { parsed } = await stopAndParse(projectDir);
    expect(parsed.status).toBe('stopped');
    expect(parsed.secretsCleaned).toEqual([]);
    expect(parsed.secret_cleanup_warning).toContain('cleanup boom');
  });

  it('registry 目录不可读 → 空清单不报错(无法判死保守不清)', async () => {
    process.env.GODOT_MCP_BRIDGE_REGISTRY_DIR = join(registryDir, 'not-exists');
    setRunSessionProc(projectDir, mockProc(), true);

    const { parsed } = await stopAndParse(projectDir);
    expect(parsed.status).toBe('stopped');
    expect(parsed.secretsCleaned).toEqual([]);
  });
});
