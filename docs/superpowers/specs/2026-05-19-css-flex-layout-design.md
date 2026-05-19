# CSS Flex Layout 翻译层设计

**日期**: 2026-05-19
**状态**: 已确认
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

**规则**: `layout` 和 `type` 可共存。有 `layout` 时，MCP 在该节点内部自动生成对应的 Container 层。

## 翻译映射

### direction → Container

| direction | 容器类型 | 备注 |
|-----------|---------|------|
| `row` | `HBoxContainer` | |
| `column` | `VBoxContainer` | |
| `row-reverse` | `HBoxContainer` | `set_layout_direction(2)` |
| `column-reverse` | `VBoxContainer` | `set_layout_direction(2)` |

### justify → alignment

| justify | Godot 等价 |
|---------|-----------|
| `flex-start` | `BoxContainer.ALIGNMENT_BEGIN` (0) |
| `center` | `BoxContainer.ALIGNMENT_CENTER` (1) |
| `flex-end` | `BoxContainer.ALIGNMENT_END` (2) |
| `space-between` | 近似: `ALIGNMENT_BEGIN` + 子节点均分 stretch_ratio |
| `space-around` | 近似: `ALIGNMENT_CENTER` |
| `space-evenly` | 近似: `ALIGNMENT_CENTER` |

### align → size_flags

| align | 效果 |
|-------|------|
| `stretch` | 子节点 `size_flags_vertical/horizontal |= SIZE_EXPAND_FILL` |
| `flex-start` | 不设 expand |
| `center` | 子节点包裹 CenterContainer（单向） |
| `flex-end` | 不设 expand + anchor 偏移 |

### wrap → FlowContainer

| wrap | 容器 |
|------|------|
| `nowrap` | BoxContainer（默认） |
| `wrap` | `HFlowContainer`（row）或 `VFlowContainer`（column） |

### gap

翻译为 `container.add_theme_constant_override("separation", gap)`

### padding

有 `padding` 时容器外包 `MarginContainer`，设置 `margin_top/right/bottom/left`。

### flex（子级）→ size_flags

| flex 属性 | GDScript | 备注 |
|-----------|----------|------|
| `grow: N` | `size_flags_stretch_ratio = N; size_flags |= SIZE_EXPAND` | |
| `shrink` | 忽略 | Godot 无对应概念 |
| `align_self` | 同 align 但只作用于该子节点 | |
| `min_width/height` | `custom_minimum_size.x/y` | |
| `max_width/height` | 忽略 | Godot 无对应概念 |

## 代码生成流程

`uiNodeToGd` 函数修改：

```
if spec 有 layout:
  1. 确定容器类型 (BoxContainer / FlowContainer)
  2. 生成容器节点代码
  3. 设置容器属性 (alignment, separation, layout_direction)
  4. 如果有 padding → 生成 MarginContainer 包裹层
  5. 遍历 children:
     - 递归 uiNodeToGd 生成子节点
     - 应用 flex: size_flags, stretch_ratio, custom_minimum_size
     - 应用 align_self
  6. 设置容器 anchor_preset（默认 full_rect）
else:
  走现有逻辑不变
```

## 测试策略

在 `test/ui-tools.test.js` 中新增测试组，全部为 TypeScript 纯函数测试：

1. **Schema 验证**: 非法 direction、负数 gap 等应报错
2. **翻译正确性**: 快照测试，传入 UiNodeSpec + layout，断言生成的 GDScript 包含预期的 Container 和属性
3. **向后兼容**: 没有 `layout` 字段的 UiNodeSpec 输出不变
4. **嵌套 layout**: layout 内部子节点也有 layout
5. **近似映射**: space-between 等的近似行为不报错

## 文件修改范围

| 文件 | 修改内容 |
|------|---------|
| `src/tools/ui-tools.ts` | 新增 FlexLayout/FlexChild 类型、修改 `UiNodeSpec`、修改 `uiNodeToGd`、新增 `layoutToGd` helper |
| `src/tools/ui-tools.ts` | `getToolDefinitions` 中 `ui_build_layout` 的 schema 增加 layout/flex 字段定义 |
| `test/ui-tools.test.js` | 新增 layout 翻译测试组 |
