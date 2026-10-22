/** 打包 skills 目录定位与枚举(N-6 下沉,2026-10-22 审查批)
 *
 * 从 src/cli/skills.ts 下沉为共享纯函数:src/resources.ts(MCP Resources 协议,
 * server 进程内消费)此前 import ./cli/skills.js——server 基础设施依赖 CLI 模块的
 * 方向倒挂(2026-10-19 B1-B5 审查 N-6 遗留,2026-10-22 全维度审查 Nit-15)。
 * 本文件保持零副作用:无 env 读取、无写盘、无 console——可安全纳入 eslint
 * console 纪律门禁的 server 可达面。
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** 打包内 skills 分发目录(相对本文件:build/packaged-skills.js → 包根 skills/;
 *  dev 场景 build/ → 仓库根 skills/。原位于 cli/skills.ts 时为 build/cli/ 两级上溯,
 *  下沉后层级变化,路径计算同步调整为一级上溯) */
export function packagedSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'skills');
}

/** 列出打包 skills(name + description 摘自 SKILL.md frontmatter) */
export function listPackagedSkills(skillsDir: string): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, entry, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const content = readFileSync(skillMd, 'utf-8');
    const descMatch = content.match(/^description:\s*"([\s\S]*?)"\s*$/m);
    out.push({ name: entry, description: descMatch?.[1]?.slice(0, 120) ?? '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
