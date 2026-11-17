# Refero 设计系统借鉴落地 — 设计文档

日期:2026-11-16
状态:v3(2026-11-17 批3 Task 5 维护:D8 补字段级输出纪律、新增 D10 theme_path 显式传递、批3 节 token_set 表述修正为文件级 action;v2=2026-11-16 吸收外部审查 BLOCKING 项修订:4 P0 + 7 P1 + 9 Nits 全部对账核实后落实)
来源:[styles.refero.design](https://styles.refero.design/) 方法论分析(2026-11-16 会话)+ 用户痛点澄清 + 外部审查(file:line 级对账)

## 意图与为什么

Refero Styles 把知名网站的设计系统逆向成 AI 可读的 DESIGN.md,核心方法论:**把"设计品味"文件化——视觉选择变成可复用规则(比例系统),而不只是散点数值;约束(Do's and Don'ts)比参数更能让 AI 输出统一风格;单源多格式**。

用户的真实痛点(在 DotaLegendGodot 复刻项目中实证):**AI 生成的 UI 节点之间没有布局约束关系**——

1. **裸壳**:`MoneyLay` 这类壳(源 lua 里是有排布语义的 layout 容器)直译成裸 `Control`,子节点全绝对坐标,关系只活在注释文字里("label 右+20"),不可执行;
2. **溢出**:子节点跑出容器外,`clip_contents=false` 不裁剪,直接叠到外面;
3. **乱飘**:节点没有相对父/相对兄弟的约束,像独立摆放;
4. **换档崩**:`layout_mode=0` 硬 offset 不随父缩放,g960→g800 分辨率档全量错位(tscn 注释自认"过渡态")。

用户心智模型来自安卓:LinearLayout/RelativeLayout 里容器天然限制子节点。Godot 有等价物(Container 系 + anchors),但 AI 直译时全部绕过。

靶子项目复刻链**不走浏览器原型**(项目内仅 web-gui 生成的 `面板入口.html` 入口页,非复刻产物),是 Cocos lua 源直译;ui_import_prototype 的浏览器提取增强对本项目是第二战场。

## 目标(按批次)

| 批 | 内容 | 解决 |
|---|------|------|
| 批1 | 布局约束保真:主题挂载→基线→四类机检→锚点改造工具 | 裸壳、溢出、乱飘、换档崩(直接痛点) |
| 批2 | 布局秩序 verify:间距档位 + 对齐线 + 视觉组聚类 | "散点数值 → 比例系统" |
| 批3 | tokens 层:`$token` 引用 + Theme 真源 | 样式重复、单源多格式 |
| 批4 | 周边工具:verify 分档 + 整树样式勘察 + DESIGN.md 导出 | 上下文成本、逆向工程闭环 |

## 非目标与反目标

- **不做** Godot 风格内容库;**不做**规则 DSL(第一批只做内置检查项;复杂断言走 `verify_delivery` 既有 GDScript 通道);**不做** JSON 中间真源。
- **反目标(验收级)**:容器化/锚点改造破坏复刻精度——"坐标是圣经"。判据:**0 容差**(v2 修订:原 2px `layout_verify` 绿不足以证明"逐像素不变";`layout-diff.ts:65-66` 四边各 ≤2px 仍算绿)。批1 一切改动在 960 基准档下逐节点 rect 与基线 **0 容差一致**(实现前提:`solve_from_current` 写回浮点 offset——现有 `solveAnchors` 的 `Math.round` 会引入 ≤1px 舍入,0 容差下误报)。

## 关键决策(对话已定,不重开)

1. **Theme (.tres) 是唯一真源**;命名 token 存 Theme 自定义 type `DesignTokens`。
2. **`$token` 引用,查不到明确报错**(`TOKEN_NOT_FOUND`),不静默 fallback。
3. **批次顺序**:批1→批2→批3→批4;批1 内部顺序见批1 节(v2 重排)。
4. **验收靶子**:`D:\workspace\projects\DotaLegendGodot`(960×540 视口、canvas_items stretch、g960/g800 双档)。
5. **g800 验收基准(用户已定)**:位置/中心线对齐,尺寸容偏(纯比例锚点;双档换算非均匀 x/w×5/6、y×8/9、美术 h×5/6,高度偏 ~5.6% 容忍,g800 为逃生门档)。
6. **验收范围(用户已定)**:只看 tscn 静态 chrome;`daily_login_panel.gd` 的 g960 绝对常量运行时重排属游戏代码,留给项目自身 RES_PROFILE 体系,批1 不动。

## 现状锚点(2026-11-16 侦察,v2 修正行数口径)

`src/tools/ui/` 共 12 文件 3535 行,其中:`ui-layout.ts`(775,ui_build_layout)、`index.ts`(758,schema/handler/TOOL_META 所在——v1 遗漏此关键文件)、`prototype-import.ts`(505)、`pixel-verify.ts`(288)、`layout-diff.ts`(273)、`ui-theme.ts`(258)、`types.ts`(163)、`ui-measure.ts`(160)、`ui-draw.ts`(127)、`ui-create.ts`(101)、`ui-import-single.ts`(84)、`anchor-solver.ts`(43)。

- `FlexLayout`(types.ts:74-83)已含 `direction/justify/align/wrap/gap/row_gap/padding/columns`——容器语义在声明侧完整,缺的是直译链不经过它。
- `MeasuredNode`(layout-diff.ts:12-21)已回读 `anchors/offsets`——**注意 `layout_mode` 不回读**(ui-measure.ts:121-128),编辑器属性不可作机检判据(N2)。
- `detectOutOfBounds`(layout-diff.ts:108-126)**根节点与一级子都跳过**(113 行 `!p` 跳根、115 行父不在测量集跳一级子)——对"Panel 相对视口越界"这一 g800 最典型失败形态全盲(P1-1)。measure 输出已有 `viewport`(ui-measure.ts:108-112)可用。
- `diffLayout` 容差在调用点硬编码 2px(index.ts:505)(P0-4)。
- `solveAnchors`(anchor-solver.ts:28-43)产比例锚点(1e-6 吸附 0/0.5/1)+ `Math.round` offsets;`CONTAINER_CONTROL_TYPES` 容器清单在 anchor-solver.ts:12-16。
- `theme_path` 参数**已存在于 `ui_set_theme`**(index.ts:102,save/load 用)——批2/批3 是**沿用同名扩展到 `ui_measure_layout`/`ui_import_prototype`**,不是新发明(N4)。
- proto-geometry 是 strict schema(`flow` 为字符串枚举 `z.enum(['row','column'])`,prototype-import.ts:133);翻译器是**纯函数零 Godot 依赖**(prototype-import.ts:2)——批3 token 解析通道的架构前提(P1-3,见批3 节)。
- STYLEBOX_SLOTS TS/GD 双份硬编码(types.ts:101-106 与 ui-measure.ts `_all_slots`)。
- `theme_set_property` 已支持任意 themeType 的 set_color/set_constant(ui-theme.ts:201-227)但**不落盘**(无 ResourceSaver);`theme_create(extract)` 只读 `source.theme` 单节点(ui-theme.ts:140)(N6)。
- `sanitizeResPath` 先例在 ui-theme.ts:207(P1-6 复用)。
- 靶子项目:主题**只由 autoload 挂根**(theme_manager.gd:13-19 `get_tree().root.set_theme(_theme)`);`daily_login_content.tscn` 无脚本依赖、大量节点靠 `theme_type_variation` 取字号(14/20 号仅在 default_theme.tres:1845-1849)。

## 仓库级改动面清单(P0-1,v2 新增;照 prototype-import spec §6 惯例)

| 登记 | 位置 | 纪律 |
|---|---|---|
| 新 action 名 | `types.ts` ACTIONS + `ui/index.ts` TOOL_META.actionRisks(标 `write`/`read`)| `satisfies Record<typeof ACTIONS[number], RiskLevel>` 编译期穷尽——漏补即编译红 |
| 新参数 | `ui/index.ts` inputSchema | CI `check:ssot-params` 对账**生成产物** `docs/capability-matrix.json`——须先 `npm run build-matrix` 再跑 check,否则老 matrix 对老 schema 假绿 |
| 规则文档 | `.claude/rules/godot-mcp-ui.md` **与** `src/tools/rule-templates.ts`(约 593-760 段)双副本 | `check:rules-sync` STRICT 阻断;模板变更触发 `check-rules-version-bump.mjs` 的 bump 硬门禁(AGENTS.md N-C 例外条款) |
| 版本/日志 | `npm version`(门禁联动)+ CHANGELOG | `check:changelog-sync` |
| 上下文预算 | token 预算 | `check:budget` |
| 大量新增 props 时 | `src/core/module-loader.ts` | 按 module 生成机制评估 |

## 批1 设计:布局约束保真(v2 重排内部顺序;生成侧/机检侧的新表述见 §决策记录 D7)

**执行顺序(P0-2 修正:主题语境先行,否则基线自证)**:

### 1a. measure 的主题挂载 + viewport 参数(先行 spike)

- `ui_measure_layout`/`ui_import_prototype` 扩展 `theme_path` 参数(沿用 ui_set_theme 同名):measure 生成脚本在加载场景后 `root.set_theme(load(theme_path))`。
- **必须先行的原因**(P0-2,已核实):measure 脚本 `extends SceneTree` → executor 强制 `loadAutoloads = false`(gdscript-executor.ts:771-774)→ 靶子项目 ThemeManager 不跑 → 根无主题 → `theme_type_variation` 节点回落默认 16 号,Label 最小行高与设计值不同。**主题敏感场景的 rect 在无主题 measure 进程里是错语境**。
- `ui_measure_layout` 新增 `viewport` 参数(模拟视口尺寸,g800 复测通道):headless 下 root size 控制可行性须先 spike(不可行则退窗口模式 `run_project` + `dump_layout_tree`;靶子项目 `window_width_override=1920`,窗口模式开 800 宽的可行性同样须 spike)。
- **假绿防护**:viewport 参数生效验证——改 viewport 后至少一个非全铺节点的 rect 必须发生变化,否则报"viewport 未生效"警告(防"只报了新 viewport 但布局没动"的静默假绿)。

### 1b. 重取 g960 基线(0 容差格式,P0-4)

- 基线 = 主题挂载后的 measure 快照:**逐节点 rect + anchors/offsets 原值**,存 JSON(`.godot/` 或 `test/__fixtures__/`)。
- 基线是 raw 节点清单,不是 `expect_tree`——比对方式为脚本逐值 0 容差(不依赖 `layout_verify` 的 2px 语义)。

### 1c. 检查器(四模式 → quality 报告节;P1-7 映射表)

| 模式 | 判据(只用 anchors/offsets + 类型 + rect,N2) | 报告节 | 后续工具 |
|---|---|---|---|
| A.1 裸壳 | Control 壳(非渲染件)下子节点 ≥2 且四 anchor 全 0 纯 offset | quality | `solve_from_current` |
| A.2 应跟随 | 子 rect ≈ 父 rect(容差 2px,全铺背景类)但 anchor 全 0 | quality | `solve_from_current` |
| A.3 等距组 | 兄弟沿轴相邻间距差 ≤2px 且 ≥3 个 | order | AI 决定容器化(ui_build_layout) |
| D 溢出 | 子节点出父界(升级 detectOutOfBounds)+ **新增节点 vs viewport 边界检查**(P1-1:现根/一级子全盲,g800 的 Panel 越视口恰是典型形态) | quality | AI 按报告改 |

- 溢出门禁阈值默认 4px;quality/order **默认仅在有发现时输出**(空则省略,不增常态 token 负担;全量可 `checks` opt-in)(P1-4)。
- `stalled=true`(布局未收敛)时**不出判定**,只报 stalled(P1-4)。
- 报告量预估(N2,验收前置):daily_login 28 节点,Panel/TopRigLay/MoneyLay 壳预计全部命中 A.1——**预期行为**。验收标准相应从"清零"改为**"名单化处置"**:每个报告项要么改造、要么标注豁免(纯静态装饰,A.2/A.3 同理),处置记录随基线归档。
- 报告量实测(2026-11-16 Task 4 靶子 e2e,挂主题 g960 measure 一次):**裸壳 A.1 ×3**(Panel / Panel/MoneyLay / Panel/TopRigLay,与预估名单完全一致)/ **应跟随 A.2 ×1**(Panel/Bj)/ 父级越界 ×0 / 视口溢出 ×0(g960 全在内,g800 档才会暴露 Panel 越宽)/ **等距组 A.3 ×0**——等距判定限正间距(等量叠压堆叠非容器化候选,靶子实测 6 组负间距全被正确抑制)。锚定测试 `test/ui-quality-check.test.ts`(双 skipIf:GODOT_PATH + 靶子项目存在)。

### 1d. `solve_from_current`(唯一写盘新工具,P0-3 语义全部本节定死)

- **反解数据源 = 授权几何**(v2 双轨:授权几何反解 + 主题挂载 measure 验证):读 tscn 文本的 offsets + 父授权尺寸**直接解析**,不经运行时 measure——彻底脱开主题依赖(P0-2 后果 2 的根治:不会把脱主题语境的钳制高度固化进锚点)。主题挂载后的 measure 只做**验证侧**(1b 基线比对)。
- **锚点选择策略**:沿用 `solveAnchors` 的比例锚点 + 0/0.5/1 吸附(Godot "SCALE" 语义,对 g800"位置对齐"决策正确——位置按比例跟随)。反解欠定性由此收敛为单一规范解:全比例锚点 + 对应 offsets。
- **offset 不 round**(v2 细化):保留浮点(tscn 合法),达成 0 容差;现有 `solveAnchors` 的 `Math.round` 不动(生成链既有行为),`solve_from_current` 用不取整变体。
- **排除 Container 子节点**:父类型在 `CONTAINER_CONTROL_TYPES`(anchor-solver.ts:12-16)的子节点跳过并在响应中点名(容器每帧重排 anchors/offsets,写进去即静默失败——rule-templates.ts 容器重排条目)。
- **写回通道 = tscn 文本 patch**(`src/tscn/` 段落级编辑原语):保留 tscn 内解释性注释(靶子项目靠注释记录"g800 过渡态"等审计线索,`PackedScene` 重存会整文件重写毁掉注释)。
- **`layout_mode = 1`(anchors)** 同步写入被转换节点;检测判据不依赖 `layout_mode`(measure 不回读它)。
- 支持 filter(节点名单/模式)排除纯静态装饰。
- 安全:进 ACTIONS + actionRisks 标 `write`;路径过 `sanitizeResPath`(P1-6)。

### 1e. ui_import_prototype 提取脚本升级(第二战场,P1-2 BC 定案)

- evaluate 模板:自动读 `getComputedStyle(el).display` 识别 flex/grid(带出 flex-direction/gap/align-items/justify-content);`data-flow` 显式标注优先。
- **schema BC(P1-2)**:`flow` 保持字符串枚举不动(公开契约,破坏即违"默认行为不变")——新增**平级可选键** `flow_gap: number`、`flow_align: string`(cross 轴),strict 白名单登记;容器语义不塞进 flow 对象。文本 `align`(left|center|right)与容器 `flow_align` 分立,不混淆。
- 翻译器:任意深度 flow 壳子节点进 Container(现状仅单层);`flow_gap` 落地为容器 separation。

### 批1 验收

1. `daily_login_content.tscn`(建议)主题挂载后取 g960 基线(1b 格式);
2. 按检查报告(A.1/A.2/D)落地 `solve_from_current` + 容器化决策,报告项**名单化处置**(改造或标注豁免);
3. g960 档逐节点 rect 与基线 **0 容差**一致(1b 比对脚本);
4. g800 档(viewport 参数或窗口模式,1a spike 定通道)实测:位置/中心线对齐官方 g800(尺寸容偏,决策 5);一级 Panel 不越 800 宽视口;
5. quality 报告处置名单归档。

## 批2 设计:布局秩序 verify

Theme `DesignTokens` type 下声明 spacing 档位(`set_constant("space_1".."space_8", "DesignTokens", 4/8/12/16/24/32/48/64)`,档位值项目自定)。**读取通道(N4 修正表述)**:`theme_path` **沿用 ui_set_theme 既有参数名,扩展到 `ui_measure_layout`/`ui_import_prototype`**(批1 已先行引入用于主题挂载,批2 复用读 constants)——单参数单语义,不造第二轮加参。

`ui_measure_layout`(及 ui_import_prototype verify)新增 `order` 报告节:

1. **间距档位**:兄弟相邻间距(gap = 后缘−前缘,非中心距)对照档位表,容差 2px;报"落档率"+ 落档外清单。无档位声明跳过不发噪音。
2. **对齐线**:同父兄弟左/右缘/中心线聚类(容差 2px),报"多数派 + 离群者"。纯检测不强制。
3. **视觉组聚类**:兄弟间距单链接聚类(阈值默认取档位表最大值)→ 容器化建议文本。只读不改。

输出纪律同 1c:仅有发现时给、stalled 不判定(P1-4)。

## 批3 设计:tokens 层

- proto-geometry schema:颜色字段(`bg/color/fill/border.color`)接受 `"$name"` 引用(strict 白名单放行 `$` 前缀字符串,与现有三格式并列)。
- **token 解析通道(P1-3 定案:GD 预取注入,保持翻译器纯函数)**:翻译前由 GD 侧一次性执行 `load(theme_path)` → 遍历 `DesignTokens` type 导出全量 `{name: value}` JSON map → 作为 `token_map` 入参注入翻译器。翻译器本体仍零 Godot 依赖,单测用 fixture map;TS 侧**不**解析 .tres 文本(复刻 Godot 序列化格式脆)。查不到 → `TOKEN_NOT_FOUND`(点名 token 名 + theme 路径)。
- `theme_path` **无默认值**(D10):`$token` 引用必须显式传 theme_path,缺省报 INVALID_PARAMS;`res://ui/theme.tres` 仅为错误提示语中的**约定路径建议**(提示语提示,非隐式回退——显式优于隐式,静默回落默认值会把 token 解析/写入指向错误主题),靶子项目实际配 `res://resources/themes/default_theme.tres`。
- `token_set`(**N6 组合关系明示**):**文件级新 action**——项语义对齐 `theme_type="DesignTokens"`,自带 ResourceSaver 原子落盘,**不经场景节点**(theme_set_property 操作场景节点的 theme 且现状不落盘;token_set 面向 theme 文件本身,不是 node.theme 的语法糖);`token_list` 读全量。token 名进 GDScript 前白名单校验(字符集 `^[A-Za-z_][A-Za-z0-9_-]*$`,对齐 gdEscape 纪律)(P1-6)。
- StyleBoxFlatSpec 颜色引用 token 时仍逐节点 override;StyleBox 共享去重留批4 评估。

## 批4 设计:周边工具

1. **verify 分档**:`detail: "compact" | "extended"`(默认 extended 兼容现状)。compact:diff/order/quality 各节只返回不 ok 条目 top-20(按偏差量排序)+ 计数 summary。
2. **`extract_tree`(N6:与既有 `extract` 语义差距大,名不动但契约独立)**:整树扫描场景 stylebox override/font_size/color,按 spec 聚类,产出 ① Theme 草稿(高频 spec → 类型槽位)② 报告(每类出现次数/节点清单/建议 token 名)。只产草稿与报告不自动改场景。与 `extract`(单节点 `source.theme` 直读)是两个契约。
3. **DESIGN.md 导出(N8:独立只读 action,不挂 ui_set_theme/theme_create)**:`export_doc`(暂名,与 `token_list` 同族):从 Theme 导出人读文档——DesignTokens 全量表 + 类型槽位摘要 + 引擎约束提示(ProgressBar 27px 类)。文档是视图不是真源。

## 约束

- **向后兼容**:所有新参数可选、默认行为不变;proto-geometry 新键(`flow_gap`/`flow_align`/`$token`)为平级可选,不动既有字段形态。
- **strict schema**:新参数全部进 inputSchema;先 `build-matrix` 再 `check:ssot-params`(改动面清单表)。
- **GD/TS 双侧清单同步**:spacing 档位读取、token map 导出若两侧有清单,登记同步点。
- **安全/健壮(P1-6)**:写盘类新 action(`solve_from_current`/`token_set`/`extract_tree` 草稿落盘)全进 actionRisks 标 `write`;资源路径过 `sanitizeResPath`;token 名/节点名进 GDScript 前白名单校验。
- **测试**:检查函数单测(layout-diff 扩展);靶子验收为**手工流程**(靶子路径不在本仓库,CI 永远跑不到——脚本落 `scripts/` 或 `test/` 但标注 `GODOT_PATH` + 靶子存在性双重 skipIf,文档明示手工执行)(P1-5)。
- **headless 限制**:像素级验证须窗口模式;数值检查走 measure 链**但须主题挂载**(P0-2:主题敏感场景的 rect 无主题即错语境)。

## 决策记录(N9,v2 新增)

| # | 决策 | 依据 |
|---|------|------|
| D1 | Theme (.tres) 唯一真源,token 存 DesignTokens type | 对话(用户授权"最适合 Godot 的") |
| D2 | g800 基准 = 位置对齐尺寸容偏;验收只看 tscn 静态 chrome | 对话(AskUserQuestion 2026-11-16) |
| D3 | 批1 内部顺序:主题挂载→基线→检查器→反解工具(原"生成侧先行"作废) | 外部审查 P0-2/N7 |
| D4 | `solve_from_current` 反解数据源 = 授权几何(tscn 文本),measure 只做验证 | 外部审查 P0-2 建议 b + 自核(theme 语境根治) |
| D5 | 写回 = tscn 文本 patch(保注释),`layout_mode=1`,浮点 offset | 外部审查 P0-3 + 自核(Math.round 舍入) |
| D6 | flow schema BC:平级新键 `flow_gap`/`flow_align`,不动枚举 | 外部审查 P1-2 |
| D7 | token 通道 = GD 预取 map 注入,翻译器保持纯函数 | 外部审查 P1-3(方案自定) |
| D8 | quality/order 报告输出纪律:**节级省略**(整节无发现不挂字段,null 语义——quality 四类全无发现省略 quality 节;order 四类检测任一无产出省略 order 节);**已挂节的必检字段空数组照挂**(`equidistant: []`/`alignment_lanes: []`——必检检测恒跑,空数组区分"检测了无发现"与"未检测");**条件性检测字段未触发时省略**(`spacing_scale` 依赖档位声明、`visual_groups` 依赖阈值缺省链,缺席 = 未跑不发噪音,接口层 optional);stalled 不判定 | 外部审查 P1-4;批3 Task 5 按实现实况(quality-check.ts OrderSection/QualitySection)补字段级纪律 |
| D9 | 验收 0 容差(2px 绿不承载"坐标是圣经");基线为 raw 快照非 expect_tree | 外部审查 P0-4 |
| D10 | theme_path 无默认值——`$token` 引用必须显式传 theme_path;`res://ui/theme.tres` 仅为错误提示语中的约定路径建议(显式优于隐式,静默回落默认值会把 token 解析指向错误主题) | 批3 Task 3 实现(缺 theme_path 报 INVALID_PARAMS 附约定路径指引);批3 Task 5 spec 定档 |

## 开放问题(N9,v2 新增)

1. headless viewport 控制可行性——**已实测(批1 1a Task 2 spike,2026-11-16,Godot 4.7 headless --path --script,探针不留仓库)**:①`root.content_scale_size = Vector2(w,h)` 直接赋值不生效——当刻读回新值,后续帧被引擎复位回项目设置(960×540),布局不重排;②`root.set_size(Vector2i(w,h))` 同样被复位(WIN 回 64×64,headless DisplayServer 窗口尺寸不可控);③**SubViewport 通道生效(已采用)**——场景实例挂进 `SubViewport(size=w×h)`,Control 树按注入视口重排:靶子 960×540 默认注入 800×480,全铺场景根 rect.w 960→800(e2e 硬断言锚定)。附带实测:root.set_theme 的主题传播不跨 Viewport 边界,viewport 注入时 themeMount 须改挂场景根;假绿防护的"非全铺节点 vs 默认视口基线"辅判据因挂 root 基线与 SubViewport 覆写轮的语境噪声(headless Window 不可信 + stretch 字体度量失真)弃用,主判据(全铺节点 rect.w 贴合注入视口宽)未命中即 `viewport_check: inconclusive` 诚实降级。锚定测试 `test/ui-measure-viewport.test.ts`。
2. 窗口模式下 800 宽与 `window_width_override=1920` 的相互作用(spike)。
3. 主题敏感高度偏差量级——**已实测(批1 1a spike,2026-11-16,Godot 4.7)**:①无 autoload 的最小 fixture(theme_type_variation Label,显式高 24px):无主题 rect.h=24(默认 16 号行高不顶开),挂主题(30 号)=42——**+18px,远超 2px verify 容差**,推理链成立且量级可观;②靶子项目 DotaLegendGodot `daily_login_content.tscn` 的 LoginMonthLabel:无 theme_path 与挂 theme_path 两轮 rect.h 均 28、Δ=0——**根因是实测新发现**:`--headless --path <project> --script` 模式下引擎仍加载 project autoload(loadAutoloads=false 只影响 TS 侧包装路径),ThemeManager._ready 自动挂根主题,两轮同在主题语境——P0-2「headless 无 autoload 主题管理」的前提在**自带 ThemeManager autoload 的项目**不成立,theme_path 的价值在无 autoload 挂载的项目/场景与显式指定异于项目默认主题的语境。锚定测试 `test/ui-measure-theme.test.ts`。
4. A.1 "非渲染件"判定细则(纯 Control 无 texture/text/stylebox 即视为壳?Panel 带 stylebox 算不算?)——实现前用一个真实场景标定,避免报告量失控。

## 留给实现者的(仅文件归属/命名;契约语义已全部上文定死)

- 检查函数文件归属(layout-diff.ts 扩展 vs 新文件,按 ≥2 文件建目录规则)。
- compact top-N 的 N 值与排序键。
- `solve_from_current` 的 filter 参数形态、`export_doc` 最终命名。

## 总验收(DotaLegendGodot 试金石)

复刻一个尚未做的新 UI 场景(从官方 lua 源直译),全程走新链路:

1. 直译产物过 quality/order 报告:报告项全部名单化处置(无未处置项),间距落档率 100%(或落档外有明确豁免理由);
2. g960 档 0 容差不回归;g800 档位置对齐、不越视口;
3. 样式 token 化:同 spec 复用 token,`token_list` 可审计;
4. 与旧链路产物对比:节点数、960 档 0 容差、双档稳定性、报告可读性。
