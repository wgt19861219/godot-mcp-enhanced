# MCP 工具反馈修复设计

> 日期：2026-05-15
> 状态：终版
> 前置：v0.8.0 用户反馈（validate_scripts 误报 + 4 个新工具需求）

## 1. 范围

5 个改动，按模块分布：

| # | 优先级 | 改动 | 文件 |
|---|--------|------|------|
| 1 | P1 | validate_scripts 误报修复 | `src/tools/validation.ts` |
| 2 | P1 | quick_scene 新工具 | `src/tools/scene.ts` |
| 3 | P1 | batch_create_files 新工具 | `src/tools/batch-tools.ts`（新建） |
| 4 | P1 | batch_run_verify 新工具 | `src/tools/batch-tools.ts` |
| 5 | P2 | diff_scenes 新工具 | `src/tools/batch-tools.ts` |

## 2. validate_scripts 误报修复

### 2.1 问题

headless 模式下 Godot 解析器无法解析 Node/Node2D/Control 继承链的方法签名，导致 `add_child()`、`get_tree()`、`_process()` 等合法调用被报为 `not found in base self`。

当前 `isErrorFalsePositive` 只过滤 `ScriptBus` 相关错误。

### 2.2 修复方案

扩展 `isErrorFalsePositive` 函数，增加三条过滤规则：

**规则 1：已知基类方法/属性**
```
const KNOWN_BASE_METHODS: Set<string> = new Set([
  // Node 核心
  'add_child', 'remove_child', 'get_child', 'get_children', 'get_child_count',
  'get_parent', 'get_tree', 'get_node', 'find_child', 'find_children',
  'has_node', 'is_inside_tree', 'is_node_ready', 'queue_free', 'free',
  'call_deferred', 'set_deferred', 'emit_signal', 'connect', 'disconnect',
  'is_connected', 'get_name', 'set_name',
  // 生命周期
  '_ready', '_process', '_physics_process', '_input', '_unhandled_input',
  '_unhandled_key_input', '_enter_tree', '_exit_tree',
  // Node2D / Control
  'position', 'rotation', 'scale', 'visible', 'modulate', 'z_index',
  'get_global_mouse_position', 'get_viewport', 'get_viewport_rect',
  'set_process', 'set_physics_process', 'set_process_input',
  // CanvasItem 绘制
  'draw_rect', 'draw_circle', 'draw_string', 'draw_line', 'queue_redraw',
  'get_canvas_item', 'get_global_transform',
  // CharacterBody
  'move_and_slide', 'move_and_collide', 'velocity', 'floor',
  'is_on_floor', 'is_on_wall', 'is_on_ceiling',
  // PhysicsBody / RigidBody
  'linear_velocity', 'angular_velocity', 'mass', 'bounce', 'friction',
  'gravity_scale', 'apply_impulse', 'apply_force',
  // Navigation
  'get_rid', 'get_region',
  // Shader / Material
  'set_shader_parameter', 'canvas_item',
  // Timer
  'wait_time', 'autostart', 'one_shot',
  // Resource / Object
  'get_path', 'resource_path', 'get_resource', 'duplicate',
]);
```
当错误行包含 `not found in base self` 且匹配到上述方法名时，过滤该错误。

**规则 2：虚拟方法签名不匹配**
```
/Parse Error.*\b(_ready|_process|_physics_process|_input|_enter_tree|_exit_tree)\b.*signature/
```
虚拟方法在子类重写时签名"不匹配"是误报。

**规则 3：属性默认值类型**
`not found in base self` 后跟 `.position`、`.visible` 等属性赋值也是误报（headless 无法解析属性继承）。

### 2.3 结果增强

返回结构中增加 `filtered_count` 字段，报告过滤的误报数量。**`validate_scripts` 和 `batch_validate` 两个工具的返回格式都要更新**：
```json
{
  "total_errors": 2,
  "filtered_count": 8,
  "scripts": [...]
}
```
`batch_validate` 同样输出 `filtered_count`，保持一致。

## 3. quick_scene

### 3.1 功能

一行命令创建"带脚本引用的场景"。参数：

```typescript
{
  project_path: string;
  scene_path: string;            // res://scenes/player.tscn
  script_path?: string;          // res://scripts/player.gd
  root_node_type?: string;       // 默认 Node2D
  root_node_name?: string;       // 默认从 scene_path 文件名推导
  script_content?: string;       // 可选，脚本不存在时自动创建
}
```

### 3.2 行为

1. 推导根节点名：PascalCase 转换（`tween_demo.tscn` → `TweenDemo`，`player.tscn` → `Player`）。规则：去掉扩展名，按 `_` 分割，每段首字母大写后拼接
2. 生成 .tscn：如果提供 script_path，添加 `[ext_resource]` 和 `script` 属性
3. 如果提供 script_content 且 .gd 不存在 → 同时创建脚本文件
4. 目录不存在时 mkdirSync 递归创建

### 3.3 生成的 .tscn 格式

```ini
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1"]

[node name="Player" type="Node2D"]
script = ExtResource("1")
```

无 script_path 时省略 ext_resource 和 script 行。

## 4. batch_create_files

### 4.1 功能

批量创建多个文件。参数：

```typescript
{
  project_path: string;
  files: Array<{
    path: string;           // 相对路径 (res://scripts/player.gd)
    content: string;
    overwrite?: boolean;    // 默认 false
  }>;
  validate?: boolean;       // 创建后验证 .gd 文件，默认 true
}
```

### 4.2 行为

1. 按数组顺序逐一创建文件，目录自动创建
2. overwrite=false 时已存在的文件跳过
3. validate=true 时创建完成后调 batchValidateScripts 验证 .gd 文件
4. 返回 `{ created, skipped, failed, validation_errors? }`

## 5. batch_run_verify

### 5.1 功能

对多个场景逐一运行 headless 验证，返回汇总报告。参数：

```typescript
{
  project_path: string;
  scenes: string[];
  timeout?: number;          // 每个场景秒数，默认 10
  capture_tree?: boolean;    // 默认 false
}
```

### 5.2 行为

1. 对每个 scene 复用 run_and_verify 的 spawn + analyze 逻辑
2. 汇总：`{ passed, failed, timed_out, results: [...] }`
3. 单个场景失败不阻断后续
4. 串行执行（Godot headless 不能并行共享同一项目）

## 6. diff_scenes（P2）

### 6.1 功能

对比两个场景文件的节点树差异。参数：

```typescript
{
  project_path: string;
  scene_a: string;
  scene_b: string;
  ignore_properties?: string[];  // 默认 ['metadata/_edit_lock']
}
```

### 6.2 行为

1. 分别 parseTscn 解析两个 .tscn
2. 按节点路径匹配，生成三类差异：
   - `added`：B 有 A 没有
   - `removed`：A 有 B 没有
   - `modified`：节点存在但属性/类型不同，列出具体 diff
3. 返回 `{ summary, added, removed, modified }` + 纯文本摘要

## 7. 文件分布

```
src/tools/validation.ts   — 修改 isErrorFalsePositive + 增加 filtered_count（两个工具都更新）
src/tools/scene.ts        — 新增 quick_scene 工具
src/tools/batch-tools.ts  — 新建，包含 batch_create_files + batch_run_verify + diff_scenes
src/GodotServer.ts        — 导入 batch-tools 模块
src/tscn-parser.ts        — diff_scenes 复用 parseTscn（已有）
```
