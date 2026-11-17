# Refero 批4「周边工具」实施计划(v2,按外部计划审查修订)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` syntax for tracking.

**Goal:** verify 输出分档(compact 省流)+ `extract_tree` 整树样式逆向(Theme 草稿与报告)+ `export_doc` DESIGN.md 导出——Refero 系列的收尾周边工具。

**Architecture:** ① compact 是**纯后处理**:diff 系条目与 quality/order 字段在不 ok 侧过滤、按偏差量排序、top 20 截断并附计数 summary——**compact 形态定死为"被压缩的数组字段从裸数组变为 `{entries, summary}` 对象"**(extended 默认路径逐字节不变);② `extract_tree` 两段式:GD spawn1 扫描场景(**override-only**:has_theme_*_override 门控后再读值)→ TS 纯函数按 spec 聚类 → 可选 GD spawn2 把草稿原子落盘;只产草稿与报告不自动改场景;③ `export_doc` 只读:GD load theme 导出 DesignTokens 全量 + 逐类型槽位清单(**类型 top 20 + names 每通道 top 10 双截断防文档爆炸**)→ TS 拼 markdown **随响应返回不落盘**(文档是视图不是真源,N8)。

**Tech Stack:** TypeScript(vitest + zod strict)、GDScript 生成脚本。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-16-refero-design-system-design.md`(v3 批4 节 + 约束节)

## Global Constraints

- **向后兼容**:`detail` 默认 `extended` 且 extended 路径**响应逐字节不变**(既有测试即回归锚);新 action/新参数不动既有字段形态。
- **strict schema + 生成物纪律(H-5)**:凡改 schema 的任务必须 `npm run build-matrix && npm run gen:tool-docs` 并把 `docs/capability-matrix.{json,md}` + `docs/tools/` 漂移纳入同一 commit;先 build-matrix 再 check:ssot-params/check:budget。
- **计数与版本时序(批4 关键裁定)**:规则/计数/版本变更**全部集中在 Task 3**(extract_tree+export_doc 同任务落地 → 计数 277→279 一笔同步、规则双副本一笔、`npm version minor --no-git-tag-version` 0.37.0→0.38.0 单 bump)——Task 1/2 **不触碰** `src/tools/rule-templates.ts` 与计数面,规避 N-C 逐任务 bump 冲突;计数承载文件 = **8 文件中 5 个含 action 数**(README.md、README.en.md、manifest.json、src/tools/rule-templates.ts、.claude/rules/godot-mcp-core.md;server.json/docs/distribution/docs/migration 仅工具数不变不动——以实跑 `npm run check:tool-count` 漂移清单为准逐处修)+ `test/ui-tools.test.js` 两处计数断言 16→18。
- **版本纪律(N-C 四件套,Task 3 一笔)**:`npm version minor --no-git-tag-version` → `npm run version-sync`(A 类 6 文件,含 `addons/godot_mcp_server/plugin.cfg` 全路径)→ README 版本行 → CHANGELOG `## [0.38.0] - <当日>` 定版段(批4 三工具一笔收编)+ **[Unreleased] 保留实质内容(去符号后 >50 字符)**;`package-lock.json` 核对。**commit 主题避免 `top-20` 字样**(会被 changelog-sync 的标识符正则 `[A-Za-z]{2,}-\d+` 误判为任务号,写「top 20」空格形式或「topN」)。
- **lint 纪律**:凡改 `src/`/`test/`/`scripts/` 的任务 commit 前 `npm run lint`(基线 533 零新增)。**rules-sync 顺序:先 `npm run build` 再 `STRICT=1 npm run check:rules-sync`**(check 读 build 产物)。
- **P1-6 安全**:`extract_tree` → actionRisks `write`(可落盘),`export_doc` → `read`;`draft_path` 过 `sanitizeResPath` + `resolveWithinRoot`;GD 内插全部 `escapeForGdLiteral`;草稿写入复用 token_set 原子模式(tmp+rename)。
- **extract_tree 契约独立(N6)**:与 `theme_create(extract)`(单节点 source.theme 直读)两个契约,规则文档写明;只产草稿与报告不自动改场景。
- **文档是视图(N8)**:export_doc 只读不落盘;类型槽位双截断(类型 top 20 排序键 = 通道条目总数,逐通道 names top 10,超出 `(+N more)`)。
- **双侧清单同步点登记(I5)**:Task 3 在 `types.ts` 两处注释随动——STYLEBOX_SLOTS 的 GD 副本从双份变三份消费点(measure `_all_slots` + extract_tree 扫描 + 既有注释);DESIGN_TOKENS_TYPE 消费点清单追加 ui-extract/ui-export。
- **靶子约束**:真实文件只读、不提交;验收副本 `_batch4_*` 前缀、finally 删除、git 断言 = 与验收前 porcelain 快照一致;`GODOT_PATH` + 靶子存在性双 gate。
- 注释简体中文;commit `feat(ui)/chore(ui)/docs(ui)/fix(ui): ...`(中文描述)。

## Review Focus

1. **extended 默认逐字节不变**——不传 detail 的既有 measure/import 响应形状与字段序不得变(既有全量测试 + 新增对照锚)→ Task 2 测试。
2. **排序键的 NaN**——diff 条目 delta 含 NaN(缺失读数)时按最大偏差排最前,计入 non_ok,不得被数值 sort 丢弃 → Task 2 纯函数单测。
3. **override-only 读值顺序**——GD 无 override-only getter,`get_theme_stylebox(` 必须出现且**在 `has_theme_stylebox_override(` 门控之后**(顺序锚,非"不含"锚);无 override 节点不进报告 → Task 3 generator 单测 + e2e。
4. **草稿落盘与空行为**——draft_path 越界拒;空扫描(无任何 override)→ 空报告 + **不落盘不挂 persist** + note 一行;不可映射类型(非 Panel/ProgressBar/Button/Label)→ 报告含组、草稿跳过并在 draft 注记 → Task 3 handler 单测 + e2e。
5. **空/超大 theme 的 export_doc**——裸 Theme 空档文档不报错;靶子级 1246 条通道条目 → 双截断生效(类型 top 20/names top 10),文档尺寸有界 → Task 3 单测 + Task 4 靶子实测。

---

### Task 1: budget 校准(首任务;批4 前置)

**Files:**
- Modify: `scripts/check-token-budget.mjs`(THRESHOLDS + 校准史)

**Interfaces:**
- Produces: `perToolSchema.error` 13000→13600、`perToolTotal.error` 14000→14400;校准史注释。

- [ ] **Step 1: 实测记录**——Run: `npm run check:budget`;Expected: 0 error。记录:**ui schema 12656B / schema error 13000(余 344B)、total 13504B / total error 14000(余 496B)、desc 848B ≥ warn 800(既有 warn)**。归因:批3 Task 4 自身增量(token_name/token_value + enum +2 + description 扩写)吃到 12656——计划侧沿用 T3 时点旧数 12285 是 v1 审查 B1 抓出的口径债。
- [ ] **Step 2: 校准两线 + 校准史**——perToolSchema.error 13000→13600、perToolTotal.error 14000→14400(warn 线不动;desc 848 的 warn 是有意义瘦身提醒,记录不调)。校准史必含:①现状与 344B/496B 余量构成(批3 T4 正当增量);②批4 预计增量 ~300B(detail 参数 + draft_path + enum +2 + 描述),校准后余量 ~640B/~700B;③二次校准说明(批3 首录后隔日二录,理由同批3:批A 已证结构形状不可砍、继续压伤可用性);④error 硬线语义保留(回弹语义)。
- [ ] **Step 3: 复跑 + commit**

Run: `npm run check:budget`(0 error)

```bash
git add scripts/check-token-budget.mjs
git commit -m "chore(budget): ui schema/total error 线二录校准 13000→13600/14000→14400——批3 T4 增量水位接受(批4 首任务)"
```

### Task 2: verify 分档(detail: compact|extended,形态定死)+ intraGap 顺手简化

**Files:**
- Modify: `src/tools/ui/layout-diff.ts`(compact 纯函数)
- Modify: `src/tools/ui/index.ts`(schema detail 参数 + 三处应用点)
- Modify: `src/tools/ui/quality-check.ts`(intraGap 死分支简化:`c.gaps.length > 0 ? 均值 : 0` 的 `: 0` 不可达[多成员簇必有 ≥1 gap] → 直除)
- Test: `test/ui-layout-diff.test.ts` + `test/ui-import-prototype.test.ts`(扩展)

**Interfaces:**
- Consumes: `DiffEntry`、`StyleDiffEntry`、quality/order 节形状(quality-check.ts:360-376)。
- Produces:
  - `export interface CompactSummary { total: number; ok: number; non_ok: number; truncated: number }`
  - `export function compactDiffEntries(entries: DiffEntry[], topN = 20): { entries: DiffEntry[]; summary: CompactSummary }`——过滤 `!ok`,按偏差量降序(键 = max(|dx|,|dy|,|dw|,|dh|);**NaN 任一 → 最大排最前**;并列稳定按 path),截 topN;
  - `export function compactStyleEntries(entries: StyleDiffEntry[], topN = 20): { entries: StyleDiffEntry[]; summary: CompactSummary }`——同语义(delta 数值 |·| / 数组 max |分量| / null 最大);
  - **compact 响应形态(定死)**:`detail === 'compact'` 时——① `layout_verify.diff`、`style_verify`、`flow_verify` 三处从裸数组/嵌套数组**变为对象 `{ entries, summary }`**(layout_verify 其余键 targets/overlaps/out_of_bounds/viewport 原样保留——它们本就是"有发现才有"的天然紧凑清单);② `quality`/`order` 的**每个列表字段**(bare_shells/should_follow/out_of_bounds/viewport_overflow/equidistant/alignment_lanes/visual_groups)与 `spacing_scale.off_scale` → `{ entries, summary: { total, truncated } }`(按报告序截断,无排序——quality 项无数值偏差;visual_groups 外层截断、组内 members 不动);③ 顶层挂 `"detail": "compact"`;④ **不传或 extended → 全部路径与现状逐字节一致**;
  - schema:`detail: { type: 'string', enum: ['compact', 'extended'], description: 'ui_measure_layout(带 expect_tree)/ui_import_prototype: compact=verify 各节只返回不 ok 条目 top 20(按偏差量排序)+计数 summary,被压缩数组变为 {entries,summary} 对象;默认 extended 全量' }`。

- [ ] **Step 1: 失败单测(纯函数)**——混合过滤/summary 计数;25 条递增偏差截断+truncated;NaN 条目排最前计入 non_ok;style 三形态 delta 排序;恰好 20 不截。
- [ ] **Step 2: 失败单测(接线形态)**——import mock 两段式:① `detail:'compact'` + 2 条 diff(1 ok/1 偏 5px)→ `layout_verify.diff` 为对象 `{entries:[1 条], summary:{total:2,ok:1,non_ok:1,truncated:0}}` + 顶层 `detail:'compact'`;quality/order 字段对象化 + `{total,truncated}`;② 不传 detail → 无 detail 字段、diff 仍裸数组、与既有断言一致(逐字节锚)。
- [ ] **Step 3: 跑测失败**

Run: `npx vitest run test/ui-layout-diff.test.ts test/ui-import-prototype.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**——两纯函数 + index.ts 三处应用(measure 后处理段1/段3 + import 装配)+ schema detail + intraGap 顺手。
- [ ] **Step 5: 通过 + 生成物 + 门禁 + commit**

Run: `npx vitest run test/ui-layout-diff.test.ts test/ui-import-prototype.test.ts test/ui-quality-check.test.ts && npx tsc --noEmit && npm run lint && npm run build-matrix && npm run gen:tool-docs && npm run check:ssot-params && npm run check:budget`
Expected: 全绿(schema < 13600)

```bash
git add src/tools/ui/layout-diff.ts src/tools/ui/index.ts src/tools/ui/quality-check.ts test/ui-layout-diff.test.ts test/ui-import-prototype.test.ts docs/capability-matrix.json docs/capability-matrix.md docs/tools/
git commit -m "feat(ui): verify 分档 detail=compact——不 ok 条目截断+计数 summary,数组对象化形态(批4;intraGap 死分支顺手简化)"
```

### Task 3: extract_tree + export_doc 两 action + 全随动面 + 版本 0.38.0(单笔收口)

**Files:**
- Create: `src/tools/ui/ui-extract.ts`(genExtractTreeScript + 聚类纯函数 + genDraftSaveScript)
- Create: `src/tools/ui/ui-export.ts`(genThemeInspectScript + buildDesignDoc)
- Modify: `src/tools/ui/types.ts`(ACTIONS +2;STYLEBOX_SLOTS/DESIGN_TOKENS_TYPE 注释随动)
- Modify: `src/tools/ui/ui-tokens.ts`(**导出 `themeFileNotFoundBlock`**——ui-export 复用,不再模块私有)
- Modify: `src/tools/ui/index.ts`(schema draft_path + action 描述 + 两 case + actionRisks)
- Modify: `test/ui-tools.test.js`(16→18)+ 计数承载文件(以 check:tool-count 漂移清单为准,预期 5 个 action 数文件)
- Modify: 规则双副本 `src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-ui.md`(工具清单表 +2 行 + 两小节)
- Modify: `package.json` + A 类版本文件 + `README.md` 版本行 + `CHANGELOG.md` + `package-lock.json`
- Regenerate: `docs/capability-matrix.{json,md}` + `docs/tools/`
- Test: `test/ui-extract.test.ts` + `test/ui-export.test.ts`(新建,含 e2e)

**Interfaces:**
- Consumes: `DESIGN_TOKENS_TYPE`;`STYLEBOX_SLOTS`;token_set 原子落盘模式;`styleboxSlotFor`(prototype-import.ts);`PROGRESS_BAR_MIN_HEIGHT`;ui-measure `_walk` 的 stylebox 读回写法(:277-295)。
- Produces:
  - `export function genExtractTreeScript(scenePath: string, nodePath: string | undefined, maxDepth: number): string`——`_mcp_load_scene` + walk:每 Control ① `_all_slots` 各槽 `has_theme_stylebox_override(s)` **命中后** `get_theme_stylebox(s)` 读 StyleBoxFlat 四组字段;② `has_theme_font_size_override("font_size")` → `get_theme_font_size`;③ `has_theme_color_override("font_color")` → `get_theme_color`(Color 转 `[r,g,b,a]`);任一命中才输出节点;`_mcp_output("extract_scan", JSON.stringify({"nodes": [...]}))`;
  - `export interface ExtractScanNode { path: string; type: string; styles?: Array<StyleReading>; font_size?: number; font_color?: [number, number, number, number] }`
  - `export function extractTreeReport(scan: ExtractScanNode[]): { report: ExtractReport; draft: ThemeDraft | null; notes: string[] }`——纯函数聚类:① StyleBoxFlatSpec 规格键(bg_color 数组 join + corner/border 数值 + draw_center,精确匹配)→ `{spec, count, nodes, slots, suggested_token}`;② font_size 值 → 组;③ font_color 值 → 组;suggested_token 约定:`style_<slot>_<rrggbb>`(组内最高频 slot)、`font_size_<n>`、`text_<rrggbb>`;**draft = 非空时**:四类控件(Panel/ProgressBar/Button/Label,styleboxSlotFor)各取默认槽最高频 spec → set_stylebox + token 组 → DesignTokens set_color/set_constant;**空扫描 → draft 为 null、不落盘、notes 一行说明;不可映射类型 → 报告含组、草稿跳过并在 notes 点名类型**(Review Focus 4);
  - `export function genDraftSaveScript(draftPath: string, draft: ThemeDraft): string`——Theme.new() + StyleBoxFlat 逐字段 set + set_stylebox + set_color/set_constant(DESIGN_TOKENS_TYPE) + 原子落盘;草稿 JSON 内嵌(escapeForGdLiteral + `JSON.parse_string`,同 genStyleExpectInit 先例);`_mcp_output("draft_saved", ...)`;
  - `export function genThemeInspectScript(themePath: string): string`——无场景加载;load 缺失 → 复用 `themeFileNotFoundBlock`(经 mapper 前置分支 THEME_NOT_FOUND);导出 ① DesignTokens colors/constants 全量;② `get_type_list()` 逐类型四通道(`get_color_list/get_constant_list/get_stylebox_list/get_font_size_list`)names **每通道 top 10 + `_more` 计数**;③ default_font/default_font_size 有无;`_mcp_output("theme_inspect", ...)`;
  - `export interface ThemeInspect { tokens: { colors: Record<string, number[]>; constants: Record<string, number> }; types: Array<{ type: string; colors?: { names: string[]; more: number }; constants?: ...; styleboxes?: ...; font_sizes?: ... }>; has_default_font: boolean; default_font_size?: number }`(通道条目形态同名约定);
  - `export function buildDesignDoc(inspect: ThemeInspect): string`——markdown:`# DESIGN`(头部声明「本文档是 Theme 资源的视图,真源是 .tres;由 export_doc 生成」)+ DesignTokens 全量表(空 → 一行空档说明)+ 类型槽位摘要表(**类型按通道条目总数排序截 top 20,超出 `(+N types)`**;每类型各通道 counts + names 截断)+ 引擎约束提示节(固定三条:ProgressBar 默认主题最小高 ~27px 引用 `PROGRESS_BAR_MIN_HEIGHT`/Label 垂直对齐默认 TOP 需显式 CENTER/透明布局壳须 self_modulate 禁 modulate);
  - handler:`extract_tree`(scene_path 必填,node_path/max_depth 可选默认 16/cap 64,draft_path 可选 sanitize+resolve;spawn1 → 聚类 → draft_path 且 draft 非空 → spawn2 落盘;响应 `{report, draft, notes, persist?}`);`export_doc`(theme_path 必填;spawn → buildDesignDoc;响应 `{document, theme_path}`,不落盘);actionRisks `extract_tree:'write', export_doc:'read'`;
  - schema:`draft_path: { type: 'string', description: 'extract_tree: 可选 Theme 草稿落盘路径(.tres,相对项目;缺省只回报告' }`;theme_path description 追加 export_doc 语义。

- [ ] **Step 1: 失败单测(generator)**——genExtractTreeScript:**顺序锚**:`indexOf('has_theme_stylebox_override') >= 0` 且 `< indexOf('get_theme_stylebox(')`(Review Focus 3,非"不含"锚);含 font_size/color 门控、`extract_scan` 键、maxDepth 数字。genDraftSaveScript 含 `StyleBoxFlat.new()`/`ResourceSaver.save`/rename/`DesignTokens`。genThemeInspectScript 含 `get_type_list`、四通道 list、`theme file not found`。buildDesignDoc:表头/空档/引擎约束三词条/`(+N more)` 与 `(+N types)` 截断标记。
- [ ] **Step 2: 失败单测(聚类 + handler 校验)**——① 同/异 spec 分组计数与节点清单;② font_size/font_color 组;③ suggested_token 命名;④ draft 槽位选举(Panel 3 节点两同 spec → count 大者;Button 独立);⑤ **空扫描 → draft null + notes**(Review Focus 4);⑥ 不可映射类型(如 TextureRect 带 override)→ 报告含、draft 跳过 + notes;⑦ handler:缺 scene_path/draft_path `../` → INVALID_PARAMS;缺 theme_path(export_doc)→ INVALID_PARAMS;ACTIONS 含两新值;actionRisks write/read;ui-tools 计数 18。
- [ ] **Step 3: 跑测失败**

Run: `npx vitest run test/ui-extract.test.ts test/ui-export.test.ts test/ui-tools.test.js`
Expected: FAIL

- [ ] **Step 4: 实现**——按 Interfaces(types.ts 含注释随动 → ui-tokens.ts 导出 block → ui-extract.ts → ui-export.ts → index.ts → ui-tools.test.js)。
- [ ] **Step 5: 随动面 + 版本(单笔)**——计数(以 `npm run check:tool-count` 漂移清单为准)→ 规则双副本(工具表 +2 行 + extract_tree 小节[契约独立/override-only/只产草稿] + export_doc 小节[视图非真源/双截断])→ `npm version minor --no-git-tag-version`(0.38.0)→ version-sync → README 版本行 → CHANGELOG 定版段([Unreleased] 保留实质)。
- [ ] **Step 6: e2e(skipIf 无 GODOT_PATH)**——extract:fixture 场景(Panel A/B 同 bg + Panel C 异 bg + Label D font_size/color override + 无 override 的 Label E)→ report 数字精确、E 不在任何组;带 draft_path → .tres 文本含 `StyleBoxFlat`/`bg_color` 且 `ui_set_theme(load)` 挂载无错;空场景(全无 override)→ 空报告 + 无 persist。export:带 DesignTokens fixture → 全量表;裸 Theme → 空档不报错;>10 names 类型 → `(+N more)`;>20 类型构造 → `(+N types)`(Review Focus 5)。

Run: `npx vitest run test/ui-extract.test.ts test/ui-export.test.ts`
Expected: PASS(有 GODOT_PATH 时)

- [ ] **Step 7: 全门禁 + commit**

Run: `npx vitest run test/ui-extract.test.ts test/ui-export.test.ts test/ui-tools.test.js && npx tsc --noEmit && npm run lint && npm run build-matrix && npm run gen:tool-docs && npm run check:ssot-params && npm run check:budget && npm run check:tool-count && npm run build && STRICT=1 npm run check:rules-sync && npm run version-check && STRICT=1 npm run check:changelog-sync`
Expected: 全绿(计数 279,版本 0.38.0,schema < 13600)

```bash
git add src/tools/ui/ui-extract.ts src/tools/ui/ui-export.ts src/tools/ui/types.ts src/tools/ui/ui-tokens.ts src/tools/ui/index.ts test/ui-extract.test.ts test/ui-export.test.ts test/ui-tools.test.js README.md README.en.md manifest.json src/tools/rule-templates.ts .claude/rules/godot-mcp-core.md .claude/rules/godot-mcp-ui.md package.json package-lock.json addons/godot_mcp_server/plugin.cfg server.json Dockerfile docs/使用指南.md src/scripts/mcp_bridge.gd CHANGELOG.md docs/capability-matrix.json docs/capability-matrix.md docs/tools/
git commit -m "feat(ui): extract_tree 整树样式逆向+export_doc 只读导出+版本 0.38.0 收口(批4;计数 279)"
```

(A 类/add 清单以 version-sync 与 check:tool-count 实际改动为准,`git status` 收尾零遗漏。)

### Task 4: 靶子轻量验收(import 造 override 链)+ 审查文档 + memory 登记

**Files:**
- Create: `docs/superpowers/plans/2026-11-17-refero-batch4-acceptance.md` + `docs/superpowers/plans/refero-batch4-acceptance/` 快照
- Create: `scripts/refero-batch4-acceptance.mjs`(批3 骨架:双 gate/`_batch4_*` 前缀/动态 git 快照断言/finally 清理)
- Create: `docs/reviews/2026-11-17-refero-batch4.md`(批3 落档模式)

**Interfaces:**
- Consumes: Task 2/3 工具;靶子资源。靶子实况(v1 审查 I1 实测):`daily_login_content.tscn` **0 处 theme_override 且无 Panel 类型节点**(名为 Panel 的节点是 Control)——直接 extract 必空报告。
- Produces: 靶子真数字存档 + 批4 审查文档 + memory 登记。

- [ ] **Step 1: 靶子验收驱动**——① **override 副本链**:靶子副本场景 `_batch4_copy.tscn` ← 先复制 daily_login_content.tscn,再对小 geometry(bg/border/fontSize/color 各一)跑 `ui_import_prototype(parent_path=root, scene_path=_batch4_copy.tscn)`——import persist 会为副本写入 override 节点 → `extract_tree` 跑该副本 → report 真数字与 import geometry **自洽对账**(style 组数/font_size 组数可从输入 geometry 推出);② `export_doc` 跑 default_theme.tres 只读(无写盘)→ 文档真数字(DesignTokens 空档/379 type 摘要/类型 top 20 截断是否触发——v1 审查 I2 实测 1246 通道条目,预期触发)存档;③ compact:副本场景 `ui_measure_layout(theme_path=default_theme.tres, detail:'compact')` → quality/order 字段对象化+summary 数字;④ 快照×3 落盘、md 誊数字、git 快照断言。
- [ ] **Step 2: 审查文档**——批3 模式(docs/reviews/2026-11-17-refero-batch4.md):过程/发现与处置/ledger minor triage/实跑验证表/总评(Refero 四批收官、总验收链路就绪度——总验收本身是用户侧交互流程,不在批4 范围)。
- [ ] **Step 3: memory 登记(AGENTS:469)**——按 AGENTS「完成前必登 memory」把批4 关键教训登 memory;若 `mcp__memory__*` 工具在本会话不可用,以 Obsidian 日志 + 会话 memory 目录等价登记并在审查文档注明降级方式。
- [ ] **Step 4: 全量回归 + commit**

Run: `npm run build && npx vitest run && npm run lint`
Expected: 0 failed / 533 棘轮

```bash
git add docs/superpowers/plans/2026-11-17-refero-batch4-acceptance.md docs/superpowers/plans/refero-batch4-acceptance/ scripts/refero-batch4-acceptance.mjs docs/reviews/2026-11-17-refero-batch4.md
git commit -m "docs(ui): 批4 靶子验收记录+独立审查文档落档(Refero 收官)"
```
