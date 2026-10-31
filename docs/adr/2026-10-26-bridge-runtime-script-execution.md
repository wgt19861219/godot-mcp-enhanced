# ADR: bridge 不提供游戏内任意 GDScript 执行通道

- **状态**:已接受(2026-10-26,竞品综述修复方案批 C,用户拍板「维持无任意执行」)
- **背景批次**:docs/plans 竞品综述修复方案(2026-10-25 竞品与头部项目更新综述建议 3)
- **决策者**:用户(方案 AskUserQuestion 确认)+ 本 ADR 论证

## 背景与决策

IvanMurzak Godot-MCP 0.33.0(PR #421,commit 07b67fd)引入「游戏运行中 Roslyn 脚本执行」:agent 发 C# → 运行中的游戏用 Roslyn 编译并在主线程执行,安全边界为双重 opt-in(游戏侧 `GodotMcpCodeExecInGame=true` + csproj 条件编译),默认导出不含该能力且 CI 专项检查导出程序集。

enhanced 的 bridge(Game Bridge 域,`src/scripts/mcp_bridge.gd`)面临同题:**是否提供游戏内任意 GDScript 执行**。本 ADR 决策:**不提供**。维持既有设计:`call_method` 只走白名单分派,`Expression` 明确规避。

## 论证

### 1. enhanced 已有 IvanMurzak 范式的等价物

| IvanMurzak #421 机制 | enhanced 等价物 | 位置 |
|---|---|---|
| 双重 opt-in(游戏侧 env + csproj 条件编译) | 三层白名单:静态 `ALLOWED_METHODS`(22 个只读方法)→ env `GODOT_MCP_BRIDGE_EXTRA_METHODS`(进程级 opt-in)→ per-node `const GDA_CALLABLE` 声明(default deny,沿脚本基类链静态枚举) | `mcp_bridge.gd:183-188, 2094-2107` |
| 不进默认导出 + CI 检查导出面 | `EXTRA_METHODS_BLOCKLIST` 硬底线(set_script/call/queue_free 等 17 项,env/GDA 命中也拒,含 args[0] 内层方法二次检查)——无论怎么 opt-in,结构性危险方法不可达 | `mcp_bridge.gd:195-206, 2109-2116` |
| runtime-security 文档 + headless harness | 双门通道 `install_override`(调试脚本覆盖:`source_script_path` 限 ALLOWED_PROJECT_PATHS 白名单 + risk='write' 确认令牌)+ 文档化的沙箱边界 | `game-bridge.ts:812-867` |

### 2. Expression 规避的既有依据

bridge 刻意不引入 `Expression`(动态求值):Erodenn 竞品规则表将 Expression 列 Tier 1 hard_block(动态代码执行面)。任意 GDScript 执行=把 headless 域的 `execute_gdscript` 沙箱困难整体搬进运行中的游戏进程,且游戏进程没有 headless 的进程隔离(写盘/网络/单例直接触达)。收益(运行态探测)已由 `game_query`/`find_nodes`/`monitor`/`watch`/playtest 快照等只读原语覆盖大半。

### 3. 审计覆盖(批 C 原计划「EXTRA_METHODS 放行记 audit」的勘误,2026-10-26 批 C+D 审查再勘误)

原计划在 GD 侧给 EXTRA_METHODS 放行加审计条目。核查结论:**调用级覆盖已有,method 级追溯未有——原稿「无需新增代码」的等价性夸大,如实修正如下**。G3 审计体系(`audit` after middleware,`ToolDispatcher.ts:655`)对 risk ≠ read 的调用自动落盘 `~/.godot-mcp/mcp_audit.jsonl` + 外置防篡改副本;`game_write`(含 call_method)的 risk='process' ≠ read,**每次调用都落审计**。但 `AuditEntry`(`audit-log.ts:80-98`)**不含 args 字段**——审计粒度只到 `tool=game, action=game_write`,**被调的 method 名不在审计行内**。因此:

- 追溯「何时经 EXTRA_METHODS 通道调过写方法」→ 调用级已覆盖(时间/工具/action/项目全在);
- 追溯「具体放行了哪个 method」→ **现状不覆盖**,属 deferred:若此粒度成为刚需,后续给 game_write 的 audit 记录补 `details.method` 上报(代码改动,单独立批)。

## 重评估触发条件

满足任一可重开本决策(届时须先过安全设计评审):

1. 只读原语无法覆盖的高价值场景成规模出现(如需要读取运行中闭包/信号连接状态的调试工作流,且 `watch`/`get_tree` 明确不够);
2. 上游或社区出现「运行时执行但保住 BLOCKLIST 硬底线」的成熟范式(非 Expression 路线);
3. 用户明确要求实装(届时按 IvanMurzak 双重 opt-in + CI 验证安装面形态单独立批)。

## 关联

- 竞品综述:`D:\GitHub\_notes\2026-10-25-竞品与头部项目更新综述.md`(建议 3,深挖 2)
- 既有安全体系总述:`AGENTS.md`「安全体系(核心护城河)」段
- IvanMurzak 实仓:`D:\GitHub\godot-mcp-series\IvanMurzak-Godot-MCP`(commit 07b67fd)
