# 反馈批次C（输入注入）独立审查报告

**分支**：fix/feedback-batch-20260916c ｜ **审查日期**：2026-09-17 ｜ **审查方式**：code-reviewer 子代理 Read/Grep 逐文件实测（审查环境无 Bash，git/npm 类命令无法执行，已在涉及处注明）

## 总体判定：SHIPPED WITH NITS

实现者声称的关键结论全部经独立实测核实成立；未发现 Blocking 问题；4 条 Nit（2 条本批新引入、2 条范围外/存量提示；其中 3 条已于审查后当日清偿，见文末处置记录）。

## 逐维度结论

### 1. 设计正确性 — 通过

- **C1 定谳证据链扎实**：`test/fixtures/mouse-gui-e2e/probe.gd:40-65` 三层探针（`_input` 引擎管线层 / `control_gui_count` GUI 派发层 / `control_taps` tap 判定层）+ Button 对照组，e2e 断言（`test/e2e-bridge-mouse-gui.test.ts:178-182`）逐一锚定。tap 判定复刻真实（`probe.gd:58-65`：press 记局部 position → release `distance_to < 8.0` 判 tap，同点位距离 0 必触发）。坐标推算自洽：ctl 全局 (100,100)-(300,300)、中心 (200,200)、局部 (100,100)，与 e2e 222-223 行 `global_position==[cx,cy]` / `position==[100,100]` 断言吻合。
- **device=0 语义正确**：`src/scripts/mcp_bridge.gd:2416-2418` 注释明确「显式 0 对齐真实鼠标事件，不依赖引擎对默认 -1 的未文档化规范化」——防御性显式化合理。全文 `.device =` 仅 4 处（2418/2431/3958/3967），与声称改动面完全一致；timeline 注入（3733/3735/3737 行复用 `_cmd_send_mouse_click` 等函数）自动跟随，CHANGELOG「timeline 自动跟随」声明属实。
- **_num 收口完整**：注入类命令（click/move/touch/drag）零裸 `float(params.get` 残留；`int(params.get("index"))`（2451/2490）前置 `_is_valid_touch_index` 守卫（2393-2398）安全。其余 19 处裸 `int/float(params.get`（1238/1346/1370/2629/2674/3003/3204/3307/3318/3514/3613/3616/3702/3705/4041-4043）全在非注入命令族（read/monitor/watch/recording/playtest/network 类），不属本批「输入注入链」声称范围，不判为问题（可作后续批次参考）。
- **C2 定谳反转可信**：取层错误根因的修复在 `test/e2e-bridge-mouse-gui.test.ts:290-293`（`unwrapCallMethod` 取 `(r.result).result` 两层）+ 注释链（228-233 行）完整记录；且 324-326 行反向断言 `click.warnings` 为 undefined，防已回退的误导性告警复活。
- 未能独立核verify：commit ec65e2e5（global_position 2026-05-29 起在位）与「全量 6650 passed」——无 git/npm 执行能力。但 global_position 当前在位（2415/2429 行）且有契约锁定，不影响判定。

### 2. 回退干净度 — 通过

`_input_dead_warning` 全仓零命中（grep 命中仅 CHANGELOG.md:22 / README.md:737 / e2e 注释中的**过程性描述文字**，非代码残留）；测试无对已回退行为的断言残留。

### 3. TS-GD 一致性 — 通过（1 Nit）

- 契约测试 5 用例与 GD 实现逐条核对对应（funcSlice 切片内字符串真实存在）。
- **不改 TS schema 描述可接受**：`src/tools/game-bridge.ts:239` 的 params 描述是紧凑形状提示且已引导「完整说明见规则文档」；device=0 是实现细节非调用方接口；坐标口径落在规则文档双副本（正确位置）。
- 顺带发现**存量问题**（非本批引入）：game-bridge.ts:239 `send_mouse_move{x,y}` 漏 `button_mask` 参数（GD 2434 行在读，2026-08-22 反馈加的）→ **审查后已清偿**。

### 4. 测试质量 — 通过（1 Nit）

- 假绿防护充分：null/UNEXPECTED_RESULT 显式判（77-78 行）、beforeAll 失败 → `ctx.skip` 不假绿（137-139 + 164 行）、断言用 base+N 相对增长不依赖绝对值。
- CI Linux+xvfb 可行：describe1 带窗口 spawn 与已在 CI L2 列表先例 `e2e-bridge-input-sequence.test.ts` 同模式（env 处理亦同款：beforeAll 设 EXTRA_METHODS、afterAll 删）；describe2 手动 `--headless` 无显示依赖，xvfb-run 不干扰（`.github/workflows/ci.yml:216-217` 注释亦载）。fixture `features=4.5` 与 CI Godot 版本差异仅警告不阻塞，同先例。

### 5. 仓库级约束独立核查 — 全部通过

- **双副本同步**：`.claude/rules/godot-mcp-bridge.md:51-55` 与 `src/tools/rule-templates.ts:224-228` 逐字一致（ts 侧反引号转义归一后），上下文段（写入/等待/监控/信号监听）亦一致；CI 80-81 行 STRICT=1 check:rules-sync 步骤在位（本次以文件级逐字比对作等效验证）。
- **版本链**：package.json/manifest.json/plugin.cfg/server.json(2处)/Dockerfile/docs/使用指南.md/docs/capability-matrix.json 全 0.33.5；CHANGELOG.md:20-31 有 [0.33.5] 定版段（Fixed 2 + Added 3）；README.md:737 版本行；CHANGELOG.md:22 明确「npm publish / tag 待用户指令」——N-C 条款（规则模板触发 bump ≠ 发版）合规。
- **ci.yml 对账制**：test/ 中 11 个引用 `GODOT_MCP_E2E_L2` 的文件全部在 ci.yml:231 e2e 列表（新文件已登记）；ci.yml:50-54 check-e2e-l2-coverage.mjs 机械对账步骤在位。
- **gitignore**：39/45-48/56-57 行覆盖 mouse-gui-e2e 全部运行时产物（mcp_bridge.gd/.uid、probe.gd.uid、`.godot/`、`NVIDIA Corporation/`、png）。
- **分发产物边界**：capability-matrix.json 属 build 产物随版本号再生成，未见手改痕迹。

### 6. 行尾事故 — 已收口

12 个改动面文件 `\r` 零命中；检测方法经阳性对照验证有效（`\t` 在同批文件正常命中、多模式花括号 glob 会静默失配已识别并弃用）；`.gitattributes:2` `* text=auto eol=lf` 策略在位；CHANGELOG/README 内容通读无损坏。

### 7. 文档标注质量 — 通过

「输入注入管线要点」四条事实核对：坐标口径（窗口坐标 + 引擎派发局部化，与 e2e 222-223 断言一致）、覆盖面（headless 与带窗口均派发，与 describe1/2 断言一致；TextureButton 未被 e2e 直接锚定但 BaseButton 同链路推断成立）、排查清单与复杂交互引导合理无事实错误。

## Blocking Issues

无。

## Nits

1. `test/e2e-bridge-mouse-gui.test.ts:259` — `resolveBridgePort` 解构后全文未使用（死代码）。lint 只覆盖 `src/`（package.json:36 `eslint src/`），CI 抓不到 → **已清偿（删除）**。
2. `test/bridge-feedback-batch-c-contract.test.ts:51` — 用例名「send_mouse_touch」应为 `send_touch`（工具实名）→ **已清偿（更名）**。
3. 范围外提示：`_cmd_send_touch`/`_cmd_send_drag`/`send_key` 未对称设置 device=0（本批声称范围仅 mouse 链 + 09-10 建议①，touch 链同依赖引擎规范化；后续批次可对称收口）→ **挂账批次D/后续（待办登记）**。
4. 存量（非本批）：`src/tools/game-bridge.ts:239` schema 描述 `send_mouse_move{x,y}` 漏 `button_mask` 参数 → **已顺手清偿（同主题一行描述修正，定向单测 43 passed）**。

## 值得进 memory 的工程教训

1. **审查工具的否定性结论必须做阳性对照**：Grep 花括号多模式 glob 会静默失配（0 文件命中伪装成「无匹配」），本次靠 `\t` 对照试出；任何「无残留/无污染」级结论先验证检测手段本身有效。
2. **C2 定谳反转的方法论**：判定「引擎不派发」级上游结论前，先排除工具链自身取层/解析错误——call_method 两层 result 少取一层 → x=null → GD `float(null)` 崩 → 响应静默 result:null，整链表象与「不派发」不可区分；分层探针（`_input` 计数独立于 GUI 派发）是拆解此类混淆的关键。

## 审查后处置记录（2026-09-17，实现者）

- Nit1/2/4 已当日清偿（死 import 删除 / 用例名更名 / schema 补 button_mask）；清偿后定向复验：契约 5/5、game-bridge 相关单测 43/43、e2e 4/4、lint 0、build 通过。
- Nit3 挂账：touch/drag 链 device=0 对称收口（含 e2e 锚定）留后续批次。
