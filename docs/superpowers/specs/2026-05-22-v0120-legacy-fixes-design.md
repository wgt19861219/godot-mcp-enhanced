# v0.12.0 遗留问题修复设计

> 日期: 2026-05-22
> 范围: 8 个遗留问题修复 + 功能增强

## 优先级排序

按 **风险×影响** 排序，分为三批：

### 批次 1: 安全 + 正确性（高优先级）

| # | 问题 | 改动范围 | 风险 |
|---|------|---------|------|
| #7 | requestId 溢出 + connect 竞态 | `mcp_bridge.gd`, `websocket_server.gd` | 整数溢出导致 ID 冲突 |
| #11 | EditorConnection 重连无上限 | `EditorConnection.ts` | 无限重连消耗资源 |
| #3 | 常量时间比较重复 | `mcp_bridge.gd`, `websocket_server.gd` | 两处代码不同步 |

### 批次 2: 代码质量（中优先级）

| # | 问题 | 改动范围 | 风险 |
|---|------|---------|------|
| #4 | 全局可变状态 | `process-state.ts`, `index.ts` | 多实例共享状态 |
| #5 | 确认令牌无作用域 | `scene.ts` | token 被跨操作复用 |
| #9 | L015 isInCommentOrString 过滤 | `gdscript-lint.ts` | 误报/漏报 |

### 批次 3: 功能增强（低优先级）

| # | 问题 | 改动范围 | 风险 |
|---|------|---------|------|
| #6 | camelCase/snake_case 双向映射 | `scene.ts`, `shared.ts` | 属性名匹配失败 |
| #10 | CSS Grid 翻译层 | `ui-tools.ts` | 布局不正确 |

---

## 批次 1 详细设计

### #7: requestId 溢出保护 + connect 竞态

**问题:**
- `_request_counter: int` 在 GDScript 中理论上可以溢出（虽然 int 64 位，实际极难触发）
- `EditorConnection.ts` 的 `requestId` 同样是自增 int，无溢出保护
- WebSocket 握手完成前收到消息会导致竞态

**方案:**
- GDScript: 加 `% 1000000` 取模（100 万足够大不会冲突）
- TypeScript `EditorConnection`: `requestId` 加 `% Number.MAX_SAFE_INTEGER` 保护
- `websocket_server.gd`: 新连接状态追踪，STATE_CONNECTING 期间缓冲消息

**文件:**
- `src/scripts/mcp_bridge.gd` — `_request_counter` 取模
- `addons/godot_mcp_server/websocket_server.gd` — `_request_counter` 取模
- `src/core/EditorConnection.ts` — `requestId` 取模

### #11: EditorConnection 重连上限

**问题:**
- 指数退避到 60s 上限后，持续重连永不停止
- 服务端崩溃后客户端无限重试

**方案:**
- 添加 `maxReconnectAttempts` 选项，默认 20 次
- 超过上限后停止重连，触发 `onDisconnect` 回调
- 成功连接后重置计数器（已有）

**文件:**
- `src/core/EditorConnection.ts` — 添加 `maxReconnectAttempts` + 重连终止逻辑

### #3: 常量时间比较去重

**问题:**
- `mcp_bridge.gd` 和 `websocket_server.gd` 各有一份 `_constant_time_compare`
- 注释标注 DUPLICATE，两处需手动同步

**方案:**
- 编辑器插件无法引用外部脚本（GDScript 限制）
- 替代方案：将共享函数写入 `addons/godot_mcp_server/shared/` 目录
- `mcp_bridge.gd` 是 autoload 脚本，无法引用 addons
- **实际方案**：保持两份副本，但用构建脚本自动同步
  - 在 `scripts/` 目录维护单一源文件 `constant_time_compare.gd`
  - `package.json` 的 build 脚本中添加同步步骤
  - 删除两处的 DUPLICATE 注释，改为 `// Auto-synced from scripts/constant_time_compare.gd`

**文件:**
- 新建 `scripts/constant_time_compare.gd` — 单一源
- 修改 `src/scripts/mcp_bridge.gd` — 从源复制
- 修改 `addons/godot_mcp_server/websocket_server.gd` — 从源复制
- 修改 `package.json` — build 脚本添加同步

---

## 批次 2 详细设计

### #4: 全局可变状态

**问题:**
- `process-state.ts` 用模块级 `let` 变量存储运行时状态
- 多个 MCP 会话会共享同一进程，导致状态冲突

**方案:**
- 将模块级变量封装为 `SessionState` 类
- 通过 `ToolContext` 传入（已有 `setRunningProcess` 等方法）
- `index.ts` 创建 `SessionState` 实例，传入各 handler
- 保留 `resetState()` 作为实例方法

**文件:**
- `src/core/process-state.ts` — 改为 `SessionState` 类 + 工厂函数
- `src/types.ts` — `ToolContext` 添加 `state: SessionState`
- `src/index.ts` — 创建实例，传入 ToolContext

### #5: 确认令牌作用域

**问题:**
- `remove_node` 的确认 token 无过期时间和操作绑定
- 理论上可以用一个操作的 token 确认另一个操作

**方案:**
- Token 结构改为 `{ token, operation, nodePath, scenePath, createdAt }`
- 验证时检查操作类型和目标路径匹配
- 5 分钟过期

**文件:**
- `src/tools/scene.ts` — `confirmationToken` 改为结构化对象 + 验证逻辑

### #9: L015 isInCommentOrString 过滤

**问题:**
- L015 规则检测 `_process` 中调用 `look_at` 等物理方法
- 当前 `isInCommentOrString` 仅在通用规则扫描中使用
- L015 使用 `isCallOrder: true` 走独立路径，可能绕过过滤

**方案:**
- 在 L015 的 call-order 检测路径中，对匹配行调用 `isInCommentOrString`
- 跳过注释和字符串中的误报

**文件:**
- `src/tools/gdscript-lint.ts` — L015 处理分支添加过滤

---

## 批次 3 详细设计

### #6: camelCase/snake_case 双向映射

**问题:**
- MCP 工具接受 camelCase 参数（如 `nodeType`），但 GDScript 属性用 snake_case（如 `node_type`）
- 部分工具已硬编码映射，部分没有

**方案:**
- 在 `shared.ts` 添加通用转换函数 `toGodotProperty(key)`
- 映射表覆盖已知的 Godot 属性名
- 在 `edit_node`、`set_instance_property` 等工具中统一应用

**文件:**
- `src/tools/shared.ts` — 添加 `toGodotProperty()`
- `src/tools/scene.ts` — edit_node 路径使用映射

### #10: CSS Grid 翻译层

**问题:**
- Flex 布局翻译层已支持 FlexBox → Godot Container
- GridContainer 缺少类似的高级翻译

**方案:**
- 扩展 `ui_build_layout` 的 `layout.direction` 支持 `grid` 值
- `grid` 模式使用 GridContainer，解析 `columns` 参数
- 支持跨列/跨行（column_span/row_span）

**文件:**
- `src/tools/ui-tools.ts` — `buildLayoutTree` 添加 grid 分支

---

## 审查修正记录

以下修正来自 Eng Review (2026-05-22)：

### 已删除项

| # | 原因 |
|---|------|
| #5 确认令牌作用域 | `guard.ts` 已有完整实现：PendingToken 含 toolName+args+createdAt，3分钟TTL，128位随机token。问题不存在。 |
| #7 竞态缓冲部分 | 服务端 websocket_server.gd:190-194 已有 auth 门控保护未认证消息；客户端 EditorConnection.ts:77 消息处理器在 open 后才注册。竞态不存在。仅保留 requestId 取模。 |
| #4 全局状态重构 | MCP 是单进程单会话（stdio transport），多实例共享状态不会发生。改为类是过度工程。保留注释说明即可。 |
| #3 构建脚本同步 | 12行代码两份副本是 GDScript 语言限制。构建同步方案不匹配 addons/ 目录。改为注释提醒。 |

### 方案修正

| # | 原方案 | 修正后 |
|---|--------|--------|
| #6 | 硬编码映射表 | 运行时自动 camelCase→snake_case 转换（toSnakeCase()） |
| #9 | 叠加 isInCommentOrString 过滤 | 从全局正则改为逐行匹配+过滤（与其他 lint 规则一致） |
| #10 | 支持 column_span/row_span | 不支持 span（Godot GridContainer 无此能力），仅支持 columns 参数 |

### 最终范围（5项）

| # | 改动 | 文件 |
|---|------|------|
| #7 | requestId 取模保护 | mcp_bridge.gd, websocket_server.gd, EditorConnection.ts |
| #11 | 重连上限（maxReconnectAttempts=20） | EditorConnection.ts |
| #9 | L015 逐行扫描+isInCommentOrString 过滤 | gdscript-lint.ts |
| #6 | 运行时 camelCase→snake_case 自动转换 | shared.ts, scene.ts |
| #10 | Grid 翻译层（columns 参数，不支持 span） | ui-tools.ts |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | /plan-ceo-review | Scope and strategy | 0 | - | - |
| Codex Review | /codex review | Independent 2nd opinion | 0 | - | - |
| Eng Review | /plan-eng-review | Architecture and tests (required) | 1 | CLEAN | 4 issues, 0 critical gaps, scope reduced |
| Design Review | /plan-design-review | UI/UX gaps | 0 | SKIPPED | No UI scope - backend-only change |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED - ready to implement
