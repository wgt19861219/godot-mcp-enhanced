# 2026-09-30 daemon 批 A(feat/daemon-core)— 批级第三方审查

> **审查者**:code-reviewer 子代理(跨任务视角 + 仓库级约束独立 grep,不采信实施报告声明)
> **审查对象**:commits `14a20a1c..70b167c1`(6 commits:spike/transport 参数化/WebGuiServer 三注入/mcp-endpoint 双闸门/daemon 进程入口/plan 回写)
> **单任务审查**:Task 1-5 已逐个过 task reviewer(全 Approved/SHIPPED),本文为批级补充视角
> **总体判定**:**SHIPPED WITH NITS**(0 Blocking;1 Important + 3 Nit,处置记录见文末)

## 逐维度结论(审查者原文要点)

1. **批整体结构 — 通过**:六 commit 接缝一致(processMode 命名链/mcpHandler 签名链三方逐字一致/strictPort 消费链/createMcpEndpoint↔main.ts 两段式接线);`src/daemon/` 双文件建目录符合「src 目录分组规则」;eslint 分层门禁仅限 src/core|tscn,daemon 不受限;**grep 实测 `src/web-gui/` 下零 MCP SDK import**(分层红线兑现)。
2. **仓库级约束(独立 grep)— 全部合规**:`.claude/rules/`/`rule-templates.ts`/`src/tools/`/`src/capability/` 零触碰——不触发 rules-sync/bump、不需 build-matrix;CHANGELOG 归批 C Task 13 与 check-changelog-sync 脚本逻辑兼容(advisory + 按版本日期后 commit 比对,批 C 一次补登涵盖批 A 的 4 个 feat commit);覆盖率:main.ts 组装段约 90 行零单测,全局稀释后不破阈值线,批 C 补。
3. **spec 落位 — §3.2/§3.3/§3.4/§3.10 良好;§3.5 双闸门安全面扎实**(query token 401/cookie 401/401 不回 token 值/Host 伪造 403 全有测试实证;timingSafeEqual 恒定时间)。缺口:401 拒绝未落审计(N-1)。
4. **批间风险 — 已知 4 项全部有书面承接位**(ledger progress.md),无新增失位;新输入:main.ts:112 保活 setInterval 不 unref,批 B 组装段单测若真跑 runDaemon 会挂测试进程,需 fake 化。
5. **SDD 过程 — 通过**:TDD 红灯证据在档;commit 粒度合规;测试隔离干净(mkdtemp/env save-restore/避开自愈端口段,无 cwd 副产物);index.ts IIFE 守卫影响面干净(test/ 与 dashboard/ 零 import index.js)。

## Nits(→ 处置)

| # | Nit | 置信度 | 处置 |
|---|-----|--------|------|
| N-1(Important) | /mcp 401/403 拒绝未落审计——spec §3.5"失败落审计"明文,mcp-endpoint.ts 401 分支零审计调用;plan 覆盖对照"无缺口"声明失真 | 85% | ✅ fix `b8e6a3d2`:401/403 各落 appendMachineAuditLine(caller `daemon:mcp`,action `mcp-auth-reject`/`mcp-host-reject`,details `{error,hasAuth}` 不含 token 值/Host 原文,best-effort);+2 用例 TDD(vi.mock 模块 spy,getMachineAuditFile 无注入点不真写机器审计流) |
| N-2 | ServerOptions.processMode/mcpHandler 死字段(实际差异走工厂路线,字段声明后零消费,误导接口面) | 95% | ✅ fix `b8e6a3d2`:两字段+JSDoc+专用 import 删,main.ts 传参与测试引用清(grep 全仓 .ts 零 processMode 代码引用);WebGuiServerOptions.mcpHandler 真消费面未动 |
| N-3 | DaemonStartupGateDeps.port 死参数 | 100% | ✅ fix `b8e6a3d2`:字段与传参删(runDaemon 内 port 真消费保留) |
| N-4 | main.ts 组装段约 90 行零单测(覆盖率风险) | 90% | 📌 defer 批 C(真机验收 V1-V8 + 补覆盖,ledger 已记) |

**fix 波次复审**(scoped re-review):N-1/N-2/N-3 全 ADDRESSED,fix diff 零新破坏(vi.mock 文件级隔离/401/403 响应行为逐字未动/真消费面无误删)——**可合回**。

## 值得进 memory 的工程教训(审查者提炼)

**spec 覆盖对照的"节号打勾"会漏句内次级义务**:§3.5 的"失败落审计"是双闸门主句后的次级要求,plan 拆任务按主句建测试块,次级义务无声丢失,且 plan 尾部"Self-Review 无缺口"为它背书——覆盖对照应逐句拆 spec 条目,不能按节号打勾(2026-07-27 final-review 教训的变体)。

## 验证证据

```
批 A 门禁(控制器亲跑):npm run lint 0 + build 通过 + npm test 474 files / 7034 passed / 0 failed
fix 波次:npx vitest run test/web-gui/ 27 文件 302 passed + lint 0 + build 0;N-1 TDD 红(2 用例 got 0 times)→ 18/18 绿
真机冒烟(Task 5 报告,6 项):import 干净退出/index 守卫放行/env=0 拒启 exit 1/真起 daemon 保活+kind 登记+端口顺延/401×2+initialize SSE 全通/health ok
```
