# 2026-09-30 daemon 专项终审(三批 22 commits)— 第三方审查

> **审查者**:code-reviewer 子代理(终审广域:deferred triage + 三批整体性 + 漏网之鱼;单任务/批级审查已全做过)
> **审查对象**:commits `3de2b15b..bbb82ac9`(整专项,批 A core + 批 B lifecycle + 批 C frontend-accept)
> **总体判定**:**SHIPPED WITH NITS(0 Blocking)——可合入 `feat/web-gui-instance-management`**(两条 Nit 已由 fix `00b30e8c` 处置,见文末)

## deferred triage(终审者裁定)

| 项 | 裁定 | 理由 |
|---|------|------|
| spike 三条 minor | 失效 | 一次性探针已完成使命 |
| Task2 `_opts` 空壳 | 已处置 | 注释定性"有意,长期"(spec m-2 签名要求) |
| GET/DELETE 404 未测 | 留档(可不补) | 三方法同分支,POST 已测等价 |
| N4 main.ts 组装段单测 | **留档(defer 承诺未兑现)** | daemon-main.test.ts 仍仅 gate 用例;行为已被真机 V1-V8+全量覆盖,但自动化防护缺位,后续小批补 |
| 重入守卫 | 留档 | strictPort 保证收敛不破不变式;150ms 窗口极窄,一行可补 |
| POSIX 信号×交接边界 | 留档 | Windows 主平台无此风险(detached 收不到信号) |
| respawnOf 残留 | 已防 | 前端旧 pid 在场性判定闭环 |
| restart 无预检提示 | 已处置 | 注释即裁定记录(非首启语义;死实例分支自动获得) |
| run() 独有功能缺位 | 留档 | orphanScan/stateStore/multi-instance daemon 不跑;建议后续做 daemon-vs-stdio 能力对照表 |
| **工具档位差异** | **fix 00b30e8c 收口** | 原:daemon 兜底 full vs stdio basic、env 不响应、决策悬空、文档零披露 → 已接 env(resolveDaemonToolMode 与生产链同款,basic 兜底)+ 三处文档披露 + 3 用例 |
| 三空格测试副产物 | 留档(非本批引入) | 根因 ToolDispatcher.test.ts:1085;建议审计层对空白 project_path 跳过落盘 |
| N3 审计受控性分裂 | 留档(维持观察) | 两侧各有先例;kill/交接恒写符合"关键动作留痕"哲学 |

## 整体性/漏网/仓库级(终审者结论)

- **接口咬合**:buildWebGuiOptions 工厂等价抽取、mcpHandler 两段式接线、hasLiveSession 与 409 闸门同源、shutdown 端点↔controlledRestart↔CLI 三方签名一致——三批叠加零漂移。
- **spec §3.1-§3.10 终核**:全覆盖;唯一字面缺口(daemon status 缺"交接中"标注,秒级窗口影响小)留档。
- **漏网检查**:killPidTree 对 daemon 进程树(taskkill /T 覆盖)无新风险;settings 热生效与 stdio 同源;daemon 日志无 rotation 留档观察。
- **仓库级**:rules-sync/bump/matrix 三门禁不触发✓;分支策略合规✓;CHANGELOG-代码一致(经 fix)✓;AGENTS.md 强制流程齐备✓。

## Nits(→ 处置)

| # | Nit | 处置 |
|---|-----|------|
| 1 | CHANGELOG `daemon-<pid>.log` vs 实现 `<timestamp>.log` | ✅ fix `00b30e8c`:同步+成因括注,三方一致 |
| 2 | daemon status 缺"交接中"标注(spec §3.7 字面) | 📌 留档:秒级窗口+前端已显示,CLI 收益低 |

## 值得进 memory 的工程教训(终审者提炼)

SDD 多批流水中,implementer 报"concerns 备案、后续批再定"若无 ledger 强制"承接任务号"字段,会被后续批静默漏接(档位差异:task-5 备案 → 批 B/C 均未接 → 终审才收口)。**deferred 项必须绑任务号,不能只写"后续再定"。**

## 验证证据(控制器亲跑,终审采信)

```
门禁:lint 0 / build 0 / npm test 476+ files 7099 passed 0 failed / smoke 72 passed / changelog-sync ✓
真机 V1-V8(ledger 详录):start 就绪(V1 含预检提示,缺口补 bbb82ac9)/401+session+47 tools+call+Host 403 原生确证(V2)/fetch 等价全通(V3,ZCode 真实客户端留用户)/restart 端口 9554 不漂移+终态无双活(V4)/stop 受控退出+登记清零+审计(V5)/409 单会话+DELETE 轮换重建+崩溃残留新鲜期 409 实证(V6)/全量+smoke(V7)/二次 start 拒(V8)
fix 00b30e8c 复审:两条 ADDRESSED 无新破坏(resolveDaemonToolMode 与 index.ts:111-125 字面同链)
```
