// script 工具 project_replace action 实现（全仓批量替换 + 两阶段原子写）。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync, copyFileSync } from 'fs';
import { join } from 'path';
import type { ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { getLogger } from '../../core/logger.js';
import { opsErrorResult } from '../shared.js';
import { pluginSelfPathGuard } from '../shared/file-guard.js';
import { scanScriptSandboxOrThrow } from './shared.js';

export async function projectReplace(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requireProjectPath(args);
  const search = args.search as string;
  const replace = (args.replace as string) ?? '';
  const ALLOWED_EXTENSIONS = new Set(['.gd', '.cs', '.tscn', '.tres', '.gdshader', '.cfg', '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv']);
  const HARDCODED_EXCLUDE = new Set(['.git', 'node_modules']);
  const rawExtensions: string[] = (args.extensions as string[]) || ['.gd'];
  const extensions = rawExtensions.filter(ext => ALLOWED_EXTENSIONS.has(ext));
  if (extensions.length === 0) {
    return opsErrorResult('INVALID_PARAMS', `No allowed extensions. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
  const userExcludeDirs: string[] = (args.exclude_dirs as string[]) || ['.godot', '.import'];
  const excludeDirs = [...new Set([...userExcludeDirs, ...HARDCODED_EXCLUDE])];
  const dryRun = args.dry_run === true;

  if (!search) {
    return opsErrorResult('INVALID_PARAMS', 'search must be a non-empty string.');
  }

  const normalizedSearch = search.replace(/\r\n/g, '\n');
  const normalizedReplace = replace.replace(/\r\n/g, '\n');

  // I-01, I-03: Clean up residual .bak / .mcp-tmp files from interrupted atomic writes
  // Scan all top-level subdirectories (not just . and src) since project_replace can affect any location
  const cleanedResiduals: string[] = [];
  for (const suffix of ['.bak', '.mcp-tmp']) {
    try {
      const rootEntries = readdirSync(p, { withFileTypes: true });
      for (const rootEntry of rootEntries) {
        const absDir = join(p, rootEntry.name);
        // Only scan directories that aren't excluded and the root itself
        const isExcluded = excludeDirs.includes(rootEntry.name) || rootEntry.name.startsWith('.');
        const targets = isExcluded ? [] : (rootEntry.isDirectory() ? [absDir] : rootEntry.isFile() && rootEntry.name.endsWith(suffix) ? [absDir] : []);
        // Also check root-level files matching suffix
        if (rootEntry.isFile() && rootEntry.name.endsWith(suffix)) {
          try { unlinkSync(absDir); cleanedResiduals.push(rootEntry.name); } catch { /* best effort */ }
          continue;
        }
        for (const targetDir of targets) {
          if (!existsSync(targetDir)) continue;
          const entries = readdirSync(targetDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(suffix)) {
              const residualPath = join(targetDir, entry.name);
              try { unlinkSync(residualPath); cleanedResiduals.push(join(rootEntry.name, entry.name)); } catch { /* best effort */ }
            }
          }
        }
      }
    } catch { /* non-critical cleanup */ }
  }

  // Collect files
  const MAX_FILES = 500;
  const matchedFiles: string[] = [];
  const skippedDirs: string[] = [];
  function scanDir(dir: string, depth: number): void {
    if (matchedFiles.length >= MAX_FILES) return;
    if (depth > 15) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (matchedFiles.length >= MAX_FILES) return;
        if (entry.name.startsWith('.')) continue;
        if (excludeDirs.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (existsSync(join(full, '.gdignore'))) continue;
          scanDir(full, depth + 1);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          matchedFiles.push(full);
        }
      }
    } catch (err) {
      getLogger().debug('script', `scan dir for files: ${err instanceof Error ? err.message : err}`);
      skippedDirs.push(dir.slice(p.length + 1) || dir);
    }
  }
  scanDir(p, 0);
  if (matchedFiles.length >= MAX_FILES) {
    return opsErrorResult('INVALID_PARAMS', `Too many matching files (>${MAX_FILES}). Narrow the search with more specific extensions or add directories to exclude_dirs.`);
  }

  const relOf = (absPath: string) => absPath.slice(p.length + 1);

  const changedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const skippedLarge: string[] = [];
  let totalReplacements = 0;
  const MAX_FILE_SIZE = 1_000_000; // 1MB

  // Phase 1: 收集所有变更到内存
  const pendingWrites: Array<{ filePath: string; finalContent: string }> = [];

  for (const filePath of matchedFiles) {
    try {
      const fileSize = statSync(filePath).size;
      if (fileSize > MAX_FILE_SIZE) {
        skippedLarge.push(relOf(filePath));
        continue;
      }
    } catch (e) { getLogger().debug('script', `stat failed for ${filePath}: ${e instanceof Error ? e.message : e}`); continue; }
    const content = readFileSync(filePath, 'utf-8');
    const hasCRLF = content.includes('\r\n');
    const normalized = content.replace(/\r\n/g, '\n');

    if (!normalized.includes(normalizedSearch)) {
      unchangedFiles.push(relOf(filePath));
      continue;
    }

    const count = normalized.split(normalizedSearch).length - 1;
    totalReplacements += count;

    if (!dryRun) {
      const newContent = normalized.replaceAll(normalizedSearch, normalizedReplace);
      const finalContent = hasCRLF ? newContent.split('\n').join('\r\n') : newContent;
      pendingWrites.push({ filePath, finalContent });
    }

    changedFiles.push(relOf(filePath));
  }

  // P1-2 FileGuard: 拒写插件自资产——整批原子检查(任一命中全拒,保持批量原子性)
  // 全仓审查 B-1 (2026-09-12): project_replace 的批量写入曾绕过沙箱扫描——此处对每个
  // .gd 落盘内容过 scanScriptSandboxOrThrow(script/shared.ts 全仓约束:所有写 .gd 落盘前
  // 必须过此扫描)。攻击路径与 SEC-P1-1 同构:replace 注入危险 API → run_project 即执行。
  if (!dryRun && pendingWrites.length > 0) {
    for (const pw of pendingWrites) {
      const selfGuardP = pluginSelfPathGuard(pw.filePath);
      if (selfGuardP) return selfGuardP;
      const sandboxGuardP = scanScriptSandboxOrThrow(pw.finalContent, pw.filePath);
      if (sandboxGuardP) return sandboxGuardP;
    }
  }
  // Phase 2: Best-effort atomic write — backup originals, write .tmp, rename with rollback
  if (!dryRun && pendingWrites.length > 0) {
    const tmpFiles: string[] = [];
    const bakFiles: string[] = [];
    const renamedCount = { value: 0 };
    try {
      // Step 1: Write all .tmp files (safe — originals untouched)
      for (const pw of pendingWrites) {
        const tmpPath = pw.filePath + '.tmp';
        writeFileSync(tmpPath, pw.finalContent, 'utf-8');
        tmpFiles.push(tmpPath);
      }
      // Step 2: Backup originals to .bak (needed for rollback)
      for (const pw of pendingWrites) {
        const bakPath = pw.filePath + '.bak';
        copyFileSync(pw.filePath, bakPath);
        bakFiles.push(bakPath);
      }
      // Step 3: Rename .tmp → target
      for (let i = 0; i < pendingWrites.length; i++) {
        renameSync(tmpFiles[i]!, pendingWrites[i]!.filePath);
        renamedCount.value++;
      }
    } catch (writeErr) {
      // Rollback: restore .bak for already-renamed files
      for (let i = 0; i < renamedCount.value; i++) {
        try { renameSync(bakFiles[i]!, pendingWrites[i]!.filePath); } catch { /* best effort */ }
      }
      // Cleanup .tmp and remaining .bak files
      for (const tmp of tmpFiles) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      }
      for (const bak of bakFiles) {
        try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
      }
      return opsErrorResult('ATOMIC_WRITE_FAILED', `Batch write failed: ${(writeErr as Error).message}. Rollback attempted for ${renamedCount.value} files.`);
    }
    // Success: cleanup .bak files
    for (const bak of bakFiles) {
      try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
    }
    // Cleanup .tmp (already renamed, but defensive)
    for (const tmp of tmpFiles) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  const prefix = dryRun ? '[DRY RUN] ' : '';
  const summary = [
    `${prefix}Batch replace complete.`,
    `Search: "${search.substring(0, 80)}${search.length > 80 ? '...' : ''}"`,
    `Replace: "${replace.substring(0, 80)}${replace.length > 80 ? '...' : ''}"`,
    `Extensions: ${extensions.join(', ')}`,
    `Scanned: ${matchedFiles.length} files`,
    `Changed: ${changedFiles.length} files (${totalReplacements} replacements)`,
    unchangedFiles.length > 0 ? `Unchanged: ${unchangedFiles.length} files` : '',
    skippedLarge.length > 0 ? `Skipped (>${MAX_FILE_SIZE / 1_000_000}MB): ${skippedLarge.length} files` : '',
    skippedDirs.length > 0 ? `Skipped dirs (unreadable): ${skippedDirs.slice(0, 10).join(', ')}${skippedDirs.length > 10 ? ` ... and ${skippedDirs.length - 10} more` : ''}` : '',
    cleanedResiduals.length > 0 ? `Cleaned residuals: ${cleanedResiduals.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const details = changedFiles.length > 0
    ? '\n\nChanged files:\n' + changedFiles.slice(0, 50).map(f => `  ${f}`).join('\n')
      + (changedFiles.length > 50 ? `\n  ... and ${changedFiles.length - 50} more` : '')
    : '\n\nNo files contained the search text.';

  return textResult(summary + details);
}
