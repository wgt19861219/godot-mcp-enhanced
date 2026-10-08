# 「入口页根治批」独立审查报告(2026-10-08)

> 审查者:code-reviewer 子代理(隔离视角);审查对象:工作区未提交改动中的入口页根治批(3 文件:`src/web-gui/portal.ts`、`src/web-gui/server.ts` 三处 preferredPort 透传、`test/web-gui/portal.test.ts`)。
> 背景:file:// 入口页自动跳转原挑 `found[0]`(第一个活实例),9550 旧实例常驻时新实例永远轮不到(真机验收发现"重启了面板看不到更新")。

**审查方式声明**:审查环境无命令执行工具,vitest/tsc 未实跑,结论基于静态读码 + grep 行号实测;实现者的验证声明由主会话补跑背书(见文末)。

## 总体判定:SHIPPED WITH NITS → **NIT-1 已修,SHIPPED**

无 Blocking 问题。原 1 条 Nit(server 级透传缺行为级测试锚点)审查后已补。

## 逐点结论

### 1. 模板注入安全 — 通过(PREFERRED 注入面为零)

- `portal.ts:24-25`:`safeToken` 受 `SHARED_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/`(registry.ts:47)限制,字符集不含 `<`/引号/反斜杠,`</script>` 逃逸源头即不可能;再经 `JSON.stringify` 二次兜底。
- `safePort` 校验完备:`Number.isInteger` 滤 NaN/Infinity/小数;`> 0` 滤 0/负数/-0;`< 65536` 滤越界。测试 `portal.test.ts` 的 `[0, -1, 70000, 1.5, Number.NaN]` 覆盖全部 false 分支。
- 插值 `JSON.stringify(safePort)` 对 number 只输出十进制字面量,无注入面。

### 2. 挑选逻辑正确性 — 通过

核心:`var target = (PREFERRED && found.indexOf(PREFERRED) !== -1) ? PREFERRED : found[found.length - 1];`(portal.ts:83)

- PREFERRED 死 → indexOf -1 → 回退最大端口 ✓
- PREFERRED 未内嵌(0)→ `PREFERRED &&` 短路 → 回退 ✓
- PREFERRED 段外(如 8577)→ 扫描段 9550-9569 物理看不见 → indexOf -1 → 回退;若为唯一实例则 found 空 → dead 分支(既有行为)✓
- found 有序性:probes 升序构造 + Promise.all 保序 + filter 保序 → `found[len-1]` 确为最大端口 ✓
- ★ 标注(`found[i] === target`)与跳转(`location.replace(... target ...)`)同源同一变量,结构性一致 ✓
- 设计自洽加分:顺延语义存在空洞情形(9550/9552 活、9551 空时新实例占低位 9551,"最大端口=旧实例"回退会挑错)——preferred 机制恰好补此盲区(新实例必写自身端口);回退只在 preferred 失效窗口兜底,两层互补。

### 3. server.ts 三处透传时机 — 通过(无 portValue=0 窗口)

- 赋值链:`server.ts:253` listen resolve 后同步赋值;全失败时 :260 throw 不会到达 :275。三处透传点(start :275 / refreshProjectEntries :1333/:1339 / scan/add 回调)均在监听启动后。
- `portStart:0` 随机端口:`address().port` 返回 OS 实际端口(必非 0)→ 正确内嵌。
- 双保险:假想 0 传到 buildPortalHtml 也被 safePort 退化为无偏好。

### 4. 调用方兼容 — 通过(CLI/rotate 清 preferred 属已声明边界)

- `open.ts:55` / `registry.ts:111` 不传可选参,类型/行为兼容;重写为无偏好版 → 回退最大端口。rotate 本身伴随实例重启(重启即写回 preferred),降级方向安全。portal.ts:21 注释已涵盖该边界。

### 5. 测试质量 — 通过

- portal.test.ts:PREFERRED 内嵌/挑选表达式源码契约锁/`not.toContain("found[0] + '/'")` 防回退/ensureXxx 函数级透传/非法值防御,均行为敏感非恒真。源码契约锁写法有 server.ts:358 M-1 先例,作防回退锚点有效。
- ★ 断言与源码 `\u2605` 不矛盾:模板字面量求值时转义已解释为实际 ★ 落盘。

## Blocking Issues

无。

## Nits

- **NIT-1(审查时提出,已修)**:server 级透传缺行为锚——若未来删掉 `server.ts:275` 的 `this.portValue` 实参,现有测试全绿不拦。**处置:已补 `test/web-gui/server-http.test.ts` 用例(startCtrlServer 后断言 registryDir/portal.html 含 `var PREFERRED = ${srv.port};`,顺带锁定随机端口路径),补后全量 7185 passed。**

## 值得记录的教训/观察

1. **扫描段双处硬编码漂移风险(pre-existing)**:`portal.ts` 的 9550/9569 与 `server.ts` 的 `DEFAULT_PORT_START/PORT_ATTEMPTS` 无单一来源约束,当前一致(9550+20-1=9569);将来调参需两处同步,portal.test.ts 字面量断言锁不住跨文件一致性。
2. **双保险插值模式可复用**:类型约束 + 运行时白名单校验 + JSON.stringify 兜底,三层叠加使 HTML 内联 script 上下文注入面收敛为零,且非法输入退化方向(无偏好)安全幂等。
3. **preferred 的非对称写入是设计而非缺陷**:有实例上下文的写方内嵌,无上下文的重写方清空,配合"回退挑最大端口"在顺延语义下与 preferred 多数收敛——降级路径安全,无需为 CLI 层反向探测补上下文。

## 验证补跑(主会话,2026-10-08)

```
$ npx vitest run test/web-gui/server-http.test.ts test/web-gui/portal.test.ts → 57 passed
$ npm run lint → 0 违例;npm run build → exit 0
$ npm test → Test Files 481 passed | Tests 7185 passed | 93 skipped
```

端到端(实现者已跑,node 模拟浏览器环境执行入口页脚本):五活实例(9550/9551/9552/9553/9556)场景,`location.replace` 收到 `http://127.0.0.1:9553/#token=…`(preferred 直达,未被 9550 截胡)。
