# Refero 批4 靶子轻量验收记录(periphery 层:extract_tree / export_doc / detail=compact)

> 日期:2026-11-17。执行人:Task 4 验收代理。分支 `feature/refero-batch4-periphery`(BASE `1519426f`,Task 1-3 已完成,版本 0.38.0 已收口)。
> 验收对象:批4 Task 2/3 全部新增面(`extract_tree` 整树样式逆向 / `export_doc` 只读设计文档导出 / `ui_measure_layout` `detail='compact'` 分档)对真实靶子的轻量闭环——brief Step 1 三步的执行证据。
> 驱动脚本:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\refero-batch4-acceptance.mjs`(`GODOT_PATH` + 靶子存在双门控;`clean` 子命令兜底清理;场景唯一副本 `_batch4_copy.tscn`,finally 删除;`fail()` 抛异常不 `process.exit` 保 finally 必跑)。

## 0. 靶子与环境

| 项 | 值 |
|---|---|
| 靶子项目 | `D:\workspace\projects\DotaLegendGodot`(git 仓库) |
| 真实主题 | `res://resources/themes/default_theme.tres`(2487 行;379 type;无 DesignTokens;只读——本批两消费点均只读,不复制) |
| 真实场景 | `res://scenes/ui/daily_login_content.tscn`(**0 处 theme_override 且无 Panel 类型节点**——名为 Panel 的节点是 Control;驱动前置 grep 复核 0/0。直接 `extract_tree` 必得空报告,故验收走「import 造 override 副本链」) |
| 副本形态 | 场景副本 `res://scenes/ui/_batch4_copy.tscn` = daily_login_content.tscn **逐字节复制**(import persist 落盘目标 + extract/measure 的扫描对象),finally 删除;theme **不复制**(`export_doc` 巡检无 ResourceSaver(契约「不落盘」);`ui_measure_layout` 的 `theme_path` 是运行时挂载不写盘——两个消费点均零写入) |
| Godot | 4.7 stable(`GODOT_PATH=D:\godot\Godot_v4.7-stable_win64.exe`) |
| 通道 | 与批1/2/3 同款 `handleTool` 直调本仓 build 产物(验收前 `npm run build` 同步最新源) |

## 1. ① override 副本链:import 注入 → extract 逆向 → 自洽对账

### 链路

副本场景(逐字节复制)→ 小 geometry 经 `ui_import_prototype(parent_path=root, scene_path=副本)` **固定 persist** 落盘(为副本写入带 theme_override 的节点)→ `extract_tree(scene_path=副本)` 整树逆向 → 报告数字与输入 geometry 对账。**对账成立的根基**:场景原有 0 override,报告的每一项都来自 import 注入——输入是唯一真源,输出全部可从输入推出。

geometry(与 T3 e2e fixture `test/ui-extract.test.ts` 同构便于对账;bg 全 2 的幂次 float32 位级安全;视口 960×540 与靶子一致;三 rect y 向分离不交叉;Label rect.h=48 ≥ fontSize×1.5 避开行高钳制 warning):

```json
geometry.nodes = [
  { name: 'ExtractPanelA', rect: {x:40, y:40,  w:240, h:80}, type: 'Panel', bg: [0.25,0.5,0.75,1], borderRadius: 8 },
  { name: 'ExtractPanelB', rect: {x:40, y:140, w:240, h:40}, type: 'Panel', bg: [0.5,0.25,0.75,1] },
  { name: 'ExtractLabel',  rect: {x:40, y:220, w:240, h:48}, type: 'Label', text: 'Batch4 Extract Chain', fontSize: 20, color: [1,0.5,0.25,1] }
]
```

### import 侧数字

- `persist.saved = true`(副本场景落盘成功);
- `layout_verify`:targets x4(合成根 _PrototypeRoot + 3 目标节点)/ **diff 4/4 全 ok 且 delta 全 0** / overlaps x50(daily_login 既有叠压形态(批2/批3 已记录的背景件-前景件交叠)+ import 注入节点与既有背景件的交叠,既有形态如实呈现,非本批缺陷)/ out_of_bounds x0;
- `style_verify` x6 全 ok 且 delta 全 0:PanelA `panel` 槽 bg_color 分量 `[0,0,0,0]`(float32 位级)+ corner_radius 四角逐角 8;PanelB bg_color 分量 `[0,0,0,0]`(Label 的 fontSize/color 走 font 通道不进 stylebox 槽位,不产条目——与翻译器槽位契约一致)。

### extract_tree 对账表(核心)

| 对账项 | 从输入推出 | 实测 | 判定 |
|---|---|---|---|
| 逆向节点并集 | 3(两 Panel + 一 Label;场景原有 0 override) | 3,全部在 `_PrototypeRoot/` 子树 | ✓ |
| `stylebox_groups` 组数 | 2(两 Panel spec 互异:bg + radius 不同) | 2 | ✓ |
| 组 token 与组序 | `style_panel_4080bf`(count 平票首见在前)/ `style_panel_8040bf` | 同左 | ✓(M6 平票锚真机复现) |
| PanelA 组 `bg_color` | `[0.25, 0.5, 0.75, 1]` | 逐分量 `===` | ✓ |
| PanelA 组 `corner_radius` | 四角 8 | tl/tr/br/bl 全 8 | ✓ |
| PanelB 组 `bg_color` / `corner_radius` | `[0.5, 0.25, 0.75, 1]` / 无 radius → 全 0 | 同左 | ✓ |
| `slots` | 两 Panel 均翻译到 `panel` 槽 | `['panel']` ×2 | ✓ |
| `font_size_groups` | 1 组 `{value:20, count:1, token:'font_size_20'}` | 同左 | ✓ |
| `font_color_groups` | 1 组 value `[1, 0.5, 0.25, 1]` token `text_ff8040` | 同左(分量 `===`) | ✓ |
| `draft.styleboxes` | Panel/panel 槽平票取首见(PanelA 先 walk)→ `style_panel_4080bf` | 同左(spec 含 radius 8) | ✓ |
| `draft.colors` | 2 条:`style_panel_4080bf=[0.25,0.5,0.75,1]` + `text_ff8040=[1,0.5,0.25,1]` | 同左 | ✓ |
| `draft.constants` | 1 条 `{font_size_20, 20}` | 同左 | ✓ |
| `notes` | 非空扫描(不应有空扫描说明/不可映射点名) | x0 | ✓ |

结论:`extract_tree` 的 override 门控(七槽 stylebox + font_size + font_color 三通道)、规格聚类(bg/corner/border/draw_center 精确匹配)、suggested_token 约定(`style_<slot>_<rrggbb>` / `font_size_<n>` / `text_<rrggbb>`)、draft 选举(四类控件默认槽最高频、平票取首见)在真靶子全链路自洽——T3 单测/e2e 锚的语义在真场景复现。

## 2. ② export_doc:真主题只读巡检 → DESIGN.md 视图

`export_doc(theme_path=res://resources/themes/default_theme.tres)` 直跑**原文件**(只读——handler 链无任何写盘点,git 快照断言兜底验证)。响应 `{document, theme_path}`,document 全文 41 行存档:

- **DesignTokens 空档**:`(空:该 Theme 无 DesignTokens token——先 token_set 建档,再 export_doc 重导)` 一行——真主题无 DesignTokens(批3 实测同源),诚实空非报错;
- **类型 top 20 截断预期触发**:类型槽位摘要表体恰 20 行 + `(+359 types)` 标记,合计 **379 type**(与 v1 审查 I2 实测 type 数一致)——DOC_TYPE_TOP=20 截断与 more 计数在真主题规模下正确工作;
- 表首类型 `StarShopBuyBtn`(colors 2 / constants 2 / styleboxes 5 / font_sizes 1 = 通道条目总数 10,按总数降序)——靶子主题是按钮重主题,排序结果与视觉直觉一致;
- names 每通道 top 10(GD 侧截)+ 表内前 5 双截断:表中可见 `2: font_color, font_shadow_color` 形态(通道总数: 前 5 names),无一类型单通道超 5 名,`(+N more)` 本次未触发(379 type 的单通道 names 均 ≤5,截断层仍被 top 20 类型截断覆盖验证);
- **引擎约束提示节** 4 行:三条固定(ProgressBar ~27px 钳制 / Label 垂直居中 / self_modulate)+ 默认字体行 `未设置(回落 ThemeDB fallback)`(M4 裁决接受的 inspect 数据附加行)。

## 3. ③ compact 分档:副本场景 measure 真数字

`ui_measure_layout(scene_path=副本(import 后), theme_path=default_theme.tres 运行时挂载, detail='compact')`:

- `data.detail = 'compact'` 挂出 ✓(quality/order 有发现时);
- **quality**(全字段 `{entries, summary:{total, truncated}}` 对象化形态,截断数学自洽 `entries.length = min(total, 20)`):

| 字段 | total | 构成 |
|---|---|---|
| `bare_shells` | 3 | `Panel`(11 子)/ `Panel/MoneyLay`(4 子)/ `Panel/TopRigLay`(18 子)——裸 Control 壳纯 offset 绝对定位 |
| `should_follow` | 1 | `Panel/Bj` 子 rect 贴合父 rect 但 anchor 全 0 |
| `out_of_bounds` | 0 | — |
| `viewport_overflow` | 0 | — |

- **order**:`equidistant` 0 / `alignment_lanes` **13**(Panel 下 4 条 + MoneyLay 3 条 + TopRigLay 6 条;最大多数派 8 节点共享 top 75.8px 对齐线——DayNum/Tian 系列日条目);`spacing_scale` 未挂(真主题无 DesignTokens space_* 声明,档位检测数据源缺省跳过——契约内行为)/ `visual_groups` 无发现未挂;
- measure 元数据:viewport 960×540 / `stalled=false` / `stable_after_frames=3` / node_count **40**(36 既有 + _PrototypeRoot + 3 注入——与 import 注入数自洽)。

真场景 quality 有裸壳发现(bare_shells 3)——**如实记录,不修饰**:这是 daily_login 既有布局形态(批2 质量报告同源发现),恰证明 compact 分档在真靶子上输出可用的人读摘要而非空转。

## 4. 靶子 git 状态(只读纪律)

断言语义 = 与验收前形态一致(批3 同款 orchestrator 裁决):驱动验收前记录 `git -C 靶子 status --porcelain` 快照,finally 清理副本后断言逐行一致。

本次实测:验收前快照 = **干净(空)** → 验收后逐行一致 ✓。真 theme / 真场景文件零写入(theme 两消费点只读 + 场景操作全经 `_batch4_copy.tscn` 副本)。

> 驱动防线(批3 同款):`fail()` 抛异常不 `process.exit`(exit 跳 finally);快照前幂等预清理 `_batch4_*` 残留防历史垃圾混入快照。

## 5. 快照 ×3 归档

| 文件 | 内容 |
|---|---|
| `docs/superpowers/plans/refero-batch4-acceptance/extract-import-chain.json` | ① 副本链全记录:geometry + import(persist/verify_coverage/layout_verify 计数/style_verify x6/build_warnings)+ extract(逆向节点并集/report 三组聚类/draft/notes) |
| `docs/superpowers/plans/refero-batch4-acceptance/export-doc-default-theme.json` | ② DESIGN.md 全文(41 行)+ 派生计数(doc_lines/type_rows_shown 20/more_types 359/types_total 379/design_tokens_empty) |
| `docs/superpowers/plans/refero-batch4-acceptance/measure-compact-report.json` | ③ compact 真数字:measure 元数据(viewport/stalled/stable/node_count)+ quality/order 对象化全量 + compact_totals 摘要 |

## 6. 结论

批4 三项新增面(extract_tree / export_doc / detail=compact)在真实靶子上全链路自洽:override 逆向对账 14 项全过(token 可从输入推出、bg 分量位级 ===、平票锚复现)、只读导出双截断按预期触发(379 type → top 20 + 359)、compact 对象化形态 + 截断数学在真场景 quality/order 发现(裸壳 3 / 对齐线 13)上成立。靶子零形态改变(git 快照逐行一致)。Refero 四批的工具链证据链(批1 布局约束 → 批2 布局秩序 → 批3 tokens → 批4 periphery)在靶子上全部落档。
