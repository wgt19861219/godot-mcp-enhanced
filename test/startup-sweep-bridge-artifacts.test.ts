// B2(竞品综述落地批 2026-11-13): 启动自愈 sweepStaleBridgeArtifacts。
// 方案 docs/plans/2026-11-13-竞品综述落地批方案.md Task B2(对齐 Erodenn v4 "硬杀自清理"):
// - 扫 ~/.godot-mcp/instances/ registry JSON,pid 探活,死条目 unlink
// - secret 清理仅 flag 开(GODOT_MCP_STARTUP_CLEANUP)时做,复用 cleanDeadInstanceSecrets
//   判活护栏(只清 pid 已死者)——误删在跑实例 = 事故(Review Focus #2)
// 本文件与 runtime-stop-secret-cleanup.test.js 同款:刻意不 mock fs,真临时目录验证。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepStaleBridgeArtifacts, cleanDeadInstanceSecrets } from '../src/core/bridge-client.js';
import { isPidAlive } from '../src/core/process-state.js';

/** 取一个保证已死的真实 pid(spawn 短命子进程并等其退出;pid 复用窗口内实测安全)。 */
async function getDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((res) => child.on('exit', res));
  return pid;
}

function writeRegistryEntry(registryDir: string, file: string, fields: Record<string, unknown>) {
  writeFileSync(join(registryDir, file), JSON.stringify({
    lastSeenMs: Date.now(),
    capabilities: ['registry-heartbeat'],
    ...fields,
  }));
}

function writeSecret(projectDir: string, port: number) {
  const p = join(projectDir, '.godot', `mcp_bridge_${port}.secret`);
  writeFileSync(p, `secret-${port}`);
  return p;
}

let projectDir: string;
let registryDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'b2-proj-'));
  registryDir = mkdtempSync(join(tmpdir(), 'b2-reg-'));
  mkdirSync(join(projectDir, '.godot'), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('sweepStaleBridgeArtifacts — 死 registry 条目清理(默认面,flag 无关)', () => {
  it('死 pid 心跳条目被 unlink;活 pid/pid 缺失/非心跳(server 自注册)/损坏条目保留', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9201, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive.json', { projectPath: projectDir, port: 9202, pid: process.pid });
    writeRegistryEntry(registryDir, 'nopid.json', { projectPath: projectDir, port: 9203 });
    writeRegistryEntry(registryDir, 'server.json', { projectPath: projectDir, port: 9204, pid: deadPid, capabilities: ['ts-http-receiver'] });
    writeFileSync(join(registryDir, 'corrupt.json'), '{not json');

    const r = sweepStaleBridgeArtifacts(registryDir, isPidAlive);

    expect(r.removedEntries).toBe(1);
    expect(existsSync(join(registryDir, 'dead.json'))).toBe(false);       // 死条目 → 清
    expect(existsSync(join(registryDir, 'alive.json'))).toBe(true);       // 活实例条目 → 保留
    expect(existsSync(join(registryDir, 'nopid.json'))).toBe(true);       // pid 缺失无法判死 → 保留
    expect(existsSync(join(registryDir, 'server.json'))).toBe(true);      // server 自注册条目(非 registry-heartbeat)→ 不在 sweep 面
    expect(existsSync(join(registryDir, 'corrupt.json'))).toBe(true);     // 损坏条目容错跳过(sweep 不负责修数据)
  });

  it('flag 关(默认)→ secret 不动(sweep 默认面只做无副作用的死条目 unlink)', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9201, pid: deadPid });
    const s9201 = writeSecret(projectDir, 9201);

    const r = sweepStaleBridgeArtifacts(registryDir, isPidAlive);   // cleanSecrets 缺省 = false

    expect(r.removedEntries).toBe(1);
    expect(r.secretsCleanedPorts).toEqual([]);
    expect(existsSync(s9201)).toBe(true);   // 默认不删 secret——安全默认,secret 清理须显式 opt-in
  });

  it('flag 开 → 死 pid secret 清理、活 pid secret 保留(误删护栏,Review Focus #2)', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9201, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive.json', { projectPath: projectDir, port: 9202, pid: process.pid });
    const s9201 = writeSecret(projectDir, 9201);
    const s9202 = writeSecret(projectDir, 9202);

    const r = sweepStaleBridgeArtifacts(registryDir, isPidAlive, { cleanSecrets: true });

    expect(r.removedEntries).toBe(1);
    expect(r.secretsCleanedPorts).toEqual([9201]);
    expect(existsSync(s9201)).toBe(false);   // 死实例 secret → 删
    expect(existsSync(s9202)).toBe(true);    // 活实例 secret → 必须保留(清错在跑实例 = 事故)
  });

  it('isAlive 缺省(() => true 保守全保留)→ sweep 无操作(无探测能力即不清)', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead.json', { projectPath: projectDir, port: 9201, pid: deadPid });

    const r = sweepStaleBridgeArtifacts(registryDir);   // 不注 isAlive

    expect(r.removedEntries).toBe(0);
    expect(existsSync(join(registryDir, 'dead.json'))).toBe(true);
  });

  it('registry 目录不可读 → no-op 不抛(返回零计数)', () => {
    const r = sweepStaleBridgeArtifacts(join(registryDir, 'not-exists'), isPidAlive);
    expect(r).toEqual({ removedEntries: 0, secretsCleanedPorts: [] });
  });

  it('多项目死条目 → flag 开时逐项目 secret 清理(secretsCleanedPorts 汇总)', async () => {
    const deadPid = await getDeadPid();
    const projectDir2 = mkdtempSync(join(tmpdir(), 'b2-proj2-'));
    try {
      mkdirSync(join(projectDir2, '.godot'), { recursive: true });
      writeRegistryEntry(registryDir, 'dead1.json', { projectPath: projectDir, port: 9201, pid: deadPid });
      writeRegistryEntry(registryDir, 'dead2.json', { projectPath: projectDir2, port: 9202, pid: deadPid });
      const s1 = writeSecret(projectDir, 9201);
      const s2 = writeSecret(projectDir2, 9202);

      const r = sweepStaleBridgeArtifacts(registryDir, isPidAlive, { cleanSecrets: true });

      expect(r.removedEntries).toBe(2);
      expect(r.secretsCleanedPorts.sort()).toEqual([9201, 9202]);
      expect(existsSync(s1)).toBe(false);
      expect(existsSync(s2)).toBe(false);
    } finally {
      rmSync(projectDir2, { recursive: true, force: true });
    }
  });

  // 审查 blocking 回归(2026-11-13): 死实例端口被活实例复用 —— A(pid 已死)硬杀后端口
  // 释放,同项目 B(活)复用同端口并覆盖写同路径 secret(secret 文件名只含端口),死/活条目
  // (project, port) 同值指向**同一 secret 文件**;按死条目 pid unlink 删的是活实例 B 正在
  // 用的 secret(TS 端缓存 TTL 过期后重读 ENOENT → 认证断,须重启游戏恢复)。
  it('死/活条目同 port(端口被活实例复用)→ 该端口 secret 跳过清理、无占用死端口照清', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead-a.json', { projectPath: projectDir, port: 9201, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive-b.json', { projectPath: projectDir, port: 9201, pid: process.pid });
    writeRegistryEntry(registryDir, 'dead-c.json', { projectPath: projectDir, port: 9203, pid: deadPid });   // 对照:无活实例占用的死端口
    const s9201 = writeSecret(projectDir, 9201);
    const s9203 = writeSecret(projectDir, 9203);

    const r = sweepStaleBridgeArtifacts(registryDir, isPidAlive, { cleanSecrets: true });

    expect(r.removedEntries).toBe(2);                                      // 死条目本身(A/C)仍 unlink(条目清理不受影响)
    expect(existsSync(join(registryDir, 'dead-a.json'))).toBe(false);
    expect(existsSync(join(registryDir, 'alive-b.json'))).toBe(true);
    expect(r.secretsCleanedPorts).toEqual([9203]);                         // 9201 被活实例 B 占用 → 跳过;9203 无占用 → 照清
    expect(existsSync(s9201)).toBe(true);                                  // B 正在用的 secret 必须保留(清错在跑实例 = 事故)
    expect(existsSync(s9203)).toBe(false);
  });

  // B3 通道(runtime close/stop handler)直调 cleanDeadInstanceSecrets——修复须落在函数内部
  // 才能同时覆盖 B2(sweep)与 B3 两条通道,此处锚定直调路径同款防护。
  it('cleanDeadInstanceSecrets 直调:死/活条目同 port → secret 保留', async () => {
    const deadPid = await getDeadPid();
    writeRegistryEntry(registryDir, 'dead-a.json', { projectPath: projectDir, port: 9201, pid: deadPid });
    writeRegistryEntry(registryDir, 'alive-b.json', { projectPath: projectDir, port: 9201, pid: process.pid });
    const s9201 = writeSecret(projectDir, 9201);

    const cleaned = cleanDeadInstanceSecrets(projectDir, registryDir, isPidAlive);

    expect(cleaned).toEqual([]);           // 端口被活实例占用 → 不清
    expect(existsSync(s9201)).toBe(true);  // 活实例 secret 必须保留
  });
});
