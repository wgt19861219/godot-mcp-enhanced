// src/tools/import-integrity.ts — .import 文件完整性自检（布局审计能力 D）
//
// 背景（2026-09-21 TMXYH5 反馈）：`godot --headless --import` 后部分 `*.png.import`
// 被引擎重写为只剩 [remap] 段（importer=/uid/[params] 全删），触发条件未定谳
// （疑与位图字体 .fnt 引用的 png 相关）。本模块提供两层轻量防护：
//   1. 文本自检：.import 文件头不含 `importer=` 行 → 疑似砍残
//   2. git 增强：项目根有 .git 时列出 M 状态的 .import，提示 diff 核对
//
// 挂载点（三入口，--import 真实执行链全覆盖）：
//   - import-check.ts runImport() 尾部 —— 自动 warmup / class_name 重建等全部 --import
//     链的汇聚点（gdscript-executor、script/shared 都经此）
//   - validation.ts run_and_verify —— 显式验证后的顺手诊断
//   - validation.ts import_resources —— 占位 .import 生成后的同目录自检

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { getLogger } from '../core/logger.js';

/** 砍残检测的递归排除目录（生成物/依赖/VCS，正常项目不含用户 .import） */
const SCAN_EXCLUDE_DIRS = new Set(['.godot', '.git', '.import', 'node_modules', 'build', 'dist', '.zcode']);

/** 正常 .import 的 importer= 行总在文件头部；砍残文件只剩 [remap] redirect 段 */
const IMPORTER_PROBE_BYTES = 512;

export interface ImportIntegrityReport {
  /** 扫描过的 .import 文件总数 */
  scanned: number;
  /** 疑似砍残（缺 importer= 行）的 .import，项目相对路径（正斜杠） */
  gutted: string[];
  /** git 项目：工作区 M/ 状态的 .import；非 git 项目或 git 不可用时为 null */
  gitModified: string[] | null;
}

/**
 * 扫描项目内 *.import 的完整性。
 *
 * @param projectPath 项目根绝对路径
 * @param subdirs 可选：只扫描这些项目相对子目录（缺省全项目递归）
 */
export function checkImportIntegrity(projectPath: string, subdirs?: string[]): ImportIntegrityReport {
  const gutted: string[] = [];
  let scanned = 0;

  const scanDir = (dir: string, depth: number): void => {
    if (depth > 20) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 读失败（权限/占用）跳过目录，不中止扫描
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDE_DIRS.has(entry.name)) scanDir(fullPath, depth + 1);
      } else if (entry.name.endsWith('.import')) {
        scanned++;
        if (!hasImporterLine(fullPath)) {
          gutted.push(relative(projectPath, fullPath).replace(/\\/g, '/'));
        }
      }
    }
  };

  if (subdirs && subdirs.length > 0) {
    for (const sub of subdirs) {
      const dir = join(projectPath, sub.replace(/^res:\/\//, ''));
      if (existsSync(dir)) scanDir(dir, 0);
    }
  } else {
    scanDir(projectPath, 0);
  }

  return { scanned, gutted, gitModified: gitModifiedImports(projectPath) };
}

/** 读文件头部找 `importer="..."` 行（砍残文件只剩 [remap] 的 path= 重定向） */
function hasImporterLine(importPath: string): boolean {
  try {
    const fd = readFileSync(importPath); // .import 头部元数据文件很小，整体读取即可
    const head = fd.subarray(0, IMPORTER_PROBE_BYTES).toString('utf-8');
    return /^importer="/m.test(head);
  } catch {
    return true; // 读失败不判砍残（避免权限问题误报）
  }
}

/** git 项目增强：列出工作区 M 状态的 .import（与砍残检测互补——改写但仍有 importer= 的也能暴露） */
function gitModifiedImports(projectPath: string): string[] | null {
  if (!existsSync(join(projectPath, '.git'))) return null;
  try {
    const out = execFileSync(
      'git', ['-C', projectPath, 'status', '--porcelain', '--', '*.import'],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const modified: string[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      // M(已改)/MM(暂存后又改)/AM 等任何含工作区修改的状态都值得列出；?? 是新文件不列
      if (path && /[MD]/.test(status) && !status.includes('?')) modified.push(path);
    }
    return modified;
  } catch {
    return null; // git 不可用/超时 → 静默降级（增强层，不阻塞主检测）
  }
}

/** 人读文本；干净项目返回空串（调用方按需附加） */
export function formatImportIntegrity(report: ImportIntegrityReport): string {
  if (report.gutted.length === 0 && (report.gitModified === null || report.gitModified.length === 0)) {
    return '';
  }
  const lines: string[] = [];
  if (report.gutted.length > 0) {
    lines.push(
      `⚠️ 疑似被 --import 砍残的 .import（只剩 [remap] 段、缺 importer= 行，资源导入参数已丢失）${report.gutted.length} 个：`,
      ...report.gutted.slice(0, 30).map(f => `  ${f}`),
    );
    if (report.gutted.length > 30) lines.push(`  ... and ${report.gutted.length - 30} more`);
    lines.push('建议：git checkout 恢复或编辑器内重导这些文件；此现象与位图字体引用的 png 相关性待引擎侧定谳。');
  }
  if (report.gitModified !== null && report.gitModified.length > 0) {
    lines.push(
      `📄 git 工作区有修改的 .import ${report.gitModified.length} 个（建议 git diff 核对是否预期改动）：`,
      ...report.gitModified.slice(0, 30).map(f => `  ${f}`),
    );
    if (report.gitModified.length > 30) lines.push(`  ... and ${report.gitModified.length - 30} more`);
  }
  return lines.join('\n');
}

/** runImport 尾部调用：检测 + 日志告警（自动 warmup 链的用户可见兜底） */
export function warnIfGutted(projectPath: string, report: ImportIntegrityReport): void {
  const text = formatImportIntegrity(report);
  if (text) {
    getLogger().warn('import-integrity', `--import 后检出 .import 异常（${projectPath}）：\n${text}`);
  }
}
