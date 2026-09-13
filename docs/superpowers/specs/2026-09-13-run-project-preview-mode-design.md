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
| `run_project` 弹真实游戏窗口 | 已有(`src/tools/runtime.ts:140-282`) | 默认 30s TTL 自动杀,用户没看清窗口就没了 |
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

**进程生命周期零新增代码**——复用现有机制:

- 用户关窗 → 进程 close → `proc.on('close')`(`runtime.ts:231-244`)自动释放槽位、注销 pid、关 profiler;输出缓冲保留,AI 可继续 `get_debug_output`
- 下一轮 preview → 全局单槽先杀旧进程再起新窗口(`runtime.ts:154-159`,现有行为)
- `stop_project` 仍可手动杀
- MCP server 退出 → `registerSpawnedGodotPid` 注册表清理,不留孤儿
- 与 `wait_for_bridge` / `profiling` 参数可组合,互不排斥

### 4.2 规则层(双副本 + 硬门禁)

`src/tools/rule-templates.ts` core 模板"手动组合"段(`:109` 附近,`grep -n "手动组合"` 已实测定位)加收尾流程约定;`.claude/rules/godot-mcp-core.md` 同步(独立副本,`STRICT=1 npm run check:rules-sync` 机械校验)。

规则内容要点:

1. **触发判定**:改动涉及 `.tscn` / UI 脚本 / 样式 / 场景结构等**用户需要看到效果才能验收**的内容 → 弹窗;纯逻辑/测试/文档改动不弹。
2. **流程**:① `validate_scripts` 快速语法验证 → ② `run_project(preview=true)` → ③ 告知用户"窗口已弹出,请确认效果,关闭窗口即验证结束" → ④ 用户关窗后 `get_debug_output` 检查运行时错误并汇报。
3. **组合约束**:preview **默认不传 `wait_for_bridge`**——wait_for_bridge=true 且 bridge 未就绪会终止游戏(`runtime.ts:267-276`),窗口会在用户眼前闪现即逝;仅当确实需要 bridge 查询运行时状态且项目 bridge 就绪快时才组合。

### 4.3 测试策略

- `test/runtime.test.js` / `test/runtime-timeout.test.ts` 补用例:
  - preview=true 不设 autoStopTimer:`vi.useFakeTimers` + `advanceTimersByTime` 快进超时时间,断言进程未被杀(参照 runtime-timeout.test.ts 现有 timeout 测试模式)
  - preview 返回消息字符串断言(预览语义文案)
  - preview + wait_for_bridge 组合行为(bridge 失败仍杀——语义不变,只是规则层引导别组合)
  - 关窗清理路径回归(close handler 现有行为,防 preview 分支破坏)
- 手动验收:真实项目走一遍"改 → 弹窗 → 关窗 → 查错"闭环

### 4.4 边界与错误处理

| 场景 | 行为 | 说明 |
|------|------|------|
| 游戏秒崩 | close handler 清理,AI 从 debug output 拿崩溃报错 | 现有能力 |
| 用户长时间不关窗 | 窗口无限常驻;单槽被占但 headless 验证不受影响;下一轮 preview 自动换窗 | 实测:headless 走独立 `acquireShortRunningSlot`(`src/gdscript-executor.ts:25`),不碰游戏槽 |
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
| 完成前强制检查 | `npm run lint` + `npm run build` + `npm test` 全绿 | AGENTS.md「完成前强制检查」 |
| plan 落地后第三方审查 | 实施完成后产出 `docs/reviews/2026-MM-DD-run-project-preview.md` | AGENTS.md §8 |
| memory 登记 | feature-decision-log + 教训 | AGENTS.md「完成前必登 memory」 |

## 6. 改动量估计

- `src/tools/runtime.ts`:约 15 行(参数 schema + timer 条件 + 返回消息)
- `src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-core.md`:约 10 行 × 2 副本
- 测试:约 60 行
- 版本链:package.json / manifest.json(version-sync)/ CHANGELOG / README 版本行

## 7. 设计轮审阅记录(2026-09-13)

设计者自审 + 两项负载性假设实测:

1. ✅ 输出缓冲上限存在(`process-state.ts:17`,5000 行)
2. ✅ headless 不被游戏槽阻塞(`gdscript-executor.ts:25` 只用 ShortRunningSlot)

发现并已纳入设计的问题:

- **P2-1** preview+wait_for_bridge 闪窗风险 → 规则层引导默认不组合(§4.2.3)
- **P2-2** 游戏窗口生命周期绑定 MCP server → 诚实标注(§4.4)
- **P3** 测试用 fake timers 断言(§4.3);文案英文一致性(§4.1);截图留档 YAGNI 记录(§2)

第三方 code-reviewer 对本设计文档的独立审阅:结论回填至本节(见下方审阅记录);实施完成后的代码级审查另产出 `docs/reviews/` 文档(§5 清单倒数第二行)。

## 8. 开放问题

无——所有设计决策已在设计轮敲定。实施时唯一需现场判断的:preview 消息文案的最终措辞(保持英文 + 含 get_debug_output 引导即可)。
