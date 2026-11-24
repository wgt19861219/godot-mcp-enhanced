/**
 * 反馈批 2026-11-22 Task 4 契约级锁定(源码字面量契约,范式同 bridge-feedback-batch-d-contract):
 * - 实例归属:TS 侧 run_project spawn 注入 GODOT_MCP_BRIDGE_OWNER_PID(= MCP server pid),
 *   GD 侧 _owner_pid() 读取,心跳条目与 ping 响应带 ownerPid(>0 才写键)——TS 侧
 *   resolveBridgePort 据此偏好本 server 起的实例,annotatePingOwner 对他人实例告警。
 * - ⚠️ 局限:源码字符串断言验证"落位"而非运行时行为;TS 侧行为由
 *   test/game-bridge-registry.test.ts(A1/A3)与 test/game-bridge-validation.test.ts
 *   (annotatePingOwner)覆盖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function funcSlice(name: string): string {
  const start = gd.indexOf(`func ${name}`);
  expect(start, `${name} 须存在`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf('\nfunc ', start + 10);
  return gd.slice(start, end === -1 ? undefined : end);
}

describe('反馈批 20261122 Task 4: bridge 归属 ownerPid', () => {
  it('_write_registry_entry: 读 GODOT_MCP_BRIDGE_OWNER_PID,>0 才写 ownerPid 键', () => {
    const s = funcSlice('_write_registry_entry');
    expect(s).toContain('_owner_pid()');
    expect(s).toContain('"ownerPid"');
    expect(s).toMatch(/if owner_pid > 0:/);
  });
  it('_cmd_ping: 响应带 ownerPid(同样 >0 才写)', () => {
    const s = funcSlice('_cmd_ping');
    expect(s).toContain('"ownerPid"');
    expect(s).toContain('_owner_pid()');
  });
  it('_owner_pid: 读 GODOT_MCP_BRIDGE_OWNER_PID', () => {
    expect(funcSlice('_owner_pid')).toContain('OS.get_environment("GODOT_MCP_BRIDGE_OWNER_PID")');
  });
});

describe('反馈批 20261122 Task 6: get_viewport_info DPI 诊断字段', () => {
  it('响应含 content_scale_factor/window_size/scale_hint,get_window() 判空降级', () => {
    const s = funcSlice('_cmd_get_viewport_info');
    expect(s).toContain('"content_scale_factor"');
    expect(s).toContain('"window_size"');
    expect(s).toContain('"scale_hint"');
    expect(s).toContain('if win == null:');
  });
});
