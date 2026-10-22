/** skills 命令 — 安装打包的 Claude Code skills 到用户目录(P2-2,2026-08-19)
 *
 * 分发叙事:skills 指导 AI 如何用好 godot-mcp MCP 工具(路由器/安全编辑/验证闭环/
 * 截图留证/Tween 审计/bridge E2E),安装摩擦低于 MCP server 配置——
 * `npx godot-mcp-enhanced skills install` 一条命令装入 ~/.claude/skills/。
 * 注意:skills 是 MCP server 的配套增强(教 AI 调工具),不替代 server 本身;
 * 配合 `configure <client>` 使用。
 *
 * load_skill 生态复用:npm 包内 skills/ 目录(SKILL.md 子目录结构)可直接注册为
 * load_skill 库——env `GODOT_SKILL_LIBRARIES` 指向该目录即可(load_skill 递归扫 .md)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { opt, hasFlag } from './args.js';
import { auditSkillsInstall } from './audit-helper.js';
// N-6 下沉(2026-10-22):packagedSkillsDir/listPackagedSkills 移至 src/packaged-skills.ts
// ——resources.ts(server 进程)不再依赖 CLI 模块;本文件按新路径引用。
import { packagedSkillsDir, listPackagedSkills } from '../packaged-skills.js';

/** 安装:拷贝打包 skills 到目标目录(默认 ~/.claude/skills/)。已存在的跳过(--force 覆盖) */
export function installSkills(
  skillsDir: string, targetDir: string, force: boolean,
): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const srcDir = join(skillsDir, entry);
    if (!statSync(srcDir).isDirectory()) continue;
    const src = join(srcDir, 'SKILL.md');
    if (!existsSync(src)) continue;
    const dstDir = join(targetDir, entry);
    const dst = join(dstDir, 'SKILL.md');
    if (existsSync(dst) && !force) {
      skipped.push(entry);
      continue;
    }
    mkdirSync(dstDir, { recursive: true });
    // 保持原文件 mode(对齐 writeFileAtomicWithMode 语义;src 打包 mode 即目标 mode)
    const mode = statSync(src).mode & 0o777;
    writeFileSync(dst, readFileSync(src), { mode });
    installed.push(entry);
  }
  return { installed, skipped };
}

/** B3 (2026-10-19): --client 安装面映射——只收有真实用户级 skills 目录机制的客户端,
 * 不确定的客户端不加(装到无效目录 = 假成功,比不装更糟)。新客户端支持 skills 时
 * 在此表加条目即可。注意与 clients/ 的 15 个 MCP server 适配器是两个概念:
 * 那边管 server 配置,这边只管 skills 目录。 */
export const CLIENT_SKILLS_DIRS: Record<string, () => string> = {
  'claude-code': () => join(homedir(), '.claude', 'skills'),
  'zcode': () => join(homedir(), '.zcode', 'skills'),
};

export async function runSkills(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const skillsDir = packagedSkillsDir();

  if (!existsSync(skillsDir)) {
    console.error(`✗ Packaged skills not found: ${skillsDir}`);
    console.error('  (从 npm 包运行应含 skills/ 目录;源码仓跑 npm run build:skills 生成)');
    process.exit(1);
    return;
  }

  const sub = args.find(a => !a.startsWith('--')) ?? 'list';

  if (sub === 'list') {
    const skills = listPackagedSkills(skillsDir);
    console.log(`Packaged skills (${skills.length}) — ${skillsDir}\n`);
    for (const s of skills) {
      console.log(`  ${s.name}`);
      if (s.description) console.log(`    ${s.description}`);
    }
    console.log('\nInstall:  npx godot-mcp-enhanced skills install [--force]');
    console.log('Skills 指导 AI 调用 godot-mcp MCP 工具——请先 `configure <client>` 配好 MCP server。');
    return;
  }

  if (sub === 'install') {
    // --target <dir>:装入指定目录(项目级 .claude/skills/);默认 ~/.claude/skills/(用户级)
    // P2-9(七维度审核): 双形式(此前 indexOf 精确匹配只认空格形式,--target=<dir>
    // 静默落回用户级目录装错位置)
    const explicitTarget = opt(args, 'target');
    if (hasFlag(args, 'target') && !explicitTarget) {
      console.error('✗ --target requires a directory argument');
      process.exit(1);
      return;
    }
    // B3 (2026-10-19): --client <name> 按客户端映射装 skills 目录(与 --target 互斥)
    const clientName = opt(args, 'client');
    if (hasFlag(args, 'client') && !clientName) {
      console.error('✗ --client requires a client name argument');
      process.exit(1);
      return;
    }
    if (clientName && explicitTarget) {
      console.error('✗ --client and --target are mutually exclusive — pick one install destination');
      process.exit(1);
      return;
    }
    let targetDir: string;
    if (clientName) {
      const factory = CLIENT_SKILLS_DIRS[clientName];
      if (!factory) {
        console.error(`✗ Unknown client: ${clientName}. Supported: ${Object.keys(CLIENT_SKILLS_DIRS).join(', ')}`);
        console.error('  (仅收录有真实用户级 skills 目录机制的客户端;其余客户端用 --target <dir> 自定路径)');
        process.exit(1);
        return;
      }
      targetDir = factory();
    } else {
      targetDir = explicitTarget ?? join(homedir(), '.claude', 'skills');
    }
    const { installed, skipped } = installSkills(skillsDir, targetDir, force);
    // 批4-T9(五维评估 P2): CLI 写面留痕——写 ~/.claude/skills/(机器级,非项目内)
    if (installed.length > 0) auditSkillsInstall(installed.length);
    console.log(`Target: ${targetDir}${clientName ? ` (client: ${clientName})` : ''}\n`);
    for (const name of installed) console.log(`  ✓ ${name}: installed`);
    for (const name of skipped) console.log(`  ⊘ ${name}: already exists (use --force to overwrite)`);
    console.log(`\n${installed.length > 0 ? `✓ ${installed.length} skill(s) installed.` : 'No new skills installed.'}`);
    console.log('  重启 Claude Code 会话后生效;skills 配合 godot-mcp MCP server 使用(configure <client>)。');
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error('Usage: godot-mcp-enhanced skills [list|install] [--force] [--client <name> | --target <dir>]');
  process.exit(1);
}
