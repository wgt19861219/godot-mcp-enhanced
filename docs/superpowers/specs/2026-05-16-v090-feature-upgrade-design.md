# v0.9.0 功能升级设计文档

> **版本**: v0.9.0 | **日期**: 2026-05-16 | **状态**: 审核修订中

## 版本说明

当前 package.json 为 0.7.0。v0.8.0 的功能（Editor WebSocket、测试框架、粒子/导航/AnimationTree）已在代码中实现并提交，但 package.json 未同步更新。本版本直接跳到 0.9.0 以反映实际进度，0.8.0 的变更已在 ROADMAP.md 中记录。

## 目标

godot-mcp-enhanced v0.9.0：三线并行（功能补齐 + 质量提升 + 性能优化），工具数 100 → ~123，测试覆盖 0.12:1 → 0.20:1，零新依赖。

## 当前基线

- **工具数**: 100 个，20 个模块，约 13,800 行 TypeScript
- **运行时依赖**: `@modelcontextprotocol/sdk` + `ws`（仅 2 个）
- **已有能力**: Editor WebSocket, Game Bridge, GDScript 代码生成, API 内省
- **测试**: 1,614 行，0.12:1 覆盖率

---

## P0 — 基础设施（性能优化前置）

> 独立于业务功能的基础设施改进，为 P1-P3 的所有工具提供性能收益。

### GDScript 预热池

在 `src/gdscript-executor.ts` 中实现：

- 保持 1 个空闲 headless Godot 进程，复用执行后续 GDScript
- 最大空闲进程数: 1
- 空闲超时: 30 秒自动关闭
- autoload 需求时不复用（需要完整场景加载）
- 预计减少 50%+ 冷启动时间

### API 文档单条目缓存

在 `src/godot-docs.ts` 中实现：

- 首次加载 `extension_api.json` 后将解析结果存入模块级变量
- 后续调用直接返回缓存（因为只有一个 Godot 版本，无需 LRU 淘汰）
- 缓存生命周期 = 进程生命周期

### Godot 路径缓存

在 `src/helpers.ts` 或 `GodotServer.ts` 中实现：

- `findGodot()` 结果缓存到模块级变量
- 进程生命周期内只搜索一次文件系统

---

## P1 — UI/Theme 系统（+8 工具）

### 新建模块: `src/tools/ui-tools.ts`（~650 行）

| 工具 | 职责 |
|------|------|
| `ui_create_control` | 创建 Control 节点（20+ 类型白名单），自动设锚点/尺寸 |
| `ui_set_layout` | 设置锚点/边距/最小尺寸/自定义最小尺寸/增长方向 |
| `ui_set_theme` | 创建/附加/保存 Theme 资源，设置主题属性（字体/颜色/样式盒） |
| `ui_get_layout` | 读取 Control 节点的布局信息（锚点/边距/全局矩形） |
| `ui_anchor_preset` | 一键应用 16 种锚点预设（Full Rect/Center/Left Wide 等） |
| `ui_container_add` | 向 Container 节点添加子节点并设置容器特定属性 |
| `theme_create` | 创建空 Theme 或从节点提取 Theme |
| `theme_set_property` | 批量设置 Theme 的默认字体/颜色/常量/样式盒（按 item_type 分类） |

### Control 类型白名单

Button, Label, Panel, LineEdit, TextEdit, RichTextLabel, LinkButton, HSlider, VSlider, CheckBox, CheckButton, OptionButton, SpinBox, ProgressBar, TextureRect, ColorPickerButton, TabContainer, Tree, ItemList, MarginContainer, HBoxContainer, VBoxContainer, GridContainer, CenterContainer, ScrollContainer, PanelContainer, HSplitContainer, VSplitContainer, NinePatchRect

### 锚点预设

映射 Godot `LayoutPreset` 枚举（0-15），提供名称到值映射：
`top_left, top_right, bottom_left, bottom_right, center_left, center_top, center_right, center_bottom, center, left_wide, top_wide, right_wide, bottom_wide, vcenter_wide, hcenter_wide, full_rect`

### Theme 操作

通过 `theme_set_property` 工具统一操作，按 `item_type` 参数区分：

| item_type | GDScript 调用 | 值类型 |
|-----------|-------------|--------|
| `default_font` | `theme.set_default_font(value)` | Font 资源路径 |
| `color` | `theme.set_color(name, type, Color(r,g,b,a))` | array[4] |
| `constant` | `theme.set_constant(name, type, value)` | number |
| `stylebox` | `theme.set_stylebox(name, type, value)` | StyleBox 资源路径 |

### Headless Theme 可行性

Godot headless 模式可以创建 Theme 资源并调用 `ResourceSaver.save()` 序列化为 .tres 文件。验证点：
- `Theme.new()` 不依赖渲染服务器
- `ResourceSaver.save()` 在 headless 中正常工作（已通过 material-ops.ts 验证同样模式）
- 唯一限制：headless 无法预览 Theme 效果，需要用户在编辑器中查看

### 质量配套 — godot-ops.ts 完整拆分

将 `godot-ops.ts`（1112 行、15 个工具）拆分为 5 个聚焦模块：

| 新模块 | 提取的工具 | 预估行数 |
|--------|-----------|---------|
| `signal-ops.ts` | signal_connect / disconnect / emit / list | ~200 |
| `node-3d-ops.ts` | node_create_3d / collision_overlay | ~200 |
| `physics-ops.ts` | physics_raycast / body_info / diagnose_physics / query_spatial | ~250 |
| `audio-ops.ts` | audio_play / stop / set_param / query | ~300 |
| `navigation.ts`（已有） | nav_query_path（从 godot-ops 迁入） | +50 |
| `godot-ops.ts`（保留） | 仅保留 execute_gdscript + search_classes + get_class_info + get_inheritance + find_method + edit_script + project_replace | ~300 |

**兼容性**：拆分后所有 MCP 工具名和参数签名不变。客户端（Claude/Cursor 等）通过工具名调用，不受内部模块重组影响。`GodotServer.ts` 中更新 `toolModules` 数组注册新模块即可。

---

## P2 — 高级动画编辑（+6 工具）

### 扩展模块: `src/tools/animation-ops.ts` + `src/tools/animtree.ts`

| 工具 | 职责 | 模块 |
|------|------|------|
| `animation` (重构) | 现有 12 action + 新增 create/delete/update_props | animation-ops.ts |
| `animation_track` | 添加/移除/查询轨道（9 种类型） | animation-ops.ts |
| `animation_keyframe` | 添加/移除/更新关键帧（时间/值/过渡曲线） | animation-ops.ts |
| `animation_curve` | 创建/编辑贝塞尔曲线轨道，设置控制点 | animation-ops.ts |
| `animation_blend` | 通过 AnimationPlayer 混合动画（见下方详细说明） | animation-ops.ts |
| `animtree_state_edit` | 编辑 AnimationTree 状态机的状态位置/混合值 | animtree.ts |

### Track 类型枚举

映射 Godot TrackType：value(0), position_3d(1), rotation_3d(2), scale_3d(3), blend_shape(4), method(5), bezier(6), audio(7), animation(8)

### 关键帧操作

- `Animation.add_track(type, at_position)` — 添加轨道
- `Animation.track_insert_key(track_idx, time, value, transition)` — 插入关键帧
- `Animation.track_remove_key(track_idx, key_idx)` — 移除关键帧
- `Animation.track_set_key_transition(track_idx, key_idx, transition)` — 设置过渡曲线
- `Animation.track_set_key_value(track_idx, key_idx, value)` — 更新关键帧值

### 贝塞尔曲线

- `track_set_key_in_handle(track_idx, key_idx, in_handle)` — 入控制点
- `track_set_key_out_handle(track_idx, key_idx, out_handle)` — 出控制点

### animation_blend 详细设计

混合目标为 **AnimationPlayer** 级别（非 AnimationTree 级别），通过 headless GDScript 执行：

```
输入参数:
  - node_path: AnimationPlayer 节点路径
  - animation_name: 目标动画名称
  - blend_time: 混合过渡时间（秒）
  - speed: 播放速度倍率（默认 1.0）

GDScript 实现:
  var player = get_node(node_path) as AnimationPlayer
  player.play(animation_name, blend_time, speed)

行为: 从当前播放位置以 blend_time 为过渡时间切换到目标动画。
      Godot 会自动在两个动画之间做线性插值混合。
```

**不涉及 AnimationNodeBlendTree/BlendSpace2D**——那是 AnimationTree 的领域，已由现有 animtree 工具覆盖。本工具仅操作 AnimationPlayer 的 `play()` 带 `custom_blend` 参数。

---

## P3 — 录制/回放系统（+5 工具）

### 新建模块: `src/tools/recording.ts`（~500 行）

| 工具 | 职责 |
|------|------|
| `recording_start` | 开始录制输入事件（键鼠），通过 Game Bridge 连接 |
| `recording_stop` | 停止录制，返回事件序列 JSON |
| `recording_save` | 将事件序列保存为 JSON 文件 |
| `recording_load` | 加载已保存的录制文件 |
| `recording_play` | 按原始时间间隔回放录制的事件序列 |

### 前置条件

录制（start/stop）和回放（play）强依赖 Game Bridge：
- 目标游戏必须正在运行且已安装 `mcp_bridge.gd` autoload
- 如果 Bridge 未连接，recording_start 和 recording_play 返回 `BRIDGE_NOT_CONNECTED` 错误并附带安装指引
- recording_save 和 recording_load 为纯文件操作，不依赖 Bridge

### 事件序列格式

```json
{
  "version": 1,
  "duration_ms": 5230,
  "events": [
    {"type": "key", "keycode": 87, "pressed": true, "time_ms": 0},
    {"type": "mouse_click", "position": [400, 300], "button": 1, "pressed": true, "time_ms": 1200},
    {"type": "mouse_move", "position": [450, 310], "time_ms": 1250}
  ]
}
```

### 录制实现

- 通过 GDScript 在 Game Bridge 侧注册 `_input()` 回调
- 捕获 `InputEventKey/InputEventMouseButton/InputEventMouseMotion` 事件
- 每个事件记录相对录制开始的毫秒时间戳

### 回放实现

- 通过 `Input.parse_input_event()` 发送事件
- 使用 Timer 按原始时间间隔调度
- 支持速度倍率（0.5x / 1.0x / 2.0x）

**精度限制声明**：回放依赖 Godot Timer 调度，精度受帧率影响（60fps 约 16ms 误差）。不适用于需要亚帧精度（如格斗游戏帧级输入）的场景。对于一般 UI 测试和功能验证足够。

### 持久化与路径安全

- 保存为 JSON 文件到 `res://recordings/` 目录
- 文件名由系统生成：`recording_YYYYMMDD_HHMMSS.json`（不接受用户自定义路径名）
- recording_load 的 file_name 参数仅接受 `recording_*.json` 格式，拒绝包含 `/`、`..`、`\` 的输入
- 内部使用 `resolveWithinRoot()` 校验最终路径在项目目录内

---

## P4 — 编辑器插件扩展 + 质量收尾（+3 同步命令模块）

### 编辑器同步命令模块（3 个）

| 模块文件 | 对应工具 | 命令数 |
|----------|---------|--------|
| `addons/mcp_bridge/commands/ui_commands.gd` | ui_* 8 工具 | 8 |
| `addons/mcp_bridge/commands/animation_commands.gd` | animation_track/keyframe/curve/blend | 4 |
| `addons/mcp_bridge/commands/recording_commands.gd` | recording_start/stop/play | 3 |

同步命令允许编辑器内直接操作，与 headless 工具共享参数格式。

### 质量收尾

| 项目 | 目标 |
|------|------|
| 版本号 | package.json + GodotServer.ts VERSION 变为 0.9.0 |
| 测试覆盖 | 新增约 90-100 测试用例，0.12:1 变为 0.18-0.20:1 |
| 大文件拆分 | godot-ops.ts 1112 → ~300（P1 完成） |
| ROADMAP.md | 添加 v0.9.0 完成记录 |

---

## 架构影响

### 新增文件

```
src/tools/ui-tools.ts         — P1 UI/Theme 工具（约 650 行）
src/tools/recording.ts        — P3 录制/回放工具（约 500 行）
src/tools/signal-ops.ts       — P1 从 godot-ops.ts 拆出（约 200 行）
src/tools/node-3d-ops.ts      — P1 从 godot-ops.ts 拆出（约 200 行）
src/tools/physics-ops.ts      — P1 从 godot-ops.ts 拆出（约 250 行）
src/tools/audio-ops.ts        — P1 从 godot-ops.ts 拆出（约 300 行）
test/ui-tools.test.js         — P1 测试（约 400 行）
test/recording.test.js        — P3 测试（约 350 行）
test/animation-track.test.js  — P2 测试（约 350 行）
addons/mcp_bridge/commands/ui_commands.gd          — P4
addons/mcp_bridge/commands/animation_commands.gd   — P4
addons/mcp_bridge/commands/recording_commands.gd   — P4
```

### 修改文件

```
src/tools/animation-ops.ts    — P2 新增 5 工具
src/tools/animtree.ts         — P2 新增 animtree_state_edit
src/tools/navigation.ts       — P1 迁入 nav_query_path
src/gdscript-executor.ts      — P0 预热池机制
src/godot-docs.ts             — P0 单条目缓存
src/GodotServer.ts            — 注册新模块 + VERSION 更新
src/helpers.ts                — P0 Godot 路径缓存
package.json                  — version 变为 0.9.0
```

### 零新依赖

所有新功能通过 GDScript 代码生成 + headless 执行实现，不引入新的 npm 依赖。

---

## 错误处理

### UI/Theme 错误码

```typescript
const UI_ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
  THEME_NOT_FOUND: 'THEME_NOT_FOUND',
  INVALID_THEME_PROPERTY: 'INVALID_THEME_PROPERTY',
  INVALID_THEME_ITEM_TYPE: 'INVALID_THEME_ITEM_TYPE',
};
```

### 录制/回放错误码

```typescript
const RECORDING_ERROR_CODES = {
  BRIDGE_NOT_CONNECTED: 'BRIDGE_NOT_CONNECTED',
  RECORDING_IN_PROGRESS: 'RECORDING_IN_PROGRESS',
  NO_RECORDING: 'NO_RECORDING',
  RECORDING_FILE_NOT_FOUND: 'RECORDING_FILE_NOT_FOUND',
  INVALID_RECORDING_FORMAT: 'INVALID_RECORDING_FORMAT',
  INVALID_FILE_NAME: 'INVALID_FILE_NAME',
};
```

---

## 测试策略

### 每阶段新增测试

| 阶段 | 新增测试用例 | 新增测试代码行 | 重点场景 |
|------|------------|-------------|---------|
| P1 | ~30 | ~400 | Control 白名单校验、锚点预设、Theme 创建/保存/加载、拆分模块注册 |
| P2 | ~25 | ~350 | Track 添加/删除、关键帧操作、曲线控制点、blend 参数 |
| P3 | ~25 | ~350 | 录制启停、事件序列格式、回放时间间隔、路径安全、文件持久化 |
| P4 | ~15 | ~200 | Editor 命令格式、参数传递、错误处理 |

总计约 95-100 新测试用例，测试代码从 1,614 行增至约 2,900-3,100 行。考虑到源码也同步增长（+约 2,000 行），覆盖率预计从 0.12:1 提升至 0.18-0.20:1。

---

## Godot 版本要求

最低支持 Godot 4.2+。所有新 API（Theme 操作、Animation 轨道操作、InputEvent 回放）在 4.0+ 可用。
