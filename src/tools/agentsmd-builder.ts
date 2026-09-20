// src/tools/agentsmd-builder.ts
// 组装单文件 AGENTS.md（ZCode 等遵循 AGENTS.md 标准的客户端读取）。
// ZCode 约束：只读 workspace 根 AGENTS.md，不扫描子目录、不展开 @import →
// 必须把全部 godot-mcp 规则合并进单文件，并对规则文件标题做降级（避免与
// AGENTS.md 的 ## MCP 段冲突）。复用 claudemd-builder 的元数据 builders +
// rule-templates 的 DETAILED_RULE_TEMPLATES + shared/section-merge 的合并逻辑。
import type { GodotConfig } from '../core/config-parser.js';
import {
  buildEngineVersion, buildRenderer, buildKeyPaths, buildMainScene,
  buildAutoloads, buildInputMap, buildPhysics, buildLayerNames,
  buildTypeGuide, buildBestPractices, GODOT_MCP_RULES,
} from './claudemd-builder.js';
import { DETAILED_RULE_TEMPLATES } from './rule-templates.js';
import { mergeSections as mergeSectionsGeneric } from './shared/section-merge.js';

// AGENTS.md 的 MCP 管控段 header 白名单（## 级，供幂等合并判定）
export const AGENTS_SECTION_IDS: Set<string> = new Set([
  '## 项目信息',
  '## Godot MCP 通用规则',
  '## Godot MCP 核心决策树',
  '## Godot MCP 编辑器模式',
  '## Godot MCP Game Bridge',
  '## Godot MCP UI 布局',
  '## Godot MCP 录制回放',
  '## Godot MCP 引擎特性',
  '## Godot MCP GDScript 规范',
  '## Godot MCP 最佳实践',
]);

// 段 header → 规则模板键（base 用特殊标记 __base__）
const SECTION_TO_TEMPLATE: Array<[string, string]> = [
  ['## Godot MCP 核心决策树', 'godot-mcp-core.md'],
  ['## Godot MCP 编辑器模式', 'godot-mcp-editor.md'],
  ['## Godot MCP Game Bridge', 'godot-mcp-bridge.md'],
  ['## Godot MCP UI 布局', 'godot-mcp-ui.md'],
  ['## Godot MCP 录制回放', 'godot-mcp-recording.md'],
  ['## Godot MCP 引擎特性', 'godot-mcp-engine-quirks.md'],
];

/**
 * 标题降级：行首 markdown 标题（#..######）降一级。用状态机跳过 ``` 代码块，
 * 避免误降级代码块内的 # 注释。
 */
function demoteHeadings(content: string): string {
  const lines = content.split('\n');
  let inCodeBlock = false;
  const out = lines.map(line => {
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;
    const m = line.match(/^(#{1,6})( .*)$/);
    return m ? '#' + m[1] + m[2] : line;
  });
  return out.join('\n');
}

/** 剥离开头的 yaml frontmatter（--- ... ---）。 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

/** 剥离开头的 "> 适用于 godot-mcp-enhanced ..." 版本引用行（base 段保留自己的一次）。 */
function stripVersionQuote(content: string): string {
  return content.replace(/^> 适用于 godot-mcp-enhanced[^\n]*\n+/, '');
}

/** AGENTS.md 内联说明段（替代指向 .claude/rules/ 的映射表——ZCode 下该目录不生效）。 */
function buildInlineMapping(): string {
  return [
    '> ZCode 不读取 `.claude/rules/` 目录。上方各段（通用规则 / 核心决策树 /',
    '> 编辑器模式 / Game Bridge / UI 布局 / 录制回放 / 引擎特性）已全部内联到本文件，',
    '> 是 godot-mcp-enhanced 规则在 ZCode 下的唯一来源。',
  ].join('\n');
}

/**
 * 组装单文件 AGENTS.md 内容。sections 顺序固定，供幂等检测。
 * 返回未含 H1 标题的 sections 数组（H1 由 project.ts 的 setup_project_rules 拼接）。
 */
export function buildAgentsMdSections(
  config: GodotConfig | null,
  projectDir: string,
  mcpVersion: string,
): Array<[string, string]> {
  const sections: Array<[string, string]> = [];

  // ── 项目信息段（元数据 builders 合并）──
  const metaBuilders: Array<() => string | null> = [
    () => buildEngineVersion(config),
    () => buildRenderer(config),
    () => buildKeyPaths(projectDir),
    () => buildMainScene(config),
    () => buildAutoloads(config),
    () => buildInputMap(config),
    () => buildPhysics(config),
    () => buildLayerNames(config),
  ];
  const metaLines = metaBuilders.map(b => b()).filter((v): v is string => v !== null);
  if (metaLines.length > 0) {
    sections.push(['## 项目信息', metaLines.join('\n') + '\n\n' + buildInlineMapping()]);
  } else {
    sections.push(['## 项目信息', buildInlineMapping()]);
  }

  // ── base 规则（GODOT_MCP_RULES，H2 → 降级为 H3）──
  // 剥 H1：段头已是 ## Godot MCP 通用规则，H1 冗余且降级为 H2 后会被
  // parseSections 误判为顶层新段（不在 AGENTS_SECTION_IDS → 当用户段保留），破坏幂等合并。
  const baseContent = GODOT_MCP_RULES
    .replace(/\{\{MCP_VERSION\}\}/g, mcpVersion)
    .replace(/^# Godot MCP 开发规则\n+/, '');
  sections.push(['## Godot MCP 通用规则', demoteHeadings(baseContent).trim()]);

  // ── 各子系统规则模板（剥离 frontmatter + 版本引用，降级 H2→H3/H3→H4）──
  for (const [header, templateKey] of SECTION_TO_TEMPLATE) {
    const tpl = DETAILED_RULE_TEMPLATES[templateKey];
    if (!tpl) continue;
    const cleaned = stripVersionQuote(stripFrontmatter(tpl)).replace(/\{\{MCP_VERSION\}\}/g, mcpVersion);
    sections.push([header, demoteHeadings(cleaned).trim()]);
  }

  // ── GDScript 规范 + 最佳实践（builders 直接产出，无标题需降级）──
  sections.push(['## Godot MCP GDScript 规范', buildTypeGuide()]);
  sections.push(['## Godot MCP 最佳实践', buildBestPractices()]);

  return sections;
}

/** 幂等合并 AGENTS.md：MCP 段替换，用户自建段保留。 */
export function mergeAgentsMd(existing: string, sections: Array<[string, string]>): string {
  return mergeSectionsGeneric(existing, sections, AGENTS_SECTION_IDS);
}

/**
 * 完整生成 AGENTS.md 全文（含 H1 项目名标题）。首次生成用；已存在时用 mergeAgentsMd。
 */
export function buildAgentsMd(
  config: GodotConfig | null,
  projectDir: string,
  projectName: string,
  mcpVersion: string,
): string {
  const sections = buildAgentsMdSections(config, projectDir, mcpVersion);
  const body = sections.map(([h, b]) => `${h}\n${b}`).join('\n\n');
  return `# ${projectName}\n\n${body}\n`;
}
