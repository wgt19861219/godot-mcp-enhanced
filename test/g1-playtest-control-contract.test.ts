import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// G1 playtest control 层(2026-08-14 批 D 审查修复)契约测试。
// 验证 src/scripts/mcp_bridge.gd 源码签约:D-1 unfreeze 清 pending、D-2 paused 保存-还原、
// D-3 playtest owner 互斥、D-4 _playtest_active 复位、D-5 wall_budget clamp 50s、D-6 step frozen 守卫。
//
// ⚠️ 局限(对齐 cmp-14-debug-phase2 范式的过渡手段):本测试是源码字符串断言,验证"修复模式
// 落位"而非运行时行为。运行时行为由 bridge 实测(见 task-D-report.md)覆盖。字符串断言
// 不能防语义级回归(如还原值被后续覆盖),只能锚定关键模式存在/消失。

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

// 函数级 slice:从 func 声明取到下一个顶层锚点(防跨函数误匹配)
function sliceBetween(startAnchor: string, endAnchor: string): string {
  const start = gd.indexOf(startAnchor);
  expect(start, `锚点未找到: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf(endAnchor, start);
  expect(end, `结束锚点未找到: ${endAnchor}`).toBeGreaterThan(start);
  return gd.slice(start, end);
}

describe('D-1 [P1]: unfreeze 清 step_until pending(防 refreeze 复活致永久暂停)', () => {
  const unfreezeSlice = () => sliceBetween('func _cmd_control_unfreeze', 'func _cmd_control_step_until');

  it('D-1a: unfreeze 段含 _control_step_until_pending.clear()', () => {
    expect(unfreezeSlice().includes('_control_step_until_pending.clear()'), 'unfreeze 缺 pending.clear()').toBe(true);
  });

  it('D-1b [负向]: unfreeze 段不再含旧"硬设 paused=false"(D-1+D-2 共同负向)', () => {
    expect(unfreezeSlice().includes('get_tree().paused = false'), 'unfreeze 仍硬设 paused=false').toBe(false);
  });
});

describe('D-2 [P2]: freeze 系列保存-还原游戏自身 paused(三处还原点)', () => {
  const freezeSlice = () => sliceBetween('func _cmd_control_freeze', 'func _cmd_control_unfreeze');
  const cleanupSlice = () => sliceBetween('func _cleanup_peer_state', 'func _extract_ui_data');
  const stepUntilSlice = () => sliceBetween('func _cmd_control_step_until', 'func _compare_values');

  it('D-2a: 全局区声明 _control_paused_saved + _control_paused_saved_valid', () => {
    expect(gd.includes('var _control_paused_saved: bool = false'), '缺 _control_paused_saved 声明').toBe(true);
    expect(gd.includes('var _control_paused_saved_valid: bool = false'), '缺 _control_paused_saved_valid 声明').toBe(true);
  });

  it('D-2b: freeze 在置 true 前保存原值(saved_valid 防重复 freeze 覆盖)', () => {
    const s = freezeSlice();
    expect(s.includes('_control_paused_saved = get_tree().paused'), 'freeze 缺原值保存').toBe(true);
    // 保存必须先于 paused=true(顺序锚定:保存 index < 置 true index)
    expect(s.indexOf('_control_paused_saved = get_tree().paused'), '保存应在置 true 之前').toBeLessThan(
      s.indexOf('get_tree().paused = true')
    );
  });

  it('D-2c: 还原点1 unfreeze 恢复原值 + 清 saved', () => {
    const s = sliceBetween('func _cmd_control_unfreeze', 'func _cmd_control_step_until');
    expect(s.includes('get_tree().paused = _control_paused_saved'), 'unfreeze 缺原值还原').toBe(true);
    expect(s.includes('_control_paused_saved_valid = false'), 'unfreeze 缺 saved_valid 清除').toBe(true);
  });

  it('D-2c2 [Nit-A]: unfreeze 还原受 saved_valid 守卫(无有效保存不覆盖 paused)', () => {
    // Nit-A (2026-08-14 审查补修):(a) 从未 freeze 直接 unfreeze;(b) 非 refreeze
    // step_until 完成已清 S/V 后 owner 空转持有。两种边缘下无条件还原会把游戏自暂停
    // 清成过期 false。还原必须在 if _control_paused_saved_valid: 守卫内(2 Tab 缩进)。
    const s = sliceBetween('func _cmd_control_unfreeze', 'func _cmd_control_step_until');
    expect(
      s.includes('if _control_paused_saved_valid:\n\t\tget_tree().paused = _control_paused_saved'),
      'unfreeze 还原缺 saved_valid 守卫(嵌套 2 Tab)'
    ).toBe(true);
    // 负向:守卫后的还原不再以函数体 1 Tab 裸露(旧无条件还原模式)
    expect(
      s.includes('\n\tget_tree().paused = _control_paused_saved'),
      'unfreeze 仍存在无条件 1 Tab 还原(Nit-A 未修)'
    ).toBe(false);
  });

  it('D-2d: 还原点2 step_until 完成分支恢复原值(非 refreeze 且 pending 清空)', () => {
    // 完成逻辑在 _process 的 step_until 轮询段(非独立 func),用全文锚定:
    // elif 分支 = 最后一个开窗 entry 完成时还原,且带 not _control_frozen 防护
    // H1 (2026-08-20): input_seq pending 同为开窗者,还原条件扩为两数组皆空
    expect(
      gd.includes('elif _control_step_until_pending.is_empty() and _control_input_seq_pending.is_empty() and not _control_frozen:'),
      'step_until 完成段缺 elif 还原分支'
    ).toBe(true);
    expect(gd.includes('get_tree().paused = _control_paused_saved'), '完成段缺原值还原').toBe(true);
  });

  it('D-2e: 还原点3 owner 断线(_cleanup_peer_state)恢复原值 [负向: 不再硬设 false]', () => {
    const s = cleanupSlice();
    expect(s.includes('get_tree().paused = _control_paused_saved'), '断线清理缺原值还原').toBe(true);
    expect(s.includes('get_tree().paused = false'), '断线清理仍硬设 paused=false').toBe(false);
  });

  it('D-2f: step_until 开窗前保存原值(非 refreeze 周期覆盖游戏自身 paused=true 场景)', () => {
    const s = stepUntilSlice();
    expect(s.includes('_control_paused_saved = get_tree().paused'), '开窗前缺原值保存').toBe(true);
    // 保存必须先于开窗硬设 false
    expect(s.indexOf('_control_paused_saved = get_tree().paused'), '保存应在开窗之前').toBeLessThan(
      s.indexOf('get_tree().paused = false')
    );
  });

  it('D-2g [负向]: 全文件 get_tree().paused = false 仅剩开窗 2 处(step_until/input_sequence 各一;原 3 处:unfreeze/开窗/断线)', () => {
    const count = gd.split('get_tree().paused = false').length - 1;
    expect(count, `硬设 false 应仅剩开窗 2 处,实际 ${count} 处`).toBe(2);
  });
});

describe('D-3 [P2]: playtest snapshot/restore owner 登记 + seed/fixed_delta owner 互斥', () => {
  const seedSlice = () => sliceBetween('func _cmd_playtest_seed', 'func _cmd_playtest_fixed_delta');
  const fixedDeltaSlice = () => sliceBetween('func _cmd_playtest_fixed_delta', 'const PLAYTEST_SNAPSHOT_HARD_STOP');
  const snapshotSlice = () => sliceBetween('func _cmd_playtest_snapshot', 'func _collect_node_snapshot');
  const restoreSlice = () => sliceBetween('func _cmd_playtest_restore', 'func _cmd_playtest_step');

  it('D-3a: snapshot 签名带 pid + owner==-1 时登记(断线清理可达)', () => {
    const s = snapshotSlice();
    expect(s.includes('func _cmd_playtest_snapshot(params: Dictionary, pid: int)'), 'snapshot 签名缺 pid').toBe(true);
    expect(s.includes('if _playtest_owner_pid == -1:'), 'snapshot 缺 owner 登记分支').toBe(true);
    expect(s.includes('_playtest_owner_pid = pid'), 'snapshot 缺 owner 登记').toBe(true);
  });

  it('D-3b: snapshot/restore dispatch 已传 pid', () => {
    expect(gd.includes('_cmd_playtest_snapshot(params, pid)'), 'dispatch 未传 pid(snapshot)').toBe(true);
    expect(gd.includes('_cmd_playtest_restore(params, pid)'), 'dispatch 未传 pid(restore)').toBe(true);
  });

  it('D-3c: seed 加 owner 互斥 [负向: 校验先于 seed() 副作用]', () => {
    const s = seedSlice();
    expect(s.includes('playtest session held by another session'), 'seed 缺 owner 互斥').toBe(true);
    expect(
      s.indexOf('playtest session held by another session'),
      'owner 校验应先于 seed() 副作用'
    ).toBeLessThan(s.indexOf('seed(seed_value)'));
  });

  it('D-3d: fixed_delta 加 owner 互斥 [负向: 校验先于 Engine 三连副作用]', () => {
    const s = fixedDeltaSlice();
    expect(s.includes('playtest session held by another session'), 'fixed_delta 缺 owner 互斥').toBe(true);
    expect(
      s.indexOf('playtest session held by another session'),
      'owner 校验应先于 Engine 副作用'
    ).toBeLessThan(s.indexOf('Engine.physics_ticks_per_second = hz'));
  });

  it('D-3e: restore 加 owner 互斥 [负向: 校验先于写场景循环]', () => {
    const s = restoreSlice();
    expect(s.includes('playtest session held by another session'), 'restore 缺 owner 互斥').toBe(true);
    expect(
      s.indexOf('playtest session held by another session'),
      'owner 校验应先于 restore 写循环'
    ).toBeLessThan(s.indexOf('node.set(prop_name, val)'));
  });
});

describe('D-4 [P2]: _playtest_active 复位移出 fixed_delta 分支 + restore 复位', () => {
  const cleanupSlice = () => sliceBetween('func _cleanup_peer_state', 'func _extract_ui_data');
  const restoreSlice = () => sliceBetween('func _cmd_playtest_restore', 'func _cmd_playtest_step');

  it('D-4a: _cleanup_peer_state 复位移出 fixed_delta 分支(owner if 内 2 Tab,与 snapshot if 同级)', () => {
    const s = cleanupSlice();
    expect(s.includes('\n\t\t_playtest_active = false'), '复位应在 owner if 内 2 Tab(fixed_delta if 外)').toBe(true);
  });

  it('D-4b [负向]: 不再有 3 Tab 深度复位(旧位置:fixed_delta if 分支内)', () => {
    expect(
      cleanupSlice().includes('\n\t\t\t_playtest_active = false'),
      '复位仍嵌在 fixed_delta 分支内(3 Tab)'
    ).toBe(false);
  });

  it('D-4c: restore 完成时复位 [负向: 复位先于 success 返回]', () => {
    const s = restoreSlice();
    expect(s.includes('_playtest_active = false'), 'restore 缺复位').toBe(true);
    expect(
      s.indexOf('_playtest_active = false'),
      '复位应在 success 返回之前'
    ).toBeLessThan(s.indexOf('"success": true, "restored"'));
  });
});

describe('D-5 [P3]: step_until wall_budget 上限压 50s(防 60s idle 断连同界)', () => {
  const stepUntilSlice = () => sliceBetween('func _cmd_control_step_until', 'func _compare_values');

  it('D-5a: wall_budget clamp 到 50000(60s idle 断连留 10s 余量)', () => {
    expect(
      stepUntilSlice().includes('clampi(wall_budget_ms, 1000, 50000)'),
      '缺 clampi(wall_budget_ms, 1000, 50000)'
    ).toBe(true);
  });

  it('D-5b [负向]: 不再有 60000 上限校验(拒绝式旧模式)', () => {
    const s = stepUntilSlice();
    expect(s.includes('> 60000'), '仍有 60000 拒绝校验').toBe(false);
    expect(s.includes('1000-60000'), '仍有 1000-60000 文案').toBe(false);
  });
});

describe('D-6 [P3]: freeze 期间 playtest.step 守卫(防假成功)', () => {
  const stepSlice = () => sliceBetween('func _cmd_playtest_step', '# ─── G1 (2026-08-13) control-first');

  it('D-6a: step 入口含 frozen 守卫 + 明确报错文案', () => {
    const s = stepSlice();
    expect(s.includes('if _control_frozen:'), 'step 入口缺 _control_frozen 守卫').toBe(true);
    expect(s.includes('game is frozen; unfreeze before stepping'), '缺明确报错文案').toBe(true);
  });

  it('D-6b [负向]: 守卫先于 frames 解析与哨兵返回(防校验后置)', () => {
    const s = stepSlice();
    expect(
      s.indexOf('if _control_frozen:'),
      'frozen 守卫应先于 frames 解析'
    ).toBeLessThan(s.indexOf('var frames'));
    expect(
      s.indexOf('if _control_frozen:'),
      'frozen 守卫应先于哨兵返回'
    ).toBeLessThan(s.indexOf('"__deferred__": "playtest_step"'));  // O1 收敛(批5):原 __playtest_step__ 锚
  });
});
