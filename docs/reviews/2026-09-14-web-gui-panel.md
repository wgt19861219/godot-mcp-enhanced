# Web GUI 监控面板批次 — 最终全分支审查报告

- **日期**: 2026-09-14
- **分支**: `feat/web-gui-panel`（18 commits，fb92d460..5d4723aa，基于 `feat/per-project-run-sessions`）
- **审查方式**: Subagent-Driven（11 任务各配独立 implementer + task reviewer，最终全分支独立审查）
- **总体判定**: **READY WITH FOLLOW-UPS**——零 Blocking / 零 Important，跨任务接缝闭环，仓库级约束零违规，安全四层壳完整，门禁四项实跑全绿，真机验收 ACCEPTANCE PASS

## 一、交付内容

spec（v3.1，两轮独立审阅闭环：v1 审 2B+6I+7M → v3 二轮审 3B+4I+8M → 复核 14 PASS/1 PARTIAL）→ plan（11 任务 TDD）→ 实现：

| 子系统 | 内容 |
|--------|------|
| `src/web-gui/server.ts` | WebGuiServer：node:http + SSE（hello 幂等/log 增量帧/快照节流）、token×Origin 四象限鉴权、端口避让（9550 起 20 试）、listen/socket unref、stop 全链清理 |
| `src/web-gui/registry.ts` | per-pid 登记（0o600+0o700+icacls+原子写+探活清死，对齐 InstanceManager S-5） |
| `src/web-gui/html.ts` | 单文件 HTML 四面板（原生 JS 零依赖；token→sessionStorage→replaceState；401 探测停重连；textContent 防注入） |
| `src/web-gui/open.ts` | CLI `dashboard --web`（登记聚合+探活+跨平台 opener+多实例菜单） |
| `src/core/logger.ts` | `LogEntry.srv` 进程标识（5 写点全覆盖）+ `getServerId()` + `todayStr` 导出 |
| `src/dashboard/log-reader.ts` | UTC/本地时区 bug 修复（东八区每日 00:00-08:00 断流） |
| `src/dashboard/aggregator.ts` | per-project 统计 + `entry.project` 死逻辑修复 + 幽灵桶写入侧清理（实测缺陷修复） |
| `src/core/process-state.ts` | `listRunSessionsDetailed()` 只读详单（白名单 9 字段+两态行数，禁惰性建桶） |
| 接线 | GodotServer 起/停（webGuiActive 三态+catch 补 stop 清半激活）、index.ts TUI 决策改造、launcher 双触发点 guard、test/setup.js env 隔离 |

## 二、任务执行与审查记录

| Task | Commit | Review 判定 | 关键事件 |
|------|--------|------------|---------|
| 1 logger srv | 1cf71137 | Approved | defects 基线 80→81 合法联动 |
| 2 时区修复 | 49d125f2 | Approved | TDD 红精准复现 bug；连带修测试 helper 同源 UTC 镜像 bug |
| 3 aggregator | 52699390 + b59c2d90 回流 | Approved | 简报矛盾以测试为规格裁决并回流计划 |
| 4 detailed | f10c6bf0 | Approved | 简报测试序列三处偏差修正全部经审查验证必要 |
| 5 registry | 86a89c81 | Approved | 权限加固同构 S-5 实证 |
| 6 HTTP 骨架 | bf7a7fd2 | Approved | 简报 ??/|| 混用 SyntaxError 被实施者抓出修复 |
| 7 SSE | d59aba91 | Approved | **幽灵桶补强断言实证 Task 3 真实缺陷并顺手修复**（撤修复必红） |
| 8 HTML | 893e237f + 6142c579 | Approved | 安全四底线实证（零 innerHTML 数据注入/零外链/零硬编码 token/401 停重连） |
| 9 接线 | 49c9a2b6 | Approved | 三态时序无竞态推演；半激活清理落地 |
| 10 CLI | e75089fc | Approved | Task 9 交接断言补齐（三态/降级/端口无泄漏/env 门） |
| 11 收尾 | 5d4723aa | Approved | 真机验收 ACCEPTANCE PASS（UTC/本地时间线闭环佐证真实） |

**交接式 Minor 管理的兑现**：19 条任务级 Minor 中 7 条经"→Task N 交接"机制闭环（rotation 测试缺口→Task 2 补、幽灵桶断言→Task 7 补并发现真缺陷、半激活残留→Task 9 补 stop、tautology 用例→Task 10 补正式断言等）。

## 三、最终全分支审查结论（六维度）

- **A 跨任务一致性 PASS**：srv 链路（5 写点→过滤→分组→SSE→前端）全程语义一致；构造器选项与接线传参一致；stop 清理链无死锁无遗漏；前端契约逐字段对齐。
- **B 仓库级约束 PASS**：零 any、ESM 合规、import 方向合法（core 无反向依赖）、无新增模块级 setter（_active/_serverId 均只读导出）、生成产物未动、不触发 rules-sync/version-bump/build-matrix 门禁、新代码纳入覆盖率阈值。
- **C Minor triage**：12 条跟进级（见第四节），无 merge 前必须修项。
- **D 安全终审 PASS**：恒回环（无 host 配置通道）、token 全生命周期闭合（生成→URL 唯一入口→sessionStorage→磁盘 0o600）、Origin 白名单、CSP/nosniff/textContent、SSE 鉴权在路由前；后续任务改动未削弱壳。
- **E 验收覆盖度可接受**：判据 1a/1b/1c/4 自动化锁定；判据 2/3/5 的核心机制均有等效自动化（两态语义/srv 过滤/TUI 契约三重覆盖）。
- **F 测试隔离 PASS**：setup.js env=0 + env-gate afterEach 恢复；端口全随机或自 squat；不写真实 ~/.godot-mcp。

## 四、门禁实跑证据（controller 亲跑，2026-09-14 19:31）

```
npm run lint            → exit 0（eslint src/ 零输出）
npm run build           → exit 0（tsc + .gd/instructions.md/game-templates 拷贝完整）
npm test                → 438 files passed | 14 skipped；6467 tests passed | 81 skipped；Duration 63.87s
npm run check:env-isolation → exit 0（62 条历史存量 warn，无 WEB_GUI 新增条目）
```

真机验收（Task 11 实跑）：判据 1a 登记 pid=34908 port=9550 / 1b HTML 含面板标题 / 1c SSE hello / 判据 4 错 token 401 + 伪造 Origin 403 → **ACCEPTANCE PASS**（脚本 `.superpowers/sdd/web-gui-acceptance.mjs` 可复跑；判据 2/3/5 留人工补跑）。

## 五、Merge 后跟进清单（12 条，多数一至数行改动）

1. `test/web-gui/logger-srv.test.ts:2` existsSync 死 import（1 行删除）
2. `registry.ts` defaultIsPidAlive 补 `pid<=0` 守卫（与 instance-manager 等三处副本统一抽共享）
3. `registry.ts` 死条目按文件名删（异常残留文件清理）
4. `registry.ts` icacls username 异常补 warn
5. 目录不存在返回空数组补直接单测
6. eslint core regex 扩 `(tools|web-gui)`（防御性）
7. CI(UTC) 时区用例退化（已知设计边界，可加 TZ 注入）
8. `html.ts` renderLogs 强制滚底→加用户上翻贴底判断（体验项）
9. Task 10 用例标题 ENOTDIR 措辞改中性（Windows 实际 EEXIST）
10. defaultChoose readline 生产路径补注入式测试
11. `listRegistrations` token 加 `/^[0-9a-f]+$/` 校验（关掉 exec 注入理论残余面）
12. `check-env-isolation.mjs` 正则补 `GODOT_MCP_WEB_GUI`（门禁声明与实际覆盖对齐）

另：人工补跑 `dashboard --web` CLI 端到端真机（defaultOpener 真弹浏览器 + process.exit 与异步 exec 竞态确认）。

## 六、值得进 memory 的工程教训

1. **交接式 Minor 管理**：任务级 review 的 Minor 显式标注"→Task N 必须交接"并在后续任务验收，本批 7/19 条经此闭环（含 1 条真缺陷发现）。
2. **check-env-isolation 正则不自动覆盖新增 env 键**（且 warn-only）：新增 `GODOT_MCP_*` 开关须自查正则 + afterEach 还原。
3. **测试辅助函数镜像 bug 会跟随实现同源**：修实现侧 bug 时凡"复制生产逻辑做断言"的测试 helper 都是同源 bug 藏匿点（log-reader.test.ts todayFile 实证）。

## 七、结论

本批次历经 spec 两轮独立审阅（5B+10I+15M 全闭环）→ 11 任务 TDD（每任务独立审查）→ 最终全分支六维度审查，**READY WITH FOLLOW-UPS**。分支合并与 npm publish/tag 待用户明确指令。
