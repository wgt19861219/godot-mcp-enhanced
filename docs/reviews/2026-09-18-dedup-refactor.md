# 2026-09-18 代码重复收敛重构——第三方审查报告

> **审查对象**：`b9971d6d..ee7d38fd`（方案 + 五批次 + 终审修复波次，23+2 commits）
> **方案**：`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\plans\2026-09-18-dedup-refactor-plan.md`
> **分析依据（Spec）**：`D:\workspace\Obsidian\GodotMCP\开发日志\2026-09-18 代码重复分析.md`
> **执行账本**：`.superpowers/sdd/2026-09-18-dedup-refactor-plan/progress.md`（会话工作区，含全部 Ruling）
> **审查方式**：每任务级审查（独立 code-reviewer 子代理，spec+quality 双裁决）×6 + 全分支终审（独立 code-reviewer）+ 修复波次 scoped 复审。审查者不预设实现者声明为真，全部 grep/read 实测。

## 总体判定：SHIPPED

五批次行为保真全部经快照零漂移 + 门禁全绿证实；跨批共享基础设施正交无冲突；Global Constraints 十项全链零违反（不触碰清单零触碰、无版本 bump、Conventional Commits 全合规、分层约束无新增 core→tools 依赖与模块级 setter）；终审 2 条必修（合计 3 行）已修复并复审 all addressed；9 条 Minor 经 triage 留档不修（理由见下）。

## 净效果（复测实测，检测脚本与 2026-09-18 分析同源）

| 范围 | 重构前 | 重构后 | 消除 |
|---|---|---|---|
| TypeScript（src/） | 205 块 / 2615 行 / 4.0% | 159 块 / 1847 行 / 2.9% | -768 行重复 |
| GDScript（src/scripts + addons） | 43 块 / 695 行 / 4.1% | 40 块 / 631 行 / 3.8% | -64 行重复 |

GD 剩余 top 全为「不触碰清单」有意冗余（godot_operations↔mcp_bridge 三副本 69 行、mcp_bridge↔engine_commands 跨域、inspect_node↔query_scene_tree 自包含设计、command 模块 setup/cleanup 样板），符合方案预期。

## 批次清单与验证证据

| 批 | 分支 | merge | 核心验证 |
|---|---|---|---|
| 1 animation 生成器收敛 | refactor/dedup-animation | fb94b94d | 锁定测试 10/10 快照零漂移；净 -202 行 |
| 2 material shader 前奏 | refactor/dedup-material | 06fa266c | 锁定 4/4 零漂移；material-ops 86/86；净 -57 行 |
| 3 runOpsScript（10 文件） | refactor/dedup-ops-runner | 73306462 | 逐文件测试绿；errorMapper 原位；净 -37 行 |
| 4 core 四处 | refactor/dedup-core-ts | 605e7a82 | frame-verify 产物字节级不变 + 新增锁定测试；错误文本前缀保留 |
| 5 GD 两处 | refactor/dedup-gd | 2b62cfc5 | `check:gdscript` 两轮 files=40/errors=0/warnings=0；nav 50 测试绿 |
| 6 终审修复 | docs/dedup-review-close | （本报告 commit） | regression 193/193；既有快照零漂移（diff 纯新增机械证明） |

每批门禁：`npm run lint` → `npm run build` → `npm test` 全绿（全量中 ui 域真跑 Godot 的超时 flaky 按"单独重跑绿即放行"判据处置，批 1 另有 stash 对照双证）。

## 实现者的 5 项 Ruling（对方案的必要偏离，全部行为保真优先）

1. **typeVal 用 indexOf+回退 0**（批1）——保住原 `?? 0` 对非法 type 的防御语义（简报示例裸 indexOf 会漂移）；终审实测 TRACK_TYPES 顺序与原 typeMap 枚举逐位一致。
2. **helper 多返回 `full` 键**（批5）——edit_node 尾段 `_verify_saved_scene(full_scene_path, ...)` 需要，简报缺口。
3. **`timeoutSec ?? 30` 兜底**（批3）——简报可选直传写法 strict 下 TS2345 不可编译。
4. **`errorOpts`/`trusted` 可选参数**（批3）——node-3d 的 suggestion 第 4 参与 uid-ops 的 Trusted 通道是简报矩阵漏判的现状（终审复核：helper 未暴露 `_skipSandbox`，安全边界未扩大）。
5. **navigation/physics 的变量 timeout 与条件 warn**（批3）——简报矩阵两处误判（"不显式 timeout"实为 bake_mesh 120s 局部变量；warn 实为 PERSIST_ACTIONS 条件计算），按现状传计算值。

## 终审发现与处置

**必修 2 条（已修复 + 复审 all addressed）**：
- defects.ts:92 白名单 `SIM_HELPERS_GD` 补终止锚定 `\}`（a36c539a）——防未来前缀变体（`_V2`/参数化）静默豁免；三支白名单现全部精确锚定。
- remove 系补 2 个快照用例（ee7d38fd）——批1 收敛后 toBe 等价断言 trivially true，remove 系 MCP 契约改由独立快照锁定。

**留档不修 9 条（triage 理由）**：trackTypeValue() 再抽（两处各 4 行含防御语义注释，收益趋零）；原型链病态输入差异（方向是修复，信息性）；D4 报告数字口径（报告文字非代码）；timeoutSec 兜底不可达可改必填（10/10 调用方显式传，API 收紧留后续）；blender-spawn doc 注释标点半角化（零行为影响）；nav helper 注释多一行 + P0-2 措辞归一化（注释级，简报规定动作）；GD 解包行类型标注（动态类型合法，check:gdscript 零警告）；D1 用例名（已闭环）。

**观察点 1 条（信息级）**：`shared.ts → ops-runner.ts → gdscript-executor.ts → shared.ts` 良性循环 import——gdscript-executor 对 barrel 绑定全部使用点在函数体内（无顶层初始化依赖），ESM live binding + build 零错 + 全量绿佐证无害；未来若在 gdscript-executor 顶层使用 barrel 绑定此环变敏感。

**流程遗留 1 条（移交用户）**：批5 nav helper 的 editor 手工冒烟未做（headless 环境限制；`check:gdscript` 完整编译 + nav 相关 50 测试已覆盖语法与契约层）——建议下次打开编辑器会话时调一次 `nav_create_region` 目视确认。

## 仓库级约束独立核查（不只对照方案清单）

- 「独立副本同步约束」：`rule-templates.ts`/`.claude/rules/` 不在 23 commits 的 Files changed——未触发版本 bump 硬门禁，符合「默认不发版」。
- 「分发产物边界」：无 `build/`、`docs/capability-matrix.*` 手改；工具 name/schema/description 零变更（无需 build-matrix）。
- 「分层约束」：`src/core/headless-process.ts` 零 tools 依赖；ops-runner 的 tools→core import 方向合法；全部新 helper 为纯函数/常量导出。
- 「不触碰清单」：三域 Keep-in-sync 副本、`detectStringConcatBypass`↔`detectBpyStringConcatBypass` 双实现、command 模块 setup/cleanup 样板、inspect_node/query_scene_tree——全部零触碰（终审逐项 grep 实测）。

## 值得进 memory 的工程教训

1. **特征锁定测试（characterization test）先行是生成器类重构的安全网范式**：inline snapshot 首跑 `-u` 固化基线 → 重构后禁 `-u` 复跑零漂移；"快照红 = 代码错，绝不改快照"纪律 + diff 纯新增的机械证明，把"行为不变"从声明变成可验证事实。
2. **收敛会令等价断言平凡化**：两实现合一后 `toBe(a, b)` 恒真失去守护力，需升级为独立 golden 快照（本次终审抓到并修复）——去重重构的测试策略要预设这一退化。
3. **方案/简报与代码现状的偏差要靠实现者现场发现**：本轮 5 项 Ruling 全部是"简报写着 X、代码实为 Y"，执行架构（实现者可上报偏离 + 控制器裁决留痕）比"逐字执行简报"更能保行为。
4. **安全回归谓词的白名单条目必须精确锚定**（开括号/闭括号），裸前缀是探测器盲区的温床。

——审查者：独立 code-reviewer 子代理（任务级×6 + 终审 + 复审），控制器汇总，2026-09-18
