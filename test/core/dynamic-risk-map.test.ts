import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_TO_TOOL, resolveDynamicTool } from '../../src/core/dynamic-risk-map.js';

// A1 (2026-08-11 审查 P1): METHOD_TO_TOOL 双副本同步契约。
// src/core/dynamic-risk-map.ts(运行时,ToolDispatcher 反查静态 risk)与
// scripts/check-command-docs-drift.mjs(构建期,GD docs ↔ TS schema drift 检测)
// 是两份独立副本(mjs 无法 import TS)。任一份增删 method 而另一份未同步 = drift:
// 运行时副本缺 method → 动态工具 fail-closed 多余确认(可用性);mjs 副本缺 method →
// drift 检测静默跳过(正确性)。本测试逐条比对两份表,drift 即红。

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIFT_SCRIPT = join(repoRoot, 'scripts', 'check-command-docs-drift.mjs');

/** 从 mjs 源码正则提取 METHOD_TO_TOOL 条目(method: { tool: 'x', action: 'y' [, actions: {...}] }) */
function extractMjsMap(source: string): Map<string, { tool: string; action: string; actions?: Record<string, string> }> {
  const blockMatch = source.match(/const METHOD_TO_TOOL = \{([\s\S]*?)\n\};/);
  expect(blockMatch, 'check-command-docs-drift.mjs 的 METHOD_TO_TOOL 块未找到(结构被破坏)').toBeTruthy();
  const body = blockMatch![1]!;
  const out = new Map<string, { tool: string; action: string; actions?: Record<string, string> }>();
  // C-1(2026-10-22): 新形状含 actions 表(animation_track/keyframe 按 GD 短 action 解析风险);
  // 旧形状(无 actions)仍须匹配——两种条目逐条比对,缺一即 drift。
  const entryRe = /^ {2}([a-z_]+):\s*\{ tool: '([a-z_]+)',\s*action: '([a-z_]+)'(, actions: \{ ([^}]+) \})? \},?/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const entry: { tool: string; action: string; actions?: Record<string, string> } = { tool: m[2]!, action: m[3]! };
    if (m[5]) {
      const actions: Record<string, string> = {};
      for (const pair of m[5]!.split(',')) {
        const kv = pair.match(/^\s*([a-z]+):\s*'([a-z_]+)'\s*$/);
        expect(kv, `mjs actions 表条目格式异常: ${pair}(method ${m[1]})`).toBeTruthy();
        actions[kv![1]!] = kv![2]!;
      }
      entry.actions = actions;
    }
    out.set(m[1]!, entry);
  }
  return out;
}

describe('C-1 真实 action 解析（2026-10-22 审查第二轮）', () => {
  it('animation_keyframe + remove → remove_keyframe（destructive）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'remove'))
      .toEqual({ tool: 'animation_track', action: 'remove_keyframe' });
  });
  it('animation_keyframe + update → update_keyframe（destructive）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'update'))
      .toEqual({ tool: 'animation_track', action: 'update_keyframe' });
  });
  it('animation_track + remove → remove_track（destructive）', () => {
    expect(resolveDynamicTool('animation_track', 'remove'))
      .toEqual({ tool: 'animation_track', action: 'remove_track' });
  });
  it('已登记 method + 未登记 action → undefined（fail-closed）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'evil_action')).toBeUndefined();
  });
  it('无内部 action 的 method 不受 actualAction 影响', () => {
    expect(resolveDynamicTool('engine_call_method', 'whatever'))
      .toEqual({ tool: 'engine', action: 'call_method' });
  });
});

describe('dynamic-risk-map (A1 双副本同步契约)', () => {
  it('METHOD_TO_TOOL 与 check-command-docs-drift.mjs 逐条一致', () => {
    const mjsMap = extractMjsMap(readFileSync(DRIFT_SCRIPT, 'utf-8'));
    expect(mjsMap.size).toBeGreaterThan(50);  // 基线 ~63 条;结构解析失败(size=0)也在此暴露

    const tsKeys = new Set(Object.keys(METHOD_TO_TOOL));
    const mjsKeys = new Set(mjsMap.keys());
    const onlyInTs = [...tsKeys].filter(k => !mjsKeys.has(k));
    const onlyInMjs = [...mjsKeys].filter(k => !tsKeys.has(k));
    expect(onlyInTs, `仅运行时副本有的 method(构建期 drift 检测漏覆盖): ${onlyInTs.join(', ')}`).toEqual([]);
    expect(onlyInMjs, `仅 mjs 副本有的 method(运行时反查 fail-closed 多余确认): ${onlyInMjs.join(', ')}`).toEqual([]);

    for (const [method, entry] of Object.entries(METHOD_TO_TOOL)) {
      expect(mjsMap.get(method), `method ${method} 两副本 tool/action 不一致`).toEqual(entry);
    }
  });

  it('resolveDynamicTool: 已映射返静态 (tool, action),未映射返 undefined', () => {
    expect(resolveDynamicTool('engine_call_method')).toEqual({ tool: 'engine', action: 'call_method' });
    expect(resolveDynamicTool('debug_evaluate')).toEqual({ tool: 'debug', action: 'evaluate' });
    expect(resolveDynamicTool('add_node')).toEqual({ tool: 'scene', action: 'add_node' });
    expect(resolveDynamicTool('not_a_method')).toBeUndefined();
  });

  it('gated 动态方法可经映射命中 action-gate(debug.evaluate 在 GATED_ACTIONS)', async () => {
    // 联动校验:dynamic-risk-map 把 debug_evaluate 映射到 (debug, evaluate),
    // 而 action-gate GATED_ACTIONS 含 'debug.evaluate' —— 两表协同才堵动态绕过。
    const { isActionGated } = await import('../../src/core/action-gate.js');
    const mapped = resolveDynamicTool('debug_evaluate');
    expect(mapped).toBeDefined();
    expect(isActionGated(mapped!.tool, mapped!.action)).toBe(true);
    expect(isActionGated('debug_evaluate', '')).toBe(false);  // 未反查时的原始形态(修复前的盲区)
  });
});
