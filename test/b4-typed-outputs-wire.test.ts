// test/b4-typed-outputs-wire.test.ts — B4 (2026-10-19): typed outputs 试点 wire 层
//
// 真实 SDK + InMemoryTransport(照 qa-tasks-wire.test.ts 先例,仓库无 client 依赖,
// 手写 JSON-RPC 握手)。不 mock SDK——本测试的价值在真实分发层:
// - tools/list 广告侧:试点工具定义携带 outputSchema 透传到客户端
// - tools/call 结果侧:structuredContent 与 content 文本双通道等值
// - legacy 协议版本(2025-06-18)连接下 content 文本仍可解析(旧客户端零回归)
// game 工具 3 个 action 的输出侧增强(find_ui_elements/monitor_poll/watch_poll,无
// 工具级 schema)由 game-bridge.test.ts 的 mock 断言覆盖(需要 bridge 连接,本文件不模拟)。
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { GodotServer } from '../src/GodotServer.js';

// ─── 测试侧最小 JSON-RPC 客户端(手写握手,照 qa-tasks-wire 先例) ─────────────

interface JsonRpcResponse { result?: unknown; error?: { code: number; message: string } }

interface TestClient {
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
}

async function startServer(protocolVersion: string): Promise<{ gs: GodotServer; tc: TestClient }> {
  const gs = new GodotServer('/fake/ops.gd');
  const server = (gs as unknown as { server: Server }).server;
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);

  const pending = new Map<number, (m: unknown) => void>();
  cT.onmessage = (m: unknown) => {
    const msg = m as { id?: number; method?: string };
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        void cT.send({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: `test client has no handler: ${msg.method}` },
        } as never).catch(() => { /* best-effort */ });
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve?.(m);
    }
  };

  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve as (m: unknown) => void);
      void cT.send({ jsonrpc: '2.0', id, method, params } as never);
    });

  const init = await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'b4-wire-test', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  await cT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  return { gs, tc: { request } };
}

/** tools/list 结果里抓单个工具定义 */
async function getToolDef(tc: TestClient, name: string): Promise<Record<string, unknown>> {
  const res = await tc.request('tools/list');
  const tools = (res.result as { tools?: Array<Record<string, unknown>> }).tools ?? [];
  const def = tools.find(t => t.name === name);
  expect(def, `tools/list 应含 ${name}`).toBeTruthy();
  return def!;
}

/** call 工具并断言双通道等值,返回 structuredContent */
async function callAndAssertDualChannel(tc: TestClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await tc.request('tools/call', { name, arguments: args });
  const result = res.result as { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  expect(result?.isError, `${name} 不应报错`).not.toBe(true);
  expect(result?.structuredContent, `${name} 应携带 structuredContent(modern 双通道)`).toBeTruthy();
  const text = result?.content?.[0]?.text;
  expect(typeof text, `${name} content 文本必须存在(MCP 规范)`).toBe('string');
  // 双通道等值:content 文本 == JSON(structuredContent)
  expect(JSON.parse(text!)).toEqual(result!.structuredContent);
  return result!.structuredContent!;
}

describe('B4: typed outputs 试点 wire 层', () => {
  it('modern 协议:tools/list 广告 godot_get_context / godot_list_instances 的 outputSchema', async () => {
    const { gs, tc } = await startServer('2025-11-25');
    try {
      const ctxDef = await getToolDef(tc, 'godot_get_context');
      const schema = ctxDef.outputSchema as Record<string, unknown> | undefined;
      expect(schema, 'godot_get_context 应带 outputSchema').toBeTruthy();
      expect(schema!.type).toBe('object');
      expect((schema!.required as string[]).sort()).toEqual(['data', 'success']);
      const instDef = await getToolDef(tc, 'godot_list_instances');
      const instSchema = instDef.outputSchema as Record<string, unknown> | undefined;
      expect(instSchema, 'godot_list_instances 应带 outputSchema').toBeTruthy();
    } finally {
      await gs.close();
    }
  });

  it('godot_get_context:structuredContent 过声明 schema 的关键字段 + 双通道等值', async () => {
    const { gs, tc } = await startServer('2025-11-25');
    try {
      const sc = await callAndAssertDualChannel(tc, 'godot_get_context', {});
      expect(sc.success).toBe(true);
      const data = sc.data as Record<string, unknown>;
      expect(['ok', 'partial']).toContain(data.status);
      expect(['headless', 'editor', 'bridge', null]).toContain(data.mode);
      expect(Array.isArray(data.failedFields)).toBe(true);
      expect(Array.isArray(data.toolGroups)).toBe(true);
      expect(Array.isArray(data.rules)).toBe(true);
    } finally {
      await gs.close();
    }
  });

  it('legacy 协议版本(2025-06-18)连接:content 文本仍可解析出同结构(旧客户端零回归)', async () => {
    const { gs, tc } = await startServer('2025-06-18');
    try {
      const res = await tc.request('tools/call', { name: 'godot_get_context', arguments: {} });
      const result = res.result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result?.isError).not.toBe(true);
      const parsed = JSON.parse(result!.content![0]!.text) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect((parsed.data as Record<string, unknown>).status).toBeDefined();
    } finally {
      await gs.close();
    }
  });
});
