import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// P2-4 GD 侧契约测试(审查 I-3):mcp_bridge.gd 是 bridge 运行时(TCP,游戏进程),
// headless SceneTree 测不了 _process/_handle_message 的 TCP 路由。改用源码字面量断言
// 防 B-1 类漂移(BLOCKED_PROPERTIES 多副本撕裂)+ 命令存在性。参 headless-whitelist.test.ts 模式。
const GD = readFileSync(join(__dirname, '..', '..', 'src', 'scripts', 'mcp_bridge.gd'), 'utf-8');
// 2026-08-06 审查 P1：BLOCKED_PROPERTIES 有 3 份 GDScript 副本 + 1 TS Set，任一漏 instance 即重开
// ExtResource 注入 RCE。原测试只守 mcp_bridge.gd，现扩 command_helpers.gd + godot_operations.gd。
const CMD_HELPERS_GD = readFileSync(join(__dirname, '..', '..', 'addons', 'godot_mcp_server', 'commands', 'command_helpers.gd'), 'utf-8');
const GODOT_OPS_GD = readFileSync(join(__dirname, '..', '..', 'src', 'scripts', 'godot_operations.gd'), 'utf-8');

describe('P2-4 mcp_bridge.gd playtest 契约(审查 I-3)', () => {
  describe('B-1 守护:BLOCKED_PROPERTIES 必须含 instance(防 ExtResource 注入 RCE)', () => {
    it('BLOCKED_PROPERTIES 数组含 "instance"', () => {
      const m = GD.match(/const BLOCKED_PROPERTIES[\s\S]{0,500}?\]/);
      expect(m, 'BLOCKED_PROPERTIES block found').toBeTruthy();
      expect(m![0]).toMatch(/"instance"/);
    });

    it('snapshot 序列化器跳过 BLOCKED_PROPERTIES(_collect_node_snapshot)', () => {
      // _collect_node_snapshot 必须用同一个 BLOCKED_PROPERTIES 常量(不新抄)
      // 2026-08-06 上限 600→900：P1 加了 HARD_STOP 节点数守卫后函数体变长
      // 2026-08-07 上限 900→1300：批次1 P1 加了 Resource 反向转换 + _is_safe_value 守卫后函数体进一步变长
      const m = GD.match(/func _collect_node_snapshot[\s\S]{0,1300}?for child in/);
      expect(m, '_collect_node_snapshot found').toBeTruthy();
      expect(m![0]).toMatch(/in BLOCKED_PROPERTIES/);
    });

    it('restore 跳过 BLOCKED_PROPERTIES(_cmd_playtest_restore)', () => {
      // 到下一个 func 定义为边界(避免非贪婪到首个 return 截断)
      const m = GD.match(/func _cmd_playtest_restore[\s\S]*?\nfunc /);
      expect(m, '_cmd_playtest_restore found').toBeTruthy();
      expect(m![0]).toMatch(/in BLOCKED_PROPERTIES/);
    });
  });

  // 2026-08-06 审查 P1：三副本 BLOCKED_PROPERTIES 都必须含 instance（B-1 漂移守护扩展）
  describe('B-1 三副本守护:BLOCKED_PROPERTIES 含 instance（扩展防漂移）', () => {
    it('command_helpers.gd BLOCKED_PROPERTIES 含 "instance"', () => {
      const m = CMD_HELPERS_GD.match(/const BLOCKED_PROPERTIES[\s\S]{0,800}?\]/);
      expect(m, 'command_helpers.gd BLOCKED_PROPERTIES block found').toBeTruthy();
      expect(m![0]).toMatch(/"instance"/);
    });

    it('godot_operations.gd BLOCKED_PROPERTIES 含 "instance"', () => {
      const m = GODOT_OPS_GD.match(/const BLOCKED_PROPERTIES[\s\S]{0,800}?\]/);
      expect(m, 'godot_operations.gd BLOCKED_PROPERTIES block found').toBeTruthy();
      expect(m![0]).toMatch(/"instance"/);
    });

    it('command_helpers.gd coerce_property_value 含 instance 双保险分支', () => {
      // B-1 修复：command_helpers.gd:189 `prop in BLOCKED_PROPERTIES or prop == "instance"`
      expect(CMD_HELPERS_GD).toMatch(/prop in BLOCKED_PROPERTIES or prop == "instance"/);
    });

    it('三副本 BLOCKED_PROPERTIES 关键属性字面量一致（script/owner/name/instance）', () => {
      // 提取三副本的 BLOCKED_PROPERTIES 数组内容，校验关键属性都在
      const extractBlocked = (src: string): string[] => {
        const m = src.match(/const BLOCKED_PROPERTIES[\s\S]{0,800}?\]/);
        if (!m) return [];
        const props = m[0].match(/"([a-z_]+)"/g) ?? [];
        return props.map(p => p.replace(/"/g, ''));
      };
      const required = ['script', 'owner', 'name', 'instance'];
      for (const prop of required) {
        expect(extractBlocked(GD), `mcp_bridge.gd 含 ${prop}`).toContain(prop);
        expect(extractBlocked(CMD_HELPERS_GD), `command_helpers.gd 含 ${prop}`).toContain(prop);
        expect(extractBlocked(GODOT_OPS_GD), `godot_operations.gd 含 ${prop}`).toContain(prop);
      }
    });
  });

  describe('5 个 playtest 命令存在 + match 分发', () => {
    it('match 分发含 5 个 playtest.method', () => {
      expect(GD).toMatch(/"playtest\.seed":/);
      expect(GD).toMatch(/"playtest\.fixed_delta":/);
      expect(GD).toMatch(/"playtest\.snapshot":/);
      expect(GD).toMatch(/"playtest\.restore":/);
      expect(GD).toMatch(/"playtest\.step":/);
    });

    it('5 个 _cmd_playtest_* 函数定义存在', () => {
      expect(GD).toMatch(/func _cmd_playtest_seed\(/);
      expect(GD).toMatch(/func _cmd_playtest_fixed_delta\(/);
      expect(GD).toMatch(/func _cmd_playtest_snapshot\(/);
      expect(GD).toMatch(/func _cmd_playtest_restore\(/);
      expect(GD).toMatch(/func _cmd_playtest_step\(/);
    });
  });

  describe('I-2 守护:step 走 _process 计数器(非 coroutine),frames=1 边界', () => {
    it('step 哨兵格式正确(O1 收敛:统一 __deferred__ kind=playtest_step)', () => {
      // O1 收敛(2026-09-18 批5):原 "__PLAYTEST_STEP__%d__" 把帧数编码进字符串,收敛为统一
      // "__DEFERRED__" 哨兵,frames/report/profile 平铺进 payload(语义守恒见 e2e-gd-symmetry 守恒用例)
      expect(GD).toMatch(/"__deferred__": "playtest_step"/);
      expect(GD).toMatch(/"__DEFERRED__"/);
    });

    it('_process 末尾有 pending 处理 + _added_this_frame 边界守卫(I-2 修复)', () => {
      // I-2 修复:刚加入的 entry 本帧不递减,避免 frames=1 在同一 tick 完成(physics 未推进)
      expect(GD).toMatch(/_playtest_step_pending/);
      expect(GD).toMatch(/_added_this_frame/);
    });
  });

  describe('fixed_delta 安全:不碰 time_scale,restore 还原原值', () => {
    it('fixed_delta 改 physics_ticks_per_second + max_physics_steps_per_frame + jitter_fix 三连', () => {
      // 到下一个 func 定义为边界
      const m = GD.match(/func _cmd_playtest_fixed_delta[\s\S]*?\nfunc /);
      expect(m, '_cmd_playtest_fixed_delta found').toBeTruthy();
      expect(m![0]).toMatch(/Engine\.physics_ticks_per_second/);
      expect(m![0]).toMatch(/Engine\.max_physics_steps_per_frame/);
      expect(m![0]).toMatch(/Engine\.physics_jitter_fix/);
      // 反向:不碰 time_scale(避破坏 keepalive/recording Timer)
      expect(m![0]).not.toMatch(/Engine\.time_scale/);
    });

    it('restore 还原 fixed_delta 原值(_playtest_fixed_delta_saved)', () => {
      expect(GD).toMatch(/_playtest_fixed_delta_saved/);
    });
  });

  describe('_input 录制污染防护(_playtest_active 早 return)', () => {
    it('_input 在 recording 检查后有 _playtest_active 早 return', () => {
      const m = GD.match(/func _input\(event: InputEvent\)[\s\S]{0,200}?if _playtest_active/);
      expect(m, '_input playtest guard found').toBeTruthy();
    });
  });
});
