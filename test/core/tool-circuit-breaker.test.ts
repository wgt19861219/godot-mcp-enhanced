// 批 B3 (2026-10-26): 工具级失败熔断 middleware 单测。
// 纯注入式测试(now/getActionRisk 注入,不依赖 tool-registry 真实元数据)。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createCircuitBreakerMiddleware,
  stableArgsFingerprint,
  parseOpsErrorCode,
} from '../../src/core/tool-circuit-breaker.js';
import { opsErrorResult } from '../../src/core/shared/errors.js';
import type { DispatchContext, ToolResult } from '../../src/types.js';

let fakeNow = 1_000_000;
const riskTable: Record<string, string> = { 'scene.commit': 'write', 'script.execute_gdscript': 'process', 'scene.read_scene': 'read' };

function mkMw(threshold = 3, openMs = 600_000) {
  return createCircuitBreakerMiddleware({
    threshold,
    openMs,
    now: () => fakeNow,
    getActionRisk: (tool, action) => riskTable[`${tool}.${action}`] as never,
  });
}

function mkCtx(toolName = 'scene', action = 'commit', args: Record<string, unknown> = {}): DispatchContext {
  return { toolName, args: { action, ...args }, startTime: fakeNow, phase: 'before', traceId: 't' };
}

const failResult = (): ToolResult => opsErrorResult('COMMIT_FAILED', '保存失败: EACCES permission denied');
const okResult = (): ToolResult => ({ content: [{ type: 'text', text: '{"success":true}' }] });

async function runOnce(mw: ReturnType<typeof mkMw>, ctx: DispatchContext, result: ToolResult) {
  const before = await mw.before(ctx);
  if ('rejected' in before && before.rejected) return before.error;
  return await mw.after!(ctx, result);
}

describe('stableArgsFingerprint', () => {
  it('键序无关 → 同指纹;值变 → 不同指纹;嵌套对象 canonical', () => {
    expect(stableArgsFingerprint({ a: 1, b: { x: 1, y: 2 } }))
      .toBe(stableArgsFingerprint({ b: { y: 2, x: 1 }, a: 1 }));
    expect(stableArgsFingerprint({ a: 1 })).not.toBe(stableArgsFingerprint({ a: 2 }));
    expect(stableArgsFingerprint({ l: [3, 1, 2] })).not.toBe(stableArgsFingerprint({ l: [1, 2, 3] })); // 数组保序
  });
});

describe('parseOpsErrorCode', () => {
  it('解析 opsErrorResult 的 error_code;非 JSON 返回 undefined', () => {
    expect(parseOpsErrorCode(opsErrorResult('X_CODE', 'm'))).toBe('X_CODE');
    expect(parseOpsErrorCode({ content: [{ type: 'text', text: 'plain' }] })).toBeUndefined();
  });
});

describe('circuit breaker(批 B3:同参数连续 N 败拒绝,写类专属)', () => {
  beforeEach(() => { fakeNow = 1_000_000; delete process.env.GODOT_MCP_TOOL_CIRCUIT_BREAKER; });
  afterEach(() => { delete process.env.GODOT_MCP_TOOL_CIRCUIT_BREAKER; });

  it('同参数连续 3 败 → 第 4 次拒绝(TOOL_CIRCUIT_OPEN,含首错摘要与指引)', async () => {
    const mw = mkMw();
    const args = { scene_path: 'res://a.tscn' };
    await runOnce(mw, mkCtx('scene', 'commit', args), failResult());
    await runOnce(mw, mkCtx('scene', 'commit', args), failResult());
    await runOnce(mw, mkCtx('scene', 'commit', args), failResult()); // 第 3 败 → 开路
    const blocked = await runOnce(mw, mkCtx('scene', 'commit', args), failResult());
    expect(blocked.isError).toBe(true);
    const text = (blocked.content?.[0] as { text: string }).text;
    expect(text).toContain('TOOL_CIRCUIT_OPEN');
    expect(text).toContain('EACCES'); // 首错摘要
    expect(text).toContain('read 目标状态');
  });

  it('参数变化 → 新指纹不拒绝(设计意图:改参数获得新机会)', async () => {
    const mw = mkMw();
    for (let i = 0; i < 3; i++) await runOnce(mw, mkCtx('scene', 'commit', { scene_path: 'a' }), failResult());
    const ok = await runOnce(mw, mkCtx('scene', 'commit', { scene_path: 'b' }), okResult());
    expect(ok.isError).toBeUndefined();
  });

  it('成功清零:2 败 1 成功再 2 败 → 不开路', async () => {
    const mw = mkMw();
    await runOnce(mw, mkCtx(), failResult());
    await runOnce(mw, mkCtx(), failResult());
    await runOnce(mw, mkCtx(), okResult());
    await runOnce(mw, mkCtx(), failResult());
    const r = await runOnce(mw, mkCtx(), failResult()); // 连续仅 2 败,工具真执行(返回其自身失败结果,非熔断拒绝)
    const text = (r.content?.[0] as { text: string }).text;
    expect(r.isError).toBe(true);
    expect(text).not.toContain('TOOL_CIRCUIT_OPEN');
  });

  it('read 类 action 不熔(探测失败属正常探路)', async () => {
    const mw = mkMw();
    for (let i = 0; i < 5; i++) await runOnce(mw, mkCtx('scene', 'read_scene'), failResult());
    const r = await runOnce(mw, mkCtx('scene', 'read_scene'), failResult());
    expect((r.content?.[0] as { text: string }).text).not.toContain('TOOL_CIRCUIT_OPEN');
  });

  it('批 B1:dry_run 只读预检不熔(与 guard.ts 同款豁免)', async () => {
    const mw = mkMw();
    const dryCtx = (): DispatchContext => ({ toolName: 'scene', args: { action: 'commit', dry_run: true }, startTime: fakeNow, phase: 'before', traceId: 't' });
    for (let i = 0; i < 5; i++) await runOnce(mw, dryCtx(), failResult());
    const r = await runOnce(mw, dryCtx(), failResult());
    expect((r.content?.[0] as { text: string }).text).not.toContain('TOOL_CIRCUIT_OPEN');
  });

  it('risk 未知(undefined)不熔——防御层不因元数据缺失误伤', async () => {
    const mw = mkMw();
    for (let i = 0; i < 5; i++) await runOnce(mw, mkCtx('other', 'unknown_action'), failResult());
    const r = await runOnce(mw, mkCtx('other', 'unknown_action'), failResult());
    expect((r.content?.[0] as { text: string }).text).not.toContain('TOOL_CIRCUIT_OPEN');
  });

  it('开路 openMs 后半开放行一次试探;试探失败续开路,成功关路', async () => {
    const mw = mkMw(3, 600_000);
    for (let i = 0; i < 3; i++) await runOnce(mw, mkCtx(), failResult());
    fakeNow += 601_000; // 越过半开窗口
    const probe = await runOnce(mw, mkCtx(), failResult()); // 半开试探放行(计入第 4 败,重新计时)
    expect(probe.isError).toBe(true); // 试探本身执行了(是工具的真失败结果,非熔断拒绝)
    const blocked = await runOnce(mw, mkCtx(), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN'); // 续开路
    fakeNow += 601_000;
    const healed = await runOnce(mw, mkCtx(), okResult()); // 二次半开试探成功
    expect(healed.isError).toBeUndefined();
    const after = await runOnce(mw, mkCtx(), failResult()); // 已关路,重新计数
    expect(after.isError).toBe(true); // 工具真执行(failResult 本身 isError)
  });

  it('middleware 层错误码不计入:MISSING_PARAM(elicit 拒绝)不累计熔断', async () => {
    const mw = mkMw();
    const ctx = mkCtx();
    for (let i = 0; i < 3; i++) {
      await mw.before(ctx); // 标记 passed
      await mw.after!(ctx, opsErrorResult('MISSING_PARAM', '缺参'));
    }
    const r = await runOnce(mw, mkCtx(), failResult());
    expect(r.isError).toBe(true); // 工具真执行,未熔断
  });

  it('批 B 审查 Nit-1:middleware 层拒绝不清零真实失败计数(1 败 + MISSING_PARAM + 2 败 → 开路)', async () => {
    const mw = mkMw();
    await runOnce(mw, mkCtx(), failResult()); // 真失败 1
    const ctx = mkCtx();
    await mw.before(ctx);
    await mw.after!(ctx, opsErrorResult('MISSING_PARAM', '缺参')); // 非工具失败,不应清零
    await runOnce(mw, mkCtx(), failResult()); // 真失败 2
    await runOnce(mw, mkCtx(), failResult()); // 真失败 3 → 开路
    const blocked = await runOnce(mw, mkCtx(), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
  });

  it('GODOT_MCP_TOOL_CIRCUIT_BREAKER=0 关闭(默认开)', async () => {
    const mw = mkMw();
    for (let i = 0; i < 5; i++) await runOnce(mw, mkCtx(), failResult());
    const stillOn = await runOnce(mw, mkCtx(), failResult());
    expect((stillOn.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    process.env.GODOT_MCP_TOOL_CIRCUIT_BREAKER = '0';
    const mw2 = mkMw();
    for (let i = 0; i < 5; i++) await runOnce(mw2, mkCtx(), failResult());
    const off = await runOnce(mw2, mkCtx(), failResult());
    expect(off.isError).toBe(true); // 工具真失败结果,非熔断
  });

  it('maxKeys 超限清未开路条目,保留开路条目(正在防御的状态优先)', async () => {
    const mw = createCircuitBreakerMiddleware({
      threshold: 2, openMs: 600_000, maxKeys: 3, now: () => fakeNow,
      getActionRisk: () => 'write',
    });
    // key1 连续 2 败开路
    await runOnce(mw, mkCtx('scene', 'commit', { p: '1' }), failResult());
    await runOnce(mw, mkCtx('scene', 'commit', { p: '1' }), failResult());
    // 填满至超限(未开路条目)
    await runOnce(mw, mkCtx('scene', 'commit', { p: '2' }), failResult());
    await runOnce(mw, mkCtx('scene', 'commit', { p: '3' }), failResult());
    await runOnce(mw, mkCtx('scene', 'commit', { p: '4' }), failResult()); // 超限触发清理
    // key1(开路)仍拒绝——未被清理
    const blocked = await runOnce(mw, mkCtx('scene', 'commit', { p: '1' }), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
  });
});
