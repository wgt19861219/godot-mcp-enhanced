# v0.13.0 大版本升级设计：质量基础 + 编辑器能力 + 差异化特性

> 日期: 2026-05-23
> 状态: Draft
> 来源: v0.12.0 发布后的新功能方向研究

## 问题背景

v0.12.0 完成了遗留修复，当前工具数 124+，覆盖场景/脚本/验证/文档查询/物理/音频/TileMap/材质/导航/粒子/动画/UI/信号/性能分析。但对比竞品仍有三方面差距：

1. **质量保障** — 747 个单元测试全部 mock，缺少与真实 Godot 引擎的集成测试
2. **编辑器能力** — Undo/Redo 缺失，运行时交互深度不够，导出构建流程基础
3. **差异化** — Asset Library 集成、代码模板系统等竞品有但我们没有

## 设计目标

6 个核心模块 + 2 个 stretch goal，分 3 个子版本递进交付：

| 子版本 | 模块 | 主题 |
|--------|------|------|
| **v0.13.0** | 模块 1（集成测试）+ 模块 2（代码模板） | 质量基础 |
| **v0.14.0** | 模块 3（Undo/Redo）+ 模块 4（运行时交互）+ 模块 5（导出增强） | 编辑器能力 |
| **v0.15.0** | 模块 6（Asset Library）+ Stretch 1/2 | 差异化特性 |

每个子版本独立发版，前一个版本完成后才开始下一个。

---

## 模块 1：集成测试框架

**状态**: 已有完整设计（`2026-05-21-integration-test-framework-design.md`），直接实施。

**摘要**:
- 复用已有 `executeGdscript()` + `findGodot()`，不建新抽象层
- 双层级：Level A（GDScript 执行管道 5 个用例）+ Level B（MCP 工具端到端 15 个用例）
- 可选执行：Godot 不在 PATH 时自动 skip
- 测试放 `test/integration/`，`npm run test:integration` 单独运行

**文件结构**:
```
test/
├── helpers/
│   ├── integration-setup.js    # Godot 可用性检测 + itIfGodot
│   ├── tool-context.js         # createToolContext + createTempProject
│   └── fixtures.js             # MINIMAL_PROJECT 模板
├── integration/
│   ├── gdscript-execution.test.js   # Level A, 5 用例
│   ├── scene-operations.test.js     # Level B, 6 用例
│   ├── script-editing.test.js       # Level B, 4 用例
│   └── project-management.test.js   # Level B, 5 用例
```

**测试命令**:
```json
{
  "test": "npm run build && node --test test/*.test.js",
  "test:integration": "npm run build && node --test test/integration/*.test.js",
  "test:all": "npm run build && node --test test/*.test.js test/integration/*.test.js"
}
```

---

## 模块 2：代码模板系统

**状态**: 设计文档 P1 部分（`2026-05-18-gdscript-lint-and-templates-design.md`），需细化。

### 存储方式：混合模式

- **内置模板**: 常见模式硬编码在 `src/tools/code-templates.ts`（已有文件，扩展内容）
- **用户模板**: 支持 `project://.mcp-templates/` 目录下的自定义模板，覆盖/扩展内置模板

### 模板格式

每个模板是一个 JSON 结构：

```typescript
interface CodeTemplate {
  id: string;                    // 唯一标识，如 "character-body-2d-movement"
  name: string;                  // 显示名
  description: string;           // 一行描述
  tags: string[];                // 搜索标签 ["2d", "movement", "physics"]
  appliesTo: string[];           // 适用基类 ["CharacterBody2D"]
  godotVersion: string;          // 最低版本 "4.2"
  code: string;                  // 模板代码（支持 {{variable}} 占位符）
  variables?: TemplateVariable[]; // 可定制参数
}

interface TemplateVariable {
  name: string;
  type: "number" | "string" | "bool" | "enum";
  default: string;
  description: string;
  options?: string[];            // enum 类型用
}
```

### 内置模板清单（首轮）

| ID | 名称 | 适用类 | 用途 |
|----|------|--------|------|
| `character-body-2d-movement` | 2D 角色移动 | CharacterBody2D | move_and_slide() + 输入处理 |
| `character-body-3d-movement` | 3D 角色移动 | CharacterBody3D | 3D 第一人称/第三人称移动 |
| `rigid-body-3d-bounce` | 3D 刚体弹跳 | RigidBody3D | PhysicsMaterial 正确用法 |
| `camera-3d-follow` | 3D 相机跟随 | Camera3D | 平滑跟随目标 |
| `animation-player-basic` | 基础动画播放 | AnimationPlayer | play/stop/seek 模式 |
| `signal-connection-pattern` | 信号连接模式 | 任意 | 常见 signal emit/connect 模式 |
| `area2d-detection` | 2D 区域检测 | Area2D | body_entered/Exited 处理 |
| `timer-pattern` | 计时器模式 | Timer | One-shot/重复计时器 |
| `state-machine-simple` | 简单状态机 | 任意 | enum + match 状态管理 |
| `resource-preload` | 资源预加载 | 任意 | preload/load 正确模式 |

### 工具集成

新增 MCP 工具：
- `list_templates` — 列出可用模板（支持标签/适用类过滤）
- `apply_template` — 将模板应用到指定脚本路径（带变量替换）

增强现有工具：
- `write_script` — 写入后自动检测是否匹配已有模板，返回模板建议
- `batch_create_files` — 支持从模板生成多个文件

### 模板渲染引擎

使用内联 `String.replace()` 实现 `{{variable}}` 替换，不引入模板引擎依赖：

```typescript
function renderTemplate(code: string, variables: Record<string, string>): string {
  return code.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}
```

用户模板验证：加载时校验 `id` 唯一性、`code` 非空、`variables` 类型合法。同名内置模板被用户模板覆盖时打印 warning。

### 测试计划

- 每个内置模板至少 1 个单元测试（渲染 + 变量替换）
- 用户模板加载测试（覆盖、校验、错误处理）
- `apply_template` 端到端测试（写入文件 + 验证内容）

### 文件结构

```
src/tools/
├── code-templates.ts        # 内置模板定义 + 渲染 + 加载逻辑（单文件，不拆分）
└── (无额外 template-engine.ts / template-loader.ts)
```

---

## 模块 3：Undo/Redo（编辑器模式）

**状态**: 新模块，需从零设计。

### 实现机制：委托编辑器 UndoRedo

通过 WebSocket 让编辑器插件调用 Godot 原生 `UndoRedo` API。MCP 侧记录操作序列，编辑器侧执行 undo/redo。

### WebSocket 协议扩展

新增命令，每个命令包含幂等性 `requestId` 和确认响应：

```json
// 开始一个 undo 组（幂等：相同 requestId 不重复创建）
{ "type": "undo_create_action", "name": "Add Sprite2D", "requestId": "uuid-1" }

// 提交 undo 组（确认：返回 success/failure）
{ "type": "undo_commit_action", "requestId": "uuid-2" }

// 执行 undo（确认：返回 undo 后的状态）
{ "type": "undo", "requestId": "uuid-3" }

// 执行 redo
{ "type": "redo", "requestId": "uuid-4" }

// 获取 undo 历史
{ "type": "get_undo_history", "requestId": "uuid-5" }

// 清空 undo 历史
{ "type": "clear_undo_history", "requestId": "uuid-6" }
```

每个命令返回确认响应：
```json
{ "type": "undo_create_action_result", "requestId": "uuid-1", "success": true }
```

### 断连恢复机制（CRITICAL 1 修复）

**问题：** WebSocket 断连时，未提交的 undo action 残留在编辑器内存中，导致后续 undo 行为不可预测。

**方案：**
1. MCP 侧维护当前 undo action 状态（`pending_action_id`），超时 30s 未 commit 自动 rollback
2. 编辑器侧在 `on_client_connected` 时检查是否有残留的未提交 action，如果有则 `undo_redo.rollback()` 清理
3. MCP 侧重连后发送 `get_undo_history` 同步状态，确认历史一致性

```typescript
// MCP 侧超时保护
private pendingUndoTimeout: NodeJS.Timeout | null = null;

async startUndoAction(name: string): Promise<void> {
  const requestId = crypto.randomUUID();
  await this.sendCommand({ type: 'undo_create_action', name, requestId });
  this.pendingUndoTimeout = setTimeout(() => {
    this.rollbackPendingAction();
  }, 30_000); // 30s 超时自动回滚
}

async commitUndoAction(): Promise<void> {
  if (this.pendingUndoTimeout) {
    clearTimeout(this.pendingUndoTimeout);
    this.pendingUndoTimeout = null;
  }
  await this.sendCommand({ type: 'undo_commit_action', requestId: crypto.randomUUID() });
}
```

```gdscript
# 编辑器侧：连接时清理残留
func _on_client_connected():
    if _undo_redo.has_undo():
        _undo_redo.rollback()  # 清理任何未提交的 action
```

### 编辑器插件改动

`addons/godot_mcp_server/websocket_server.gd` 新增：

```gdscript
var _active_undo_request_id: String = ""

func _handle_undo_create_action(data: Dictionary) -> void:
    var request_id: String = str(data.get("requestId", ""))
    if _active_undo_request_id == request_id:
        # 幂等：相同 requestId 不重复创建
        _send_response({ "type": "undo_create_action_result", "requestId": request_id, "success": true })
        return
    if _active_undo_request_id != "":
        _undo_redo.rollback()  # 清理上一个未提交的
    _active_undo_request_id = request_id
    var action_name: String = data.get("name", "MCP Action")
    _undo_redo.create_action(action_name)
    _send_response({ "type": "undo_create_action_result", "requestId": request_id, "success": true })

func _handle_undo_commit_action(data: Dictionary) -> void:
    _active_undo_request_id = ""
    _undo_redo.commit_action()
    _send_response({ "type": "undo_commit_action_result", "requestId": str(data.get("requestId", "")), "success": true })

func _handle_undo(data: Dictionary) -> void:
    _undo_redo.undo()
    _send_response({ "type": "undo_result", "requestId": str(data.get("requestId", "")), "success": true })

func _handle_redo(data: Dictionary) -> void:
    _undo_redo.redo()
    _send_response({ "type": "redo_result", "requestId": str(data.get("requestId", "")), "success": true })
```

对于 `add_node`、`edit_node`、`remove_node` 等操作，自动包装在 undo action 中：
- 调用前发 `undo_create_action`（带幂等 requestId）
- 操作执行（添加 add_undo_method/add_do_method）
- 调用后发 `undo_commit_action`
- 超时 30s 未 commit 自动 rollback

### MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `undo` | 无 | 撤销上一步操作（编辑器模式） |
| `redo` | 无 | 重做上一步操作（编辑器模式） |
| `get_undo_history` | 无 | 获取可撤销操作列表 |
| `clear_undo_history` | 无 | 清空 undo 历史 |

### 兼容性

- 仅编辑器模式可用（headless 模式调用返回错误提示）
- 需要编辑器插件升级（最低版本要求更新）

---

## 模块 4：运行时交互增强

**状态**: 已有 `game-bridge` 基础（game_input/game_query/game_wait），需扩展。

### 新增输入类型

#### 4.1 拖拽操作

```typescript
// game_input 新增 method: "send_mouse_drag"
{
  method: "send_mouse_drag",
  params: {
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number,     // 拖拽持续时间（ms）
    button: "left" | "right" | "middle",
    steps: number         // 插值步数（默认 10）
  }
}
```

编辑器端将插值生成 move 事件序列。

#### 4.2 录制回放增强

扩展现有 recording 模块：
- `recording_edit` — 编辑已录制的输入序列（删除/修改/插入事件）
- `recording_merge` — 合并多个录制文件
- `recording_export` — 导出为可读 JSON 格式
- `recording_speed` — 回放时变速（0.5x / 1x / 2x）

### 测试计划

- 拖拽操作单元测试（插值步数验证、边界检查）
- 录制回放测试（编辑/合并/变速的正确性）
- 与现有 game_input 集成测试

### 编辑器插件改动

`game_bridge.gd` 扩展 `handle_input` 以支持 `send_mouse_drag` 方法。拖拽在编辑器端插值生成 move 事件序列。

### 非目标（本轮不做）

- 手柄/游戏板输入（`send_joy_button` / `send_joy_axis`）— 需要注册虚拟设备，复杂度高
- 触控模拟（`send_touch` / `send_multi_touch`）— 移动端测试场景有限

---

## 模块 5：导出/构建增强

**状态**: 已有 `export_build`/`export_list_presets`/`export_get_preset`，需扩展。

### 新增能力

#### 5.1 多平台批量构建

```typescript
// 新工具: batch_export
{
  presets: string[],          // preset 名称列表
  output_dir?: string,        // 统一输出目录
  continue_on_error?: boolean // 单个失败是否继续
}
```

顺序执行每个 preset，返回每个的结果（成功/失败/产物路径）。

#### 5.2 构建状态轮询

`export_build` 保持**同步默认**（现有行为不变），新增 `async: boolean` 参数 opt-in 异步模式：

```typescript
// 现有行为（同步，默认）
await handleTool('export_build', { project_path: "...", preset: "Windows" });
// → 等待构建完成，直接返回结果

// 异步模式（opt-in）
const result = await handleTool('export_build', { project_path: "...", preset: "Windows", async: true });
// → 立即返回 { export_id: "uuid", status: "started" }

// 轮询状态
await handleTool('export_status', { export_id: "uuid" });
// → { status: "running", progress: 45, current_step: "Packing resources" }
```

#### 5.3 构建产物管理

```typescript
// 新工具: list_builds
{
  project_path: string,
  preset?: string             // 可选过滤
}

// 新工具: clean_builds
{
  project_path: string,
  preset?: string,
  keep_latest?: number        // 保留最近 N 个
}
```

#### 5.4 CI/CD 集成

- 所有导出工具支持 `--json` 格式输出（结构化 JSON 代替人类可读文本）
- `export_build` 新增 `wait: boolean` 参数（默认 true，CI 中用 false + 轮询）
- 退出码语义化：0=成功，1=构建失败，2=配置错误

---

## 模块 6：Asset Library 集成

**状态**: 新模块，连接 Godot 官方 Asset Library API。

### API 端点

基础 URL: `https://assets.godotengine.org/api/v2`

| 端点 | 用途 |
|------|------|
| `GET /asset` | 搜索资产（支持 filter/sort/page） |
| `GET /asset/{asset_id}` | 资产详情 |
| `GET /asset/{asset_id}/versions` | 资产版本列表 |
| `GET /category` | 分类列表 |

### MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `search_assets` | query, category?, godot_version?, sort?, page? | 搜索资产 |
| `get_asset_info` | asset_id | 资产详情 |
| `install_asset` | asset_id, version?, target_dir? | 下载并安装到项目 |
| `list_installed_assets` | project_path | 扫描项目已安装资产 |

### 安装流程

1. `search_assets` 找到目标资产
2. `get_asset_info` 确认版本兼容性
3. `install_asset` 下载 zip → 解压到 `target_dir`（默认 `res://addons/`）
4. 如果资产有 `plugin.cfg`，提示用户在项目设置中启用

### Zip Slip 防护（CRITICAL 2 修复）

**问题：** 恶意 zip 文件可能包含 `../../etc/passwd` 这样的路径，解压时写入项目外的任意文件。

**方案：** 解压时验证每个条目的真实路径（`realpath`）必须以 `target_dir` 为前缀：

```typescript
import { resolve, relative } from 'path';

function safeExtract(zipPath: string, targetDir: string): void {
  const absoluteTarget = resolve(targetDir);

  for (const entry of zip.getEntries()) {
    const entryPath = entry.entryName;

    // 拒绝绝对路径和路径遍历
    if (entryPath.startsWith('/') || entryPath.includes('..')) {
      throw new Error(`Zip slip detected: entry "${entryPath}" escapes target directory`);
    }

    const destPath = resolve(absoluteTarget, entryPath);
    const relativePath = relative(absoluteTarget, destPath);

    // 二次验证：相对路径不能以 .. 开头
    if (relativePath.startsWith('..') || resolve(destPath) !== destPath) {
      throw new Error(`Zip slip detected: "${entryPath}" resolves outside "${targetDir}"`);
    }

    // 安全：写入文件
    entry.extractTo(destPath);
  }
}
```

### 缓存策略

使用内存 Map + hash key，不引入外部缓存库：

```typescript
// 简单内存缓存
const cache = new Map<string, { data: unknown; expires: number }>();

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: unknown, ttlMs: number): void {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// 缓存 key 使用 query hash
function cacheKey(prefix: string, params: Record<string, unknown>): string {
  const hash = createHash('md5').update(JSON.stringify(params)).digest('hex').slice(0, 12);
  return `${prefix}:${hash}`;
}
```

- 搜索结果缓存 5 分钟
- 资产详情缓存 30 分钟
- 下载的 zip 文件缓存到系统临时目录（`os.tmpdir()`）

### 测试计划

- 搜索/详情 API mock 测试（参数构建 + 响应解析）
- Zip Slip 防护测试（恶意路径 `../../etc/passwd`、绝对路径 `/etc/passwd`）
- 缓存命中/过期测试
- 安装流程端到端测试（下载 + 解压 + 验证）
- 错误处理测试（网络失败、404、无效 zip）

---

## Stretch Goals（时间允许时实施）

### Stretch 1：调试器集成

- 通过编辑器 WebSocket 代理 DAP 协议
- 工具：`set_breakpoint`、`get_stack_trace`、`get_variables`、`step_over`、`step_into`、`continue`
- 复杂度大（4-5 天），依赖编辑器插件大量改动

### Stretch 2：可视化浏览器

- 本地 HTTP 服务器提供浏览器端场景结构可视化
- 力导向图展示节点关系、脚本依赖
- 实时同步编辑器变更
- 复杂度大（4-5 天），需要前端实现

---

## 版本号与兼容性

- **版本**: v0.13.0 → v0.14.0 → v0.15.0（三阶段交付）
- **最低 Godot 版本**: 4.4+（不变）
- **编辑器插件版本**: v0.14.0 起需升级以支持 Undo/Redo + 拖拽输入
- **Node.js**: 18+（不变）
- **破坏性变更**: 无。`export_build` 保持同步默认，异步通过 `async: true` opt-in

## 文件结构概览

```
src/tools/
├── code-templates.ts              # 模块 2: 内置模板 + 渲染 + 用户模板加载（单文件）
├── undo-redo.ts                   # 模块 3: Undo/Redo 工具（含断连恢复）
├── game-bridge.ts                 # 模块 4: 运行时交互（扩展拖拽+录制）
├── export-tools.ts                # 模块 5: 导出增强（同步默认+异步 opt-in）
├── asset-library.ts               # 模块 6: Asset Library（含 zip slip 防护 + 内存缓存）
└── (现有工具文件不变)

addons/godot_mcp_server/
├── websocket_server.gd            # 模块 3: Undo/Redo 命令（幂等+确认+rollback）
└── game_bridge.gd                 # 模块 4: 拖拽输入

test/
├── integration/                   # 模块 1: 集成测试文件
├── code-templates.test.js         # 模块 2 测试
├── undo-redo.test.js              # 模块 3 测试
├── game-bridge-enhanced.test.js   # 模块 4 测试
├── export-tools.test.js           # 模块 5 测试
├── asset-library.test.js          # 模块 6 测试（含 zip slip 安全测试）
└── (现有测试不变)
```

## 非目标

- Godot 3.x 兼容
- 多编辑器实例管理
- 性能基准测试套件
- 跨版本 Godot 兼容性测试
- 自定义 MCP server 插件系统
