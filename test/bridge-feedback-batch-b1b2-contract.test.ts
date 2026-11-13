/**
 * 反馈批次 2026-11-12 Task B1+B2 契约测试(模式同 bridge-feedback-batch-a2a3/a5-contract):
 * - B1(显式端口起点不钳窗): env GODOT_MCP_BRIDGE_PORT 显式指定时候选端口线性向上
 *   (candidate = start_port + i,越界 65535 停)——现状环形取模
 *   `PORT_DEFAULT + ((start_port - PORT_DEFAULT + i) % PORT_ATTEMPTS)` 把任何起点折回
 *   [9081,9090] 十口窗,CI 连跑无法按次错开(2026-11-07 反馈症状①)。crypto 随机起点
 *   保持窗口内取模(默认行为不变,与 instance-manager 分配窗口对齐)。
 *   行为级 e2e 见 test/e2e-bridge-port-linear-b1b2.test.ts(GODOT_PATH 门控,
 *   双实例 9095/9096 直连 TCP 探测)。
 * - B2(GODOT_MCP_BRIDGE_DISABLE env): _ready 顶部守卫——env 非空且非 "0"/"false" →
 *   print 一行提示 + return(不起监听不写 secret 不写 registry),CI/连跑场景
 *   headless --quit 也免留 secret(2026-11-07 反馈症状②)。DISABLE 优先级最高
 *   (先于 EXPORT-1 导出守卫;命名对齐 GODOT_MCP_BRIDGE_* 前缀,buildSafeEnv 天然透传)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function funcSlice(name: string, endAnchor?: string): string {
  const start = gd.indexOf(`func ${name}`);
  expect(start, `${name} 须存在`).toBeGreaterThanOrEqual(0);
  const end = endAnchor ? gd.indexOf(endAnchor, start) : gd.indexOf('\nfunc ', start + 10);
  expect(end, `${name} 的结束锚点未找到`).toBeGreaterThan(start);
  return gd.slice(start, end === -1 ? undefined : end);
}

describe('B1: 显式端口起点线性避让(env 起点不钳回 9081-9090 窗)', () => {
  const bindFn = () => funcSlice('_bind_available_port', 'func _port_in_use');

  it('env 显式起点分支存在线性形态(candidate = start_port + i,无 % PORT_ATTEMPTS 取模)', () => {
    const s = bindFn();
    expect(s.includes('candidate = start_port + i'), 'env 分支须为线性 candidate = start_port + i').toBe(true);
    // env 分支(env_explicit 判定到 else 之间)不得再做环形取模——那是把起点钳回窗口的根因
    const envBranch = s.slice(s.indexOf('if env_explicit:'), s.indexOf('else:', s.indexOf('if env_explicit:')));
    expect(envBranch.length, 'env 线性分支结构未找到').toBeGreaterThan(0);
    expect(envBranch.includes('% PORT_ATTEMPTS'), 'env 分支不得取模钳窗(修复前根因)').toBe(false);
  });

  it('env 分支 65535 越界停(线性向上不回绕)', () => {
    const s = bindFn();
    const envBranch = s.slice(s.indexOf('if env_explicit:'), s.indexOf('else:', s.indexOf('if env_explicit:')));
    expect(envBranch.includes('candidate > 65535'), '缺 65535 越界判断').toBe(true);
    expect(envBranch.includes('break'), '越界须 break 停止(不得回绕)').toBe(true);
  });

  it('crypto 随机起点默认分支保持窗口内取模(默认行为不变,与 instance-manager 窗口对齐)', () => {
    const s = bindFn();
    // 环形取模表达式须保留在默认(非 env)分支——随机起点+线性递增会漂到窗口外,
    // 与 TS instance-manager 的 9081-9090 扫描窗口不对称(审查Nit-A)
    expect(s.includes('PORT_DEFAULT + ((start_port - PORT_DEFAULT + i) % PORT_ATTEMPTS)'),
      '默认分支的环形取模须保留(随机起点仍钳窗内)').toBe(true);
  });

  it('env 显式性判定:clampi 分支置 env_explicit 标记(在随机化分支之前)', () => {
    const s = bindFn();
    const clampIdx = s.indexOf('clampi(int(env_port)');
    expect(clampIdx, '缺 clampi env 起点分支').toBeGreaterThanOrEqual(0);
    expect(s.indexOf('env_explicit = true'), 'env 分支须置显式标记').toBeGreaterThan(clampIdx);
    expect(clampIdx, 'env 分支应在随机化分支之前(既有契约)').toBeLessThan(s.indexOf('elif _crypto != null:'));
  });
});

describe('B2: GODOT_MCP_BRIDGE_DISABLE 顶部禁用守卫', () => {
  const readyFn = () => funcSlice('_ready', 'func _exit_tree');

  it('_ready 顶部读 GODOT_MCP_BRIDGE_DISABLE(非空且非 0/false → print + return)', () => {
    const s = readyFn();
    expect(s.includes('OS.get_environment("GODOT_MCP_BRIDGE_DISABLE")'), '缺 DISABLE env 读取').toBe(true);
    // 假值白名单:"0"/"false"(大小写不敏感)视为未禁用
    expect(s.includes('"0"'), '须容忍 "0"').toBe(true);
    expect(s.includes('"false"'), '须容忍 "false"').toBe(true);
    // 禁用时须 print 一行提示 + return(不起监听不写 secret)
    expect(s.includes('print("[MCP Bridge]'), '禁用须 print 提示').toBe(true);
  });

  it('DISABLE 优先级最高:先于 EXPORT-1 导出守卫与 editor hint 判定(_ready 内首个守卫)', () => {
    const s = readyFn();
    const disableIdx = s.indexOf('GODOT_MCP_BRIDGE_DISABLE');
    expect(disableIdx, 'DISABLE 守卫须存在').toBeGreaterThanOrEqual(0);
    // 先于 editor hint 与 EXPORT-1 导出守卫
    expect(disableIdx, 'DISABLE 须在 Engine.is_editor_hint 之前').toBeLessThan(s.indexOf('Engine.is_editor_hint'));
    expect(disableIdx, 'DISABLE 须在 EXPORT-1 导出守卫(has_feature)之前').toBeLessThan(s.indexOf('OS.has_feature'));
    // 禁用 return 须在 _start_server 之前(不起监听)
    const returnIdx = s.indexOf('return', disableIdx);
    expect(returnIdx, 'DISABLE 分支须 return').toBeGreaterThan(-1);
    expect(returnIdx, 'DISABLE return 须先于 _start_server').toBeLessThan(s.indexOf('_start_server()'));
  });

  it('DISABLE 后不得触达 secret/registry(守卫段内无 server/secret/registry 写入)', () => {
    const s = readyFn();
    const disableIdx = s.indexOf('GODOT_MCP_BRIDGE_DISABLE');
    const nextReturn = s.indexOf('return', disableIdx);
    // 守卫段(DISABLE 读点到其 return)内不得有 server/secret/registry 写入
    const guardSeg = s.slice(disableIdx, nextReturn);
    expect(guardSeg.includes('_start_server'), '守卫段内不得起监听').toBe(false);
    expect(guardSeg.includes('_write_secret'), '守卫段内不得写 secret').toBe(false);
    expect(guardSeg.includes('_start_registry_heartbeat'), '守卫段内不得写 registry').toBe(false);
  });
});
