# validate_scripts 静默假通过修复:独立审查与处置记录

**日期**:2026-11-26　**审查人**:控制器(Claude Code 主会话,实跑门禁与真机取证)+ 独立审查者(headless-reviewer 子代理,只读代码与测试,两轮)　**分支**:`fix/validate-scripts-stderr-20261126`(基于 master `24c47097`)
**范围**:`src/tools/validation.ts`、`src/tools/batch-tools.ts`、`src/tools/workflow.ts`;新增 `test/validation-validator-failure.test.js`、`test/validation-real-godot.test.js`;改动 `test/validation-attribution.test.js`、`test/validation-tools.test.js`、`test/batch-tools.test.js`、`test/tools/workflow.test.ts`、`test/script-editing-mock.test.js`;`CHANGELOG.md`、`docs/flaky-watchlist.md` 与本记录
**依据**:2026-11-26 MCP 安全与协议审查后续的验证途中发现两条静默假通过(C-1 / C-2),根因与改法见 `CHANGELOG.md` 同名条目

---

## 一、范围与方法

- **为什么有这一批**:`validate_scripts` 及其同族消费点自 `6177ddfc`(2026-06-05)起只读 `spawnGodot` 的 stdout,而 Godot 的 `SCRIPT ERROR: Parse Error` 全部写在 stderr,对真实语法错误恒报 0 errors;校验器自身失败(`<validator…>` 条目)又被 `validate_scripts` 的输出组装丢弃。
- **改了什么**:三处消费点改为两路都读;`validate_scripts` 显式输出校验器失败;审查后追加 Windows 键归一与 `create_files` 的异常修复。不改分析器(`src/error-analyzer.ts`)的语义。
- **控制器**:真实 Godot 复现 → 修复 → 回归用例红绿实测(临时还原源码) → 变异检验 → 门禁实跑。
- **独立审查者**:两轮。第一轮 **BLOCKING ISSUES**(Blocking 2、Important 5、Nits 7);对阻断项修复做范围性复审后改判 **SHIPPED WITH NITS**。两轮都只读代码与测试,没有复跑任何内容;下文的实跑数字全部来自控制器。

## 二、总体判定

**SHIPPED WITH NITS**(独立审查者复审结论)。两处阻断项读码成立且已修,没有引入新的错误行为;Important 条目延后另立条目的归类经复审认可。

## 三、Blocking Issues(均已修)

### B-1 Windows 上 `validate_scripts` 的输出层丢掉已归因的错误

- **证据**:`batchValidateScripts` 的结果键出自 `stripProjectPrefix`(`src/tools/validation.ts:234`,恒正斜杠);`validate_scripts` 的 `relOf` 出自 `relPathOf`(`src/core/path-utils.ts:222`,win32 恒反斜杠)。原实现用后者查前者建的 `errorMap`,根目录脚本无分隔符能对上,子目录脚本必失配——真项目脚本几乎都在子目录。
- **为什么此前无从暴露**:根本没有错误可查。控制器的真机取证起初也全用根目录脚本,恰好绕过。
- **修法**:建键与查找两侧统一过 `normKey`(`src/tools/validation.ts:939`,`:941`、`:944-947` 建键,`:957`、`:961`、`:986` 查找与判定)。
- **测试**:`test/validation-validator-failure.test.js`「子目录脚本的 Parse Error 进入 scripts[].errors 与 total_errors」;`test/validation-real-godot.test.js`(真实 Godot,走 `validation.handleTool`,脚本在 `scripts/` 下)。
- **变异检验(控制器实跑)**:仅把 `errorMap.get(normKey(rel))` 改回 `errorMap.get(rel)`,上述两例在 Windows 上都变红(`expected +0 to be 1`);还原后通过。

### B-2 `create_files(validate=true)` 遇到真实语法错误会抛异常

- **证据**:原实现对已是相对路径的 `r.file` 调 `relPathOf`,`path-utils.ts:233` 对不在项目根下的输入直接 throw;该段无 try/catch。校验器没拉起时(`<validator:spawn>` 的 `errors` 非空)早就能触发,真实语法错误可见后成为必经路径。
- **修法**:`src/tools/batch-tools.ts:174-191`——`<validator…>` 条目进 `result.validator_failures`(带 `not_validated`)并置 `result.incomplete = true`,其余直接以 `r.file` 作 `validation_errors` 的键;该文件的 `relPathOf` 导入已移除。
- **测试**:`test/validation-validator-failure.test.js` 的 `create_files(validate=true)` 三例(有 Parse Error / 没拉起 / 正常对照)。

## 四、Important(延后,待立项;复审认可这一归类)

- **I-1 退出期泄漏噪声**:`run_verify` 现在与 `run_and_verify` 同用 `analyzeOutput`,后者对 `resources still in use at exit` 一类噪声没有过滤(`src/error-analyzer.ts:174-181` 归 `runtime_error`,`:205` 默认分支同理)。规则文档写的「应忽略」在分析器里并无实现,属既有不一致。审查者估计只影响「场景在超时内自行退出且退出时有未释放资源」的少数目标。
- **I-2**:`USER ERROR:` 不被 `analyzeOutput` 识别(审查者引用 `error-analyzer.ts:333`、`:361`,控制器未复核)。
- **I-3**:`dev_loop` 校验步 `runVerification` 的 `status` 只看退出码(`src/tools/workflow.ts:828-831` 一带),会出现 `status: 'passed'` 加 `error_count > 0`;同函数 `:820` 超时快照只留 stdout,`:823` 用 `includes('Error:')` 判 spawn 失败,匹配不到 `SPAWN_FAILED:`。
- **I-4 `edit_script` 回滚路径复活后的误回滚面**(影响面最大的一条):全新或从未导入的项目没有 `.godot/global_script_class_cache.cfg`,引用 `class_name` 的脚本会被回滚,而 `auto_validate` 默认开;另有 `<filtered>` 条目被报成「Godot unavailable」、依赖脚本出错时连带回滚、回滚文案没有行号(审查者引用 `src/tools/script/edit.ts:277` 的正则与实际错误串不匹配,控制器未复核)。
- **I-5 测试缺口**:「多批只有一批失败」没有用例。
- **文档与规则双副本订正**:`AGENTS.md`「改动 GDScript 后」一节、`CLAUDE.md`、`.claude/rules/godot-mcp-core.md`、`.claude/rules/godot-mcp-engine-quirks.md`、`.claude/rules/godot-mcp-workflow-verify.md`、`src/tools/rule-templates.ts`、`README.md` 里「validate_scripts 逐文件 parse、抓不到块缩进」的表述在本批后不准确(审查者清单,控制器未逐处复核)。按 `AGENTS.md`「独立副本同步约束」须两处同步并 bump 版本,适合单独成批。

## 五、Nits 与 Advisory

**已在本批顺手处理**:

- N-1 `batchValidateScripts` 的「errors 优先」守卫从未生效(判断早于归因):改为组装时 `errors.length === 0` 才挂 load-null 警告(`src/tools/validation.ts:400`),有测试。
- N-2 summary 把脚本错误数与校验器失败数分开写;未校验的脚本条目带 `validated: false`;`create_files` 的同名字段形状与 `validate_scripts` 对齐。
- N-3 一处不准确的注释已订正。
- N-5 autoload 过滤用例补了「确实读到并过滤」的断言(`<filtered>` 条目与 `filtered_count`)。
- A-2 真机用例的 `timeout` 由 30 调为 10(原先校验器超时与用例超时同为 60 秒,余量为零)。
- A-4 `test/script-editing-mock.test.js` 的死替身与过期注释已清。
- **既有用例订正**:同文件「validate scripts」用模块替身替换 `validation.js` 导出的 `batchValidateScripts`,但 `validate_scripts` 在模块内部直接调用真函数,替身管不到;用例一直在拉起不存在的 Godot,靠旧实现丢弃 `<validator:spawn>` 才通过。现把替身下沉到 `spawnGodot` 并加 `incomplete` 断言。独立审查者复核:文件级替身不改变同文件其它用例的行为。

**未动,记录**:

- A-3 B-1 的回归锁只在 Windows 上有区分力,CI 主 vitest 跑 Linux 抓不到,靠本地 Windows 全量把关。
- A-5 `runSingleVerify` 没有像 `run_and_verify` 那样传 autoload / class_name 符号集。
- A-6 `spawnGodot` 对 stderr 有 100KB 截断且无 incomplete 标记(`src/tools/spawn-helper.ts` 的 `maxOutput`)。
- A-7 `create_files` 对只有 `headless_limitations` 的条目仍是静默丢弃。
- A-8 `validation.ts` 里原先那个从未生效的守卫代码还留着(已有注释说明)。
- N-7(GUI 版 exe 的 stderr 能否到达管道)经控制器反证关闭:真实 server 取证用的是非 console 的 exe 路径,stderr 的错误行照常到达;审查者认可。

## 六、验证证据(控制器实跑)

- **红绿**:同批 7 个测试文件 99 例,临时还原三处源码后 `13 failed | 86 passed`,变红的正好是全部新增回归用例;恢复后 `99 passed`。
- **真机**(Godot 4.7.2 与 4.6.3):坏脚本(未闭合括号 / `else` 块缺缩进 / 未声明变量)全部归因,修复前 `batchValidateScripts` 返回 `[]`;有类缓存的项目里引用 autoload / class_name 的脚本零误报;无类缓存的全新项目里引用 `class_name` 的脚本报 `Identifier "PlayerStats" not declared` 及其连带的类型推断错误(项目状态的真实反映,见 CHANGELOG 行为变化须知②)。
- **真实 server**(`build/index.js`):含死循环脚本的项目(25s 超时)由 `validated: 3, total_errors: 0` 变为 `validated: 0, incomplete: true`、`validator_failures` 列出未校验的三个脚本;含运行期错误的场景 `run_verify` 由 `passed: 1` 变为 `failed: 1`。
- **门禁**:`npm run lint` 0 errors / 533 warnings(=上限),`tsc --noEmit` 与 `npm run build` 通过,`check:test-quality` 785 ≤ 860。`npm test` 在最终代码上 3 轮:2 轮 `553 文件 537 passed / 16 skipped、8405 用例 8307 passed / 98 skipped / 0 failed`,1 轮 2 例失败在未改动的 `test/gdscript-executor-audit-runtime.test.js`(单跑 3 passed),按风险假设登记为 `docs/flaky-watchlist.md` 的 FLAKY-007。
- **局限**:独立审查者未复跑;`/verify` 的测试项因选测基线问题恒为 `TOO_BROAD`,测试证据全部来自手动全量。

## 七、行为变化须知

见 `CHANGELOG.md` 同名条目的「行为变化须知」四条,其中与日常使用最相关的是:`edit_script` 自动验证此后会对真实 Parse Error 回滚编辑;全新或从未导入的项目先导入一次再校验。

## 八、工程教训

- 修「静默假通过」要沿数据流走到最终输出层(`batchValidateScripts` → `errorMap` → `scripts[]`),只修到中间函数会在最后一公里丢掉;真机取证要走工具层并用子目录脚本。
- 同一个相对路径在相邻函数里用不同归一化(`stripProjectPrefix` 正斜杠、`relPathOf` 反斜杠)做 Map 键,而 CI 只跑 Linux,Windows 分支永远测不到。
- `vi.mock` 替换的是模块导出,管不到模块内部的直接调用;替身要下沉到被调用方自己依赖的那一层。
- 让一条死分支复活前,先审它所有下游消费方(`create_files` 的 `relPathOf` 对相对路径抛异常)。
- 替身夹具的流布局必须跟随真实进程(stdout / stderr 分流),并保留一条真机用例。
- 把「根因归因」写进规则文档前先验证:2026-08-01 的「validate_scripts 盲区」很可能是 C-1 的症状。
