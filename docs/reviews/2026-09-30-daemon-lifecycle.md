# 2026-09-30 daemon 批 B(feat/daemon-lifecycle)— 批级第三方审查

> **审查者**:code-reviewer 子代理(跨任务视角 + 仓库级约束独立 grep)
> **审查对象**:commits `9105e87c..a51a73c0`(6 commits:/api/shutdown 端点、CLI 四命令、受控交接、fix×2、spec 回写)
> **单任务审查**:Task 7 SHIPPED / Task 8 fix 后 clean / Task 9 Approved(2 Minor defer 批 C)
> **总体判定**:**SHIPPED WITH NITS**(0 Blocking;3 Nit,处置见文末)

## 逐维度结论(审查者原文要点)

1. **跨任务接缝 — 通过**:Task 7↔9 接线完整(stop→shutdownDaemon/restart→controlledRestart,全注入);Task 8↔7 query token 第一优先级通道+无 Origin 放行实测自洽;两套 spawn(CLI buildDaemonArgv / controlled-restart spawnDaemonDetached)argv 语义一致,**分层声明注释 + 双侧 argv 测试锁定**防漂移机制成立。
2. **两不变式批 B 端到端 — 兑现**:不变式 1(CLI 恒传 --port→strictPort 恒真;relisten 绑原端口 EADDRINUSE 即败有 squatter 测试);不变式 2(回滚 kill→登记消失→relisten 顺序有断言)。
3. **仓库级约束 — 全部合规**:11 变更文件不含 rules/rule-templates/src/tools(三门禁不触发);EX-b 递归扫描自动纳入(EXIT_CODES 常量零字面值);src/core 反向 import grep 0;cli/daemon.ts import 面合规;源码 ~847 行配 745 行测试。
4. **安全面 — 主干完备**(authorized 复用零自造;kill 兜底审计 reason 四值覆盖且 await 先于 kill;query token 权衡可接受)。缺口 N-1。
5. **真机证据静态自洽 — 通过**:start→9557(pickFreePort 递增)/restart 端口不漂移(strictPort+恒传)/T1 200(originAllowed 同端口)/stop 登记清零(closeListener 后 stop 仍清登记的修复有专测)。

## Nits(→ 处置)

| # | Nit | 处置 |
|---|-----|------|
| N-1 | /api/shutdown 401/403 零审计(spec §3.9"401 拒绝→审计"明文;批 A 已给 /mcp 落审计,此处漏) | ✅ fix `24db556a`:auditDaemonReject(action `shutdown-auth-reject`,401 `unauthorized`/403 `origin_forbidden` 分流,details `{error,hasAuth}` 无 token 值,isAuditEnabled+best-effort;authorized() 未动,pathname 条件限定不影响其他端点);+2 用例 TDD。复审:ADDRESSED 无新破坏 |
| N-2 | CHANGELOG [Unreleased] 无 daemon 条目 | 📌 plan 定批 C Task 13 统一补登(涵盖批 A+B 全部 feat commit),批 C 确认防漏 |
| N-3(观察) | 审计受控性分裂:server 侧 auditDaemonAction 受 isAuditEnabled 控制,cli/controlled-restart 侧恒写(各有先例声明) | 📌 ledger 记录,批 C 文档/终审可见性,不改动 |

## 批 C 风险输入(审查者新增)

1. **respawnOf 残留陷阱**:交接完成后新登记的 respawnOf 永久保留(指向已死 pid)——前端"交接中"判定不能只看 respawnOf 在场性,须结合旧 pid 登记/存活,否则永远误标。
2. **重入竞态真机验证**:双 restart 并发窗口=150ms setTimeout 期,第二序列 strictPort 自杀收敛但旧进程短暂无 listener——批 C 真机连发 restart 验证收敛。
3. **回滚文案**:CLI restart 交接回滚成功时(旧进程活着无新登记)CLI 等 10s 报"未登记"exit 1——文案未区分"回滚但活着",批 C 顺手改。

## 值得进 memory 的工程教训

两套 spawn 实现靠「分层声明注释 + 双侧 argv 测试锁定」防漂移——"有意不抽共享抽象(职责分层优先)"场景下可复用的防 drift 模式。

## 验证证据(控制器亲跑)

```
门禁:npm run lint 0 + build 0 + npm test 476 files / 7079 passed / 0 failed
真机交接验证(Windows 开发机):
  daemon start(干净 env)     → pid=25324 port=9557 就绪,URL/token 打码打印 ✓
  daemon restart(T2 CLI)     → 25324→25892,端口 9557 不漂移,respawnOf=25324,无双活 ✓
  T1 面板通道(同端口 Origin) → 200 {ok,mode:restart},25892→38180 端口不变 ✓
  daemon stop                 → 受控退出,registry daemon 登记清零,进程消失 ✓
  日志                        → action=shutdown mode=stop caller=daemon-cli result=200 落痕 ✓
  (首次 start 失败=GODOT_MCP_ALLOW_UNSAFE_CONFIRM 继承 env 触发 H-08 门拦截——门正常工作,
   生产用户终端无此 env;V5 close 链更细日志措辞留批 C 正式核对)
```
