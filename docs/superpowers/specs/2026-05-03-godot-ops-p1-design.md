# P1 音频管理 + TileMap 编辑 — 设计文档

**日期:** 2026-05-03
**状态:** v1
**范围:** 音频播放控制、TileMap 完整编辑
**前置:** P0 运行时操作工具（v0.5.0, commit 2bbf228）

---

## 1. 背景

P0 交付了 8 个运行时操作工具（信号、物理、3D、导航），v0.5.0 工具总数 43。
P1 填补两个高频缺失能力域：音频播放控制和 TileMap 地图编辑。

## 2. 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| A: 全部扩展现有 godot-ops.ts | 音频+TileMap 都塞进 godot-ops | 单文件膨胀过大 |
| B: 两个新独立模块 | audio-ops.ts + tilemap-ops.ts | 音频仅 4 工具，独立模块不划算 |
| **C: 混合** | **音频合入 godot-ops.ts，TileMap 独立为 tilemap-ops.ts** | **已选** |

交付策略：方案 C
音频 4 工具体量小，复用 godot-ops 已有基础设施；TileMap 8 工具逻辑复杂（双节点类型兼容），独立模块便于维护。

## 3. 实现级约束

### P1-A1：自动检测音频节点类型

`audio_play`/`audio_stop`/`audio_set_param`/`audio_query` 统一接受 `node_path` 参数，
GDScript 内自动检测节点类型：
- `AudioStreamPlayer` — 全局音频
- `AudioStreamPlayer2D` — 2D 位置音频
- `AudioStreamPlayer3D` — 3D 位置音频

非以上类型返回 `AUDIO_NOT_FOUND` 错误。

### P1-A2：音频参数安全校验

- `volume_db`: number，范围 [-80, 24]，超出截断并警告
- `pitch_scale`: number，范围 [0.01, 100]，超出截断并警告
- `bus`: string，经 `gdEscape` 转义
- `stream_path`: 以 `res://` 开头的资源路径，经 `gdEscape` 转义

### P1-T1：TileMap / TileMapLayer 双节点兼容

所有 TileMap 工具自动检测节点类型：
- `TileMap`（旧版）：支持多图层，`layer` 参数可选（默认 0）
- `TileMapLayer`（4.3+ 新版）：单图层，忽略 `layer` 参数

GDScript 内用 `if node is TileMap` / `elif node is TileMapLayer` 分支。

### P1-T2：坐标系和区域校验

- `coords`: `{x: int, y: int}`，校验为整数
- `region` (Rect2i): `{x: int, y: int, w: int, h: int}`，w/h 必须 > 0
- `atlas_coords`: `{x: int, y: int}`，校验为非负整数

### P1-T3：图案数据序列化

`tilemap_copy` 返回的 pattern 数据为 JSON 数组：
```json
{
  "cells": [
    {"coords": [0,0], "source_id": 1, "atlas_coords": [2,3], "alternative_tile": 0},
    {"coords": [1,0], "source_id": 1, "atlas_coords": [3,3], "alternative_tile": 0}
  ],
  "size": {"w": 2, "h": 1}
}
```

`tilemap_paste` 接受此 JSON 作为 `pattern` 参数。

### 复用已有约束

- P0-1 结构化向量对象（TileMap 中 coords 用 Vector2i）
- P0-2 统一 NodePath 解析
- P0-3 GDScript 字符串安全转义
- P1-3 统一返回格式 `{success, data, error, error_code, warnings}`

### 新增错误码

- `AUDIO_NOT_FOUND` — 节点非 AudioStreamPlayer 类型
- `TILEMAP_NOT_FOUND` — 节点非 TileMap/TileMapLayer 类型
- `INVALID_TILE_COORDS` — 坐标非整数或缺失
- `INVALID_REGION` — Rect2i 参数无效（w/h<=0）
- `TILE_SOURCE_NOT_FOUND` — source_id 不存在于 TileSet

## 4. 工具清单

### 4.1 音频播放控制（4 个工具，合入 godot-ops.ts）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `audio_play` | node_path (NodePath), stream_path? (string res://), volume_db? (number), pitch_scale? (number), bus? (string), from_position? (number) | 检测节点类型 → 可选加载 stream → 设置参数 → `node.play()` |
| `audio_stop` | node_path (NodePath) | `node.stop()` |
| `audio_set_param` | node_path (NodePath), param (enum: volume_db/pitch_scale/bus), value (number/string) | 按 param 类型设置对应属性 |
| `audio_query` | node_path (NodePath) | 返回 playing, stream_resource, volume_db, pitch_scale, bus, playback_position, stream_length |

### 4.2 TileMap 编辑（8 个工具，独立 tilemap-ops.ts）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `tilemap_read` | node_path (NodePath), layer? (int), region? (Rect2i) | 遍历区域内 cells，返回 coords→tile 映射数组 |
| `tilemap_set_cell` | node_path (NodePath), coords (Vector2i), source_id (int), atlas_coords (Vector2i), alternative_tile? (int 默认0) | `set_cell()` / `set_cell_atlas_coords()` |
| `tilemap_erase_cell` | node_path (NodePath), coords (Vector2i), layer? (int) | `erase_cell()` |
| `tilemap_fill_rect` | node_path (NodePath), region (Rect2i), source_id (int), atlas_coords (Vector2i), alternative_tile? (int) | 遍历 region 内所有 cell 调用 set_cell |
| `tilemap_clear` | node_path (NodePath), layer? (int) | `clear()` |
| `tilemap_copy` | node_path (NodePath), source_region (Rect2i), layer? (int) | 读取区域内所有 cell 数据，序列化为 pattern JSON |
| `tilemap_paste` | node_path (NodePath), target (Vector2i), pattern (object), layer? (int) | 遍历 pattern.cells，按 target 偏移 set_cell |
| `tilemap_set_transform` | node_path (NodePath), coords (Vector2i), flip_h? (bool), flip_v? (bool), transpose? (bool), layer? (int) | `set_cell()` 带 flip_h/flip_v/transpose |

**关键限制（同 P0）：** 运行时操作，headless 中执行不持久化。description 中明确说明。
持久化修改应走 `edit_script` 或 `add_node` + `save_scene`。

## 5. 架构

```
src/tools/godot-ops.ts (扩展)
├── 已有: TOOL_NAMES, getToolDefinitions, handleTool, gen*Script (P0 8个)
├── 新增 TOOL_NAMES: audio_play, audio_stop, audio_set_param, audio_query
├── getToolDefinitions(): 新增 4 个音频工具定义
├── handleTool(): switch 新增 4 个 case
└── 新增 GDScript 生成函数:
    ├── genAudioPlayScript()
    ├── genAudioStopScript()
    ├── genAudioSetParamScript()
    └── genAudioQueryScript()

src/tools/tilemap-ops.ts (新建, ~500 行)
├── TOOL_NAMES (8 个常量)
├── ERROR_CODES (TileMap 专用)
├── getToolDefinitions(): Tool[]
│   └── 8 个工具定义（inputSchema）
├── handleTool(): Promise<ToolResult | null>
│   └── switch 8 cases
│       └── 每个: 提取参数 → 校验 → 生成 GDScript → executeGdscript() → 返回
└── GDScript 生成辅助函数
    ├── genTilemapReadScript()
    ├── genTilemapSetCellScript()
    ├── genTilemapEraseCellScript()
    ├── genTilemapFillRectScript()
    ├── genTilemapClearScript()
    ├── genTilemapCopyScript()
    ├── genTilemapPasteScript()
    └── genTilemapSetTransformScript()
```

注册到 `GodotServer.ts` 的 `toolModules` 数组（新增 tilemapOps import）。

## 6. 不做的事

- 音频总线管理 / 效果器（P2）
- 音频资源管理（导入/列举/查询时长）（P2）
- 麦克风录音（P2）
- TileMap 图集编辑（创建/修改 TileSet 资源，需编辑器 API）
- TileMap 烘焙导航（需编辑器 API）
- Shader 编辑（P2）
- 粒子系统（P2）

## 7. 测试策略

- `test/godot-ops.test.js`：新增 4 个音频工具测试
  - 每个 genAudio*Script() 验证 GDScript 包含关键代码片段
  - 负例：非 AudioStreamPlayer 类型、volume_db 超范围、非法 stream_path
  - 参数截断测试：超出范围的参数被截断并产生 warnings

- `test/tilemap-ops.test.js`（新建）：8 个 TileMap 工具测试
  - 每个 genTilemap*Script() 验证 GDScript 包含关键代码片段
  - 双节点类型测试：TileMap 分支和 TileMapLayer 分支分别生成正确脚本
  - 负例：非法 coords（浮点数）、非法 region（w=0）、非 TileMap 类型
  - 图案序列化测试：copy 输出格式正确，paste 输入格式解析正确

- 不做 Godot 进程集成测试（需要 Godot 安装 + 项目上下文）

## 8. 成功标准

- 12 个新工具 schema 全部有 required + 类型校验
- 音频参数自动截断超范围值并产生 warnings
- TileMap 工具在 TileMap 和 TileMapLayer 两种节点上都生成正确脚本
- 所有 string 入脚本前统一 `gdEscape`
- 所有 path 先 `normalizeNodePath` 再使用
- `npm run build` 通过
- 测试覆盖 12 个 gen*Script + 负例 + 双节点兼容
- 工具总数从 43 增长到 55
- 版本号升到 0.6.0
- README.md 同步更新
