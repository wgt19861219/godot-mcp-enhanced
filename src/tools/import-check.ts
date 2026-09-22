/**
 * Import warmup module for Godot MCP Enhanced.
 *
 * Godot headless mode does NOT run the resource import pipeline,
 * so `.godot/imported/` may be missing or stale, causing `load()` to fail.
 *
 * This module detects stale/missing imported resources and runs
 * `godot --headless --import` to warm up the cache before execution.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { runGodotHeadless } from '../core/godot-spawn.js';
import { getLogger } from '../core/logger.js';
import { checkImportIntegrity, warnIfGutted, type ImportIntegrityReport } from './import-integrity.js';

// ─── Cache state ──────────────────────────────────────────────────────────────

/** Timestamp of the latest mtime seen across scanned asset directories. */
let _lastCheckedAssetMtime: number | null = null;

/** Project path that the cached mtime corresponds to. */
let _lastCheckedProject: string | null = null;

/** Directories to scan for new/modified assets (top-level only). */
const ASSET_SCAN_DIRS = ['assets', 'scenes', 'scripts'];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reset import cache — for test isolation.
 */
export function resetImportCache(): void {
  _lastCheckedAssetMtime = null;
  _lastCheckedProject = null;
}

/**
 * Check whether a project needs an import warmup run.
 *
 * Returns true when:
 * 1. `GODOT_MCP_AUTO_IMPORT=false` is NOT set, AND
 * 2. `.godot/imported/` does not exist, OR new asset files have been detected
 *    (based on mtime comparison with cached state).
 */
export function needsImport(projectPath: string): boolean {
  // P3: Allow users to opt out of auto-import
  if (process.env.GODOT_MCP_AUTO_IMPORT === 'false') {
    return false;
  }

  const importedDir = join(projectPath, '.godot', 'imported');

  // If .godot/imported/ doesn't exist at all, definitely need import
  if (!existsSync(importedDir)) {
    return true;
  }

  // Scan asset directories for latest mtime
  const latestMtime = scanLatestMtime(projectPath);

  // No asset dirs found or couldn't scan — assume no import needed
  if (latestMtime === 0) {
    // Update cache to avoid repeated scanning
    _lastCheckedAssetMtime = 0;
    _lastCheckedProject = projectPath;
    return false;
  }

  // First check for this project — cache current state, but still check freshness
  if (_lastCheckedProject !== projectPath || _lastCheckedAssetMtime === null) {
    // Check if imported dir is stale (older than latest asset)
    const importedStat = statSafe(importedDir);
    if (importedStat && importedStat.mtimeMs < latestMtime) {
      return true;
    }
    // Cache the current state
    _lastCheckedAssetMtime = latestMtime;
    _lastCheckedProject = projectPath;
    return false;
  }

  // Same project — check if any new files appeared since last check
  if (latestMtime > _lastCheckedAssetMtime) {
    return true;
  }

  // No new files detected — update cache and return false
  _lastCheckedAssetMtime = latestMtime;
  _lastCheckedProject = projectPath;
  return false;
}

/**
 * Run `godot --headless --import` to warm up the resource import cache.
 *
 * 能力 D (2026-09-21)：导入完成后执行 .import 完整性自检（TMXYH5 反馈：
 * --import 曾把位图字体引用的 png.import 重写为只剩 [remap] 段）。返回检测
 * 报告——gutted 非空时调用方可上浮到工具输出；自动 warmup 链至少有 logger
 * 告警（warnIfGutted）。
 *
 * @throws Error if the import process fails or times out.
 */
export async function runImport(
  projectPath: string,
  godotPath: string,
  timeoutMs: number = 60_000,
): Promise<ImportIntegrityReport> {
  const result = await runGodotHeadless(
    ['--headless', '--import', '--path', projectPath], godotPath, timeoutMs,
  );
  if (result.exitCode === null) {
    throw new Error(
      `Import warmup timed out after ${timeoutMs}ms for ${projectPath}. ` +
      `stdout: ${result.stdout.slice(-500) || '(empty)'}; stderr: ${result.stderr.slice(-500) || '(empty)'}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Import warmup exited with code ${result.exitCode} for ${projectPath}. ` +
      `stdout: ${result.stdout.slice(-500) || '(empty)'}; stderr: ${result.stderr.slice(-500) || '(empty)'}`,
    );
  }
  // code === 0: 更新缓存
  const latestMtime = scanLatestMtime(projectPath);
  _lastCheckedAssetMtime = latestMtime || Date.now();
  _lastCheckedProject = projectPath;
  getLogger().info('import-check', `Import warmup completed for ${projectPath}`);

  // 能力 D：导入后自检（纯文本扫描 + git 增强，毫秒级；失败不影响导入结果语义）
  try {
    const report = checkImportIntegrity(projectPath);
    warnIfGutted(projectPath, report);
    return report;
  } catch (err) {
    getLogger().debug('import-check', `integrity check skipped: ${err instanceof Error ? err.message : err}`);
    return { scanned: 0, gutted: [], gitModified: null };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Scan top-level asset directories for the latest file mtime.
 * Returns 0 if no files found or directories don't exist.
 */
function scanLatestMtime(projectPath: string): number {
  let latest = 0;

  for (const dir of ASSET_SCAN_DIRS) {
    const dirPath = join(projectPath, dir);
    if (!existsSync(dirPath)) continue;

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          const stat = statSync(join(dirPath, entry.name));
          if (stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
          }
        } catch {
          // Skip files we can't stat (permissions, broken symlinks, etc.)
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return latest;
}

/**
 * Safe statSync that returns null on error instead of throwing.
 */
function statSafe(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
