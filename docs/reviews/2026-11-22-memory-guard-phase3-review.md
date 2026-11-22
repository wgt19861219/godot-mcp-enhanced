# memory-guard 三期（实现收敛批）独立审查

**日期**：2026-11-23　**审查人**：fresh reviewer（Claude，独立会话）　**分支**：`feat/memory-guard-p3`
**范围**：`b2198f81..3870b22f`（8 commits：计划落档 1 + 功能 6 + 审查修复 1）
**依据**：计划 `docs/superpowers/plans/2026-11-22-memory-guard-phase3.md`（Review Focus 五条 + Global Constraints）；Spec `docs/superpowers/specs/2026-11-22-memory-guard-design.md`（§L2 豁免规则、§L3 可观测性）

---

## 一、审查范围与方法

- **主视图**：review package（`.superpowers/sdd/2026-11-22-memory-guard-phase3/review-b2198f81..3870b22f.diff`，2012 行全量通读——commit 清单 + stat + 完整 diff，单遍完成无需分卷）。
- **源码核实**：`src/core/exit-watchdog.ts` 全文（源码锚断言验证）、`src/core/memory-guard.ts` 与 `src/core/mem-watchdog.ts` 关键段落当前态与 diff 一致性、行号以当前 worktree 实测为准。
- **测试基建核实**：`mockForceSnapshots`（force 序列耗尽续用末值）、session-idle-timer.test 外层 beforeEach（`resetState`+`_resetForTest` 与内层 stubEnv 的顺序关系）、mem-watchdog.test 的部分 mock（importOriginal 保真）vs idle-timer 侧真实 import 的差异各自自洽。
- **行为验证（read-only）**：定向跑 6 个受影响测试文件 `npx vitest run test/core/{memory-guard,mem-watchdog,exit-watchdog,session-idle-timer}.test.ts test/cli/doctor.test.ts test/tools/get-context.test.ts` → **6 files / 175 passed / 1 skipped / 0 failed**，与任务报告一致。
- **环境已知事实排除**：本机 git 裸日期 `--since` 空致 changelog-sync worthy 恒绿（不作为门禁证据采信，改以 diff 逐条目核对 CHANGELOG 内容完整性）；working tree 先存脏文件 `test/fixtures/gdscript-check/project.godot` 非本批产物（CHANGELOG 已注明），不在审查范围。

## 二、Review Focus 五条逐条核验

### 1. env 部分非法（`prevew,editor` 拼错）→ 不得整体失效 ✅

- 实现：`src/core/memory-guard.ts:467-479` `watchdogExemptGroups()`——split `,` → trim → toLowerCase，逐 token 独立判定，未知非空 token 记一行 `console.error` 后跳过，合法 token 照常进 Set。无任何「遇错整体 return 空」路径。
- 测试：`test/core/memory-guard.test.ts` ⑭④（`env=prevew,editor`）——断言 candidates 只剔 editor（`['N']`）、`envExempted = {preview:0, editor:1}`、`errSpy` 恰一次且报文含 `prevew` 原始 token。全平台用例（不依赖 RSS 通道）。
- 判定：**通过**。部分生效语义成立，warn 点名非法 token 可 grep。

### 2. 豁免组残留殿后（env 只豁免 editor）→ preview 仍殿后、普通候选 ratio 降序不变 ✅

- 实现：`src/core/memory-guard.ts:506-525`——env 剔除发生在 rows 构建循环内（`continue` 跳过命中组），**剩余行的 exempt 标记（`:523`）与排序比较器（`:525`，exempt 恒排尾部、组内 ratio 降序）与二期逐语义一致**（diff 证实比较器零改动，仅 rows 构建从 map 重构为 for 循环，行为等价）。
- 测试：⑭②（env=editor，四租约混合）——断言 `['N2','N1','P']`（headless 区 1.5>0.75 降序在前，preview 会话 P 殿后留在候选），`envExempted.editor=1`。
- 判定：**通过**。殿后与 env 豁免两语义正交且共存。

### 3. 单进程硬帽与豁免正交（env 豁免 editor 后 editor RSS 超声明×3）→ 仍被单进程杀 ✅

- 实现：`src/core/mem-watchdog.ts` pollOnce 单进程杀循环（约 :123-131）**零改动**——diff 证实该段为上下文行；循环内无任何 `WATCHDOG_EXEMPT` 查询，`KILL_FACTOR` 判定不读 env。头注释（:22-25）同步声明禁令语义。
- 测试：`test/core/mem-watchdog.test.ts` 三期②——env=editor + editor RSS 12.5GB > 4096MB×3=12GB → `pollOnce` 返回 killed:1、killPidTree（spawnSpy）恰一次、`wasMemKilled(6001)` 归因在案、租约释放。机器快照走 beforeEach 默认恒健康（不进驱逐），纯测单进程杀路径——隔离干净。
- 判定：**通过**（Docker 反模式禁令核心语义：无上限豁免被禁止）。

### 4. 候选耗尽报文区分「真无租约」vs「全被 env 豁免」✅

- 实现：`src/core/mem-watchdog.ts:157-168`——耗尽分支（victim undefined）在既有句后按 `envExempted` 任一非零追加「(另有 N 笔租约被 GODOT_MCP_WATCHDOG_EXEMPT 豁免: preview X, editor Y——需人工处理或调 env)」，全零保持原句（无豁免场景零噪音）。计数快照取自耗尽当轮的 `getEvictionCandidates()` 重读账本（循环每轮重取），豁免租约未被杀仍在账本 → 计数正确。
- 测试：三期①——仅 editor 租约（8GB，ratio 1.95 高但 < 12GB 杀线不触单进程杀）+ force 恒低压 → 驱逐循环耗尽；断言 stderr 含「已无本 server 可驱逐进程」+「被 GODOT_MCP_WATCHDOG_EXEMPT 豁免」+「editor 1」，租约保留（`['E']`，不是看门狗杀的）、状态诚实保持 hard。
- 判定：**通过**。归因信息区分了两类耗尽。

### 5. 查⓪ enteredAt null 防御 ✅

- 实现：`src/core/memory-guard.ts:664-672`——三元分支 `enteredAt === null` 时用原主旨句（跳过时长后缀不炸），非 null 拼 `——已持续 ${Math.round((Date.now()-enteredAt)/1000)}s`。
- 测试：memory-guard.test ⑫⑧（pressure 进入后再过 45s，报文含「已持续 45s」+ 主旨句保持；`getPressureEnteredAt()` 非 null 兜底断言）+ ⑨（hard 态 12s 同覆盖，hard 进入重置 enteredAt 由其覆盖）。「非 normal 且 enteredAt=null」经公开 API 不可构造（状态机三进入点均同时设值）——计划 Task 6 Step 1 的 fallback 方案（「若不可构造则断言现有分支恒有 enteredAt，注释注明防御不可达」）被如实执行，测试注释完整记录论证。
- 判定：**通过**。

## 三、spec §L2 豁免规则逐句对照

| spec §L2 原文（豁免规则句） | 实现落点 | 判定 |
|---|---|---|
| 「preview 会话与编辑器**不豁免记账**（L1 已计入）」 | 记账路径（acquireLease/bindPid/预算统计）零改动，env 无任何记账分支 | ✅ |
| 「但**驱逐排序最后**」 | 未设 env 时 exempt 殿后排序逐语义保留（比较器零改动）；env 命中组才是「不进候选」的升级语义，两者共存正交（Review Focus 2 钉住） | ✅ |
| 「若 env 显式 `GODOT_MCP_WATCHDOG_EXEMPT=preview,editor` 全豁免，则同时**强制它们的单进程硬帽（声明 × 3）仍生效**」 | KILL_FACTOR 循环零改动且不读 env；测试 ② 钉住 env=editor 下超帽照杀 | ✅ |
| 「**无上限豁免被禁令禁止**」 | env 仅收窄驱逐候选集合，单进程杀线恒开——不存在任何「永不杀」配置 | ✅ |
| 「外部进程（用户手开）**永不杀**」（§L2 硬阈值句 + §4 责任边界） | 候选过滤 `l.serverPid === process.pid && typeof l.pid === 'number'` 未动（memory-guard.ts:501-503），env 剔除只在此集合内做减法 | ✅ |
| §L3 可观测性「面板附内存面板」 | `MemoryPanelData.watchdogExempt`（固定序）经 buildMemoryPanel 单源透出 doctor/get_context，outputSchema typed outputs 契约同步声明 | ✅ |

**结论：spec §L2/§L3 无偏离。** 二期终审指出的「env 设计层未实现」差分本期收口，实现语义与 spec 前瞻注释一致。

## 四、计划对齐与其余任务核验

- **Task 1**（0eec3f20）：Interfaces 两条产物（`watchdogExemptGroups(): ReadonlySet` + `getEvictionCandidates()` 新签名 `{candidates, envExempted}`）与计划逐字一致；测试用例五组（未设/editor/双豁免/拼错/空串与 `,,`）全数落地。
- **Task 2**（af36d5ad）：四件齐——panel 字段（固定序 `(['preview','editor'] as const).filter`，memory-guard.ts:935-940）、doctor 行（enabled 且非空才附，doctor.ts:368-371，disabled 不附的设计理由有注释）、README 双语 env 表、规则双副本（rule-templates.ts 与 .claude/rules/godot-mcp-core.md 同句同步，STRICT rules-sync 门禁佐证）；get-context outputSchema + 测试契约同步。
- **Task 3**（1df3a576）：两条集成测试落地且质量高——正交测试采用「先绝对断言 normal 基线再 `toEqual(hardObs)`」的对比写法（**防两态同坏时对比恒绿**，这是对比型测试的正确姿势）；源码锚（exit-watchdog.ts 不含 `/pressure/i`、不 import memory-guard）+ 行为双钉；幂等测试双向时序（驱逐先杀→idle 感知死进程跳过；idle 先回收→驱逐候选空 no-op），核心断言「无二次树杀 + 账本终态一致 + 不抛」齐备。核实外层 beforeEach（resetState+_resetForTest）先于内层 stubEnv 执行，pressure 状态机用例间无泄漏。
- **Task 4**（e206f551）：纯注释（bridge-client.ts:647-653），警示内容与计划 Step 1 要点一致（现状可容忍的论证 + 未来周期重试必须 `poke:false`）。
- **Task 5**（12886a1f）：无源码改动，CHANGELOG 留证（响应 JSON 原文含 `static_mem: 50370206` 有限数字、pid/项目指纹双核验、清理纪律）。控制面以 `handleTool` 等价链路替代 MCP 工具直调属可接受等价验收（计划 Interfaces 认可环境内等价链路）。
- **Task 6**（5fb5c4f9）：查⓪ 时长后缀 + 版本四件套（package.json/manifest/plugin.cfg/server.json/Dockerfile/使用指南/mcp_bridge.gd BRIDGE_SCRIPT_VERSION 六 A 类 + README 版本表 B 类）机械同步完整，version-check 门禁佐证。
- **审查修复**（3870b22f）：CHANGELOG Task 2 重复条目删除，核对本版 CHANGELOG 无重复。

## 五、Deferred Minors Triage（10 项裁定）

| # | 延后项 | 裁定 | 理由 |
|---|---|---|---|
| 1 | mem-watchdog.test 注释「低压」措辞易误读 | **留** | 纯注释，无行为影响 |
| 2 | warn 报文取 `token.trim()` 而非字面 raw | **留** | trim 后展示反而可读；断言不受影响（已自审披露） |
| 3 | doctor.test 缺「disabled+豁免非空→不附」「enabled+空→不附」边界钉子 | **建议补，不阻塞** | 当前行为正确（doctor.ts:368 条件清晰）；四格真值表只钉两格，`disabled+非空` 是「disabled 不误导」设计意图的唯一未验证格——未来重构把条件改成只查 length 测试不挂。补两行断言成本极低，建议随手补 |
| 4 | `not.toContain('exempt')` 全 output 断言过宽 | **留** | 低概率误挂（未来英文文案含 exempt 字样）；挂了也是提醒审视文案 |
| 5 | 规则句位置语义化（L2 驱逐句后 vs 计划字面 L1 句群后） | **留档** | 语义等价，双副本一致即达 rules-sync 目的 |
| 6 | killForEviction dead 分支无驱逐版直测 | **留** | 同函数被既有单测（杀前已死仅清租约）覆盖，驱逐路径走同一实现 |
| 7 | 正向序「终态一致」口径依赖注释时序推理 | **留** | 断言本身是行为断言（无二次树杀/账本清/不抛），注释只解释机制 |
| 8 | ping 响应原文疑似摘编 | **留** | static_mem 段完整，核心断言有 JSON 原文为据 |
| 9 | 全量首跑 flaky 2 例（defects-fixed 复发计数 + worker teardown 竞态） | **留但关注** | 既有 flaky 基建非本批引入路径；建议在 defects 体系继续追踪复发频次 |
| 10 | errSpy.mockRestore 不在 finally | **留** | 与仓库既有测试风格一致，afterEach `restoreAllMocks` 兜底 |

**合并前必修项：无。**

## 六、发现的问题

### Critical（必须修）

无。

### Important（应当修）

无。

### Minor（建议改）

1. **hard 态查⓪ 主旨句文案失真**——`src/core/memory-guard.ts:672`：hard 直进（0s 宽限）场景下报文仍说「整机内存压力(**软阈值**)持续 30s」，但 hard 的进入条件不是持续 30s。计划 Task 6 Step 3 明确裁定「主旨句保持」故不属偏离，且新增后缀「已持续 Ns」已提供准确时长（hard 进入重置 enteredAt 由其覆盖），误导程度显著降低。建议未来迭代时 hard 态分支换主旨句（如「整机内存压力(硬阈值)——拒新保旧」）。
2. **`watchdogExemptGroups()` 重复 warn 同一非法 token**——`src/core/memory-guard.ts:473-477`：每次调用实时读 env（计划明文设计，保证面板与实际生效一致），代价是 hard 态驱逐循环期间每 10s 轮询重复打同一 warn、每次面板查询也打。与既有 hard 耗尽报文同量级（可 grep、起持续提醒作用），可接受；若未来嫌吵可做「同 token 进程生命周期内只警一次」的去重（Set 记已警 token），注意与「实时读 env」语义不冲突（去重只影响日志不影响解析结果）。
3. **Deferred #3 doctor 边界钉子**（见上表裁定）——建议补 `disabled+非空→不附` 与 `enabled+空→不附` 两行断言，钉死 doctor.ts:368 条件的完整真值表。

## 七、做得好的地方

- **对比型测试的正确写法**（exit-watchdog 正交测试）：先对 normal 基线逐字段绝对断言、再 `expect(hardObs).toEqual(normalObs)`——杜绝「两态同坏、对比恒绿」的经典假绿模式；配合源码锚（`/pressure/i` 不匹配 + 不 import memory-guard）形成行为+结构双钉。
- **「零改动即证据」的纪律**：单进程硬帽独立性不是靠新代码实现，而是靠 pollOnce 杀循环零改动 + 测试钉住——最小改动面贯彻 Docker 禁令。
- **耗尽报文归因设计**：`envExempted` 计数随候选同点产出、耗尽当轮重读账本，语义准确且全零时零噪音。
- **测试隔离前瞻**：两测试文件 beforeEach 显式归零 `GODOT_MCP_WATCHDOG_EXEMPT`（空串=未设），防宿主环境变量泄漏污染既有用例——这是新 env 引入时最易漏的隔离动作。
- **固定序契约**：`watchdogExempt` 输出恒 preview→editor（乱序/大小写输入归一），doctor 行与 typed outputs 展示稳定。
- **文档与版本收口完整**：六 A 类文件机械同步、README 双语 env 表、规则双副本同句、CHANGELOG 回标与收口段齐备。

## 八、结论

**Ready to merge? Yes**

**理由**：Review Focus 五条全部有实现+测试双重锚定且定向复跑全绿（6 files / 175 passed / 0 failed）；spec §L2 豁免规则逐句对照零偏离（记账不豁免/殿后保留/硬帽恒独立/外部进程永不杀四语义全部成立）；Deferred 10 项无合并前必修项；三条 Minor 均为文案精度与测试补强建议，不构成行为缺陷，可随后续迭代处理。
