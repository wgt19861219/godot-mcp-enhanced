/** rules 命令 — CLI 批量规则分发（2026-10-24 规则分发可靠性批 P2-1）
 *
 * 用法:
 *   godot-mcp-enhanced rules --all [--mode update|check|overwrite]
 *   godot-mcp-enhanced rules --paths "D:/proj/A;D:/proj/B" [--mode ...]
 *
 * MCP 工具 project(setup_project_rules)的同源 CLI 包装：复用 tools/project.ts 的
 * distributeRules 分发核心（领域壳合法例外，AGENTS.md「分层约束与全局状态规则」，
 * 先例 cli/qa.ts 之于 tools/qa/）。CLI 每次新起进程，模板与 PKG_VERSION 固化值
 * 恒为磁盘最新——天然免疫 MCP 旧进程毒化（"新版本号+旧内容"），这是 CLI 通道的
 * 结构优势；distributeRules 入口的 SERVER_STALE 拦截仍保留（防未来常驻形态）。
 */
import { EXIT_CODES } from '../core/exit-codes.js';
import { existsSync, readdirSync, type Dirent } from 'fs';
import { join } from 'path';
import { opt, hasFlag } from './args.js';
import { makeCtx } from './ctx.js';
import { distributeRules } from '../tools/project.js';
import type { RulesMode } from '../tools/rules-manifest.js';
import { getAllowedProjectPaths } from '../core/path-utils.js';
import { PKG_VERSION } from '../core/update-checker.js';

const RULES_MODES: readonly RulesMode[] = ['check', 'update', 'overwrite'];

function usage(): void {
  console.log(`godot-mcp-enhanced rules — 批量分发项目规则(CLI 进程恒新,免疫旧进程毒化)

用法:
  rules --all [--mode update|check|overwrite]     分发 ALLOWED_PROJECT_PATHS 全部项目
  rules --paths "a;b;c" [--mode ...]              显式指定项目根(每条目向下探测
                                                   project.godot,深度 2,覆盖 monorepo
                                                   子目录形态如 TMXYH5/client)

选项:
  --mode  check(默认)/ update / overwrite,语义与 setup_project_rules 的
          rules_mode 相同(check 只检测;update 覆盖版本过时与 content-drift 文件,
          保留用户动过的;overwrite 全覆盖)

输出: 逐项目一行结果(更新 N 文件 / content-drift 修复 / 保留用户改动 / 失败原因),
末尾汇总;存在失败项目时非零退出(EXIT_OPERATION_FAILED)。`);
}

/** 在 root 下探测 Godot 项目根（含 root 自身，深度 ≤ maxDepth，覆盖 monorepo 子目录
 *  形态；对齐 project 工具 list_projects 的扫描语义但限深,批量分发不做深扫）。 */
export function findGodotProjectRoots(root: string, maxDepth = 2): string[] {
  const found: string[] = [];
  const scan = (dir: string, depth: number): void => {
    if (existsSync(join(dir, 'project.godot'))) { found.push(dir); return; }
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name), depth + 1);
    }
  };
  scan(root, 0);
  return found;
}

/** 由 distributeRules 的 report.actions 提取单行摘要（rules 相关行动作拼接）。 */
export function summarizeActions(actions: unknown): string {
  if (!Array.isArray(actions)) return 'no actions';
  const rulesLines = (actions as string[])
    .filter(a => typeof a === 'string' && a.startsWith('rules'))
    .map(a => a.replace(/^rules(?:-manifest)?:\s*/, ''));
  return rulesLines.length > 0 ? rulesLines.join(' / ') : 'no rules actions';
}

export async function runRules(args: string[]): Promise<void> {
  const mode = (opt(args, 'mode') ?? 'update') as RulesMode;
  if (!RULES_MODES.includes(mode)) {
    console.error(`--mode 非法: ${mode}(合法: ${RULES_MODES.join('/')})`);
    process.exit(EXIT_CODES.EXIT_USAGE);
  }
  const useAll = hasFlag(args, 'all');
  const pathsArg = opt(args, 'paths');
  if (!useAll && !pathsArg) {
    usage();
    process.exit(EXIT_CODES.EXIT_USAGE);
  }
  if (useAll && pathsArg !== undefined) {
    console.error('--all 与 --paths 互斥,二选一');
    process.exit(EXIT_CODES.EXIT_USAGE);
  }

  const roots = useAll ? getAllowedProjectPaths() : pathsArg!.split(';').filter(Boolean);
  if (roots.length === 0) {
    console.error(useAll
      ? 'ALLOWED_PROJECT_PATHS 未配置或为空——rules --all 依赖该白名单(分号分隔多根)'
      : '--paths 未解析出任何目录');
    process.exit(EXIT_CODES.EXIT_USAGE);
  }
  const projects: string[] = [];
  for (const r of roots) {
    const found = findGodotProjectRoots(r);
    if (found.length === 0) console.log(`  ! ${r}: 未探测到 project.godot(深度 2),跳过`);
    projects.push(...found);
  }
  if (projects.length === 0) {
    console.error('无目标 Godot 项目');
    process.exit(EXIT_CODES.EXIT_OPERATION_FAILED);
  }

  const ctx = makeCtx();
  let okCount = 0;
  let failCount = 0;
  console.log(`规则分发(mode=${mode}, server v${PKG_VERSION}, ${projects.length} 项目)`);
  for (const project of projects) {
    let report: Record<string, unknown>;
    try {
      report = await distributeRules(project, {
        hooks: true,
        claude_md: true,
        agents_md: true,
        force: false,
        rules_mode: mode,
      }, ctx);
    } catch (e) {
      console.log(`  ✗ ${project}: ${e instanceof Error ? e.message : String(e)}`);
      failCount++;
      continue;
    }
    if (typeof report.error === 'string') {
      console.log(`  ✗ ${project}: ${report.error}`);
      failCount++;
      continue;
    }
    console.log(`  ✓ ${project}: ${summarizeActions(report.actions)}`);
    okCount++;
  }
  console.log(`汇总: ${okCount} 成功 / ${failCount} 失败`);
  if (failCount > 0) process.exit(EXIT_CODES.EXIT_OPERATION_FAILED);
}
