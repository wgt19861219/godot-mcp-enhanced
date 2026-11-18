---
description: "ui ui_create_control ui_build_layout ui_measure_layout ui_set_layout ui_get_layout ui_anchor_preset ui_set_theme ui_container_add ui_draw_recipe theme_create theme_set_property token_set token_list extract_tree export_doc DesignTokens 设计 token 逆向 聚类 草稿 DESIGN 文档 CSS flexbox grid 布局 测量 容器 锚点 rect Control HBoxContainer VBoxContainer GridContainer 全屏 居中 迁移 PanelContainer clip_contents 圆角 对齐"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.38.0+

## 概述与架构

UI 布局工具将 **CSS Flexbox/Grid 语义**翻译为 Godot Container 树，让 AI 用熟悉的布局概念构建 Godot UI。

- **三种入口**：单节点操作（ui_create_control）/ 批量布局（ui_build_layout）/ HTML 原型还原（ui_import_prototype，几何 JSON 一次调用，固定持久化）
- **运行时工具**：操作在 headless 进程中执行，默认不持久化到 .tscn（例外：`ui_build_layout` 支持 `persist=true` 原子写；`ui_import_prototype` 无 persist 参数、固定持久化）。详见 godot-mcp-core.md "运行时 vs 持久化"。
- **互补关系**：ui_import_prototype 适合"HTML 原型→Godot"还原（原型是唯一真源）；ui_build_layout 适合手写树整体布局；ui_create_control + ui_set_layout 适合精确定位
- **迁移/搭建 UI 的默认闭环（任何构建路径都适用，含 add_node/手写 tscn）**：读源 → 声明结构（视觉组判定，见下节） → 构建（按「布局收敛闭环」persist=true） → **必验**：数值优先 `ui_measure_layout`（**必须传 expect_tree 含 rect**——不传只得到原始 rect 清单，没有 diff/overlaps/out_of_bounds 判定）→ 视觉兜底 `screenshot(action=capture)`（窗口模式；headless 无渲染截图空白）或 `ui_pixel_verify`（**窗口模式专属、非 headless**；输入为已 persist 落盘的场景 + geometry，独立 spawn 不经 bridge、无需游戏运行；定位是几何/样式全绿后的终验，非迭代反馈）→ 修 → 复验。**搭完不验=未完成**。
  - 数值审计的已知边界：父不在测量集时该条 diff 为 NaN、`stalled` 未收敛、2px 容差、overlaps 只看兄弟、out_of_bounds 只看直接父——数值全过≠视觉必对；圆角畸变/光学对齐**只能**靠截图或像素对比暴露。不要用截图替代几何数值校验，也不要用数值全过否认视觉检查。
  - 深度审计（需 bridge）：`dump_layout_tree` 导出坐标表 → `analysis layout_compare` 与基准 JSON 比对；`get_font_report` 查字体居中。基准 JSON 来源：原型几何（expect_tree/geometry）或迁移前先导出的基准快照。
- **UI 复刻任务默认链路（Refero 总验收,v0.38+）**:凡复刻/还原/对照既有 UI,默认走——读源→proto-geometry（颜色 `$token` 引用、视觉组容器化）→ `ui_import_prototype(theme_path)` → quality/order 报告**名单化处置**（`solve_from_current` 改造或标注豁免,间距落档率目标 100%）→ 双档验证（设计档 `compareBaseline` 0 容差;窄档 `viewport={w,h}` 位置对齐不越视口）→ `token_list` 审计 + `export_doc` 视图 → 验收记录落档。宿主游戏项目纪律:真实文件只读、副本前缀工作、产物收编与提交由用户裁决。

## 跨引擎迁移 UI 构建策略（从 Unity/Cocos/Egret/Web 等迁移时必读）

### 1. 整体性判定：视觉组必须容器化（治"拆散"与"内容超出背景框"）

源引擎 UI 多为绝对坐标平铺。迁移时先做视觉组识别：一个背景 + 其内文案/图标/交互件（卡片、面板、按钮、条目），必须重构为容器子树，禁止平铺成兄弟节点 + 手动 rect 还原。

**按构建路径选容器方案**：

- **ui_build_layout / 手写 tscn（容器布局子节点）**：背景自适应首选 `PanelContainer`——它本身是 Container，尺寸随子内容最小尺寸自动撑开，背景=内容边界。多向排布用 `PanelContainer > MarginContainer > VBox/HBox`。注意：`Panel` 继承 Control **不是** Container，不会被子节点最小尺寸撑开——放进 VBox 拿到的是自身最小尺寸（常为 0），子内容照样溢出；要 Panel 视觉样式又想自适应，外包一层 PanelContainer。
- **ui_import_prototype（绝对 rect 子节点）**：背景仍用 `Panel`（翻译器样式槽位仅映射 Panel/ProgressBar/Button/Label，PanelContainer 的 bg/border 会触发 "无该控件的样式槽位,已忽略" warning）；容器排布靠原型 `flow` 字段；**绝对 rect 子节点永远不要放在 Container 父下**（rect/anchors 会被容器重排覆盖，见「扁平列表，视口绝对坐标」rect 求解段）。
- 同款条目重复出现 → 建成独立场景（组合控件）再 instance，不做兄弟复制。
- 固定 size 的 Panel 仅用于纯装饰层（无动态内容）；有内容的一律走容器自适应。

### 2. 对齐三原则（治"对齐乱"）

- 容器内对齐 → 交给 `size_flags`（SIZE_FILL/SIZE_EXPAND 搭配 SIZE_SHRINK_CENTER/SIZE_SHRINK_END 预设）+ Box 容器的 `alignment`
- 跨控件对齐 → 交给共同父容器（把要对齐的控件放进同一个 Box/Flow）
- 绝对坐标/锚点定位 → 仅限 overlay、特效层、全屏装饰；禁止逐控件手算 x/y 模拟对齐（字体行盒差异会让手算必错，见下条）
- **嵌套圆角**：外层圆角 = 内层圆角 + 内边距（Concentric Radius）才视觉协调；padding 大时视为分离表面不强套公式。**光学对齐**：图标/三角形等非对称图形几何居中后需 1~2px 级偏移修正；文本行盒与字形 ink 高度差异致跨引擎"文字不居中"，第一步诊断用 `game_query get_font_report`（ink_center_shift 字段；**需 bridge、游戏运行中**——构建期无游戏时先用 `ui_measure_layout` 量行盒尺寸做粗判，精确诊断留到运行期）——换字体可能缩小偏差但不改变行盒居中算法，先看诊断再决定。

## 工具清单

| 工具 | 说明 |
|------|------|
| `ui_build_layout` | 声明式批量布局，CSS Flexbox/Grid → Godot Container 树；支持 rect 绝对几何与 persist 原子写 |
| `ui_import_prototype` | HTML 原型几何 JSON 一次调用：翻译→build（固定 persist）→measure→layout_verify；返回 verify_coverage 覆盖率（v0.31.0） |
| `ui_measure_layout` | headless 整树 computed rect 测量（等布局稳定后输出，可带 expect_tree diff） |
| `ui_create_control` | 创建单个 Control 节点（31 种类型） |
| `ui_set_layout` | 设置锚点/偏移/最小尺寸 |
| `ui_get_layout` | 查询节点布局信息 |
| `ui_anchor_preset` | 应用 16 种锚点预设 |
| `ui_container_add` | 向 Container 添加子 Control |
| `ui_draw_recipe` | 声明式 2D 绘图（7 种操作） |
| `ui_set_theme` | 设置/创建/保存/加载 Theme |
| `theme_create` | 创建空 Theme 或从节点提取 |
| `theme_set_property` | 设置 Theme 属性（font/color/constant/stylebox） |
| `token_set` | 向 theme 的 DesignTokens 命名空间写一个 token（color/constant）并原子落盘（v0.37.0） |
| `token_list` | 审计 theme 的 DesignTokens 全量 token（colors+constants 双通道，只读） |
| `extract_tree` | 整树 theme override 逆向扫描→聚类报告（stylebox 规格/font_size/font_color 三组），可选 draft_path 落 Theme 草稿（v0.38.0） |
| `export_doc` | Theme 只读巡检→DESIGN.md 视图（DesignTokens 全量表+类型槽位摘要 top 20，不落盘） |

### 支持的 31 种 Control 子类

Button, Label, Panel, LineEdit, TextEdit, RichTextLabel, LinkButton, HSlider, VSlider, CheckBox, CheckButton, OptionButton, SpinBox, ProgressBar, TextureRect, ColorPickerButton, TabContainer, Tree, ItemList, MarginContainer, HBoxContainer, VBoxContainer, GridContainer, CenterContainer, ScrollContainer, PanelContainer, HSplitContainer, VSplitContainer, NinePatchRect, TextureButton, ColorRect

## 使用指南

### ui_build_layout — 声明式布局

`tree` 参数定义布局结构，支持递归嵌套（最大深度 10）：

```json
{
  "type": "VBoxContainer",
  "name": "MainMenu",
  "layout": { "direction": "column", "gap": 10, "padding": 20 },
  "children": [
    { "type": "Label", "name": "Title", "properties": { "text": "游戏标题" } },
    {
      "type": "HBoxContainer",
      "name": "ButtonRow",
      "layout": { "direction": "row", "justify": "center", "gap": 8 },
      "children": [
        { "type": "Button", "name": "StartBtn", "properties": { "text": "开始" } },
        { "type": "Button", "name": "QuitBtn", "properties": { "text": "退出" } }
      ]
    }
  ]
}
```

### layout 字段

| 字段 | 值 | 对应 Godot |
|------|-----|-----------|
| `direction` | row/column/grid | HBoxContainer/VBoxContainer/GridContainer |
| `justify` | flex-start/center/flex-end/space-between/space-around/space-evenly | Container alignment |
| `align` | stretch/flex-start/center/flex-end | Cross-axis alignment |
| `gap` | number | Theme 默认间距 override |
| `padding` | number 或 [上,右,下,左] | MarginContainer |
| `columns` | number | GridContainer columns（仅 grid 方向） |

### flex 字段（控制子节点在容器中的行为）

| 字段 | 说明 | 对应 Godot |
|------|------|-----------|
| `grow` | 扩展比例（0=不扩展） | size_flags_stretch_ratio |
| `min_width` / `min_height` | 最小尺寸 | custom_minimum_size |
| `align_self` | 单独对齐覆盖 | size_flags + alignment |

### anchor_preset 锚点预设

16 种预设：top_left, top_right, bottom_left, bottom_right, center_left, center_top, center_right, center_bottom, center, left_wide, top_wide, right_wide, bottom_wide, vcenter_wide, hcenter_wide, **full_rect**（最常用）

### rect 绝对几何（v0.30.3 语义修正）

无 `layout` 字段的节点支持 `rect: {x, y, w, h}`——**相对父节点左上角**（不是视口绝对坐标），按**父尺寸**反解为 anchors+offsets：

- **求解基准**：根节点（挂 parent_path 下）的 rect 相对 **`viewport` 参数**求解（默认 1280x720）；子节点的 rect 相对**父节点的 rect.w/h** 求解；父节点未声明 rect 时降级用 viewport 求解并发 warning（`parent's size is unknown`，结果可能不准）。
- **viewport 参数**：`ui_build_layout` 顶层参数 `{w, h}`（须为正数），与项目 `display/window/size` 一致时根 rect 即视口绝对几何。
- **父必须非 Container**：HBoxContainer 等容器父会强制重排子节点，rect 会被运行时跳过并给出 warning（需要容器内定位请重构为非容器父或兄弟节点）。
- `rect` 优先于 `anchor_preset`；显式写四值 anchors+offsets，不用 set_anchors_preset（引擎陷阱：preset 不重置 offsets）。
- 锚点值吸附 0/0.5/1（可读性优先），其余位置保持比例锚点兜底。
- **带 `layout` 的容器节点自身 rect 不落地布局**：仅作为 `ui_measure_layout(expect_tree)` 的对照目标（diff 会报告实际偏差）；容器实际几何由 `anchor_preset`（默认 full_rect）与子节点内容/`custom_minimum_size` 撑开决定。

### justify space-* 行为（v0.30.3）

非 wrap 非 grid 的 row/column 下，`space-between/around/evenly` 通过注入 `_spacer_N` Control 节点实现（SIZE_EXPAND + stretch_ratio），**不再是近似映射**。`wrap: "wrap"` 时 justify 被忽略（FlowContainer 无对齐）、`grid` 方向时同样忽略——这两种情况**不注入 spacer、也不发 spacer 注入 warning**。与子节点 `flex.grow` 并存时，spacer 与 grow 子节点瓜分剩余空间，分配语义与 CSS 不同，会有 warning。

### 布局收敛闭环（v2）

`ui_build_layout(tree 含 rect, **persist=true 写盘**)` → `ui_measure_layout(expect_tree=同一棵 tree 含 rect，**不带 node_path**)` → 按 `data.layout_verify.diff` 的 Δ 数值修 tree → 重新 `ui_build_layout(persist=true)` → 循环至全绿。

- **每一轮验证循环都以 persist=true 落盘为默认**——measure 是独立进程，从磁盘加载场景；persist=false 的运行时树测不到（进程退出即丢）。
- 不想污染目标场景时：先把 `scene_path` 指向临时场景路径（如 `res://tmp/ui_verify.tscn`）走完循环，全绿后把 `scene_path` 换成目标场景再 build 一次 persist=true（persist 写盘为 pack → tmp → rename 覆盖写）。**前置：临时场景文件与所在目录须先存在**——build 脚本首行 `_mcp_load_scene` 对不存在的场景直接 "Failed to load scene" 退出，persist 无从执行；先用 scene 工具创建空场景（或复制目标场景）再进循环。

- `layout_verify` 结构：`targets`（期望 rect 清单）/ `diff`（逐节点 Δ，容差默认 2px）/ `overlaps`（兄弟节点重叠）/ `out_of_bounds`（溢出父边界）/ `viewport`（measure 输出的根参照系透传）。
- **坐标系语义（v0.30.3）**：rect 相对父节点左上角；`diff` 的 actual 为**父相对坐标**（measured 子 global − 父 global，与 target 同构可直接比 Δ）；根级 target（树根自身 rect）以视口原点为参照；父不在测量集（未渲染/不可见）时该条目 delta 为 NaN。
- `ui_measure_layout` 单独使用时：`node_path` 可选（省略则从场景根整树测），`max_depth` 默认 16（上限 64），等布局稳定（连续帧快照一致或最多 5 帧）后输出；输出含 `viewport`（项目声明视口尺寸）与 `stalled`（5 帧上限内未达 2 帧稳定时 true，布局可能未收敛）。

### ui_import_prototype — HTML 原型还原（v0.31.0）

**工作流（AI 全链路，原型是唯一真源）**：AI 写 HTML 原型（每个待还原元素标 `data-name`）→ 浏览器 MCP 一条 evaluate 提取几何 JSON（模板见下节）→ `ui_import_prototype` **一次调用**完成 翻译→build→measure→layout_verify → **不绿回 HTML 改原型**（不在 Godot 侧调 rect）→ 绿后 `screenshot(action=diff)` 像素级双图验收（要点见本节末）。

**入参**：`geometry`（inline JSON）或 `geometry_path`（文件路径，相对项目、支持 `res://` 前缀；二选一，同时给时 `geometry` 优先 + warning）/`viewport`（可选，默认取 geometry.viewport）/`tolerance`（默认 2px）/`parent_path`（默认 root）。**没有 persist 参数——固定持久化**（内部 measure 是第二次 Godot spawn 从磁盘 load 场景，不落盘则 verify 全部 actual:null）。

**proto-geometry JSON**（strict schema，未知字段拒绝——字段拼错（如 `font-size`）早暴露，不静默丢）：

```json
{
  "viewport": { "w": 1280, "h": 720 },
  "nodes": [
    { "name": "TopBar", "rect": { "x": 0, "y": 0, "w": 1280, "h": 56 },
      "type": "Panel", "text": "标题", "fontSize": 16, "color": "#e8ecf5",
      "bg": "#10141f", "align": "center", "value": 0.72,
      "flow": "row", "justify": "space-between", "interactive": true }
  ]
}
```

- **扁平列表，视口绝对坐标**（rect 为浏览器/原型视口绝对值）；树由翻译器按 rect 包含关系自动推导（容差 1px，≤500 节点）；**两节点 rect 交叉重叠（互不包含）或完全相等 → INVALID_PARAMS**（不静默落平级）。
- 字段全可选（除 name/rect）：`type`（CONTROL_TYPES 白名单）/`text`/`fontSize`（px）/`color`/`bg`/`fill`（ProgressBar fill 槽色，取 `[data-fill]` 子元素背景）/`borderRadius`（统一四角 number 或 `{tl,tr,br,bl}` 对象）/`border`（`{width,color}` 统一四边 + 可选 `perSides:{top,right,bottom,left}` 四边各异信息——提取脚本在 top>0 且四边各异时附上，width 恒取 top；**四边各异时翻译器发 warning**（border sides differ...; using top），仍取 top 渲染、行为不变；top=0 其余边>0 时不产 border spec（防「有 border 无 bg」被设 draw_center=false 全透明），提取脚本以 `borderNotice` 提示字段透传成 warning；style_verify 无法暴露该差异（期望与实测同源于同一翻译产出，恒绿），ui_pixel_verify 采样点不采边框本身、只能间接暴露）/`align`（left|center|right，缺省 center）/`value`（0-1，ProgressBar）/`flow`（row|column，容器排布语义；多层 flow 任意深度嵌套均递归展开为 Container 子树，每层 flow 的直接子进各自 `_Flow` 容器）/`flow_gap`（≥0 有限数，flow 容器间距 px——落地 `_Flow` 容器 separation 的 theme override 常量）/`flow_align`（start|center|end，flow 跨轴对齐 align-items——映射 flex-start/center/flex-end；`flow_gap`/`flow_align` 无 `flow` 同节点声明时忽略+warning，不静默）/`justify`/`interactive`（text+interactive→Button）。
- **颜色仅三种格式**：`#rrggbb` / `[r,g,b]` 0-255 / `[r,g,b,a]` 0-1。CSS `rgb()/rgba()` 字符串**不支持**——evaluate 模板已内置转换（见下节）。
- **bg 缺省 = 透明壳契约（责任归 JSON 生产者）**：推断为布局壳 Panel（无显式 type、无 text、无 bg、无 value 的纯布局节点，及 flow 壳）→ `self_modulate:[1,1,1,0]`（禁 modulate，级联陷阱见 godot-mcp-engine-quirks.md）。**该有背景的面板务必在原型侧显式填 bg**，否则被当透明壳（build_warnings 会提示 "set bg or type to keep it visible"）。**自带视觉控件不会被设透明壳**：ProgressBar（推断或显式）、Button（推断或显式）、任何显式 type（含显式 Panel）——显式 type 说明有意为之，一律保留可见性。
- **翻译规则要点**（12+1 条）：类型推断（显式 type > flow > value→ProgressBar > text+interactive→Button > text→Label > Panel）；视口坐标逐层减父原点转相对父 rect（进锚点求解链）；Label 全部 `vertical_alignment:1`；bg/fill/borderRadius/border→StyleBoxFlat（槽位映射（`add_theme_stylebox_override` API；override 属性名为 `theme_override_styles/<slot>`，注意 `node.set()` 该路径 pack 落盘会丢 override，勿手写）：Panel→panel、ProgressBar→background+fill、Button/Label→normal；其余控件 warning+忽略；bg 缺省而 border/radius 存在→`draw_center=false` 保 CSS 透明底）；非白名单 type 降级 Panel + warning；深度 cap 10；name 非法字符清洗。
- **引擎下限预警（只警不修，修在原型侧）**：文本控件 rect.h < fontSize*1.5 → "可能被字体最小行高钳制" warning；ProgressBar rect.h < 27 → "will be clamped" warning（**无条件**；实测 Godot 4.7.1 h=16：无 override→27、bg-only→23、fill-only→27、bg+fill→23，全组合被钳，override 只改变钳制值不消除钳制）。应对：调大原型 rect.h 或调小字号，勿指望 Godot 侧硬压。
- **容差模糊带**：verify 容差（默认 2px）内兄弟关系与偏移不可区分——**避免构造 ≤2px 宽的相邻独立节点**（工具返回也带此提示）。

**返回**：`{ tree, build_warnings, measure: {stable_after_frames, stalled, viewport}, verify_coverage, layout_verify: {targets, diff, overlaps, out_of_bounds, viewport}, style_verify, flow_verify, persist }`。

- **verify_coverage 覆盖率语义**：`targets` 为受几何 verify 覆盖的节点数（**含合成根 `_PrototypeRoot`——无 flow 时 = 输入节点数 + 1**）。**flow 直接子节点丢 rect、不在 layout_verify 覆盖内——由 `flow_verify` 数字覆盖**（期望=输入视口 rect vs 容器排布实测 global rect，逐节点 Δx/Δy/Δw/Δh；孙层由 **layout_verify** 近似覆盖（非 flow_verify）——期望相对输入父原点，容器排布后天然带偏移）。
- **style_verify（逐槽位样式 diff）**：`ui_import_prototype` 返回与 `ui_measure_layout`（expect_tree 时）均挂；对「期望清单内节点 ∪ 槽位 override 非空节点」按需读回 `get_theme_stylebox(slot)`（override 优先、回落默认主题——**override 没设上时以默认主题数值 diff 暴露**）；非 StyleBoxFlat（如 Label 未 override 的 normal 槽 StyleBoxEmpty）以 type 红条目暴露、不进字段 diff；仅比 box 显式设置的字段，颜色容差 0.002（Color float32 精度）、corner/border 宽度精确匹配。
- **flow_verify 容差语义**：直接子层 Δ 的合理阈值可大于几何 verify 的 2px（HTML flex 默认 align stretch vs Godot size_flags 默认 fill 的固有数值差）——偏差即价值，暴露后按 Δ 在原型侧修或加 size_flags；`tolerance` 参数同款可调。
- measure 阶段失败时错误信息附 `(build 已持久化,可重跑 ui_measure_layout)`——场景已在磁盘，无需重新 import。
- **ui_pixel_verify(像素终验)**：对已构建场景（`scene_path` 必填，指 `ui_import_prototype` persist 产物）窗口模式截图，对每个 bg 节点采样中心+四角内缩点（内缩 `max(0, min(borderRadius+border.width, 短边/2−2))` (短边<4 时回落 0,防负内缩)，角点坐标按像素格半开区间右/下缘 `−1`），与目标色 RGB 欧氏距离判定（中心容差 20、角点 60，0-255 空间；实测校准零底噪零偏移，13 采样点 distance=0）。**定位是终验而非迭代反馈**——几何 layout_verify + style_verify 全绿后才跑一次（每次 capture 窗口模式弹窗 + 秒级耗时）。Windows 窗口模式专属（headless=dummy renderer 截图空白；Linux headless 2D CanvasItem 亦空白，BLANK 拦截为 stdout 提示 + PNG 全图均匀色双条件）。采样跳过两类：半透明 bg（alpha<0.999，即非完全不透明；合成后采样色≠bg_color）与 ProgressBar 系（type/value/fill 任一——fill 与百分比文字覆盖 bg 渲染面，无可采样纯色区，bg 槽依赖 style_verify）；带 text 节点跳过中心点（居中排版必踩文字，仅采四角）。未映射控件（如 LineEdit 带 bg）的 bg 被翻译层忽略、渲染无该色——采样仍收集且预期红，与 build_warnings 样式丢失警告互为印证（诚实暴露，不静默跳过）。采样基准=输入视口 rect，挂载父须原点对齐（同 layout_verify 约束）；flow 子节点位置偏差由 flow_verify 先收敛；PNG 中间产物临时落 `.godot/` 且失败路径也清理。

**像素验收要点（`screenshot(action=diff)`）**：`image_a`/`image_b` 两 PNG（白名单内，尺寸必须一致）、`threshold` 默认 0.12（per-pixel RGB 欧氏距离 / (√3×255)，严格大于才计差、忽略 alpha）、可选 `diff_path` 输出红染差异图；返回 `{width, height, diff_pixels, diff_ratio, bbox}`。

- **capture 的 viewport 必须与原型 viewport 一致**（用法契约）：原型 1280x720 则 capture 也用 1280x720，否则几何比例全错、diff 全图皆红。
- **diff_ratio 含字体抗锯齿底噪**——对 diff_ratio **以同布局好图对为基线，坏图对 ratio 应显著高于基线（如 > 基线×1.5）**，勿用精确值断言。本仓实测（threshold=0.12）：好图对 web-prototype vs godot-hud（同布局不同渲染器）≈0.1762；下半部内容消失的合成坏图（godot-hud 下半 y>360 置纯黑，模拟 modulate 级联内容消失）≈0.48，约为基线 2.7 倍——"好图 < 0.25、坏图 > 0.4" 的区间示例在本仓成立；跨项目请以自身好图对为基线校准（同源渲染仍有 17% 量级像素差，精确值断言必 flaky）。

### 浏览器 evaluate 取数脚本模板（chrome-devtools / playwright 通用）

HTML 原型侧约定：每个待还原元素标 `data-name`（=Godot 节点名，须唯一）；flex/grid 容器可显式标 `data-flow="row|column"`（可选 `data-justify`），**不标也行——模板读 computed style 的 `display` 自动检测**（flex/inline-flex/grid/inline-grid 时按 `flex-direction` 输出方向，grid 暂映射 row 不扩枚举，并带出 `flow_gap`/`flow_align`）；整页视口容器标 `data-viewport`（可选，缺省取窗口尺寸）。在浏览器 MCP（如 chrome-devtools 的 evaluate_script / playwright 的 browser_evaluate）执行：

```js
() => {
  const toRgba = (c) => {                     // CSS 颜色 → [r,g,b,a] 0-1 数组(保留 alpha;替代丢 alpha 的 toHex)
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;   // alpha 0 = 透明
    return [Number(m[1])/255, Number(m[2])/255, Number(m[3])/255, m[4] !== undefined ? Number(m[4]) : 1];
  };
  const vpEl = document.querySelector('[data-viewport]');
  const vpRect = vpEl ? vpEl.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
  const out = { viewport: { w: Math.round(vpRect.width), h: Math.round(vpRect.height) }, nodes: [] };
  for (const el of document.querySelectorAll('[data-name]')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const node = {
      name: el.dataset.name,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
    const text = (el.dataset.text ?? el.textContent ?? '').trim();  // 嵌套容器建议用 data-text 标注,避免吞子元素文本
    if (text) node.text = text;
    const alignMap = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
    const align = alignMap[cs.textAlign];                // 水平对齐:CSS 默认 left 而翻译器缺省 center——不采集会系统性丢失对齐
    if (align) node.align = align;                       // (justify 等其余值不输出字段,走翻译器缺省 center)
    const fs = parseFloat(cs.fontSize);
    if (Number.isFinite(fs)) node.fontSize = fs;
    const fg = toRgba(cs.color);
    if (fg && !(fg[0]===0 && fg[1]===0 && fg[2]===0 && fg[3]===1)) node.color = fg;  // 跳过浏览器默认黑
    const bg = toRgba(cs.backgroundColor);                 // 背景色:非透明才填(透明壳契约由翻译器兜底)
    if (bg) node.bg = bg;
    // flex/grid 自动检测:display 为 flex/inline-flex/grid/inline-grid 时输出 flow(方向按
    // flex-direction,column-reverse/row-reverse 就近归 column/row)+ flow_gap(gap 计算值)
    // + flow_align(align-items 映射 start/center/end;stretch/normal 是默认不输出)。
    // 显式 data-flow 标注优先于自动检测;grid 暂输出 flow:row(白名单枚举内,不扩枚举)。
    const dflow = el.dataset.flow;
    const isFlexish = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(cs.display);
    let flowDir = null;
    if (dflow === 'row' || dflow === 'column') {
      flowDir = dflow;                                  // 显式标注优先
    } else if (isFlexish) {
      flowDir = cs.display.endsWith('grid') ? 'row' : (cs.flexDirection.startsWith('column') ? 'column' : 'row');
    }
    if (flowDir) {
      node.flow = flowDir;
      if (el.dataset.justify) node.justify = el.dataset.justify;
      const gap = parseFloat(cs.gap) || parseFloat(cs.columnGap) || parseFloat(cs.rowGap) || 0;  // "8px"→8,"normal"→NaN
      if (gap > 0) node.flow_gap = gap;                 // gap 计算值>0 才填(0 是缺省,省键)
      const itemsMap = { start: 'start', 'flex-start': 'start', center: 'center', end: 'end', 'flex-end': 'end' };
      if (itemsMap[cs.alignItems]) node.flow_align = itemsMap[cs.alignItems];
    }
    if (el.dataset.value !== undefined) {                 // ProgressBar:value 必填 0-1 小数,百分数(如 72)请先除以 100——schema min(0).max(1) 会拒
      const v = Number(el.dataset.value);
      node.value = Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
    }
    if (el.dataset.interactive === 'true') node.interactive = true;
    const px = (v) => parseFloat(v) || 0;                  // "8px" → 8
    const tl = px(cs.borderTopLeftRadius), tr = px(cs.borderTopRightRadius),
          br = px(cs.borderBottomRightRadius), bl = px(cs.borderBottomLeftRadius);
    if (tl || tr || br || bl) {
      node.borderRadius = (tl === tr && tr === br && br === bl) ? tl : { tl, tr, br, bl };
    }
    const bTop = parseFloat(cs.borderTopWidth) || 0, bRight = parseFloat(cs.borderRightWidth) || 0,
          bBottom = parseFloat(cs.borderBottomWidth) || 0, bLeft = parseFloat(cs.borderLeftWidth) || 0;
    if (bTop > 0) {                                          // top>0 才产 border spec;width 恒取 top(border-color 同)
      const bc = toRgba(cs.borderTopColor);
      if (bc) {
        node.border = { width: bTop, color: bc };
        if (bTop !== bRight || bRight !== bBottom || bBottom !== bLeft) {
          node.border.perSides = { top: bTop, right: bRight, bottom: bBottom, left: bLeft };  // 四边各异透传,翻译器发 warning
        }
      }
    } else if (bRight > 0 || bBottom > 0 || bLeft > 0) {     // top=0 其余边>0(仅下边框/分隔线):不产 border spec
      node.borderNotice = `CSS border top=0 而其余边>0 (top/right/bottom/left = ${bTop}/${bRight}/${bBottom}/${bLeft});Godot StyleBoxFlat 无按边 border,已不产 border spec——改为独立装饰线节点或源侧统一边框`;
    }
    const fillEl = el.querySelector('[data-fill]');        // ProgressBar fill 色:原型约定内层标 data-fill
    if (fillEl) {
      const fc = toRgba(getComputedStyle(fillEl).backgroundColor);
      if (fc) node.fill = fc;
    }
    if (el.dataset.type) node.type = el.dataset.type;     // 显式类型覆盖推断(31 种白名单内)
    out.nodes.push(node);
  }
  return out;  // → 直接作 geometry 入参,或写文件后走 geometry_path
}
```

要点：**bg 只在 `getComputedStyle().backgroundColor` 非透明时填**（透明壳契约由翻译器兜底）；**颜色经 toRgba 转 `[r,g,b,a]` 0-1 数组**（保留 alpha，替代旧 toHex 的丢 alpha；翻译器三种颜色格式均认）；**border 四边语义**——top>0 才产 border spec（width 恒取 top），四边各异时附 `border.perSides` 由翻译器 warning 消静默（渲染仍取 top），top=0 其余边>0 时改发 `borderNotice` 提示字段（不产 border spec，防全透明回归）；**flow 自动检测**——显式 `data-flow` 优先，否则 `display` 为 flex/inline-flex/grid/inline-grid 时自动输出 flow+`flow_gap`（gap 计算值 >0 才填）+`flow_align`（align-items 的 start/center/end 映射；stretch/normal 是默认不输出）；grid 映射 row 属近似（列数语义不迁移，差异回原型侧修）；`viewport` 取 `[data-viewport]` 容器或窗口尺寸，**必须与 Godot 项目 `display/window/size` 及后续 `screenshot(capture)` 的 viewport 参数一致**（不一致则几何比例全错）。

### DesignTokens token 层（v0.37.0，批3）

- **真源约定**：设计 token 的唯一真源是 **theme 资源文件**的 `DesignTokens` 自定义 typevariation 命名空间（约定路径 `res://ui/theme.tres`，可用任意路径但须全项目一致）——colors（`DesignTokens/colors/<name>`，色板）与 constants（`DesignTokens/constants/<name>`，间距/字号档位如 `space_1..8`）。场景/原型里不重复定义色值，一律 `$name` 引用。
- **`$name` 引用语法与 `theme_path` 四语义**：geometry 的颜色字段（`color`/`bg`/`fill`/`border.color`）支持 `"$name"` 引用 theme token（名须匹配 `^[A-Za-z_][A-Za-z0-9_-]*$`；缺键报 TOKEN_NOT_FOUND 点名 token 与 theme 路径）。`theme_path` 一个参数四种语义：① `ui_set_theme` save/load 的资源路径；② `ui_measure_layout`/`ui_import_prototype` 的 measure 前挂载；③ `ui_import_prototype`/`ui_pixel_verify` 的 `$token` 解析源；④ `token_set`/`token_list` 的读写目标主题（必填、须已存在）。
- **预取成本提示**：geometry 含 `$` 引用时，import/pixel_verify 会**多一次 Godot spawn** 预取 token map（loadAutoloads=false 只 load 资源）；无 `$` 引用零开销透传。频繁迭代原型时先落字面量调试、定稿再换 `$name` 可省 spawn。
- **`token_set` 落盘与建主题前置**：`token_set(theme_path, token_name, token_value)`——theme 文件**必须已存在**（`theme_create(scene_path+save_path)` 或 `ui_set_theme create+save` 先建；缺失报 THEME_NOT_FOUND 附建主题指引）；token_value 为 color 数组 `[r,g,b](,[a])` 0-1 → `set_color`，有限数字 → `set_constant`；**原子落盘**（tmp+rename，theme 文件要么旧值要么新值，无中间态）；同名覆盖 = 原位重写。
- **`token_list` 审计**：`token_list(theme_path)` 返回 `{colors: {name: [r,g,b,a]}, constants: {name: number}}` 双通道全量清单（Color 先转数组再进 JSON 通道，数值可精确比较）；裸 Theme（无 DesignTokens type）返回空双 dict **不报错**（审计语义，缺失≠错误）——先 token_list 确认现状再 token_set，避免盲写。

### 样式逆向与设计文档（extract_tree / export_doc，v0.38.0，批4）

- **`extract_tree(scene_path, node_path?, max_depth?, draft_path?)`**：整树 theme override 逆向——**只扫 override**（`has_theme_stylebox_override`/`has_theme_font_size_override("font_size")`/`has_theme_color_override("font_color")`），默认主题项不进扫描（契约独立于 ui_measure_layout 的「期望 ∪ override」并集——extract 关心「场景作者显式设置了什么」）；任一命中的节点才输出（无 override 的节点不进任何组）。GD 无 override-only getter，`get_theme_stylebox(` 只在 override 命中后调用。返回 `report` 三组聚类：① stylebox 规格（bg_color/corner/border/draw_center **精确匹配**分组，`{spec, count, nodes, slots, suggested_token}`）；② font_size 值分组；③ font_color 值分组；suggested_token 约定 `style_<slot>_<rrggbb>`（组内最高频 slot）/`font_size_<n>`/`text_<rrggbb>`。
- **只产草稿**：`draft` 是四类控件（Panel/ProgressBar/Button/Label，按 styleboxSlotFor 默认槽）各取最高频 spec 组装的**新建 Theme**（不回写场景、不改既有主题）；`draft_path`（res:// 形式）提供**且 draft 非空**才落盘（tmp+rename 原子写，含 bg token 进 DesignTokens colors、font_size 组进 constants）；**空扫描（全无 override）→ draft=null 不落盘**，notes 一行说明；不可映射类型（如 TextureRect 带 override）报告含组、草稿跳过并在 notes 点名类型。
- **`export_doc(theme_path)`**：Theme 只读巡检 → `{document, theme_path}`（markdown，不落盘）。文档结构：头部声明「本文档是 Theme 资源的视图，真源是 .tres；由 export_doc 生成」+ DesignTokens 全量表（空 → 一行空档说明）+ 类型槽位摘要表（**双截断**：类型按通道条目总数排序 top 20 超出 `(+N types)`；names 每通道 top 10（GD 侧截）+ 表内前 5 `(+N more)`）+ 引擎约束三条（ProgressBar 默认主题最小高 ~27px／Label 垂直对齐默认 TOP 需显式 CENTER／透明布局壳须 self_modulate 禁 modulate）。**视图非真源**——改设计先改 theme（token_set/ui_set_theme）再重导文档，不在文档侧手改。

### draw_recipe 声明式绘图

7 种绘图操作：`rect`（矩形）、`circle`（圆形）、`line`（线段）、`arc`（弧线）、`polygon`（多边形）、`polyline`（折线）、`string`（文本）

每种操作支持 `color`（[r,g,b] 或 [r,g,b,a]，0-1 范围）、`filled`（是否填充）、`width`（线宽）。

## 调用示例

### Flexbox 行布局

```
ui_build_layout(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  parent_path="root",
  tree={
    "type": "HBoxContainer",
    "name": "Toolbar",
    "layout": { "direction": "row", "gap": 4, "padding": [0, 8, 0, 8] },
    "children": [
      { "type": "Button", "name": "NewBtn", "properties": { "text": "新建" } },
      { "type": "Button", "name": "OpenBtn", "properties": { "text": "打开" } },
      { "type": "Button", "name": "SaveBtn", "properties": { "text": "保存" } }
    ]
  }
)
```

### draw_recipe HP 条

```
ui_draw_recipe(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_path="/root/HUD/HealthBar",
  ops=[
    { "kind": "rect", "position": [0, 0], "size": [200, 20], "color": [0.2, 0.2, 0.2] },
    { "kind": "rect", "position": [0, 0], "size": [140, 20], "color": [0, 0.8, 0] },
    { "kind": "string", "text": "70/100", "position": [80, 14], "color": [1, 1, 1], "font_size": 12 }
  ]
)
```

### 错误：无效 Control 类型

```
ui_create_control(
  project_path="D:/game",
  scene_path="res://scenes/main.tscn",
  node_type="MyCustomWidget",    // ❌ 不在白名单中
  node_name="CustomWidget"
)
// → { error: "INVALID_CONTROL_TYPE", message: "MyCustomWidget is not a supported control type" }
// 解决：使用 31 种支持的类型之一，或通过 execute_gdscript 注册自定义场景
```

## 常见陷阱

- **运行时默认不持久化**：UI 布局工具创建的节点在 headless 进程退出后丢失。`ui_build_layout(persist=true)` 可原子写 .tscn（pack → tmp → rename，默认 false）；其余持久化替代方案：`add_node` + `save_scene` 逐个写入，或 `scene(action="commit")`（批量 node_property/node_add 操作）直接编辑 .tscn。
- **Container 子节点必须是 Control**：向 HBoxContainer/VBoxContainer 等容器添加非 Control 子节点会报错。
- **CSS 属性回退**：`wrap`、`order`、`flex-shrink`、`max-width/height` 等 CSS 属性在 Godot 中无对应，会被忽略。
- **grid 方向必须指定 columns**：使用 `direction: "grid"` 时必须同时指定 `columns` 数量。
- **ui_build_layout vs ui_create_control**：build_layout 一次创建整棵树，适合初始布局。create_control + set_layout 适合精确控制单个节点。
