import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllModules } from '../src/module-loader.js';
import { getModuleForTool } from '../src/core/tool-registry.js';
import { setActiveGroups } from '../src/core/tool-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_GD = readFileSync(resolve(__dirname, '..', 'src', 'scripts', 'mcp_bridge.gd'), 'utf8');

registerAllModules();

/**
 * P5 批 (2026-09-11) 测试:discover 按需发现评分 + near 空间查询。
 * discover 为纯 TS 逻辑(注册表数据),单测覆盖;near 的 GD 行为由 e2e(p3-e2e fixture
 * Anchor/NearA/NearB/FarAway 节点)与源码契约覆盖。
 */

describe('P5-1: discover 按需发现评分', () => {
  async function discover(query: string, top?: number): Promise<{ data: { total_matched: number; results: Array<{ tool: string; group: string; active: boolean; score: number; hint: string }> } }> {
    const mod = getModuleForTool('manage_tools');
    const result = await mod!.handleTool('manage_tools', { action: 'discover', query, ...(top !== undefined ? { top } : {}) }, {} as never);
    const text = result!.content.map(c => 'text' in c ? c.text : '').join('');
    return JSON.parse(text);
  }

  it('DISC-a: 关键词命中工具名/action 名,评分排序正确(screenshot 第一名)', async () => {
    const r = await discover('screenshot');
    expect(r.data.total_matched).toBeGreaterThan(0);
    expect(r.data.results[0]!.tool).toBe('screenshot');
    expect(r.data.results[0]!.score).toBeGreaterThanOrEqual(5);  // 工具名命中 ×5
    // P4 瘦身后 take_screenshot 在 game 的 method 属性描述里 → 第五维度(schema 属性描述×2)
    const game = r.data.results.find(x => x.tool === 'game');
    expect(game, 'take_screenshot 属性描述命中使 game 工具入选').toBeDefined();
    expect(game!.score).toBeGreaterThanOrEqual(2);
  });

  it('DISC-b: 中文关键词可用(描述命中)', async () => {
    const r = await discover('截图');
    expect(r.data.results.some(x => x.tool === 'screenshot')).toBe(true);
  });

  it('DISC-c: 多词累计评分 + top 截断', async () => {
    const r = await discover('export android', 3);
    expect(r.data.results.length).toBeLessThanOrEqual(3);
    expect(r.data.results[0]!.tool).toBe('android');
  });

  it('DISC-d: 未激活组返回 activate 指引 hint(模拟 basic profile 收窄)', async () => {
    const prev = await import('../src/core/tool-registry.js').then(m => m.getActiveGroups());
    try {
      // 模拟 basic:只留 core+bridge——android/engine 组未激活
      setActiveGroups(new Set(['core', 'bridge']));
      const r = await discover('export android');
      const android = r.data.results.find(x => x.tool === 'android');
      expect(android).toBeDefined();
      expect(android!.active).toBe(false);
      expect(android!.hint).toContain('manage_tools activate');
      expect(android!.hint).toContain('"android"');
    } finally {
      setActiveGroups(prev);  // 恢复,防污染后续测试
    }
  });

  it('DISC-e: 空 query 拒绝(INVALID_PARAMS)', async () => {
    const mod = getModuleForTool('manage_tools');
    const result = await mod!.handleTool('manage_tools', { action: 'discover', query: '  ' }, {} as never);
    const text = result!.content.map(c => 'text' in c ? c.text : '').join('');
    expect(text).toContain('INVALID_PARAMS');
  });
});

describe('P5-2: near 空间查询(源码契约;行为由 e2e 覆盖)', () => {
  it('NEAR-a: 锚点解析/维度校验/距离过滤/升序排序的契约字面量', () => {
    expect(BRIDGE_GD).toContain('near_node anchor not found');
    expect(BRIDGE_GD).toContain('near_node anchor must be Node2D/Node3D');
    expect(BRIDGE_GD).toContain('max_distance must be >= 0');
    // 同维度过滤(2D↔2D / 3D↔3D,异维度不收)
    expect(BRIDGE_GD).toContain('近邻查询只收与锚点同维度的节点');
    // 锚点自身排除 + 距离升序 tie 按名
    expect(BRIDGE_GD).toContain('if node == near_anchor:');
    expect(BRIDGE_GD).toContain('a["d"] < b["d"]');
    expect(BRIDGE_GD).toContain('info["distance"]');
  });

  it('NEAR-b: 默认 max_distance=1000 与 gua 式确定性排序(tie 按节点名)', () => {
    // H-2(2026-09-17 审查)后裸转收口为 _num 守卫,默认值语义不变(1000.0)
    expect(BRIDGE_GD).toContain('_num(params.get("max_distance"), 1000.0)');
    expect(BRIDGE_GD).toContain('(a["node"] as Node).name < (b["node"] as Node).name');
  });
});
