# 2026-10-01 web-gui NIT 修复批独立审查

> **审查对象**:web-gui 面板全功能真机验证(`docs/reviews/` 同日验证会话)发现的 4 个 NIT 的修复批,工作区未提交改动 8 文件(4 源码 + 4 测试)。
> **审查者**:code-reviewer 子代理(隔离视角,不预设实现者声明为真;本环境无 Bash,改动面用 Glob mtime + build 产物 grep 交叉验证,断言逐条推演真值)。
> **总体判定**:**SHIPPED**(0 Blocking / 3 Nits,其中 Nit-1 已当场处置,Nit-2/3 记录)。

## 修复内容与根因(四项)

| NIT | 根因 | 修复 | 位置 |
|---|---|---|---|
| favicon 404 | 面板无 favicon,浏览器自动请求 `/favicon.ico` 落 404(控制台唯一 error) | head 加内联 SVG data: URI icon;配套 CSP img-src 加 `data:`(Chromium 将 favicon data: 纳入 img-src 管辖,'self'-only 真机实测报 CSP violation) | `src/web-gui/html.ts:13`、`src/web-gui/server.ts:159` |
| verify stage 漂移 | cmd.exe 对 `--version` 行为非确定(间歇 exit 0 空输出 vs exit 1),godot-finder 落 `version-run-failed` 或 `not-godot-signature` 不定 | settings-api 层 `normalizeGodotStage` 归一为 `not-a-godot-binary` + 稳定文案;godot-finder 原始 stage 不动(ToolDispatcher 等其余消费方零变化) | `src/web-gui/settings-api.ts:35-49` |
| stop 后误显 errored | `markSessionExited` 只看退出码,主动停止链(先 `markSessionStopping` 再 kill)被 taskkill /F 的退出码 1 误归 errored | stopping 态统一归 exited(2s 内 exited_early 判定同被短路);五个调用方(面板 stop/stop_project/超时自停/bridge 清理/覆盖重跑)一次性受益 | `src/core/process-state.ts:401-404` |
| a11y label | DevTools issue 实证报的是**孤立 `<label>` 元素**(aria-label 不被该检查认可):设置面板 3 个无 for 的 label + 7 个表单控件无 label 关联 | 7 控件补 aria-label + `<label for>`(5 个 sr-only + 2 个既有文本 label 加 for);纯样式标题「当前生效(只读)」改 `.set-lbl` span | `src/web-gui/html.ts:52,109,137-176` |

## 审查结论(逐维度,证据为审查者亲读)

1. **stopping 分支正确性 — 通过**:`markSessionStopping` 全部 5 处调用方(runtime.ts:198/278/336/409 + GodotServer.ts:575)语义均为主动停止,归 exited 正确;前置守卫(仅 running/starting 可转)杜绝「已 errored 桶被洗白」;`killAllRunSessions` 走 `stashToSnapshot` 不经新分支,close handler 与其幂等交错无冲突。
2. **html.ts — 通过**:7 控件 aria-label/label-for 双全;全文件 `<label` 恰 7 处全带 for;favicon data: URI 编码正确(`%23` 防 fragment 截断);`.sr-only`/`.set-lbl` 无样式冲突;改动全在静态段,`INDEX_SCRIPT_SHA256` 不变(硬编码 hash 锚测试不受影响)。
3. **CSP — 通过**:仅 img-src 追加 `data:`,其余指令未动;data: 图片在 img 上下文不执行脚本,面板动态内容 textContent 反向锁定。
4. **stage 归一 — 通过**:归一只在 settings-api 层(verify/save);`version-read-failed`(校验通过但读版本失败)不在归一集,原样透传;is-directory/path-not-allowed 透传。
5. **测试质量 — 通过**:4 处断言均可失败(分支回退即红);无既有断言被削弱(runtime.test.js:337 errored 是 spawn 失败路径、process-state.test.js:1070-1073 无 stopping 前置)。
6. **仓库级约束 — 通过**:rule-templates/.claude/rules 未动(无版本 bump 门禁);build/ 已同步(build 产物四处新代码 grep 在位);无工具增删,无需 build-matrix。
7. **验证覆盖 — 匹配**:lint + build + npm test 7122 用例全绿 + 隔离实例真机复验(控制台零 error 零 issue / verify 三连 stage 稳定 / start→stop 后 status=exited)。

## Nits 与处置

1. **GODOT_STAGE_MESSAGES 两条不可达条目**(已处置):version-run-failed/not-godot-signature 文案经 UNSTABLE 集先行归一后不可达——已加回落文案注释(防后人误判死代码),lint+测试+build 复跑绿。
2. **stopping→exited 链路级断言缺口**(defer):状态机分支已有两条可失败断言锁定(分支回退即红),四条真实链路的端到端集成断言留后续批次。
3. **POSIX 对等场景**(备忘):SIGTERM 下 close code=null 原本就归 exited(process-state.ts:407,单测覆盖),仅 Windows taskkill 非零码是真机验证对象;风险极低。

## 工程教训(已登 memory)

- 同一 kill 动作在「主动停止」与「意外崩溃」下的退出码语义必须分层——修复锚在 `markSessionStopping` 前置状态而非退出码本身,是正确分层点。
- 非确定性外部行为(cmd.exe 间歇 exit 0/1)在展示层的正确解法是**消费端归一**,而非改探测器原始语义——影响面最小。
- DevTools「No label associated with a form field」报的是孤立 `<label>` 元素,aria-label 不被认可——修 a11y 前先读 issue 详情定方向,别按字面猜。
