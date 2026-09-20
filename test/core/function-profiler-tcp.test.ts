// test/core/function-profiler-tcp.test.ts — W10 遗留批6:DebuggerProfiler TCP 编排测试
// 真协议 localhost 拨入(net.connect + encodeVariant 编码 + 4 字节 LE 长度前缀),
// 覆盖状态机主链:accept/set_pid 握手→start(出站启用消息)→签名注册→帧折叠(首帧丢弃
// 语义)→profile_total 哨兵 finalize→stop 排名输出;以及防线(零长度包/超尺寸包经
// fail→挂起 wait 拒绝、bad_args/profile_not_started/profile_busy)。
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { DebuggerProfiler, ProfilerError } from '../../src/core/function-profiler.js';
import { encodeVariant, decodeVariant } from '../../src/core/godot-variant.js';

const ROW_STRIDE = 5;

/** 4 字节小端长度前缀 + variant payload(对齐 receive 的组帧协议) */
function framed(msg: unknown[]): Buffer {
  const payload = encodeVariant(msg);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

/** 构造合法 profile_frame 的 data 段(与 parseFrame 布局一致,见 function-profiler.test.ts) */
function frameData(frame: number, rows: Array<[id: number, calls: number, selfS: number, totalS: number]>): unknown[] {
  const data: unknown[] = [frame, 0.016, 0.010, 0.002, 0.008, 0.003, 0];
  data.push(rows.length * ROW_STRIDE);
  for (const [id, calls, selfS, totalS] of rows) data.push(id, calls, selfS, totalS, 0);
  return data;
}

/** 收集 server 出站消息(已解码) */
class Outbound {
  private buf = Buffer.alloc(0);
  private queue: unknown[][] = [];
  private waiters: Array<(m: unknown[]) => void> = [];
  constructor(sock: net.Socket) {
    sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= 4) {
        const size = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + size) break;
        try { this.queue.push(decodeVariant(this.buf.subarray(4, 4 + size)) as unknown[]); } catch { /* 不可解码忽略 */ }
        this.buf = this.buf.subarray(4 + size);
        const w = this.waiters.shift();
        if (w) w(this.queue[this.queue.length - 1]!);
      }
    });
  }
  next(): Promise<unknown[]> {
    return new Promise((res) => {
      const m = this.queue.shift();
      if (m) res(m); else this.waiters.push(res);
    });
  }
}

async function dial(port: number): Promise<net.Socket> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  return sock;
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

describe('DebuggerProfiler TCP 状态机(真协议 localhost)', () => {
  it('参数校验:seconds/captureLimit 越界 → bad_args;未 start 的 stop → profile_not_started', async () => {
    const prof = await DebuggerProfiler.create();
    cleanups.push(() => prof.close());
    await expect(prof.start(0, 16)).rejects.toMatchObject({ code: 'bad_args' });
    await expect(prof.start(61, 16)).rejects.toMatchObject({ code: 'bad_args' });
    await expect(prof.start(1, 15)).rejects.toMatchObject({ code: 'bad_args' }); // CAPTURE_LIMIT_MIN=16
    await expect(prof.stop(10, 'selfMs')).rejects.toMatchObject({ code: 'profile_not_started' });
    await expect(prof.stop(0, 'selfMs')).rejects.toMatchObject({ code: 'bad_args' });
    await expect(prof.stop(10, 'nope' as never)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('主链:握手→start(出站启用消息)→签名→两帧折叠(首帧丢弃)→total 哨兵→stop 排名', async () => {
    const prof = await DebuggerProfiler.create();
    cleanups.push(() => prof.close());
    const sock = await dial(prof.port);
    const outbound = new Outbound(sock);

    sock.write(framed(['set_pid', 7, [4242]]));
    const startP = prof.start(1, 16);
    // 出站第一条应为启用消息: ['profiler:servers', threadId, [true, [limit, false]]]
    const enable = await outbound.next();
    expect(enable[0]).toBe('profiler:servers');
    expect(enable[2]).toEqual([true, [16, false]]);

    // 签名注册 + 两帧(首帧被丢弃——VM 内启用的首样本时间戳为零,见 handle 注释)
    sock.write(framed(['servers:function_signature', 7, ['res://a.gd::10::do_work', 1]]));
    sock.write(framed(['servers:profile_frame', 7, frameData(100, [[1, 3, 0.001, 0.004]])])); // 丢弃
    sock.write(framed(['servers:profile_frame', 7, frameData(101, [[1, 5, 0.002, 0.006]])])); // 计入
    const started = await startP;
    expect(started.active).toBe(true);
    expect(started.captureLimit).toBe(16);

    // 完成哨兵 → finalize → stop 排名(引擎累计总表只作哨兵,排名来自帧折叠)
    sock.write(framed(['servers:profile_total', 7, frameData(101, [])]));
    const result = await prof.stop(10, 'selfMs');
    const row = result.rows.find(r => r.signature === 'res://a.gd::10::do_work');
    expect(row).toBeDefined();
    expect(row!.calls).toBe(5);       // 第二帧 calls=5(首帧 3 已丢弃)
    expect(row!.selfMs).toBeCloseTo(2, 4);
    expect(prof.hasResult).toBe(true);
    sock.destroy();
  });

  it('防线:零长度包 → 组帧失步,fail 拒绝挂起中的 start', async () => {
    const prof = await DebuggerProfiler.create();
    cleanups.push(() => prof.close());
    const sock = await dial(prof.port);
    sock.write(framed(['set_pid', 7, [1]]));
    await new Promise((r) => setTimeout(r, 50)); // 等握手被处理
    const startP = prof.start(1, 16);
    await new Promise((r) => setTimeout(r, 50));
    sock.write(Buffer.alloc(4)); // size=0
    await expect(startP).rejects.toMatchObject({ message: expect.stringContaining('zero-length') });
    sock.destroy();
  });

  it('防线:超尺寸包声明 → 超限 fail 拒绝挂起中的 start', async () => {
    const prof = await DebuggerProfiler.create();
    cleanups.push(() => prof.close());
    const sock = await dial(prof.port);
    sock.write(framed(['set_pid', 7, [1]]));
    await new Promise((r) => setTimeout(r, 50));
    const startP = prof.start(1, 16);
    await new Promise((r) => setTimeout(r, 50));
    const big = Buffer.alloc(4);
    big.writeUInt32LE(0x7fffffff, 0);
    sock.write(big);
    await expect(startP).rejects.toMatchObject({ message: expect.stringContaining('exceeds') });
    sock.destroy();
  });

  it('busy 防重入:capturing 中再 start → profile_busy', async () => {
    const prof = await DebuggerProfiler.create();
    cleanups.push(() => prof.close());
    const sock = await dial(prof.port);
    sock.write(framed(['set_pid', 7, [1]]));
    await new Promise((r) => setTimeout(r, 50));
    const first = prof.start(1, 16);
    await new Promise((r) => setTimeout(r, 50));
    await expect(prof.start(1, 16)).rejects.toMatchObject({ code: 'profile_busy' });
    // 清场:发帧完成首捕获后关连接,first 正常 settle 或随断开拒绝均可
    sock.write(framed(['servers:profile_frame', 7, frameData(1, [[1, 2, 0.001, 0.002]])]));
    sock.write(framed(['servers:profile_frame', 7, frameData(2, [[1, 2, 0.001, 0.002]])]));
    await first.catch(() => {});
    sock.destroy();
  });
});
