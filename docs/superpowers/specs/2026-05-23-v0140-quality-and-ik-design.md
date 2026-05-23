# v0.14.0 质量加固 + IK 框架 MVP 设计

> 日期: 2026-05-23
> 版本: v0.14.0
> 前置: v0.13.0 (d0b3b88)
> 策略: 方案 B — 质量加固与 IK 新功能并行推进

---

## 1. 目标

v0.14.0 是质量与新能力并重的版本：

- **质量加固**: 核心模块测试补全、安全加固、大文件重构、CI 集成
- **IK MVP**: Godot 4.6 IK 框架工具集最小可用版本
- **交付标准**: 774 现有测试 + ~40 新测试全部通过，tsc 编译无错误

---

## 2. 质量加固

### 2.1 核心测试补全

优先给无测试的核心模块补单测，复用 `test/helpers/tool-context.js` mock 框架。

| 模块 | 关键测试点 | 预估用例 |
|------|-----------|---------|
| `scene.ts` | read_scene、add_node、edit_node、remove_node、quick_scene、batch_add_nodes | 8-10 |
| `script.ts` | read_script、write_script lint 输出、edit_script search_and_replace、project_replace | 6-8 |
| `validation.ts` | validate_project、validate_scripts、run_and_verify 参数校验 | 4-5 |
| `navigation.ts` | nav_create_region、nav_query_path、nav_create_agent 参数校验 | 4-5 |
| `tscn-parser.ts` | parent="." 多层嵌套、空场景、unique_id 丢弃验证、instance 解析 | 4-5 |
| `ik-tools.ts`（新增） | 白名单校验、参数校验、GDScript 生成、骨骼配置、空 Skeleton | 6-8 |

测试范围：参数校验 + GDScript 生成代码正确性，不依赖 Godot 运行时。

### 2.2 安全加固

| 项目 | 当前问题 | 修复方案 |
|------|---------|---------|
| `validateIdentifier` 长度 | 无上限，可传入超长字符串 | 加 `name.length <= 64` 限制 |
| `validateIdentifier` 覆盖 | 部分入口未校验 | grep 确认所有 `args.name`/`args.type` 入口 |
| `script.ts` 超时边界 | timeout 参数无限制 | 限制范围 [5, 120] 秒 |

### 2.3 代码重构（独立 PR）

> **注意**: 文件拆分与本版本的其他工作无依赖关系，独立 PR 提交，降低风险。

拆分大文件，原文件保留为 barrel re-export：

| 文件 | 当前行数 | 拆分方案 |
|------|---------|---------|
| `ui-tools.ts` | 1583 | `ui-controls.ts`（create/set/layout）+ `ui-theme.ts`（theme/draw）+ `ui-build.ts`（build_layout） |
| `scene.ts` | 1024 | `scene-read.ts`（read/query/inspect）+ `scene-write.ts`（add/edit/remove/save） |

拆分原则：
- 不破坏外部导入（barrel re-export）
- 不改变工具名称和参数接口
- 拆分后立即运行全量测试验证

### 2.4 CI 集成

GitHub Actions 工作流：

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
```

触发条件：push to master + 所有 PR。

---

## 3. IK 框架工具集 MVP

### 3.1 工具清单与参数校验

| 工具名 | 功能 | 必需参数 | 可选参数 | 校验规则 |
|--------|------|---------|---------|---------|
| `ik_modifier_create` | 创建 IK 修改器节点 | `type`, `name`, `project_path` | `parent`, `position`, `bone_name`, `target_nodepath` | type 白名单校验；name validateIdentifier |
| `ik_modifier_get` | 读取 IK 节点属性 | `project_path`, `node_path` | — | node_path normalizeNodePath |
| `ik_modifier_set` | 设置 IK 参数 | `project_path`, `node_path`, `properties` | — | properties 白名单校验（仅允许已知属性名） |
| `ik_list_bones` | 列出 Skeleton3D 骨骼 | `project_path`, `node_path` | `limit` | limit 正整数，默认无限制 |

错误返回格式：统一使用 `opsErrorResult(errorCode, message)`，错误码：
- `INVALID_TYPE` — IK 类型不在白名单或为抽象类
- `INVALID_PROPERTY` — properties 含未知属性名
- `NODE_NOT_FOUND` — 目标路径不存在
- `SCRIPT_EXEC_FAILED` — GDScript 执行失败

### 3.2 IK 节点类型白名单

可实例化的具体类型：
- `TwoBoneIK3D` — 关键属性: bone_name, target_nodepath, use_magnet, magnet_position, influence
- `FABRIK3D` — 链式 IK
- `CCDIK3D` — 实时快速求解
- `SplineIK3D` — 样条曲线
- `JacobianIK3D` — 雅可比迭代

不可实例化（排除）：
- `SkeletonModifier3D` — 基类
- `IKModifier3D` — 抽象类

### 3.3 设计原则

- 复用 `node_create_3d` 模式（白名单 + `validateIdentifier`）
- IK 节点通常挂载到 Skeleton3D 下，parent 校验不强制（允许延迟挂载）
- headless 兼容性：5 种 IK 类型已在 Godot 4.6 兼容性报告中验证可实例化
- 运行时操作，不持久化（与其他 node_create_3d 系列一致）

### 3.4 ik_modifier_get 返回结构

```json
{
  "type": "TwoBoneIK3D",
  "active": true,
  "influence": 1.0,
  "bone_name": "RightForeArm",
  "target_nodepath": "root/Player/RightHandTarget",
  "use_magnet": false,
  "magnet_position": { "x": 0, "y": 0, "z": 0 },
  "skeleton_path": "root/Player/Skeleton3D",
  "bones": {
    "0": { "name": "Hips", "rest_position": { "x": 0, "y": 0.9, "z": 0 } }
  }
}
```

### 3.5 ik_modifier_set 可写属性

| 属性 | 类型 | 说明 | 适用类型 |
|------|------|------|---------|
| `active` | bool | 是否启用 | 所有 |
| `influence` | float 0-1 | 影响权重 | 所有 |
| `bone_name` | string | 要控制的骨骼名（非空） | TwoBoneIK3D |
| `target_nodepath` | string | IK 目标节点路径 | TwoBoneIK3D |
| `use_magnet` | bool | 启用磁极偏移 | TwoBoneIK3D |
| `magnet_position` | {x,y,z} | 肘部/膝盖偏移 | TwoBoneIK3D |

属性通过 `properties` 参数传入。`ik_modifier_set` 对属性名做白名单校验（仅允许上表中的属性），对 `bone_name` 做非空校验，对 `target_nodepath` 做格式校验。

---

## 4. v0.15.0 方向（仅记录，不展开设计）

| 功能 | 优先级 | 说明 |
|------|--------|------|
| mesh_to_collision | P1 | 一键从 MeshInstance3D 生成 CollisionShape3D |
| unique_id 解析 | P2 | tscn parser 扩展 ParsedNode.unique_id 字段 |
| 端到端可靠性 | P1 | headless→editor 行为差异文档化、Game Bridge 自动化测试 |

---

## 5. 交付标准

- [ ] 现有 774 测试 + 新增 ~50 测试全部通过（含 IK 工具 ~8 用例）
- [ ] `tsc --noEmit` 零错误
- [ ] 4 个 IK 工具在 headless 模式下可创建/读取/设置 IK 节点（含骨骼配置）
- [ ] GitHub Actions CI 绿色
- [ ] validateIdentifier 有长度限制 + 覆盖所有入口
- [ ] script.ts timeout 参数有边界校验

---

## 6. 工作顺序（本 PR）

1. 安全加固（validateIdentifier 长度、timeout 边界）— 先建护栏
2. 核心测试补全（scene、script、validation、navigation、tscn-parser）
3. IK 工具集 MVP（创建、骨骼配置、读取、设置、骨骼列表 + 测试）
4. CI 集成（GitHub Actions）
5. 版本发布（更新 package.json、CHANGELOG）

### 独立 PR（不阻塞本版本）

- 文件拆分（ui-tools.ts → 3 文件、scene.ts → 2 文件）
