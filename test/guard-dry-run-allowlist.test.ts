// 批 B 审查 B-1 清偿:dry_run 确认豁免收敛到「handler 真实实现 dry_run」的 action 白名单。
// 回归锚:全局布尔短路会让任意写/删 action 传 dry_run:true 绕过确认令牌
// (2026-07-12 dynamicRiskOverride 同型教训——豁免不得信任调用方承诺)。
// guard 依赖 tool-registry 的 getActionRisk;本文件 mock 之以构造「risk=write」场景。
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/core/tool-registry.js', () => ({
  getActionRisk: vi.fn((tool: string, action: string) =>
    (['scene.commit', 'scene.remove_node', 'script.project_replace'].includes(`${tool}.${action}`) ? 'write' : undefined)),
  getActionRisks: vi.fn(() => undefined),
}));

import { requiresConfirmation, DRY_RUN_IMPLEMENTED } from '../src/core/guard.js';

describe('dry_run 确认豁免白名单(批 B 审查 B-1)', () => {
  it('白名单内的 dry_run 调用免确认(scene.commit / script.project_replace)', () => {
    expect(requiresConfirmation('scene', { action: 'commit', dry_run: true })).toBe(false);
    expect(requiresConfirmation('script', { action: 'project_replace', dry_run: true })).toBe(false);
  });

  it('白名单外的写类 action 传 dry_run:true 仍需确认(绕过面已封死)', () => {
    expect(requiresConfirmation('scene', { action: 'remove_node', dry_run: true })).toBe(true);
    expect(requiresConfirmation('scene', { action: 'commit', dry_run: false })).toBe(true); // 未声明 dry_run 原样确认
  });

  it('DRY_RUN_IMPLEMENTED 白名单内容锚定(新增实现 dry_run 的 handler 时同步维护)', () => {
    expect([...DRY_RUN_IMPLEMENTED].sort()).toEqual(['scene.commit', 'script.project_replace']);
  });
});
