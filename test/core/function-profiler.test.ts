// test/core/function-profiler.test.ts — W10 批4 组A:帧解析纯函数单测
// 覆盖:合法帧解析/零调用行丢弃/未解析签名/布局漂移 fail-loud/asCount 边界/roundNumbers 递归。
// 诚实边界:DebuggerProfiler 类的 TCP 编排(accept/receive/自动停止/等待者)不在本文件——
// 需模拟 Godot debugger 协议拨入,依赖面重,留待专项(见审查文档缺口声明)。
import { describe, it, expect } from 'vitest';
import {
  badFrame, asNumber, asCount, roundNumbers, parseFrame,
  ProfilerError,
} from '../../src/core/function-profiler.js';

const ROW_STRIDE = 5;

/** 构造一个合法帧:[frameNo, 5 timings, serverCount, (name,entries,pairs...)*, rowCount, rows*STRIDE] */
function buildFrame(overrides: {
  frame?: number;
  servers?: Array<{ name: string; fns: Array<[string, number]> }>;
  rows?: Array<[id: number, calls: number, selfS: number, totalS: number]>;
}): unknown[] {
  const data: unknown[] = [
    overrides.frame ?? 100,
    0.016, 0.010, 0.002, 0.008, 0.003, // frameMs/processMs/physicsMs/physicsFrameMs/scriptMs(秒)
    (overrides.servers ?? []).length,
  ];
  for (const s of overrides.servers ?? []) {
    data.push(s.name, s.fns.length * 2);
    for (const [n, t] of s.fns) data.push(n, t);
  }
  const rows = overrides.rows ?? [];
  data.push(rows.length * ROW_STRIDE);
  for (const [id, calls, selfS, totalS] of rows) {
    data.push(id, calls, selfS, totalS, 0 /* internal_time,parseFrame 故意跳过 */);
  }
  return data;
}

describe('parseFrame(合法帧)', () => {
  it('timings 秒→毫秒(×1000),servers 结构与条目解析正确', () => {
    const data = buildFrame({
      frame: 42,
      servers: [{ name: 'Physics', fns: [['step', 0.5], ['sync', 0.25]] }],
      rows: [],
    });
    const sigs = new Map<number, string>();
    const f = parseFrame(data as never[], sigs);
    expect(f.frame).toBe(42);
    expect(f.timings.frameMs).toBeCloseTo(16, 6);
    expect(f.timings.scriptMs).toBeCloseTo(3, 6);
    expect(f.servers).toHaveLength(1);
    expect(f.servers[0]!.name).toBe('Physics');
    expect(f.servers[0]!.functions).toEqual([
      { name: 'step', ms: 500 },
      { name: 'sync', ms: 250 },
    ]);
    expect(f.rows).toEqual([]);
    expect(f.rawRowCount).toBe(0);
  });

  it('签名 file::line::function 三段拆分;未解析签名标记 sourceResolved=false', () => {
    const data = buildFrame({
      rows: [
        [7, 3, 0.001, 0.004],  // 已解析
        [9, 1, 0.0005, 0.001], // 未解析
      ],
    });
    const sigs = new Map([[7, 'res://game.gd::120::_physics_process']]);
    const f = parseFrame(data as never[], sigs);
    expect(f.rows).toHaveLength(2);
    const resolved = f.rows[0]!;
    expect(resolved.signature).toBe('res://game.gd::120::_physics_process');
    expect(resolved.file).toBe('res://game.gd');
    expect(resolved.line).toBe(120);
    expect(resolved.function).toBe('_physics_process');
    expect(resolved.sourceResolved).toBe(true);
    expect(resolved.calls).toBe(3);
    expect(resolved.selfMs).toBeCloseTo(1, 6);

    const unresolved = f.rows[1]!;
    expect(unresolved.signature).toBe('<unresolved:9>');
    expect(unresolved.sourceResolved).toBe(false);
    expect(unresolved.line).toBe(0); // 非 :: 拆分形态 line=0
  });

  it('零调用行被丢弃,但 rawRowCount 保留引擎真实行数(截断检查用)', () => {
    const data = buildFrame({
      rows: [
        [1, 5, 0.001, 0.002],
        [2, 0, 0, 0], // 零调用 → 丢弃
      ],
    });
    const f = parseFrame(data as never[], new Map([[1, 'a.gd::1::f'], [2, 'b.gd::2::g']]));
    expect(f.rows).toHaveLength(1);
    expect(f.rawRowCount).toBe(2);
  });
});

describe('parseFrame(布局漂移 fail-loud)', () => {
  it('server 块条目数为奇数 → profile_bad_frame', () => {
    const data: unknown[] = [1, 0, 0, 0, 0, 0, 1, 'Server', 3, 'a', 1, 'b', 2, 0];
    expect(() => parseFrame(data as never[], new Map())).toThrow(ProfilerError);
    expect(() => parseFrame(data as never[], new Map())).toThrow(/odd entry count/);
  });

  it('row 块长度不填满包尾 → profile_bad_frame(版本漂移防线)', () => {
    const base = buildFrame({ rows: [[1, 2, 0.001, 0.002]] });
    const tampered = [...base];
    tampered.push(999); // 尾部多一个元素 → offset+length !== data.length
    expect(() => parseFrame(tampered as never[], new Map())).toThrow(/does not fill the packet/);
  });

  it('计数位落了浮点计时值 → asCount 拒绝(防 for 循环静默走样)', () => {
    const data: unknown[] = [1, 0, 0, 0, 0, 0, 0.016, 0]; // serverCount=0.016 浮点
    expect(() => parseFrame(data as never[], new Map())).toThrow(/expected a count in \[0,/);
  });
});

describe('asNumber / asCount 边界', () => {
  it('asNumber 非 number 抛 badFrame', () => {
    expect(() => asNumber(undefined)).toThrow(ProfilerError);
    expect(() => asNumber('5' as never)).toThrow(/expected a number/);
    expect(asNumber(1.5)).toBe(1.5);
  });
  it('asCount 拒负数/超限;接受 0 与界内整数', () => {
    expect(() => asCount(-1, 10)).toThrow(/count in \[0, 10\]/);
    expect(() => asCount(11, 10)).toThrow(/count in \[0, 10\]/);
    expect(asCount(0, 10)).toBe(0);
    expect(asCount(10, 10)).toBe(10);
  });
});

describe('roundNumbers 递归取整', () => {
  it('number/array/嵌套对象递归,非数值原样保留', () => {
    expect(roundNumbers(0.123456789)).toBeCloseTo(0.1235, 6); // MS_ROUNDING 四位
    expect(roundNumbers([0.11111, 2])).toEqual([0.1111, 2]);
    expect(roundNumbers({ a: { b: 0.99999 }, s: 'x', n: null })).toEqual({
      a: { b: 1 }, s: 'x', n: null,
    });
  });
});

describe('badFrame / ProfilerError', () => {
  it('错误码与消息形态', () => {
    const e = badFrame('whatever');
    expect(e).toBeInstanceOf(ProfilerError);
    expect(e.code).toBe('profile_bad_frame');
    expect(e.message).toContain('whatever');
    expect(e.message).toContain('may not be supported');
  });
});
