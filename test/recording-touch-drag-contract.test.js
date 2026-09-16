// Task 4 F2: touch_drag 双侧字段契约(三端字段名对齐,防 IMP-11 同类静默错)
// GDScript 侧无法 import TS 常量,用 readFileSync 读源码文本断言字面量 + 从 TS 导入 TOUCH_DRAG_FIELDS 对齐。
// 扩展名 .js 与既有 recording.test.js 一致;ESM import.meta.url 定位项目根。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOUCH_DRAG_FIELDS } from '../src/tools/recording.js';

// 项目根 = 当前测试文件所在 test/ 的上一级;rel 传项目根相对路径如 'src/scripts/mcp_bridge.gd'
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PROJECT_ROOT, rel), 'utf8');

describe('F2 touch_drag 双侧字段契约', () => {
  // Bridge _cmd_send_drag:position 拆 x/y;relative/speed 直读;index 直读;InputEventScreenDrag 载体
  it('bridge _cmd_send_drag 构造 InputEventScreenDrag 并赋全部 TOUCH_DRAG_FIELDS 语义', () => {
    const src = read('src/scripts/mcp_bridge.gd');
    expect(src).toContain('InputEventScreenDrag.new()');
    // position 拆 x/y(对齐 send_touch),relative/speed/index 直读。
    // 2026-09-16 跨项目验证修复:引擎属性是 velocity(Godot 3 的 speed 已改名,赋值
    // event.speed 在 Godot 4 直接 SCRIPT ERROR);JSON 契约键 speed 不变(TOUCH_DRAG_FIELDS)。
    expect(src).toContain('event.relative =');
    expect(src).toContain('event.velocity =');
    expect(src).not.toContain('event.speed =');
    expect(src).toContain('"send_drag"'); // dispatch 入口(L497)
  });

  // editor 插件 _fire_playback_event "touch_drag" 分支:同字段集合
  it('editor _fire_playback_event touch_drag 分支赋全部 TOUCH_DRAG_FIELDS 语义', () => {
    const src = read('addons/godot_mcp_server/commands/recording_commands.gd');
    expect(src).toContain('"touch_drag"'); // match 分支键
    expect(src).toContain('ie.relative =');
    expect(src).toContain('ie.velocity =');
    expect(src).not.toContain('ie.speed =');
  });

  // TS 侧 canonical 集合(三端漂移时此断言先红)
  it('TS TOUCH_DRAG_FIELDS canonical 集合 = [position, index, relative, speed]', () => {
    expect([...TOUCH_DRAG_FIELDS]).toEqual(['position', 'index', 'relative', 'speed']);
  });
});
