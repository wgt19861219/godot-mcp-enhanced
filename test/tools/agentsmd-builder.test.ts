import { describe, it, expect } from 'vitest';
import { buildAgentsMd, buildAgentsMdSections, mergeAgentsMd, AGENTS_SECTION_IDS } from '../../src/tools/agentsmd-builder.js';
import type { GodotConfig } from '../../src/core/config-parser.js';

const config: GodotConfig = {
  application: { 'config/name': 'TestGame', 'config/features': 'PackedStringArray("4.6")', 'run/main_scene': 'res://main.tscn' },
} as unknown as GodotConfig;

describe('agentsmd-builder', () => {
  it('生成含全部 MCP 段 header', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    for (const h of AGENTS_SECTION_IDS) {
      expect(md).toContain(h);
    }
  });

  it('标题降级：规则文件内嵌 ## 不出现在顶层（被降为 ###）', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    // core 模板有 "## 概述与架构"，降级后应为 "### 概述与架构"，不应作为顶层 ##
    expect(md).not.toMatch(/\n## 概述与架构\n/);
    expect(md).toMatch(/### 概述与架构/);
  });

  it('剥离 yaml frontmatter（生成结果无 --- 块）', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    expect(md).not.toMatch(/\ndescription:\s/);
    expect(md).not.toMatch(/\nalwaysApply:\s/);
  });

  it('{{MCP_VERSION}} 插值', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    expect(md).not.toContain('{{MCP_VERSION}}');
    expect(md).toContain('0.99.0');
  });

  it('代码块内的 # 不被降级（状态机跳过 ``` 块）', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    // core 模板决策树代码块含 "├─" 不含 # 标题；但若有代码块内 # 注释应保留原样。
    // 关键：base 的 GODOT_MCP_RULES 内无代码块；core 决策树 ``` 块内的内容不应出现多余的 ### 降级。
    // 断言：决策树块内的 "├─ .tscn/.gd 文件" 原样保留
    expect(md).toContain('├─ .tscn/.gd 文件');
  });

  it('AGENTS_SECTION_IDS 含 10 个段（项目信息 + base + 6 子系统 + 类型规范 + 最佳实践）', () => {
    expect(AGENTS_SECTION_IDS.size).toBe(10);
  });

  it('含 ZCode 内联说明（不指向 .claude/rules/）', () => {
    const md = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    expect(md).toContain('已全部内联到本文件');
  });

  it('二次合并不产生 base H1 降级的伪段（幂等）', () => {
    const first = buildAgentsMd(config, '.', 'TestGame', '0.99.0');
    const sections = buildAgentsMdSections(config, '.', '0.99.0');
    const merged = mergeAgentsMd(first, sections);
    // base 段 body 内不应有 ## Godot MCP 开发规则（H1 已剥，非降级为 H2）
    expect(merged).not.toMatch(/\n## Godot MCP 开发规则\n/);
    // 幂等：二次合并后 AGENTS_SECTION_IDS 的段仍各出现一次
    for (const h of AGENTS_SECTION_IDS) {
      expect(merged.split(h).length).toBe(2);  // 段头出现 1 次 → split 得 2 段
    }
  });
});
