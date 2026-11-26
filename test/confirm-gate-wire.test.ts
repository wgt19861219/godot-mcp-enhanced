// test/confirm-gate-wire.test.ts — M-1(2026-11-26 MCP 安全与协议审查):确认门「用户拒绝」的 wire 层回归
//
// 真实 SDK + InMemoryTransport(照 qa-tasks-wire / b4-typed-outputs-wire 先例;仓库无 client 依赖,
// 手写 JSON-RPC 握手并应答 server→client 的 elicitation/create)。不 mock SDK——缺陷恰在 SDK 响应
// 视图与 dispatcher 的交互:acceptedContent() 对 decline / cancel / accept-无内容一律返回
// undefined,dispatcher 把 undefined 当「第一轮(尚无响应)」再次返回 inputRequired,legacy shim
// 再发一轮 elicitation,直到 inputRequired.maxRounds(修复前实测 8 轮),token 始终不消费。
// 既有 ToolDispatcher.test.ts 的 T11 是 mock 级:「decline」用例实际构造的是 accept+confirm:false。
//
// 服务端 LATEST_PROTOCOL_VERSION 为 2025-11-25,所有连接都走 legacy shim(push 式
// elicitation/create),故按两个 legacy 版本参数化;夹具落仓库内 test-output/(自建自清)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GodotServer } from '../src/GodotServer.js';
import { resetState as resetTokenState } from '../src/core/guard.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ─── 测试侧最小 JSON-RPC 客户端(手写握手,替代 SDK Client) ───────────────────

type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
type ElicitPolicy = () => ElicitResult;
const DECLINE: ElicitPolicy = () => ({ action: 'decline' });
const CANCEL: ElicitPolicy = () => ({ action: 'cancel' });
/** 客户端 accept 却没带 content:按协议属异常应答,服务端不得据此放行。 */
const ACCEPT_NO_CONTENT: ElicitPolicy = () => ({ action: 'accept' });
/** 用户按提示在输入框键入 yes:唯一被接受的确认值(字符串——Claude Code 2.1.332 的表单里布尔字段设不上值)。 */
const ACCEPT_CONFIRM: ElicitPolicy = () => ({ action: 'accept', content: { confirm: 'yes' } });
/** 以下都不是有效确认:大小写不符 / 旧版布尔值 / 明确说 no。 */
const ACCEPT_YES_UPPER: ElicitPolicy = () => ({ action: 'accept', content: { confirm: 'Yes' } });
const ACCEPT_LEGACY_BOOL: ElicitPolicy = () => ({ action: 'accept', content: { confirm: true } });
const ACCEPT_NO: ElicitPolicy = () => ({ action: 'accept', content: { confirm: 'no' } });

interface JsonRpcResponse { result?: unknown; error?: { code: number; message: string } }
interface ElicitRequestSeen { message: string; requestedSchema: unknown }
interface Wire {
  gs: GodotServer;
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** 服务端→客户端 elicitation/create 请求 = 用户实际看到的确认弹窗 */
  elicits: ElicitRequestSeen[];
}

async function startWire(protocolVersion: string, policy: ElicitPolicy): Promise<Wire> {
  const gs = new GodotServer('/fake/ops.gd');
  const server = (gs as unknown as { server: Server }).server;
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);

  const pending = new Map<number, (m: unknown) => void>();
  const elicits: ElicitRequestSeen[] = [];
  cT.onmessage = (m: unknown) => {
    const msg = m as { id?: number; method?: string; params?: { message?: string; requestedSchema?: unknown } };
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.method === 'elicitation/create') {
        elicits.push({ message: String(msg.params?.message ?? ''), requestedSchema: msg.params?.requestedSchema });
        void cT.send({ jsonrpc: '2.0', id: msg.id, result: policy() } as never).catch(() => { /* best-effort */ });
        return;
      }
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
    capabilities: { elicitation: {} },
    clientInfo: { name: 'confirm-gate-wire-test', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  await cT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  return { gs, request, elicits };
}

type CallToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
const resultText = (res: JsonRpcResponse): string =>
  (res.result as CallToolResult)?.content?.map((c) => c.text).join('\n') ?? '';

/** 调 script.write_script(写类 action,过确认门)拿 confirmation_token */
async function requestToken(wire: Wire, projectPath: string, file: string): Promise<string> {
  const res = await wire.request('tools/call', {
    name: 'script',
    arguments: { action: 'write_script', project_path: projectPath, script_path: `res://${file}`, content: 'extends Node\n# confirm-gate-wire\n' },
  });
  const text = resultText(res);
  expect((res.result as CallToolResult)?.isError, `令牌请求不应报错: ${text}`).not.toBe(true);
  expect(text, '令牌请求应声明 requires_confirmation').toContain('"requires_confirmation":true');
  const payload = text.split('\n_duration_ms')[0] ?? '';
  const token = (JSON.parse(payload) as { confirmation_token?: unknown }).confirmation_token;
  expect(typeof token, '令牌请求应返回 confirmation_token').toBe('string');
  return token as string;
}

const confirm = (wire: Wire, token: string) =>
  wire.request('tools/call', { name: 'confirm_and_execute', arguments: { token } });

const LEGACY_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25'];

describe.each(LEGACY_PROTOCOL_VERSIONS)('confirm_and_execute 确认门 wire 层(协议 %s,legacy shim)', (protocolVersion) => {
  let scratch: string;
  let projectPath: string;
  let wires: GodotServer[];

  beforeEach(() => {
    // 开发者 shell 的确认旁路会泄漏进 vitest 进程(本机用户级环境变量即如此)——不清则确认门整段被跳过
    vi.stubEnv('GODOT_MCP_ALLOW_UNSAFE_CONFIRM', '');
    vi.stubEnv('GODOT_MCP_AUDIT', '');
    // 夹具落仓库内(已 gitignore),自建自清;不写系统临时目录。
    // test-output/ 未入库——全新克隆里不存在,而 mkdtempSync 不建父目录,须先 mkdir
    // (先例:scripts/check-changelog-sync.test.ts);漏建则 CI 上整文件 ENOENT。
    mkdirSync(join(REPO_ROOT, 'test-output'), { recursive: true });
    scratch = mkdtempSync(join(REPO_ROOT, 'test-output', 'confirm-gate-wire-'));
    projectPath = join(scratch, 'proj');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="confirm-gate-wire"\n', { flag: 'wx' });
    wires = [];
  });

  afterEach(async () => {
    for (const gs of wires) await gs.close();
    // guard(token) 是进程级单例:GodotServer.close() 会置 _shutdown,不 reset 则下个用例签不出 token
    resetTokenState();
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  async function start(policy: ElicitPolicy): Promise<Wire> {
    const wire = await startWire(protocolVersion, policy);
    wires.push(wire.gs);
    return wire;
  }

  it.each([
    ['decline', DECLINE],
    ['cancel', CANCEL],
    ['accept 但未带 content', ACCEPT_NO_CONTENT],
    ['accept 但 confirm 为 "Yes"(大小写不符)', ACCEPT_YES_UPPER],
    ['accept 但 confirm 为旧版布尔值 true', ACCEPT_LEGACY_BOOL],
    ['accept 但 confirm 为 "no"', ACCEPT_NO],
  ] as Array<[string, ElicitPolicy]>)('用户 %s:只弹一次窗、返回 ELICITATION_DENIED、目标脚本不落盘', async (_label, policy) => {
    const wire = await start(policy);
    const token = await requestToken(wire, projectPath, 'probe.gd');
    wire.elicits.length = 0;

    const res = await confirm(wire, token);

    // 确认值是字符串字段:布尔必填在 Claude Code 2.1.332 的表单里设不上值,确认永远无法提交
    const schema = wire.elicits[0].requestedSchema as { properties?: { confirm?: { type?: string } }; required?: string[] };
    expect(schema.properties?.confirm?.type).toBe('string');
    expect(schema.required).toEqual(['confirm']);

    expect(wire.elicits.length, '用户拒绝后不得再次发起确认').toBe(1);
    expect((res.result as CallToolResult)?.isError).toBe(true);
    expect(resultText(res)).toContain('ELICITATION_DENIED');
    expect(existsSync(join(projectPath, 'probe.gd')), '被拒绝的操作不得落盘').toBe(false);
  });

  it('用户 accept + confirm:"yes"(对照组):弹一次窗后执行、脚本落盘', async () => {
    const wire = await start(ACCEPT_CONFIRM);
    const token = await requestToken(wire, projectPath, 'probe.gd');
    wire.elicits.length = 0;

    const res = await confirm(wire, token);

    expect(wire.elicits.length).toBe(1);
    expect(wire.elicits[0].message).toContain('键入 yes');
    expect((res.result as CallToolResult)?.isError).not.toBe(true);
    expect(existsSync(join(projectPath, 'probe.gd'))).toBe(true);
  });

  it('decline 后同一 token 重调:INVALID_TOKEN,不再发起确认', async () => {
    const wire = await start(DECLINE);
    const token = await requestToken(wire, projectPath, 'probe.gd');
    await confirm(wire, token);
    wire.elicits.length = 0;

    const res = await confirm(wire, token);

    expect(wire.elicits.length, '已消费的 token 不得再触发确认弹窗').toBe(0);
    expect((res.result as CallToolResult)?.isError).toBe(true);
    expect(resultText(res)).toContain('INVALID_TOKEN');
    expect(existsSync(join(projectPath, 'probe.gd'))).toBe(false);
  });

  it('5 个并发 confirm 同一 token 全部 decline:每个请求只弹一次窗(共 5 次)、全部被拒、脚本不落盘', async () => {
    const wire = await start(DECLINE);
    const token = await requestToken(wire, projectPath, 'probe.gd');
    wire.elicits.length = 0;

    const results = await Promise.all(Array.from({ length: 5 }, () => confirm(wire, token)));

    // 并发请求都在第一轮让出点前完成 peek,故各弹一次;修复前每个请求各走满 8 轮(共 40 次)
    expect(wire.elicits.length).toBe(5);
    for (const res of results) {
      expect((res.result as CallToolResult)?.isError).toBe(true);
      expect(resultText(res)).not.toContain('maxRounds');
    }
    expect(existsSync(join(projectPath, 'probe.gd'))).toBe(false);
  });
});
