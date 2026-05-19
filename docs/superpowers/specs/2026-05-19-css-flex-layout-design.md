# CSS Flex Layout 翻译层设计

**日期**: 2026-05-19
**状态**: 已审查，待实现
**审查决策**: 4 项架构修改 + 4 项审查修正（见附录 A）
**范围**: `src/tools/ui-tools.ts` + `test/ui-tools.test.js`

## 背景

AI 通过 MCP 工具生成 Godot UI 时，需要理解 Godot 原生 Container 系统（HBoxContainer、VBoxContainer、anchor、offset、size_flags），学习曲线陡峭。本设计在 `ui_build_layout` 工具中增加 CSS Flexbox 语义层，AI 用 `layout` 描述布局意图，MCP 侧翻译成原生 Container 嵌套。

**约束**: 零 Godot 插件依赖。生成的 GDScript 只包含原生节点，兼容所有 Godot 4.x 版本。

## 方案

**编译时 TypeScript 翻译**（方案 B）。在 `uiNodeToGd` 函数中，遇到 `layout` 字段时自动将容器类型替换为对应的原生 Container，设置 alignment/separation/size_flags 等属性。没有 `layout` 字段时行为不变——向后兼容。

## 数据模型

### FlexLayout（容器级）

```typescript
interface FlexLayout {
  direction: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  align?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  wrap?: 'nowrap' | 'wrap';
  gap?: number;
  row_gap?: number;
  padding?: number | [number, number, number, number];
}
```

### FlexChild（子级）

```typescript
interface FlexChild {
  grow?: number;
  shrink?: number;
  align_self?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch';
  min_width?: number;
  min_height?: number;
  max_width?: number;
  max_height?: number;
}
```

### UiNodeSpec 扩展

```typescript
interface UiNodeSpec {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  anchor_preset?: string;
  layout?: FlexLayout;    // 新增
  flex?: FlexChild;       // 新增
  children?: UiNodeSpec[];
}
```

**规则**: `layout` 存在时**覆盖** `type` — 容器类型完全由 `layout.direction` 决定，`type` 字段被忽略。无 `layout` 时行为不变。

## 翻译映射

### direction → Container

| direction | 容器类型 | 备注 |
|-----------|---------|------|
| `row` | `HBoxContainer` | |
| `column` | `VBoxContainer` | |
| `row-reverse` | `HBoxContainer` | TypeScript 层反转 children 数组顺序 |
| `column-reverse` | `VBoxContainer` | TypeScript 层反转 children 数组顺序 |

### justify → alignment

| justify | Godot 等价 | 精确度 |
|---------|-----------|--------|
| `flex-start` | `BoxContainer.ALIGNMENT_BEGIN` (0) | 精确 |
| `center` | `BoxContainer.ALIGNMENT_CENTER` (1) | 精确 |
| `flex-end` | `BoxContainer.ALIGNMENT_END` (2) | 精确 |
| `space-between` | 近似: `ALIGNMENT_BEGIN` + 子节点均设 `SIZE_EXPAND` + 等分 `stretch_ratio`（实现"按比例填充剩余空间"，非 CSS 首尾贴边效果） | ⚠️ 受限近似，warning 明确告知无法做到首尾贴边 |
| `space-around` | 近似: `ALIGNMENT_CENTER` | ⚠️ 受限近似，运行时输出 warning |
| `space-evenly` | 近似: `ALIGNMENT_CENTER` | ⚠️ 受限近似，运行时输出 warning |

### align → size_flags

| align | 效果 |
|-------|------|
| `stretch` | 子节点 `size_flags_vertical/horizontal \|= SIZE_EXPAND_FILL` |
| `flex-start` | 不设 expand |
| `center` | 子节点 `size_flags \|= SIZE_SHRINK_CENTER`（值 4），**注意**: 与 `SIZE_EXPAND`/`SIZE_FILL` 互斥，实现时需确保不叠加 EXPAND_FILL |
| `flex-end` | 不设 expand（Container 内子节点无法可靠实现 anchor 偏移） |

### wrap → FlowContainer

| wrap | 容器 |
|------|------|
| `nowrap` | BoxContainer（默认） |
| `wrap` | `HFlowContainer`（row）或 `VFlowContainer`（column） |

### gap

根据容器类型使用不同的 theme constant：

| 容器 | gap 翻译 |
|------|---------|
| `HBoxContainer` / `VBoxContainer` | `add_theme_constant_override("separation", gap)` |
| `HFlowContainer` | `add_theme_constant_override("h_separation", gap)` + `add_theme_constant_override("v_separation", row_gap ?? gap)` |
| `VFlowContainer` | `add_theme_constant_override("h_separation", row_gap ?? gap)` + `add_theme_constant_override("v_separation", gap)` |

> ⚠️ FlowContainer 的 theme properties 是 `h_separation` / `v_separation`，不是 `separation`。设置 `"separation"` 不会生效。

### row_gap

`row_gap` 仅在 `wrap: 'wrap'` 场景下有意义（控制换行行间距）。映射到 FlowContainer 的交叉轴 separation：
- `HFlowContainer`：`row_gap` → `v_separation`
- `VFlowContainer`：`row_gap` → `h_separation`

非 wrap 场景下 `row_gap` 被忽略，输出 warning。

### padding

**策略**: 优先使用容器的 theme override 设置内边距，避免额外 MarginContainer 嵌套。

| 容器类型 | padding 实现 |
|---------|-------------|
| `BoxContainer` | `add_theme_constant_override("margin_top/right/bottom/left", value)` — 直接在容器上设置，零额外嵌套 |
| `FlowContainer` | 外包 `MarginContainer`（FlowContainer 无 `margin_*` theme constant） |

MarginContainer 命名为 `{spec.name}_margin`，内部 Container 保持 `spec.name`。`_mcp_output` 中返回完整节点路径映射。

### flex（子级）→ size_flags

| flex 属性 | GDScript | 备注 |
|-----------|----------|------|
| `grow: N` | `size_flags_stretch_ratio = N; size_flags \|= SIZE_EXPAND` | EXPAND 设在主轴方向（row→horizontal, column→vertical），与 align 的交叉轴 EXPAND_FILL 不冲突 |
| `shrink` | 忽略，输出 warning | Godot 无对应概念 |
| `align_self` | 同 align 但只作用于该子节点 | |
| `min_width/height` | `custom_minimum_size.x/y` | |
| `max_width/height` | 忽略，输出 warning | Godot 无对应概念 |

## 代码生成流程

`uiNodeToGd` 函数修改：

```
if spec 有 layout:
  1. 容器类型由 layout.direction 决定，忽略 type 字段
  2. 如果 direction 含 reverse → 反转 children 数组顺序
  3. 如果 wrap == 'wrap' → 使用 FlowContainer 代替 BoxContainer
  4. 生成容器节点代码
  5. 设置容器属性:
     - alignment (justify 翻译)
     - gap → 根据容器类型选择 separation / h_separation / v_separation
  6. 如果有 padding:
     - BoxContainer → 直接 add_theme_constant_override("margin_*")
     - FlowContainer → 生成 MarginContainer 包裹层（命名 {name}_margin）
  7. 遍历 children:
     - 递归 uiNodeToGd 生成子节点
     - 应用 flex: size_flags, stretch_ratio, custom_minimum_size
       （grow 的 EXPAND 设在主轴，align 的 EXPAND_FILL 设在交叉轴，不冲突）
     - 应用 align / align_self（center 用 SIZE_SHRINK_CENTER，确保不叠加 EXPAND）
  8. 设置容器 anchor_preset（默认 full_rect）
     注意: 若父节点是 Container，anchor_preset 可能与容器布局冲突，需评估是否跳过
  9. 收集 warnings:
     - 近似 justify (space-between/around/evenly)
     - 被忽略的 flex 属性 (shrink, max_width/height)
     - 非法值 (负数 gap, 超出范围的值)
     → 结构化输出: {"warnings": [{"field": "flex.shrink", "message": "ignored: no Godot equivalent"}]}
else:
  走现有逻辑不变
```

## 测试策略

在 `test/ui-tools.test.js` 中新增测试组，全部为纯函数断言测试（`assert.ok(script.includes(...))`），与现有风格一致：

1. **Schema 验证**: 非法 direction 报错、负数 gap 报错、非法 padding 格式报错
2. **direction 翻译**: row→HBoxContainer、column→VBoxContainer
3. **reverse 行为**: row-reverse 生成 HBoxContainer + children 顺序反转
4. **justify 翻译**: flex-start/center/flex-end 精确映射
5. **justify 近似**: space-between/around/evenly 执行近似 + 输出包含 warning
6. **align 翻译**: stretch→EXPAND_FILL、center→SHRINK_CENTER
7. **wrap**: wrap + row → HFlowContainer、wrap + column → VFlowContainer
8. **gap (BoxContainer)**: gap=10 → add_theme_constant_override("separation", 10)
9. **gap (FlowContainer)**: gap=10 → add_theme_constant_override("h_separation", 10) + add_theme_constant_override("v_separation", 10)
10. **row_gap**: wrap 场景下 row_gap=5 映射到交叉轴 separation；非 wrap 场景输出 warning
11. **padding (BoxContainer)**: padding 直接通过 add_theme_constant_override("margin_*") 设置，无额外嵌套
12. **padding (FlowContainer)**: padding 生成 MarginContainer 包裹（命名 {name}_margin）
13. **flex.grow**: grow: 2 → stretch_ratio=2 + SIZE_EXPAND（主轴方向）
14. **flex.align_self**: align_self: 'center' → per-child SHRINK_CENTER（不叠加 EXPAND）
15. **flex.min_width/height**: → custom_minimum_size
16. **flex 被忽略属性**: shrink/max_width/max_height → 结构化 warning
17. **向后兼容**: 没有 layout 字段的 UiNodeSpec 输出不变
18. **layout 覆盖 type**: layout 存在时 type 字段被忽略
19. **嵌套 layout**: layout 内部子节点也有 layout

## 文件修改范围

| 文件 | 修改内容 |
|------|---------|
| `src/tools/ui-tools.ts` | 新增 FlexLayout/FlexChild 类型、修改 `UiNodeSpec`、修改 `uiNodeToGd`、新增 `layoutToGd` helper |
| `src/tools/ui-tools.ts` | `getToolDefinitions` 中 `ui_build_layout` 的 schema 增加 layout/flex 字段定义 |
| `test/ui-tools.test.js` | 新增 layout 翻译测试组（约 16 个用例） |

## 附录 A: 审查决策记录

### 第一轮: 架构审查 (plan-eng-review, 2026-05-19)

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | space-between/around/evenly 无法精确映射 | 近似映射 + 运行时 warning | 诚实告知 AI 限制，不阻断流程 |
| 2 | layout + type 共存歧义 | layout 覆盖 type | 避免双层嵌套，最可预测 |
| 3 | align: center 的 CenterContainer 包裹 | 改用 SIZE_SHRINK_CENTER (值 4) | 零额外嵌套，利用 Godot 原生支持 |
| 4 | row-reverse/column-reverse 实现方式 | TypeScript 层反转 children 数组 | set_layout_direction(2) 只影响文本方向，不影响子节点顺序 |

### 第二轮: Godot API 核对审查 (2026-05-19)

| # | 优先级 | 问题 | 修正 |
|---|--------|------|------|
| 5 | P0 | FlowContainer 的 gap 属性名是 `h_separation`/`v_separation`，不是 `separation` | gap 翻译按容器类型分表，FlowContainer 用正确的属性名 |
| 6 | P1 | `row_gap` 接口存在但无翻译映射 | 补充 row_gap 翻译规则：仅 wrap 场景生效，映射到交叉轴 separation；非 wrap 输出 warning |
| 7 | P1 | `space-between` 近似描述"均分 stretch_ratio"不准确 | 明确描述为"按比例填充剩余空间，非首尾贴边"，warning 告知无法做到首尾贴边 |
| 8 | P1 | BoxContainer 支持直接 `margin_*` theme override，无需 MarginContainer | padding 策略改为：BoxContainer 直接用 theme override，仅 FlowContainer 用 MarginContainer |
| 9 | P2 | `SIZE_SHRINK_CENTER` 与 `SIZE_EXPAND`/`SIZE_FILL` 互斥 | align 映射表加注，实现时确保不叠加 |
| 10 | P2 | `flex.grow` 的 EXPAND 设在主轴，`align: stretch` 的 EXPAND_FILL 设在交叉轴 | flex 映射表加注方向区分，不冲突 |
| 11 | P2 | `FlowContainer.reverse_fill` (4.3+) 控制交叉轴行填充方向，不等同 CSS reverse | 统一采用 TS 层 children 反转，附录说明 reverse_fill 不可用 |

### 不在范围内

- CSS Grid 翻译层
- Godot 运行时动态布局调整（仅生成时翻译）
- 绝对定位（position: absolute）支持
- z-index 映射
- CSS 选择器/媒体查询

### 失败模式

| 代码路径 | 失败场景 | 处理方式 |
|---------|---------|---------|
| layout 验证 | 非法 direction | throw → catch → 错误消息 |
| layout + type 共存 | AI 传 HBoxContainer + layout | type 被覆盖，无感 |
| reverse children | 空 children + reverse | 空数组反转仍为空，静默正确 |
| padding MarginContainer | 嵌套深度溢出 | validateUiNodeSpec 检查 depth |
| 近似 justify | AI 期望精确 space-between | 结构化 warning 告知近似行为 |
| flex 被忽略属性 | AI 传 shrink 期望生效 | 结构化 warning: `{"field":"flex.shrink","message":"ignored: no Godot equivalent"}` |
| wrap gap 属性名 | 对 FlowContainer 用 "separation" | 代码生成时按容器类型选择正确属性名（编译时保证） |
| grow + stretch 方向 | 主轴/交叉轴 flags 混淆 | 按 direction 区分 horizontal/vertical，编译时确定 |
