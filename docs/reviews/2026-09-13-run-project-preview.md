# 2026-09-13 run_project 预览模式 — 最终全分支审查报告

- **分支**:`feat/run-project-preview-mode`(8 commits,`a2034070..24c3e314`)
- **审查者**:最终全分支 code-reviewer 子代理(独立隔离上下文,所有声明实跑/实读验证)
- **前置**:设计文档 `docs/superpowers/specs/2026-09-13-run-project-preview-mode-design.md`(含设计轮第三方审阅 B-1 记录);实施计划 `docs/superpowers/plans/2026-09-13-run-project-preview-mode.md`;五个任务各自通过任务级审查(报告见 `.superpowers/sdd/task-N-report.md`)
- **总体判定**:**READY WITH FOLLOW-UPS**(无 Critical/Important;9 条 Minor 均不阻塞 merge;真实弹窗验收待用户闭环)

## 功能摘要

`run_project` 新增 `preview` 参数(禁自动停止、游戏窗口常驻至用户关闭)+ 输出快照机制(运行结束后 `get_debug_output` 仍可查错,`source: "last_finished_run"` 标注,顺带修复 `stop_project` 报告恒空现存 bug)+ 规则模板双副本「视觉改动收尾流程」+ 版本链 0.33.2。

## 验证证据链(最终 reviewer 实跑)

| 命令 | 结果 |
|------|------|
| `npm run build` | 成功 |
| `STRICT=1 npm run check:rules-sync` | 9 个模板双向对账一致,exit 0 |
| `node scripts/check-rules-version-bump.mjs` | exit 0 |
| `npm run version-check` | 版本元数据一致 (0.33.2),exit 0 |
| `npm run diff-matrix` | no drift,exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | 6379 passed / 2 failed(`test/integration/ui-layout-integration.test.ts` 真实引擎超时用例,单跑 7/7 通过,并发资源争抢 flaky,与本批零交集,P4 批 memory 有同案记录) |
| `npx vitest run test/process-state.test.js test/runtime.test.js` | 117/117 passed |

## 跨任务一致性(逐环节验证成立)

1. **快照闭环(Task 1 产出 ↔ Task 2 消费)**:真实 ctx 直通 process-state 单例(`src/core/ToolDispatcher.ts:107-110`);换窗时序 Stop existing(`src/tools/runtime.ts:169-173`)→ `setRunningProcess(null)` 触发 stash(`src/core/process-state.ts`,buffer 非空→快照)→ `clearOutputBuffer()` 空守卫不覆盖刚存的快照。
2. **规则文案(Task 3)↔ 实际行为(Task 1+2)**:source 字段值、wait_for_bridge 闪窗、换窗留档、禁用自动停止——逐条与源码吻合。
3. **CHANGELOG/README(Task 4)↔ 实现**:stop_project bug 描述与修复方式准确。
4. **生成产物(Task 5)↔ src**:preview 描述三方逐字一致(runtime.ts == capability-matrix.json == docs/tools/runtime.md);`diff-matrix` no drift;game.md 3 处描述连带对齐系 0.33.1 批漏再生成滞留,合法。
5. **既有消费方零破坏**:bridge-session/qa 不传 preview,timer 条件与非 preview 文案对默认路径逐字不变;qa 的 `'Bridge ready'` 大写判据不受 preview 小写文案影响;stop_project/get_debug_output 输出变化无程序化消费方。

## 仓库级硬约束(逐条 ✅)

独立副本同步(实跑 STRICT 通过)/ 版本链 7 文件 0.33.2 / 生成产物不手改(diff-matrix no drift)/ 分层约束(process-state 未新增对 tools 的 import)/ TypeScript strict·禁 any·ESM .js(lint 全绿)。

## Minor 清单与 triage

| # | 事项 | 处置 |
|---|------|------|
| 1 | stash 自身截断分支(仅 setOutputBuffer 直塞>5000 可达)无测试 | merge 后跟进(低优,生产无该路径) |
| 2 | getLastFinishedRunOutput 返回内部引用 | 记录即可(与 getOutputBuffer 同惯例,消费方只读) |
| 3 | 弱断言 `not.toContain('timeout: 40s')`(实际 timeout=30,源自计划简报) | merge 后跟进(改 `not.toContain('timeout:')` 一行) |
| 4 | preview+wait_for_bridge 失败分支无测试(设计 §4.3 承诺未落地) | merge 后跟进(与 #3 同区补) |
| 5 | CHANGELOG 朴素 `### Added` 风格 vs 近期副标题风格 | 记录即可(官方标准形态) |
| 6 | manifest"248 actions"/README"271 action"存量计数漂移 | merge 后跟进(建议 version-sync 从 matrix 注入计数) |
| 7 | check-rules-version-bump CI 侧不设防(比较 HEAD vs 工作区,checkout 后恒等→恒跳过) | merge 后跟进(issue 级:CI 增加 HEAD vs HEAD^ 形态) |
| 8 | gen:tool-docs 依赖 build-matrix 产物,建议 `gen:all` 串联脚本 | merge 后跟进(一行 script) |
| 9 | 真实弹窗验收未做(单测已覆盖行为逻辑) | **merge 后由用户闭环**:下次视觉改动收尾按规则流程走 run_project(preview=true) → 关窗 → get_debug_output 应见 `source:"last_finished_run"` |

另记录(新发现,记录即可):
- **N-A** 零输出运行继承上一轮快照的误导窗口(触发条件苛刻,空守卫本身是换窗时序正确性依赖,不可简单移除;根治需 clearOutputBuffer 区分调用点,成本收益比不支持现改)。
- **N-B** Dockerfile 引用 `godot-mcp-enhanced@0.33.2`(npm 上尚不存在)——仓库既有 bump-先于-publish 模式,已知发布节奏。

## 工程教训(已登 memory)

1. "HEAD vs 工作区"式门禁在 CI(checkout 后恒等)与"改完即 commit"习惯下恒跳过——硬门禁脚本必须明确比较基线的有效作用域。
2. 快照 move 语义的空守卫是双刃剑:保住换窗时序,同时制造"零输出运行继承旧快照"语义边界——带条件的 move 语义注释要同时写明保护的时序与放过的残留。
3. 计划里的测试断言数学同样要独立复核(6000 行截尾 5000 的首行断言,Task 1 实施者 node 模拟后纠正计划错误)——与设计轮 §7.3"mock 绿≠行为对"构成姊妹条。
