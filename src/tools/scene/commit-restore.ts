// src/tools/scene/commit-restore.ts
//
// 批 B2 (2026-10-26,竞品综述建议2 三件套之二): scene.commit 的 restore point
// 作用域回滚(对标 Unreal_mcp 685e59cd "restore points roll back only this
// server's steps")。commit 写盘前,TS 侧对将写文件(场景 .tscn + TILESET_RESOURCE_OPS
// 涉及的 .tres)备份到 ~/.godot-mcp/restore-points/<projectHash>/<runId>/;commit
// 结果附 restore_point {id, files};`commit_restore` 按 id 恢复本 commit 触及的
// 文件(作用域=该次提交,不碰其他);`commit_restore_list` 列点;LRU 保留最近
// 10 点(按建点时间戳,进程内单调递增;并列时比目录 mtime)防盘胀。
//
// 语义边界(诚实声明):
// - 文件级备份/恢复,非内存事务——若 commit 中途崩溃,已写盘部分由本机制可回滚,
//   但 GD 进程内未落盘的中间态无从谈起(与执行侧 stop_on_error 语义互补)。
// - 恢复 = 用备份覆盖当前文件;备份后用户手工改过的内容会被覆盖(manifest 带
//   ts,列表展示供决策)。
// - 备份仅覆盖「已存在的将写文件」;新建文件(场景/tileset 原 absent)无备份面,
//   恢复不删除新建文件(restore 返回 restored/missing 明细,不做删除——删除属
//   破坏性语义,交由用户/上层显式处理)。

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { resolveWithinRoot } from '../../core/path-utils.js';

const KEEP_POINTS = 10;

export interface RestorePoint {
  id: string;
  ts: number;
  project: string;
  /** 备份成功的文件(项目相对路径,正斜杠);不存在的文件不进备份面。 */
  files: string[];
}

interface Manifest extends RestorePoint {
  /** 备份文件名(同 run 内以序号前缀防同名冲突)。 */
  backups: string[];
}

function projectHash(projectPath: string): string {
  return createHash('md5').update(projectPath.replace(/\\/g, '/')).digest('hex').slice(0, 8);
}

function pointsRoot(projectPath: string): string {
  // env 覆盖(测试隔离/自定义落盘,先例 GODOT_MCP_QA_REPORTS_DIR);默认 ~/.godot-mcp/
  const base = process.env.GODOT_MCP_RESTORE_POINTS_DIR
    ?? join(homedir(), '.godot-mcp', 'restore-points');
  return join(base, projectHash(projectPath));
}

function newRunId(ts: number): string {
  return `${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

// 建点时间戳在进程内严格递增:listRestorePoints 按 ts 降序排、pruneRestorePoints 按 ts 留最近 N 个,
// 同一毫秒内连续建点若 ts 相等,先后会退回目录枚举顺序(Linux 上是哈希序)——「新→旧」与「留最新」
// 都不可靠(2026-11-27 CI 暴露:列表顺序随机颠倒)。时钟回拨时同样只增不减。
let lastRestoreTs = 0;
function nextRestoreTs(): number {
  const now = Date.now();
  lastRestoreTs = now > lastRestoreTs ? now : lastRestoreTs + 1;
  return lastRestoreTs;
}

/**
 * 创建 restore point:逐个备份已存在的将写文件,写 manifest,LRU 清理。
 * 全部文件都不存在(纯新建)时返回 null——无备份面,不产生空目录。
 */
export function createRestorePoint(projectPath: string, relFiles: string[]): RestorePoint | null {
  const ts = nextRestoreTs();
  const id = newRunId(ts);
  const dir = join(pointsRoot(projectPath), id);
  const backed: { rel: string; backup: string }[] = [];

  for (const rel of relFiles) {
    const abs = join(projectPath, rel);
    if (!existsSync(abs)) continue;
    const backup = `${backed.length}_${basename(rel)}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(abs, join(dir, backup));
    backed.push({ rel, backup });
  }
  if (backed.length === 0) return null;

  const manifest: Manifest = {
    id, ts, project: projectPath.replace(/\\/g, '/'),
    files: backed.map(b => b.rel.replace(/\\/g, '/')),
    backups: backed.map(b => b.backup),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  pruneRestorePoints(projectPath);
  return { id, ts, project: manifest.project, files: manifest.files };
}

/** 列出该项目的 restore points(新→旧):按 ts 降序,并列(跨进程同一毫秒各建一点)再比目录 mtime。 */
export function listRestorePoints(projectPath: string): RestorePoint[] {
  const root = pointsRoot(projectPath);
  if (!existsSync(root)) return [];
  const entries: { point: RestorePoint; mtime: number }[] = [];
  for (const id of readdirSync(root)) {
    const mPath = join(root, id, 'manifest.json');
    if (!existsSync(mPath)) continue;
    try {
      const m = JSON.parse(readFileSync(mPath, 'utf8')) as Manifest;
      entries.push({
        point: { id: m.id, ts: m.ts, project: m.project, files: m.files },
        mtime: statSync(join(root, id)).mtimeMs,
      });
    } catch {
      // 损坏的 manifest 跳过(不因单点损坏阻断列表)
    }
  }
  return entries.sort((a, b) => (b.point.ts - a.point.ts) || (b.mtime - a.mtime)).map(e => e.point);
}

/**
 * 按 id 恢复:备份覆盖回项目原路径。
 * 批 B 审查 I-1 清偿——双层路径校验:id 须匹配 newRunId 形态(防 join 规范化 `..`
 * 指向 restore-points 根外);manifest.files 是磁盘上的可变 JSON 而非创建时内存值,
 * 每条 rel 恢复前复核 resolveWithinRoot(逃逸项进 missing 拒拷贝,与 commit 入口
 * tileset_path 的纵深校验同标准)。
 * 2026-10-29 审查 L-1 清偿:manifest.backups 与 files 同为磁盘输入——backups 逐条
 * 复核在 restore-point 目录内(resolveWithinRoot,防伪造 manifest 把目录外任意本地
 * 文件拷回项目路径);长度不齐/类型异常显式报 manifest 损坏(原实现 backups 短于
 * files 时 join(undefined) 抛 TypeError 被上层误报 RESTORE_POINT_NOT_FOUND)。
 * @returns restored=已恢复文件;missing=备份缺失或安全校验拒绝的文件。
 */
export function restoreFromPoint(projectPath: string, id: string): { restored: string[]; missing: string[] } {
  if (!/^\d{13}-[a-z0-9]{1,8}$/.test(id)) {
    throw new Error(`invalid restore point id: ${id}(须为 newRunId 形态;用 commit_restore_list 查看)`);
  }
  const mPath = join(pointsRoot(projectPath), id, 'manifest.json');
  if (!existsSync(mPath)) {
    throw new Error(`restore point not found: ${id}(用 commit_restore_list 查看可用点)`);
  }
  const m = JSON.parse(readFileSync(mPath, 'utf8')) as Manifest;
  // L-1: 结构完整性前置校验(数组形态 + 逐条 string + 与 files 等长)——损坏 manifest
  // 显式报错,而非循环中途 TypeError 被上层 catch 吞成误导性错误
  if (!Array.isArray(m.files) || !Array.isArray(m.backups) || m.backups.length !== m.files.length
    || m.files.some((f) => typeof f !== 'string') || m.backups.some((b) => typeof b !== 'string')) {
    throw new Error(`restore point manifest corrupted (files/backups mismatch): ${id}`);
  }
  const dir = join(pointsRoot(projectPath), id);
  const restored: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < m.files.length; i++) {
    const rel = m.files[i]!;
    // 备份缺失检查在消毒前(纯只读 existsSync,无写风险)——缺失报普通 missing,
    // 存在但逃逸才报 SECURITY(消毒函数对不存在目标会回落根,顺序颠倒会误标)
    if (!existsSync(join(dir, m.backups[i]!))) { missing.push(rel); continue; }
    try {
      // 双数组全量消毒:files 复核在项目根内,backups 复核在本 restore-point 目录内
      const abs = resolveWithinRoot(projectPath, rel);
      const backupAbs = resolveWithinRoot(dir, m.backups[i]!);
      mkdirSync(join(abs, '..'), { recursive: true });
      copyFileSync(backupAbs, abs);
      restored.push(rel);
    } catch {
      missing.push(`${rel} [SECURITY: escapes project root, restore refused]`);
    }
  }
  return { restored, missing };
}

/**
 * LRU:保最近 KEEP_POINTS 个,超限删最旧。排序键与列表一致——manifest 的 ts(建点时进程内单调递增),
 * 并列再比目录 mtime:只按 mtime 排时,同一毫秒内的并列项退回目录枚举序,可能把更新的点当成最旧的删掉。
 * 没有 manifest 的目录不参与清理(既有行为);manifest 损坏或缺 ts 的点以目录 mtime 代入。
 */
function pruneRestorePoints(projectPath: string, keep = KEEP_POINTS): void {
  const root = pointsRoot(projectPath);
  if (!existsSync(root)) return;
  const dirs: { abs: string; ts: number; mtime: number }[] = [];
  for (const id of readdirSync(root)) {
    const abs = join(root, id);
    const manifestPath = join(abs, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const mtime = statSync(abs).mtimeMs;
    let ts = mtime;
    try {
      const parsed = Number((JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Manifest>).ts);
      if (Number.isFinite(parsed)) ts = parsed;
    } catch { /* manifest 损坏:mtime 代入 */ }
    dirs.push({ abs, ts, mtime });
  }
  dirs.sort((a, b) => (b.ts - a.ts) || (b.mtime - a.mtime));
  for (const d of dirs.slice(keep)) {
    rmSync(d.abs, { recursive: true, force: true });
  }
}
