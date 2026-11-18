# Refero 批4「periphery 层」独立审查报告

- **审查对象**:分支 `feature/refero-batch4-periphery`,自 master 分叉点(merge-base `15238dff`,批3 收尾)起 5 个 commit:`7b1ce508`(计划 v2 + 计划外部审查报告入库)→ `eee1b894`(T1 budget 校准)→ `cc8b45ca`(T2 verify 分档 compact)→ `46000677`(T3 extract_tree + export_doc + 版本 0.38.0)→ `1519426f`(T3 审查 fix round 1)。内容为 Refero 批4 periphery 层——`detail='compact'` 分档、`extract_tree` 整树样式逆向、`export_doc` 只读设计文档导出、budget 线校准、靶子验收。
- **审查者与文档定位**:本文档为**任务级审查与 fix round 全记录**(T1-T4 各任务独立实现者 + 独立任务审查的过程结论汇总,ledger 可读:`.superpowers/sdd/2026-11-17-refero-batch4-periphery/progress.md`)。**整支终审(opus,独立上下文)已完成**(2026-11-18)——终审结论 **Ready to merge: Yes**(3 Minor 均注释/文档级,附 fix wave 建议)已按终审报告补齐文末「整支终审」段(批3 的终审即由整支终审代理补写,本批同款流程)。
- **日期**:2026-11-17
- **总体判定(任务级)**:**4/4 任务 complete**——T1/T2 审查 clean、T3 审查 fix round 1 后 clean(5/5 addressed)、T4(本文档)靶子验收全绿。整支终审 **Ready to merge: Yes**(终审 3 Minor 由 fix wave 清偿,见文末终审段)。

## 过程

- 4 任务 SDD,每任务独立实现者 + 独立任务审查;1 轮 fix round(T3):
  1. 计划 v1 经外部 BLOCKING 审查(4B/6I/14N)修订为 v2(`docs/reviews/2026-11-17-refero-batch4-plan-review.md` 落档)——B1 预算数字(12656B/13504B)实测复核后入计划;
  2. T1 budget 校准 `eee1b894`(dispatch haiku);
  3. T2 verify 分档 `cc8b45ca`(dispatch sonnet);
  4. T3 periphery 双工具 + 版本收口 `46000677`,任务审查出 5 issues(HIGH-1/M3/M5/M6/LOW-2),fix round 1 `1519426f` 全 addressed,re-review 5/5 无新破坏(dispatch sonnet);
  5. T4 靶子验收 + 本文档 + memory 登记(本文档所在 commit)。
- 任务级审查各自实跑可跑验证(T1-T3 门禁数字见下表;T4 实测见「靶子验收」节)。

## 逐任务结论(任务级审查汇总)

### T1: budget 校准 — 通过(`eee1b894`,审查 clean)

- `13000→13600 / 14000→14400` 二录校准(ui schema 12941B < 13600 线,批3 T4 增量水位接受);budget 门禁 0 error。
- 顺手记录(ledger minor,注释级):①校准史 total 侧余量写 `~700B` 实为 596B(brief 原文误差)②「隔日二录」与同句「(同日)」矛盾——两条均注释级,终审 fix wave 顺手两行。

### T2: verify 分档 detail=compact — 通过(`cc8b45ca`,审查 clean)

- `detail` 参数(enum compact/extended,缺省 extended 逐字节不变)三处应用:measure 段1(diff/style 对象化+偏差量排序+截断)、段3(quality/order 列表字段对象化)、import 链同款——形态纪律:extended 路径值与原表达式逐字节一致。
- 扩展锚 157/157 + 330/330(extended 不变性);NaN 排序=显式 Infinity 映射 + path 次键短路,正反向锚定。
- ledger minor 3 条均 Nit 级:①styleSeverity 空数组理论 edge(实际不触发)②报告「逐字节锚」措辞强于断言实际(形态断言+83 存量背书)③报告 totalSum 换算笔误。

### T3: extract_tree + export_doc + 版本 0.38.0 — fix round 1 后通过(`46000677` + `1519426f`,re-review clean)

实现面(单笔 72 文件):`extract_tree` 整树 override 逆向(七槽 stylebox + font_size + font_color 三门控,顺序锚 indexOf 锁序)+ 聚类纯函数三组 + draft 选举(四类控件默认槽最高频,平票取首见)+ 可选草稿原子落盘;`export_doc` Theme 只读巡检 + DESIGN.md 视图(双截断:类型 top 20 / names 每通道 top 10 GD 侧截 + 表内前 5);随动面(计数 277→279 八处 / 规则双副本 / types.ts 注释 / 版本 0.38.0 六文件单笔收口);新增测试 43 条。

任务审查 5 issues 与 fix round 处置(`1519426f`,9 文件 +62/-12,4 新锚):

| Issue | 内容 | 处置 |
|---|---|---|
| **HIGH-1** | `export_doc` 通道 `more` 计数 `<10` 条时裸减产**负数**(GD `maxi` 缺下限钳制,真机实锤 `-4: a, b, c`),TS 侧 total 全错 | 源头钳制 `maxi(0, size-top)` + 三层测试锁(源码锚 + TS cell 断言 + e2e 真机 `<10` cell) |
| M3 | `draft_path` schema description 缺右括号(brief 原文笔误照抄) | 补齐 + 生成物同步 |
| M5 | `genDraftSaveScript` 草稿 JSON parse 失败静默降级空 dict → 落空 Theme 假报 `draft_saved 0/0/0` | fail-loud(error 输出 + return;实际不可达,防御取向) |
| M6 | 聚类/draft 选举平票无锚(依赖 sort/reduce 隐式稳定性) | 显式锚:组排序稳定 sort 首见在前、draft reduce 严格 `>` 取首见,单测锁定 |
| LOW-2 | `defects.ts` 基线 87→88 定性「前序遗留」错——实为本 commit 新文件(ui-extract.ts `_all_slots` GD 模板行)引入的登记制上调 | 报告/CHANGELOG 认知双处更正 |

顺手修裁决(T3 实现者,orchestrator 追认):①HEAD 红——T1 调线漏改 `test/scripts/check-token-budget.test.ts` 断言(批3 同款失败模式第二次,顺手修复)②`defects.ts` 基线 87→88(新文件入账)。M4(引擎约束节 4 行 vs「固定三条」):Ruling 接受——附加的默认字体行来自 inspect 数据,无害有用。

真机教训(记 CHANGELOG + 本批 memory 登记):GDScript `var x := theme.get_color_list(t)` 对 `load()` 返回 Variant 链路 `:=` 类型推断必炸(Cannot infer the type)——显式 `var x: Array` 标注修复;vitest esbuild 不查类型,tsc 门禁才抓到。

### T4: 靶子验收 + 审查文档 + memory 登记 — 通过(本文档所在 commit)

见下节。

## 靶子验收 — 通过(支撑 Refero 总验收「样式可逆向 + 文档可导出 + 报告可瘦身」链路)

实测记录全文见 `docs/superpowers/plans/2026-11-17-refero-batch4-acceptance.md`(快照×3 同目录 `refero-batch4-acceptance/`)。摘要:

| 步 | 面 | 关键数字(全断言通过) |
|---|---|---|
| ① | import 造 override 副本链 | 副本场景(靶子原场景 0 override)← geometry 3 节点(与 T3 e2e fixture 同构)→ import persist 落盘 → extract 逆向**对账 14 项全过**:节点并集恰 3(全部来自 import 注入)、stylebox_groups 恰 2(token `style_panel_4080bf`/`style_panel_8040bf` 从输入推出、bg 分量位级 `===`、radius 四角 8/全 0 逐角对)、font_size 组 1×(20)、font_color 组 1×(#ff8040)、draft 平票首见锚真机复现(styleboxes 1 / colors 2 / constants 1) |
| ② | export_doc 只读真主题 | document 41 行:DesignTokens 空档行 ✓;类型表体恰 20 行 + `(+359 types)` = 379 type(截断预期触发);引擎约束节 4 行;默认字体未设置(回落 ThemeDB fallback) |
| ③ | compact 分档真数字 | `detail='compact'` 挂出 ✓;quality `{entries,summary}` 对象化:bare_shells 3(Panel 11 子/MoneyLay 4 子/TopRigLay 18 子)/ should_follow 1 / out_of_bounds 0 / viewport_overflow 0;order:alignment_lanes 13 / equidistant 0;截断数学自洽;node_count 40(36 既有+4 注入,自洽) |
| ④ | 靶子只读纪律 | git 快照(验收前=干净)→ finally 清副本后**逐行一致** ✓;真 theme 两消费点只读零写入 |

验收工程质量:双 gate + 幂等预清理 + `fail()` 抛异常保 finally(批3 教训固化)+ 动态 git 快照断言,全链批3 同款纪律。

## 实跑验证表(T1-T3 任务审查时点 + T4 本次)

| 验证项 | T3 收口时点(`46000677`/`1519426f`) | T4 本次 |
|---|---|---|
| 全量 vitest | 7946 绿(72 文件批内 + 全量回归;并发跑 2 flaky:bridge B2 探窗/cli-init ENOTEMPTY,单跑稳定——零触碰面) | 复跑确认(见 T4 报告) |
| tsc --noEmit | 0 错(GD `:=` 坑即 tsc 抓出) | — |
| lint | 基线 533 零新增 | 同 |
| budget / tool-count | 0 error / 279 计数八处 | — |
| 版本链 | 0.38.0 六文件 + README + CHANGELOG(version-check/changelog-sync STRICT) | 不触碰(0.38.0 已收口,T4 无版本操作) |
| 真机 e2e | extract/export 7 条 + fix round 4 新锚全绿 | 靶子验收驱动全绿(上表) |

## ledger minor triage(5 条 deferred:全留档)

| 条目 | 判定 | 理由 |
|---|---|---|
| T1①:校准史 total 侧余量 `~700B` 实为 596B | 留档 | 注释级(brief 原文误差);终审 fix wave 顺手两行 |
| T1②:「隔日二录」与「(同日)」矛盾 | 留档 | 注释级,同上 |
| T2①:styleSeverity 空数组理论 edge | 留档 | 实际不触发(数据形态不可能空) |
| T2②:报告「逐字节锚」措辞强于断言实际 | 留档 | 报告措辞;断言为形态断言+83 存量背书,行为无虞 |
| T2③:报告 totalSum 换算笔误 | 留档 | 报告数字誊写笔误,非代码 |

无 Critical/Important 遗留(T3 的 HIGH-1 已在 fix round 清偿)。

## 值得进 memory 的工程教训(已按降级方式登记,见下节)

1. **budget 校准改阈值必须同步 `test/scripts/check-token-budget.test.ts` 断言**:批3(`d340d39d` 补丁)与批4(T3 顺手修 HEAD 红)**连续两次同款漏改**——第二次是批4 首任务调线,直到 T3 全量回归才抓出。改 `scripts/check-token-budget.mjs` 里的阈值时,同 commit 必须检查测试侧硬断言是否引用旧数字。
2. **GDScript `:=` 对 `load()` 返回 Variant 链路必炸**:`var x := load("...").get_color_list(t)` 类写法在 Godot 4.7 报 `Cannot infer the type`(parse 期);手写 GD 模板凡消费 `load()` 产物,一律显式类型标注(`var x: Array = ...`)。vitest(esbuild)不查 GD 类型,tsc 只能拦 TS 侧——GD 模板字符串内的类型坑只有真机 `--import`/e2e 能抓。

## memory 登记(降级方式)

AGENTS「完成前必登 memory」要求 MCP `mcp__memory__*` 工具,本会话不可用。等价登记(三通道):

1. **会话 memory 目录**(新建,本仓无既有 memory 目录):
   - `C:\Users\wgt\.claude\projects\D--GitHub-godot-mcp-series-godot-mcp-enhanced\memory\budget-calibration-test-sync.md`(教训 1,frontmatter name/description/metadata.type: reference,正文 Why/How to apply);
   - `C:\Users\wgt\.claude\projects\D--GitHub-godot-mcp-series-godot-mcp-enhanced\memory\gdscript-inferred-type-load-variant.md`(教训 2,同构);
   - `C:\Users\wgt\.claude\projects\D--GitHub-godot-mcp-series-godot-mcp-enhanced\memory\MEMORY.md`(索引,两条各一行——目录首建,索引随建)。
2. **本文档上一节**:两条教训全文落仓内审查文档(仓库可见面)。
3. **CHANGELOG**:教训 2 在 `46000677` 定版段已有记载(教训 1 的批4 侧修复亦有记载)。

memory 目录文件不在本仓,不随 commit(登记证据 = 文件路径 + 本节说明;无 MCP 工具可截图,以路径与内容为证)。

## 总评(Refero 四批收官)

批4 是 Refero(HTML 原型 → Godot 设计系统工具链)最后一批:批1 布局约束与锚点、批2 布局秩序(quality/order)、批3 tokens 层($token/token_set/token_list)、批4 periphery(逆向提取/文档导出/报告瘦身)。四批合计把「正向构建(原型→场景)」与「反向理解(场景→聚类报告→Theme 草稿→设计文档)」两侧工具链补齐,靶子验收四批全部落档(`docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md` 起 4 份 + 快照目录)。

**总验收链路就绪度**:Refero 总验收是用户侧交互流程(真实设计稿 → 原型 → import → token 化 → extract/export 审计的端到端人验),不在批4 范围。工具侧就绪度判断:四批靶子验收覆盖了总验收各环节的工具证据链(几何保真/布局秩序可检/token 可审计/样式可逆向/文档可导出),无已知阻塞项。版本 0.38.0 收口,门禁全绿。

## 整支终审

> 本段已按终审报告补齐(原占位声明作废)。整支终审由 orchestrator 派发的 opus 终审代理执行(独立上下文,2026-11-18,429 中断后恢复出报告;覆盖 `7b1ce508..a1f9d204` 全部实现 commit,含全量 vitest/tsc/lint/生成物漂移/真机 e2e 实跑);报告全文:`.superpowers/sdd/2026-11-17-refero-batch4-periphery/final-review.md`。批3 先例:`docs/reviews/2026-11-17-refero-batch3.md` 的终审段即同款流程产物。

- **审查对象**:`feature/refero-batch4-periphery`(`15238dff..a1f9d204`,6 commits,85 文件 +4035/−117)。
- **实跑验证矩阵**(终审独立实跑,非转述):tsc 0 错 / lint 533 基线零新增 / budget 0 error(ui schema 13242B<13600、total 14277B<14400)/ tool-count 279×27 处一致 / build+build-matrix+gen:tool-docs 重跑**生成物零漂移** / STRICT rules-sync、version-check(0.38.0)、changelog-sync、ssot-params 全绿 / **全量 vitest 7951 passed / 0 failed**(实现者预告的 flaky 未触发)/ **真机 e2e(Godot 4.7)ui-extract+ui-export 47/47 绿** / memory 登记两文件+索引核实齐全 / 靶子快照 JSON 数字复核一致。

### 终审判定:Ready to merge: **Yes**

(附 fix wave 建议:Minor 1-3 共 4 行注释/文档级修正,非阻断——可合并前顺手或紧跟合并一笔 docs/chore 补丁。)

### 发现清单

**Critical:无。Important:无。**

**Minor(3 条,均为注释/文档数字级)**:

1. **`src/tools/ui/ui-measure.ts:194` 内联注释漂移**(终审新发现,ledger 未记)——GD 模板内 `# 与 types.ts STYLEBOX_SLOTS 双份硬编码,扩槽须两处同步` 未随批4 随动:types.ts 与 ui-extract.ts 均已改「三份/三处」,此处仍写「双份/两处」。下一个扩槽人从 ui-measure 侧读注释只会同步两处,恰恰是 I5 同步点登记要防的事故形态。修复:一行注释对齐 types.ts 措辞。
2. **`docs/superpowers/plans/2026-11-17-refero-batch4-acceptance.md:84`(ledger T4①)**——「最大多数派 8 节点共享 **top 85.8px** 对齐线」kind/lane 错配。独立读快照 `measure-compact-report.json` 坐实:8 节点多数派共三条线(top **75.75** / bottom 95.75 / vc **85.75**),85.8 是 vc 线的四舍五入,top 线实为 75.75。快照 JSON 是对的,仅 md 誊写错。修复:一行。
3. **`scripts/check-token-budget.mjs` 校准史两处(ledger T1①②)**——①「校准后余量 ~640B/**~700B**」total 侧实为 596B(14400−13504−300);②同段「批3 首录后**隔日**二录」与前句「批3 首录(**同日**)」自相矛盾(批3/批4 校准同为 2026-11-17)。校准史是后续预算决策的推算基点,错误余量会传导。修复:两行。

**Nit(留档不修)**:

- 计划 P1-6 写「draft_path 过 sanitizeResPath **+ resolveWithinRoot**」,实现只过 sanitizeResPath(`src/tools/ui/index.ts` handleExtractTree)——但 sanitizeResPath(`src/tools/shared/value-serializer.ts:98-120`)强制 `res://` 前缀 + 迭代解码拒 `/../`/`\`,res:// 语义天然锚定项目根,且与批3 token_set 先例一致、e2e 验证落盘在项目内。安全语义达成,仅计划文字偏差。
- suggested_token 命名不含 alpha/corner 维度(plan-review N14 显式未采纳):同 rgb 不同 border 两组会同名建议 token——报告层是建议名、draft 选举按 type+slot 唯一,无实际冲突面。
- extract_tree `_count` 2000 上限静默截断(同 measure 先例);measure 链 compact 无作用面时不挂 detail 标记与 import 链(恒挂)不对称——行为自洽(无压缩无标记),测试已锚。

### ledger minor triage(终审版,7 条)

| 条目 | 判定 | 理由 |
|---|---|---|
| T1① 校准史 total 侧 `~700B` 实为 596B | **必修(fix wave 两行)** | 校准史是下次预算校准的余量推算基点,错误数字会传导;与②同段一笔修,成本两行 |
| T1② 「隔日二录」与「(同日)」同句矛盾 | **必修(与①同笔)** | 自相矛盾比单纯错误更误导;批3/批4 同为 2026-11-17 是可查事实 |
| T2① styleSeverity 空数组理论 edge | 留档 | StyleDiffEntry.delta 数组形态恒非空(颜色 diff 至少一分量),数据形态不可能触发;加防御=死代码 |
| T2② 报告「逐字节锚」措辞强于断言实际 | 留档 | 报告措辞非代码;实际保障=形态断言(裸数组/无 detail 字段)+83 存量测试背书+本次 7951 全量绿,行为无虞 |
| T2③ 报告 totalSum 换算笔误 | 留档 | 一次性报告誊写笔误,无后续消费面 |
| T4① 验收 md kind/lane 错配 | **必修(fix wave 一行)** | 验收记录是 Refero 收官的长期档案,「top 85.8px」这条线不存在;快照对、md 错,一行改正 |
| T4② cpSync 在 finally 保护外 | 留档 | cpSync 与外层 try 间零可抛语句;幂等预清理 + `clean` 子命令双兜底;重构收益低于扰动 |

### 总评(含 Refero 四批收官判断)

批4 是 Refero 系列质量面最干净的一批:T3 审查抓出的 HIGH-1(export_doc 通道 more 负数——GD 裸减无下限钳制,真机实锤)在 fix round 1 以「源头钳制 + 三层测试锁」清偿,顺手修的 T1 遗留预算断言红(批3 同款失败模式第二次)催生的 memory 教训已三通道登记且核实到位。跨批一致性三项全过:**D8 语义**——compactReportSections 完全镜像 extended 的挂节条件(quality 节存在才对象化、spacing_scale/visual_groups 条件展开、空清单照挂),压缩不破坏输出纪律;**STYLEBOX_SLOTS 第三消费点**——types.ts 权威注释/ui-extract 副本/defects 基线 88 三面齐,唯 ui-measure.ts:194 内联注释漏网(Minor 1);**export_doc 与 token_list 双通道 GD 读法**——DesignTokens colors/constants 两段逐字同款零漂移,themeFileNotFoundBlock 导出复用成单一真源。回归面坐实:extended 路径三处应用点均为 `detailCompact ? compact : 原引用` 形态,7951 全量绿 + 真机 47/47 提供实证。

**四批收官判断:闭环成立**。spec 总目标的四批映射(批1 布局约束保真→批2 布局秩序 verify→批3 tokens 单源→批4 周边工具)全部落地且各有靶子验收落档,正向构建(原型→场景)与反向理解(场景→override 聚类→Theme 草稿→DESIGN.md)双侧工具链齐备,计数 274→279、版本 0.36.9→0.38.0、规则双副本/生成物/预算线全随动,批4 靶子验收的 14 项对账(含平票锚真机复现、379 type 截断触发、compact 真数字)把工具证据链钉死在真项目上。**总验收就绪度声明是诚实的**:审查文档总评段明确「总验收是用户侧交互流程(复刻新 UI 场景的人验),不在批4 范围」,只声明「工具侧就绪、无已知阻塞项」——与事实相符,未把工具验收偷换为总验收通过。

**结论:Ready to merge: Yes**。终审建议合并动作:先落 fix wave 小补丁(Minor 1-3 共 4 行:ui-measure 注释一行 + 验收 md 数字一行 + budget 校准史两行),再把终审结论补进本文档占位段。

> **fix wave 处置记录**:终审建议的两步已随 fix wave 一次落地——Minor 1-3 共 4 行修正与本文档终审段补齐同笔 commit(即本 commit);Nit 3 条按终审裁决留档不修。
