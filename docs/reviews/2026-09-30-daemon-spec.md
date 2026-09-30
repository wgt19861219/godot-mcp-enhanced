# 2026-09-30 常驻守护进程 spec — 第三方审查

> **审查者**:code-reviewer 子代理(隔离视角,不预设 spec 作者声明为真,全部声明 Read/Grep 实测;SDK 导出核对 `node_modules/@modelcontextprotocol/server/dist/index.d.mts`;ZCode config 已读仅确认形态,凭证不入报告)
> **审查对象**:`docs/plans/2026-09-30-daemon-spec.md`(草案,未实现)
> **总体判定**:**NO-GO**(修 B-1~B-3 后可转 plan)
> **处置记录**:见 spec 文末 §8(3 Blocking + 5 Nit 已全数处置)

## 逐维度结论(审查者原文要点)

1. **事实表 F1-F13:基本全部成立**。F1 ✓(config 存在多条 `type:"http"` 条目且支持自定义 headers;另有 localhost 形态条目但 `enabled:false`,不能算 localhost 已实证——spec R2 如实标注,诚实);F2 ✓(`index.d.mts:605` declare class、`:738` export 列表含 `WebStandardStreamableHTTPServerTransport`/`PerRequestHTTPServerTransport`/`InMemoryTransport`;依赖为 `@modelcontextprotocol/server` ^2.0.0,package.json:79——AGENTS.md 写的 `sdk ^1.29.0` 已过时,spec 正确);F3 行号准但方法名误(见 N-4);F4 ✓(server.ts:45-84 构造器注入十余点,零 setter);F5 ✓(registry.ts:17-26,parseRegistrationFile registry.ts:161 不校验 version——处置时 grep 勘误,原报告写 164);F6 ✓(GodotServer.ts:866;restart 接线 server.ts:559);F7/F8/F9/F10/F11 ✓(recoverPanel 实证 html.ts:1222-1227 扫 9550..9569);F12 ✓;F13 ✓(index.ts:25-80——处置时 grep 勘误,原报告写 37-79,spec 初稿 38-80 同源有偏,已同步修正)。
2. **设计自洽性:不过关**。三处硬矛盾见 B-1/B-2/B-3。其余自洽:§3.3 面板必起校验与 GodotServer.ts:575 现状吻合;§3.6 单会话与 SDK stateful 模式 `onsessioninitialized` 回调(index.d.mts:475-476)兼容;R1 对 Web Standard Request/Response 适配层的风险描述准确(server.ts 现为 Node req/res 形态)。
3. **方案裁定:合理**。B 否决理由成立(面板数据源全为进程内注入,F4 实证,跨进程化成本判断准确);A→C 增量演进论证成立;A 首期"单会话共享"代价声明诚实(§2/§3.6)。
4. **仓库级约束核查:§0.5 结论全部复核成立,有少量漏列**。eslint 门禁实证(eslint.config.js:30-35,core 禁 import tools/web-gui,daemon 放 src/daemon/ 合法);check:command-docs-drift 是 GD docs↔TS schema 校验(scripts/check-command-docs-drift.mjs:2-3),新 CLI 子命令不触发,§0.5 未列它是对的;check:modules-sync/build:skills 不触发 ✓;漏列:覆盖率阈值(vitest 强制,新增约 6 文件须配套用例)、test 文件落位惯例(实为 `test/web-gui/` 子目录)。见 N-5。
5. **改动面完整性:两处漏项**(N-1 CSP 锚、N-3 mcpHandler 透传)。README/docs 行已列;check:command-docs-drift 无关,不漏。
6. **风险清单:R1-R8 覆盖面好,但漏了 B-2 的 registry 双 daemon 并存窗口**(R5 只提端口漂移)。
7. **验收标准可测性:大体可测**。V2 可用 SDK client 脚本自动化;V6/V8 可自动;V7 的"本会话工具即回归证明"不可复现(N-4);V5 测不出 close 链是否真执行(B-3 修法内含)。
8. **安全:§3.5/§3.9 主干够**(/mcp 强制 token + 127.0.0.1 + 审计,auditInstanceAction 实证 server.ts:504-512 走 appendMachineAuditLine;respawn token 不变成立——registry.ts:43-48 机器级共享设计)。缺口见 N-2。

## Blocking Issues

| # | 问题 | 证据与修法 |
|---|------|-----------|
| B-1 | **端口漂移直接推翻 G3"P2 根治"主张,F11 兜底被错误外推到 MCP 客户端**(置信 90)。§3.7"先 respawn 后退出"→ 新 daemon 起 WebGuiServer 时旧进程仍持有端口(server.ts:101-102 从 9550 递增)→ 新 daemon 大概率漂移到 9551。浏览器面板有 recoverPanel 扫描兜底(html.ts:1222-1227),**MCP 客户端没有**——`type:"http"` 配置是静态 URL(ZCode config 实测形态),不会扫 9550..9569。漂移即 V4"ZCode 重连后工具调用恢复"永久失败 | respawn 序列改为"旧进程先关 HTTP listener(不 exit)→ spawn 新 daemon 并显式传 `--port=<旧端口>` → 新实例登记确认 → 旧进程 exit",牺牲秒级可用性换端口稳定;spec 须改写 §3.7 并同步 G3/V4 措辞("端口不漂移为不变式"而非"前端自愈兜底") |
| B-2 | **§3.1/§3.4 单例检测与 §3.7 respawn 交互未定义**(置信 85)。§3.4"单例检测 = registry 内 kind=daemon 且探活",但未写检测在哪层执行:若在 daemon 进程入口,respawn 时旧登记必然在场(先 respawn 后退出)→ 新 daemon 自我拒绝,respawn 死锁;若只在 CLI 壳,则绕过 CLI 直接跑 `node build/daemon/index.js` 可起多实例,且 respawn 期间 registry 出现**两条活 daemon 登记**(前端实例区双行、`daemon status` 双报) | spec 须明确:检测执行位置、respawn 豁免通道(如 `--respawn-of=<旧pid>` 旗标)、双登记窗口的处置(如 respawn 登记带 replacing 标记或旧进程 close 前先删自身登记) |
| B-3 | **Windows 上"优雅信号"路线不成立,仓库自己的先例注释直接证伪**(置信 90)。§3.1"daemon stop:registry 找活 daemon → 优雅信号 → 超时兜底 killPidTree"。Node 在 Windows 上 `kill(pid,'SIGTERM')` 直接 TerminateProcess、不跑信号 handler/exit hooks;detached 进程无控制台,SIGINT(Ctrl+C 事件)也收不到。本仓实例管理批已实测并写进注释:`src/web-gui/server.ts:554`"**Windows 无跨进程优雅信号(taskkill /F /T 是唯一可行)**"。后果:daemon 的有序 close(stateStore flush、in-flight 清理、GodotServer.ts:866 链)在 stop 时不执行,§3.1 图步骤 5"信号处理:有序 close"落空;且 V5 只查"进程退出+registry 清+无孤儿",强杀也能过,验收掩盖问题 | stop 主路改走 HTTP 关停端点(如 `POST /api/shutdown` 带共享 token,复用现有基建与 onSelfRestart 同款 close 链),信号仅作非 Windows 辅助;V5 增加"日志含 close 链完成证据"验收点 |

## Nits

| # | Nit | 处置 |
|---|-----|------|
| N-1 | §4 `html.ts` 行漏 CSP 锚重算义务。`test/web-gui/server-http.test.ts:86,92` 硬编码锚值+独立重算互证,已有五次重锚史(:73-85);kind 徽标/会话占用展示必改 INDEX_HTML 内联脚本 → 第六次重锚+双通道互证流程,改动面清单应列明 | spec §4 补列 |
| N-2 | /mcp 鉴权未写明**仅认 Authorization header、明确拒绝 cookie**。面板与 /mcp 同源同端口,浏览器同源 fetch 自动带 cookie——若实现顺手复用面板 cookie 校验,DNS rebinding 恶意页面即可带 cookie 获得完整工具面(任意 GDScript 执行)。另建议 Host 头白名单校验,SDK 有现成导出(`validateHostHeader`/`localhostAllowedHostnames`,index.d.mts:166-170) | spec §3.5 补两道闸 |
| N-3 | mcpHandler 注入链与现实结构冲突:WebGuiServer 在 `GodotServer.run()` 内部构造(GodotServer.ts:577-655),daemon 入口无法直接注入,须经 GodotServer options 透传;§4 GodotServer.ts 行应补"mcpHandler 透传通道"改动,否则实现批要么复制十余个注入点(违背 F4 主张)要么返工 | spec §3.2/§4 修正注入链 |
| N-4 | F3/§3.3 把 `GodotServer.ts:543-544` 所在方法称为 `connect()`,实为 `run()`(内部有 `this.server.connect(transport)` 调用,实质成立,措辞应修正);§3.1"exit code 对齐 qa.ts(0=running)"——qa.ts:135 实为 0=PASSED,语义仅可类比;V7 的"本会话工具即回归证明"不可复现,应只留 smoke+既有 stdio 测试 | spec 三处措辞修正 |
| N-5 | §0.5 漏列覆盖率阈值义务(statements 76%/branches 67%/functions 80%/lines 77%,CI 强制)与测试落位惯例(`test/web-gui/` 子目录);均 plan 批可补,记录在案 | spec §0.5 补两行 |

## 值得进 memory 的工程教训(审查者提炼)

1. **"兜底机制的外推要区分客户端类型"**:浏览器面板的跨端口自愈(扫 9550..9569)不能外推给配置静态 URL 的 MCP HTTP 客户端——同一"重连"词下两类消费者能力不同(daemon spec B-1 根因)。
2. **Windows 跨进程优雅停止是持久盲区**:本仓已两次踩(instance-manager 的 taskkill 注释、本 spec 的"优雅信号")——凡是"detached 常驻进程 + 有序清理"设计,停止通道必须走 IPC/HTTP,不能假设 POSIX 信号语义。
