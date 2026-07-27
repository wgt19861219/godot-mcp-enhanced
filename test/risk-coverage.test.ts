// test/risk-coverage.test.ts
// 覆盖完整性测试 — 根除漏标的运行期硬约束
// 验证每个工具的每个 action 都在 actionRisks 中声明了风险等级

import { describe, it, expect } from 'vitest';
import { registerAllModules } from '../src/core/module-loader.js';
import { getAllToolDefinitions, getActionRisks } from '../src/core/tool-registry.js';

// 注册所有工具模块（必须在测试前执行）
registerAllModules();

/** GUARDED 工具集合（见下方 new Set）：其 actionRisks 允许声明非 read 风险（write/destructive/process）。
 * 任何不在此集合中的工具，其所有 action 的 risk 必须为 'read'（零行为改变不变量）。
 * project（H-1 修复）：create_project/setup_project_rules/write_config/apply_template 有真实
 * 副作用（建目录/多文件、改 project.godot、写 .claude/settings.json+CLAUDE.md+rules、注入 hook），
 * 已标 'write' 触发确认；纯查询 action 仍 'read'。 */
const GUARDED_KEYS = new Set([
  'scene', 'script', 'animation', 'tilemap', 'game', 'material', 'particles',
  'signal', 'nav', 'audio', 'ui', 'physics', 'runtime', 'android', 'workflow',
  'validation', 'manage_tools', 'project', 'cpp', 'csv_to_resources', 'asset',
  'blender',
  'self_update',  // update action 非 read（check=read / update=write）
]);

/** 从 inputSchema.action.enum 提取某工具全部 action 名 */
function extractActions(toolName: string): string[] {
  const def = getAllToolDefinitions().find(t => t.name === toolName);
  const enumArr = (def?.inputSchema as any)?.properties?.action?.enum;
  return Array.isArray(enumArr) ? enumArr : [];
}

describe('actionRisks 覆盖完整性（根除漏标）', () => {
  const toolNames = getAllToolDefinitions().map(t => t.name);

  for (const tool of toolNames) {
    const actions = extractActions(tool);

    // 跳过没有 action enum 的工具（如 static工具或无 action 参数的工具）
    if (actions.length === 0) continue;

    it(`${tool}: 每个 action 都声明了 risk`, () => {
      const risks = getActionRisks(tool);

      // 验证该工具已声明 actionRisks
      expect(risks, `${tool} 未声明 actionRisks`).toBeDefined();

      // 检测未在 actionRisks 中声明的 action（遗漏标注）
      const missing = actions.filter(a => !(a in (risks ?? {})));

      expect(missing, `${tool} 漏标 risk 的 action: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('非 GUARDED 工具的零行为改变不变量', () => {
  // 锁定：未在上方 GUARDED_KEYS 集合中的工具，其每个 action 的 risk 必须为 'read'。
  // 防止曾经无需确认的工具被静默升级为 write/destructive/process（行为改变）。
  const toolNames = getAllToolDefinitions().map(t => t.name);

  for (const tool of toolNames) {
    if (GUARDED_KEYS.has(tool)) continue; // GUARDED 工具允许非 read，跳过

    const actions = extractActions(tool);
    if (actions.length === 0) continue;

    it(`${tool}: 非 GUARDED 工具所有 action 须为 read`, () => {
      const risks = getActionRisks(tool);
      // 非 GUARDED 工具可能无 actionRisks（A-10 默认），此时无风险声明也意味着 read-only
      if (!risks) return;
      const upgraded = Object.entries(risks).filter(([, r]) => r !== 'read').map(([a]) => a);
      expect(upgraded, `${tool} 非 GUARDED 工具出现非 read 风险（行为改变）: ${upgraded.join(', ')}`).toEqual([]);
    });
  }
});
