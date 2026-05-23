# GDScript Lint 规则引擎与代码模板系统设计

> 日期: 2026-05-18
> 状态: Draft (Reviewed — eng-review 9c638a9 + API 事实核对 + plan-eng-review 8项修订)
> 来源: 批量创建 33 个 3D demo 时踩过的所有 API 陷阱

## 问题背景

在 Godot 4.6 中批量创建 demo 时，LLM 生成的 GDScript 代码出现了 12 类重复性错误。这些错误在 Godot 编辑器中才暴露（运行时 crash 或属性赋值失败），而 MCP 工具的 `validate_scripts` 只能检查语法，无法检测 API 语义错误。

核心痛点：
1. **LLM 训练数据混杂** — Godot 3.x/4.x/4.6 的 API 共存，生成代码常引用已重命名/已移除的属性
2. **时序陷阱** — `look_at()` 要求节点在树中、`AStarGrid2D` 要求先 `update()` 等
3. **缺少正确模板** — 每次从零生成 Camera3D/RigidBody3D 代码，容易踩同一个坑

## 设计目标

1. `write_script` / `edit_script` / `batch_create_files` 写入 .gd 文件后，自动运行 lint 规则，在返回结果中包含警告
2. 常见模式（相机设置、刚体弹跳等）提供经过验证的代码模板
3. `get_class_info` 返回的属性列表标注 Godot 4.6 中的重命名/移除

## 与现有代码的冲突

> **审查发现 (关键):** `src/tools/validation.ts:40` 的 `KNOWN_BASE_METHODS` 白名单包含
> `bounce`、`friction`、`mass`、`linear_damping` 等属性。这些属性正是 lint 规则 L002/L006
> 要拦截的"已废弃属性"。当前白名单让 `RigidBody3D.bounce = 0.4` 通过验证，而 lint 引擎
> 要将其标记为 error — 形成直接矛盾。

**清理计划:**

1. 从 `KNOWN_BASE_METHODS` 中移除以下条目（由 lint 引擎接管检测）：
   - `bounce`、`friction` — L002 规则（RigidBody3D → PhysicsMaterial）
   - **`mass` 保留** — `RigidBody3D.mass` 在 Godot 4.6 中仍然有效，只有 `SoftBody3D.mass` 被重命名为 `total_mass`。L006 规则通过 headless 语义验证区分类型，不从白名单全局移除 `mass`
2. 移除后需运行现有 `validate_scripts` 回归测试，确认不破坏其他属性的验证
3. 清理与 lint 引擎实现在同一 PR 中完成，不分拆

> **API 核对注记:** `RigidBody3D.mass` 在 Godot 4.6 官方文档中确认有效。
> 白名单中 `mass` 保留，L006 仅通过 headless 类型上下文拦截 `SoftBody3D.mass`。

## P0: GDScript 运行时 Lint 引擎

### 位置

`src/tools/gdscript-lint.ts`

### 检测策略: 两阶段

**阶段 1 — 正则初筛:**
14 条规则中 12 条使用正则匹配，快速扫描标记疑似问题（< 1ms/文件）。

**阶段 2 — Godot headless 语义验证:**
对正则初筛的命中项，通过 headless 验证确认。排除以下误报场景：
- 注释中的代码（`# rb.bounce = 0.4`）
- 字符串中的代码（`var desc = "bounce = 0.4"`）
- 非 RigidBody3D 类型的 `.bounce` 赋值（字典、自定义类等）

**说明:** 阶段 2 增加延迟，但仅在正则初筛命中时触发。对于 `batch_create_files` 的批量场景，
阶段 1 汇总所有命中后批量提交一次 headless 验证，避免逐文件往返。

### 规则列表

| ID | 严重度 | 规则 | 检测方式 | 作用域限制 |
|----|--------|------|----------|-----------|
| L001 | error | `look_at()` 在 `add_child()` 之前调用 | 扫描同函数内调用顺序 | **仅同函数内** |
| L002 | error | `RigidBody3D.bounce = ...` 直接赋值 | 正则匹配 `\.bounce\s*=` | headless 验证变量类型 |
| L003 | error | `CylinderMesh.radius = ...` | 正则匹配 `CylinderMesh.*\.radius\s*=` | suggestion: 分别设置 `top_radius` 和 `bottom_radius` |
| L004 | error | `Environment.adjustments_*` (带 s) | 正则匹配 `adjustments_` | — |
| L005 | error | `Environment.tone_mapper` | 正则匹配 `\.tone_mapper\s*=` | — |
| L006 | error | `SoftBody3D.mass = ...` (应用 total_mass) | 正则匹配 `SoftBody3D.*\.mass\s*=` | — |
| L007 | error | `Node3D.visibility_range_begin/end` | 正则匹配 `visibility_range_` + headless 语义验证 | 属性迁移至 `GeometryInstance3D`，需语义验证排除合法子类，见作用域说明 |
| L008 | error | `ArrayMesh.create_triangle_shape()` | 正则匹配 `create_triangle_shape` | — |
| L009 | error | `Node.get_child_or_null()` (4.x 已移除) | 正则匹配 `get_child_or_null` | — |
| L010 | error | `FogMaterial.albedo_color` (应用 albedo) | 正则匹配 `FogMaterial.*\.albedo_color` | `albedo` ≠ `emission`，见作用域说明 |
| L011 | error | `Environment.physically_based_lights_enabled` | 正则匹配 `physically_based_lights_enabled` | — |
| L012 | error | `Line2D.dash_pattern = [...]` 非类型化数组 | 检测 `dash_pattern = [` | **不检测变量间接赋值** |
| L013 | error | `CharacterBody3D` 使用 `body_entered` 信号 | 正则匹配 `CharacterBody.*body_entered` | — |
| L014 | warn | `AStarGrid2D.update()` 清除了 `set_point_solid()` 设置 | 扫描同函数内调用顺序 | **仅同函数内**，见作用域说明 |
| L015 | error | `_process`/`_physics_process` 内调用 RigidBody3D `look_at()` | 检测 `_process`/`_physics_process` 内 `look_at` 调用 | 官方警告会破坏物理模拟 |
| L016 | warn | `add_child()` 后同函数内立即访问子节点方法 | 检测 `add_child(x)` 后紧接 `x.method()` | `_ready` 时序陷阱 |

**L001/L014/L016 作用域说明:** 调用顺序检测限制为**同一函数体内**的正向顺序。跨函数调用（如 `_ready` 中 `add_child`，`_process` 中 `look_at`）不在检测范围内 — 这类场景需要完整的控制流分析，超出正则引擎能力。

**L012 作用域说明:** 仅检测直接字面量赋值 `line.dash_pattern = [...]`。通过变量间接赋值（`var p := PackedFloat32Array([1,2]); line.dash_pattern = p`）不在检测范围内。

**L014 语义修正:** `set_point_solid()` 本身**不需要**先调用 `update()`。官方文档明确标注 "Calling update() is not needed after the call of this function"。真正的陷阱是 `update()` 会**清除所有 point data**（包括 solidity 和 weight scale）。所以正确顺序是 `update()` → `set_point_solid()`。当前规则检测的是"先 set_point_solid 后 update"的反模式，因为 update 会清除之前的 solid 设置。

**L007 属性归属说明:** `visibility_range_begin/end` 在 Godot 4.x 中不是从 `Node3D` 移除的，而是位于继承链上层的 `GeometryInstance3D`（MeshInstance3D < GeometryInstance3D < VisualInstance3D < Node3D）。LLM 常在 `Node3D` 上下文中引用这些属性导致错误。suggestion 应指向 `GeometryInstance3D.visibility_range_begin`。**需要语义验证**：纯正则无法区分 `node.visibility_range_begin`（Node3D，非法）和 `mesh.visibility_range_begin`（MeshInstance3D，合法），必须通过 headless 验证变量是否为纯 Node3D（非 GeometryInstance3D 子类）。

**L010 属性语义说明:** `FogMaterial` 在 Godot 4.6 中同时拥有 `albedo`（单次散射颜色）和 `emission`（自发光颜色）两个独立属性，功能完全不同。旧属性 `albedo_color` 应映射到 `albedo`，**不是** `emission`。若误用 `emission` 替代，会将雾的散射色错误改为自发光色，导致视觉效果完全错误。

**L015 物理破坏说明:** 官方文档明确警告：在 `_process` 或 `_physics_process` 中对 RigidBody3D 每帧调用 `look_at()` 会破坏物理模拟。正确做法是在 `_integrate_forces()` 中实现跟随逻辑。

### 实现方案

```typescript
interface LintRule {
  id: string;
  severity: "error" | "warning";
  pattern: RegExp;
  message: string;
  suggestion: string;
  // 两阶段: 阶段 2 是否需要 headless 语义验证
  requiresSemanticValidation?: boolean;
  // 语义验证函数: 接收 headless 上下文，排除误报
  semanticFilter?: (match: RegExpMatchArray, context: SemanticContext) => boolean;
}

interface LintResult {
  rule: string;
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
  confirmed: boolean; // true = 阶段 2 已确认, false = 仅正则初筛
  fixable: boolean;   // 是否可通过模板自动修复
}

interface SemanticContext {
  // 匹配位置前 N 行的变量声明和类型信息
  precedingLines: string[];  // 匹配位置前 50 行的变量声明和类型信息
  // 是否在注释中
  isInComment: boolean;
  // 是否在字符串中
  isInString: boolean;
}

function lintGDScript(code: string, skipSemantic?: boolean): LintResult[] {
  const results: LintResult[] = [];
  for (const rule of RULES) {
    const matches = code.matchAll(rule.pattern.global ? rule.pattern : new RegExp(rule.pattern.source, "g"));
    for (const match of matches) {
      // 阶段 1: 正则初筛 — 始终执行
      const preliminary: LintResult = {
        rule: rule.id,
        severity: rule.severity,
        line: getLineNumber(code, match.index),
        message: rule.message,
        suggestion: rule.suggestion,
        confirmed: false,
      };

      // 快速排除: 注释和字符串中的匹配
      if (isInCommentOrString(code, match.index)) {
        continue;
      }

      // 阶段 2: 如果规则需要语义验证且未跳过
      if (rule.requiresSemanticValidation && rule.semanticFilter && !skipSemantic) {
        const context = extractSemanticContext(code, match);
        if (rule.semanticFilter(match, context)) {
          preliminary.confirmed = true;
          results.push(preliminary);
        }
        // 语义验证未通过 = 误报，不加入结果
      } else {
        // 纯正则规则默认 confirmed=true（不需要语义验证）
        preliminary.confirmed = true;
        results.push(preliminary);
      }
    }
  }
  return results;
}
```

### 集成点

1. `write_script` — 写入后自动 lint，返回结果中包含 `lint` 字段
2. `edit_script` — 编辑后自动 lint（仅 lint 变更区域 + 上下文）
3. `batch_create_files` — 批量创建后汇总所有 lint 结果，阶段 2 批量提交
4. `validate_scripts` — 增强现有验证，语法检查通过后追加 lint 检查

### 性能约束

- **阶段 1 (正则):** < 1ms/文件，16 条规则逐条扫描
- **阶段 2 (headless):** 仅对阶段 1 命中项触发，batch 场景合并为一次 headless 调用
- **只对 .gd 文件运行 lint** — .tscn、.tres、.gdshader 等文件跳过
- **edit_script 部分 lint** — 仅扫描变更行 ± 10 行上下文，不全文件扫描

### 返回格式增强

```json
{
  "success": true,
  "lint": {
    "errors": [
      {
        "rule": "L002",
        "line": 45,
        "message": "RigidBody3D.bounce 在 Godot 4 中不存在",
        "suggestion": "使用 PhysicsMaterial: var mat := PhysicsMaterial.new(); mat.bounce = 0.4; body.physics_material_override = mat",
        "confirmed": true
      }
    ],
    "warnings": []
  }
}
```

## P1: 代码模板系统

### 位置

`src/tools/code-templates.ts`

### 集成方式

**主路径: 仅通过 lint suggestion 集成。**

模板不单独注入系统提示（避免 token 占用），不添加独立 MCP tool（避免增加 API 表面积）。
模板代码作为 lint 规则的 `suggestion` 字段返回，LLM 看到 lint 报错时直接获得正确代码。

```
lint 报错 (L002)
  → suggestion 字段包含 T002 模板代码
    → LLM 基于模板代码修复
```

### 模板列表

| 模板 ID | 名称 | 关联 lint 规则 | 覆盖场景 |
|---------|------|---------------|----------|
| T001 | camera3d_setup | L001 | Camera3D + look_at，保证 add_child 在前 |
| T002 | rigidbody3d_with_bounce | L002 | RigidBody3D + PhysicsMaterial + CollisionShape3D |
| T003 | area3d_detection | L013 | Area3D 子节点用于碰撞检测（CharacterBody3D 场景） |
| T004 | environment_adjustments | L004, L005, L011 | WorldEnvironment + 色彩校正（正确属性名） |
| T005 | softbody3d_setup | L006 | SoftBody3D（正确属性名 total_mass/damping_coefficient） |
| T006 | astar_grid_setup | L014 | AStarGrid2D（先 update 再 set_point_solid） |
| T007 | line2d_dashed | L012 | Line2D + dash_pattern（PackedFloat32Array） |

### 模板格式

每个模板是一个函数，接收参数返回 GDScript 代码片段：

```typescript
interface CodeTemplate {
  id: string;
  name: string;
  description: string;
  relatedRules: string[];  // 关联的 lint 规则 ID
  params: TemplateParam[];
  generate: (params: Record<string, any>) => string;
  verifiedGodotVersion: string;  // 模板验证的 Godot 版本（如 "4.6"）
  lastVerified: string;          // 最后验证日期（ISO 格式）
}

// 示例: T002 rigidbody3d_with_bounce
const rigidbodyWithBounce: CodeTemplate = {
  id: "T002",
  name: "rigidbody3d_with_bounce",
  description: "创建带弹跳的 RigidBody3D",
  relatedRules: ["L002"],
  verifiedGodotVersion: "4.6",
  lastVerified: "2026-05-18",
  params: [
    { name: "position", type: "Vector3", default: "Vector3.ZERO" },
    { name: "radius", type: "float", default: "0.5" },
    { name: "bounce", type: "float", default: "0.4" },
    { name: "mass", type: "float", default: "1.0" },
    { name: "color", type: "Color", default: "Color.WHITE" },
  ],
  generate: (p) => `
var rb := RigidBody3D.new()
rb.position = ${p.position}
rb.mass = ${p.mass}
var phys_mat := PhysicsMaterial.new()
phys_mat.bounce = ${p.bounce}
rb.physics_material_override = phys_mat
var mesh_inst := MeshInstance3D.new()
var sphere := SphereMesh.new()
sphere.radius = ${p.radius}
sphere.height = ${p.radius} * 2.0
mesh_inst.mesh = sphere
var mat := StandardMaterial3D.new()
mat.albedo_color = ${p.color}
mesh_inst.material_override = mat
rb.add_child(mesh_inst)
var col := CollisionShape3D.new()
var shape := SphereShape3D.new()
shape.radius = ${p.radius}
col.shape = shape
rb.add_child(col)
add_child(rb)
`.trim(),
};
```

## P2: get_class_info 废弃属性标注

### 位置

`src/tools/docs.ts`（修改现有 `get_class_info` 实现）

### 实现方案

在 `get_class_info` 返回的属性列表中，对 Godot 4.6 已重命名/移除的属性添加注释：

```typescript
// 已知废弃属性映射表
const DEPRECATED_PROPERTIES: Record<string, Record<string, { removed: boolean; replacement?: string }>> = {
  "Environment": {
    "adjustments_enabled": { removed: false, replacement: "adjustment_enabled" },
    "adjustments_brightness": { removed: false, replacement: "adjustment_brightness" },
    "adjustments_contrast": { removed: false, replacement: "adjustment_contrast" },
    "adjustments_saturation": { removed: false, replacement: "adjustment_saturation" },
    "tone_mapper": { removed: false, replacement: "tonemap_mode" },
    "physically_based_lights_enabled": { removed: true },
  },
  "Node3D": {
    "visibility_range_begin": { removed: false, replacement: "GeometryInstance3D.visibility_range_begin" },
    "visibility_range_end": { removed: false, replacement: "GeometryInstance3D.visibility_range_end" },
  },
  "SoftBody3D": {
    "mass": { removed: false, replacement: "total_mass" },
    "linear_damping": { removed: false, replacement: "damping_coefficient" },
  },
  "RigidBody3D": {
    "bounce": { removed: true, replacement: "PhysicsMaterial.bounce via physics_material_override" },
    "friction": { removed: true, replacement: "PhysicsMaterial.friction via physics_material_override" },
  },
  "CylinderMesh": {
    "radius": { removed: true, replacement: "top_radius 和 bottom_radius 分别设置" },
  },
  "FogMaterial": {
    "albedo_color": { removed: false, replacement: "albedo" },  // 不是 emission！albedo 是散射色，emission 是自发光色
  },
};
```

### 返回格式增强

```json
{
  "class_name": "Environment",
  "properties": [
    {
      "name": "adjustment_enabled",
      "type": "bool",
      "deprecated_notes": null
    },
    {
      "name": "tonemap_mode",
      "type": "int",
      "deprecated_notes": "Godot 4.6 重命名自 tone_mapper"
    }
  ],
  "deprecated_warnings": [
    "旧属性 adjustments_enabled（带 s）已重命名为 adjustment_enabled（不带 s）"
  ]
}
```

## 文件分布

```
src/
  tools/
    gdscript-lint.ts      # P0: lint 规则引擎（新增）
    code-templates.ts     # P1: 代码模板（新增）
    validation.ts         # 修改: 清理 KNOWN_BASE_METHODS 白名单 + 集成 lint
    scene.ts              # 修改: 集成 lint 到 write_script/edit_script
    batch-tools.ts        # 修改: batch_create_files 集成 lint + 批量语义验证
    docs.ts               # 修改: get_class_info 增加废弃标注（P2）
  helpers.ts              # 复用: getLineNumber() 工具函数（如已存在）
  GodotServer.ts          # 修改: 注册 lint 相关工具
```

## 实施优先级

1. **P0** (lint 引擎) — 投入产出比最高，一次实现永久受益
2. **P1** (代码模板) — 作为 lint suggestion 的副产品，减少未来生成错误
3. **P2** (废弃标注) — 锦上添花，防止 LLM 询问属性时拿到错误信息

**实施顺序约束:** KNOWN_BASE_METHODS 白名单清理与 P0 lint 引擎在同一 PR 中完成。

## 维护策略

### 规则集版本适配

- `DEPRECATED_PROPERTIES` 和 lint 规则集绑定到具体 Godot 版本（当前 4.6）
- 每个 Godot 小版本发布时（4.7/4.8/...），需人工审查：
  1. 新增的重命名/移除属性 → 更新 DEPRECATED_PROPERTIES + 新增 lint 规则
  2. 旧规则是否仍然有效 → 移除不再适用的规则
  3. 正则模式是否需要调整 → API 变更可能影响匹配精度

### CI 测试保障

每个 lint 规则必须包含 3 类测试（详见测试方案），CI 在每次提交时运行。
新增/修改 lint 规则时，对应测试必须同步更新 — CI 失败则阻止合并。

### 规则集元数据

```typescript
const LINT_VERSION = {
  godot_target: "4.6",
  last_reviewed: "2026-05-18",
  rules_count: 16,
  breaking_changes_since: "4.5",
  changelog_url: "https://godotengine.org/article/godot-4-6-release-candidate-2",
};
```

`lintGDScript()` 返回结果中包含此元数据，方便调用方判断规则集是否适配当前 Godot 版本。

### 规则失效检测

当 Godot 升级时，某些规则可能不再适用（如废弃 API 被重新引入，或修复了某类 bug）。CI 中应加入：
- 对新版 Godot 的每个规则进行回归测试
- 当某个规则命中率在真实项目中持续为零（超过阈值）时，发出提醒检查是否需要移除
- 通过 `LINT_VERSION.rules_count` 变化追踪规则增减

## 测试方案

### 测试矩阵

每条 lint 规则需要 3 类测试用例：

| 类别 | 说明 | 示例 (L002) |
|------|------|-------------|
| **命中** | 应该报错的代码 | `rb.bounce = 0.4` |
| **忽略** | 不应报错的正确代码 | `phys_mat.bounce = 0.4` |
| **边界** | 注释/字符串/间接赋值 | `# rb.bounce = 0.4` |

### 完整测试列表

#### P0: Lint 规则测试（16 × 3 = 48 个用例）

```
L001 look_at 顺序
  ├─ 命中: _ready 内 look_at 在 add_child 前
  ├─ 忽略: _ready 内 add_child 在 look_at 前
  └─ 边界: _process 内 look_at（不在检测范围）

L002 RigidBody3D.bounce
  ├─ 命中: rb.bounce = 0.4
  ├─ 忽略: phys_mat.bounce = 0.4
  └─ 边界: # rb.bounce = 0.4 (注释)

L003 CylinderMesh.radius
  ├─ 命中: CylinderMesh.new(); mesh.radius = 0.5
  ├─ 忽略: SphereMesh.new(); mesh.radius = 0.5
  └─ 边界: var cylinder_radius = 0.5 (变量名包含 radius)

L004 Environment.adjustments_*
  ├─ 命中: env.adjustments_enabled = true
  ├─ 忽略: env.adjustment_enabled = true
  └─ 边界: # adjustments_enabled is deprecated (注释)

L005 Environment.tone_mapper
  ├─ 命中: env.tone_mapper = 1
  ├─ 忽略: env.tonemap_mode = 1
  └─ 边界: var tone_mapper_value = 1 (变量名)

L006 SoftBody3D.mass
  ├─ 命中: SoftBody3D.new(); body.mass = 2.0
  ├─ 忽略: RigidBody3D.new(); body.mass = 2.0
  └─ 边界: var softbody_mass = 2.0 (变量名)

L007 Node3D.visibility_range_* (实际位于 GeometryInstance3D)
  ├─ 命中: node.visibility_range_begin = 5.0 (在 Node3D 上下文中引用)
  ├─ 忽略: mesh.visibility_range_begin = 5.0 (MeshInstance3D 继承自 GeometryInstance3D，合法)
  └─ 边界: # visibility_range_begin (注释)

L008 ArrayMesh.create_triangle_shape
  ├─ 命中: mesh.create_triangle_shape()
  ├─ 忽略: mesh.create_triangle_mesh() (正确 API)
  └─ 边界: var shape = create_triangle_shape() (函数名但非 ArrayMesh 调用)

L009 Node.get_child_or_null
  ├─ 命中: get_child_or_null(0)
  ├─ 忽略: get_child(0) or find_child("name")
  └─ 边界: # get_child_or_null (注释)

L010 FogMaterial.albedo_color → albedo (不是 emission!)
  ├─ 命中: FogMaterial.new(); fog.albedo_color = Color.RED
  ├─ 忽略: FogMaterial.new(); fog.albedo = Color.RED (正确属性名)
  └─ 边界: fog.emission = Color.RED (合法，emission 是独立属性，不应被拦截)

L011 Environment.physically_based_lights_enabled
  ├─ 命中: env.physically_based_lights_enabled = true
  ├─ 忽略: (无正确用法，属性已移除)
  └─ 边界: # physically_based_lights_enabled (注释)

L012 Line2D.dash_pattern
  ├─ 命中: line.dash_pattern = [1.0, 2.0]
  ├─ 忽略: line.dash_pattern = PackedFloat32Array([1.0, 2.0])
  └─ 边界: var pattern := PackedFloat32Array([1,2]); line.dash_pattern = pattern (间接赋值，不在范围)

L013 CharacterBody3D.body_entered
  ├─ 命中: CharacterBody3D; body.body_entered.connect(...)
  ├─ 忽略: Area3D; area.body_entered.connect(...)
  └─ 边界: # body_entered signal (注释)

L014 AStarGrid2D update 清除 point data
  ├─ 命中: _ready 内先 set_point_solid 后 update（update 清除了 solid 设置）
  ├─ 忽略: _ready 内先 update 后 set_point_solid（正确顺序）
  └─ 边界: _process 内 set_point_solid (不在检测范围)

L015 RigidBody3D.look_at 在 _process 内
  ├─ 命中: _physics_process 内 rigidbody.look_at(target)
  ├─ 忽略: _integrate_forces 内实现跟随逻辑
  └─ 边界: _ready 内一次性 look_at (合法)

L016 add_child 后立即访问子节点
  ├─ 命中: add_child(node); node.set_something() (同函数内)
  ├─ 忽略: add_child(node); await get_tree().process_frame; node.set_something()
  └─ 边界: add_child 在 func A，node.set_something 在 func B (跨函数，不在范围)
```

#### P0: 集成测试（4 个用例）

```
write_script 集成
  ├─ 返回结果包含 lint 字段
  └─ lint 语义验证命中时 confirmed=true

edit_script 集成
  ├─ 仅 lint 变更区域 ± 10 行
  └─ 变更区域外的问题不触发

batch_create_files 集成
  ├─ 汇总所有 .gd 文件的 lint 结果
  └─ 非 .gd 文件跳过 lint

validate_scripts 集成
  ├─ 白名单清理后 bounce/friction 不再被忽略
  ├─ mass 保留在白名单（RigidBody3D.mass 仍有效）
  └─ lint 报错不影响语法验证通过/失败判断
```

#### P1: 模板自测（7 个用例）

每个模板生成的代码必须通过 lint 引擎零报错验证：

```
T001 camera3d_setup
  └─ 生成代码 → lintGDScript() → 应 0 errors

T002 rigidbody3d_with_bounce
  └─ 生成代码 → lintGDScript() → 应 0 errors（尤其不应触发 L002）

T003 area3d_detection
  └─ 生成代码 → lintGDScript() → 应 0 errors

T004 environment_adjustments
  └─ 生成代码 → lintGDScript() → 应 0 errors（不应触发 L004/L005/L011）

T005 softbody3d_setup
  └─ 生成代码 → lintGDScript() → 应 0 errors（不应触发 L006）

T006 astar_grid_setup
  └─ 生成代码 → lintGDScript() → 应 0 errors（不应触发 L014）

T007 line2d_dashed
  └─ 生成代码 → lintGDScript() → 应 0 errors（不应触发 L012）
```

#### P2: 废弃标注测试（1 个用例）

```
get_class_info 返回格式
  └─ 废弃属性出现在 deprecated_warnings 中，replacement 正确
```

### 测试代码示例

```typescript
describe("GDScript Lint", () => {
  // ─── L002: RigidBody3D.bounce ───

  it("L002: 检测 RigidBody3D.bounce 直接赋值", () => {
    const code = `rb.bounce = 0.4`;
    const results = lintGDScript(code, true); // skipSemantic for unit test
    expect(results).toContainEqual(
      expect.objectContaining({ rule: "L002" })
    );
  });

  it("L002: 不误报 PhysicsMaterial.bounce", () => {
    const code = `phys_mat.bounce = 0.4`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L002")).toBeUndefined();
  });

  it("L002: 注释中的 bounce 不触发", () => {
    const code = `# rb.bounce = 0.4`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L002")).toBeUndefined();
  });

  // ─── L001: look_at 顺序 (仅同函数) ───

  it("L001: _ready 内 look_at 在 add_child 前报错", () => {
    const code = `
func _ready():
  var cam := Camera3D.new()
  cam.look_at(target)
  add_child(cam)`;
    const results = lintGDScript(code, true);
    expect(results).toContainEqual(
      expect.objectContaining({ rule: "L001" })
    );
  });

  it("L001: _process 内 look_at 不报错", () => {
    const code = `
func _ready():
  add_child(cam)
func _process(delta):
  cam.look_at(target)`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L001")).toBeUndefined();
  });

  // ─── 集成: 白名单清理 ───

  it("validate_scripts: bounce 不再被 KNOWN_BASE_METHODS 忽略", async () => {
    // 清理白名单后，RigidBody3D.bounce 应由 lint 而非白名单处理
    const code = `extends RigidBody3D\nfunc _ready(): bounce = 0.4`;
    const result = await validateScript(code);
    expect(result.lint?.errors).toContainEqual(
      expect.objectContaining({ rule: "L002" })
    );
  });

  // ─── L010: FogMaterial.albedo_color → albedo (非 emission!) ───

  it("L010: FogMaterial.albedo_color 报错，建议用 albedo", () => {
    const code = `var fog := FogMaterial.new()\nfog.albedo_color = Color.RED`;
    const results = lintGDScript(code, true);
    expect(results).toContainEqual(
      expect.objectContaining({ rule: "L010", suggestion: expect.stringContaining("albedo") })
    );
    // suggestion 绝不应包含 "emission"
    expect(results.find(r => r.rule === "L010")?.suggestion).not.toContain("emission");
  });

  it("L010: FogMaterial.emission 不应被拦截", () => {
    const code = `var fog := FogMaterial.new()\nfog.emission = Color.RED`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L010")).toBeUndefined();
  });

  // ─── L014: AStarGrid2D update 清除 point data ───

  it("L014: 先 set_point_solid 后 update 报错", () => {
    const code = `
func _ready():
  var grid := AStarGrid2D.new()
  grid.set_point_solid(Vector2i(1, 1), true)
  grid.update()`;
    const results = lintGDScript(code, true);
    expect(results).toContainEqual(
      expect.objectContaining({ rule: "L014" })
    );
  });

  it("L014: 先 update 后 set_point_solid 不报错", () => {
    const code = `
func _ready():
  var grid := AStarGrid2D.new()
  grid.update()
  grid.set_point_solid(Vector2i(1, 1), true)`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L014")).toBeUndefined();
  });

  // ─── L015: RigidBody3D.look_at 在 _process 内 ───

  it("L015: _physics_process 内 look_at 报错", () => {
    const code = `
func _physics_process(delta):
  rb.look_at(target)`;
    const results = lintGDScript(code, true);
    expect(results).toContainEqual(
      expect.objectContaining({ rule: "L015" })
    );
  });

  it("L015: _ready 内一次性 look_at 不报错", () => {
    const code = `
func _ready():
  var cam := Camera3D.new()
  add_child(cam)
  cam.look_at(target)`;
    const results = lintGDScript(code, true);
    expect(results.find(r => r.rule === "L015")).toBeUndefined();
  });

  // ─── 白名单: RigidBody3D.mass 保留 ───

  it("validate_scripts: RigidBody3D.mass 仍被 KNOWN_BASE_METHODS 允许", async () => {
    const code = `extends RigidBody3D\nfunc _ready(): mass = 2.0`;
    const result = await validateScript(code);
    // mass 不应触发 L006（L006 仅拦截 SoftBody3D.mass）
    expect(result.lint?.errors?.find(r => r.rule === "L006")).toBeUndefined();
  });
});
```

### 与 gdlint 的关系定位

`Scony/godot-gdscript-toolkit` 提供了基于 AST 的 GDScript linter (`gdlint`)，但：
- `gdlint` 主要检测代码风格和最佳实践，**不检测 Godot 版本迁移相关的 API 废弃**
- 调用顺序检测（L001、L014）在正则下实现复杂，理论上 `gdlint` 的 AST 遍历更可靠

**定位:** API 废弃检测（L002-L013）自研（差异化价值），调用顺序检测（L001、L014、L017）可考虑未来复用 `gdlint` AST 能力。

### 阶段 2 的 LSP 复用评估

当前设计使用自定义 headless 验证。MCP 生态中已有多个 Godot LSP 集成方案（如 `minimal-godot-mcp` 直接通过 Godot 原生 LSP 获取诊断信息），可替代自定义 headless 调用链。

**当前决策:** P0 先用自定义 headless（完全控制，无额外依赖）。后续可评估迁移到 LSP 复用方案。

## NOT in scope

- **跨函数调用顺序追踪** — L001/L014 仅限同函数内检测，跨函数需完整控制流分析
- **变量间接赋值类型检测** — L012 的 `var p = [...]; line.dash_pattern = p` 不在检测范围
- **edit_script 自动修复** — 未来可能支持的 `auto_fix: true`，当前不设计
- **系统提示模板注入** — 模板不注入 MCP 系统提示，避免 token 占用
- **Godot 3.x 兼容** — lint 规则仅针对 Godot 4.6+，不检测 3.x 特有问题
- **非 GDScript 文件 lint** — .gdshader、.tscn、.tres 等文件不在 lint 范围内

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAN | 9 issues (首轮) + 8 items (本轮)，0 critical gaps |
| API Audit | 人工联网核对 | Godot 4.6 官方文档验证 | 1 | CLEAN | L010 事实错误已修正，L014 描述已修正，L007 归属已修正，新增 L015/L016 |

### plan-eng-review 修订记录 (2026-05-19)

| # | 发现 | 严重度 | 决议 |
|---|------|--------|------|
| 1 | L007 缺少语义验证（MeshInstance3D 合法使用会误报） | IMPORTANT | 添加 requiresSemanticValidation + headless 类型验证 |
| 2 | 清理计划 linear_damping 事实错误（不在白名单中） | IMPORTANT | 从清理计划移除该条目 |
| 3 | L015→L017 编号跳跃缺 L016 | ADVISORY | L017 重编号为 L016 |
| 4 | confirmed 字段语义二义性 | IMPORTANT | 纯正则规则默认 confirmed=true |
| 5 | P2 deprecated_warnings 示例措辞自相矛盾 | ADVISORY | 修正为"旧属性 X → 新属性 Y"格式 |
| 6 | precedingLines 窗口大小 N 未定义 | IMPORTANT | 明确 N=50 |
| 7 | L007 测试与规则定义不同步 | ADVISORY | 随 #1 同步更新 |
| 8 | P1 模板系统缺少测试方案 | IMPORTANT | 增加 7 个模板自测用例 |
