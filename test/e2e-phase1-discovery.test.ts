/**
 * Phase 1 在线验证 — 连真实 Godot editor,验证三级 discovery 与 dynamic 工具集成。
 *
 * 单 editor 实例模式(所有测试共用 beforeAll 启动的 editor),避免端口/secret 冲突。
 *
 * 运行方式(需 GUI + Godot 本机):
 *   cd D:/GitHub/godot-mcp-enhanced
 *   GODOT_PATH="D:/godot/Godot_v4.6.3-stable_win64.exe" E2E_EDITOR=1 \
 *   npx vitest run test/e2e-phase1-discovery.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { waitForEditorSecret } from '../src/core/editor-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = existsSync(GODOT_PATH);
const REAL_PROJECT = resolve(__dirname, 'fixtures', 'real-project');
const hasProject =
  existsSync(REAL_PROJECT) &&
  existsSync(resolve(REAL_PROJECT, 'project.godot')) &&
  existsSync(resolve(REAL_PROJECT, 'addons', 'godot_mcp_server', 'plugin.cfg'));
const hasEditorFlag = !!process.env.E2E_EDITOR;
const canRun = hasGodot && hasProject && hasEditorFlag;
const EDITOR_PORT = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);

if (!canRun) {
  const reasons: string[] = [];
  if (!hasGodot) reasons.push(`GODOT_PATH 未设或不存在(当前: ${GODOT_PATH || '<空>'})`);
  if (!hasProject) reasons.push('real-project fixture 不完整');
  if (!hasEditorFlag) reasons.push('E2E_EDITOR=1 未设');
  process.stderr.write(`[E2E-SKIP] 原因: ${reasons.join('; ')}\n`);
}

function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function startEditor(): Promise<ChildProcess> {
  const child = spawn(GODOT_PATH, ['--editor', '--path', REAL_PROJECT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GODOT_MCP_EDITOR_PERSISTENT_SECRET: 'true' },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isPortOpen(EDITOR_PORT, '127.0.0.1')) return child;
    if (child.exitCode !== null) throw new Error(`editor 启动后退出(exitCode=${child.exitCode})`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGKILL');
  throw new Error('editor 30s 内未就绪(WS 9090 未 LISTEN)');
}

// ─── 共享状态(所有测试用同一个 editor + conn)─────────────────────────────
let editor: ChildProcess | null = null;
let conn: EditorConnection | null = null;

beforeAll(async () => {
  if (!canRun) return;
  // 清理旧缓存(容错)
  try { rmSync(resolve(REAL_PROJECT, '.godot'), { recursive: true, force: true }); }
  catch (e) { process.stderr.write(`[E2E-WARN] 清理 .godot 失败: ${(e as Error).message}\n`); }

  // 触发所有工具模块注册(让 getAllToolDefinitions 返回完整工具集)
  const { registerAllModules } = await import('../src/module-loader.js');
  registerAllModules();

  editor = await startEditor();
  // 用 poll 模式等 secret 文件出现(端口 LISTEN 不代表 plugin _ready 生成完 key)
  const secret = await waitForEditorSecret(REAL_PROJECT, 15_000);
  if (!secret) throw new Error('editor 启动后 15s 内 secret 文件未出现');
  conn = new EditorConnection({
    port: EDITOR_PORT, host: '127.0.0.1', secret,
    reconnect: true, reconnectInterval: 300, maxReconnectAttempts: 10,
  });
  // issue #72: 必须 await connect()——它在 performAuth 成功后才 resolve。裸 connect() +
  // 轮询 isConnected() 会在 ws open 后、auth 完成前的窗口放行(EditorConnection.connected
  // 在 performAuth 之前置位),首个 request 收 -32001 Authentication required 且被 peer.close
  // 断连;beforeAll 的 rmSync(.godot) 让 editor 冷启动全量 re-import、auth 往返可超 200ms
  // 轮询间隔,窗口放大 → CI 偶发红。同坑先例:e2e-resilience-editor.test.ts issue #23。
  await conn.connect();
}, 90_000);

afterAll(async () => {
  if (conn) { try { conn.disconnect(); } catch { /* */ } conn = null; }
  if (editor) {
    try { editor.kill('SIGKILL'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 1000));
    editor = null;
  }
}, 30_000);

// ─── 辅助:拉 dynamic 工具(每个测试前刷新)───────────────────────────────
async function refreshDynamicTools(): Promise<void> {
  const { dynamicSchema } = await import('../src/core/dynamic-schema.js');
  const { getAllToolDefinitions } = await import('../src/core/tool-registry.js');
  dynamicSchema.setFetcher(async () => {
    return await conn!.request('list_param_docs', {}) as Record<string, unknown>;
  });
  dynamicSchema.setStaticToolNames(new Set(getAllToolDefinitions().map(t => t.name)));
  dynamicSchema.invalidate();
}

describe.skipIf(!canRun)('e2e Phase 1: 三级 discovery 与 editor dynamic 工具集成', () => {
  it('editor 连接成功 + list_param_docs 返回 dynamic 命令', async () => {
    expect(conn!.isConnected()).toBe(true);
    const docs = await conn!.request('list_param_docs', {});
    expect(docs).toBeTruthy();
    const methodCount = Object.keys(docs as Record<string, unknown>).length;
    console.log('[Phase1-E2E] list_param_docs 返回方法数:', methodCount);
    console.log('[Phase1-E2E] 方法名样本:', Object.keys(docs as Record<string, unknown>).slice(0, 10));
    expect(methodCount).toBeGreaterThan(0);
  }, 30_000);

  it('godot_list_dynamic_routes 无参返回 categories + 向后兼容字段', async () => {
    await refreshDynamicTools();
    const { dynamicSchema } = await import('../src/core/dynamic-schema.js');
    const dynamicTools = await dynamicSchema.getDynamicTools();
    console.log('[Phase1-E2E] dynamicSchema 拉取工具数:', dynamicTools.length);
    if (dynamicTools.length > 0) {
      console.log('[Phase1-E2E] dynamic 工具样本:', dynamicTools.slice(0, 8).map(t => t.name));
    }

    const { handleTool } = await import('../src/tools/advanced-proxy.js');
    const result = await handleTool('godot_list_dynamic_routes', {}, {} as never);
    const text = (result!.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);

    console.log('[Phase1-E2E] 无参 totalTools:', parsed.totalTools, '/ total_dynamic:', parsed.total_dynamic);
    console.log('[Phase1-E2E] categories:', JSON.stringify(parsed.categories));
    console.log('[Phase1-E2E] 体积:', Buffer.byteLength(text), 'B');

    // 向后兼容字段
    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.registered)).toBe(true);
    expect(typeof parsed.total_registered).toBe('number');
    expect(typeof parsed.dynamic_routing_enabled).toBe('boolean');
    // 新字段
    expect(parsed.totalTools).toBeDefined();
    expect(parsed.categories).toBeDefined();
    expect(parsed.hint).toBeDefined();
  }, 30_000);

  it('search/category/tool 三级对 dynamic 工具生效', async () => {
    await refreshDynamicTools();
    const { dynamicSchema } = await import('../src/core/dynamic-schema.js');
    const dynamicTools = await dynamicSchema.getDynamicTools();
    const { handleTool } = await import('../src/tools/advanced-proxy.js');

    if (dynamicTools.length === 0) {
      console.log('[Phase1-E2E] 无 dynamic 工具,用静态工具验证三级');
      // fallback:用静态工具测(如 scene)
      const r3 = await handleTool('godot_list_dynamic_routes', { tool: 'scene' }, {} as never);
      const p3 = JSON.parse((r3!.content[0] as { text: string }).text);
      console.log('[Phase1-E2E] Level 3 静态 tool=scene:', p3.name, '→', p3.category);
      expect(p3.name).toBe('scene');
      expect(p3.inputSchema).toBeDefined();
      return;
    }

    // 选第一个 dynamic 工具
    const sample = dynamicTools[0]!;
    const stripped = sample.name.replace(/^godot_/, '');
    const parts = stripped.split('_');
    const sampleCat = parts.length >= 2 ? parts[0]! : 'core';
    console.log('[Phase1-E2E] 样本 dynamic 工具:', sample.name, '→ category:', sampleCat);

    // Level 3:tool=name
    const r3 = await handleTool('godot_list_dynamic_routes', { tool: sample.name }, {} as never);
    const p3 = JSON.parse((r3!.content[0] as { text: string }).text);
    console.log('[Phase1-E2E] Level 3 tool:', p3.name, '→', p3.category);
    expect(p3.name).toBe(sample.name);
    expect(p3.inputSchema).toBeDefined();

    // Level 2a:search
    const r2a = await handleTool('godot_list_dynamic_routes', { search: sampleCat }, {} as never);
    const p2a = JSON.parse((r2a!.content[0] as { text: string }).text);
    console.log('[Phase1-E2E] Level 2a search:', sampleCat, '→ totalMatches:', p2a.totalMatches);
    expect(p2a.totalMatches).toBeGreaterThanOrEqual(1);

    // Level 2b:category(非 core 才测)
    if (sampleCat !== 'core') {
      const r2b = await handleTool('godot_list_dynamic_routes', { category: sampleCat }, {} as never);
      const p2b = JSON.parse((r2b!.content[0] as { text: string }).text);
      console.log('[Phase1-E2E] Level 2b category:', sampleCat, '→ count:', p2b.count);
      expect(p2b.category).toBe(sampleCat);
      expect(p2b.count).toBeGreaterThanOrEqual(1);
    }
  }, 30_000);
});
