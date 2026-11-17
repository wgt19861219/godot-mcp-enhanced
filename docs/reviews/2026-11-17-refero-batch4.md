# Refero 批4「periphery 层」独立审查报告

- **审查对象**:分支 `feature/refero-batch4-periphery`,自 master 分叉点(merge-base `15238dff`,批3 收尾)起 5 个 commit:`7b1ce508`(计划 v2 + 计划外部审查报告入库)→ `eee1b894`(T1 budget 校准)→ `cc8b45ca`(T2 verify 分档 compact)→ `46000677`(T3 extract_tree + export_doc + 版本 0.38.0)→ `1519426f`(T3 审查 fix round 1)。内容为 Refero 批4 periphery 层——`detail='compact'` 分档、`extract_tree` 整树样式逆向、`export_doc` 只读设计文档导出、budget 线校准、靶子验收。
- **审查者与文档定位**:本文档为**任务级审查与 fix round 全记录**(T1-T4 各任务独立实现者 + 独立任务审查的过程结论汇总,ledger 可读:`.superpowers/sdd/2026-11-17-refero-batch4-periphery/progress.md`)。**整支终审(opus,独立上下文)在全部任务完成后由 orchestrator 派发,尚未发生**——终审段见文末占位「(终审待补)」,orchestrator 终审后补齐(该占位是流程设计,不是遗漏;批3 的终审即由整支终审代理补写)。
- **日期**:2026-11-17
- **总体判定(任务级)**:**4/4 任务 complete**——T1/T2 审查 clean、T3 审查 fix round 1 后 clean(5/5 addressed)、T4(本文档)靶子验收全绿。整支 SHIPPED 判定待终审。

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

## 整支终审(终审待补)

> 占位:整支终审(opus,独立上下文,覆盖 `7b1ce508..` 全部实现 commit,含全量 vitest/tsc/lint/生成物漂移/真机 e2e 实跑)由 orchestrator 在全部任务完成后派发——终审结论、发现与处置、SHIPPED 判定由终审代理补写本节。批3 先例:`docs/reviews/2026-11-17-refero-batch3.md` 的终审段即该流程产物。
