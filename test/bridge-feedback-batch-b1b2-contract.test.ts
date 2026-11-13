/**
 * 反馈批次 2026-11-12 Task B1+B2 契约测试(模式同 bridge-feedback-batch-a2a3/a5-contract):
 * - B1(显式端口起点不钳窗): env GODOT_MCP_BRIDGE_PORT 显式指定时候选端口线性向上
 *   (candidate = start_port + i,越界 65535 停)——现状环形取模
 *   `PORT_DEFAULT + ((start_port - PORT_DEFAULT + i) % PORT_ATTEMPTS)` 把任何起点折回
 *   [9081,9090] 十口窗,CI 连跑无法按次错开(2026-11-07 反馈症状①)。crypto 随机起点
 *   保持窗口内取模(默认行为不变,与 instance-manager 分配窗口对齐)。
 *   行为级 e2e 见 test/e2e-bridge-port-linear-b1b2.test.ts(GODOT_PATH 门控,
 *   双实例 9095/9096 直连 TCP 探测)。
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
