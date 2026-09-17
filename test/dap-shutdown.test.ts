/**
 * Task 2.1(2026-09-17 架构审查 H-4)dap 会话纳入 GodotServer.close() 清理链:
 * - closeAllDapSessions():销毁全部 DAP TCP socket + 清 _sessions/_breakpoints 簿记
 * - _resetForTest 复用同一清理循环(去重,测试/生产同语义)
 *
 * 测试策略:同 test/dap.test.ts 的 mock DAP server(node:net 本地 TCP 假 server,
 * 真实 Content-Length 帧编解码)——initialize 建真 session 后调生产清理函数,
 * 断言 status 簿记清空 + mock server 侧连接收到 close(socket.destroy 的对端证据)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { handleTool, _resetForTest, closeAllDapSessions } from '../src/tools/dap.js';

// ─── 精简 mock DAP server(仅 initialize 握手需要)────────────────────────────

function startMockDapServer(): Promise<{ port: number; connClosed: Promise<void>; close: () => Promise<void> }> {
  return new Promise((resolveMock) => {
    let connClosedResolve: () => void = () => {};
    const connClosed = new Promise<void>((r) => { connClosedResolve = r; });
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('close', () => connClosedResolve());
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const header = buffer.subarray(0, headerEnd).toString('utf8');
          const m = /content-length:\s*(\d+)/i.exec(header);
          if (!m) { buffer = Buffer.alloc(0); return; }
          const len = Number(m[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + len) return;
          const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
          buffer = buffer.subarray(bodyStart + len);
          try {
            const req = JSON.parse(body) as Record<string, unknown>;
            const resp = {
              seq: 0, type: 'response', request_seq: req.seq, command: req.command, success: true,
              body: { supportsConfigurationDoneRequest: true, exceptionBreakpointFilters: [] },
            };
            const respBody = Buffer.from(JSON.stringify(resp), 'utf8');
            socket.write(Buffer.concat([
              Buffer.from(`Content-Length: ${respBody.length}\r\n\r\n`, 'utf8'), respBody,
            ]));
          } catch { /* 坏帧忽略 */ }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolveMock({
        port: addr.port,
        connClosed,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await handleTool('dap', args, {} as never);
  const text = result?.content?.map((c) => ('text' in c ? String(c.text) : '')).join('') ?? '';
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; }
}

describe('Task 2.1 (H-4): closeAllDapSessions 生产清理', () => {
  let mock: Awaited<ReturnType<typeof startMockDapServer>>;

  beforeEach(() => { _resetForTest(); });
  afterEach(async () => { _resetForTest(); await mock?.close(); });

  it('销毁全部 session socket 并清 _sessions/_breakpoints 簿记', async () => {
    mock = await startMockDapServer();
    // 建真 session(TCP + initialize 握手)
    const init = await call({ action: 'initialize', port: mock.port, timeout_ms: 2000 });
    expect(init.isError).toBeUndefined();
    let status = await call({ action: 'status' });
    expect(status.session_count).toBe(1);
    // 建断点簿记(本地,无需 DAP 交互)
    await call({ action: 'set_breakpoint', port: mock.port, timeout_ms: 2000, source_path: 'D:/proj/main.gd', line: 10 });
    status = await call({ action: 'status' });
    expect(status.breakpoint_count as number).toBeGreaterThan(0);

    // 生产清理(mock server 侧连接收到 close = socket.destroy 的对端证据)
    closeAllDapSessions();
    await expect(mock.connClosed).resolves.toBeUndefined();

    status = await call({ action: 'status' });
    expect(status.session_count).toBe(0);
    expect(status.breakpoint_count).toBe(0);
  });

  it('空簿记时 no-op(可安全纳入 GodotServer.close() 无会话路径)', () => {
    expect(() => closeAllDapSessions()).not.toThrow();
  });
});
