# Refero 批4 计划审查报告(独立审查)

- **审查对象**:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\plans\2026-11-17-refero-batch4-periphery.md`
- **上游 spec**:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-16-refero-design-system-design.md`(批4 节 :147-151、约束节 :155-160、留给实现者的 :184-188)
- **审查者**:独立审查(静态核对:read/grep 通读计划、spec、被引源码、门禁脚本、CI、测试、committed 产物、批1/2/3 档案、靶子真实文件)
- **日期**:2026-11-17
- **总体判定**:**不通过(需修订后开工)**——三工具的契约切分(N6 独立 / N8 只读视图 / compact 纯后处理)与 spec 一致,方向成立;但落地侧 4 条链路会在已声明的门禁上硬红或与 AGENTS 硬规冲突,另有 6 项设计粒度不足会让 SDD 子 agent 各自发明契约。
- **处置建议**:修订为 v2 后再开工(修订清单见文末)。审查过程未改动计划文件。

## 审查环境与诚实边界

- 本机 Windows 沙箱 ACL 故障(`sandbox-local: windows-acl workspace grant failed … Win32 5`),**`pwsh` 全部不可用**,故未能实跑 `npm run build-matrix` / `check:budget` / `check:tool-count` / `check:rules-sync` / `check:changelog-sync`。
- 支撑结论的数字全部来自 **committed 产物**与**逐行读码**:`docs/capability-matrix.json`(committed 0.37.0 快照)、`scripts/*.mjs` 阈值常量、`README.md`/`manifest.json` 手写计数、靶子真实文件。凡属估算的地方均标注"复算/估算",并给出可实跑的确认命令。
- 靶子文件可读(workspace 外读取未受限),已实测 read/grep,证据见 I1。

## 一、核对通过的声明(抽样)

| 编号 | 计划声明 | 结论 |
|---|---|---|
| P1 | `detail` 默认 `extended`、compact 纯后处理、新参数可选、不动既有字段形态 | 与 spec:149/:155 一致;唯一风险点是 compact 自身形态(B2) |
| P2 | 277 = action 总数(非工具数),46 = 顶层工具数 | 准确(`README.md:7`、`README.md:240`、`manifest.json:6-7`、`src/tools/rule-templates.ts:24`、`.claude/rules/godot-mcp-core.md:10` 全为 46/277) |
| P3 | 版本 0.37.0 → 0.38.0(minor),A 类 6 文件 | 准确(`package.json:3` = 0.37.0;`scripts/version-sync.mjs:20-33` WRITE_TARGETS 恰 6 项) |
| P4 | 生成物纪律:先 `build-matrix` 再 `check:ssot-params` / `check:budget`;H-5 `git diff --exit-code` | 正确且必要(`.github/workflows/ci.yml:36-49`) |
| P5 | `actionRisks` 需随新 action 登记(编译期穷尽) | 准确:`src/tools/ui/index.ts:1179-1191` 用 `satisfies Record<typeof ACTIONS[number], RiskLevel>` |
| P6 | Review Focus 3:measure 的 styles 读回含期望侧 fallback,不可直接复用并集逻辑 | 准确:`src/tools/ui/ui-measure.ts:273-296` 的 `_slots` = 期望清单 ∪ `has_theme_stylebox_override`,确实不能当 override-only 清单用 |
| P7 | `extract_tree` 草稿复用 token_set 原子落盘(tmp+rename) | 先例存在:`src/tools/ui/ui-tokens.ts:73-100` |
| P8 | `export_doc` 缺失分流走 mapper 前置分支 → THEME_NOT_FOUND | 准确:`src/tools/ui/index.ts:832-836` 已有 `theme file not found` 前置分支 |
| P9 | 引擎约束三条(ProgressBar 27px / Label 默认 TOP / transparent 壳须 self_modulate)有据可引 | 有据:`src/tools/ui/prototype-import.ts:368` 的 `PROGRESS_BAR_MIN_HEIGHT` 常量、`src/tools/rule-templates.ts:1125-1126` 两条引擎陷阱 |
| P10 | spec:187 把 compact 的 N 与排序键留给实现者 → N=20 + max(|Δ|) | 合规(spec 未约束具体值) |
| P11 | 靶子脚本骨架(双 gate / `_batch3_*` 副本 / porcelain 快照 / finally 清理)可复用 | 存在且可复用:`scripts/refero-batch3-acceptance.mjs:46,50,56-57` |
| P12 | 新增 action 不需要改 module-loader / SLIM_CONFIG / ssot 白名单 | 正确:`src/module-loader.ts:231` 的 `SLIM_CONFIG` 为空配置;`detail`/`draft_path` 均进 schema,不触发 `check:ssot-params` |

## 二、改动面清单完整性独立核查(AGENTS:319 要求)

| 仓库级约束 | 涉及文件 | 计划是否覆盖 | 结论 |
|---|---|---|---|
| 独立副本同步(AGENTS:398-405)+ 模板变更强制 bump(AGENTS:289,311) | `src/tools/rule-templates.ts`、`.claude/rules/godot-mcp-ui.md`、`godot-mcp-core.md` | 覆盖,但 bump 时序错 | **B4** |
| 生成物 / H-5 门禁 | `docs/capability-matrix.{json,md}`、`docs/tools/` | 覆盖 | ✓ |
| 计数门禁 `check-tool-count` | 实际 **8** 个文件(`scripts/check-tool-count.mjs:48-126`),其中仅 **5** 个承载 action 数 | 覆盖但清单失准 | Nit N3 |
| token 预算门禁 | `scripts/check-token-budget.mjs:14-22` + `test/scripts/check-token-budget.test.ts:26,43-45` | **未覆盖** | **B1** |
| rules-sync 读 build 产物 | `npm run build` 前置 | 覆盖(计划 :19,Task 2/3 门禁串) | ✓ |
| 版本 A 类 6 文件 + `package-lock.json` | `scripts/version-sync.mjs:20-33` | 覆盖,但 git add 路径有笔误 | Nit N1/N2 |
| 新 e2e 文件的 CI L2 白名单(`check-e2e-l2-coverage`) | `.github/workflows/ci.yml` L2 run 行 | 无需改(本批 e2e 用 `GODOT_PATH` + `describe.skipIf`,不引用 `GODOT_MCP_E2E_L2`,同 `test/ui-token-e2e.test.ts:16-27` 先例) | ✓ 但带来 N12 的"绿≠覆盖" |
| 测试质量门禁(Mock drift / 弱断言上限 860) | `scripts/check-test-quality.mjs:204-210`,`ci.yml:92-93` 阻断 | **未覆盖** | Nit N13 |
| AGENTS 强制 memory 登记 | `AGENTS.md:469` | **未覆盖** | **I6** |
| `themeFileNotFoundBlock` 复用者 | `src/tools/ui/ui-tokens.ts:48-53`(模块私有) | **未覆盖** | **I3** |
| GD/TS 清单同步点登记 | `src/tools/ui/types.ts:76-82`(DESIGN_TOKENS_TYPE 消费点)、`:111-120`(`_all_slots` 双份硬编码) | **未覆盖** | **I5** |

## 三、Blocking(4 项)

### B1. `check:budget` 自 Task 2 起必红——计划"仍 < 13000"没有余量依据

- **现状(committed matrix 实测)**:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\capability-matrix.json:6852-6856` —— ui 的 `descBytes 848 / schemaBytes 12656 / totalBytes 13504`,是全库唯一逼近 error 线的工具。
- **阈值**:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\check-token-budget.mjs:21-22` —— `perToolSchema.error = 13000`(**余量 344B**)、`perToolTotal.error = 14000`(**余量 496B**);该文件 :16-20 已记录批3 首任务"ui schema 11992B 余 8B → 判定校准不瘦身"的完整先例。
- **增量下限(UTF-8 手工复算)**:
  - Task 1 `detail` 属性(描述取计划 :51 原文,约 20 汉字 + 100 ASCII)≈ **230–250B**;
  - Task 2 `extract_tree` 枚举项 ≈ 16B + `draft_path` 属性(最小 `type`+一行中文描述)≈ 90–140B + `action` 描述追加 ≈ 60–100B → **≥ 170B**;
  - Task 3 `export_doc` 同类 **≥ 100B**。
  - 合计 **≥ 500–600B** → schema 在 Task 2 就越 13000,total 到 Task 3 越 14000。即便 Task 1 单项(≈240B)也只剩 ~100B 余量,描述多一句即红。
- **影响**:`ci.yml:44-49` 在 H-5 步 `build-matrix` 重生成后跑 `check-token-budget`,error 阻塞 → Task 2/3 的 commit 落红,直接违反计划 :17"每个任务 commit 自身全绿"。
- **建议**:新增 Task 0(或并入 Task 1)「门禁基线清偿」,内容与批3 Task 1(`docs/superpowers/plans/2026-11-17-refero-batch3-tokens.md:39-43`)同款:改 `scripts/check-token-budget.mjs` 的 `perToolSchema.error` / `perToolTotal.error`(附校准注释,沿 :16-20 风格)+ 同步 `test/scripts/check-token-budget.test.ts:26`(以当前 error 线当"必 error"样例)与 :43/:45 常量断言;新线以 `npm run build-matrix` 实测值定,留 ≥8% 余量。备选"压缩描述"路线不建议(批 A 已压过一轮,再压伤可用性,见该文件 :40-45)。

### B2. compact 的响应形态没有定义到可实现粒度:数组挂不上 `summary`,quality/order 截断无类型

- 计划 :50 写"diff 系三节经上述函数替换并各挂 `summary` 字段"。但三节形态不同:
  - `layout_verify` 是对象(可挂 `summary`):`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\tools\ui\index.ts:608-615`;
  - `style_verify` 是**顶层裸数组**(同文件 :616)、import 链的 `flow_verify` 也是**顶层裸数组**(:1115-1116)——JSON 数组挂不上 `summary`,必须改形(并列 `*_summary` 键,或 `{entries, summary}` 包裹),计划未定。
- **quality/order 更未定义**:`QualitySection` 是 4 个数组(`src/tools/ui/quality-check.ts:360-365`),`OrderSection` 是 3 个数组 + 可选对象 `spacing_scale` + 可选**嵌套数组** `visual_groups[].groups[]`(:371-376)。计划 :50 只说"各数组字段截 top-20(报告序不动,附每字段 `{total, truncated}` 计数)",既没说计数挂在哪一层,也没说嵌套数组(`alignment_lanes`/`visual_groups`)如何处理。
- **测试面缺口**:计划 :53(Step 1)只覆盖 `compactDiffEntries` / `compactStyleEntries` 两个纯函数,:54 只断言 `layout_verify.diff` 一条路径;quality/order 压缩与 style/flow 的 summary 位置**没有任何先行失败测试**,而 Task 4 :174③ 又要拿 quality/order 的 compact 数字做靶子存档——口径不定则 Task 1 与 Task 4 返工。
- **省流目标也未量化**:compact 不触碰响应最大字段 `measure.nodes` 与 `layout_verify.targets`(targets 是输入树回显,:608)。Goal 写"compact 省流",但没有可验证量级,验收无从判定。
- **建议**:在 Task 1 Interfaces 补三件事:①summary 承载键的精确命名(`layout_verify.summary` / `style_verify_summary` / `flow_verify_summary` / `quality_summary` / `order_summary`);②quality/order 的 compact 形态(建议"数组保留 + 每字段计数进并列 summary 对象",避免把数组包成对象后消费方全改);③明确 compact 是否压 `targets`/`nodes`(建议 targets 保留,规则文档写清"compact 只压 diff 系与 quality/order"),并给一个"典型 measure 响应字节下降 ≥X%"的可验证目标。同时把 quality/order 压缩加进 Step 1 纯函数单测。

### B3. Task 2 Step 1 的生成期断言与 Godot 唯一读法矛盾(测试按字面写不出来)

- 计划 :90 同时要求产物"**不含 `get_theme_stylebox(`**"与"读值行必须在 has 门控行之后"——两句互斥。
- 事实:Godot 只有 `has_theme_stylebox_override(name)`(判定)与 `get_theme_stylebox(name)`(读值,**有 override 时返回 override**),**没有"只读 override"的 getter**;measure 的既有正确形态就是"门控 → 读值":`src/tools/ui/ui-measure.ts:277-283`。另一条 `node.get("theme_override_styles/"+slot)` 被规则文档明确标为危险写法:`src/tools/rule-templates.ts:752`("`node.set()` 该路径 pack 落盘会丢 override,勿手写")。
- **影响**:按字面实现只能走脆弱路径;按正常实现则该断言必红 → Step 1 的"失败单测"会变成"写不出来的单测"。
- **建议**:改为**顺序锚**断言:`script.indexOf('has_theme_stylebox_override') < script.indexOf('get_theme_stylebox(')`,并追加"`get_theme_stylebox` 调用行前面 3 行内含 `has_theme_stylebox_override`"的门控邻接断言;font_size/font_color 两条同款。

### B4. 版本 bump 时序与 AGENTS 硬门禁 / 批3 先例冲突(计划"每任务全绿"不成立)

- **必然性**:计划 :17 要求 Task 2 同步计数 277→278,而 `src/tools/rule-templates.ts:24` 就是"46 个 MCP 工具（277 个 action"——Task 2 **必然**改模板源;同一 Task(:101)还跑 `STRICT=1 npm run check:rules-sync`,强制 `.claude/rules/*` 双副本同改。两条路都绕不开模板变更。
- **硬规**:`AGENTS.md:311`(改了 `rule-templates.ts` 后须 bump)、`AGENTS.md:289`(N-C 例外:规则模板门禁触发的 bump 照常走四件套);脚本 `scripts/check-rules-version-bump.mjs:16-19`(TEMPLATE_FILES 含 `rule-templates.ts`)+ :78-90(要求同 commit 的 package.json version diff)。批3 先例明确"改 rule-templates.ts 的任务同批 bump"(`2026-11-17-refero-batch3-tokens.md:18`),而批4 把 bump 推到 Task 3(:18、:137)。
- **诚实边界**:该脚本比对 HEAD vs 工作区,CI checkout 后恒无 diff → **CI 不会红**(批3 计划审查 Nit 9 已记录同一机制);红的是**本地提交前门禁**与 AGENTS 硬规,且计划自己声明的"每任务全绿"不成立。
- **建议(二选一,推荐 A)**:
  - **A. bump 前移**:把版本四件套(`npm version minor --no-git-tag-version` 0.37.0→0.38.0 + `version-sync` + README 版本行 + CHANGELOG 定版段)整体放进 **Task 2**;Task 3 只把 export_doc 条目并入已定的 `[0.38.0]` 段,**不二次 bump**,并保留 `version-check` / `check:changelog-sync` 作为校验。
  - B. 改 Task 拆分:把"规则双副本 + 全部计数同步 + 版本四件套"合并为一个独立 Task,排在两个工具 Task 之后、验收之前。

## 四、Important(6 项)

| # | 发现 | 证据 | 建议处置 |
|---|---|---|---|
| I1 | **Task 4 的 extract_tree 靶子验收是空验证**:靶子场景 0 处 theme override,report 必为空;且该场景无 `Panel` 类型节点(名为 Panel 的节点 `type="Control"`),`styleboxSlotFor` 只映射 Panel/ProgressBar/Button/Label,草稿也必为空 | 实测 `D:\workspace\projects\DotaLegendGodot\scenes\ui\daily_login_content.tscn`:46 处匹配全为 `[node]`/`[ext_resource]`,**无一条 `theme_override`**;`src/tools/ui/prototype-import.ts:386-394` 槽位映射仅 4 类 | Task 4①改为两段:先在 `_batch4_copy.tscn` 上跑 `ui_import_prototype` 造出带 bg/borderRadius 的 override(批3 在同一副本上做过 import),**再** `extract_tree` 读它——这样才有真组数/草稿数字;并保留"裸场景 → 空报告"作为 override-only 的反向锚 |
| I2 | **export_doc 文档没有总量/类型数上限**:只截"每类型每通道 names top-10",类型数不设上限;靶子 theme 实测 1246 条通道条目(379 type 量级)→ 文档/响应可达 ~100KB 级,一次性灌进 agent 上下文 | `D:\workspace\projects\DotaLegendGodot\resources\themes\default_theme.tres`(2487 行,grep `^[A-Za-z0-9_]+/(colors\|constants\|fonts\|font_sizes\|styles)/` 命中 1246 条,0 条 `DesignTokens/`);计划 :135 只做 names 截断;spec:151 只要求"人读文档" | 加类型行数护栏(如按条目数 top-30 类型 + `(+N more types)`),或加可选 `max_types`;Task 4②把实测文档字节数/行数登记为验收数字(沿批3 budget 记账风格) |
| I3 | **Task 3 Files 漏 `src/tools/ui/ui-tokens.ts`**:计划要复用 `themeFileNotFoundBlock`,该函数是模块私有 | `src/tools/ui/ui-tokens.ts:48-53`(无 `export`);计划 :134 写"复用 … 文案" | 要么把它 `export`(Files + git add 补 `ui-tokens.ts`),要么在 `ui-export.ts` 复制文案并在注释里写明"与 ui-tokens 双份,改动须同步" |
| I4 | **空草稿 / 不可映射类型的行为未定义**:给 `draft_path` 但聚类结果为空时,是落一个空 Theme、还是不 spawn2、`persist` 长什么样,计划没说;仅 4 类控件能进草稿,其余类型的 override 只进报告,报告也无字段标注"未能进草稿" | 计划 :88(`persist?: { saved, path }`)、:91"空 scan → 空报告空草稿不报错";`prototype-import.ts:386-394` | 明确:空草稿 → 不 spawn2,`persist: { saved:false, reason:'empty draft' }`;报告增加 `draft_skipped_types`(或每组 `in_draft:false`);补对应单测 |
| I5 | **同步点登记缺失**:`_all_slots` 从"双份硬编码"变三份;`DESIGN_TOKENS_TYPE` 新增两个消费点 | `src/tools/ui/types.ts:111-120`(注释声明双份:TS + `ui-measure.ts:194`)、`:76-82`(DESIGN_TOKENS_TYPE 同步点清单);spec:157 要求"两侧清单同步须登记" | Task 2/3 同 commit 更新 `types.ts` 两处注释:`_all_slots` 第三副本在 `ui-extract.ts`;`DESIGN_TOKENS_TYPE` 消费点补 `ui-extract`(草稿写 set_color/set_constant)与 `ui-export`(读) |
| I6 | **缺 AGENTS 强制 memory 登记步骤**(硬规:不登视为未完成) | `AGENTS.md:469-479`;批3 计划同样缺(历史债) | Task 4 增加一步:登记 `feature-decision-log`(批4 三工具 + 决策:compact 形态/N=20 排序键/override-only/extract_tree 与 theme_create(extract) 契约分界/draft 只覆盖 4 类型)+ 本次教训 |

## 五、Nit(14 项)

1. **`--no-git-token-version` 拼写错**(计划 :137):应为 `--no-git-tag-version`,否则 `npm version` 会走默认 commit+tag 流程。
2. **git add 路径错**(计划 :157):`plugin.cfg` 实际在 `addons/godot_mcp_server/plugin.cfg`(`scripts/version-sync.mjs:23`);该行 `git add plugin.cfg` 会直接报错(末尾"以 version-sync 实际改动为准"可救,但仍应写对)。
3. **"计数 9 文件"是沿袭批3 的误计**:`check-tool-count.mjs:48-126` 实为 **8** 个 `file:`;且本批只加 action,tool 数 46 不变 → **只有 5 个文件真正需要改**(`README.md`、`README.en.md`、`manifest.json`、`src/tools/rule-templates.ts`、`.claude/rules/godot-mcp-core.md`);`server.json`、`docs/distribution/README.md`、`docs/migration-from-coding-solo.md` 只承载工具数 46,改它们是无操作。另 `README.md:240` 的 read/write 分解(133/118/10/16)需手工 133→134(write 118→119)且**不被任何正则守护**。
4. **测试标题会失真**:`test/ui-tools.test.js:22`("exactly 16 entries")、`:632`("all 16 ACTIONS")是字符串标题,改动只在断言 :25/:635 → 建议标题一并改,否则后续 grep 误导。
5. **Task 1 的"顺手简化 intraGap"超出范围**(计划 :41/:60):已核实 `c.gaps.length > 0` 分支确不可达(`src/tools/ui/quality-check.ts:332-349`:簇 members≥2 ⟺ 至少 push 过一次 gap),删之无行为变化——但它与本批目标无关,建议删掉或拆独立 `chore(ui)` commit(AGENTS「精确编辑」)。
6. **schema 描述与行为不符**(计划 :51):`detail` 描述写成 "ui_measure_layout(带 expect_tree)/ui_import_prototype",但 quality/order 在**不带 expect_tree** 的成功响应里也会出(`src/tools/ui/index.ts:646-668`),Task 4(:174③)正是这么用的 → 描述应写成两个通道。
7. **"复用既有 mock 两段式"措辞与实况不符**(计划 :54):`test/ui-import-prototype.test.ts:76` 是**单 spawn 合批**(`buildOutputs()+measureOutputs()` 同批 outputs);只有 $token 预取场景才两次 `mockResolvedValueOnce`(:614-615)。建议改成"单 spawn 合批 mock"。
8. **路径逃逸用例的拒因写偏**(计划 :92):`draft_path='../evil.tres'` 被拒的真实原因是"不以 `res://` 开头"(`src/tools/shared/value-serializer.ts:99-101`),不是 traversal 分支(:116)。建议补 `res://../evil.tres` 命中 traversal 分支,两条用例分开断言。
9. **changelog STRICT 的标识符陷阱**:Task 1 提交标题含 `top-20`,会命中 `scripts/check-changelog-sync.mjs:110` 的标识符正则(`[A-Za-z]{2,}-[A-Za-z]*\d+`),被当"标识符"要求**逐字出现**在 CHANGELOG;若 CHANGELOG 写成"top 20"即 Task 3 STRICT 红。建议 commit subject 与 CHANGELOG 措辞逐字一致。
10. **compact summary 缺 missing 计数**:`{total, ok, non_ok, truncated}`(`:47`)把"偏差大"与"没读到(NaN)"混在 `non_ok` 里;而 Review Focus 2 恰恰强调 NaN 语义。建议 `non_ok` 旁加 `missing`(或 `nan`)计数,Task 4 的靶子数字也更可读。
11. **`genExtractTreeScript` 未声明 maxDepth 的 clamp/NaN 回落**:measure 同款生成器做了 `Math.max(1, Math.min(64, …))` 且 NaN→16(`src/tools/ui/ui-measure.ts:142`);extract 的 Interfaces(:84)只写 `maxDepth: number`,建议同款防御 + 单测(非有限值/超限)。
12. **Task 4 缺 `npm run build`**:验收脚本必然 `import … from '../build/tools/ui/index.js'`(批3 先例 `scripts/refero-batch3-acceptance.mjs:46`);而 Task 4 只跑 `npx vitest run && npm run lint`,**`npx` 不触发 `pretest` 的 build** → 可能拿旧产物跑验收。请补 `npm run build` 前置,并在脚本里断言 build 产物 mtime 晚于 src 或版本号匹配。
13. **缺 `npm run check:test-quality`**:`ci.yml:92-93` 阻断式,弱断言上限 860(`scripts/check-test-quality.mjs:204-210`);本批新建两个测试文件,数量增量小但应进门禁串(Task 2/3)。
14. **suggested_token 命名不唯一**:`style_<slot>_<rrggbb>` 丢掉了 alpha 与 corner/border 维度(`:86`),同 rgb 不同 alpha/border 的两个 spec 组会得到同名 token;报告层建议去重后缀(`_a80` 或 `_2`),或命名改为 spec 指纹短哈希。

## 六、结论与修订清单

**分层判断成立**:①compact 作为纯后处理不触 GD 链路,是风险最低的省流做法;②extract_tree 两段式(spawn1 扫描 → TS 纯函数聚类 → 可选 spawn2 原子落盘)与批3 token_set 先例同构;③export_doc 只读不落盘、文档是视图(N8)的契约守得住;④override-only 的语义判断与 measure 并集读法的差异认定准确。缺陷集中在**门禁时序、形态定义、验收有效性**三处。

**v2 修订清单(按优先级)**:

1. 新增 Task 0「门禁基线清偿」:budget 阈值校准 + `test/scripts/check-token-budget.test.ts` 断言随动(B1)。
2. bump 四件套前移到 Task 2(A 方案),Task 3 只并入 changelog 条目不二次 bump(B4)。
3. Task 1 Interfaces 定死 compact 的 summary 承载键、quality/order 压缩形态、targets/nodes 是否压缩,并补 quality/order 纯函数单测(B2)。
4. Task 2 Step 1 的生成期断言改"顺序锚 + 门控邻接",删掉"不含 `get_theme_stylebox(`"(B3)。
5. Task 3 Files 补 `src/tools/ui/ui-tokens.ts`(导出 `themeFileNotFoundBlock`)或声明双份文案(I3)。
6. Task 2 补空草稿/不可映射类型的明确行为与报告字段(I4);同步 `types.ts` 两处同步点注释(I5)。
7. Task 4 改为"先 import_prototype 造 override 副本 → 再 extract_tree"的两段验收,并补 `npm run build`、`check:test-quality`、memory 登记、`npx vitest run` 的 skip 数声明(I1/I6/N12/N13)。
8. export_doc 加类型行数护栏(I2);其余 14 条 Nit 逐条吸收或显式驳回。

**判定**:不通过,修订后按 Subagent-driven 开工。

---

### 附:本报告可复核命令

| 结论 | 复核方式 |
|---|---|
| ui 预算现状 12656/13504(余 344B/496B) | `node -e "const m=require('./docs/capability-matrix.json');console.log(m.tools.find(t=>t.name==='ui').size)"` |
| 预算门禁是否红 | `npm run build-matrix && npm run check:budget`(改 schema 后) |
| 计数面到底几文件 / 哪几个承载 action 数 | `node scripts/check-tool-count.mjs`;`grep -n "file: '" scripts/check-tool-count.mjs` |
| 靶子场景无 override / theme 无 DesignTokens | `grep -c theme_override D:\workspace\projects\DotaLegendGodot\scenes\ui\daily_login_content.tscn`(0);`grep -c '^DesignTokens/' …\default_theme.tres`(0) |
| 规则模板变更必 bump | `node scripts/check-rules-version-bump.mjs`(改动 `rule-templates.ts` 后本地跑) |
