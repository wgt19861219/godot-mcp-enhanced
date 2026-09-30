// test/web-gui/daemon-core.test.ts
// daemon 批 A(2026-09-30 spec §3.3):Task 2——GodotServer transport 参数化用例。
// Task 3(WebGuiServer strictPort/instanceKind/mcpHandler)后续在本文件追加。
//
// 注:字段名用 processMode 而非 plan 原文的 mode——ServerOptions.mode 已是工具档位
// 字符串(GodotServer 构造 ToolDispatcher 时消费),同名重复声明 union 类型属 TS2717
// 编译错误,详见 src/GodotServer.ts ServerOptions 注释。
import { describe, it, expect, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/server';
import { GodotServer } from '../../src/GodotServer.js';

describe('GodotServer transport 参数化(daemon 批 A)', () => {
  it('connectTransport 接受外部 transport 并 connect', async () => {
    const server = new GodotServer('res://ops.gd', { processMode: 'daemon' });
    const fake = { start: vi.fn(), send: vi.fn(), close: vi.fn() };
    await server.connectTransport(fake as unknown as Transport);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it('connectTransport 不碰 process.stdin(daemon 纪律:注入点不注册 stdin-end 钩子)', async () => {
    const server = new GodotServer('res://ops.gd', { processMode: 'daemon' });
    const fake = { start: vi.fn(), send: vi.fn(), close: vi.fn() };
    const before = process.stdin.listenerCount('end');
    await server.connectTransport(fake as unknown as Transport);
    // daemon/stdio 的 stdin 钩子差异在入口层(index.ts,stdio 注册/daemon 不注册,Task 5);
    // 注入点本身必须 stdin 无感——否则 daemon 传 HTTP transport 也会被 stdio 自杀钩子拖死。
    expect(process.stdin.listenerCount('end')).toBe(before);
  });

  it('processMode 缺省 stdio:ServerOptions 向后兼容(不传 processMode 不抛)', () => {
    expect(() => new GodotServer('res://ops.gd', {})).not.toThrow();
  });
});
