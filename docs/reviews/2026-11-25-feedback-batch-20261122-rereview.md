# 反馈批 20261122(0.41.1)终审修复波范围性复审

**日期**:2026-11-25　**审查人**:控制器(ZCode 主会话,实跑门禁)+ 独立复审者(fresh general-purpose 子代理,全程只读)　**分支**:`worktree-fix-feedback-batch-20261122`
**范围**:`0efa83ed..16901907`(四笔提交:1bf08c1c / 3eacf8fc / 9b1473d4 / 16901907;9 文件 +308/−36)
**依据**:终审修复波报告与执行账本 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.superpowers\sdd\2026-11-22-feedback-batch-20261122\final-fix-report.md`、同目录 `progress.md`(内含全分支终审的原始发现与控制器 triage;原 worktree 已移除,此处是保留副本);仓库规则 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\AGENTS.md`

---

## 一、范围与方法

- **为什么补这一轮**:全分支终审判定 With fixes,随后落了四笔修复波。修复波报告自述「未跑:全量 vitest、check:gdscript」,只跑了定向的 8 + 13 个测试文件;开发日志把「范围性复审 → memory → 合并」列为未完成。本轮补齐全量门禁与独立复审后再合并。
- **控制器**:在分支顶点 `16901907` 上跑全量门禁与 CI 静态检查清单(第三节),执行合并与合并后验证(第八节)。
- **独立复审者**:只读复审四笔提交,不预设修复波报告的任何声明为真——逐条核对出口清点、判据边界、错误体结构、注入点真实性、报告里的数字与行号,并独立核查仓库级约束。未运行任何测试,其结论以控制器全量门禁全绿为前提。
- **限制(诚实声明)**:独立复审者未核对 F 项的仓外文档(反馈库顶部总表、开发日志),未复跑真机探针(只判断输出内部自洽)。控制器未重跑上一轮终审已覆盖的八任务主体,只复验修复波之后的终态。

## 二、总体判定

| 维度 | 判定 | 一句话 |
|---|---|---|
| 修复波对终审发现的清偿 | **PASS** | Important-1 / M-3 / triage-1~3 / M-1 / M-4 六项逐条落地,与控制器裁定一致 |
| 出口覆盖(被杀尾注) | **PASS** | 独立清点停旧后 9 处 return:5 个失败出口直接拼接,4 条成功响应经 `sessionNote` |
| 首跑文案与错误体 | **PASS** | 没杀旧实例时拼接结果逐字相同;`Error:` 前缀、`isError`、结构化 `error_code` 不受影响 |
| 塌 0 判据 | **PASS(有一条边界 Minor)** | 两支判据、空数组、NaN 处理与实现一致;被测根不是 Control 时 `nodes[0]` 语义不成立(Minor 2) |
| 新增测试的鉴别力 | **PASS** | dispatcher 级测试走真注入点、无假绿路径;尾注正则带 `$` 锚定;塌 0 接线用例先自证假发现存在 |
| 仓库级约束 | **PASS** | 双副本、生成物、分层、setter、any、ESM 扩展名、GDScript 均未触及或合规(第七节) |
| 全量门禁 | **PASS** | 独立复审前由控制器补齐:lint / build / 全量 / GDScript / CI 静态检查(第三节) |

**结论:SHIPPED WITH NITS —— Ready to merge: Yes。** 0 Critical / 0 Important / 9 Minor,Minor 全部是既有问题或文档补全,不阻塞合并,处置见第五节。

## 三、控制器实跑的门禁(HEAD `16901907`,2026-11-25 18:24–18:53)

| 检查 | 命令 | 结果 |
|---|---|---|
| lint | `npm run lint` | `533 problems (0 errors, 533 warnings)`,与锁定基线持平 |
| 构建 | `npm run build` | 成功 |
| 测试辅助类型 | `npm run typecheck:helpers` | 0 错 |
| 全量测试 | `npm test` | Test Files **534 passed / 16 skipped (550)**;Tests **8274 passed / 98 skipped (8372)**,0 failed;Duration 278.94s |
| GDScript | `GODOT_PATH=D:/godot/Godot_v4.7.2-stable_win64_console.exe npm run check:gdscript` | `errors=0 warnings=0` |
| 生成物漂移 | `npm run build-matrix` 后 `git status --porcelain -- docs/` | 无差异 |
| Godot 4.7.2 定向 | `npx vitest run test/ui-quality-check.test.ts test/ui-measure-theme.test.ts` | 2 files / **90 passed**,靶子场景未误触发塌 0 守卫 |
| CI 静态检查 | `check-token-budget`、`check-tool-count`、`check-ssot-params`、`check-e2e-l2-coverage`、`check:tool-groups`、`check:modules-sync`、`check:command-docs-drift`、`check:gd-duplicates`、`check-contract`、`check-rules-version-bump`、`version-sync --check`、`check:protocol-versions`、`check-env-isolation`、`STRICT=1 check:rules-sync`、`check:path-coverage` | 全部 PASS |

两条红,均非本批引入,已另批修根因(分支 `fix/ci-gates-20261125`):

- `check:test-quality`:弱断言 `911 > 上限 860`。与修复波报告的基线一致(本波新增行命中 0)。
- `STRICT=1 check:changelog-sync`:点名 `1bf08c1c`、`c6ad5838`。两条都已按哈希登记在 `[0.41.1]` 段,属门禁脚本误报——`git log --since=<裸日期>` 是「该日当前时刻」而非零点(发版当天空过,次日起只框进发版日当晚的提交),且标识符正则把评审标签 `Important-1` / `Minor-1` 当成追踪号。

运行备注:`check:gdscript` 改写了已跟踪夹具 `test/fixtures/gdscript-check/project.godot`(既有问题),已 `git checkout --` 恢复。

## 四、独立复审者逐条核对(摘要)

判定「属实」的关键声明:

- `killedNote` 计算位置在停旧段之后(`src/tools/runtime.ts:236-238`),供其后的全部出口共用;`killedPreviousPids` 只在 `:220` / `:225` 被写,上移定义不改变取值。
- `opsErrorResult` 是 `errorResult(JSON.stringify(opsError(...)))`(`src/core/shared/errors.ts:55-61`),尾注落在 JSON 的 `error` 字段内。
- 槽位 busy 出口在生产代码里当前不可达(`:229` 到 `:256` 之间没有 await),用例注释已如实说明。
- 塌 0 判据 `src/tools/ui/quality-check.ts:421-426`:先判空再取 `nodes[0]!`,NaN 走 `<=` 恒 false。
- dispatcher 级测试 `test/core/ToolDispatcher.no-project-path.test.ts:19-32`:真 `ToolDispatcher` + `registerAllModules()`,只接管 `resolveProjectPath`,而它正是 `src/core/ToolDispatcher.ts:348` 调用的函数;三者移出名单则 6 例全红(静态推理,未运行)。
- 修复波报告里的四笔 stat、所引行号、9 个文件换行符、四笔提交的署名尾行,逐项核对一致。

## 五、Minor 清单(9 条,均不阻塞;行号取自独立复审者报告,以 `16901907` 为准)

| # | 位置 | 问题 | 处置 |
|---|---|---|---|
| 1 | `src/GodotServer.ts:697-698`、`src/cli/bridge-session.ts:48` | Web GUI 与 CLI 对失败文案截断 200 字符,内存守卫拒绝报文加 JSON 前缀后,尾注会被截掉。既有截断;M-3 在 MCP 主通道完整 | 挂账,随后续批处理 |
| 2 | `src/tools/ui/quality-check.ts:426` | 被测根不是 Control 时,`_walk` 只把 Control 入列,`nodes[0]` 是第一个 Control 后代,`slice(1)` 会含别的分支——首节点 0×0 且别的分支带锚点时整份报告被压制 | 挂账,随后续批处理 |
| 3 | `src/tools/ui/quality-check.ts:399-420`、`CHANGELOG.md:33` | 第二支判据的保守面(有意为之的 0×0 分组壳 + 带锚点子节点也会触发)只写在修复波报告里 | 文档补全,随后续批 |
| 4 | `README.md:910` | 仍写「`run_project` **成功响应**尾部附」,修复后失败出口同样带尾注 | 文档补全,随后续批 |
| 5 | `src/tools/ui/index.ts:238` 对 `CHANGELOG.md:21` | schema 描述写「须与项目视口一致」,CHANGELOG 写「不一定是项目视口」;agent 实际读的是 schema | 本批已声明不改 schema,随后续批 |
| 6 | `test/core/memory-guard-funnels.test.ts:647-660` | 对照用例标题写「失败文案零变化」,实际只断言前缀标志加 `not.toContain('killed previous')` | 挂账 |
| 7 | `test/core/memory-guard-funnels.test.ts:628-635`、`test/core/ToolDispatcher.no-project-path.test.ts:71` | `spy?.mockRestore()` 不在 `finally` 里;`not.toContain('project_path')` 耦合生成物 `docs/tools/help.md` 的内容 | 挂账 |
| 8 | `CHANGELOG.md` 已知问题 | 非根的零尺寸中间层加带锚点子节点不触发守卫(按裁定只认首节点),与已知问题 2 可串成现实链 | 建议登记为已知问题 3,随后续批 |
| 9 | `CHANGELOG.md:45`、`src/tools/ui/index.ts:1097-1106` | CHANGELOG 的全量数字(8254 passed / 549 文件)是修复波之前的,终态见第三节;塌 0 两条 warning 是英文,同列表的兄弟条目是中文 | 终态数字以本文档第三节为准 |

## 六、修复波报告「顾虑」7 条的裁定

| # | 顾虑 | 裁定 |
|---|---|---|
| 1 | 反馈库 help 条仍写「验证只到单元层」 | 成立,合并收尾时更正 |
| 2 | CHANGELOG 多改了 Task 1、Task 4 两处 | 成立且应当改——两处因本波代码提交而失实,不改才是漂移 |
| 3 | 多补的用例 | 成立且有鉴别力,不撤回 |
| 4 | 槽位 busy 出口不可达 | 成立,独立推出同样结论;用例注释诚实 |
| 5 | 第二支判据的保守面 | 成立,与控制器裁定一致;文档面缺口见第五节 #3 |
| 6 | 既有噪音(dispatcher 日志、`EDITOR_ONLY` 未在 `error-codes.ts` 登记) | 成立,非本波引入 |
| 7 | 真机只覆盖 Godot 4.7.2 | 成立;判据不依赖版本特有行为 |

## 七、仓库级约束核查

| 约束 | 结果 |
|---|---|
| 规则文档双副本(`src/tools/rule-templates.ts` ↔ `.claude/rules/*.md`) | 未触及,`STRICT=1 check:rules-sync` 通过 |
| 生成物(capability-matrix、`docs/tools`) | 本波未改 schema 或工具清单;`build-matrix` 重建后无差异,`check:command-docs-drift` 通过 |
| `src/core/**` 不得 import `../tools/` | 全仓无违规,本波未改 `src/core` |
| 禁止新增模块级 setter 注入点 | 新增行无命中 |
| 禁用 `any`、未使用变量 | 新增行无 |
| ESM import 带 `.js` 扩展名 | 新测试文件合规 |
| `.tscn` / GDScript / `addons` | 未触及 |
| CHANGELOG 版本段的仓库文件引用体例 | 相对路径加反引号,与同段既有写法一致 |
| 弱断言门禁 | 本波新增行命中 0、删除行命中 0 |
| 版本 bump | 未触及规则模板与 `package.json`,不需要 |

## 八、合并执行

- 方式:**快进**。分支领先 master 20 个提交、落后 0 个;快进不改写历史,反馈库与 CHANGELOG 里引用的哈希不用回填。合并由控制器在用户授权「按情况分类处理」下执行;合并前 master 位置 `d57e376a`。
- 结果:master `d57e376a` → `16901907`(版本 0.41.1),2026-11-25。worktree 已移除,分支已删除;SDD 执行工作区(账本、简报、审查包)保留副本于 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\.superpowers\sdd\2026-11-22-feedback-batch-20261122\`。
- 合并后验证(主 checkout):`npm run build` 成功、`npm run typecheck:helpers` 0 错、`node scripts/version-sync.mjs --check` 一致(0.41.1)、修复波及其邻近的 22 个测试文件 **781 passed**。
- 生效条件:本机 4 个 godot MCP server 进程是从主 checkout 的 `build/index.js` 启动的,内存里仍是 0.41.0 的代码,重启后才生效。
- 未做:`git push`、npm publish、tag、GitHub Release——均待用户明确指令。

## 九、值得进 memory 的工程教训

1. **定向测试全绿不等于可合并**。修复波报告的「最终验证」只跑了 8 + 13 个文件并如实写了「未跑全量」;补跑后全量是 8274 passed,比报告引用的 8254 多 20 条。合并前必须在被合并的那个 SHA 上跑全量。
2. **发版日的门禁空过会掩盖次日的误报**。`check:changelog-sync` 在定版当天因为裸日期的时间语义一个提交都筛不出来,显示通过;第二天才暴露误报。按日期筛提交的门禁,应当显式写零点。
3. **只读复审者不要读工作区**。控制器在复审期间切换分支、变基,复审者读到的磁盘文件可能与被审 SHA 不一致。本批之后的审查一律只允许读 git 对象(`git show <SHA>:<路径>`、`git diff <A>..<B>`)。
4. **修复策略不预设根因**。本批反馈里四处根因假设经代码求证后全部修正,其中两处至今未定位;修法从「治根因」改为「守卫 + 可观测性」,反馈库只回标 🟡 不闭环。「工具里找不到这个缺陷」不等于「用户遇到的问题已解决」。
