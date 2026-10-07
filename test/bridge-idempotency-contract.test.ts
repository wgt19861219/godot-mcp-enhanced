/**
 * 批次2(2026-10-04)幂等层 GD 源码契约测试(审查 I-2 修复)。
 *
 * 背景:幂等逻辑的 TS 侧行为测试 mock 了 bridge 协议边界,而 GD 侧(去重表/延迟通道排除)
 * 无真跑 Godot 的行为覆盖——审查 B-1(call_method await_completion 落在幂等缝隙)正是
 * "两端各自正确、拼起来错"的缝。本文件按 p4-batch/p7-unit 的源码契约先例锁关键结构:
 * 延迟通道 return 必须先于幂等缓存写入(B-1 类缝隙的机械防线)、TS 侧 await 变体排除、
 * 协议字段两端拼写一致。
 *
 * 刻意独立成文件:game-bridge.test.ts 有 vi.mock('net'/'fs')(Linux fork 影子化约束,
 * 全仓仅允许一个 net mock 文件),本文件读源码文本需真 fs。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GD = readFileSync(resolve(__dirname, '../src/scripts/mcp_bridge.gd'), 'utf-8');
const TS = readFileSync(resolve(__dirname, '../src/core/bridge-client.ts'), 'utf-8');
const TOOL = readFileSync(resolve(__dirname, '../src/tools/game-bridge.ts'), 'utf-8');

describe('批次2 幂等层 GD 源码契约(审查 I-2/B-1)', () => {
  it('B-1 结构锁:延迟通道 return "__DEFERRED__" 必须先于幂等缓存写入(顺序倒置=缝隙)', () => {
    const deferredReturnIdx = GD.indexOf('return "__DEFERRED__"');
    const cacheWriteIdx = GD.indexOf('if request_id != "":\n\t\t_cache_idempotent_response(request_id');
    expect(deferredReturnIdx).toBeGreaterThan(-1);
    expect(cacheWriteIdx).toBeGreaterThan(-1);
    expect(deferredReturnIdx, '延迟通道须在写缓存前 return——倒置会让 await 类延迟命令入缓存(结构错位)').toBeLessThan(cacheWriteIdx);
  });

  it('GD 幂等核心构件齐备:requestId 读取/命中查询/TTL+LRU 常量/能力声明', () => {
    expect(GD).toContain('var request_id := str(msg.get("requestId", ""))');
    expect(GD).toContain('if request_id != "" and _idempotency_cache.has(request_id):');
    expect(GD).toContain('const IDEMPOTENCY_CACHE_MAX := 256');
    expect(GD).toContain('const IDEMPOTENCY_TTL_MS := 120000');
    expect(GD).toContain('"idempotent-v1"');
    // 命中响应用当前请求 id 组装(JSON-RPC id 每次重试会变)且带命中标记
    expect(GD).toContain('hit_result["idempotentHit"] = true');
    expect(GD).toContain('return JSON.stringify({"id": id, "result": hit_result})');
  });

  it('B-1 修复锁:TS 侧 call_method await_completion 变体排除在幂等键之外', () => {
    expect(TOOL).toContain("const isAwaitCallMethod = method === 'call_method' && params.await_completion === true;");
    expect(TOOL).toContain("const idemKey = action === 'game_write' && !isAwaitCallMethod");
  });

  it('协议字段两端拼写一致:requestId 顶层字段 + idempotent-v1 能力串', () => {
    // TS 写顶层(bridge-client sendToBridge)↔ GD 读 msg.get("requestId")
    expect(TS).toContain("JSON.stringify({ id, method, params, ...(opts?.requestId !== undefined ? { requestId: opts.requestId } : {}) })");
    expect(TOOL).toContain("includes('idempotent-v1')");
  });

  it('指纹算法措辞与实现一致(GD HashingContext,防旧 API 名残留回潮)', () => {
    expect(GD).toContain('hctx.start(HashingContext.HASH_SHA256)');
    expect(GD).toContain('_script_fingerprint = hctx.finish().hex_encode()');
    // PackedByteArray 无 sha256() 方法(4.6.3 探针实证)——实现中不得出现该调用形态
    expect(GD).not.toContain('.sha256().hex_encode()');
  });
});
