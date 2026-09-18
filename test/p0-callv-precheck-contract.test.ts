import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// P0-1 (2026-09-11): callv 参数预检 — 源码字面量契约测试。
// 坑:Godot callv 对无法转换的参数 push 引擎错误并返回 null,bridge 曾把 null 当
// "成功返回 null"误报(与 void 返回不可区分)。aigengame 在 4.6.3 实测中招组合:
// String→int / Dictionary→Object / null→int / JSON array→Array[int]。
// 修复:_cmd_call_method 在 coerce 后、callv 前做个数+类型预检,不可达组合显式
// 拒绝(code -10)。GD 运行在游戏进程无法单测运行时行为,此处验证源码落位
// (模式对齐 cmp-9-bridge-call-method.test.ts)。

describe('P0-1: callv 参数预检(GD 源码契约)', () => {
  const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

  it('P0-1a: _cmd_call_method 在 coerce 后调用预检,且在协程哨兵前(覆盖 await 路径)', () => {
    const fnStart = gd.indexOf('func _cmd_call_method');
    expect(fnStart, '缺 _cmd_call_method 函数').toBeGreaterThan(-1);
    const fnEnd = gd.indexOf('\nfunc ', fnStart + 10);
    const slice = gd.slice(fnStart, fnEnd);
    const coercePos = slice.indexOf('_coerce_bridge_args(node, method, args)');
    const precheckPos = slice.indexOf('_call_args_precheck_error(node, method, _coerced)');
    const asyncPos = slice.indexOf('"__deferred__": "call_method_async"');  // O1 收敛(批5):原 __call_method_async__ 锚
    const callvPos = slice.indexOf('node.callv(method, _coerced)');
    expect(coercePos, '缺 coerce 调用').toBeGreaterThan(-1);
    expect(precheckPos, '缺预检调用').toBeGreaterThan(-1);
    expect(asyncPos, '缺协程延迟哨兵(定位锚)').toBeGreaterThan(-1);
    expect(callvPos, '缺 callv(定位锚)').toBeGreaterThan(-1);
    // 顺序:coerce → precheck → 协程哨兵 → callv
    expect(precheckPos, '预检必须在 coerce 之后').toBeGreaterThan(coercePos);
    expect(precheckPos, '预检必须在协程哨兵( await_completion 分支)之前,覆盖 await 路径').toBeLessThan(asyncPos);
    expect(precheckPos, '预检必须在 callv 之前').toBeLessThan(callvPos);
  });

  it('P0-1b: 预检失败返回错误码 -10', () => {
    const fnStart = gd.indexOf('func _cmd_call_method');
    const fnEnd = gd.indexOf('\nfunc ', fnStart + 10);
    const slice = gd.slice(fnStart, fnEnd);
    expect(slice.includes('"code": -10'), '预检错误缺 code -10').toBe(true);
    expect(slice.includes('Argument mismatch'), '预检错误缺 Argument mismatch 前缀').toBe(true);
  });

  it('P0-1c: _BRIDGE_ARG_STRICT_CONVERSIONS 常量表存在且覆盖关键源行', () => {
    const constStart = gd.indexOf('const _BRIDGE_ARG_STRICT_CONVERSIONS');
    expect(constStart, '缺 _BRIDGE_ARG_STRICT_CONVERSIONS 常量').toBeGreaterThan(-1);
    const slice = gd.slice(constStart, constStart + 900);
    // JSON 6 源行(aigengame 真引擎验证表)+ INT 源行(coerce 产物)
    expect(slice.includes('TYPE_NIL: [TYPE_OBJECT]'), '缺 NIL→OBJECT(null 可传 Object 参数)').toBe(true);
    expect(slice.includes('TYPE_BOOL: [TYPE_INT, TYPE_FLOAT]'), '缺 BOOL 源行').toBe(true);
    expect(slice.includes('TYPE_INT: [TYPE_FLOAT]'), '缺 INT 源行(coerce 产物宽化)').toBe(true);
    expect(slice.includes('TYPE_FLOAT: [TYPE_BOOL, TYPE_INT]'), '缺 FLOAT 源行').toBe(true);
    expect(slice.includes('TYPE_STRING_NAME'), '缺 STRING→STRING_NAME/NODE_PATH/COLOR 行').toBe(true);
    expect(slice.includes('TYPE_PACKED_VECTOR4_ARRAY'), '缺 ARRAY→PACKED_* 行').toBe(true);
    expect(slice.includes('TYPE_DICTIONARY: []'), '缺 DICTIONARY 空行(Dictionary 不可宽化)').toBe(true);
  });

  it('P0-1d: _call_args_precheck_error 为 static func 且含 count+type 双检查', () => {
    const fnStart = gd.indexOf('static func _call_args_precheck_error');
    expect(fnStart, '缺 static func _call_args_precheck_error(static 供行为探针直接调用)').toBeGreaterThan(-1);
    const fnEnd = gd.indexOf('\nfunc ', fnStart + 10);
    const slice = gd.slice(fnStart, fnEnd === -1 ? fnStart + 2500 : fnEnd);
    // count:required = declared - default_args;vararg 判定
    expect(slice.includes('default_args'), '预检缺 default_args(必参个数计算)').toBe(true);
    expect(slice.includes('METHOD_FLAG_VARARG'), '预检缺 VARARG 判定').toBe(true);
    expect(slice.includes('needs at least'), '预检缺个数不足错误').toBe(true);
    expect(slice.includes('accepts at most'), '预检缺个数超出错误').toBe(true);
    // type:typed container 拒绝 + identity + 宽化表查询
    expect(slice.includes('PROPERTY_HINT_NONE'), '预检缺 typed container hint 判定').toBe(true);
    expect(slice.includes('typeof(val) == declared_type'), '预检缺 identity 检查').toBe(true);
    expect(slice.includes('_BRIDGE_ARG_STRICT_CONVERSIONS.get'), '预检缺宽化表查询').toBe(true);
    // 动态方法(签名取不到)放行,不拦
    expect(slice.includes('method_info.is_empty()'), '预检缺签名空放行分支').toBe(true);
  });

  it('P0-1e: TS 侧 game-bridge.ts 描述同步预检行为', () => {
    const ts = readFileSync('src/tools/game-bridge.ts', 'utf8');
    // P4-1 瘦身后 params 描述留紧凑指引,完整预检说明承接进规则文档(godot-mcp-bridge.md)
    expect(ts.includes('预检-10'), '工具描述缺预检 -10 指引').toBe(true);
    expect(ts.includes('见规则'), '工具描述缺规则文档指引').toBe(true);
  });
});
