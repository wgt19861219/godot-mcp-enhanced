/**
 * 反馈坑 2/3/4(2026-08-21 反馈批,CardGame2 2026-08-19 全量走查四坑之三)契约级锁定:
 * - 坑2 find_nodes 消费 root 参数(子树限定 + 无效 root 报错,不再静默全树)
 * - 坑4 call_method 协程双模式(GDScriptFunctionState 检测 + {coroutine:true} 标记
 *   + await_completion 哨兵延迟响应 + 完成推送守卫)
 * 行为级 e2e 见 test/e2e-bridge-feedback-pits.test.ts(L2 opt-in);坑3(override 插入
 * 位置)是 TS 侧,由 test/overrides.test.ts 顺序单测直接锁定,不在本文件。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

describe('坑2: find_nodes root 参数契约', () => {
  const findSlice = () => {
    const start = gd.indexOf('func _cmd_find_nodes');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = gd.indexOf('func ', start + 10);
    return gd.slice(start, end);
  };

  it('消费 root 参数(params.get("root"))而非忽略', () => {
    const s = findSlice();
    expect(s.includes('params.get("root"'), 'find_nodes 须读取 root 参数').toBe(true);
  });

  it('root 传入时限定 _traverse_tree 起点(opts.root),不再恒全树', () => {
    const s = findSlice();
    expect(s.includes('"root": start_root'), '_traverse_tree 须接收解析后的起点节点').toBe(true);
  });

  it('root 无效时报结构化错误(非静默全树搜索)', () => {
    const s = findSlice();
    expect(s.includes('Root node not found'), '无效 root 须报错而非回落全树').toBe(true);
  });
});

describe('坑4: call_method 协程双模式契约', () => {
  const callSlice = () => {
    const start = gd.indexOf('func _cmd_call_method');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = gd.indexOf('func _await_call_method_and_respond', start);
    return gd.slice(start, end);
  };

  it('协程检测:GDScriptFunctionState 用 get_class() 字符串判定(is 类型名不可解析)', () => {
    const s = callSlice();
    expect(s.includes('get_class() == "GDScriptFunctionState"'), '检测手段须为 get_class 字符串比对').toBe(true);
  });

  it('默认模式:协程返 {coroutine:true} 标记 + 说明(不再序列化内部状态对象)', () => {
    const s = callSlice();
    expect(s.includes('"coroutine": true'), '默认模式须带 coroutine 标记').toBe(true);
    expect(s.includes('await_completion=true'), '标记说明须指引用 await_completion').toBe(true);
  });

  it('await_completion 模式:延迟通道 O1 收敛——__deferred__ kind=call_method_async', () => {
    // O1 收敛(2026-09-18 批5):原 __call_method_async__/__CALL_METHOD_ASYNC__ 双哨兵 + 模块级
    // 临时变量 _pending_call_method_result,收敛为 handler 平铺 {"__deferred__": kind, ...payload}
    // + 识别端统一 "__DEFERRED__" + 消费端 kind 分派(延迟响应语义不变,e2e 坑4 三条守恒)。
    expect(gd.includes('"__deferred__": "call_method_async"'), '_cmd_call_method 须返统一哨兵 kind').toBe(true);
    expect(gd.includes('"__DEFERRED__"'), '_handle_message/消费端须统一哨兵字符串').toBe(true);
    expect(gd.includes('d_kind == "call_method_async"'), '消费端须按 kind 分派 call_method_async').toBe(true);
  });

  it('等待协程:await callv + 完成后 peer 查找推送(peer 断开丢响应)+ 节点失效守卫', () => {
    const start = gd.indexOf('func _await_call_method_and_respond');
    expect(start).toBeGreaterThanOrEqual(0);
    const s = gd.slice(start, gd.indexOf('func ', start + 10) === -1 ? undefined : gd.indexOf('func ', start + 10));
    expect(s.includes('await node.callv'), '须 await callv 等待真值').toBe(true);
    expect(s.includes('is_instance_valid'), '等待期间节点被 free 须守卫').toBe(true);
    expect(s.includes('target_peer == null'), 'peer 断开须丢响应').toBe(true);
  });
});
