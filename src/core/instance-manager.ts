// src/core/instance-manager.ts
/**
 * InstanceManager — multi-instance discovery and registry management (Phase 2b)
 *
 * Discovers running Godot instances via:
 * 1. Machine-level registry: ~/.godot-mcp/instances/
 * 2. Project-level registry: {project}/.godot/mcp-instances/
 *
 * Each instance writes its own JSON file (no concurrent write contention).
 * Stale detection: lastSeen > staleTimeout → stale status.
 *
 * 2026-08-10 (行225): 补全写入能力——registerSelf/unregisterSelf/updateLastSeen/allocatePort，
 * 让 TS server 也能把自己注册到 registry（此前仅 GD 端 editor/headless 写入，TS 端只读）。
 * 配合 instance-http-server.ts 实现 MULTI_INSTANCE 接收端闭环。
 */

import { readdir, readFile, writeFile, mkdir, unlink, rename } from 'fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'path';
import { homedir, userInfo } from 'os';
import { randomBytes } from 'crypto';
import { getLogger } from './logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InstanceInfo {
  id: string;
  projectPath: string;
  projectName: string;
  port: number;
  pid: number;
  lastSeen: string;       // ISO 8601
  godotVersion: string;
  capabilities: string[];  // e.g. ['registry-heartbeat']

  // Phase 2 新增（可选，旧插件不写此字段）
  status?: 'ready' | 'compiling' | 'unresponsive';
  registeredAt?: number;
}

export type InstanceStatus = 'alive' | 'stale' | 'unreachable';

/**
 * C-02 安全：类型守卫函数，验证 JSON 解析后的对象满足 InstanceInfo 必需字段。
 * 防止损坏/恶意 JSON 通过 as 强制转型后产生 undefined 行为。
 */
function isInstanceInfo(obj: unknown): obj is InstanceInfo {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    // S-6: id 必须是无路径分隔符/无 .. 的纯标识符(对齐 projectPath 的段级校验),
    // 防 evil.json 注入 {id:"../../etc/x"} 经 unregisterSelf 拼路径删任意 .json。
    typeof o.id === 'string' && o.id.length > 0 && /^[A-Za-z0-9_-]+$/.test(o.id) &&
    typeof o.projectPath === 'string' && o.projectPath.length > 0 &&
    typeof o.projectName === 'string' && o.projectName.length > 0 &&
    typeof o.port === 'number' && o.port >= 1 && o.port <= 65535 &&
    typeof o.pid === 'number' &&
    typeof o.lastSeen === 'string' && o.lastSeen.length > 0 &&
    typeof o.godotVersion === 'string' &&
    Array.isArray(o.capabilities) &&
    (o.capabilities as unknown[]).every(c => typeof c === 'string')
  );
}

export interface InstanceManagerOptions {
  /** Machine-level registry directory. Defaults to ~/.godot-mcp/instances/ */
  registryDir?: string;
  /** Project-level registry directory. Optional. */
  projectRegistryDir?: string;
  /** Stale timeout in ms. Defaults to 70000 (70s). */
  staleTimeoutMs?: number;
  /** CMP-7: pid liveness probe override (测试注入用)。默认用 process.kill(pid, 0)。 */
  isPidAlive?: (pid: number) => boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALE_TIMEOUT_MS = 70000; // 30s × 2 + 10s jitter margin
// 导出供 bridge-client 的 registry 回落窗口扫描对齐(与 mcp_bridge.gd PORT_ATTEMPTS=10 同步,
// 契约锁定见 test/port-race-mitigation-contract.test.ts)
export const DEFAULT_PORT_START = 9081;
export const DEFAULT_PORT_END = 9090;

export function getDefaultRegistryDir(): string {
  return join(homedir(), '.godot-mcp', 'instances');
}

/**
 * S-5: Windows 下收紧 registry 文件 ACL(对齐 instance-api-auth.ts:81-92,但 registry 文件需可改可删)。
 * Linux/macOS 由 writeFile mode:0o600 / mkdir mode:0o700 覆盖;Windows 无视 mode,需 icacls。
 * 用 /inheritance:r + username:F(owner 完全控制,移除继承 = 其他人无权)—— 非 :R(只读会致
 * updateLastSeen/unregisterSelf 的写/删失败)。best-effort:失败只 warn,不阻断写入。
 */
function hardenFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const username = userInfo().username;
    if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
      // Task 4(2026-11-22 spawn 点自查):补 timeout 15s(短命令参照)——execFileSync
      // 同步阻塞,icacls 挂死会卡死 server。
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], { stdio: 'ignore', timeout: 15_000 });
    } else {
      getLogger().warn('instance-manager', `Username "${username}" has unexpected chars, skipping ACL restriction for ${filePath}`);
    }
  } catch {
    getLogger().warn('instance-manager', `ACL restriction failed for ${filePath}, file may inherit default permissions`);
  }
}

function parsePortRange(): [number, number] {
  const env = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  if (!env) return [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const parts = env.split('-').map(Number);
  if (
    parts.length === 2 &&
    Number.isFinite(parts[0]) && Number.isFinite(parts[1]) &&
    parts[0]! >= 1 && parts[0]! <= 65535 &&
    parts[1]! >= 1 && parts[1]! <= 65535 &&
    parts[0]! < parts[1]!
  ) {
    return [parts[0]!, parts[1]!];
  }
  return [DEFAULT_PORT_START, DEFAULT_PORT_END];
}

// ─── InstanceManager ────────────────────────────────────────────────────────

export class InstanceManager {
  private readonly registryDir: string;
  private readonly projectRegistryDir?: string;
  private readonly staleTimeoutMs: number;
  private readonly _portRange: [number, number];
  private readonly _isPidAlive: (pid: number) => boolean;
  private instances: Map<string, InstanceInfo> = new Map();

  constructor(opts: InstanceManagerOptions = {}) {
    this.registryDir = opts.registryDir ?? getDefaultRegistryDir();
    this.projectRegistryDir = opts.projectRegistryDir;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this._portRange = parsePortRange();
    this._isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  }

  /** Get configured port range. */
  get portRange(): [number, number] {
    return this._portRange;
  }

  /** Load instances from both registry levels. Machine-level first, then project-level overrides. */
  async loadFromRegistry(): Promise<InstanceInfo[]> {
    const merged = new Map<string, InstanceInfo>();

    // Machine-level first
    const machineInstances = await this.readRegistryDir(this.registryDir);
    for (const inst of machineInstances) {
      merged.set(inst.id, inst);
    }

    // Project-level overrides (project wins on duplicate id)
    if (this.projectRegistryDir) {
      const projectInstances = await this.readRegistryDir(this.projectRegistryDir);
      for (const inst of projectInstances) {
        merged.set(inst.id, inst);
      }
    }

    this.instances = merged;
    return [...merged.values()];
  }

  /** Get instance by id. */
  getInstance(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  /** Get all loaded instances. */
  getAllInstances(): InstanceInfo[] {
    return [...this.instances.values()];
  }

  /** Determine status of an instance based on lastSeen timestamp + pid liveness. */
  getStatus(instance: InstanceInfo): InstanceStatus {
    // Phase 2: compiling overrides stale detection
    if (instance.status === 'compiling') {
      return 'alive';
    }
    if (instance.status === 'unresponsive') {
      return 'unreachable';
    }
    // CMP-7 (2026-08-08): pid liveness probe——pid 不存活直接标 unreachable,
    // 不等 lastSeen 超时(原仅靠时间戳,进程崩溃但 lastSeen 未过期的 zombie instance 误判 alive)。
    if (!this._isPidAlive(instance.pid)) {
      return 'unreachable';
    }
    // Existing stale logic
    const lastSeen = new Date(instance.lastSeen).getTime();
    const elapsed = Date.now() - lastSeen;
    if (elapsed < this.staleTimeoutMs) return 'alive';
    return 'stale';
  }

  // ─── 写入能力（2026-08-10 行225：TS server 注册自己到 registry）──────────────
  // 此前 InstanceManager 是纯只读（仅 readFile/readdir 发现任实例）。
  // MULTI_INSTANCE 接收端闭环要求 TS server 也写入自己的 InstanceInfo，
  // 让其他 MCP 实例能发现并 route 到它。写入模式仿 GD 端 instance_registry.gd:93-104
  // 的原子写（.tmp → rename），防并发读看到半写文件。

  /**
   * 注册（或更新）一个实例到 registry。原子写 .tmp → rename。
   * 机器级 registry 优先（TS server 跨项目，projectRegistryDir 可选时写 machine-level）。
   */
  async registerSelf(info: InstanceInfo): Promise<void> {
    const dir = this.projectRegistryDir ?? this.registryDir;
    const filePath = join(dir, `${info.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      // S-5: registry 文件含 projectPath + pid,收紧权限防多用户机器信息泄露
      // (对齐 instance-api-auth.ts:78 的 0o600 + icacls 模式)。
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmpPath, JSON.stringify(info, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await rename(tmpPath, filePath);
      hardenFilePermissionsWindows(filePath);
    } catch (err) {
      getLogger().warn('instance-manager', `registerSelf failed for ${info.id}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  /** 删除一个实例的 registry JSON（退出清理用）。best-effort，不存在不报错。 */
  async unregisterSelf(id: string): Promise<void> {
    // 同时尝试两个 registry 目录（写入时可能写 projectRegistryDir，清理时两处都删）
    const dirs = [this.registryDir];
    if (this.projectRegistryDir) dirs.push(this.projectRegistryDir);
    for (const dir of dirs) {
      try {
        await unlink(join(dir, `${id}.json`));
      } catch { /* ENOENT 等忽略——best-effort */ }
    }
  }

  /** 心跳更新：只改 lastSeen 字段，原子重写。读失败/解析失败则 no-op（不阻断心跳定时器）。 */
  async updateLastSeen(id: string): Promise<void> {
    const dirs = [this.registryDir];
    if (this.projectRegistryDir) dirs.push(this.projectRegistryDir);
    for (const dir of dirs) {
      const filePath = join(dir, `${id}.json`);
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!isInstanceInfo(parsed)) continue;
        parsed.lastSeen = new Date().toISOString();
        const tmpPath = `${filePath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(parsed, null, 2), { encoding: 'utf-8', mode: 0o600 });
        await rename(tmpPath, filePath);
        return; // 只更新第一个找到的文件
      } catch { /* 文件不存在/损坏→试下一个目录 */ }
    }
  }

  /**
   * 在 portRange 内找第一个未被占用的端口。
   * @param existingPorts 已占用端口集合（从 loadFromRegistry 结果提取）
   * @returns 第一个空闲端口
   * @throws 全部占用时 throw（不静默 fallback，让调用方决策）
   */
  allocatePort(existingPorts: number[]): number {
    const used = new Set(existingPorts);
    const [start, end] = this._portRange;
    for (let port = start; port <= end; port++) {
      if (!used.has(port)) return port;
    }
    throw new Error(`No free port in range ${start}-${end} (all ${end - start + 1} ports occupied by registered instances)`);
  }

  /** Read instance JSON files from a directory. Corrupt/invalid files are skipped. */
  private async readRegistryDir(dir: string): Promise<InstanceInfo[]> {
    const results: InstanceInfo[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          const parsed = JSON.parse(content);
          // C-02 安全：使用类型守卫验证所有必需字段
          if (!isInstanceInfo(parsed)) continue;
          // C-02 安全：段级路径遍历检查 — 任一路径段恰好为 '..'(原 includes('..') 误拒 '..backup' 等合法子串)
          if (parsed.projectPath.split(/[\\/]/).some(seg => seg === '..')) continue;
          results.push(parsed);
        } catch {
          // Skip corrupt/invalid files (ENOENT, SyntaxError, etc.)
        }
      }
    } catch {
      // Directory doesn't exist �?return empty
    }
    return results;
  }
}

/**
 * CMP-7 (2026-08-08): 检测 pid 是否存活。用 process.kill(pid, 0) 发 signal 0(不实际杀进程)。
 * - 存活:返回 true(signal 0 成功无异常)
 * - 不存活:返回 false(ESRCH=no such process / Windows EPERM)
 * 跨平台:POSIX 信号 0 + Windows process.kill 都支持此语义。
 * 注:与 src/core/process-state.ts:52 isPidAlive 同语义(模块独立重复,避免 instance-manager 依赖
 * process-state)。若 pid 检测逻辑变化需两处同步。
 */
function defaultIsPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;  // ESRCH (process not found) or EPERM (Windows permission)
  }
}

/** Convenience: get machine-level registry directory path. */
export function getMachineRegistryDir(): string {
  return getDefaultRegistryDir();
}

/** Convenience: discover all instances. Creates a temporary manager and runs discovery. */
export async function discoverInstances(opts?: InstanceManagerOptions): Promise<InstanceInfo[]> {
  const manager = new InstanceManager(opts);
  return await manager.loadFromRegistry();
}

/**
 * 构造本 TS server 实例的 InstanceInfo（2026-08-10 行225：接收端注册自己用）。
 * id 格式 `ts-<pid>-<random6>`（对齐 GD 端 editor-<port> / <pid>_<ticks> 命名惯例，
 * ts- 前缀区分来源）。projectPath/projectName 来自调用方（resolveProjectPath 结果）。
 */
export function buildInstanceInfo(opts: {
  port: number;
  projectPath: string;
  projectName: string;
  godotVersion?: string;
}): InstanceInfo {
  const random = randomBytes(3).toString('hex'); // 6 hex chars
  return {
    id: `ts-${process.pid}-${random}`,
    projectPath: opts.projectPath,
    projectName: opts.projectName,
    port: opts.port,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
    godotVersion: opts.godotVersion ?? 'unknown',
    capabilities: ['ts-http-receiver'],
    status: 'ready',
    registeredAt: Date.now(),
  };
}
