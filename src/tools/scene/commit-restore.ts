// src/tools/scene/commit-restore.ts
//
// 批 B2 (2026-10-26,竞品综述建议2 三件套之二): scene.commit 的 restore point
// 作用域回滚(对标 Unreal_mcp 685e59cd "restore points roll back only this
// server's steps")。commit 写盘前,TS 侧对将写文件(场景 .tscn + TILESET_RESOURCE_OPS
// 涉及的 .tres)备份到 ~/.godot-mcp/restore-points/<projectHash>/<runId>/;commit
// 结果附 restore_point {id, files};`commit_restore` 按 id 恢复本 commit 触及的
// 文件(作用域=该次提交,不碰其他);`commit_restore_list` 列点;LRU 保留最近
// 10 点(按目录 mtime)防盘胀。
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

/**
 * 创建 restore point:逐个备份已存在的将写文件,写 manifest,LRU 清理。
 * 全部文件都不存在(纯新建)时返回 null——无备份面,不产生空目录。
 */
export function createRestorePoint(projectPath: string, relFiles: string[]): RestorePoint | null {
  const ts = Date.now();
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

/** 列出该项目的 restore points(新→旧)。 */
export function listRestorePoints(projectPath: string): RestorePoint[] {
  const root = pointsRoot(projectPath);
  if (!existsSync(root)) return [];
  const out: RestorePoint[] = [];
  for (const id of readdirSync(root)) {
    const mPath = join(root, id, 'manifest.json');
    if (!existsSync(mPath)) continue;
    try {
      const m = JSON.parse(readFileSync(mPath, 'utf8')) as Manifest;
      out.push({ id: m.id, ts: m.ts, project: m.project, files: m.files });
    } catch {
      // 损坏的 manifest 跳过(不因单点损坏阻断列表)
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * 按 id 恢复:备份覆盖回项目原路径。
 * @returns restored=已恢复文件;missing=manifest 记录但备份文件缺失(目录被清理/手删)。
 */
export function restoreFromPoint(projectPath: string, id: string): { restored: string[]; missing: string[] } {
  const mPath = join(pointsRoot(projectPath), id, 'manifest.json');
  if (!existsSync(mPath)) {
    throw new Error(`restore point not found: ${id}(用 commit_restore_list 查看可用点)`);
  }
  const m = JSON.parse(readFileSync(mPath, 'utf8')) as Manifest;
  const dir = join(pointsRoot(projectPath), id);
  const restored: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < m.files.length; i++) {
    const rel = m.files[i]!;
    const backupAbs = join(dir, m.backups[i]!);
    if (!existsSync(backupAbs)) { missing.push(rel); continue; }
    const abs = join(projectPath, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    copyFileSync(backupAbs, abs);
    restored.push(rel);
  }
  return { restored, missing };
}

/** LRU:按目录 mtime 保最近 KEEP_POINTS 个,超限删最旧。 */
function pruneRestorePoints(projectPath: string, keep = KEEP_POINTS): void {
  const root = pointsRoot(projectPath);
  if (!existsSync(root)) return;
  const dirs = readdirSync(root)
    .map(id => ({ id, abs: join(root, id), mtime: statSync(join(root, id)).mtimeMs }))
    .filter(d => existsSync(join(d.abs, 'manifest.json')))
    .sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(keep)) {
    rmSync(d.abs, { recursive: true, force: true });
  }
}
