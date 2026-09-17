# 插件反馈批次 D 独立审查（2026-09-17）

> **审查对象**：`fix/feedback-batch-20260916d` @ `00e113e2`（主提交，16 文件 +322/-23）+ `1465b58e`（Nit 清偿）+ device 挪位提交（Nit5 续，见处置记录）。
> **审查者**：code-reviewer 子 agent（独立会话，隔离视角；无命令执行能力，git 历史比对项由实现者事后补验）。
> **反馈来源**：`D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md` 09 月 open 条目（D1/D2 fr2 09-02、D3 fr2 09-06、D4 CardGame2 09-06、D5 批次C审查 Nit3 挂账）。

## 总体判定：**SHIPPED WITH NITS**（0 Blocking + 5 Nits，审查后 4 项清偿、1 项边界说明）

## 逐维度结论（审查者原文摘录，证据为审查时点行号）

### 1. 设计正确性 — 通过
- **D1 `computeRunTimeout` 语义边界**：`src/tools/runtime.ts:147-156` 逐值推演——`0`/`-1`/`'0'`/`'-5'` 归 0；`undefined`/`null`/`''`/`NaN` 走默认 30，四个漏网形态全防住。消费守卫 `timeout > 0 && !preview`（runtime.ts:273）确保 0 = 不设 timer。
- **timeout=0 + wait_for_bridge 组合**：0 直接短路返回，跳过 `Math.max(bridgeTimeout + 10, base)`——正确的优先级：timer 不存在则 race 消失，显式 0 是更强的用户意图。Bridge-not-ready 路径的 kill 是 `isBridgeReady` 探测失败后的主动清理，**不是** auto-stop timer 所杀。三处 timeoutNote 落位：runtime.ts:340/:348/:353。
- **D4 `removeUidCompanion` 误删风险**：无。`src/core/overrides.ts:288-292` 只删精确路径 `scriptPath + '.uid'`；`uninstallAllOverrides` 的调用点（:272）在 `existsSync(scriptPath)` 守卫之外——正确覆盖「脚本已被手删但 .uid 残留」场景。
- **D2 核实方法学**：证据链充分。fixture `test/fixtures/mouse-gui-e2e/probe.gd:48-51` 动态挂 MapPanel（CanvasLayer, layer=12）——.tscn 声明还是 `_ready` 动态建对运行时树遍历无区别，「Node 但非 CanvasItem」关键特征被复刻；代码侧 `_traverse_tree`（mcp_bridge.gd:2097-2116）是纯 Node 栈式 DFS 无 CanvasItem 过滤，「无盲区」定谳有代码依据；e2e 断言 pattern/type 双命中 + path 精确值构成防回归锚定。

### 2. TS-GD 一致性 — 通过
- **device=0 四处落位**与批次C三处（2419-2421/2433-2434/3973-3984）风格一致；timeline 分发点 3747/3753/3755 复用同函数自动跟随属实。
- **velocity 复刻**：引擎属性正确性独立成立（Godot 4 `InputEventScreenDrag.velocity`），契约测试双向锚定（`toContain('event.velocity =')` + `not.toContain('event.speed =')`）。

### 3. 测试质量 — 通过
- runtime-timeout 4 用例与实现逐值对应；ToolDispatcher 三文件 mock 同步完整（grep 无第三处遗漏）；D3 用例四 stage 全枚举 + pipeline 前缀断言；overrides 两用例真实走文件系统；batch-d 契约 funcSlice 边界正确；e2e 三层防假绿（skipIf 守卫/ctx.skip 显式/null result 报「疑似假绿」），D5 相对增长断言 + 禁止 -1 桶双条件健壮。

### 4. 部署同步 — 通过
- build 副本 `build/scripts/mcp_bridge.gd` 七处匹配行与 src 行号逐一相同；CI L2 无需变更（改的是已登记的 e2e 文件；新契约测试不引用 `GODOT_MCP_E2E_L2`，按 check-e2e-l2-coverage 逻辑无需登记）；gitignore :47 已覆盖 `probe.gd.uid`；capability-matrix 经 build-matrix 重生成含新 timeout 描述（`src/capability/extract.ts:78` 把整个 inputSchema 纳入产物——**参数描述文本变更也属漂移面**，审查者独立确认）。

### 5. 仓库级约束独立核查 — 全部通过
- 双副本规则表述「注入事件 device=0/global_position 与真实管线一致」不枚举具体链，批后代码更符合该表述，无漂移；版本 0.33.5 不 bump 合规（`check-rules-version-bump.mjs:73-76` 模板未变更即跳过 + 2026-08-19「默认不发版」定规，变更进 CHANGELOG `[Unreleased]`）；分层约束无违（无新增模块级 setter）。

### 6. 验证完整性 — 静态可信度评估通过（执行类声称由实现者实测）
### 7. 反馈处置正确性 — D1/D3/D4 覆盖反馈建议；D2 按反馈要求「核实而非改码」执行，代码 + 真机双证据定谳。

## Nits 与处置记录（2026-09-17，实现者）

| # | Nit | 处置 |
|---|-----|------|
| 1 | CHANGELOG [Unreleased] 双 `### Fixed`/`### Added` 段 | ✅ 已清偿（`1465b58e`）：归并为各一节，dashboard 条目上移并入 Fixed |
| 2 | ToolDispatcher 对照用例名与放行源脱节（boolean mock 无效残留） | ✅ 已清偿（`1465b58e`）：改名 `validateGodotBinaryDetailed ok:true` + 显式设置 |
| 3 | runtime timeout schema 描述 wait_for_bridge 句未注 0 例外 | ✅ 已清偿（`1465b58e`）：补「0/-1 优先短路不抬升」 |
| 4 | D4 只防新 .uid 残留，不清历史存量 | 边界说明（非缺陷）：清存量需 glob 扫超本批范围；反馈回执已注明「历史孤儿需手删，后续 install/uninstall 循环自愈」 |
| 5 | velocity 复刻「逐字一致保 merge」待合并实证 | ✅ 已清偿且**假设被证伪后修正**（详见下） |

### Nit5 清偿过程（merge 冲突面三步最小化，全 git merge-tree 实证）

1. **首验证伪**：`git merge-tree --write-tree fix/feedback-batch-20260916a fix/feedback-batch-20260916d` 实测 4 处冲突（mcp_bridge.gd / 契约测试 / matrix×2）——实现时自加的「与批A同款复刻」注释行使复刻区域非逐字一致，审查者 Nit5 的怀疑正确。
2. **删自加注释行**（`1465b58e`）：mcp_bridge.gd 的 velocity 段与 recording-touch-drag-contract.test.js 恢复与 d7b15fa4 逐字一致 → 契约测试冲突消除，mcp_bridge.gd 剩「D 在 speed 行后插入 device vs A 删改该行」的位置重叠型冲突。
3. **device 行挪位**：send_drag 的 `event.device = 0` 从 velocity 行后挪至 `event.index = index` 后（批A不动该区域）→ **mcp_bridge.gd 冲突消除**。挪位后复验：build 0 错/契约+batch-d 7 passed/check:gdscript errors=0/e2e 真机 6/6（D5 探针 `touch_device_counts={"0":2}` 不变）。

**残余冲突面（终态，机械可解）**：CHANGELOG.md（两分支各往 [Unreleased] 头插引用块，合并时顺序保留两条）+ capability-matrix.{json,md}（生成产物，合并后重跑 `npm run build-matrix` 即解）。**批A/D 合并前 checklist**：merge 后先解 CHANGELOG 两行，再跑 build-matrix 覆盖 matrix，然后全量测试。

## 值得进 memory 的工程教训（审查者 + 实现者补充）

1. **跨分支复刻的「逐字一致」必须含注释**——自加的来源标注注释会让复刻区域与源分支产生 diff，三方合并照样冲突；来源说明放 commit message（合并后注释本身过时）。merge 无冲突结论必须 `git merge-tree` 实测，不能凭「改动的是不同行」推断（插入位置的上下文重叠同样冲突）。
2. **capability-matrix 的实际漂移面宽于规则字面**：`extract.ts:78` 把整个 inputSchema（含参数描述文本）纳入产物——「改了工具清单后必跑 build-matrix」的规则表述应收窄为「改 schema/描述后必跑」。
3. **e2e「device 值分布计数」探针模式**（base/after 相对增长 + 禁止 -1 桶）是锚定注入事件属性的轻量行为级手法，强于文本契约、脆性低于全字段快照，可复用到 window_id/echo 等字段。

## 终态验证汇总（实现者实测）

- lint 0 警告 / `npm run build` 0 TS 错 / `npm run build-matrix` 46 tools（v0.33.5）
- 全量 Vitest：**6661 passed / 0 failed / 91 skipped**（首跑 1 个 recording-touch-drag-contract 失败系 velocity 复刻后未同步该契约测试的旧 `event.speed =` 断言——同步后复跑全绿；另一次环境并发 flaky 复跑消失）
- `npm run check:gdscript`：errors=0 warnings=0（Godot 4.7.1）
- e2e 真机 4.7.1：`test/e2e-bridge-mouse-gui.test.ts` **6/6**（含 D5/D2 新用例）
- D1 行为级冒烟（临时脚本，真机）：timeout=0 起 → 响应含 `no auto-stop` → 8s 后 `running:true` → stop_project `stopped`
- `STRICT=1 npm run check:rules-sync`：9 模板一致
- merge-tree：批A/D 源码冲突清零（见 Nit5 处置）
