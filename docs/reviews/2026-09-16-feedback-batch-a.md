# 审查报告:反馈批A——bridge 同步与多实例连接健壮(2026-09-16)

- **分支/commit**:`fix/feedback-batch-20260916a` @ `ba558694`(主体)+ `a7bd5bf4`(审查 B-1 清偿)
- **审查者**:code-reviewer 子 agent(独立上下文,不预设实现者声明为真,全部 grep/read 实测;无 shell 环境,可静态复核项全查,不可亲跑项已标注)
- **背景**:插件反馈批A,根治 send_drag 五踩 / 09-03 registry 断链 / 09-06 secret 残留的共同根源(项目内 mcp_bridge.gd 旧版拷贝无刷新路径)+ 多实例连接健壮性

## 总体判定:SHIPPED(清偿后)

首轮审查判定 **BLOCKING ISSUES**(A1/A2/A3 通过,A4 判活位置错误致功能整体失效);B-1 与 N1/N2/N3 已在 `a7bd5bf4` 清偿并全量验证,N4 挂账(见下)。

## 首轮审查结论(逐维度)

### 设计正确性
- **A1 force 参数 — 通过**:默认路径未动(kept-as-is 守卫保留),force 是显式 opt-in 逃生门;drift 文案含精确路径。
- **A2 版本指纹 — 通过**:GD `BRIDGE_SCRIPT_VERSION`(mcp_bridge.gd:25)= package.json 0.33.3;registry entry(:878)与 ping(:1229)回传;TS `annotatePingWithVersion` 旧版 GD(无字段)得 `unknown (old GD...)` 文案;`bundledBridgeVersion` 刻意零模块级缓存(直读);keepalive ping 走 core 层不受注解影响。
- **A3 失败端口记忆 — 通过**:registry 循环与 scanSecretWindow 双路径避开;全失败回退 mtime 最新(候选语义连续);TTL 惰性过期;`resetBridgeState` 清理。审查确认一个正确的设计细节:`probeOnce`(run_project 启动轮询)ECONNREFUSED **不**标记——启动早期游戏未监听,若标记会令后续轮询换端口反致死锁。
- **A4 判活清理 — 首轮 BLOCKING**(见 B-1)。

### 测试质量
- A1/A2/A3 首轮即合格(行为断言、纯度断言、fake-timers TTL)。
- **A4 首轮假绿**:fixture 按 TS 自己假设的路径构造心跳,验证的不是 GD↔TS 集成契约(B-1 组成部分)。

### 仓库级约束独立核查(全部通过)
| 约束 | 结论 |
|---|---|
| core 不 import tools | ✅ bridge-client.ts imports 无 `../tools/` |
| 禁新增模块级 setter | ✅ `_markPortFailed` 是领域操作函数(同 `_registerSubscription` 先例),非 setXxx 注入 |
| defects 基线 82→83 | ✅ 数学成立(唯一新增 `const _failedPorts`;game-bridge 顶层仅既有 `_syncSnapshots`) |
| rules-sync 双副本 | ✅ 本批未改 rule-templates.ts 与 .claude/rules/(双副本一致地都没动,不触发 bump 门禁,符合 [Unreleased] 定规) |
| version-sync --check | ✅ bridgeGd 0.33.3 == package.json(审查环境为静态推演,清偿后已实测通过) |
| capability-matrix 同步 | ✅ force/clean_stale_secrets 已入 matrix(构建钩子自动重建) |
| p4-batch 锚 7800→8200 | ✅ 正当校准(实测 8080,两参数为真实功能增量,先例同款) |

## Blocking Issues(已清偿)

### B-1(置信度 95,已修 `a7bd5bf4`):A4 判活读错 registry 位置
- **现象**:首版 `liveHeartbeatPorts` 读 `{projectPath}/.godot/mcp-instances/`,但 GD 侧 project-level 心跳写在 `ProjectSettings.globalize_path("user://")/.godot/mcp-instances` —— `user://` 映射 **app_userdata**(`%APPDATA%\Godot\app_userdata\<项目名>`),非项目目录。本仓库自身代码即证词(game-fs.ts:12,47 / workflow.ts:254-255)。同文件自相矛盾:secret 走 `res://`(项目目录,TS 一直读通)而 registry 走 `user://`,两种 "project .godot" 语义分裂。
- **后果**:判活恒空集 → clean_stale_secrets 永远走拒绝分支、检测永远静默、A3 新文案指向一个永远 skip 的路径——09-06 secret 残留反馈实际未被修复;测试假绿。
- **修复**:判活改读 **machine registry**(与 resolveBridgePort 同源位置,跨进程对齐被长期验证)+ projectPath/capabilities/lastSeen 同款过滤,`liveHeartbeatPortsFor` 下沉 core;`machineRegistryInstancesDir()` 加 `GODOT_MCP_BRIDGE_REGISTRY_DIR` env 重定向(测试注入;发现类信息源,重定向不涉安全边界);测试改为经 env 重定向写 machine registry(行为级真实接线)+ liveHeartbeatPortsFor 直测 4 用例。
- **未采纳的替代方案**:改 GD 侧写项目目录——已发行旧版 GD 仍写 user://,升级过渡期依旧断链。

## Nits 处置
- **N1 ✅**:version-sync 测试补 bridgeGd 漂移(--check exit 1)+ 写入(常量被更新)2 用例;"8 文件"注释修正。
- **N2 ✅**:clean 成功文案补混合新旧实例边界提示(old-GD 实例无心跳时其 secret 会被删,内存 auth 仍活但 TS 侧重连需重跑)。
- **N3 ✅**:game-bridge.test.ts 补 ECONNREFUSED → `_isPortFailed(9081)` 自动标记集成断言(fs mock 下 '/p' 无 registry/secret → 端口恒 9081;用例尾 resetBridgeState 防污染)。
- **N4 ⏸ 挂账**:bridge 规则模板(`rule-templates.ts` / `.claude/rules/godot-mcp-bridge.md`)未登记 force/clean_stale_secrets 排障入口。改它触发 `check-rules-version-bump.mjs` 硬门禁走完整版本链,与批 B/C/D 的规则模板变更合并处理更经济(单批为两个参数走一次 bump 不值)。**下批处理批次 B 时一并评估。**
- **N5 ✅ 记录**:p4-batch 锚值 8080 为实现侧 vitest 实测输出(vitest run test/p4-batch.test.ts 断言消息),非估算。

## 值得进 memory 的工程教训(已登)
1. **跨进程路径契约必须锚定在已验证对齐的位置源**:GD `res://` = 项目目录、`user://` = app_userdata,不可互换。TS 新增"读 GD 写入文件"的功能,应以既有工作系统(secret:`{project}/.godot/`)或已验证的 machine registry(`~/.godot-mcp/instances`)为契约源。
2. **手写 fixture 模拟对端写入 = 假绿温床**:测试绿只证明 TS 自洽,不证明 GD↔TS 契约;跨进程文件契约应有"双侧路径推导一致"的行为级验证(本批以 env 重定向 + machine registry 真实接线达成)。
3. **双位置心跳的每个位置都应有消费方**:user:// 心跳自 c18c6183 起无人消费,位置漂移长期无人察觉,直到 A4 想消费才暴露——无消费者的写入路径是契约盲区。

## 验证记录(清偿后终态,2026-09-16 实测)
```
npm run lint            → 0 error 0 warning
npm run build           → tsc 0 错误(build/scripts 同步)
npm test                → 6667 passed / 0 failed / 85 skipped(449 files passed)
npm run check:gdscript  → errors=0 warnings=0
node scripts/version-sync.mjs --check → ✓ 版本元数据一致 (0.33.3)
```
定向:workspace-guard 14/14、registry 28/28、validation 40/40、version-sync 18/18、game-bridge 32/32。

## 遗留(如实标注)
- **跨项目实测未做**:A1 force 刷新、A2 版本指纹告警、A4 真机清残留需在 CardGame2 重装 bridge 后验证(反馈回标的前置);本批仅 fixture/单测级验证。反馈文件回标状态 = 上游已修待跨项目验证,不标 🟢。
- N4 规则模板登记挂账(见上)。
