# 2026-09-19 易用性修复方案

> 输入：`docs/reviews/2026-09-19-易用性审查-用户界面三层.md`（12 MAJOR / 10 MINOR / 6 NIT）。
> 状态：已批准（2026-09-19）。执行时行号以 grep 重定位为准；新计数落盘前 node 实测。
> 基线快照（执行前实测）：totalSum 106402B（desc 15962B + schema 90440B），check:budget warn 线 107520B（余量 1118B）、error 线 122880B。

## Goal

修复审查确认的 12 项 MAJOR + 高价值 MINOR，分 5 个独立批次落地。**零 GDScript 改动、零 Breaking**；结构性大改（action 改名）基于侦察证据明确拒绝并给替代方案。

## 关键决策（含被拒方案）

**拒绝「action 命名统一改名」**（审查 A-4 的根治方案）。侦察证据（Explore 实测，2026-09-19）：
- 34 个域前缀 action（audio/tilemap/particles/signal/uid/translation/animtree 7 域），改名需触碰约 45+ 文件、470 行引用：test/ 316 行（34 文件）、addons/ GDScript 46 处（action 名是 TS↔GDScript 命令协议标识符，双侧耦合，`src/core/editor-method-map.ts` 11 处直通）、src 登记表 31 行（dynamic-risk-map/static-grep）。
- `LEGACY_TOOL_MAP`（`src/core/tool-registry.ts:369-392`）是工具级映射且需 `GODOT_MCP_WARN_LEGACY` opt-in；schema enum 不收旧名则旧调用在校验层直接被拒——action 级别名需新归一化层 + 确认 guard 同步反查。
- 仓库先例 commit `b5dda87c`（2026-08-21）：action 级硬切改名导致规则模板残留旧名 17 处，被迫批量修复 7 文件 69+ 行。
- **替代**：批 2 在 README 工具一览加「命名风格说明」（三种语序各举例一句），help 工具（46/46 文档 + Levenshtein 拼写纠错）继续兜底。

**defer 项**（诚实标注）：schema 注意力面治理/SLIM 恢复（结构性另立项；批 1 顺带压缩超长描述）；README 版本表 86 行与 CHANGELOG 双份维护收敛（动版本表惯例需用户裁决）；dashboard 子命令透传 TUI 参数、未知命令最近邻建议（NIT）；suggestion 覆盖率 15% 推广 android 范式（随未来批次顺手做）。

## 全局约束

- 每批独立分支（`fix/usability-<x>`），master 不直 commit；Conventional Commits。
- 每批门禁：`npm run lint` → `npm run build` → `npm test` 全绿才合并（零 .gd 改动，无需 check:gdscript）。
- 版本策略：**不 bump**——不动 `src/tools/rule-templates.ts` 与 `src/tools/claudemd-builder.ts`（check-rules-version-bump 仅盯这两文件，`scripts/check-rules-version-bump.mjs:16-19` 已核实），变更进 CHANGELOG `[Unreleased]`。若被迫触碰按 AGENTS.md 例外条款停下报告。
- 全部批次完成后：派 code-reviewer 子代理出第三方终审文档 + 登 memory。

## 批次总览

| 批 | 分支 | 覆盖发现 | 改动域 |
|---|---|---|---|
| 1 | fix/usability-tool-desc | A-1/2/3/8/6 | src/tools/*.ts + 生成物 |
| 2 | fix/usability-readme | C-1/2/3/4/6/7/8/9 + A-4 替代 | README/CHANGELOG |
| 3 | fix/usability-cli-seams | B-1/3/4/10 | src/index.ts + src/cli/ |
| 4 | fix/usability-doctor | B-7/8 | src/cli/doctor.ts |
| 5 | fix/usability-webgui | B-12 | src/web-gui/html.ts |

执行顺序 1→2→3→4→5 串行。

## 批 1：工具接口文案对齐

Files：`src/tools/{screenshot,workflow,editor-sync,advanced-proxy,docs}.ts`（英译中，工具级+参数级；`docs.ts:120-181` 透传 Godot 官方数据勿动）；project_path 统一（37 工具 16 变体 → 标准版，8 特化保留）；action 描述补全（23 个 ≤8 字符 → 0）；`runtime.ts`/`validation.ts` 前提补充 + help 引流；压缩超长描述（engine 1240B/script 739B/help 662B/dap 688B/ui 709B）；再生成 `docs/capability-matrix.{json,md}` + `docs/tools/*.md`。

**预算平衡硬约束**：totalSum 净增量 ≤800B（warn 余量 1118B）。action 补全用紧凑格式「操作类型。<一句话概括各值语义>」，仅值不自解释的工具（asset/animation/ui/game 等）逐值解释。

验收：node 扫描——纯英文描述 5→0、project_path 变体 ≤9、action ≤8 字符 23→0；`npm run build-matrix` → `gen:tool-docs` → `check:budget`（无 error、不越 warn）→ lint → build → test 全绿。

## 批 2：README 修复 + 工具一览重构

1. 硬伤：Node 18→20（`README.md:704`）；删环境变量表 626-630 重复两行；补 `ALLOWED_PROJECT_PATHS` 行；596 行 14→15；skills 数量 62/599 统一为 7。
2. 安全体系节补配置示例块（分号分隔 + deny-by-default 一句）。
3. 小白节尾补「接入 AI 客户端→快速开始」链接；快速开始尾补「验证配置成功」小节（doctor + get_godot_version）。
4. 工具一览 blockquote 扩展：action 名 vs 工具名说明、三种命名语序举例、basic profile 激活数（node 实测）+ --profile=full、链接 docs/tools/ 与使用指南.md。
5. 补缺域小节（dap/debug/engine/testing/blender/asset/qa/analysis/csv_to_resources/android/cpp/help/manage_tools/self_update/instances）；Game Bridge 表补 14 个 action。
6. CHANGELOG [Unreleased]。

验收：grep 核对（doctor 操作引用 / docs/tools 与使用指南链接 / 表内 ALLOWED_PROJECT_PATHS / 无重复行）；node 对照 capability-matrix.json 核对一览覆盖 46 顶层工具。

## 批 3：CLI 接缝修补（TDD）

1. `src/index.ts:215` TTY 引导：`process.stderr.isTTY` 时 stderr 两行「stdio MCP 模式…人类用户请跑 --help / setup」（stderr 不污染协议通道，参照 index.ts:14-21 先例）。
2. `src/cli/setup.ts:90` 成功侧补「重启客户端生效 + 验证方式」（参照 skills.ts:105）；零配置侧补 configure --list/--force 指引。
3. `src/cli/init.ts:8` 默认名：TTY 询问、非 TTY 仅提示继续（陷阱：`test/cli/init.test.ts:36-43` 断言无交互建 my-game，confirm.ts:8 非 TTY 返 false 不可当取消）。
4. `src/cli/godot-installer.ts:207` + `web-exporter.ts:75` 取消路径改干净退出（「已取消」+ exit 0，用户主动取消非错误）。

验收：test/cli/* 全绿 + TTY 手动验证。

## 批 4：doctor 诊断增强（TDD）

1. 「Godot 版本」检查：复用 `detectGodotVersion`（会 throw 须 try-catch）；主版本≠4 或 <4.5 → ✗+「支持 4.5–4.7」；4.8+ → ⚠；4.5-4.7 → ✓。
2. `ALLOWED_PROJECT_PATHS` 检查：未设 → ⚠（不置 hasError）+ 配置示例。
3. 全部 ✗ 补修复建议（not configured → setup/configure；project.godot/CLAUDE.md → 项目根目录运行）。
4. 非项目目录时 project 类检查改中性标记（消除满屏 ✗ + exit 0 误导）。

验收：doctor.test.ts 新用例 + 空目录/正常项目两场景手动跑。

## 批 5：web-gui 文案

1. `src/web-gui/html.ts:1033-1035` 401 文案改「面板需经 CLI 打开完成授权——请运行 npx godot-mcp-enhanced dashboard --web」。
2. 写操作按钮区加一行「以下操作会影响运行中的 server/项目状态」提示。

验收：文案 grep 落位 + lint/build/test。

## 总验收

1. 5 批全绿合并；12 项 MAJOR 逐项核对（闭环 10 + defer 2：A-4 被拒有替代、A-7 结构性 defer）。
2. code-reviewer 子代理独立终审 → `docs/reviews/2026-09-19-易用性修复终审.md`。
3. 登 memory（feature-decision-log 含被拒方案证据 + 工程教训）。
4. CHANGELOG [Unreleased] 汇总，不发版。
