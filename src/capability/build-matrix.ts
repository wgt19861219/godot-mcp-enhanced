// src/capability/build-matrix.ts
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../module-loader.js';
import { extractCapabilities } from './extract.js';
import type { ToolCapability } from './schema.js';

export function buildMarkdown(caps: ToolCapability[]): string {
  const total = caps.length;
  const byLevel = { 'danger-api': 0, 'guarded': 0, 'safe': 0 };
  const byL2 = { covered: 0, partial: 0, none: 0 };
  for (const c of caps) { byLevel[c.securityLevel]++; byL2[c.verification.l2]++; }
  // risk 四级聚合（全工具 actionRisks 计数汇总）
  const riskTotals = { read: 0, write: 0, destructive: 0, process: 0 };
  for (const c of caps) for (const [k, v] of Object.entries(c.riskDistribution ?? {})) {
    riskTotals[k as keyof typeof riskTotals] += v;
  }
  // trusted-nonread：标 read 但实际启进程/有副作用（项目有意信任不确认）
  const trustedList = caps.flatMap(c => (c.trustedNonRead ?? []).map(a => `\`${c.name}.${a}\``));
  const dangerTools = caps.filter(c => c.securityLevel === 'danger-api').map(c => `- \`${c.name}\` (${c.group})`).join('\n');
  // token 预算（E 组 size 聚合）
  const totalBytes = caps.reduce((s, c) => s + c.size.totalBytes, 0);
  const schemaBytesAll = caps.reduce((s, c) => s + c.size.schemaBytes, 0);
  const descBytesAll = caps.reduce((s, c) => s + c.size.descBytes, 0);
  const schemaPct = totalBytes > 0 ? Math.round((schemaBytesAll / totalBytes) * 100) : 0;
  const top5 = [...caps].sort((a, b) => b.size.totalBytes - a.size.totalBytes).slice(0, 5);
  const top5Lines = top5.map(c =>
    `- \`${c.name}\` (${c.group}): desc ${c.size.descBytes}B / schema ${c.size.schemaBytes}B / total ${c.size.totalBytes}B`
  );
  // P1-2: annotations hint 计数（readOnly / destructive / idempotent）
  const annCount = caps.reduce((acc, c) => {
    if (c.annotations) {
      if (c.annotations.readOnlyHint) acc.readOnly++;
      if (c.annotations.destructiveHint) acc.destructive++;
      if (c.annotations.idempotentHint) acc.idempotent++;
    }
    return acc;
  }, { readOnly: 0, destructive: 0, idempotent: 0 });
  const lines = [
    `# Capability Matrix`,
    ``,
    `> 自动生成，勿手改。由 \`npm run build-matrix\` 产出，漂移检测见 \`npm run diff-matrix\`。`,
    ``,
    `## 概览`,
    `- 工具总数：${total}`,
    `- securityLevel：danger-api ${byLevel['danger-api']} / guarded ${byLevel['guarded']} / safe ${byLevel['safe']}`,
    `- risk：read ${riskTotals.read} / write ${riskTotals.write} / destructive ${riskTotals.destructive} / process ${riskTotals.process}`,
    `- L2 覆盖：covered ${byL2.covered} / partial ${byL2.partial} / none ${byL2.none}`,
    // B-6 fix(2026-10-01 审查):L2/relatedDefects 是 extract.ts 硬编码占位(全工具恒
    // l2:'none'),未接线 CI e2e 映射——上方数字与下方缺口段不代表真实覆盖(CI 实际
    // 跑 16 个 L2 e2e 文件)。显式标注防误读;接线提取留待后续独立批次。
    `  - ⚠ 占位说明：L2 列为提取器占位（\`src/capability/extract.ts\` 硬编码 \`l2:'none'\`），未接线 CI e2e 映射，**不代表真实覆盖为零**（CI 实际跑 16 个 L2 e2e 文件，见 \`scripts/check-e2e-l2-coverage.mjs\`）；relatedDefects 同为占位。`,
    `- token 预算：tools/list ≈ ${totalBytes}B / ~${Math.round(totalBytes / 4)} tokens（description ${descBytesAll}B / schema ${schemaBytesAll}B，schema 占 ${schemaPct}%）`,
    `- annotations：readOnly ${annCount.readOnly} / destructive ${annCount.destructive} / idempotent ${annCount.idempotent}`,
    ...(trustedList.length > 0 ? [`> 注：标 read 但实际启进程/有副作用(项目有意信任不确认): ${trustedList.join(', ')}`] : []),
    ``,
    `## danger-api 工具（L2 安全回归优先）`,
    dangerTools || '（无）',
    ``,
    `## 覆盖缺口（L2=none，占位——见概览行说明，非真实覆盖）`,
    ...caps.filter(c => c.verification.l2 === 'none').slice(0, 50).map(c => `- \`${c.name}\` (${c.group})`),
    ``,
    `## 范围取舍（explicitly out of scope）`,
    `以下品类经评估（2026-08-19 竞品横扫对表）明确**不做**，非遗漏：`,
    `- **VisualShader 图谱编辑**（yanhuifair 8 工具/40+ 节点类型）：VisualShader 节点图是强交互编辑器域，AI 经文本属性路径（\`VisualShaderNode*\` 属性编辑）+ material/shader 工具已可覆盖大部分程序化材质需求；图谱级编排的维护成本（节点类型矩阵 × Godot 版本）远超收益。替代路径：\`material\` 工具（shader_read/write/load/save_file）+ \`execute_gdscript\` 动态构造。`,
    ``,
    `## gdScriptImpl 说明`,
    `- editor 侧：addons/godot_mcp_server/commands/*_commands.gd 按 group 匹配`,
    `- headless 侧：恒为 exists=false（GDScript 由 gdscript-executor 运行时生成，无静态 1:1 文件）`,
    `- editor 侧：按工具命令精确路由（EDITOR_COMMAND_ROUTING，源 command_handler.gd handle() 路由表）`,
    ``,
    `## token 预算 TOP 5`,
    ...top5Lines,
  ];
  return lines.join('\n');
}

function main(): void {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  registerAllModules();
  const caps = extractCapabilities(projectRoot);
  caps.sort((a, b) => a.name.localeCompare(b.name));

  const docsDir = join(projectRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });
  // 2026-08-07 审查 P2: 加 version 字段（从 package.json 读），供 CI 校验与 package.json 同步。
  // generatedAt 字段已移除：每次构建写 new Date() 产生无意义 git diff，diff-matrix 不读此字段。
  const pkgVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version;
  writeFileSync(join(docsDir, 'capability-matrix.json'), JSON.stringify({ version: pkgVersion, tools: caps }, null, 2));
  writeFileSync(join(docsDir, 'capability-matrix.md'), buildMarkdown(caps));
  console.log(`[build-matrix] ${caps.length} tools (v${pkgVersion}) → docs/capability-matrix.{json,md}`);
}

main();
