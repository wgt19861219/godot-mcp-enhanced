# 交付验证系统设计：两层自动化验证框架

> 日期: 2026-05-21
> 状态: Draft
> 来源: 端到端交付流程中反复调试场景的自动化需求

## 问题背景

在使用 MCP 工具进行 Godot 开发时，从需求到交付的流程缺少自动化验证环节：

1. **操作后无反馈** — `add_node`、`edit_node` 等写操作执行后，无法确认结果是否符合预期
2. **脚本验证分散** — `validate_scripts` 检查语法、lint 引擎检查 API、profiler 检查性能，需要分别调用
3. **无交付标准** — 缺少一个"是否可以交付"的综合判断

核心痛点：Claude 每次操作后需要手动截图/查场景树/跑验证来确认结果，反复调试耗时。

## 设计目标

1. **L1 轻量验证** — 写操作后可选快速检查（verify=true 时触发），结果嵌入工具返回值
2. **L2 深度验证** — 手动调用 `verify_delivery`，四维度全面检查（3-10s）
3. **dev_loop 增强** — 支持验收条件参数，执行后自动验证
4. **只报告不修复** — 验证层返回结构化报告，修复决策交给 Claude

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Claude (LLM)                      │
│  调用 MCP 工具 → 读取报告 → 决定是否修复             │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────────┐
    │  Layer 1: 轻量验证    │  │  Layer 2: 深度验证    │
    │  (嵌入工具返回值)     │  │  (verify_delivery)   │
    │                      │  │                       │
    │  add_node → 可选检查  │  │  场景树完整性         │
    │  edit_node → 属性核对 │  │  脚本健壮性           │
    │  write_script → 语法  │  │  性能/资源健康         │
    │  load_sprite → 资源   │  │  自定义行为断言        │
    └──────────┬──────────┘  └───────┬──────────────┘
               │                      │
    ┌──────────▼──────────────────────▼──────────────┐
    │              已有原子能力                        │
    │  execute_gdscript · validate_scripts · profiler │
    │  test_assert · scene_snapshot · error_analyzer  │
    └─────────────────────────────────────────────────┘
```

**两层职责划分：**

| 层 | 触发 | 检查范围 | 耗时 | 用途 |
|---|---|---|---|---|
| L1 轻量 | 写操作后可选（verify=true） | 单点检查（刚操作的节点/脚本） | 无额外进程开销 | 快速捕获明显错误 |
| L2 深度 | 手动调用 `verify_delivery` | 四维度全面检查 | 3-10s | 交付前终验 |

## L1 轻量验证（嵌入工具返回值）

### 触发方式

在现有写操作工具的返回值中追加 `verification` 字段。由工具注册层（`tool-registry.ts`）统一为写操作工具注入 `quickVerify()` 调用，而非分散到各工具文件。

### 涉及工具和检查项

| 工具 | 检查内容 | 实现方式 |
|---|---|---|
| `add_node` | 节点存在、类型正确、位置正确 | 执行后生成 GDScript 查询节点 |
| `edit_node` | 属性值已生效 | 读回属性对比期望值 |
| `write_script` / `edit_script` | 无语法错误、无 lint error | 轻量单文件语法检查（`validate_script_single`），仅解析目标文件，不做全项目 lint |
| `load_sprite` | 纹理加载成功 | 查询 texture 属性非空 |
| `ui_build_layout` | 子节点数量、容器类型 | 查询子节点数 |

### 返回值格式

```typescript
interface QuickVerifyResult {
  passed: boolean;
  checks: Array<{
    name: string;       // "node_exists" | "property_match" | "script_valid" | "texture_loaded" | "child_count"
    passed: boolean;
    detail?: string;    // 失败原因
  }>;
  error?: string;       // GDScript 执行失败时的错误信息。与 checks 共存：部分检查完成时 checks 填充结果，error 记录中断点
}
```

> **操作成功 vs 验证失败：** L1 验证失败不影响工具主操作的返回值。工具返回其常规结果，`verification` 字段单独报告验证状态。`error` 与 `checks` 共存——部分检查完成时 `checks` 填充已完成项，`error` 记录中断原因。
```

### 性能约束

- L1 验证复用当前操作的 Godot 进程，无额外进程启动开销
- 通过 GDScript 单次执行批量查询（不是每个属性一次调用）
- 新增一个 `verify` 参数（默认 `false`），用户可开启

> **进程复用说明：** L1 quickVerify 在操作完成后，在同一 Godot 进程内追加验证 GDScript 代码执行。不单独启动新的 headless 进程，避免了 1-2 秒的进程启动开销。

### 不做的事

- 不改变现有工具的默认行为（`verify` 默认 false）
- 不做深度检查（那是 L2 的活）

## L2 深度验证（`verify_delivery` 工具）

### 工具签名

```
verify_delivery(project_path, scope, checks?)
```

### scope 参数 — 验证范围

| scope | 说明 |
|---|---|
| `scene` | 指定场景路径，检查该场景树完整性 |
| `script` | 指定脚本路径，检查健壮性 |
| `full` | 扫描整个项目 |

> **scope 与 checks 的关系：** 两者正交——`scope` 决定扫描范围（哪些文件/场景参与检查），`checks` 决定检查维度（执行哪些类型的检查）。例如 `scope=script` + `checks.scene_tree=true` 时，只检查该脚本关联场景的树完整性（通过扫描 .tscn 文件的 script 引用反查关联场景）；`scope=full` + `checks.performance=false` 时，全项目扫描但跳过性能维度。

### checks 参数 — 四维度开关

```typescript
checks?: {
  scene_tree?: boolean;     // 场景树状态（默认 true）
  script_health?: boolean;  // 脚本健壮性（默认 true）
  performance?: boolean;    // 性能/资源（默认 true）
  assertions?: Array<{      // 自定义行为断言
    description: string;    // "玩家能移动"
    gdscript: string;       // 执行验证的 GDScript 代码
    expect?: string;        // 期望输出值
  }>;
}
```

### 四维度检查内容

**维度 1 — 场景树完整性**
- 节点引用不悬空（ext_resource 引用的文件存在）
- 脚本附件指向有效 .gd 文件
- 节点层级关系合理（如 Camera 需要 Viewport 祖先）
- 信号连接的目标节点/方法存在（仅检查 .tscn `[connection]` 段的静态信号；代码中 `connect()` 的动态信号属于运行时测试范畴，由 `test_assert` 覆盖）

> **Headless 限制说明：** 层级关系检查基于节点类型元数据（`is_class()`），不依赖运行时渲染或物理状态。Godot headless 模式下节点实例化和类型查询正常工作，但无法验证渲染/物理相关的运行时属性。

**维度 2 — 脚本健壮性**
- 复用 `validate_scripts`（语法）
- 复用 lint 引擎（已废弃 API、时序陷阱）
- 检查 `preload()`/`load()` 引用的资源是否存在

**维度 3 — 性能/资源健康**

> **Headless 有效指标：** Godot headless 模式下渲染循环被跳过，FPS 和帧时间数据无意义。性能维度只采集以下有效指标：`orphan_node_count`（孤立节点数）、`static_memory_usage`（静态内存占用）、`resource_count`（资源引用计数）。

- 复用 `profiler` snapshot 采集上述有效指标
- 报告当前瞬时值（不自动对比历史基线；Claude 可自行对比多次 `verify_delivery` 调用的结果来检测泄漏趋势）
- 资源引用计数异常检测

**维度 4 — 自定义行为断言**
- 用户传入 GDScript 代码片段
- 系统包装成 headless 执行脚本
- 比对 `_mcp_output` 输出与 `expect` 值

### 返回格式

```typescript
interface DeliveryReport {
  passed: boolean;
  dimensions: {
    scene_tree:   { passed: boolean; issues: Issue[] };
    script_health: { passed: boolean; issues: Issue[] };
    performance:  { passed: boolean; issues: Issue[] };
    assertions:   { passed: boolean; results: AssertionResult[] };
  };
  summary: string;  // 如 "3/4 通过，性能维度发现孤立节点数量偏高"
}

interface Issue {
  severity: "error" | "warning";
  location: string;    // "res://scenes/player.tscn:Player/Sprite2D"
  message: string;
  suggestion?: string; // 自动生成有意义建议时才填充
}

interface AssertionResult {
  description: string;
  passed: boolean;
  actual: string;
  expected?: string;
  error?: string;
}
```

### 性能约束

> **基准说明：** 以下耗时基于 50 场景 / 100 脚本的项目规模测试。超出此规模耗时线性增长。

| scope | 耗时 |
|---|---|
| `scene` | 3-5 秒 |
| `script` | 2-3 秒 |
| `full` | 5-10 秒 |
| 自定义断言 | 每个 1-2 秒，最多 10 个 |

## dev_loop 增强

### 新增参数

```typescript
{
  // ... 现有参数不变 ...
  acceptance?: {
    assertions: Array<{
      description: string;    // "角色重力加速度为 980"
      gdscript: string;       // 验证代码，用 _mcp_output("assert_N", value) 输出
      expect: string;         // 期望值（字符串比较）
    }>;
    max_retries?: number;     // 默认 0（只验证一次，不自动重试）
  };
}
```

### 执行流程变化

```
现有:  exec(code) → [validate] → 返回
增强:  exec(code) → [validate] → exec(assertions) → 生成报告 → 返回
```

### 返回值追加

```
现有输出
---
## Acceptance Results
✅ "角色重力加速度为 980" — PASSED (actual: "980")
❌ "敌人朝向玩家" — FAILED (actual: "facing_away", expected: "facing_player")
```

### 设计决策

- `max_retries` 默认 0 — 不自动重试，修复交给 Claude
- 断言代码在同一 Godot 进程内执行（复用 dev_loop 已启动的进程），不污染主代码
- 不自动生成断言代码（Claude 根据上下文自己写）
- 不改变没有 `acceptance` 参数时的行为

### 断言执行方式对比

| 特性 | dev_loop `acceptance` | verify_delivery `assertions` |
|------|----------------------|------------------------------|
| 执行进程 | **同一进程**（dev_loop 已启动的 Godot） | **独立进程**（新启动 headless） |
| 速度 | 快（无额外进程启动） | 慢（需启动新进程，1-2 秒/断言） |
| 上下文 | 可访问 dev_loop 代码的运行时状态 | 从头加载场景，无先前状态 |
| 适用场景 | 验证刚执行的代码效果 | 验证项目整体交付状态 |
| 代码污染 | 断言在同一脚本中执行 | 断言包装为独立脚本 |

## 实现结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/tools/delivery.ts` | `verify_delivery` 工具定义 + 四维度检查编排 |

### 修改文件

| 文件 | 变更内容 |
|---|---|
| `src/tools/shared.ts` | 新增 `quickVerify()` 函数 + `wrapAssertionCode()` 公共断言包装器 + L1 检查模板 |
| `src/tools/workflow.ts` | `dev_loop` 增加 `acceptance` 参数和断言执行逻辑（复用 `wrapAssertionCode()`） |
| `src/core/tool-registry.ts` | 注册 `verify_delivery` 工具 + 为写操作工具统一注入 L1 `quickVerify` 包装器 |

### 复用关系

```
delivery.ts (L2 编排)
  ├── 复用 validate_scripts() → 脚本健壮性
  ├── 复用 lintRules + lintScript() → 已废弃 API 检测
  ├── 复用 executeGdscript() → 场景树查询 + 自定义断言
  ├── 复用 profiler genSnapshot() → 性能数据（orphan_node_count, static_memory, resource_count）
  └── 新增 genSceneIntegrityCheck() → 节点引用完整性 + 静态信号检查

shared.ts → quickVerify() (L1 轻量)
  ├── 复用 test_assert GDScript 模板 → 节点存在/属性核对（内部复用，不改变 test_assert 对外接口）
  ├── 复用 executeGdscript() → 在操作进程内追加执行
  └── 复用 validatePath() → 路径安全检查

shared.ts → wrapAssertionCode() (公共断言包装器)
  └── 被 dev_loop.acceptance 和 delivery.ts assertions 共同调用
```

### quickVerify 调用模式

```typescript
// tool-registry.ts 中为写操作工具统一注入 L1 验证
const WRITE_TOOLS = ['add_node', 'edit_node', 'write_script', 'edit_script', 'load_sprite', 'ui_build_layout'];

function wrapWithVerify(toolHandler, toolName) {
  return async (args) => {
    const result = await toolHandler(args);
    if (args.verify === true) {
      const verifyResult = await quickVerify(toolName, args);
      result.verification = verifyResult;  // 追加到返回值
    }
    return result;
  };
}
```

### 不动的文件

- `test-framework.ts` — `test_assert` / `test_stress` 保持原样
- `profiler-ops.ts` — 只被 `delivery.ts` 调用，自身不改
- `recording.ts` — 与本次无关
- `gdscript-lint.ts` — 只被调用，自身不改

## GDScript 代码生成模板

### L1 模板（`shared.ts` quickVerify 内联）

| 模板 | 用途 | 输出 |
|---|---|---|
| `CHECK_NODE_EXISTS` | 验证节点存在于场景树 | `{exists: bool, type: string}` |
| `CHECK_PROPERTIES` | 批量读回属性值 | `{prop1: value1, prop2: value2}` |
| `CHECK_CHILDREN` | 验证子节点数量和类型 | `{count: int, types: string[]}` |

### L2 模板（`delivery.ts` 内联）

| 模板 | 用途 | 输出 |
|---|---|---|
| `SCENE_INTEGRITY` | 扫描节点引用、脚本附件、信号连接 | `{broken_refs: [], missing_scripts: [], broken_signals: []}` |
| `RESOURCE_CHECK` | 检查 preload/load 引用的文件是否存在 | `{missing_resources: []}` |
| `ASSERTION_WRAPPER` | 包装自定义断言代码 | `{result: value, passed: bool}` |

### 模板设计原则

- 每个模板是纯函数，接收参数返回 GDScript 字符串
- 输出统一走 `_mcp_output()` 协议
- 不引入外部依赖，纯 Godot 内置 API
- 每个模板力求精简（L1 模板 < 30 行，L2 复杂模板如 SCENE_INTEGRITY 允许 < 60 行）

### L2 断言包装示例

```gdscript
# ASSERTION_WRAPPER
func _initialize():
    _mcp_load_main_scene()
    var _result = {用户断言代码}
    _mcp_output("assert_result", str(_result))
```

## 范围外事项

- 不实现自动修复逻辑
- 不新增 Godot 项目内的 Autoload 插件
- 不合并 `test_assert` / `test_stress` 等已有工具的对外接口（但内部可复用其 GDScript 生成逻辑）
- 不实现 hook 机制（L1 通过工具注册层包装器注入）

## 边界测试场景

以下场景需在实现时编写测试覆盖：

| # | 场景 | 预期行为 |
|---|------|---------|
| 1 | L1 quickVerify GDScript 执行超时 | 返回 `{passed: false, error: "GDScript execution timeout"}`，工具主操作返回值不变 |
| 2 | L2 scope + checks 正交组合（scope=script + checks.scene_tree=true） | 只检查该脚本关联场景的树完整性，不扫描其他场景 |
| 3 | L2 自定义断言 GDScript 语法错误 | AssertionResult.error 填充编译错误信息，passed=false |
| 4 | L2 超过 10 个自定义断言 | 返回错误 `"Too many assertions (max 10)"`，不执行任何断言 |
| 5 | dev_loop 同时传 acceptance + verify | 按序执行：exec(code) → validate → exec(assertions)，两个验证机制独立运行 |
| 6 | L1 add_node verify=true 但节点类型不匹配 | checks 中 type_mismatch 项 failed，passed=false |
| 7 | L1 edit_node verify=true 但属性被后续操作覆盖 | checks 中 property_mismatch 项 failed，passed=false |
| 8 | L1 write_script verify=true 但 lint 发现 deprecated API | checks 中 lint_warning 项 failed（severity=warning），passed=false |
| 9 | L1 多次 verify 后 L2 verify_delivery 状态一致 | L2 报告与 L1 累计结果一致 |
| 10 | L1 verify=false 后 L2 发现 L1 应捕获的问题 | L2 正常报告，L1 未执行不影响 L2 |
| 11 | L2 scope=script 但脚本无关联场景 | scene_tree 维度 passed，issues 为空 |
| 12 | L2 scope=script 脚本关联 3 个场景 | 3 个场景均检查树完整性 |
| 13 | L2 场景通过 Autoload 间接引用脚本 | 不算直接关联，scope=script 不检查该场景 |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | clean | 18 issues (7 initial + 4 prior + 7 cross-review), 0 critical gaps |
| Cross-Review | 2 份外部审查意见 | 独立审查补充 | — | integrated | 7 additional findings adopted |

**VERDICT:** ENG CLEARED — all 18 findings resolved. 0 unresolved, 0 critical gaps.

### Key Decisions (Lake Score: 16/16)

**第一轮（plan-eng-review）：**

1. **L1 复用操作进程** — quickVerify 在操作进程内执行，不单独启动 Godot headless
2. **内部复用 test_assert 模板** — quickVerify 共享 test_assert 的 GDScript 生成逻辑
3. **关联场景反查** — scope=script 通过扫描 .tscn 文件的 script 引用反查关联场景
4. **断言信任模型** — 文档声明断言代码无沙箱，信任 MCP 调用方
5. **error 与 checks 共存** — QuickVerifyResult 不再互斥，支持部分检查完成
6. **Issue.suggestion optional** — 采纳 prior eng review 建议
7. **提取公共 wrapAssertionCode** — dev_loop 和 delivery.ts 共享断言包装器
8. **补充 8 个边界测试场景** — 覆盖 L1 负面场景、L1/L2 交互、关联反查边界
9. **性能基准规模** — 注明"基于 50 场景 / 100 脚本项目"

**第二轮（cross-review 补充）：**

10. **L1 定位修正** — 设计目标删除"自动"一词，改为"可选的快速验证层"。verify 保持默认 false，但文档措辞与实现行为一致
11. **L1 单文件验证变体** — 为 L1 提供 `validate_script_single(path)` 轻量变体，仅解析目标文件语法，不做全项目 lint。避免 validate_scripts 的全项目扫描违背 L1 单点检查原则
12. **性能维度有效指标枚举** — headless 下只采集 `orphan_node_count`、`static_memory_usage`、`resource_count`，不采集 FPS/帧时间。设计方案的性能维度检查项需更新
13. **信号检查范围明确** — 只检查 .tscn 静态信号（`[connection]` 段），文档注明动态信号（`connect()` 调用）属运行时测试范畴
14. **dev_loop 断言进程语义统一** — 配合决策 #1（进程复用），dev_loop acceptance 在同一进程内执行。删除文档中"独立进程"的矛盾表述
15. **orphan_node_count 改为瞬时报告** — L2 只报告当前值，不承诺前后对比。Claude 可自行对比多次 verify_delivery 调用的结果
16. **工具注册层包装器** — quickVerify 在 `tool-registry.ts` 层统一注入写操作工具，而非硬编码到各工具文件末尾。新增工具自动获得 L1 验证能力

### 已修改的设计方案章节

| 章节 | 修改内容 | 对应决策 |
|------|---------|---------|
| 设计目标 | "自动快速检查"→"可选的快速验证层" | #10 |
| L1 性能约束 | 总耗时改为"复用操作进程，无额外进程启动开销" | #1 |
| L1 涉及工具表 | write_script 检查方式改为 validate_script_single() | #11 |
| L2 维度3 性能检查 | 有效指标枚举为 orphan_node_count/static_memory/resource_count | #12 |
| L2 维度1 场景树 | 信号检查限定为静态信号，注明动态信号不覆盖 | #13 |
| L2 维度3 性能检查 | 删除"对比操作前后"描述，改为"报告当前瞬时值" | #15 |
| dev_loop 断言对比表 | 删除"独立进程"表述，统一为"同一进程" | #14 |
| 实现结构 | 删除各工具文件的 quickVerify 硬编码，改为注册层注入 | #16 |
