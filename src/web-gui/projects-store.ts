// src/web-gui/projects-store.ts
// Web GUI 项目面板数据层(spec 2026-09-15 v2.1):清单持久化(0o600+原子写)+ 白名单
// BFS 扫描(限深4/跳过清单/5000上限/不跟符号链接)+ 并发三规则(§3.1.1)+ 损坏重建。
//
// 并发语义(§3.1.1 三规则):
//  1. 扫描互斥:模块级单飞 promise,进行中再 scan → {started:false, reason:'scanning'}
//  2. 进程内清单读改写串行化:add/remove/scan-合并共享一条 promise 队列;扫描合并阶段
//     re-read 最新清单再合并写回(防扫描期间 add 的条目被旧快照覆盖丢失)
//  3. 跨进程写竞争:接受 last-writer-wins(清单为可再生缓存型数据,重扫描即恢复;
//     锁文件复杂度对此价值不成比例——spec §3.1.1-3 裁决,诚实声明)

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve, normalize } from 'node:path';
import { normalizeProjectKey, isAliveStatus } from '../core/process-state.js';
import type { RunSessionStatus } from '../core/process-state.js';
import { getAllowedProjectPaths, safeRealPath } from '../core/path-utils.js';
import { getLogger } from '../core/logger.js';
import { hardenFilePermissionsWindows } from './registry.js';

export interface ProjectEntry {
  path: string;                       // 绝对路径(写入时 path.resolve 归一)
  name: string;                       // project.godot 的 application/config/name;缺省 basename
  addedAt: string;                    // ISO 时间(入清单时刻)
  source: 'scan' | 'manual';          // 来源标记:上限逐出豁免 manual 条目
}

export interface ProjectView extends ProjectEntry {
  mtime: number | null;               // project.godot 的 stat.mtimeMs;null = Missing
  missing: boolean;                   // project.godot 不存在
  running: boolean;                   // 对照注入会话(isAliveStatus)
  sessionId: string | null;           // 归一化 key(前端项目行与会话行的视觉关联键;无会话 null)
}

export interface ScanResult {
  started: boolean;
  reason?: 'scanning';
  added?: number;
  scanned?: number;
}

export interface ProjectsStoreOpts {
  /** 测试注入目录;缺省 ~/.godot-mcp/web-gui/ */
  dir?: string;
  /** 会话快照注入(接线层取 listRunSessionsDetailed;缺省空数组) */
  getSessions?: () => Array<{ projectPath: string; status: string }>;
  /** 时钟注入(测试可控 addedAt);缺省 Date */
  now?: () => Date;
  /** 扫描根注入(测试可控);缺省 allowlist realpath 归一化链(坏根 catch-跳过) */
  roots?: () => string[];
  /** 单次扫描目录条目上限(测试注入模拟 5000);缺省 MAX_TREE_ENTRIES */
  maxTreeEntries?: number;
}

const MAX_ENTRIES = 200;
const MAX_DEPTH = 4;
const MAX_TREE_ENTRIES = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', 'build', 'dist']);

// 并发规则2(§3.1.1):清单读改写串行队列(模块级,进程内共享)
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

// 并发规则1(§3.1.1):扫描单飞(模块级;finally 清 null)
let scanInFlight: Promise<ScanResult> | null = null;

/** 缺省扫描根链:allowlist 逐条 realpath 归一化(与 getAllowedRealRoots 同链
 *  normalize(safeRealPath(p))),单条目失败 catch-跳过不炸整个扫描——对齐
 *  isPathInAllowedRoots 的 I-4 语义(Task 1 review 移交项:getAllowedRealRoots
 *  数组形态在单坏根时整体抛 PathError,消费侧必须逐条容错)。 */
function resolveScanRoots(): string[] {
  const out: string[] = [];
  for (const p of getAllowedProjectPaths()) {
    try {
      out.push(normalize(safeRealPath(p)));
    } catch (err) {
      getLogger().warn('web-gui', `Scan root realpath failed, skipping: ${p} — ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

/** 轻量 INI 解析(spec §3.2):逐行找 [application] 段内 config/name="...";
 *  失败/缺省 → basename(不引入 project-config.ts 全量解析器,扫描要快)。 */
async function parseProjectName(projectDir: string): Promise<string> {
  try {
    const raw = await readFile(join(projectDir, 'project.godot'), 'utf-8');
    let inApplication = false;
    for (const line of raw.split(/\r?\n/)) {
      const section = line.trim().match(/^\[(.+)\]$/);
      if (section) {
        inApplication = section[1] === 'application';
        continue;
      }
      if (!inApplication) continue;
      const m = line.match(/^config\/name\s*=\s*"(.*)"/);
      if (m && m[1] !== undefined) return m[1];
    }
  } catch {
    // 落回 basename
  }
  return basename(projectDir);
}

/** 上限逐出(§3.1):超 200 只逐 addedAt 最旧的 scan 条目,manual 豁免;
 *  返回 null = 无 scan 可逐(全 manual 满员),调用方应停止添加并 warn。 */
function capEntries(entries: ProjectEntry[]): ProjectEntry[] | null {
  if (entries.length <= MAX_ENTRIES) return entries;
  const out = [...entries];
  while (out.length > MAX_ENTRIES) {
    let oldestIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.source === 'scan' && (oldestIdx === -1 || out[i]!.addedAt <= out[oldestIdx]!.addedAt)) {
        oldestIdx = i;
      }
    }
    if (oldestIdx === -1) return null;
    out.splice(oldestIdx, 1);
  }
  return out;
}

export class ProjectsStore {
  private readonly dirPath: string;
  private readonly listPath: string;
  private readonly getSessions: () => Array<{ projectPath: string; status: string }>;
  private readonly nowFn: () => Date;
  private readonly optsRoots: (() => string[]) | undefined;
  private readonly maxTreeEntries: number;

  constructor(opts: ProjectsStoreOpts = {}) {
    this.dirPath = opts.dir ?? join(homedir(), '.godot-mcp', 'web-gui');
    this.listPath = join(this.dirPath, 'projects.json');
    this.getSessions = opts.getSessions ?? (() => []);
    this.nowFn = opts.now ?? (() => new Date());
    this.optsRoots = opts.roots;
    this.maxTreeEntries = opts.maxTreeEntries ?? MAX_TREE_ENTRIES;
  }

  // ─── 清单文件读写(0o600 + 原子写,registry S-5 同款)─────────────────────

  /** 读取清单;文件缺失/JSON 损坏/结构异常 → 空清单(v2/M3 损坏容错)。 */
  private async readRaw(): Promise<ProjectEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.listPath, 'utf-8')) as { projects?: unknown };
      return Array.isArray(parsed?.projects) ? (parsed.projects as ProjectEntry[]) : [];
    } catch (err) {
      getLogger().warn('web-gui', `projects.json unreadable, rebuilding empty list: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async writeRaw(entries: ProjectEntry[]): Promise<void> {
    const tmpPath = `${this.listPath}.tmp`;
    await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, JSON.stringify({ version: 1, projects: entries }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, this.listPath);
    hardenFilePermissionsWindows(this.listPath);
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────

  /** 清单快照(§3.3):mtime 降序,Missing 沉底(null 当 0)。 */
  async listProjects(): Promise<ProjectView[]> {
    const entries = await this.readRaw();
    const sessions = this.getSessions();
    const views = await Promise.all(entries.map(async (e): Promise<ProjectView> => {
      let mtime: number | null = null;
      let missing = true;
      try {
        mtime = (await stat(join(e.path, 'project.godot'))).mtimeMs;
        missing = false;
      } catch {
        // ENOENT(或路径不可达)→ Missing
      }
      const session = sessions.find(s => s.projectPath === normalizeProjectKey(e.path)) ?? null;
      return {
        ...e,
        mtime,
        missing,
        running: session !== null && isAliveStatus(session.status as RunSessionStatus),
        sessionId: session?.projectPath ?? null,
      };
    }));
    views.sort((a, b) => {
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      return (b.mtime ?? 0) - (a.mtime ?? 0);
    });
    return views;
  }

  /** 手动添加(§3.1):enqueue 内——resolve 归一 + project.godot 存在校验 + 去重
   *  (normalizeProjectKey)+ 200 上限逐出(manual 豁免)+ 写回。
   *  白名单校验在端点层(Task 3,isPathInAllowedRoots 403),store 层不重复。 */
  async addProject(path: string, source: 'manual' = 'manual'): Promise<{ ok: boolean; reason?: 'not_a_project' | 'duplicate' }> {
    return enqueue(async () => {
      const resolved = resolve(path);
      if (!existsSync(join(resolved, 'project.godot'))) return { ok: false, reason: 'not_a_project' };
      const list = await this.readRaw();
      const key = normalizeProjectKey(resolved);
      if (list.some(e => normalizeProjectKey(e.path) === key)) return { ok: false, reason: 'duplicate' };
      const capped = capEntries([...list, { path: resolved, name: await parseProjectName(resolved), addedAt: this.nowFn().toISOString(), source }]);
      if (capped === null) {
        getLogger().warn('web-gui', `projects list full (${MAX_ENTRIES} manual entries), not adding: ${resolved}`);
        return { ok: false };
      }
      await this.writeRaw(capped);
      return { ok: true };
    });
  }

  /** 仅清单移除(不删文件;§4 remove 端点语义)。 */
  async removeProject(path: string): Promise<{ ok: boolean; reason?: 'not_found' }> {
    return enqueue(async () => {
      const key = normalizeProjectKey(resolve(path));
      const list = await this.readRaw();
      const kept = list.filter(e => normalizeProjectKey(e.path) !== key);
      if (kept.length === list.length) return { ok: false, reason: 'not_found' };
      await this.writeRaw(kept);
      return { ok: true };
    });
  }

  /** 扫描(§3.2):规则1 互斥 → UNRESTRICTED 拒绝 → roots(空落 cwd)→ BFS →
   *  规则2 合并(enqueue + re-read)。 */
  async scanProjects(onProgress?: (found: number, scanned: number) => void): Promise<ScanResult> {
    if (scanInFlight) return { started: false, reason: 'scanning' };
    if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
      throw new Error('UNRESTRICTED 模式不支持扫描,请用添加按钮');
    }
    const job = this.runScan(onProgress);
    scanInFlight = job;
    try {
      return await job;
    } finally {
      scanInFlight = null;
    }
  }

  private async runScan(onProgress?: (found: number, scanned: number) => void): Promise<ScanResult> {
    let roots = this.optsRoots ? this.optsRoots() : resolveScanRoots();
    if (roots.length === 0) roots = [process.cwd()];              // 空 allowlist → cwd(spec IMP-2)
    const { found, scanned } = await this.bfsScan(roots, onProgress);
    // 规则2:合并走 enqueue,闭包内 re-read 最新清单(防扫描期间 add 的条目被覆盖)
    return enqueue(async () => {
      const fresh = await this.readRaw();
      const existingKeys = new Set(fresh.map(e => normalizeProjectKey(e.path)));
      const newOnes = found.filter(e => !existingKeys.has(normalizeProjectKey(e.path)));
      const capped = capEntries([...fresh, ...newOnes]);
      if (capped === null) {
        getLogger().warn('web-gui', `projects list full (${MAX_ENTRIES} manual entries), scan results not merged (${newOnes.length} found)`);
        await this.writeRaw(fresh);
        return { started: true, added: 0, scanned };
      }
      await this.writeRaw(capped);
      const cappedKeys = new Set(capped.map(e => normalizeProjectKey(e.path)));
      const added = newOnes.filter(e => cappedKeys.has(normalizeProjectKey(e.path))).length;
      return { started: true, added, scanned };
    });
  }

  /** BFS 扫描:限深 4、跳过清单目录、条目上限、不跟随符号链接/junction
   *  (readdir withFileTypes 判 isDirectory() && !isSymbolicLink();Windows junction
   *  判别有版本差异,防环退化为限深+条目上限兜底——spec v2.1)。发现项目即
   *  收集且不下钻(Godot 项目内无嵌套项目)。 */
  private async bfsScan(roots: string[], onProgress?: (found: number, scanned: number) => void): Promise<{ found: ProjectEntry[]; scanned: number }> {
    const found: ProjectEntry[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let treeCount = 0;
    const pending: Array<{ dir: string; depth: number }> = roots.map(r => ({ dir: r, depth: 0 }));
    while (pending.length > 0) {
      const item = pending.shift();
      if (item === undefined) break;
      scanned++;
      let entries: Dirent[];
      try {
        entries = await readdir(item.dir, { withFileTypes: true });
      } catch {
        continue;                                                   // 根不可达/权限 → 跳过该目录
      }
      if (entries.some(e => e.isFile() && e.name === 'project.godot')) {
        const projectDir = resolve(item.dir);
        const key = normalizeProjectKey(projectDir);
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ path: projectDir, name: await parseProjectName(projectDir), addedAt: this.nowFn().toISOString(), source: 'scan' });
          onProgress?.(found.length, scanned);
        }
        continue;                                                   // 发现即停,不下钻
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (SKIP_DIRS.has(e.name)) continue;
        if (item.depth + 1 > MAX_DEPTH) continue;                   // 限深 4:第 5 层不入队
        treeCount++;
        if (treeCount > this.maxTreeEntries) continue;              // 防超大树剪枝
        pending.push({ dir: join(item.dir, e.name), depth: item.depth + 1 });
      }
    }
    return { found, scanned };
  }
}
