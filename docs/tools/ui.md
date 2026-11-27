# ui

> UI 操作。节点: ui_create_control, ui_container_add, ui_build_layout。布局: ui_set/get/measure_layout, ui_anchor_preset。原型: ui_import_prototype(几何 JSON 一次调用翻译+构建+测量+校验+持久化;样式→StyleBoxFlat;返回 style_verify/flow_verify)。像素终验: ui_pixel_verify(bg 节点截图采样 vs 目标色 RGB 距离;Windows 窗口模式会弹窗)。锚点改造: solve_from_current(既有场景反解比例锚点+浮点 offset,tscn 文本 patch 保注释,dry_run 默认 true 只出计划)。主题: ui_set_theme, theme_create, theme_set_property。设计 token: token_set(写 DesignTokens 落盘), token_list(审计全量)。样式逆向: extract_tree(整树 override 扫描→聚类报告,可选 Theme 草稿), export_doc(Theme 巡检→DESIGN.md 视图,只读不落盘)。绘图: ui_draw_recipe。运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。(例外: theme_create(save_path)/token_set 直接落盘资源文件;extract_tree 带 draft_path 落草稿)

| 属性 | 值 |
|------|-----|
| 所属层 | headless |
| 安全级别 | danger-api |
| 需要 Godot | 是 |
| 需要编辑器 | 否 |
| 只读 | 否 |
| 长耗时 | 否 |

## Actions

- `ui_create_control`
- `ui_set_layout`
- `ui_get_layout`
- `ui_anchor_preset`
- `ui_set_theme`
- `ui_container_add`
- `ui_draw_recipe`
- `ui_build_layout`
- `ui_measure_layout`
- `ui_import_prototype`
- `ui_pixel_verify`
- `theme_create`
- `theme_set_property`
- `solve_from_current`
- `token_set`
- `token_list`
- `extract_tree`
- `export_doc`

## Parameters

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum (18 项) | ✓ | 操作类型。build_layout=CSS 布局翻译构建(推荐), import_prototype=原型导入, pixel_verify=像素验证, create_control/container_add/anchor_preset=控件, set/get/measure_layout=布局, solve_from_current=既有场景锚点改造, draw_recipe=绘制, theme_*=主题, token_set/token_list=设计 token, extract_tree=整树样式逆向(可选草稿), export_doc=设计文档导出 |
| `project_path` | string |  | 项目目录（默认 GODOT_PROJECT_PATH 或当前目录） |
| `scene_path` | string |  | 场景路径（相对项目）。ui_set_theme/theme_set_property 可选;ui_pixel_verify 必填(已构建场景);solve_from_current 必填(res://);theme_create 仅 extract 必填 |
| `node_path` | string |  | 节点路径（set/get_layout/anchor_preset/set_theme/container_add/draw_recipe;solve_from_current 可选(子树)） |
| `node_type` | enum (31 项) |  | ui_create_control/ui_container_add: Control 子类类型 |
| `node_name` | string |  | ui_create_control: 新节点名称 |
| `parent_node_path` | string |  | ui_create_control: 父节点路径（默认 root） |
| `properties` | object |  | ui_create_control: 可选属性（支持 string/number/bool/null） |
| `anchors` | object |  | ui_set_layout: 锚点 {left, right, top, bottom}，值 0-1 |
| `offsets` | object |  | ui_set_layout: 边距 {left, right, top, bottom}，像素值 |
| `min_size` | object |  | ui_set_layout: 最小尺寸 {x, y} |
| `custom_minimum_size` | object |  | ui_set_layout: 自定义最小尺寸 {x, y} |
| `grow_direction` | enum (5 项) |  | ui_set_layout: 增长方向 |
| `preset` | enum (16 项) |  | ui_anchor_preset: 锚点预设名称 |
| `theme_action` | enum (4 项) |  | ui_set_theme: 操作类型（set_params/create/save/load） |
| `theme_path` | string |  | ui_set_theme: Theme 资源路径(save/load 时必填);ui_measure_layout/ui_import_prototype: measure 前挂载到 root,主题敏感场景必传(theme_type_variation 节点字号需主题语境,显式挂载不依赖项目 autoload);ui_import_prototype/ui_pixel_verify: $token 解析源(theme DesignTokens colors);token_set/token_list: token 读写目标主题(必填,须已存在);export_doc: 导出目标主题(必填,巡检+DESIGN.md 视图) |
| `params` | object |  | ui_set_theme(set_params): 键值对（number/bool/string/array[4]→Color） |
| `child_type` | enum (31 项) |  | ui_container_add: 子节点 Control 类型 |
| `child_name` | string |  | ui_container_add: 子节点名称 |
| `child_properties` | object |  | ui_container_add: 子节点属性（支持 string/number/bool/null） |
| `theme_create_action` | enum: create | extract |  | theme_create: 操作类型（create 创建空 Theme | extract 从节点提取） |
| `source_node_path` | string |  | theme_create(extract): 源节点路径 |
| `save_path` | string |  | theme_create: 可选保存路径（res://themes/xxx.tres） |
| `theme_node_path` | string |  | theme_set_property: 拥有 Theme 的节点路径 |
| `item_type` | enum (4 项) |  | theme_set_property: 属性类型 |
| `prop_name` | string |  | theme_set_property: 属性名 |
| `theme_type` | string |  | theme_set_property: Theme 类型名（可选） |
| `value` | any |  | theme_set_property: 属性值（default_font/stylebox 为资源路径，color 为 [r,g,b,a]，constant 为数字） |
| `token_name` | string |  | token_set: token 名(白名单 ^[A-Za-z_][A-Za-z0-9_-]*$,与 $name 引用语法一致) |
| `token_value` | any |  | token_set: token 值——color 形态 [r,g,b] 或 [r,g,b,a]（0-1，元素须有限数）或数字常量（有限数） |
| `draft_path` | string |  | extract_tree: 可选 Theme 草稿落盘路径(.tres,相对项目;缺省只回报告) |
| `ops` | array |  | ui_draw_recipe: 绘图操作数组（最多 200 个） |
| `max_depth` | number |  | ui_measure_layout: 最大遍历深度(默认 16,上限 64) |
| `expect_tree` | object |  | ui_measure_layout: 可选目标树(同 ui_build_layout tree,含 rect);提供时输出逐节点 diff/重叠/越界 |
| `geometry` | object |  | ui_import_prototype/ui_pixel_verify: 原型几何 JSON(inline {viewport,nodes} 扁平视口坐标;与 geometry_path 二选一,本参优先)。样式字段:bg/fill(ProgressBar fill 槽色)/borderRadius(number 或 {tl,tr,br,bl})/border({width,color})→StyleBoxFlat 四控件槽位;颜色字段(bg/color/fill/border.color)可 "$name" 引用 theme DesignTokens token(须配 theme_path;import/pixel_verify 均支持;有引用时多一次 Godot 预取 spawn);perSides 单边差异等细节见规则文档 |
| `geometry_path` | string |  | ui_import_prototype/ui_pixel_verify: 几何 JSON 文件路径(相对项目,支持 res://;与 geometry 二选一) |
| `tolerance` | number |  | ui_import_prototype: layout_verify 容差(px,默认 2) |
| `detail` | enum: compact | extended |  | ui_measure_layout(带 expect_tree)/ui_import_prototype: compact=verify 各节只返回不 ok 条目 top 20(按偏差量排序)+计数 summary,被压缩数组变为 {entries,summary} 对象;默认 extended 全量 |
| `parent_path` | string |  | ui_build_layout: 父节点路径;ui_import_prototype: 须原点对齐节点(默认 root)——非原点挂载时 layout_verify 根级 diff 恒误报 |
| `tree` | object |  | ui_build_layout: UI 节点树(最大深度 10);节点可带 styleboxes:[{slot: panel|normal|background|fill|hover|pressed|disabled, box: {bg_color:[r,g,b,a]0-1, corner_radius: 数值或{tl,tr,br,bl}, border_width, border_color, draw_center}}]→add_theme_stylebox_override |
| `load_autoloads` | boolean |  | 加载 Autoload（默认 true） |
| `viewport` | object |  | ui_build_layout: 根 rect 求解基准 {w,h}(默认 1280x720;与项目窗口一致=视口几何);ui_import_prototype: 默认取 geometry.viewport;ui_measure_layout: 覆写测量视口(SubViewport 尺寸,正整数;注入重排;生效性见 data.measure.viewport_check,inconclusive 勿信);solve_from_current: 场景根直接子父尺寸兜底(父尺寸无法从 tscn 解析时以视口为父;须与项目视口一致,正整数) |
| `persist` | boolean |  | ui_build_layout: 持久化到 .tscn（原子写；默认 false 运行时） |
| `include` | array |  | solve_from_current: 节点名白名单 |
| `exclude` | array |  | solve_from_current: 节点名黑名单(优先于 include) |
| `dry_run` | boolean |  | solve_from_current: 默认 true 只出计划;false 写盘 |

## 风险分布

读 4 / 写 14

---
<!-- AUTO-GENERATED by scripts/gen-tool-docs.mjs from capability-matrix.json v0.41.2. DO NOT edit manually; re-run npm run gen:tool-docs after tool changes. -->
