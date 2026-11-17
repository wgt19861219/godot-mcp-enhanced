# Refero 批3「tokens 层」独立审查报告

- **审查对象**:分支 `feature/refero-batch3-tokens`,自 master 分叉点(merge-base `211d15bb`,批2 收尾)起 10 个 commit:`f1072473..4458c5fa` 共 9 个为终审审查范围,`3c4850e8` 为终审 fix wave。内容为 Refero 批3 tokens 层——`$token` 引用解析、GD 预取 token map 注入(import/pixel_verify 双链)、`token_set`/`token_list` 文件级读写、预算校准、靶子验收。
- **审查者**:整支终审 opus 子代理(独立上下文,不预设提交声明为真;按 spec v3 + plan v2 + 全量 diff + ledger 独立复核,并实跑全部可跑验证)。过程层面:6 任务 SDD,每任务独立实现者 + 独立审查。
- **日期**:2026-11-17
- **总体判定**:**SHIPPED**(终审 Ready to merge: No → 修复后 Yes——唯一阻塞项 Important-1 一行修复;fix commit `3c4850e8` 落地,fix wave 复审 3/3 ADDRESSED,见文末)

## 历史债声明

refero 批1/批2 的 SDD 终审当时有做(会话内)但未按 AGENTS.md 段 8 落 `docs/reviews/` 文档,属流程债。本文件为该系列(refero 设计系统)审查文档的起点,**不回补旧档**;批3 起严格执行落档。

## 过程

- 6 任务 SDD,每任务独立实现者 + 独立任务审查;共 2 轮 fix:
  1. T1 补丁 `d340d39d`——预算断言同步 + lint 棘轮修复;
  2. 终审 fix wave `3c4850e8`——mapper 分支收紧(Important-1)+ spec D8 措辞修正(Minor-1)。
- 整支终审(opus)覆盖全部 9 个实现 commit,含全量 vitest/tsc/lint/生成物漂移/真机 e2e 实跑。

## 逐维度结论

### 1. 验证完整性 — 通过(独立实跑,全部通过)

| 验证项 | 结果 |
|---|---|
| 全量 vitest | **7889 passed / 0 failed** / 96 skipped(521 文件) |
| tsc --noEmit | 0 错 |
| lint | 0 errors / 533 warnings(基线零新增) |
| build-matrix + gen:tool-docs 重生成 | 与 committed 产物**零漂移**(git diff 空) |
| check:ssot-params / check:budget(0 error)/ check:tool-count(277,27 处) | 全绿 |
| rules-sync STRICT / version-check(0.37.0 六文件)/ changelog-sync STRICT | 全绿 |
| $token e2e 真机(test/ui-token-e2e.test.ts) | 9/9(float32 位级 delta 0 / TOKEN_NOT_FOUND / THEME_NOT_FOUND / pixel_verify / token_set 读回覆盖) |
| DESIGN_TOKENS_TYPE 单源 | types.ts:82 定义,ui-measure/ui-tokens 全部 GD 生成点内插,src 无游离 GD 字面量(仅注释与错误消息文本) |
| 安全面 | token_name 白名单双防线(schema TOKEN_REF_RE + handler 正则,index.ts:434);`Object.hasOwn` 防原型链(prototype-import.ts:310);sanitizeResPath(迭代解码 + traversal 拒绝,value-serializer.ts:98)三通道全覆盖;GD 注入面全经 escapeForGdLiteral,token_value 数字直插无注入向量 |

(上表与发现清单照录自终审报告 `.superpowers/sdd/2026-11-17-refero-batch3-tokens/final-review.md`,实跑数据为终审时点。)

### 2. 设计正确性 — 通过(D7 纯函数承诺完整兑现,且优于计划 v1)

`resolveGeometryTokens` 作为独立前置纯函数承接全部 `$` 解析,`translateGeometry` 签名不变、零 token 知识;TS 侧不解析 .tres 文本;预取走 GD 单次 spawn(loadAutoloads:false、无场景加载、有 `$` 才触发),双链(import/pixel_verify)共用同一辅助 `resolveTokensForGeometry`,无 `$` 流量零 spawn 由 mock「恰一次调用」与全量回归双锚。计划审查 B2 的设计升级(从「translateGeometry 加第二参」改为独立解析层)是正确的取舍——pixel_verify 链因此天然获得同一防线。跨任务一致性(T2 接口被 T3/T4 消费、四语义 theme_path description、token_set 3 元写入→4 元读回的形状闭环)均无走样。

### 3. 靶子验收 — 通过(支撑总验收第 3 条「样式 token 化可审计」成立)

379→380 type 全量值级完整性(远超 brief 的代表项抽样要求,探针走 tmpdir 不污染靶子)、token_set/list 逐值 `===` 读回、import `$` 链 style_verify 分量 delta [0,0,0,0] 位级复现、`tokens_resolved {refs, tokens}` 与主题总量解耦可审计、空档诚实空、靶子 git 动态快照前后一致——「同 spec 复用 token + token_list 可审计」的工具链证据链完整。验收工程质量高(fail 抛异常保 finally、幂等预清理、探针前缀过滤)。

### 4. 仓库级约束(AGENTS)独立核查 — 通过

生成物零漂移、277 计数 27 处、版本六文件 + README + CHANGELOG 一致、lint 棘轮 533 零新增、budget 校准含完整校准史。

## 发现与处置

### Critical(0)

无。

### Important(1)— 已修复(`3c4850e8`)

**Important-1:uiErrorMapper 新增 `includes('load failed')` 分支误伤既有消息 "Scene reload failed (post-persist)"——错误码语义回归**

- 证据:`src/tools/ui/index.ts` 的分支 `if (msg.includes('load failed')) return ERROR_CODES.THEME_NOT_FOUND;` 会命中 `src/tools/ui/ui-import-single.ts:59` 的既有错误消息 `"Scene reload failed (post-persist): ..."`——"re**load failed**" 含该子串。
- 后果:import 链 persist 成功但 reload 失败(场景损坏/非场景资源篡改)时,错误码从批3 前的 SCRIPT_EXEC_FAILED(正确)变为 THEME_NOT_FOUND(错误);`docs/error-codes.md` 的 THEME_NOT_FOUND 指引会把 AI 引向与真实失败原因完全无关的修复方向。该路径不限于 `$token` 流量——任何 import reload 失败都踩。
- 测试盲区佐证:`test/integration/ui-import-integration.test.ts:746` 只锚消息文本且直调 executor 不经 mapper,故 7889 全绿不能暴露它。
- 处置(已落地):分支收紧为 `includes('theme_path load failed')`(与计划「按消息前缀分流」纪律对齐——handler catch 用了严格 `startsWith('TOKEN_NOT_FOUND')`,mapper 却用了宽松 includes);补锚定单测 `test/ui-import-prototype.test.ts`("Scene reload failed (post-persist)" → SCRIPT_EXEC_FAILED)。旁注:同分支顺带核查 `includes('theme file not found')` 无既有消息误伤(已扫全部 ui 链 error 消息面,确认干净)。

### Minor(1)— 已修复(同笔 `3c4850e8`)

**Minor-1:spec D8「order 四类检测任一无产出省略 order 节」措辞与代码实况相反**——代码实况 `src/tools/ui/quality-check.ts:420` 是「任一**有产出**」挂节(即全无产出才省略,代码内注释正确)。spec v3 Task 5 维护时引入的单行措辞 bug(= ledger T5 minor①)。

## ledger minor triage(12 条 deferred:9 留档 / 3 已清偿)

| 条目 | 判定 | 理由 |
|---|---|---|
| T1:docs 清偿 commit 归因口径漏提更早批次 | 留档 | commit message 措辞;基线归零目的已达成且幂等验证过 |
| T2①:border.color 输入侧不变性断言缺失 | **已清偿** | Task 3 顺手补齐(test/prototype-import.test.ts `input.nodes[0]!.border!.color` 断言在) |
| T2②:TOKEN_NOT_FOUND 抛错用字面量非常量 | 留档 | 与 normalizeColor 先例一致;常量供工具层匹配,非缺陷 |
| T3①:「sanitize 上移」表述失实(实为双份幂等) | 留档 | 行为正确且幂等无害,仅注释口径出入 |
| T3②:hasTokenRefs 先于 sanitize(pixel_verify 无 $ + 非法 theme_path 静默忽略) | 留档 | 影响面≈0——pixel_verify 的 theme_path 语义只为 $ 存在;import 链挂载段仍拦截非法路径 |
| T3③:e2e 用例4 隐式依赖用例1 的 persist | 留档 | vitest 同文件串行成立;将来拆文件时需自建场景前置 |
| T3④:用例4 降级分支断言宽松 | 留档 | brief 明示以实际通道为准;Windows 实测走成功分支,降级断言已实现 |
| T4①:genTokenSetScript JSDoc 误称 loadAutoloads=false | **已清偿** | 最终态 JSDoc 已是正确表述(公共段默认 true,仅预取通道 false) |
| T4②:token_value 描述 0-1 但校验只查有限数 | 留档 | GD Color 本身允许超范围值(渲染时 clamp),非错误;后续收紧只需一行 min/max |
| T5①:D8「任一无产出」措辞歧义 | 留档→已修(`3c4850e8`) | 即 Minor-1;spec 单行,代码与代码注释正确 |
| T5②:完整性探针不覆盖 Theme 全局默认属性 | 留档 | 超 brief 的超额边界;验收记录已诚实声明,type 级 379 项全量比对已远超要求 |
| T5③:brief 的 1845 行旧数字 | **已清偿** | 验收 md 已用实读值 2487 |

## fix wave 复审(`3c4850e8` 之后)

**3/3 ADDRESSED,无新破坏**:

1. mapper 分支收紧落地(`src/tools/ui/index.ts:842`,`includes('theme_path load failed')` 全前缀);
2. 锚定单测入列(`test/ui-import-prototype.test.ts` +14 行,"Scene reload failed (post-persist)" → SCRIPT_EXEC_FAILED);
3. spec D8 措辞修正(spec:173 行,「任一无产出」→「全无产出才省略」)。

同笔顺带同步了 `src/tools/ui/index.ts`/`src/core/error-codes.ts` 的相关注释;残留 `src/tools/ui/ui-tokens.ts:16` 文件头注释仍写旧子串 `includes('load failed')`(仅注释过时,不影响行为),由本 Task 6 落档同笔顺手清偿。

## 值得进 memory 的工程教训

1. **错误分流 mapper 新增子串分支必须双向扫描既有消息面**:任务审查防住了「新消息被既有分支截胡」,却没防「新分支误伤既有消息」——两者是对称盲区,本次 Important-1 即后者(mapper 新增 `includes('load failed')` 误伤 "Scene re**load failed**")。纪律:新增子串匹配前,全量枚举该 mapper 消费链上的既有错误消息文本;锚定单测须覆盖「既有消息 → 原错误码不回归」方向,不能只锚新增分流。
2. **审查文档落档是流程强制项而非会话内动作**:批1/批2 终审做了但没落档,本批补起点——「会话内审过」对仓库不可见,等于对后续读者没审过。
