// Task 7(设计 §3.3):WebGuiServer SSE 通道——hello 幂等全量/log 增量帧/快照节流 +
// LogReader→Aggregator 日志数据流(srv 过滤) + /api/stats 端点。
// logDir/registryDir 均注入 temp 目录,不污染真实 ~/.godot-mcp/。
// 附:Aggregator 幽灵桶"挤出后再撞同 key"补强(Task 3 review 遗留)。

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGuiServer } from '../../src/web-gui/server.js';
import { Aggregator } from '../../src/dashboard/aggregator.js';
import { getServerId, todayStr } from '../../src/core/logger.js';
import type { LogEntry } from '../../src/core/logger.js';

/** 读取一条 SSE 事件(事件名 + 解析后的 data);超时 fail。 */
function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ event: string; data: any }> {
  let buf = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE read timeout')), 4000);
    const pump = (): void => {
      void reader.read().then(({ done, value }) => {
        if (done) { clearTimeout(timer); reject(new Error('SSE stream ended')); return; }
        buf += new TextDecoder().decode(value);
        const m = buf.match(/event: (\w+)\ndata: ([\s\S]*?)\n\n/);
        if (m) { clearTimeout(timer); resolve({ event: m[1]!, data: JSON.parse(m[2]!) }); }
        else pump();
      }).catch(reject);
    };
    pump();
  });
}

async function connectEvents(base: string, token: string): Promise<{ es: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const es = await fetch(`${base}/events?token=${token}`, { headers: { accept: 'text/event-stream' } });
  expect(es.status).toBe(200);
  expect(es.headers.get('content-type')).toContain('text/event-stream');
  const reader = es.body!.getReader();
  return { es, reader };
}

describe('WebGuiServer SSE + 日志数据流(设计 §3.3)', () => {
  let dir: string; let logDir: string; let registryDir: string; let srv: WebGuiServer | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webgui-sse-'));
    logDir = join(dir, 'logs');
    registryDir = join(dir, 'registry');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(registryDir, { recursive: true });
  });
  afterEach(async () => { if (srv) { await srv.stop(); srv = null; } rmSync(dir, { recursive: true, force: true }); });

  function logFile(): string { return join(logDir, `${todayStr()}.jsonl`); }
  function appendLog(msg: string, srvId = getServerId()): void {
    appendFileSync(logFile(), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'm', msg, srv: srvId }) + '\n');
  }

  it('首连收到 hello 全量(sessions+stats+logs)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir, registryDir });
    await srv.start();
    appendLog('before-connect');
    await new Promise(r => setTimeout(r, 700));   // 等 LogReader 初始回放(500ms 轮询)
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    const hello = await readEvent(reader);
    expect(hello.event).toBe('hello');
    expect(hello.data).toHaveProperty('sessions');
    expect(hello.data).toHaveProperty('stats');
    expect(hello.data.logs.some((e: { msg: string }) => e.msg === 'before-connect')).toBe(true);
    await reader.cancel();
  });

  it('本进程日志 500ms 内推 log 事件;他 srv 条目被过滤', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir, registryDir });
    await srv.start();
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(reader);   // 丢弃 hello
    appendLog('mine-1');
    appendLog('foreign', 'other-server-id');
    const ev = await readEvent(reader);
    expect(ev.event).toBe('log');
    expect(ev.data.entries.some((e: { msg: string }) => e.msg === 'mine-1')).toBe(true);
    expect(ev.data.entries.some((e: { msg: string }) => e.msg === 'foreign')).toBe(false);
    await reader.cancel();
  });

  it('断开重连后再次收到 hello(幂等全量恢复,设计 I-4)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir, registryDir });
    await srv.start();
    const a = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(a.reader);
    await a.reader.cancel();
    const b = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    const hello2 = await readEvent(b.reader);
    expect(hello2.event).toBe('hello');
    await b.reader.cancel();
  });

  it('/api/stats 返回全局+per-project 快照', async () => {
    // 直接写一条完整 tool_end JSONL 行(简报原稿 appendLog(JSON.stringify(...)) 会把
    // tool_end 嵌成普通条目的 msg 字符串,外层无 type 字段,aggregator 不计 calls)。
    // 行必须带 srv: getServerId() 才过 server 侧多进程过滤。
    appendFileSync(logFile(), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'info', module: 'dispatcher',
      msg: 'Tool call completed: t', tool: 't', type: 'tool_end', call_id: 't:1', duration_ms: 5,
      project: 'D:/A', srv: getServerId() }) + '\n');
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir, registryDir });
    await srv.start();
    await new Promise(r => setTimeout(r, 700));
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/stats?token=${srv.token}`);
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.totalCalls).toBe(1);
    expect(stats.projects['D:/A'].totalCalls).toBe(1);
    expect(Array.isArray(stats.toolStats)).toBe(true);
  });

  it('stop 后进程不挂(SSE socket unref,无残留句柄)', async () => {
    srv = new WebGuiServer({ getSessions: () => [], getIndexHtml: () => '<html></html>', portStart: 0, logDir, registryDir });
    await srv.start();
    const { reader } = await connectEvents(`http://127.0.0.1:${srv.port}`, srv.token);
    await readEvent(reader);
    const t0 = Date.now();
    await srv.stop(); srv = null;
    expect(Date.now() - t0).toBeLessThan(2000);   // 活跃连接存在时 stop 仍快速完成
    await reader.cancel().catch(() => {});
  });
});

describe('Aggregator 幽灵桶补强(Task 3 review 遗留:挤出后再撞同 key)', () => {
  function toolEndAt(ts: string): LogEntry {
    return { v: 1, ts, level: 'info', module: 'dispatcher', msg: 'Tool call completed: t',
      tool: 't', type: 'tool_end', call_id: 't:1', duration_ms: 1, project: 'D:/Ghost', srv: getServerId() };
  }

  it('被挤出的旧分钟 key 再被 process 落新桶(calls=1),不并入幽灵旧桶', () => {
    const agg = new Aggregator();
    // 31 个不同 UTC 分钟(00:00..00:30)填满 timeSeries RingBuffer(容量 30)→ "00:00" 被挤出
    for (let i = 0; i < 31; i++) {
      agg.process(toolEndAt(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    }
    // 跨天同分钟("00:00")再撞已被挤出的 key
    agg.process(toolEndAt(new Date(Date.UTC(2026, 0, 2, 0, 0)).toISOString()));
    const st = agg.getStateFor('D:/Ghost');
    const b = st.timeSeries.find(x => x.minute === '00:00');
    expect(b).toBeDefined();                    // 以新桶出现,而非被 getState 清理整桶丢弃
    expect(b!.calls).toBe(1);                   // calls=1,而非并入幽灵旧桶(calls=2)
    expect(st.timeSeries).toHaveLength(30);     // RingBuffer 容量约束仍成立
    // 全局 timeSeries 对称同款(修复同时覆盖全局+per-project 两段)
    const g = agg.getState();
    expect(g.timeSeries.find(x => x.minute === '00:00')!.calls).toBe(1);
  });
});
