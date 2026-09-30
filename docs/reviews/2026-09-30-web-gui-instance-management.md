# 2026-09-30 Web GUI 面板死锁修复 + 实例管理批 — 第三方审查

> **审查者**:code-reviewer 子代理（隔离视角,所有声明 grep/read 实测,未预设实现者声明为真）
> **审查对象**:工作区未提交两批改动（`git diff` 全量）——①面板死锁修复（批 1）②实例管理批（批 2）
> **总体判定**:**SHIPPED WITH NITS**(3 条 nit,均为注释/死代码级,已全部处置,见文末)

## 批次背景

- **批 1（死锁修复）**:commit `2b9b4efa` 设置批在 `INDEX_HTML` TS 模板字符串内写 `.join('\n')`/`.split('\n')`,TS 求值成真实换行写进内联脚本 → 浏览器 `SyntaxError` → 面板死在"连接中…"。修复双写反斜杠 + vm.Script 语法级防回归。
- **批 2（实例管理）**:面板加 `GET /api/instances`（registry 直读实例清单,version 判新旧）+ `POST /api/instances/restart`（registry 校验 pid 后 killPidTree/自重启走注入）。用户需求"面板要能拉起或重启服务"①落地,②常驻守护进程立专项后续。

## 逐维度结论（审查者原文要点）

1. **设计正确性 — 通过**:restart 端点三重过滤（判型 → listRegistrations 校验 → 404）实证于 `server.ts:531-560`;绝不裸收 pid。自重启时序 `res.end` 同步完成先于 150ms setTimeout,余量充足。killPidTree 双平台语义与前端文案一致。version 向后兼容（旧登记读回 undefined,registry.test.ts:152-158 实证）。
2. **前后端一致性 — 通过**:响应形状与 `renderInstances` 消费逐字段一致;`data-pid` 数字类型链闭合（前端 Number → server `typeof !== 'number'` 拒收）;isSelf 前端 `mePid` 与服务端 `me` 双保险。
3. **仓库级约束独立核查 — 通过**:core→tools 零命中;onSelfRestart/isPidAlive 均构造器注入非模块级 setter;rule-templates/.claude/rules 未触碰（grep 零命中,不触发 bump 门禁,0.33.9 不 bump 合规）;build 由 npm run build 产出非手改;**html.ts 内联脚本区零单写反斜杠**（全量正则扫描,批 1 同款 bug 不存在）;CSP 锚三方互证自洽（锚值=五次重锚值=独立重算值）。
4. **测试质量 — 通过**:TEST_PID=999999 probe-then-run 防御真实有效（mock 绕过探活后若误占真实进程会误杀,先探测才跑）;自重启 300ms 等待余量充足;审计用例 HOME/USERPROFILE 双 stub + finally unstubAllEnvs 完整;vm.Script 防线在批 2 开发中真实拦截一次再犯（confirm 文案初稿单写反斜杠 n）。
5. **验证完整性 — 声明相容**:审查者环境无 Bash,无法重跑全量测试;静态可复核项全部吻合。真机验收项有单测等价覆盖。
6. **安全审查 — 通过**:滥用面足够窄（token 持有者只能杀 registry 内本机 godot-mcp 实例;token 为 0o600 本地凭证,同用户本机恶意进程本可直接 taskkill 任意进程,无新增攻击面）;TOCTOU 毫秒级理论窗可接受;响应无 token 外泄;审计成功与 404 均落机器级 `web-gui:instances`;confirm 文案不超售。

## Blocking Issues

无。

## Nits（审查者提出 → 处置记录）

| # | Nit | 置信度 | 处置 |
|---|-----|--------|------|
| 1 | CSP 重锚注释链缺第五次条目（注释停在四次,锚值已是五次值） | 90% | ✅ 已补 `server-http.test.ts` "实例管理批 (2026-09-30) 五次重锚"注释 |
| 2 | `GodotServer.ts:649` 注释承诺"兜底 exit(1) 防 close 悬死"但代码无 exit(1),`.catch` 只兜 reject 不兜 hang | 85% | ✅ 改注释如实描述（"close settle 后 exit(0),理论悬死窗接受——close 链各步 best-effort 有界,极端由客户端杀进程兜底"）;不加超时兜底（简约:悬死为理论窗,实际 close 链有界） |
| 3 | `audit-helper.ts:20` subsystem 联合 `'instances'` 无消费方（实例操作实际直调 appendMachineAuditLine 绕开该联合） | 82% | ✅ 加注释标注"预留扩展"并写明不走本函数的原因（projectPath 语义绑定 + existsSync 守卫丢弃空路径成功调用）;保留联合值给未来涉项目的实例类操作 |

## 诚实边界

- **自重启真机路径未实测**（保留 28416 实例给用户当可用面板）——审查者评估**可接受**:注入点接线已测（200 + onSelfRestart 被调）、注入实现静态审查通过（close 完整清理链 → exit(0),对齐 gracefulShutdown 语义）、close() 为既有成熟链路。建议后续真机补一次"重启本实例",核对登记文件随退出被删。
- **ZCode 重连行为实测结论:90 秒内不自动重连**（杀 19648 后无新进程顶上）——confirm 文案按"需手动重连"告知,与实测一致,不超售。
- **遗留（非本批引入,如实记录）**:`[check-ssot-params] ✗ 1 处漂移: ui(src/tools/ui/index.ts): handler 读取 args 键 'name' 但 inputSchema 未声明`——ui/index.ts 最后改于 2026-09-20（commit 26cf1e6b）,不在本批改动列表;该检查为 console 警告不阻断测试。建议另开小批处置（修 schema 或进 allowlist）。

## 值得进 memory 的工程教训（审查者提炼）

1. **模板字符串内嵌浏览器 JS 的转义层级陷阱**:TS 求值一次 + 浏览器 JS 解析一次 = 两层转义;此损坏形态 CSP hash 自洽放行（同源求值）、子串契约拦不住,唯 vm.Script 编译级检查可拦——防线已在批 2 开发中真实拦截一次再犯。
2. **注释承诺的防御必须与代码互证**:"注释声称有兜底"的点应 grep 实现而非采信注释（Nit-2 即此类:注释说 exit(1),代码没有）。

## 验证证据（实现者,处置 nit 后复验）

```
npm run lint  → 0 problems
npm run build → 通过（build 产物含 instances/restart 3 处,非手改）
npm test      → 471 files / 6999 tests 全绿(93 skipped 环境相关既有项)
真机验收      → 实例区 5 行(4 早期实例+1 当前 v0.33.9·本实例标记)/
                重启 24528 → 进程退出+registry 惰性清/
                越界 pid=4(System 进程) → 404 拒杀/
                ZCode 90s 不自动重连实测
```
