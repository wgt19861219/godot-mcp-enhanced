# v0.11.0 Release + validate_scripts 修复 + WebSocket 限制

日期: 2026-05-22

## 概述

三个独立任务按优先级顺序执行：
1. **v0.11.0 发版** — npm publish + GitHub Release
2. **validate_scripts 继承链修复** — 扩展白名单减少误报
3. **WebSocket 消息大小/连接数限制** — 双端资源防护

---

## 任务 1：v0.11.0 发版

### 变更内容

- package.json 版本 0.10.1 → 0.11.0
- CHANGELOG.md：[Unreleased] 内容整理为 [0.11.0] - 2026-05-22
- npm publish --access public
- git tag v0.11.0
- GitHub Release（通过 gh 命令创建）

### 发布内容摘要

自 v0.10.1 以来新增：
- verify_delivery 工具（四维度交付验证）
- L1 quickVerify + dev_loop acceptance
- 集成测试框架（23 测试用例）
- 安全加固（迭代 URL 解码、密钥文件生命周期、编辑器 WebSocket 认证+限速）
- 多项 bug 修复（断言隔离、认证失败检测、CRLF 处理等）

### 前置检查

- npm 登录状态确认（npm whoami）
- build 产物确认（npm run build 无错误）
- 测试通过（npm test）

---

## 任务 2：validate_scripts 继承链修复

### 当前问题

`src/tools/validation.ts` 中 `KNOWN_BASE_METHODS`（行 20-51）白名单不完整，
导致 `extends Node2D` 的脚本中合法方法调用被误报为 "not found in base self"。

### 修复方案

扩展 `KNOWN_BASE_METHODS` 白名单，补充以下类别的常用方法/属性：

**Input 事件：**
- Input.is_action_pressed, Input.is_action_just_pressed, Input.is_action_just_released
- Input.get_vector, Input.get_strength, Input.mouse_mode, Input.set_mouse_mode

**Area2D / Collision：**
- get_overlapping_bodies, get_overlapping_areas, monitoring, monitorable
- collision_mask, collision_layer, set_collision_mask_value

**AnimationPlayer：**
- play, stop, pause, seek, get_current_animation_position, current_animation
- speed_scale, autoplay

**AudioStreamPlayer：**
- play, stop, playing, volume_db, pitch_scale, stream

**TileMap / TileMapLayer：**
- set_cell, get_cell, clear, get_used_cells, map_to_local, local_to_map

**Sprite2D / Texture：**
- texture, hframes, vframes, frame, region_enabled, region_rect

**Label / RichTextLabel：**
- text, horizontal_alignment, vertical_alignment, autowrap_mode
- bbcode_text, append_text, clear, scroll_to_line

**Timer：**
- start, stop, paused, time_left（已有 wait_time/autostart/one_shot）

**其他常用：**
- tween (create_tween), Tween.tween_property, Tween.tween_callback, Tween.set_parallel
- get_window, set_flag, borderless, transparent
- await 关键字不应被标记

### 匹配逻辑改进

当前匹配逻辑（行 174-176）：
```
for (const method of KNOWN_BASE_METHODS) {
  if (line.includes('.' + method) || line.includes(method + '(')) return true;
}
```

问题：`line.includes(method + '(')` 可能误匹配不相关代码（如 `play(` 匹配到非方法调用）。

改进：增加更精确的匹配模式，同时检查点号前缀或方法调用上下文。

### 预期效果

- 误报数量从"几乎不可用"降低到"偶有遗漏"
- 白名单覆盖 Godot 项目中最常用的 8 个类
- 不影响真实错误的检测能力

---

## 任务 3：WebSocket 消息大小/连接数限制

### 当前状态

- `websocket_server.gd`：无连接数限制，无消息大小限制
- `EditorConnection.ts`（TypeScript WebSocket 客户端）：无入站消息大小限制
- `mcp_bridge.gd`：TCP 连接无缓冲区大小限制

### 修复方案

#### websocket_server.gd（GDScript 服务端）

新增常量：
```gdscript
const MAX_PEERS := 5
const MAX_MESSAGE_SIZE := 1048576  # 1MB
```

连接数限制：在 `_process` 中接受新连接前检查 `_peers.size() >= MAX_PEERS`。

消息大小限制：Godot WebSocketPeer API 在 4.x 中可通过 `WebSocketPeer.set_max_allowed_packet_size()` 设置，或在收到消息后检查 `packet.get_string_from_utf8().length()`。选择后者（更兼容）。

#### EditorConnection.ts（TypeScript 客户端）

Node.js ws 库无内置消息大小限制。在收到消息时检查：
```typescript
ws.on('message', (data: Buffer) => {
  if (data.length > MAX_MESSAGE_SIZE) {
    // 丢弃并记录警告
    return;
  }
  // 正常处理
});
```

### 限制值选择

| 参数 | 值 | 理由 |
|------|-----|------|
| MAX_PEERS | 5 | 编辑器场景通常 1-2 个 MCP 客户端 |
| MAX_MESSAGE_SIZE | 1MB | 足够覆盖大场景查询（场景树 JSON 通常 < 100KB） |

### 不修改 mcp_bridge.gd

TCP Bridge 已有认证和限速机制，且 TCP 协议本身有流控。消息大小由 NDJSON 行分隔符控制，单行通常很小（< 1KB 命令）。不添加额外限制。

---

## 执行顺序

1. 任务 1（发版）— 独立于任务 2/3
2. 任务 2（validate_scripts）— 独立于任务 3
3. 任务 3（WebSocket 限制）— 最后执行

每个任务完成后单独提交。
