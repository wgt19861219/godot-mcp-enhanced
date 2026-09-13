# run_project 预览模式 + AI 收尾视觉验证流程 — 设计文档

- **日期**:2026-09-13
- **状态**:已审(设计轮专业自审 + 第三方 code-reviewer 审阅),待实施
- **分支**:feat/run-project-preview-mode
- **类型**:feature(工具参数 + 规则模板收尾流程)

---

## 1. 背景与痛点

用户(开发者)的日常工作流:叫 AI 修改 Godot 项目的场景/UI/脚本 → AI 改完说"请打开编辑器验证收尾" → 用户手动启动 Godot 编辑器 → **编辑器加载慢** → 才能看到修改后的界面效果。

痛点本质不是"编辑器开发加速",而是**验证收尾闭环缺一环**:AI 完成修改后,用户缺少一条跳过编辑器、直接看到修改后界面效果的通道。

现有能力盘点(2026-09-13 实测):

| 能力 | 现状 | 缺口 |
|------|------|------|
| `run_project` 弹真实游戏窗口 | 已有(`src/tools/runtime.ts:140-283`) | 默认 30s TTL 自动杀,用户没看清窗口就没了 |
| TTL 禁用 | 基础设施支持(`runtime.ts:220` 的 `if (timeout > 0)` 才设 timer)但 `computeRunTimeout`(`runtime.ts:113-116`)把 `timeout=0` 回落成 30,无法禁用 | 需要显式参数 |
| 进程退出自动清理 | 已有(`runtime.ts:231-244` 的 `proc.on('close')` 处理槽位释放/pid 注销/profiler 关闭) | 无 |
| headless 截图(`screenshot capture`) | 已有 | 用户已明确不要此形态(选"弹真实游戏窗口") |
| AI 收尾流程约定 | 无——AI 默认叫用户开编辑器验证 | 需要规则模板引导 |
| addons 编辑器插件热重载 | 无(与本设计无关,另案) | — |

## 2. 目标 / 非目标

**目标**:

1. AI 改完视觉相关内容后,收尾动作自动变为:headless 快速验证语法 → `run_project(preview=true)` 弹出常驻游戏窗口 → 用户肉眼确认 → 用户关窗即验证结束 → AI 查运行时错误并汇报。
2. 默认行为零变化:所有现有调用方(qa/gif/bridge-session/AI 日常调用)不受影响。

**非目标**:

- 不做编辑器热重载/编辑器启动加速(独立话题)。
- 不做截图自动弹出/截图墙(YAGNI,未来"关窗后想再核对"成真实痛点再做)。
- 不改 dashboard(用户已排除;且 dashboard 只读架构约束不碰)。
- 不改 `wait_for_bridge` 语义。

## 3. 方案选型

- **方案 A(选定)**:`run_project` 加可选参数 `preview` + 规则模板收尾流程引导。
- **方案 B(否决)**:新独立工具 `preview_run`——内部仍需复用 run_project 的 spawn/槽位逻辑,等于薄壳包装;工具描述 token 预算、capability-matrix、help、文档全套跟进,过度设计。

选 A 判断依据:体验缺口 80% 在"收尾流程约定"(AI 不知道该弹窗),20% 在"工具能力"(TTL 无法禁用);A 两边都以最小改动解决。

## 4. 详细设计

### 4.1 工具层(`src/tools/runtime.ts`)

inputSchema 加参数:

```
preview: {
  type: 'boolean', default: false,
  description: '预览模式:禁用自动停止,游戏窗口常驻,用户关闭窗口即结束验证。适用于 AI 改完代码/场景后的人工视觉验证(替代打开编辑器)。默认不与 wait_for_bridge 组合(bridge 未就绪会终止游戏,见规则说明)'
}
```

行为变化仅一处:`runtime.ts:220` 的定时器条件

```ts
// 现状
if (timeout > 0) {
// 改为
if (timeout > 0 && !preview) {
```

preview=true 时不设 autoStopTimer,游戏常驻。返回消息改为预览语义(英文,仓库惯例——运行时消息读者是 AI):

```
Preview mode: game window is now open at ${p}.
It stays open until the user closes the window (no auto-stop).
After the user closes it, call get_debug_output to check for runtime errors.
```

组合分支文案(修正第三方审阅 Nit:preview + wait_for_bridge=true 成功时不得再报 `timeout: Ns`,当前 `runtime.ts:280` 的文案在 preview 下失真):preview 下省略 timeout 字段,改为 `Preview mode: bridge ready, game window open at ${p}, no auto-stop...`。

#### 4.1.2 输出快照机制(B-1 修复,新增)

**问题**:`_outputBuffer` 在两个入口被清空——`setRunningProcess(null)` 内部(`process-state.ts:290-293`,close handler 被动触发)和 `clearOutputBuffer()`(`runtime.ts:167` 新 run_project / `:311` stop_project 主动调用)。清空后 `get_debug_output` 无从读取,"关窗/换窗后查错"不可达。

**方案**(集中单文件,move 语义):

1. `src/core/process-state.ts` 新增模块级快照 `_lastFinishedRunOutput: string[]`(上限同 `MAX_OUTPUT_BUFFER_SIZE = 5000` 截断)与 getter `getLastFinishedRunOutput()`
2. 上述两个清空入口在清空前把现有 `_outputBuffer` **挪入**快照(旧快照被覆盖)
3. `runtime.ts` `get_debug_output`:`ctx.outputBuffer` 为空且无 `runningProcess` 且快照非空 → 分类快照内容,结果标注 `"(from last finished run)"`

**行为影响核查**:

- `stop_project`(`runtime.ts:300` 先读后 `:311` 清):挪语义下行为不变;且 stop 后再查 debug output 也能读到快照(相比现状是改进)
- 新 run_project:close/setRunningProcess 清旧 buffer 时自动留档,旧窗口未查的输出**不再无声丢失**(修复第三方审阅 Nit"换窗丢输出")
- 快照是数据 API(纯 getter + 内部挪移),不是依赖注入 setter,不违反 AGENTS.md「禁止新增模块级 setter 注入点」(该条针对回调/依赖注入);但实施时须在 `GodotServer.close()` 检查是否需要重置快照(数据驻留评估:仅内存字符串数组,进程退出即消失,无清理必要,实施时复核)

#### 4.1.3 preview 与 wait_for_bridge 的分层语义

工具层允许组合(参数不互斥);规则层默认不推荐(§4.2.3)。两层不矛盾:组合的正当场景是"项目装了 bridge、就绪快、且 AI 需要运行时查询状态"。

**进程生命周期复用现有 close 清理机制 + 补输出快照(第三方审阅 B-1 修复)**:

- 用户关窗 → 进程 close → `proc.on('close')`(`runtime.ts:231-244`)自动释放槽位、注销 pid、关 profiler——这部分复用现有代码
- **但实测发现**(第三方审阅 B-1,证据链已复核):close handler 经 `ctx.setRunningProcess(null)`(`runtime.ts:238-240`,直通 `ToolDispatcher.ts:106-114` 的 process-state 单例)触发 `process-state.ts:290-293` **清空 `_outputBuffer`** → `get_debug_output`(`runtime.ts:316-317`)返回 "No debug output available"——原设计"关窗后 AI 查运行时错误"的闭环不可达。因此必须补**输出快照机制**(见 §4.1.2)
- 下一轮 preview → 全局单槽先杀旧进程再起新窗口(`runtime.ts:154-159`,现有行为)
- `stop_project` 仍可手动杀
- MCP server 退出 → `registerSpawnedGodotPid` 注册表清理,不留孤儿
- 与 `profiling` 参数可组合;与 `wait_for_bridge` **技术上可组合但默认不推荐**(见 §4.2.3)

### 4.2 规则层(双副本 + 硬门禁)

`src/tools/rule-templates.ts` core 模板"手动组合"段(`:109` 附近,`grep -n "手动组合"` 已实测定位)加收尾流程约定;`.claude/rules/godot-mcp-core.md` 同步(独立副本,`STRICT=1 npm run check:rules-sync` 机械校验)。

规则内容要点:

1. **触发判定**:改动涉及 `.tscn` / UI 脚本 / 样式 / 场景结构等**用户需要看到效果才能验收**的内容 → 弹窗;纯逻辑/测试/文档改动不弹。
2. **流程**:① `validate_scripts` 快速语法验证 → ② `run_project(preview=true)` → ③ 告知用户"窗口已弹出,请确认效果,关闭窗口即验证结束" → ④ 用户关窗后 `get_debug_output` 检查运行时错误并汇报。
3. **组合约束**:preview **默认不传 `wait_for_bridge`**——wait_for_bridge=true 且 bridge 未就绪会终止游戏(`runtime.ts:267-276`),窗口会在用户眼前闪现即逝;仅当确实需要 bridge 查询运行时状态且项目 bridge 就绪快时才组合。

### 4.3 测试策略

- 测试基建参照:`test/runtime.test.js` 的 spawn mock 基建(vi.mock child_process + mockProc EventEmitter + killProcess mock,如 `:509-516` 组合形态、`:549-565` Imp-4 close 回归形态)——**注意** `test/runtime-timeout.test.ts` 只有 computeRunTimeout 纯函数断言,无进程 mock 模式,不可作参照(第三方审阅 Nit 修正)
- **mock 语义警示**(第三方审阅教训):现有 mock ctx 的 `setRunningProcess` 是纯 `vi.fn()` 无副作用(`runtime.test.js:76-91`),恰好掩盖 process-state 模块级连带清理——快照机制的测试**必须**走真实 process-state 模块(vi.importActual 或不 mock 该模块),否则"测试绿但闭环断"
- 用例:
  - preview=true 不设 autoStopTimer:断言 `killProcess` 未被调用(不设 timer 即无回调,不必依赖 fake timers)
  - preview 返回消息字符串断言(预览语义文案;组合分支不含 `timeout: Ns`)
  - **快照机制**:close 后 `get_debug_output` 读到快照并带 `(from last finished run)` 标注;新 run_project 覆盖快照;快照 5000 行截断
  - preview + wait_for_bridge 组合:bridge 失败仍杀进程(语义不变)
  - close 清理路径回归(防 preview 分支破坏)
- 手动验收:真实项目走一遍"改 → 弹窗 → 关窗 → 查错"闭环

### 4.4 边界与错误处理

| 场景 | 行为 | 说明 |
|------|------|------|
| 游戏秒崩 | close handler 清理;输出经快照保留,AI 从 get_debug_output 拿崩溃报错 | 依赖 §4.1.2 快照机制 |
| 用户长时间不关窗 | 窗口无限常驻;单槽被占但 headless/editor/bridge 域均不受影响;下一轮 preview 自动换窗 | 实测:headless 走独立 `acquireShortRunningSlot`(`src/gdscript-executor.ts:25`);`acquireProcessSlot` 全仓唯一调用点即 run_project 自身(第三方审阅 1.3 独立验证) |
| 换窗(新 run_project 杀旧进程) | 旧输出经 §4.1.2 快照自动留档,`get_debug_output` 可回查 | 修复第三方审阅 Nit"换窗丢输出";无快照机制时 `runtime.ts:154-159`+`:167` 会无声丢弃旧输出 |
| 输出缓冲增长 | 自动截断保留最近 5000 行 | 实测:`MAX_OUTPUT_BUFFER_SIZE = 5000`(`src/core/process-state.ts:17`),`appendOutput` 截断(`:300-303`) |
| 用户看窗时关掉 AI 客户端 | MCP server 退出 → 游戏 pid 被清理 → 窗口消失 | **有意设计**(防孤儿进程),需在文档诚实标注 |
| 两个会话同时 preview | 第二个 busy 报错(全局单槽) | 现有行为,不引入新问题 |
| preview 误用于无人值守任务 | 现有调用方全不传 preview,默认行为零变化 | 向后兼容 |

## 5. 仓库级约束落地清单

| 约束 | 动作 | 依据 |
|------|------|------|
| 独立副本同步 | `rule-templates.ts` 与 `.claude/rules/godot-mcp-core.md` 同步改,`STRICT=1 npm run check:rules-sync` 验证 | AGENTS.md「独立副本同步约束」 |
| 版本 bump 硬门禁 | rule-templates.ts 变更 → 强制 `npm version patch`(0.33.1 → 0.33.2,以实施时 package.json 实际版本为准)+ `npm run build` + version-sync + CHANGELOG 定版段 + README 版本行;npm publish/tag 仍待用户明确指令 | AGENTS.md「发版前额外门禁」例外条款 |
| 工具清单变更 | inputSchema 加参数 → `npm run build-matrix` 重建 capability-matrix;`npm run check:budget` 验证 token 预算 | AGENTS.md「改动工具清单后」 |
| 工具文档生成产物 | inputSchema 加参数 → `npm run gen:tool-docs` 重新生成 `docs/tools/runtime.md`(AUTO-GENERATED,footer 明示;有参数级表格) | 第三方审阅遗漏 1(Important) |
| claudemd-builder 措辞同步 | `src/tools/claudemd-builder.ts:90` GODOT_MCP_RULES 含"run_project 有超时设置,长时间运行需调整"——preview 上线后部分失真,**决策:同步更新**(该文件是分发到目标项目的第三处模板源,不在 check:rules-sync 机械校验范围,漂移无门禁拦截,须列入手工同步清单) | AGENTS.md「分发产物与独立副本边界」+ 第三方审阅遗漏 2 |
| README 工具表措辞 | `README.md:223` 工具表行"`run_project` | 以调试模式运行项目(自动超时)"——加 preview 一句话说明 | 第三方审阅遗漏 3 |
| 完成前强制检查 | `npm run lint` + `npm run build` + `npm test` 全绿 | AGENTS.md「完成前强制检查」 |
| plan 落地后第三方审查 | 实施完成后产出 `docs/reviews/2026-MM-DD-run-project-preview.md` | AGENTS.md §8 |
| memory 登记 | feature-decision-log + 教训 | AGENTS.md「完成前必登 memory」 |

## 6. 改动量估计

- `src/tools/runtime.ts`:约 20 行(参数 schema + timer 条件 + preview 文案 + 组合分支文案 + get_debug_output 快照回落)
- `src/core/process-state.ts`:约 15 行(快照变量 + getter + 两个清空入口的挪移逻辑)(B-1 修复新增)
- `src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-core.md`:约 10 行 × 2 副本
- `src/tools/claudemd-builder.ts`:约 2 行措辞
- `README.md`:工具表 1 行 + 版本行
- `docs/tools/runtime.md`:gen:tool-docs 再生成
- 测试:约 80 行(含快照机制用例)
- 版本链:package.json / manifest.json(version-sync)/ CHANGELOG / README 版本行

## 7. 设计轮审阅记录(2026-09-13)

### 7.1 设计者自审 + 假设实测

1. ✅ 输出缓冲上限存在(`process-state.ts:17`,5000 行)
2. ✅ headless 不被游戏槽阻塞(`gdscript-executor.ts:25` 只用 ShortRunningSlot)
3. ✅ 设计轮发现的 P2-1(闪窗)/P2-2(生命周期绑定)已纳入 §4.2.3 / §4.4

### 7.2 第三方 code-reviewer 独立审阅(feature-dev:code-reviewer 子代理,2026-09-13)

**总体判定:BLOCKING ISSUES → 本文档为修订版,B-1 已修复**

- **B-1(95% 置信度,已复核确认并修复)**:原设计"进程生命周期零新增代码、关窗后输出缓冲保留"的声明为假——close handler 经 `ctx.setRunningProcess(null)`(`ToolDispatcher.ts:106-114` 直通单例)触发 `process-state.ts:290-293` 清空 `_outputBuffer`,`get_debug_output`(`runtime.ts:316-317`)返回空。修复:§4.1.2 输出快照机制,修复方向选 reviewer 给的 (a)(保留完整价值闭环)而非 (b)(运行中即查错,价值缩水)。
- **Nits 全部落实**:换窗丢输出 → §4.4 边界表 + 快照机制覆盖;`gen:tool-docs` → §5;组合分支文案 → §4.1;claudemd-builder 措辞 → §5(决策:同步);测试参照改 runtime.test.js → §4.3;README 工具表 → §5;行号 140-282→140-283 → §1。
- **审查确认项**:computeRunTimeout 无需改动(副作用盘点仅消息文案);`acquireProcessSlot` 全仓唯一调用点为 run_project 自身,preview 常驻不阻塞任何域;只改 core.md 的双副本判断正确(bridge.md/recording.md/workflow-bridge-e2e.md 的 run_project 段均为前提性描述,无需同步);scope 适合单一实施计划。

### 7.3 教训(值得进 memory,实施完成后登记)

"零新增代码、复用现有机制"类设计声明,必须沿复用路径逐环节验证**隐式副作用**——本仓 process-state 模块单例的 setter 带连带清理(`setRunningProcess(null)` 清 outputBuffer/processStartTime),真实 ctx 的 getter/setter 又直通该单例(ToolDispatcher.ts:106-114);设计轮只读 tools 层漏了 core 层间接,且现有测试的纯 mock ctx(runtime.test.js:76-91)恰好掩盖模块级副作用——"测试绿"不等于"行为对"。

## 8. 开放问题

无——所有设计决策已在设计轮敲定。实施时唯一需现场判断的:preview 消息文案的最终措辞(保持英文 + 含 get_debug_output 引导即可)。
