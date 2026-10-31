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

// ── 2026-10-29 审查 B-1(F1/F2)+ M-2(F3)+ M-3(F4)清偿回归 ──────────────────
describe('circuit breaker(2026-10-29 审查清偿:集成面缺陷修复)', () => {
  beforeEach(() => { fakeNow = 1_000_000; delete process.env.GODOT_MCP_TOOL_CIRCUIT_BREAKER; });
  afterEach(() => { delete process.env.GODOT_MCP_TOOL_CIRCUIT_BREAKER; });

  it('F2:before 后 args 注入 project_path 不漂移键——after 计数落 before 键,后续调用被拒', async () => {
    const mw = mkMw();
    for (let i = 0; i < 3; i++) {
      // 模拟 executeToolCall:before 之后原地注入 project_path(F2 漂移源)
      const c = mkCtx('scene', 'commit', { scene_path: 'a' });
      await mw.before(c);
      c.args.project_path = '/injected/later';
      await mw.after!(c, failResult());
    }
    // 客户端仍省略 project_path 的下一次调用(= before 键)被拒
    const blocked = await runOnce(mw, mkCtx('scene', 'commit', { scene_path: 'a' }), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
  });

  it('F2:指纹剔除注入字段——pending.args 含 project_path 与客户端省略形态同键', () => {
    expect(stableArgsFingerprint({ action: 'commit', scene_path: 'a', project_path: '/p1' }))
      .toBe(stableArgsFingerprint({ action: 'commit', scene_path: 'a' }));
    // 显式传入不同 project_path 的两个调用也同键(project_path 非客户端语义)
    expect(stableArgsFingerprint({ action: 'commit', project_path: '/p1' }))
      .toBe(stableArgsFingerprint({ action: 'commit', project_path: '/p2' }));
  });

  it('确认令牌第一轮响应(requires_confirmation)中性:不清零真实失败计数', async () => {
    const mw = mkMw();
    const confirmationResult: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ requires_confirmation: true, tool: 'scene', confirmation_token: 'tok' }) }] };
    await runOnce(mw, mkCtx(), failResult()); // 真失败 1
    await runOnce(mw, mkCtx(), confirmationResult); // 第一轮发 token——不应清零
    await runOnce(mw, mkCtx(), failResult()); // 真失败 2
    await runOnce(mw, mkCtx(), failResult()); // 真失败 3 → 开路
    const blocked = await runOnce(mw, mkCtx(), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
  });

  it('三审遗留3收紧:正文伪造 requires_confirmation 子串但无 confirmation_token → 不豁免,照常记账', async () => {
    // 工具失败正文恰好引用了确认协议文档片段(子串伪造面)——真实令牌响应两键恒同现,
    // 单子串不构成豁免条件,失败照常累计(与 audit-log isTokenRequestResult 同口径)
    const mw = mkMw();
    const forged: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'error: doc says the literal marker "requires_confirmation":true must not appear in tool output' }],
    };
    await runOnce(mw, mkCtx(), forged); // 记账 1
    await runOnce(mw, mkCtx(), forged); // 记账 2
    await runOnce(mw, mkCtx(), forged); // 记账 3 → 开路
    const blocked = await runOnce(mw, mkCtx(), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
  });

  it('M-2:半开试探在飞期间并发调用被拒(单飞);试探失败续开路', async () => {
    const mw = mkMw(3, 600_000);
    for (let i = 0; i < 3; i++) await runOnce(mw, mkCtx(), failResult()); // 开路
    fakeNow += 601_000;
    // 试探请求 1:半开放行(probingAt 登记),尚未 after
    const probeCtx = mkCtx();
    const before1 = await mw.before(probeCtx);
    expect('rejected' in before1 && before1.rejected).toBe(false);
    // 并发请求 2:同参数,试探在飞 → 拒绝
    const before2 = await mw.before(mkCtx());
    expect('rejected' in before2 && before2.rejected).toBe(true);
    const text2 = ((before2 as { error: ToolResult }).error.content?.[0] as { text: string }).text;
    expect(text2).toContain('半开试探进行中');
    // 试探 1 失败 → 续开路;此后新调用仍被拒(常规开路文案)
    await mw.after!(probeCtx, failResult());
    const blocked = await runOnce(mw, mkCtx(), okResult());
    expect((blocked.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    expect((blocked.content?.[0] as { text: string }).text).not.toContain('半开试探进行中');
  });

  it('M-2:probingAt 超过 probeTimeoutMs 视为试探丢失,允许新试探(防永久锁死)', async () => {
    const mw = createCircuitBreakerMiddleware({
      threshold: 3, openMs: 600_000, probeTimeoutMs: 1_000, now: () => fakeNow,
      getActionRisk: () => 'write',
    });
    for (let i = 0; i < 3; i++) await runOnce(mw, mkCtx(), failResult()); // 开路
    fakeNow += 601_000;
    const probeCtx = mkCtx();
    await mw.before(probeCtx); // 半开放行,probingAt 登记,不 after(模拟试探丢失)
    fakeNow += 2_000; // 超过 probeTimeoutMs
    const retry = await runOnce(mw, mkCtx(), okResult()); // 新试探放行且成功 → 关路
    expect(retry.isError).toBeUndefined();
    const after = await runOnce(mw, mkCtx(), failResult()); // 已关路,重新计数(真执行)
    expect((after.content?.[0] as { text: string }).text).not.toContain('TOOL_CIRCUIT_OPEN');
  });

  it('M-3:全开路超限时按最旧 openedAt 淘汰,Map 不无界增长', async () => {
    const mw = createCircuitBreakerMiddleware({
      threshold: 1, openMs: 600_000, maxKeys: 2, now: () => fakeNow,
      getActionRisk: () => 'write',
    });
    // 三个键各 1 败全开路(key1 最旧)
    await runOnce(mw, mkCtx('scene', 'commit', { p: '1' }), failResult());
    fakeNow += 1_000;
    await runOnce(mw, mkCtx('scene', 'commit', { p: '2' }), failResult());
    fakeNow += 1_000;
    await runOnce(mw, mkCtx('scene', 'commit', { p: '3' }), failResult()); // size 3 > 2,全开路 → 淘汰 key1(最旧)
    // key2/key3 仍被拒
    const b2 = await runOnce(mw, mkCtx('scene', 'commit', { p: '2' }), okResult());
    expect((b2.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    const b3 = await runOnce(mw, mkCtx('scene', 'commit', { p: '3' }), okResult());
    expect((b3.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    // key1 被淘汰 → 放行(真执行)
    const r1 = await runOnce(mw, mkCtx('scene', 'commit', { p: '1' }), okResult());
    expect(r1.isError).toBeUndefined();
  });

  it('F1 接入面:checkOpen/recordOutcome 与 middleware 共用计数表(确认流路径)', async () => {
    const mw = mkMw();
    // 确认流记账:recordOutcome ×3(模拟 _confirmExecute 真实执行失败)
    for (let i = 0; i < 3; i++) mw.recordOutcome('scene', { action: 'commit', scene_path: 'a', project_path: '/p' }, failResult());
    // 确认流前置检查:第 4 次同参真实执行被拒(含注入的 project_path,与 middleware 键一致)
    const blocked = mw.checkOpen('scene', { action: 'commit', scene_path: 'a', project_path: '/p' });
    expect(blocked).not.toBeNull();
    expect((blocked!.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    // middleware 直接调用路径(客户端省略 project_path)同键被拒——两路径键空间互通
    const blockedMw = await runOnce(mw, mkCtx('scene', 'commit', { scene_path: 'a' }), okResult());
    expect((blockedMw.content?.[0] as { text: string }).text).toContain('TOOL_CIRCUIT_OPEN');
    // failed 覆盖参数:{success:false} JSON 无 isError 也计入(确认流绕过 healthSample 补打)
    const mw2 = mkMw();
    for (let i = 0; i < 3; i++) mw2.recordOutcome('scene', { action: 'commit' }, { content: [{ type: 'text', text: '{"success":false}' }] }, true);
    expect(mw2.checkOpen('scene', { action: 'commit' })).not.toBeNull();
  });
});
