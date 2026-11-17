# Refero 批3 计划(v1)外部审查报告 + 处置记录

- **审查对象**:`docs/superpowers/plans/2026-11-17-refero-batch3-tokens.md`(v1,2026-11-17)
- **审查者**:外部独立审查(用户转贴;静态核对,read/grep/glob 通读被引源码、脚本、CI、测试与批2 档案;审查环境 ACL 受限未能实跑 npm 脚本,数字类声明以 committed 产物 + 手工复算验证)
- **复核方**:orchestrator(Claude)——对全部 Blocking 声明逐条实跑/读码复核后落档(见各条「复核」)
- **日期**:2026-11-17
- **总体判定**:**不通过(需修订后开工)**——设计方向成立,落地侧四条链路(错误映射 × 生成物 × 计数 × 版本链)按 v1 执行会让 Task 2/3/4 commit 落在红 CI 上
- **处置**:计划已修订为 v2,全部 Blocking/Important/Nit 清偿(映射见文末);用户确认后开工

## 复核方式声明

orchestrator 复核可实跑(审查者环境不可):`node scripts/check-token-budget.mjs`、`node scripts/gen-tool-docs.mjs`、`npm run build-matrix` 均已实跑(验证后 `git checkout --` 还原工作区)。matrix 总量逐项求和 = 114376B 与计划一致。

## ✅ 核对通过的声明(抽样)

| 声明 | 结论 |
|---|---|
| ProtoColor 在 prototype-import.ts:91;buildSpec 四处颜色调用点(:372/:379/:387/:419) | 准确 |
| ui-theme.ts 原子落盘段 :49-74;ui-measure.ts themeConstEmit 两处 "DesignTokens" 字面量 | 准确 |
| actionRisks `satisfies` 编译期穷尽(index.ts:1018-1025) | 准确 |
| ui schema 11992B / error 线 12000B 余 8B;全库 114376B / warn 余 312B / 113*1024=115712 | 全部准确(capability-matrix.json 复算) |
| error 线 12000 从未校准过(check-token-budget.mjs:16 无校准注释) | 准确 |
| 先 build-matrix 再 check:ssot-params/check:budget(两者读 committed matrix) | 正确且必要 |
| D7 竞态裁定(预取直接 load 资源,不受挂载竞态)——批2 遗留观察佐证 | 正确 |
| 靶子 theme 无 DesignTokens → 空档预期(批2 验收 :13/:95 实读) | 成立 |
| translateGeometry 新增可选第二参不破坏既有调用(13 处全单参) | 成立 |

## 🔴 Blocking(6 项)

### B1. TOKEN_NOT_FOUND / THEME_NOT_FOUND 实际拿不到——两处错误映射漏改

- parseGeometry 与 translateGeometry 在同一 try(index.ts:844-851),catch 统一 INVALID_PARAMS——TOKEN_NOT_FOUND 会被重写;
- uiErrorMapper 首位 `includes('not found') → NODE_NOT_FOUND`(index.ts:783-789)——`theme file not found` 含该子串被截胡;
- 新分支必须插在通用 'not found' 之前;translate 错误需按前缀分流。
- **复核**:读码确认两处形态属实。**处置(v2)**:Task 3 加前缀分流(`TOKEN_NOT_FOUND` 前缀 → 专属码);Task 4 mapper 顺序修正(`theme file not found` 前置)+ Review Focus 1 锚定单测。

### B2. ui_pixel_verify 完全未处置——共享 schema 被放宽

- ProtoColor 由 parseGeometry 共用,`$name` 对 pixel_verify 也合法;pixel-verify.ts:112 直接 normalizeColor → 对 `"$brand"` 抛错,handleUiPixelVerify 无 try 兜底 → 冒成 SCRIPT_EXEC_FAILED(错误码也错);共享 geometry description 扩写等于对外承诺 pixel_verify 支持。
- **复核**:读码确认 collectBgTargets 直接消费 nd.bg。**处置(v2)**:设计升级——Task 2 从「translateGeometry 加第二参」改为独立 `resolveGeometryTokens` 前置解析纯函数,Task 3 双链(import + pixel_verify)共用同一预取+解析辅助;pixel_verify 的 `$` 路径有 mock + e2e 双锚。

### B3. CI 生成物/计数门禁缺项——三处必红

- H-5(ci.yml:40-43):`git diff --exit-code docs/capability-matrix.json docs/capability-matrix.md docs/tools`——改描述/schema 须 `build-matrix && gen:tool-docs` 并 commit,计划 git add 全缺;
- check-tool-count(ci.yml:53):action 274→276 须同步 9 处计数面(README×8 正则+:240 分解/README.en/manifest 双口径/server.json/distribution/migration/rule-templates/core.md);
- `npm run lint`(ci.yml:25 首步)全文零出现。
- **复核**:实跑 gen-tool-docs → **46 文件**漂移(批1/批2 描述变更从未重生成 docs/tools,比审查所述 ui.md 单文件更重;matrix 本身无漂移已验证);check-tool-count RULES 表逐条读确认 9 文件。**处置(v2)**:Task 1 加存量漂移清偿(独立 commit);Task 3/4 门禁串与 git add 补生成物;Task 4 承接计数 9 文件 + lint 进全局纪律。

### B4. test/ui-tools.test.js 两处 `toBe(14)` 必红且不在 Files 清单(:25/:635)

- **复核**:两处确认。**处置(v2)**:Task 4 Files 显式列入,Step 5 测试串包含。

### B5. Task 5 版本链不完整,version-check 必红

- A 类 6 写入目标(manifest/plugin.cfg/server.json/Dockerfile/docs/使用指南.md/mcp_bridge.gd,version-sync.mjs:32-33)+ README 版本行 + package-lock 漏 add;`npm version` 默认 commit+tag 须 `--no-git-tag-version`(AGENTS:311 惯例);CHANGELOG 定版后 [Unreleased] 清空会撞 STRICT 兜底(无标识符 commit 只看 [Unreleased] 去符号后 >50 字符)。
- **复核**:WRITE_TARGETS/CHANGELOG 首段规则/README `| **v` 行规则读码确认;check-changelog-sync 的 isMentionedInChangelog 分支确认(无标识符 → 仅看 unrealed stripped>50)。**处置(v2)**:版本链整体移入 Task 4(规则变更任务同批 bump,沿批1 先例),含 --no-git-tag-version、A 类 add(以 version-sync 实际改动为准 + git status 收尾核对)、[Unreleased] 保留实质内容。

### B6. 缺独立审查文档任务(AGENTS:314-322 强制:plan 落地后必出 docs/reviews/)

- **复核**:AGENTS 条文与 docs/reviews/ 现状(无 refero 系列)确认。**处置(v2)**:新增 Task 6;批1/批2 缺档在文档头部声明为历史债(SDD 终审当时有做但未按 AGENTS 落档,不回补)。

## 🟠 Important(8 项)

| # | 发现 | 处置(v2) |
|---|------|----------|
| 1 | theme_path 默认值收紧(res://ui/theme.tres → 显式必传)未记录为决策 | Task 5 spec 新增 **D10** + 批3 节第 3 条改写 |
| 2 | 「语法糖」表述失真(token_set 是文件级新 action,非 node.theme 语法糖) | Architecture ③ 与 spec N6 表述修正(Task 5) |
| 3 | tokens_resolved.count 语义错位(map 键数 ≠ 已解析引用数) | 改 `{ theme_path, refs, tokens: string[] }`(refs=引用次数,tokens=去重已解析名) |
| 4 | 靶子 git 断言口径错(批2 实况是「与验收前同一 dirty 形态」非「干净」) | Task 5 改为 porcelain 快照前后一致断言 |
| 5 | changelog STRICT:定版后 [Unreleased] 清空即红 | Global Constraints 版本纪律 + Task 4 Step 4 明示保留实质内容 |
| 6 | 溯源不可核(ledger/终审编号引用在仓库内不存在——.superpowers 未入库) | v2 计划全部改自含表述(实测数字/in-repo 锚点),不依赖 ledger |
| 7 | theme_path 语义膨胀至四义未并列写清 | Task 3 description 四语义并列 + Task 4 规则文档小节 |
| 8 | 二次 spawn 成本未声明;预取 loadAutoloads 未定 | Task 3 预取 `loadAutoloads: false` + description/规则文档成本提示 |

## 🟡 Nit(12 项,全收)

1. GEO fixture 位置/风格(prototype-import.test.ts 自有 helper)→ Task 2 测试描述改按该文件风格;
2. Task 3 e2e fixture 描述与实况不符(main.tscn 非空/tokens.tres 是 constants/skipIf 形态)→ 改为「仿项目构造模式」+ 本批 fixture 写 colors;
3. mock 两段需注意既有 beforeEach mockReset → Task 3 Step 2 明示 mockResolvedValueOnce 链;
4. 原型链污染($constructor/$__proto__ 过正则)→ Object.hasOwn + 专项单测(Review Focus 3);
5. map 值未校验(NaN/HDR → Color(NaN,...) parse error)→ 长度 4 + 有限数校验 + 单测;
6. token_list 的 Color→[r,g,b,a] 转换未写(GD JSON.stringify 不认 Color)→ Interfaces 明示 + generator 单测(Review Focus 5);
7. 建主题指引不完整(theme_create 需 scene_path)→ 错误文案改「theme_create(scene_path+save_path) 或 ui_set_theme create+save」;
8. 三 generator 建议独立文件 → 新建 `src/tools/ui/ui-tokens.ts`;
9. rules-sync 本地预验用 STRICT=1;version-bump 检查是 HEAD vs 工作区(CI 恒跳过,但 N-C 四件套仍是应有动作)→ Task 4 门禁串采用;「门禁没拦 ≠ 合规」记入;
10. ui description 尾部 ${NON_PERSIST} 与 token_set 落盘冲突 → Task 4 补例外括注(theme_create(save_path) 同病顺手更正);
11. 快照目录命名与批1/批2 不一致 → 改 `refero-batch3-acceptance/`;
12. 靶子验收缺「主题未被破坏」断言 → Task 5 加 token_set 前后 get_type_list() + 既有代表项一致断言(compareBaseline 思路)。

## 结论

v1 的分层判断(预取注入保纯函数、token_set 面向文件、$ 第四分支)成立,事实核对质量高;缺陷集中在落地侧四条链路。v2 全部清偿且 Task 2 设计升级为 resolveGeometryTokens 双链共用(比 v1 更纯)。用户确认后按 Subagent-driven 开工。
