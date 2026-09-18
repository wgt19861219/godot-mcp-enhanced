# Godot MCP Enhanced

> 免费 · 开源 · 安全 —— Godot MCP 赛道里少见提供
> 「系统化安全防护 + 三层架构 + 运行时控制」的开源方案。

给 AI(Claude Code、Cursor、CodeBuddy 等 MCP 客户端)一个能真正读、写、跑、验证 Godot 项目的
工具层:46 个 MCP 工具(merged,共 271 个 action;完整清单见 [capability-matrix](docs/capability-matrix.md))覆盖场景/脚本/UI/动画/物理/粒子/导航/音频/测试/导出/3D 参数化资产(asset:11 shape + 路径阵列 + batch 原子 undo),三层架构
(headless + editor + game bridge)+ 路径白名单 / 注入防御 / sandbox 安全体系。
赛道竞品普遍押注「生成」(authoring),本项目押注「验证」(verification)——QA 编排、回归 diff、操作审计与确定性 playtest 共同构成 **AI 游戏开发的持续验证管线**(CI for AI-assisted game development)。

**[English](README.en.md)** · 工具描述为简体中文,服务中文 Godot 开发者社区;欢迎 i18n PR。

## 小白上手:不用打开 Godot 编辑器也能做游戏

不懂引擎、不想学编辑器?装好 [Godot](https://godotengine.org/download) 后,把需求用一句话告诉 AI(「做一个 2048」「给我的角色加二段跳」),读、写、跑、验证全部由 AI 通过本工具完成,**全程可以不打开 Godot 编辑器**:

1. **说需求** — AI `create_project` 建项目、`quick_scene` / `write_script` 写场景与脚本;
2. **看效果** — `run_and_verify` 真跑一遍并做结构化错误分析,`screenshot`(action `capture`)截图给你看现在的样子;
3. **迭代** — AI `edit_script` 改完自动过 `validate_scripts` 逐脚本编译验证;你只管提意见;
4. **验收** — `qa` 用结构化测试套件起真游戏跑断言(`playtest.seed` 锁随机,同输入可复现);`verify_delivery` 交付门禁检查场景树完整性 + 脚本健康 + 性能;
5. **出错不慌** — editor 层操作全进 Godot 原生 undo 栈,AI 改错一步,打开编辑器一步 **Ctrl+Z** 即回。

**连 Godot 都没装?** 一条命令自动安装(官方 GitHub releases,SHA512 同源校验,零预装):

```bash
npx godot-mcp-enhanced install        # 默认 latest stable;可加版本 tag 如 4.7.2-stable
```

装到 `~/.godot-mcp/godot/<version>/` 并自动登记进搜索链与路径白名单;`setup` 在检测不到 Godot 时也会交互式引导安装。

**直接生成一个能玩的游戏?** 内置可玩模板(四件套:可玩 demo + GDD + qa 确定性套件 + CSV 调参表):

```bash
npx godot-mcp-enhanced init my-game --template=2048    # 或 snake(贪吃蛇)/ breakout(打砖块)
cd my-game
npx godot-mcp-enhanced qa run qa/2048.qa.md --project .   # 真跑游戏跑确定性断言
```

零外部资产(色块占位美术),零编辑器预打开即可运行;改玩法 = 编辑 `tuning/*.csv` → `csv_to_resources` 重导 `.tres` → 重启生效;`design/gdd/` 内置 8 段游戏设计文档(过 `validate_gdd` 校验),AI 拿着它继续迭代。

**一条命令把游玩过程录成 demo GIF**(分享给朋友/发社区):

```bash
npx godot-mcp-enhanced gif . --seconds 8 --fps 4              # 默认方向键;breakout 加 --keys left,right
```

bridge 定频截图 + 按键时间线注入,零依赖自写 GIF89a 编码器(≤256 色精确直通/中位切分量化);产物默认落项目内 `dist/demo.gif`,项目外路径需 y/N 确认。

**导出成网页,浏览器直接玩**(分享链接前先本地试玩):

```bash
npx godot-mcp-enhanced web .            # 自动装 export templates(首次 ~1GB)→ 导出 → 起本地服务器
```

headless `--export-release` 官方路径导出 + `127.0.0.1` 防穿越静态服务器,打印 `http://127.0.0.1:<port>/` 即可浏览器游玩;之后可用 `web --serve-only <导出目录>` 直接重玩。

已在用 [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) 工作室模板?见 **[CCGS × 本项目集成指南](docs/guides/ccgs-integration.md)**——它管设计流程,本项目管真实运行验证。

**不知道从哪开始?** 一条龙向导 skill(`game-wizard`):四档分诊(没想法/模糊/清晰/已有项目)→ 阶段机(环境→造→改玩法→**qa 硬门**→导出→分享),每个 gate 以 qa 退出码为准——「不问文档写了吗,问游戏跑通了吗」:

```bash
npx godot-mcp-enhanced skills install    # 装入 game-wizard(及另外 6 个技能)后对 AI 说「帮我做一个能玩的游戏」
```

> **路线图**:一条龙六批(分发声量/install/模板/GIF/Web/向导)已全部落地;后续方向见 [ROADMAP](ROADMAP.md)。

## 与同类方案对比

> **本项目不追求"工具数量第一"。** 赛道里,godot-mcp-pro 有 175 个工具但闭源收 $15;
> 免费的 Coding-Solo 仅 13 个。真正稀缺的不是工具数量,而是「免费 + 开源 + 系统化安全防护」——安全维度在赛道内几乎无人设防。
> 数据截至 2026-06-27(stars / 工具数 / 价格均可能变化,详见各项目仓库)。

| 维度 | **本项目** | godot-mcp-pro | GDAI MCP | Coding-Solo/godot-mcp | yanhuifair/Godot-MCP [^p4] |
|---|:---:|:---:|:---:|:---:|:---:|
| 价格 | **免费** | $15 买断 [^p1] | $19 买断 [^p2] | 免费 [^p3] | 免费 [^p4] |
| 开源 | **✅ MIT** | ❌ server 预编译闭源 [^p1] | ❌ [^p2] | ✅ [^p3] | ✅ [^p4] |
| 工具数 | **46** ([matrix](docs/capability-matrix.md)) | 175 [^p1] | ~30 [^p1] | 13 [^p1] | 386 [^p4] |
| 安全特性 | **✅ 路径白名单 / 注入防御 / sandbox / 确认令牌 / 输出防伪** | — | — | — | 部分(TCP token) [^p4] |
| 架构 | **三层 headless + editor + bridge** | 单 editor WS [^p1] | stdio [^p1] | headless CLI [^p1] | TS server + 编辑器插件 TCP [^p4] |
| **运行时控制（engine-level）** | **✅ game bridge：读运行时状态 / 输入模拟 / 录制回放 / frame-verify** | ❌ 仅文件·编辑器层 | ❌ | ❌ | ✅ 11 个 runtime 工具 [^p4] |
| **确定性 playtest（冻结/单帧/随机锁定）** | **✅ freeze / step_until 条件步进 / `playtest.seed` RNG 锁定 + fixed_delta / snapshot-restore** | — | — | — | ✅ freeze→step→screenshot(无 RNG 锁定/条件步进)[^p4][^p5] |
| Godot 4.5–4.7 兼容矩阵 | **✅** | — | — | — | —(仅声明 4.x)[^p4] |
| 中文工具描述 | **✅** | — | — | ❌ | ❌ |

[^p1]: https://github.com/youichi-uda/godot-mcp-pro README(含其自带竞品对比表),抓取 2026-06-27
[^p2]: GDAI MCP,数据转引自 godot-mcp-pro 对比表,2026-06-27
[^p3]: https://github.com/Coding-Solo/godot-mcp,抓取 2026-06-27
[^p4]: https://github.com/yanhuifair/Godot-MCP,抓取 2026-08-19(工具数 386 为 `grep -c "registry.register(" src/tools/register.ts` 实测)
[^p5]: 该仓库 README 声称「freeze/step/screenshot **No other public Godot MCP does this**」——与事实不符:本项目的 `playtest.freeze` / `step_until`(结构化条件步进)与 [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)(2025-12 起)的 deterministic playtesting 均早于该声明,供读者自行核对。

_"—" 表示该项目公开 README 未披露相应能力,不代表必然缺失;欢迎 PR 修正。_

> **不只是文件级 bridge,而是 engine-level 运行时控制。**
> 赛道里多数方案(含闭源商业 SaaS)只能让 AI 读写项目文件,**看不到、控不了一个正在运行的游戏**。
> 本项目的 Game Bridge 通过 TCP 连接运行中的游戏:读运行时节点树与属性、GPU viewport 真实截图、属性采样、信号监听、输入模拟、录制回放,外加 `frame-verify` 反作弊验证——让 AI 真正闭环「改 → 跑 → 验证」,而非停在改文件。

> **「确定性」分级:帧步进 ≠ 真确定性。** 赛道里 "deterministic" 一词正被挪用(有项目把 freeze / 固定帧数 step 标注为 Deterministic,却无 RNG 锁定——同输入不同随机状态,结果仍不可复现)。确定性测试其实分三层:
>
> | 级别 | 能力 | 含义 |
> |---|---|---|
> | **L1 帧步进** | freeze / 固定帧 step / 截图 | 能「暂停下来逐帧看」 |
> | **L2 输入时序** | 帧定时输入时间线(`send_input_sequence`) | 锁定「玩家第 N 帧做了什么」 |
> | **L3 真确定性** | `playtest.seed` RNG 锁定 + `fixed_delta` 物理步长锁定 + `step_until` 条件步进 + `snapshot/restore` 状态恢复 | 同输入 + 同 seed ⇒ **跨 run 可复现** |
>
> 本项目三层齐备。截至 2026-08-20,已知竞品最高仅达 L1(freeze/固定帧 step,无 RNG 锁定)或 L2(帧定时输入,无暂停、无 seed)。「AI 测试 AI 写的游戏」要可复现,至少需要 L3。

> **从 [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) 升级?** 见 **[迁移指南](docs/migration-from-coding-solo.md)** —— 核心能力零丢失,获得三层架构 / 安全 / 验证门禁 / 跨版本矩阵增强。

## 安全体系

截至 2026-06-27 调研,Godot MCP 赛道内少见提供系统化安全特性的方案。本项目内置多层防护,
适合对可信边界有要求的开发场景:

- **路径访问控制** — `ALLOWED_PROJECT_PATHS` 白名单(deny-by-default),防 junction / 符号链接绕过
- **Godot 二进制白名单** — `GODOT_MCP_ALLOWED_GODOT_PATHS`（分号分隔,realpath 归一）在 `godot --version` 签名校验之上加硬隔离,防 AI 可控的 `godot_path` 工具参数/项目 override/env 指向任意二进制被 spawn(任意代码执行)。空 env = back-compat 放行(本地信任场景,签名校验仍兜底);多用户/不可信环境显式列可信路径
- **GDScript 注入防御** — 危险 API 模式扫描 + 字符串拼接绕过检测
- **危险操作确认令牌** — 删节点等操作需显式确认
- **输出标记防伪造** — 每次执行随机标记,防 GDScript 伪造 MCP 输出
- **本地运行** — 无远程暴露,无第三方数据上传(注:启动时 update-checker 会查 npm registry,详见下方「匿名遥测」段)

<details>
<summary><b>⚠️ 诚实的边界(展开必读)</b></summary>

以上是**防误操作层**,不是不可绕过的安全边界。GDScript 拥有完整系统访问权限,
沙箱可被间接方式绕过(`call()` 动态分派、多步变量构造 API 名、字符串拼接构造 API 名(如 `"cu"+"rl"`、`str("OS")+".execute()"`)等)。

- 需真正隔离:容器 / VM + `GODOT_MCP_ALLOW_UNSAFE=false`
- 关闭扫描:`GODOT_MCP_SANDBOX=disabled`(仅开发)
- 本工具**仅限本地可信环境**,不提供远程认证或加密

</details>

## 匿名遥测（默认关闭）

**opt-in,默认零外传**。仅当显式设 `GODOT_MCP_TELEMETRY=true` 时启用,且阶段 0 endpoint 默认空 = **不发任何数据出进程**。

- **收集什么**:tool 名 + success bool + duration_ms + 错误分类(经白名单脱敏,非原始文本)+ 加盐 sha256 项目 hash(不可逆推原路径)
- **绝不收集**:源码 / 场景内容 / 文件路径 / 项目名 / editor 日志 / 邮箱 IP 账号
- **install UUID 存哪**:`~/.godot-mcp/telemetry-uuid.txt`(POSIX 0o600)
- **CI 强制关闭**:`CI=true` 时即使 opt-in 也忽略,防 CI 触发合成事件

> **⚠️ 诚实披露 update-checker 外传点**:本仓库每次 MCP server 启动时,`src/core/update-checker.ts` 的 `fetch(REGISTRY_URL)` 会**被动 fetch** `https://registry.npmjs.org/godot-mcp-enhanced/latest`(24h 缓存)。此行为与遥测无关但涉及「数据离开本机」。**v0.25.7 起支持 `GODOT_MCP_UPDATE_CHECK=false`(或 `0`/`no`/`off`,大小写不敏感)关闭启动外传**;`self_update` check action 经 `force:true` 短路此门控,且 risk='read' 不经确认令牌,**AI 可自主调用触发外传**(IP/UA 泄漏 npmjs.org)。严格零外传需防火墙或 readOnly 模式拒整工具。CLI 下载链(`install`/`web` 的 GitHub releases 下载,用户主动触发)是另一独立出网点,详见 [`docs/telemetry.md`](docs/telemetry.md#-诚实披露既有的非遥测外传点)。
>
> **代理环境变量(实测口径)**:Node 原生 fetch(undici)**默认不读** `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 环境变量(Node ≥24 可设 `NODE_USE_ENV_PROXY=1` 启用)。实测设必拒代理端口后 fetch registry.npmjs.org 仍直连 200。企业代理环境下更新检查**实际直连**(可能被防火墙静默拦截);`NO_PROXY` **不是**零外传的有效手段。详见 [`docs/telemetry.md`](docs/telemetry.md) 代理环境变量节。
>
> **⚠️ 诚实披露 vision-router 外传点**: `screenshot` analyze action 设 `vision_route=true` + `GODOT_MCP_VISION_KEY` 时，截图 base64+prompt 外传到 `https://api.groq.com`（groq 视觉模型）。**双重 opt-in 默认零外传**（不传 `vision_route` 或不设 key → fallback 本地 detail 分层，零外传）。可设 `GODOT_MCP_VISION_BASE_URL` 指向自建/ollama/国内中转避免外传到 groq。详见 [`docs/telemetry.md`](docs/telemetry.md)。

## Blender 建模（execute_bpy）安全模型

`execute_bpy` 通过 headless `blender --background` 跑 AI 写的 bpy 片段。**bpy 是全功能 Python，
无语言层沙箱，威胁面 = 宿主 RCE**（读/删任意文件、执行任意命令、网络）——**高于 `execute_gdscript`
的 GDScript 沙箱一个量级**（GDScript 语言层有约束，逃逸才到宿主）。

诚实边界：
1. **glb 导出落点硬约束**：`export_path` 经 `resolveWithinRoot`，仅约束 godot-mcp 注入的 export 行
   filepath，**不约束 bpy 代码内部的 `open()`/`os.remove()`/`os.system()`**。
2. **本地单用户信任模型** + 响应附 `[SECURITY]` warning。
3. 不做 bpy 语法沙箱（正则防不住动态构造 = 假绿），列 backlog。

对比 BlenderMCP：不是"我们防住了它们没防住的"，而是"我们显式声明 fail-model + glb 落点硬约束 +
本地信任模型，BlenderMCP 既无约束也无声明"。

## 核心能力

### 三层架构 — 静态编辑 / 实时调试 / 运行时验证

不是单一连接,而是按场景分工的三层(自动检测,互不冲突):

| 层 | 连接方式 | 适用场景 |
|---|---|---|
| **Headless CLI** | 独立 Godot 进程 | 文件读写、批量创建、一次性验证(默认) |
| **Editor WebSocket** | 连接运行中的编辑器 | 实时操作当前场景、Undo、场景树同步 |
| **Game Bridge** | TCP 连接运行中的游戏 | E2E 测试、运行时调试、输入模拟、状态验证 |

editor 层全部写操作注册进 Godot 原生 undo 栈(10 个生产命令文件、53 处 action 注册,递归含
`commands/asset/` 子目录,核查命令 `grep -rc "create_action" addons/godot_mcp_server/commands/
| grep -v ":0"`)——AI 改错任何一步,编辑器里一步 **Ctrl+Z** 即回;undo 覆盖面为同赛道最宽。

### 动态 GDScript 执行

`execute_gdscript` 让 AI 在 headless 模式执行任意 GDScript:代码片段模式(自动包装 `extends SceneTree`)、结构化输出(`_mcp_output`)、超时控制、Autoload 上下文(`load_autoloads=true`)、结构化错误(类型/文件/行号/修复建议)。

### AI 开发闭环 — 不只是工具堆砌

```
read_scene / read_script → 理解结构 → write_script / edit_script
→ run_and_verify(错误分析)→ validate_scripts → verify_delivery(交付门禁)
```

- **`verify_delivery`** — 端到端交付门禁:场景树完整性 + 脚本健康 + 性能 + 自定义断言
- **`validate_scripts`** — 逐脚本执行 Godot `load()` 编译验证(非项目级完整编译,后者用 `npm run check:gdscript`),捕获 headless 遗漏的 Parse Error
- **`dev_loop`** — 执行 → 验证 → 截图一体化,支持 acceptance 验收标准

闭环示例:AI 用 `read_scene` 理解 → `write_script` 改 → `run_and_verify(capture_tree=true)` 跑+分析 → `validate_project` 查资源 → `batch_add_nodes` 批建 → `import_resources` 注册 → 有问题回到改脚本。

### 批量操作与资源管理

- **`batch_add_nodes`** — 一次调用添加多个节点,只在最后做一次 pack+save,避免每个节点启停 headless Godot
- **`validate_project`** — 静态扫描缺失资源、无效 `preload()`/`load()` 路径、孤立 `.import` 文件
- **`import_resources`** — 扫描目录批量注册资源(图片/音频/字体/3D 模型),自动生成 `.import`

### 结构化开发流程（带 checklist）

对标 agentic skills 方法论（如 obra/superpowers），本项目不止堆工具，还提供 AI 可遵循的结构化开发流程（`setup_project_rules` 生成到 `.claude/rules/godot-mcp-workflow-*.md`）：

- **Bridge E2E 流程** — install → run(wait_for_bridge) → ping → 操作+wait → 截图/frame-verify 留证
- **改→跑→验证闭环** — read → edit → run_and_verify → validate_scripts → verify_delivery
- **安全编辑流** — search_and_replace 优先 / 改后 validate / 防覆盖 / 确认令牌

每个流程带 checklist + 常见偏离提示，让 AI 少踩坑、按纪律走。

## 工具一览

> 共 46 个 MCP 工具(merged tool definition,共 271 个 action),以下按 action 逐项展开全部操作;权威清单见 [capability-matrix](docs/capability-matrix.md)。
>
> **关于「工具数」**:本项目用 merged tool 架构——每个顶层 MCP 工具(如 `scene`)聚合多个 action(如 `read_scene`/`add_node`/`save_scene`)。**顶层工具数:46**(`tools/list` 返回条目数,与 capability-matrix 一致);**action 总数:271**(matrix 的 risk 聚合 read 133+write 112+destructive 10+process 16)。对比竞品统一用「顶层工具数」口径。两个数字均由 `npm run build-matrix` 从代码自动生成,CI 漂移检测守护。

### 执行工具

| 工具 | 说明 |
|------|------|
| `launch_editor` | 启动 Godot 编辑器 GUI |
| `run_project` | 以调试模式运行项目（自动超时；`preview=true` 时窗口常驻至用户关闭，用于改后视觉验证；多项目并行多窗口并存，查错/停止其他项目用 `stop_project`/`get_debug_output` 的 `project_path`） |
| `stop_project` | 停止运行中的项目，返回结构化输出 |
| `get_debug_output` | 获取分类调试输出（错误/警告/打印） |
| `screenshot` | 截图三件套:`capture` 截取游戏画面（Windows 默认窗口模式，Linux/macOS 自动降级）/ `analyze` AI 分析截图内容（元素识别、缺陷检测）/ `diff` 像素级双图对比 |
| `run_tests` | 运行 GUT 单元测试并解析结果 |
| `get_godot_version` | 获取 Godot 引擎版本 |

### 验证工具

| 工具 | 说明 |
|------|------|
| `run_and_verify` | 一键 headless 运行并返回结构化错误/警告分析。支持 `capture_tree` 选项同时获取场景树快照。自动检测版本不一致和脚本语法错误。 |
| `analyze_error` | 重新分析 Godot 输出文本，提供修复建议 |
| `validate_scripts` | 对每个脚本执行 Godot `load()` 编译验证（逐文件解析,非项目级完整编译——后者用 `check:gdscript`）,检测 headless 运行可能遗漏的 Parse Error |

### 动态执行工具

| 工具 | 说明 |
|------|------|
| `execute_gdscript` | 在 headless 模式下执行任意 GDScript 代码。支持代码片段模式（自动包装）和完整类模式。设置 `load_autoloads=true` 可在完整 Autoload 上下文中运行（DataRegistry、PlayerData 等）。 |
| `query_scene_tree` | 加载场景并查询运行时节点树，返回解析后的实际属性值。 |
| `inspect_node` | 深度检查节点：所有属性、信号连接、子节点，支持递归深度控制。 |

### 项目工具

| 工具 | 说明 |
|------|------|
| `list_projects` | 搜索目录中的 Godot 项目 |
| `get_project_info` | 项目元数据 + 文件统计 |
| `list_files` | 列出文件（支持扩展名/子目录过滤） |
| `read_project_config` | 解析 project.godot 为结构化 JSON |
| `create_project` | 创建完整 Godot 项目结构 |
| `setup_project_rules` | 一键配置项目规则（hooks + CLAUDE.md），建议首次使用时运行 |
| `validate_project` | 检查缺失资源、无效脚本引用、孤立 .import 文件 |
| `import_resources` | 扫描目录批量生成 .import 文件（图片/音频/字体/3D模型） |

### 场景工具

| 工具 | 说明 |
|------|------|
| `read_scene` | 解析 .tscn 为节点树 JSON，含属性类型解析（ExtResource/Color/Vector2/Vector3/NodePath/数组/字典/数字/字符串） |
| `create_scene` | 创建新场景 |
| `add_node` | 向场景添加节点 |
| `batch_add_nodes` | 一次调用添加多个节点（比重复 `add_node` 快得多） |
| `save_scene` | 保存场景更改 |
| `load_sprite` | 加载纹理到精灵节点 |
| `edit_node` | 编辑节点属性（位置/缩放/旋转/自定义属性） |
| `remove_node` | 从场景移除节点（需确认令牌） |
| `quick_scene` | 快速创建场景 + 可选脚本（一步到位） |
| `instance_scene` | 实例化 .tscn 场景到目标父节点 |
| `detach_instance` | 从场景树分离实例节点 |
| `diff_scenes` | 比较两个 .tscn 场景文件差异 |
| `merge_scene` | .tscn 冲突解决（三方合并，ExtResource/SubResource ID 重映射） |

### 脚本工具

| 工具 | 说明 |
|------|------|
| `read_script` | 读取 .gd/.cs 文件（含元数据） |
| `write_script` | 写入/覆盖 .gd 文件 |
| `edit_script` | 按行范围编辑 .gd 文件。支持 `raw`/`smart` 缩进模式、内容验证、变更前后对比。 |
| `generate_test` | 分析 .gd 文件并生成 GUT 测试脚本 |
| `create_test_scene` | 创建 GUT 测试运行器场景 |
| `project_replace` | 全项目批量搜索替换（CRLF 安全） |

### 运行时操作工具

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。如需持久化场景修改，请使用 `add_node` + `save_scene`。

| 工具 | 说明 |
|------|------|
| `signal_connect` | 连接两个节点的信号。仅影响当前执行上下文。 |
| `signal_disconnect` | 断开信号连接。仅影响当前执行上下文。 |
| `signal_emit` | 发射节点信号，参数仅支持基础类型（string/number/bool/null）。仅影响当前执行上下文。 |
| `signal_list` | 列出节点上可用的信号。 |
| `physics_raycast` | 执行 3D 射线检测，返回碰撞点、法线、碰撞体信息。 |
| `physics_body_info` | 获取物理体的碰撞形状、AABB、碰撞层/掩码信息。 |
| `node_create_3d` | 运行时创建 3D 节点（支持 16 种白名单类型）。headless 创建不持久化。 |
| `nav_query_path` | 查询 3D 导航路径，支持指定 NavigationRegion3D 或自动回退。 |

### 音频播放控制工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `audio_play` | 播放音频资源。支持 AudioStreamPlayer、AudioStreamPlayer2D、AudioStreamPlayer3D 三种节点类型。 |
| `audio_stop` | 停止指定音频播放器的播放。 |
| `audio_set_param` | 设置音频参数：音量 dB、音调缩放、总线路由。 |
| `audio_query` | 查询播放状态（播放中/暂停/停止）、当前播放位置、总线信息。 |
| `diagnose_physics` | 诊断物理体碰撞状态（含 ConcavePolygonShape3D 陷阱检测）。 |
| `query_spatial` | 空间区域查询：碰撞体距离排序，支持碰撞掩码过滤。 |
| `collision_overlay` | 创建碰撞形状彩色线框叠加（StaticBody=蓝/CharacterBody=绿/RigidBody=红/Area=黄）。 |

### TileMap 编辑工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。如需持久化 TileMap 修改，请使用 `execute_gdscript` 写入 .tscn 或在编辑器中操作。同时支持 TileMap（旧版）和 TileMapLayer（Godot 4.3+ 新版）两种节点类型。

| 工具 | 说明 |
|------|------|
| `tilemap_read` | 读取 TileMap/TileMapLayer 的 cell 数据，返回指定区域内的 tile 坐标、source_id、atlas_coords、alternative_tile。 |
| `tilemap_set_cell` | 设置单个 tile 的源图集和坐标。 |
| `tilemap_erase_cell` | 擦除单个 tile（设为空）。 |
| `tilemap_fill_rect` | 批量填充矩形区域内的所有 tile。 |
| `tilemap_clear` | 清空 TileMap/TileMapLayer 的所有 tile。 |
| `tilemap_copy` | 复制指定区域为模板（内部缓存），用于后续粘贴。 |
| `tilemap_paste` | 将已复制的模板粘贴到目标位置。 |
| `tilemap_set_transform` | 设置 tile 的翻转/旋转变换（水平翻转、垂直翻转、Transpose）。 |

所有运行时工具支持可选 `load_autoloads` 参数（默认 `true`），可在完整 Autoload 上下文中执行。

### API 文档工具

| 工具 | 说明 |
|------|------|
| `get_class_info` | 获取类的方法、属性、信号、常量 |
| `search_classes` | 按名称/描述搜索类 |
| `find_method` | 查找方法详情（含继承链） |
| `get_inheritance` | 获取完整继承链 |

### 材质与着色器工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `material_read` | 读取节点材质属性和 shader uniform 列表 |
| `material_write` | 设置材质参数、创建/附加/保存材质（.tres） |
| `shader_edit` | 读写着色器代码、加载 .gdshader、应用模板、编译诊断 |

### Game Bridge 工具

| 工具 | 说明 |
|------|------|
| `game_bridge_install` | 安装 MCP Bridge autoload 到项目（TCP 服务端,NDJSON 协议,仅 127.0.0.1） |
| `game_bridge_uninstall` | 卸载 MCP Bridge autoload |
| `game_query` | 查询运行中游戏状态（场景树/节点属性/性能/视口） |
| `game_input` | 向运行中游戏发送输入事件（键盘/鼠标/文本） |
| `game_wait` | 在 timeout 窗口内轮询等待游戏状态条件（节点出现/属性值变化），支持 `interval_ms` 探测间隔。条件成立立即返回，超时返回 `timed_out` |

### 工作流工具

| 工具 | 说明 |
|------|------|
| `dev_loop` | 开发循环：执行 GDScript → 验证 → 捕获输出，支持 save_state 文件即记忆 |
| `scene_snapshot` | 场景树快照，用于前后对比检测变更 |
| `batch_validate` | 批量验证多个 GDScript 文件 |

### 动画工具（运行时）

| 工具 | 说明 |
|------|------|
| `animation` | 查询、播放、编辑动画。支持 list_players、get_info、get_details、get_keyframes、play、stop、seek、create、delete、update_props、add/remove_track、add/remove/update_keyframe 等子操作 |

### 性能分析工具（运行时）

| 工具 | 说明 |
|------|------|
| `profiler` | 性能分析：快照（FPS/内存/绘制调用/物理统计）、采样分析、活跃进程检测、信号连接审计 |

### 3D 空间工具

| 工具 | 说明 |
|------|------|
| `spatial_info` | 获取 Node3D 空间信息：transform、AABB、bounds、区域查找 |

### 测试与导出工具

| 工具 | 说明 |
|------|------|
| `test_assert` | 断言场景树状态：node_exists、property_equals、signal_connected、node_count |
| `test_stress` | 压力测试：重复创建/销毁节点检测内存泄漏 |
| `export_list_presets` | 列出项目导出预设 |
| `export_get_preset` | 获取导出预设详情 |
| `export_build` | 执行导出构建 |

### 粒子系统工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `particles_create` | 创建 GPU 粒子节点（GPUParticles2D / GPUParticles3D） |
| `particles_set_emission` | 设置发射参数：形状（point/sphere/box/ring）、半径、方向、扩散 |
| `particles_set_process` | 设置处理参数：重力、速度、爆炸性、生命周期、阻尼 |
| `particles_load_preset` | 加载预设效果：fire / smoke / rain / snow / sparkle / explosion |
| `particles_set_material` | 创建或重置 ParticleProcessMaterial |

### 导航工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `nav_create_region` | 创建 NavigationRegion3D 并可选烘焙导航网格 |
| `nav_bake_mesh` | 烘焙导航网格（长时间操作） |
| `nav_create_agent` | 创建 NavigationAgent3D 并设置寻路参数 |
| `nav_set_params` | 设置导航代理参数（10 个可配置字段：radius、height、max_speed 等） |
| `nav_create_link` | 创建 NavigationLink3D 连接点（支持双向） |

### AnimationTree 工具（运行时）

> **注意：** 运行时操作仅在 headless 执行上下文中生效，不持久化到 .tscn 文件。

| 工具 | 说明 |
|------|------|
| `animtree_create` | 创建 AnimationTree 节点（支持 AnimationNodeStateMachine / BlendTree / BlendSpace2D） |
| `animtree_add_state` | 向状态机添加动画状态（AnimationNodeAnimation） |
| `animtree_add_transition` | 在状态间添加转换（含交叉淡入淡出时间和条件） |
| `animtree_set_blend` | 设置混合参数（float 用于 BlendTree，Vector2 用于 BlendSpace） |
| `animtree_play` | 切换到目标状态（通过 playback.travel） |

### IK 框架工具（运行时）

| 工具 | 说明 |
|------|------|
| `ik_modifier_create` | 创建 IK 修改器节点（TwoBoneIK3D / FABRIK3D / CCDIK3D / SplineIK3D / JacobianIK3D） |
| `ik_modifier_get` | 读取 IK 修改器属性 |
| `ik_modifier_set` | 设置 IK 参数（active、influence、bone_name、target、magnet） |
| `ik_list_bones` | 列出 Skeleton3D 骨骼 |

### 验证交付工具

| 工具 | 说明 |
|------|------|
| `verify_delivery` | 端到端交付验证：场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 标准合规 |

### 游戏设计工具

| 工具 | 说明 |
|------|------|
| `validate_gdd` | 验证游戏设计文档是否符合 8 章节标准（概述、玩家幻想、详细规则、公式、边界情况、依赖、调优旋钮、验收标准） |
| `chain_verify` | Chain-of-Verification 自我质疑引擎：对审查结论生成 5 个挑战性问题，防止盲点和过度自信 |

### 代码模板工具

| 工具 | 说明 |
|------|------|
| `list_templates` | 列出可用代码模板（内置 + 用户自定义） |
| `apply_template` | 应用代码模板到指定脚本（支持变量替换） |

### UI 布局工具（运行时）

| 工具 | 说明 |
|------|------|
| `ui_create_control` | 创建 UI Control 节点 |
| `ui_build_layout` | CSS Flexbox/Grid 翻译层，从声明式布局描述构建 Godot Container 树 |
| `ui_set_layout` | 设置 Control 节点布局属性（锚点/偏移/最小尺寸） |
| `ui_get_layout` | 查询 Control 节点布局信息 |
| `ui_anchor_preset` | 应用锚点预设（full_rect/center/top_wide 等 16 种） |
| `ui_set_theme` | 设置/创建/保存/加载 Theme |
| `ui_container_add` | 向 Container 添加子 Control 节点 |
| `ui_draw_recipe` | 声明式绘图操作（rect/circle/line/arc/polygon/string） |
| `theme_create` | 创建空 Theme 或从节点提取 Theme |
| `theme_set_property` | 设置 Theme 属性（font/color/constant/stylebox） |

### 录制工具

| 工具 | 说明 |
|------|------|
| `recording_start` | 开始录制输入事件（键盘/鼠标） |
| `recording_stop` | 停止录制并返回事件数据 |
| `recording_save` | 保存录制到 JSON 文件 |
| `recording_load` | 加载录制文件 |
| `recording_play` | 回放录制的输入事件 |

### 编辑器同步工具

| 工具 | 说明 |
|------|------|
| `editor_sync_start` | 启动场景树实时监听（推送 node_added/node_removed 事件） |
| `editor_sync_stop` | 停止场景树监听 |

### 资源管理工具（UID / 翻译）

| 工具 | 说明 |
|------|------|
| `uid_scan` | 扫描项目内全部资源文件的 UID 状态（Godot 4.4+ `.uid`）：缺 `.uid` 的资源、孤儿 `.uid`（主文件不存在） |
| `uid_get` | 查询文件 UID（单个/批量，`res://` 路径） |
| `uid_set` | 写 `.uid` 文件：指定 uid / 按路径确定性生成（与编辑器一致）/ `fix_missing` 批量修复缺失 |
| `uid_check_refs` | 扫描文本资源中的 `uid://` 引用，检测悬空引用（引用的 UID 不在项目 `.uid` 集合中） |
| `translation_read` | 读 CSV（Godot 国际化表格）/ PO（gettext）翻译条目（语言 + 键值对，支持截断） |
| `translation_write` | 写/创建 Godot 兼容 CSV 翻译表（`keys` + 每语言一列；CSV→`.translation` 编译由编辑器导入完成） |
| `translation_register` | 把 `.translation`/`.po` 资源注册进 `project.godot` 的 `internationalization/locale/translations`（`remove=true` 反向移除） |

> ⚠️ 运行时工具(物理 / 动画 / UI / 粒子 / TileMap / 材质等)仅在 headless 执行上下文生效,
> **不持久化到 .tscn**;需持久化用 `add_node` + `save_scene`。

## MCP 资源（Resources）

AI 客户端可通过 `godot://` URI 方案发现和读取项目上下文，无需显式工具调用。

### 静态资源

| URI | 说明 |
|-----|------|
| `godot://project/info` | 项目元数据 + 文件统计（JSON） |
| `godot://project/config` | 原始 `project.godot` 文件 |

### 资源模板

| URI 模式 | 说明 |
|----------|------|
| `godot://scene/{path}` | 读取 `.tscn` 场景为节点树摘要 |
| `godot://script/{path}` | 读取 `.gd` 脚本文件 |
| `godot://file/{path}` | 读取项目中任意文本文件 |

### 安全限制

- 路径必须在项目根目录下（禁止 `../` 遍历）
- `.godot/`、`.import/`、`node_modules/` 目录被阻止
- `.import`、`.uid`、`.godot` 文件扩展名被阻止

### 使用示例

```
Client: ListResources → 发现所有场景和脚本
Client: ReadResource("godot://project/info") → 项目配置 + 统计
Client: ReadResource("godot://scene/scenes/main.tscn") → 节点树摘要
Client: ReadResource("godot://script/scripts/player.gd") → GDScript 源码
```

## 快速开始

### 1 分钟配置（推荐）

#### Claude Code — 全局安装（所有 Godot 项目自动可用）

```bash
claude mcp add -s user godot -- npx -y godot-mcp-enhanced
```

> **为什么用 `-s user`？** Godot MCP 是个人开发工具，你会在多个 Godot 项目中使用它。`-s user`（user scope）将配置写入 `~/.claude.json` 顶层，所有项目自动连接，无需每个项目重复安装。详见 [Claude Code MCP 文档](https://code.claude.com/docs/zh-CN/mcp#mcp-installation-scopes)。

如果你只想在当前项目使用（不推荐，切项目会丢失）：

```bash
claude mcp add godot -- npx -y godot-mcp-enhanced  # local scope，仅当前项目
```

#### Cursor / Cline / Windsurf / 其他
在项目的 `.cursor/mcp.json` 或 MCP 配置中添加：

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "godot-mcp-enhanced"]
    }
  }
}
```

#### 腾讯 CodeBuddy（国内用户）
CodeBuddy 文档（2026-06-27 实测）支持外部 stdio MCP Server：**设置 → MCP 标签 → Add MCP**，粘贴与上面相同的 json。也可从其 MCP Market 一键安装（上架后）。
> ✅ 端到端已验证（2026-07-01）：CodeBuddy IDE 内 `read_scene` 读 `main_3d.tscn` 成功（返回完整场景结构），stdio MCP 接入跑通。解锁 MCP Market 上架（#10）。

#### Warp
[Warp 终端](https://www.warp.dev/) 原生支持 MCP。**Settings → Agents → MCP servers → + Add → CLI Server**，粘贴与上面相同的 json（`command: npx`、`args: ["-y", "godot-mcp-enhanced"]`）；也可写入 `~/.warp/.mcp.json`，或开启「Auto-spawn servers from third-party agents」直接复用上面的 Claude Code 配置（零额外配置）。
> ✅ 协议层实测通过（46 工具全发现、inputSchema 完整、无 integer 参数兼容风险）；⚠️ Warp GUI 端到端待补（本机未装 Warp）。完整步骤、兼容性核对表、env / `working_directory` 说明见 [使用指南-Warp](docs/使用指南-Warp.md)。

#### ZCode（智谱 GLM-5.2 ADE）
[ZCode](https://zcode.z.ai/) 原生支持 MCP。**设置 → MCP 服务器 → 新建**（stdio，`command: npx`、`args: ["-y", "godot-mcp-enhanced"]`），或写入 `<项目根>/.zcode/config.json` / `.agents/mcp.json`。**关键**：ZCode 不读 `CLAUDE.md`，只读 workspace 根 `AGENTS.md`——运行 `setup_project_rules`（默认双写）生成 `AGENTS.md` 让 godot 规则生效。
> 完整步骤、三种配置方式、env / 权限矩阵 / AGENTS.md 注入说明见 [使用指南-ZCode](docs/使用指南-ZCode.md)。

### 一键配置
```bash
npx godot-mcp-enhanced setup
# 自动检测：Godot 路径 + AI 客户端 + 写入配置

npx godot-mcp-enhanced configure warp
# 定向配置单个客户端（--list 列出全部 14 个，--force 越过未检测闸）

npx godot-mcp-enhanced skills install
# 打包的 6 个 Claude Code skills（路由器/安全编辑/验证闭环/bridge E2E/截图留证/Tween 审计）
# 一条命令装入 ~/.claude/skills/（--target <目录> 装项目级，--force 覆盖），
# 指导 AI 更好地调用 godot-mcp 工具——安装摩擦低于手工 MCP 配置，配合 configure 使用
```

### 首次使用

连接 Godot 项目后，建议立即运行以下工具一键配置项目规则：

```
setup_project_rules(project_path="你的项目路径")
```

这会自动生成：
- **`.claude/settings.json`**：PostToolUse hook，每次编辑 `.gd` 文件后自动提醒 AI 运行 `validate_scripts` 验证语法
- **`CLAUDE.md`**：项目级规则，包含 GDScript 验证规则和发版门禁（`verify_delivery` 检查）

如果已有配置想更新，使用 `force=true` 覆盖。如只需其中一项，用 `hooks=false` 或 `claude_md=false` 跳过。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GODOT_PATH` | Godot 可执行文件路径 | 自动搜索（PATH/注册表/Scoop/Downloads） |
| `GODOT_PROJECT_PATH` | 默认项目路径 | 自动检测 cwd（向上搜索 project.godot） |
| `GODOT_MCP_SEARCH_PATHS` | 额外 Godot 搜索目录（分号分隔） | 无 |
| `GODOT_MCP_ALLOWED_GODOT_PATHS` | Godot 二进制路径白名单(分号分隔,realpath 归一)。空=回落 `~/.godot-mcp/godot-paths.json`(CLI `install` 登记的路径视为可信);两者皆无=back-compat 放行(签名校验仍兜底)。设了 env 则 env 优先(显式用户意图,config 被忽略);多用户/不可信环境显式列出可信 Godot 路径,防 `godot_path` 工具参数/项目 override/env 指向任意二进制被 spawn(任意代码执行) | 空(回落 config) |
| `GODOT_MCP_BRIDGE_PORT` | game bridge 起始监听端口（被占自动递增避让至 +9;多实例并存安全,实际端口写入实例 registry,ping 响应带 pid/project 指纹） | `9081` |
| `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` | `true`=confirm 类写操作跳过 out-of-band 确认（⚠️ 削弱安全防线;生产环境设此值 server 拒绝启动,详见使用指南 12.12） | `false` |
| `DEBUG` | 启用详细日志 | `false` |
| `GODOT_MCP_BRIDGE_PORT` | game bridge 起始监听端口（被占自动递增避让至 +9;多实例并存安全,实际端口写入实例 registry,ping 响应带 pid/project 指纹） | `9081` |
| `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` | `true`=confirm 类写操作跳过 out-of-band 确认（⚠️ 削弱安全防线;生产环境设此值 server 拒绝启动,详见使用指南 12.12） | `false` |
| `GODOT_MCP_TELEMETRY` | 匿名遥测 opt-in(默认关闭,详见 [docs/telemetry.md](docs/telemetry.md)) | `false` |
| `GODOT_MCP_INSTALL_TAG` | CLI `install` 固定版本 tag(如 `4.7.2-stable`,跳过 latest 查询;测试/复现用) | 未设(latest) |
| `GODOT_MCP_PROFILE` | 工具 profile(basic/lite/minimal/full/bridge_dev/3d_dev 或逗号组名)。**默认 basic**(BREAKING from full;lite 9 组省 ~60% context,RCE action 经 action-gate 默认 gated)。回退全量:`GODOT_MCP_PROFILE=full` 或 `--profile=full` | `basic` |

> **⚠️ BREAKING(G7)**:默认 profile 从 `full` 改 `basic`(对齐 GoPeak compact,省 AI context window)。升级后 tools/list 只暴露 basic(lite 9 组:core/bridge/animation/audio/signal/visual/code/test/profiler)。回退全量 46 工具:`GODOT_MCP_PROFILE=full`;或 AI 运行时 `manage_tools activate <groups>` 动态扩容(无需重启)。RCE action(execute_gdscript 等)始终经 action-gate gated,需 `GODOT_MCP_PRIVILEGED_GROUPS=code-execution` 解锁。

> **注意：** 项目路径有 30 秒缓存。切换项目后等待 30 秒或重启 MCP server 使新路径生效。

### 多版本 Godot 支持

如果你使用 [godots](https://github.com/MakovWait/Godots) 等版本管理器管理多个 Godot 版本，可以为每个项目单独指定 Godot 二进制路径。

**优先级**：工具参数 `godot_path` > 项目配置 > `GODOT_PATH` 环境变量 > PATH > 平台搜索

#### 方式一：项目配置文件（推荐）

在项目目录下创建 `.godot/mcp-godot.json`：

```json
{
  "version": 1,
  "godot_path": "/path/to/Godot_v4.6.3-stable_macos.arm64"
}
```

#### 方式二：project.godot 配置段

在 `project.godot` 末尾添加：

```ini
[godot_mcp]
godot_path=/path/to/Godot_v4.6.3-stable_macos.arm64
```

#### 方式三：工具参数

在 MCP 工具调用时传入 `godot_path` 参数（如 `run_project`、`execute_gdscript` 等 10 个核心工具均支持）。

#### 方式四：godots 版本管理器自动检测

在项目根目录创建 `.godot-version` 文件（内容为版本号，如 `4.6.3`），MCP server 会自动在 `~/.godots/versions/` 中查找对应版本。

### 手动配置（高级用户）

<details>
<summary>展开查看手动安装步骤</summary>

```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install && npm run build
```

在 MCP 配置中指向 `build/index.js`，并设置所需环境变量。

</details>

## 致谢

- [godot-mcp](https://github.com/Coding-Solo/godot-mcp) — 原始项目，本项目基于其二次开发（Copyright (c) 2025 Solomon Elias，MIT，见 [LICENSE](LICENSE)）
- [Hastur Operation Plugin](https://github.com/rayxuln/hastur-operation-plugin) — 动态 GDScript 执行和结构化输出的灵感来源
- [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) — 借鉴了以下功能概念(在用 CCGS?见 **[集成指南](docs/guides/ccgs-integration.md)**):
  - **Hooks + Rules 体系** → `setup_project_rules` 自动生成 `.claude/settings.json`（PostToolUse hook 自动验证 GDScript）和 `CLAUDE.md`（项目编码标准）
  - **Gate-check / verify** → `verify_delivery` 端到端交付验证（场景树完整性 + 脚本健康 + 性能 + 自定义断言 + GDD 合规）
  - **Workflow pipeline** → `dev_loop` 执行→验证→截图一体化工作流，支持 `acceptance` 验收标准和 `save_state` 会话记忆
  - **GDScript Lint** → `validate_scripts` 内置的静态 lint 层（L015 行级扫描 + 字符串/注释过滤，独立于 load() 编译检查），对标 CCGS 的 `validate-commit.sh`
  - **GDD 标准** → `validate_gdd` 8 章节游戏设计文档结构校验，对标 CCGS 的 `design/gdd` 路径规则
  - **Chain-of-Verification** → `chain_verify` 自我质疑引擎，防止审查盲点
  - **代码模板** → `list_templates` / `apply_template` 模板系统，对标 CCGS 的 41 个文档模板

## 系统要求

- Godot Engine 4.x（已测试 4.7；4.6/4.5 向后兼容）
- Node.js >= 18
- GUT 插件（用于 `run_tests` 工具）

<details>
<summary><b>截图功能平台说明</b></summary>

`screenshot`（action `capture`）根据平台使用不同的渲染策略：

| 平台 | 模式 | 说明 |
|------|------|------|
| **Windows** | 窗口模式（默认） | Headless 模式下 viewport 纹理返回 null，必须使用 GPU 上下文 |
| **Linux** | Headless → 窗口模式降级 | Headless + OpenGL3 取决于 GPU 驱动是否支持 |
| **macOS** | Headless → 窗口模式降级 | 与 Linux 相同 |

内置 `screenshot_capture.gd` 使用 `process_frame` 信号模式和 `call_deferred()` 确保场景加载和帧捕获的可靠性。

> **测试提示：** 仓库的 E2E 测试（`test/e2e-*.test.ts`）依赖真实 Godot 二进制。设置 `GODOT_PATH` 指向本地 Godot 以运行它们；未设置时这些测试被静默跳过（控制台打印 `[E2E-SKIP]` 告警），**CI 默认不验证真实 Godot 集成**——`npm test` 的"全部通过"仅覆盖 TS/GDScript 逻辑，不含真实 Godot 子进程行为。

</details>

## 许可证

[MIT](LICENSE) — 含上游 [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) 版权（Copyright (c) 2025 Solomon Elias）。

## 路线图

项目方向与里程碑(M1 定位与声量 / M2 健壮性 P0 / M3 安全 P1 / M4 功能补齐 P2)见 [ROADMAP.md](ROADMAP.md)。

## 更新日志

> 完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 日期 | 要点 |
|------|------|------|
| **v0.33.8** | 2026-09-18 | **2026-09-17 架构审查批 5（O1 哨兵延迟通道收敛,M-7）**：五条延迟通道（call_method await/click real_event/playtest.step/step_until/input_sequence）从"handler 临时变量×5 + 五种哨兵字符串 + 消费端五段 elif"归一为单例槽 `_deferred`——handler 平铺返 `{"__deferred__": kind,...payload}`、识别端单键 id 并入、消费端按 kind 分派;行为守恒由 e2e 守恒网保证（playtest.step 补真机用例,五命令全覆盖,重构前后同绿）,契约测试断言锚同步 7 文件;净 -10 行。 |
| **v0.33.7** | 2026-09-18 | **2026-09-17 架构审查批 4（bridge 行为对称）+ 批 2/3 定版随行**：①M-5 uninstall 判活护栏——删 secret 前查 machine registry 新鲜心跳，在跑实例的 secret 保留并点名（原行为无条件删光，多实例在跑时 TS 侧重连即断）；②M-6/O3 sync_state 快照记录来源 project/port，compare 跨项目比对置 `cross_project` 警告、同 label 跨项目覆盖响应带 overwrote 警告（静默覆盖/无意义 diff 消除）；③M-8 -32601 错误自动补 ping 版本比对——非 ping 路径撞项目内旧版 mcp_bridge.gd 也能看到 `versionWarning` 重装指引；④心跳 `lastSeenMs` 毫秒精度 + pid 平票决胜（同秒双开不再靠目录顺序摇摆）+ `_doConnect` 端口单次解析（secret 读取与 TCP 连接同源，TOCTOU 消除）；⑤批1 终审 I-1：addons editor 命令族 40 处 `int/float(params.get(...))` 裸转守卫收口（H-2 覆盖盲区，command_helpers 建 `num_guarded`/`int_guarded` 三副本守卫 + 全命令族契约负向断言）。随行定版批 2（dap closeAll/profiler 直关/inflight 双清/首连装配归位控制面）与批 3（web-gui token 恒定时间比较/rotate-token/READ_ONLY 入口页短路/CSP sha256 等 M-1~M-4+Low×5）。 |
| **v0.33.6** | 2026-09-17 | **2026-09-17 架构审查 H-1/H-2 收口（bridge 参数守卫统一收口）**：①`_math_comp` 分量类型白名单——set_node_property 数学属性 `position={"x":{}}` 容器/null 分量穿透到 `float()` 即 SCRIPT ERROR（同步分发无异常隔离→响应静默 result:null），白名单外返 null 走上游 -8 可读错误；②新增 `_int_guarded` int 守卫（对齐 `_num` 先例：仅整值/合法数字串放行），19 处 `int/float(params.get(...))` 裸转全量替换（get_tree/find_nodes/monitor/watch/ui/playtest/step_until/弱网注入/touch·drag index），深预检首步 `int(e["at_frame"])` 毒参数回 0 落入既有 1-600 可读报错分支；③契约测试负向断言扩全文件（`int(params.get(`/`float(params.get(`` 禁绝，批次C只扫两函数致漏网的教训）。 |
| **v0.33.5** | 2026-09-17 | **插件反馈批次 C（输入注入）**：09-10「send_mouse_click 对非 Button 控件 gui_input 不触发」与 09-12「headless 注入整链不派发」双双真机定谳为上游不可复现（带窗口+headless 双形态 e2e：Button pressed/Control gui_input/tap 判定链全通）；①注入事件显式 device=0 对齐真实管线（global_position 早已在位，timeline 自动跟随）；②send_mouse_click/touch x/y 裸 float() 收口 _num 守卫（I-C 漏网点——null 参数 SCRIPT ERROR 静默变 result:null）；③bridge 规则双副本补「输入注入管线要点」（坐标口径/排查清单/复杂交互引导，触发 0.33.5 bump）。 |
| **v0.33.4** | 2026-09-17 | **插件反馈批次 B（scene 序列化：tscn 损坏/数据丢失类）**：①headless 白名单补 TextureButton/ColorRect（29→31 种，三方+规则模板双副本同步）；②add_node 单发 texture 裸字符串（纹理静默丢失）与属性裸数组（color 静默回退默认值）——文本捷径对 res:///uid:// 字符串与 Array 一律 fallback GD 链（load+数学 coerce 后 pack 自动 ExtResource/Color 构造器，真机验证），与 batch 路径对齐；③单发 parent 含场景根名前缀（query_scene_tree 拷贝形态）剥根名对齐 GD 链；④scene 写操作落盘自检——TS 文本路径落盘前 parse 链可达校验（断链拒写）+ GD 六写 handler 落盘后 CACHE_MODE_IGNORE 回读计数比对（损坏 exit 1 非静默成功）。 |
| **v0.33.3** | 2026-09-14 | **per-project 运行会话分桶**：`run_project` 多项目并行（多窗口并存，上限 `GODOT_MCP_MAX_SESSIONS` 默认 4；同项目重复 run 先停旧进程）；`stop_project`/`get_debug_output` 加 `project_path` 跨项目查错（快照 per-project，关窗后仍可查）；修并发互杀（C-1 主流程 per-key 写入）/orphan 30s 扫描误杀非活跃窗（排除集合改全部活进程+节流分桶）/profiler 被无关 run 销毁（跟随最近 profiling 会话）/FIFO 残留误逐出活跃桶；audit 归属活跃桶 + logger JSONL 加 `project` 字段。规则模板补多项目说明。 |
| **v0.33.2** | 2026-09-13 | **预览模式**：`run_project(preview)` 禁自动停止、弹常驻游戏窗口（AI 改完视觉验证，替代开编辑器）+ 输出快照（`get_debug_output` 关窗后仍可查错，`source` 标注；顺带修 `stop_project` 报告空 bug）。规则模板加「视觉改动收尾流程」。 |
| **v0.33.1** | 2026-09-13 | **竞品启发加固批(2026-09-01 完成延迟合并)**:①monitor 输出可解释性(对标 satelliteoflove)——properties 返回过滤后实际监控列表+`dropped_blocked` 逐个点名被滤属性+数值极值摘要 summary(min/max 及发生帧/时刻,仅数值属性)接入 stop/poll 三出口,UTF-8 跨 chunk 免疫固化;②GODOT_PATH 指向目录显性报错(对标 godot-ai),替代静默 fallback 掩盖配置错误;③fs-atomic 共享原子写上移 core(对标官方 servers)——三份重复实现收口+七处高危覆盖点接入(save_scene/quick_scene/edit_script/scene-instance/translation/game-bridge/overrides),覆盖用户资产的自写 tmp+rename 清零。冲突融合:monitor 字段与 P0 游戏时间调度三路合流/rules 双副本同款融合/overrides 保 L-1 缓冲落盘+原子写/scene 保 P1 FileGuard+writeAtomic。规则模板变更触发 bump。46 工具/271 action。 |
| **v0.33.0** | 2026-09-13 | **全仓功能审查修复批(patch→minor 口径归位)**:4 分域审查代理+主审横扫 46 工具/271 action(报告 `docs/reviews/2026-09-12-全仓功能审查.md`)——2 BLOCKING(S-B1 project_replace 写 .gd 绕过沙箱扫描→批量原子检查整批拒;G-B1 step_until 完成判定嵌循环体→AND 语义破坏+双 remove 越界中断 _process/误删相邻条目)+ 14 IMPORTANT(dap output 200 条稳态永久静默失效/DAP 断连重建绕过+断点簿记路径规范化/game_wait 单 probe 超时烧光总预算/sync_state 丢 truncated 标志/未认证空行保活 DoS/websocket_server 标量 JSON 崩溃瘫痪 WS/collect_state freed 守卫/cmdline 标记窃取链拦截/协程 quiesce 失真等)+ 13 MINOR,22 修+10 备案;S-I1 scrub 修复撤销(固定常量是 C-09 公开契约——契约 vs 漏洞判定教训)。版本号自本批起按变更性质判级:P0-P10 功能批次归位 minor 边界(此前 patch 链为规则模板硬门禁机械触发)。46 工具/271 action。 |
| **v0.32.21** | 2026-09-12 | **P10 批(多人状态同步)**:game 工具新增 sync_state(masteryee 移植裁剪)——快照/比对两段式:GD 侧 collect_state 收集 `_mcp_state() -> Dictionary` 约定节点(离散状态;group 成员存在性标记;Object 递归降级;256 节点/深度 8 上限),TS 侧 snapshot/compare/list/clear+compareStates 纯函数递归比对(**浮点容差默认 0.0001——masteryee 亲读坑修复:dict 严格相等在真实多人游戏因物理步进浮点微差永远 false**);键级 diff 输出 missing/diffs;不做进程编排(设计偏离:InstanceManager 是 server 注册表非游戏编排,多实例由用户起在各端口借连接切换打快照)。42 仓尽调行动清单 11 项至此全部落地。46 工具/271 action。 |
| **v0.32.20** | 2026-09-12 | **P9 批(DAP 断点调试)**:新增第 46 个顶层工具 dap——MCP server 作为 DAP client 直连 Godot editor 自带 DAP server(默认 127.0.0.1:6006,引擎官方调试协议),18 action 全会话流(initialize→launch→set_breakpoint→configuration_done→断点命中后 stack_trace/step_over/continue/pause→disconnect);TS 侧 node:net 直连(无 GD 改动,LuoxuanLove 791 行 GD 移植的架构偏离:frame 编解码缩到 ~40 行);三段状态机+断点簿记全量重发(512×256 上限)+SENSITIVE_KEYS 双层清洗(防调试输出泄漏 secret)+loopback 强制;SSOT 审计器首战抓出 3 个未声明键(防线自证);已知边界:只 GDScript/attach 有限/e2e 用 mock DAP server(真 editor 手动路径文档化)。46 工具/270 action。 |
| **v0.32.19** | 2026-09-12 | **P8 批(热加载状态机/参数 SSOT 双防线)**:P8-1——mcp_commands 自定义命令热加载(LuoxuanLove 移植):运行中改/增/删 .gd 自动重载无需重启(mtime+300ms debounce),quiesce 语义(调用中不换实例),失败回滚旧版本继续服务(reload_failed+last_error),重名先注册者赢,`custom.list` 内建诊断,env 可关;关键设计 GDScript.new() 独立加载(不走 ResourceLoader:同路径 load 即使 CACHE_MODE_IGNORE 也就地污染共享资源、旧 Callable 失效——e2e 实测);已知边界:语法坏文件触发 Script Debugger REPL(引擎层)。P8-2——unknown-param 顶层拒绝 + did-you-mean(regiellis 移植,additionalProperties 静默容忍语义反转,拼写建议 Levenshtein>0.4)。P8-3——SSOT 审计器(check:ssot-params,CI 阻断:文件自证归属+声明面↔使用面对账+白名单例外)+ SLIM_CONFIG ui 条目移除(schema 恢复 39 键,P8-2 上线必要补全)。45 工具/252 action。 |
| **v0.32.18** | 2026-09-11 | **P6+P7 批(tokenizer 沙箱/语义观察层)**:P6——GDScript tokenizer 结构化扫描整文件移植(432 行,成员链合并/字符串归一化/首参三分类)+ scanGdscriptSandbox Phase 3 非字面量 load/preload 拦截(堵正则盲区)+ executeGdscriptRuntime 三通道分层(15 runtime 工具只跳 Phase 3 保留 Phase 1/2 防线;架构判断不移植 Erodenn 三级 tier——execute_gdscript 已 100% 确认令牌,Tier 2 重复建设且降级是安全回退)。P7——语义观察层(gua 移植,经独立审查 BLOCKING 清偿后全覆盖):观察通道 observation_profile 参数(debug 直通/player 投影;env 三态门禁:单值 player=host 强制档防 agent 自降级绕过,多值=请求级可选)+ 可见性级联(agent_exposure=private/visible_to_player=false 沿祖先链整藏子树,不可观察节点报 not found 存在性不泄露)+ 字段策略五模式(agent_field_rules meta:omit/redact/replace/quantize/keep,坏规则 fail-closed 降级 redact,运行中改 meta 即时生效)+ **审查 B-1 清偿四读出口全覆盖**(get_tree 整枝剪除/wait exists 与 match 基于投影值/report 搭车与 conditions 同语义/call_method get 投影+结构枚举方法 -22+snapshot·restore -23 保真拒绝)+ near×投影联动(P5 钩子清偿:position 有规则的锚点 -11/候选排除,防距离差分反推)+ find_ui_elements 输出 role/label 语义字段(12 类控件适配表,全档位)。45 工具/252 action。 |
| **v0.32.17** | 2026-09-11 | **P5 发现批(discover 评分/near 空间查询)**:manage_tools 新增 discover action(关键词在全量 45 工具×action 名×schema 属性描述上五维加权评分——工具名×5>action×4>组名×3>属性描述×2>顶层描述×1,返回匹配/所属组/激活态/激活指引;默认 basic 只 ships 25 工具,未激活组的能力可见性由此补全,token 经济学最后一块);find_nodes 新增 near_node+max_distance 近邻查询(gua 移植简化:锚点 Node2D/3D,同维度节点距离升序含 distance 字段,锚点排除,引擎侧计算)。45 工具/252 action。 |
| **v0.32.16** | 2026-09-11 | **P4 效率批(描述瘦身/失焦降速/inflight 报丧)**:game 工具描述瘦身三巨点(schema 8198→5800B,总 -3.5KB,解释性文本删/结构形状保,被删细节承接进规则文档;尽调边界结论:scene/workflow 的 schema 膨胀是结构形状不可砍);editor 失焦降速对抗(beckett 轻量版,有 MCP 流量时 clamp 进程级 sleep 至 60fps,空闲 10s 恢复,不碰机器级 EditorSettings);inflight 孤儿记录(工具调用 per-pid 登记,进程被杀后下个 server 启动 stderr 报丧"死亡时仍在执行什么",BuildersGate 取消经济学);SLIM_CONFIG 口径勘误(阈值判断在变换前,slim 对 ui 实际生效);check:budget totalSum warn 90→95KB(瘦身后转绿,回弹即警)。45 工具/251 action。 |
| **v0.32.15** | 2026-09-11 | **P3 能力扩展批(弱网注入/真点击验证/项目本地命令/profile 价格标签)**:network_conditioner 弱网注入(masteryee MultiplayerPeerExtension 装饰器移植,包装多人 peer 出向注入 latency/loss/jitter,多人联机测试独特能力);click_button real_event 真实输入事件路径(press/release 注入 viewport 走完整引擎管道,修复 emit_signal 不切 button_pressed 状态类 bug,响应带信号计数验证);custom_command 项目本地命令目录(游戏开发者丢 .gd 进 res://mcp_commands/ 即扩展 bridge 命令面,custom. 前缀 default deny,regiellis 模式);manage_tools list_groups 加 per-profile 实测 bytes 价格标签(beckett doctor 模式)。新增 fixture 1 组 + 测试 3 文件 27 用例(单元 14/真引擎探针 5/e2e 8)。45 工具/251 action。 |
| **v0.32.14** | 2026-09-11 | **P2 批:函数级 profiling + report 搭车 + freeze 竞争 + 三加固项**:函数级 profiling(Erodenn 整文件移植 1056 行,run_project(profiling) + capture_functions 一次调用,函数级热点+最慢帧 top30,真引擎 e2e 过);report 结构化搭车(step/step_until 响应自带终态读数省观察往返,{path,property} 结构化防 RCE);freeze 竞争上报(unfreeze 报 frozen_for_ms/contested_reasserts);.uid 清理+orphan autoload 前置自愈;CLI 退出码单一注册表+CI 静态扫描;drive-relative 路径形态显式拒(实测抓洞)。新增 3 文件 19 测试。45 工具/249 action。 |
| **v0.32.13** | 2026-09-11 | **P1 安全批(输出侧防注入/自资产保护/心跳保活/声明制白名单)**:nonce 信封输出侧防注入(读回项目内容包随机 nonce 信封+scrub 防伪造,4 读通道 6 接点,六层防御后第一个管"出"的层);FileGuard 插件自资产写保护(拒写 addons/godot_mcp_server/** 与任意位置同名 mcp_bridge.gd,6 守卫点防自毁攻击);心跳保活(长工具每 20s progress 心跳防客户端 idle 杀的"白花钱取消",BuildersGate 取消经济学);GDA_CALLABLE per-node 声明白名单(call_method 第三授权通道,零执行静态枚举 default deny,BLOCKLIST 三通道硬底线,双副本同步触发 bump)。新增 4 文件 18 测试(含真跑 Godot 行为探针)。45 工具/248 action。 |
| **v0.32.12** | 2026-09-11 | **P0 修复批(42 仓深挖尽调三坑,规则模板 bump)**:callv 参数预检(强转不可达组合——个数不足/超出、String→int 非数字、Dictionary→Object、typed Array——调用前显式拒绝 code -10,防 callv 静默失败返回 null 被误读为成功;严格转换表来自 aigengame 真引擎验证表);.pc 日志 rotate race 双 key 防护(7 fixture + create_project/init 模板关文件日志,`.pc` feature-tag 桌面默认 true 只关 base 是 no-op,防并发实例 abort 伪装 engine_crashed);monitor 帧步长改游戏时间采样(#378 同款漂移坑:interval_ms 锚定游戏时间,paused/freeze 不计时,长帧 resync,stop 补采终态,样本加 t_game_ms;帧末采样评估后不做防输入时序偏移);规则模板双副本同步 call_method 预检与 monitor 调度条目(触发 bump 硬门禁);新增 20 测试含 8 个真跑 Godot 的行为探针(固化 type_name→type_string 函数名事故防回归)。`npm test` 6180 过/1 基线既有;独立审查 SHIPPED WITH NITS 已清偿。46 工具/248 action。 |
| **v0.32.11** | 2026-08-21 | **反馈四坑收口 + 端口竞态缓解落地 + CI e2e 并行竞态修复**:bridge 反馈三坑(find_nodes 消费 root 参数限子树搜索(无效 root 报结构化错)、install_override 插 [autoload] 段末尾(游戏单例之后 _ready 直达,免 await 兜底)、call_method 协程双模式(默认返 `{coroutine:true}` 显式标记,`await_completion=true` 哨兵延迟响应等真值));bridge 端口竞态双批落地(起始候选 crypto 随机化(randi 被 playtest.seed 锁故用 crypto)+ TS 侧 resolveBridgePort 回落升级 secret 文件窗口扫描 9081-9090,随机化后盲回落 9081 的「连不上」缝隙根治);ci.yml e2e 步骤 `--no-file-parallelism`(共用 real-project 的并行文件 secret/端口串门竞态——PR#57 前 GD 确定性绑 9081 掩盖,master 两连红同用例/同代码 PR run 绿实证时序竞态,本地串行模式 7 文件 118 测试全绿);e2e 行为级 6 用例真机全绿 + 契约 10 用例;verify_delivery 3/3 维度通过。46 工具/248 action。 |
| **v0.32.10** | 2026-08-21 | **审查修复批三批合入(2026-08-20 六专项审查 17 条全处置,master plan 批 1/2/4;批 3 CLI 参数双形式已随 v0.32.9 七维度批等价合入,分支废弃)**:批 1 测试基建(弱断言门禁 860→732 恢复 128 预防,e2e workflow 全 skip 假绿 gate,mock 工厂 satisfies+typecheck:helpers CI 门禁);批 2 GD 对称性(`_compare_values` 数值白名单防 step_until 假阳性、freeze pending 守卫、mouse button 语义 left/right/middle 映射、coerce is_valid 严格判定、isq all_applied 诊断字段;端口竞态实测坐实 18/20 但修复被证伪如实记 open);批 4 安全隐私杂项(zip 拒 NTFS ADS、web serve 仅 SVG 加 CSP(与 v0.32.9 nosniff 头互补)、qa readReport 过 realpath 防 symlink 绕过、代理披露实测订正 undici 不读 env、CLI 下载链披露补齐、claudemd-builder 旧工具名清理)。版本号由规则模板硬门禁强制 bump(claudemd-builder 分发文本变更;原定终态 0.32.9 已被七维度批用掉后移;npm 发版待用户定夺)。 |
| **v0.32.9** | 2026-08-21 | **架构审查修复批 + 七维度全面审核修复批**(报告 `docs/reviews/2026-08-21-seven-dimension-audit.md`,6 P1+12 P2):help 工具 enum 从注册表动态构建(原硬编码漏 7 个新工具致调用被拒);recording 规则双副本通篇更正为新 action 名 `record_*`(原 `recording_*` 按规则调用必败,双副本一致地错被 STRICT 门禁漏网);CLI 参数双形式统一(init/qa/skills 单形式静默失败修复);MCP server 进程级兜底(unhandledRejection/uncaughtException);qa teardown 补 unfreeze(freeze 后 abort 不残留永久暂停);zip 读侧大小强校验;editor WebSocket listen 前端口预探测(对齐 bridge 侧);工具层 PII 收敛(catch-and-return 不再直泄绝对路径);分发模板 13100 端口错误清除(实际 9090-9094);bridge 协议 README 更正(TCP+NDJSON);版本号由规则模板硬门禁强制 bump(npm 发版待用户定夺)。46 工具/248 action。 |
| **v0.32.8** | 2026-08-20 | **确定性完全体批(护城河研究 H1+叙事正名)**:bridge 新增 `send_input_sequence` 帧定时输入时间线(`timeline=[{at_frame:1-600 开窗后第N帧, type:action/key/mouse_click/mouse_move/touch/drag, ...}]`,延迟响应、owner 互斥同 control 层、frozen 下自动开窗播放+完成 refreeze、注入复用 send_* 零重复、at_frame/key/action 深预检 all-or-nothing)——与 `playtest.seed`/`fixed_delta`/`freeze` 组合达成 L3 真确定性完全体(seed 锁随机+时间线锁输入+快照恢复),为同赛道唯一(竞品最高仅 L1 固定帧 step 或 L2 输入时序,均无 RNG 锁定);qa input 步骤透传接线(超时按 wall_budget 自动放宽,game 工具同款);README 叙事三连——「AI 游戏开发的持续验证管线」定位(verification vs authoring)、「确定性分级」表(L1 帧步进/L2 输入时序/L3 真确定性,回应竞品 "Deterministic" 术语挪用)、editor undo 覆盖叙事(8 命令模块 46 处 action 注册,核查命令随附);测试 18 单测+契约 + e2e 6 用例真机全绿(fixture input-seq-e2e 探针记录 first_seen_frame 锚定帧对齐,含 wall_timeout 截断正向场景);版本号由规则模板变更硬门禁强制 bump(npm 发版待用户定夺)。46 工具/248 action。 |
| **v0.32.7** | 2026-08-20 | **分发优先批（竞品横扫行动，除 P0-1 网页提审全项）**:`configure <client>` 定向配置子命令（--list/--force/名字归一化）+ Warp 适配器（第 15 客户端，working_directory 显式设项目根）;`uid` 工具 4 action（Godot 4.4+ 文件 UID:scan 缺失/孤儿、get 批量、set 确定性生成/fix_missing、check_refs 悬空引用）;`translation` 工具 3 action（CSV/PO 读写 + project.godot 注册，纯 TS）;capability-matrix「范围取舍」段（VisualShader 明确不做）;`skills install` 一键装入 6 个打包 skills（对标 godogen 分流路线）;云路由评估（暂不做）。工具 43→46 / action 241→248，新 resources 组，版本号由规则模板计数变更硬门禁强制 bump（npm 发版待用户定夺，latest 仍 0.32.6）。 |
| **v0.32.6** | 2026-08-19 | **tilemap 可选 scene_path(外部贡献 PR#36,thefireKS)**:tilemap 八个 action 新增可选 `scene_path`——传入则 `_mcp_load_scene()` 加载指定场景并在其中解析节点(`_mcp_get_scene_node()` 自动剥 root/ 前缀与场景根名),省略则生成脚本逐字节不变(仍主场景);此前八生成器硬编码 `application/run/main_scene`,主场景是菜单的项目只能拿到误导性的 TILEMAP_NOT_FOUND。`scene_path` 经 resolveWithinRoot 白名单(越界 INVALID_PARAMS+负向测试);九处重复 preamble 收敛 scenePreamble;转义对齐 escapeForGdLiteral;作者真机 Godot 4.6.2 端到端验证(575 cells)。43 工具/241 action。 |
| **v0.32.5** | 2026-08-19 | **债务清理批收尾**:screenshot_capture 空白检测采样退化修复(线性步进整除视口退化最左单列→10×10 网格分层采样,800×600 类视口不再误报 BLANK);gdEscape→escapeForGdLiteral 转义类闭类三批(纯字面量上下文含 % 路径/值不再被双写,唯一 % 格式串上下文维持 gdEscape);PR-4 终审 Minor 清账(M-1/M-2/M-5,M-4 executor timeout 30s 决策维持);README 口径三处修复+README.en 同款+check-tool-count 防复发(20→24 处);spec §10.5 两决策输入落答(flow FILL h=39 根因=float32 比例锚点残差+HBoxContainer FILL 子高度整数截断;flow 容差维持 2)。43 工具/241 action。 |
| **v0.32.4** | 2026-08-18 | **原型翻译层单 spawn 合成(PR-4)**:ui_import_prototype 内部链 build→persist→reload→measure 由两次 Godot spawn(~6s)合成单 spawn——reload 用 `ResourceLoader.load(path, "", CACHE_MODE_IGNORE)` 绕过 ResourceCache(同进程裸 load 二载命中缓存旧实例,spec §6 B-1),篡改磁盘断言证明 reload 真读磁盘;失败错误内嵌「build 已持久化,可重跑」恢复语义;规则双副本 3 处措辞精确化(PR-3 终审 M-1/M-2/M-7)。43 工具/241 action。 |
| **v0.32.3** | 2026-08-18 | **原型翻译层像素终验(ui_pixel_verify,PR-3)**:ui 工具新 action——对已构建场景(`scene_path` 必填,persist 产物)窗口模式截图(Windows 专属,headless dummy renderer 空白),每 bg 节点采样中心+四角内缩点(内缩 clamp `min(borderRadius+border.width, 短边/2−2)` 防圆角越界;半开区间角点右/下缘 −1,否则 inset=0 采到节点外背景假红)与目标色 0-255 RGB 欧氏距离判定(中心容差 20/角点 60,集成校准 css-card 真渲染 13 采样点 d=0.0 零底噪零偏移);采样跳过两类(半透明 bg 合成后不可直判;ProgressBar 系——fill+百分比文字覆盖 bg 渲染面,bg 槽依赖 style_verify),带 text 节点跳中心点仅采四角(居中排版必踩文字);BLANK 双条件拦截(stdout 提示+PNG 全图 8x8 网格均匀色,两证据独立一致才拦);PNG 中间产物失败路径也清理;定位终验(几何+style_verify 全绿后跑一次,窗口模式弹窗+秒级耗时)。附带 T5a border 暴露渠道措辞修正(style_verify 同源恒绿暴露不了,真暴露渠道是像素采样,4 处)/T5c 孙层由 layout_verify 近似覆盖措辞+七槽 TS/GD 互指注释(5 处)。43 工具/241 action。 |
| **v0.32.1** | 2026-08-18 | **原型翻译层 verify 层(style_verify + flow_verify,PR-2)**:`ui_import_prototype` 返回与 `ui_measure_layout`(expect_tree 时)新增 `style_verify`(逐节点逐槽位逐属性 diff——measure 脚本按需读回「期望清单 ∪ override 并集」的 `get_theme_stylebox(slot)` 生效值,非 StyleBoxFlat 以 type 红条目暴露,颜色容差 0.002、corner/border 宽度精确匹配)+ `flow_verify`(翻译层产出 `flow_expect`,flow 直接子节点期望视口 rect vs 容器排布实测 global rect 直接 diff,B-2 补偿防线从 screenshot diff 兜底升级为数字清单;孙层维持近似覆盖);validate 层补强(bg_color/border_color 四元数组对称校验、corner_radius 布尔/null/数组显式拒);fill-only 灰底 warning(透明壳被 fill 输入阻断时声明默认主题灰底);M-1 border 四边各异不单独 warning 双副本显式声明(生产者仅取 top;style_verify 同源恒绿暴露不了,真暴露渠道是像素采样——0.32.3 ui_pixel_verify)。43 工具/240 action。 |
| **v0.32.0** | 2026-08-17 | **原型翻译层 StyleBox 通道(StyleBox PR-1,bg 为 BREAKING)**:`ui_import_prototype` 样式翻译从 modulate 近似染色迁移到真 StyleBoxFlat——bg/fill/borderRadius/border 统一 override(经 `add_theme_stylebox_override`,落盘名 `theme_override_styles/<slot>`;槽位映射 Panel→panel、ProgressBar→background+fill、Button/Label→normal,其余 warning+忽略;bg 缺省而 border/radius 存在→draw_center=false);新增 fill/borderRadius/border 三字段(geometry schema);GD 生成器 `_sb_N` 构造块+draw_center 布尔校验(堵注入);规则 7 钳制预警恢复无条件(实测 h=16 全 override 组合仍被钳 23/27);evaluate 模板 toHex→toRgba([r,g,b,a] 保留 alpha)+borderRadius/border/fill 三件套采集;规则双副本 9 处镜像同步 STRICT 绿。43 工具/240 action。 |
| **v0.31.4** | 2026-08-17 | **QA 断言四件套 + 应用级异步长跑(QA 深化 PR-1a/PR-1b)**:qa 套件 +4 控制步骤(watch/monitor start|stop)+4 断言(screenshot_diff/signal/errors/monitor,assert 4→8);B-2 取数铁律(GD 侧自动置 inactive 后 poll 返空→poll 优先+补 stop 取全量,不假红);runtime-assert screenshot_diff 占位→真实现(像素差异容忍 threshold 0.12,修复 0.85 相似度语义反转;evidence_path 注入修复锁 qa-reports 内);`qa run mode:async` 后台执行+qa status/cancel(单 working BUSY 互斥,CANCELLED 终态不作 nightly 基线,close 优雅收尾);assertNodeState 真 bridge 嵌套 shape 兼容(e2e 发现既有缺陷);qa 描述 773→469B;MCP tasks 协议层(tasks/get|list|cancel|result wire + 终态通知 + 客户端能力驱动的 qa run 自动 async)。43 工具/240 action。 |
| **v0.31.3** | 2026-08-16 | **QA 编排收尾 + 双副本 STRICT 门禁 + 原型小修批**：B `qa nightly <spec-dir>` CLI 夜间跑批（目录全量跑+每套件与上次同套件报告 diff+回归/修复汇总+退出码）+ `record_on_failure` 套件选项（失败自动留录制,落 qa-reports 与 recording_play 兼容）+ CLI audit 留痕（isAuditEnabled 开关对称）+ NIT-8 五分支测试补全;双副本内容一致性 CI 从 advisory 假接线升级 STRICT 阻断（历史 drift 8/9 文件清零,归一化收紧锚定版本行,bridge/recording 模板按 GD 权威产物纠正字段与路径形态）;原型翻译层遗留小修（显式 Panel 无 bg 灰底翻转 warning/parent_path 尾斜杠归一化）+ token budget warn 基线 80→90KB + CI Linux 平台债三根因修复（fixture globalSetup/pngjs 自生成/XAUTHORITY）。43 工具/238 action。 |
| **v0.31.2** | 2026-08-16 | **final review 修复波**：规则 4 透明壳收窄——只对推断布局壳 Panel 设 self_modulate,自带视觉控件（ProgressBar/Button/任何显式 type）豁免,修复 HP 条被误设透明壳而 diff 假绿（集成补 HpBar 落盘断言+负例验证）;parent_path 根级参照系限制 schema 声明+非 root 时 build_warnings 提示;坏图可区分性实测证据（好图对 0.1762 vs 下半消失合成坏图 0.4797≈2.7 倍,双副本改基线口径）;screenshot threshold 显式 null 落默认 0.12 + action 提示补 diff;ui.md 双副本历史 drift 顺带归零。 |
| **v0.31.1** | 2026-08-16 | **原型翻译层 + 视觉验收**：`ui` 工具族新 action `ui_import_prototype`（HTML 原型几何 JSON 一次调用 翻译→build(固定 persist)→measure→layout_verify;扁平视口坐标自动建树、strict schema 拒未知字段、12+1 翻译规则含 Label 垂直居中/透明壳 self_modulate/flow Holder 壳/ProgressBar 最小高 27 预警;返回 verify_coverage 覆盖率）+ `screenshot(action=diff)` 像素级双图对比（RGB 欧氏距离 threshold 默认 0.12,返回 diff_pixels/diff_ratio/bbox,可选红染差异图,零新依赖）+ 规则双副本登记（ui.md 用法+浏览器 evaluate 取数脚本模板含 textAlign→align 采集与 value 0-1 守卫、engine-quirks 4 条 UI 渲染陷阱）+ 双副本历史 drift 修复（set_anchors_preset 条目/frontmatter）。中间版 0.30.1-0.31.0 详见 CHANGELOG。43 工具/238 action。 |
| **v0.30.0** | 2026-08-15 | **AI QA 编排 + 理解层 + 协议债（方向拍板 B/C/D,零 GDScript 改动纯 TS 批次）**：B `qa` 工具（结构化测试规范→自动装 bridge→起游戏→13 种步骤逐步执行/断言/确定性 playtest→聚合报告+回归 diff,报告落 ~/.godot-mcp/qa-reports,CLI `npm run qa` 夜间跑批;run=process 风险经 confirm+audit 一次覆盖）+ C `analysis` 工具（signal_map 全项目信号连接两来源全景 + impact_check 改信号/脚本/场景前列受影响面,免费开源版对标 GodotIQ Pro,纯静态零 Godot 依赖;tscn [connection] 补 flags/binds 解析）+ D **⚠️ MCP Roots 动态授权退役（Breaking,legacy+roots 客户端统一走 ALLOWED_PROJECT_PATHS env,modern era 零变化）** + protocol-debt 决策文档（Logging 窗口内保持/Sampling 零使用/Tasks+MCP Apps defer）。43 工具/235 action。 |
| **v0.29.0** | 2026-08-15 | **2026-08-14 六批次审查 findings 全量修复（P0×1 + P1×10 + P2/P3,43 commits,双波终审）**：P0 editor 重连链死修复（编辑器重启后自动恢复）+ 安全面（write_script 沙箱 4 旁路入口封堵/deny-list 拼写/load_skill 白名单/nonce symlink）+ audit 工具复活（生产 bug,0.28.3 特性此前不可见）+ playtest 六项（永久暂停/owner 互斥/paused 保存等）+ 属性写入 no-op 假成功三路对齐 + bridge 订阅断线恢复 + **⚠️ autoload 键名迁移（Breaking,旧项目重跑 game_bridge_install 自动迁移）**+ debug/undo GD 修复 + 测试债（debug e2e 首跑/GD 套件/dispatcher 审计 9 场景）+ 披露对齐。发版门禁全绿（verify_delivery 3/3 + e2e L2 真跑 75 passed）。 |
| **v0.28.3** | 2026-08-13 | **战略批收尾（14 竞品路线图 G1/G3/G7）**：G3 操作级审计日志（audit.jsonl appendFile 原子追加,危险操作可追溯/回放）+ G1 deterministic playtest control 层（freeze/unfreeze/step_until 结构化条件,规避 RCE）+ G7 能力 profile（basic=9 组/advanced/full,**BREAKING**：默认 profile 从 full 改 basic,schema 79KB→~30KB 省 ~60% context）。路线图全完成（G2/G3/G1/G7/G8 ✅,G6 实测已有移除）。 |
| **v0.28.2** | 2026-08-12 | **安全加固 + 威胁模型 + 可观测性 + 审查修复**：G2 trace_id + 结构化错误分类 + PII 护栏（速赢批）+ S-1/S-2 bpy-sandbox 双 opt-in + spawn 清单 + S-3~S-7 多实例 registry/editor-auth/http-server 加固 + G8 威胁模型文档（10 层防护实测声明）+ P0 animtree sub_action 死代码修复（F-6 CRITICAL）+ P1 data-import timeout 钳制（F-1/F-2）+ P2 工具层校验精确化（F-3~F-8）+ CMP-13 generate-all-modules + Tier1 structuredContent/prompt + Tier2 skills/tscn parser + Vision Routing 双 opt-in。 |
| **v0.28.1** | 2026-08-11 | **安全加固批次 C + 测试质量**：批次 C 安全加固（deny-list/symlink/path/debug.evaluate RCE 多点）+ instance_registry 目录权限 Linux 0o700（P2-4）+ 弱断言精确化与接线守护批次（P1-3~P1-5/P2-1/P2-2）+ MULTI_INSTANCE 接入 godot-matrix（P1-2）+ 全批次第三方审查文档。 |
| **v0.28.0** | 2026-08-09 | **CMP-14 debug Phase 2/3 + 后续批次**：debug 工具组从 3 action 扩到 10（完整交互式调试器：栈帧/变量/表达式求值/step 控制/继续/暂停/热重载）+ 新建 EditorDebuggerPlugin 子类（debugger_bridge）+ handle_debug_async 异步路由 + 自动打开脚本（修 Phase 1 限制）+ CMP-16-B advanced-proxy 真动态化 + CMP-16-C drift 映射表扩到全 64 method + CMP-9 confirm gate 守护测试。 |
| **v0.27.0** | 2026-08-08 | **CMP-9 双通道通用方法调用 + CMP-16 live schema**（竞品 regiellis/godot-mcp-go 深度对标）：CMP-9-A editor `engine call_method`（场景树节点实例方法调用,did-you-mean + 类型强转 + deny-list 护城河）+ CMP-9-B bridge `_cmd_call_method` 放宽（env 扩展写方法 + did-you-mean + 类型强转）+ CMP-16-A GD param docs metadata（13 文件 57 method docs + `list_param_docs` 聚合）+ CMP-16-B TS live schema（`dynamic-schema.ts` 从 addon 拉 docs 构建 MCP 工具 + 缓存/降级/刷新 + `registerDynamicTools`）+ CMP-16-C drift 检测 CI（debug+engine 7 method 校验）。4749 测试。 |
| **v0.26.0** | 2026-08-08 | **P1+P2 批次修复（18 项审查 finding 闭环）**：GD-R1~R10 GDScript 健壮性（nav status 同源/_ErrorCapture 复位重构/debug 注释/engine enum 补值+search 排序/错误诊断细化/export JSON 化/recording 路由清理）+ IPC-R1~R6 可靠性（env→显式参数/删无效 gap 检测/长操作暂停 TS 心跳/重连 stale 通知/baseline 排除离群点）+ SEC-P1-1 write/edit 沙箱扫描（对齐 execute_gdscript）+ CMP-7 editor instance discovery（addon registry + pid liveness）。三次第三方审查全通过。4667 测试。 |
| **v0.25.11** | 2026-08-08 | **实时 ClassDB 内省**：新增 `engine` 工具组（editor-only），class_info/search/get_inheritance 走 editor 层直调 ClassDB。让 AI 发现运行中引擎的实际可用类/方法/属性（补静态 docs 的 4.7 快照缺口，含第三方 addon/自定义类/版本差异）。 |
| **v0.25.10** | 2026-08-08 | **debug 组 Phase 1 断点管理**：新增 `debug` 工具组（editor-only），set/clear/list breakpoint 走 CodeEdit gutter（gutter 可见 + game 命中 + 跨 run 同步）。从无到有的交互式调试能力。留 Phase 2 step/resume/pause + 栈帧读取。 |
| **v0.25.9** | 2026-08-08 | **竞品 godot-mcp-go 深度对标产出**：CMP-1 editor 项目匹配检查（连接建立后校验 project_path，mismatch 拒绝降级，防跨项目误操作；覆盖首次连接 + rebuild + 自动重连三条路径 + junction realpath fallback）+ CMP-2 game bridge runtime error 捕获（`_ErrorCapture` Logger 子类 ring buffer 200，捕获全部 4 种错误类型 ERROR/SCRIPT/SHADER/WARNING，`get_errors`/`clear_errors` 两个新 method，since-seq 增量查询，re-entrancy guard 防 error storm）。两次第三方审查均 SHIPPED。4571 测试。 |
| **v0.25.8** | 2026-08-07 | **5 批审查修复闭环**：批次1 GDScript 假成功（save_scene/load_sprite/screenshot 失败补 quit(1) + _cmd_playtest_restore Resource 反向转换 + _cleanup_peer_state 漏清 snapshot）+ 批次2 TS 可靠性（resetBridgeState 清 push 子系统 + STARTUP_CLEANUP.finally + health-monitor degraded 不被心跳过早清除 + playtest owner_pid 多 peer）+ 批次3 安全纵深（FileAccess READ 非 Godot 协议拦 + 网络回连 API 进沙箱 + stripLiterals 扩 user://）+ 批次4 测试缺口（P3-6 socket 竞态并发测试 + C# 回滚测试 + 4 CI 守门脚本）+ 批次5 文档收尾（update-checker 门控语义健壮化 + 文档漂移修正）。4534 测试。 |
| **v0.25.7** | 2026-08-06 | **P3 选做三批**（审查 SHIPPED WITH NITS）：P3-1/P3-2 版本同步收口（server.json/Dockerfile 纳入 version-sync，根治分发产物漂移）+ P3-7 C# 阶段一收尾（project_replace 白名单/read using/edit 验证回滚）+ P3-6 subscriptions/listen（bridge 事件主动推送，watch/monitor push 模式三层改造）+ P2 第三方审查 B-1/I-2/I-3 修复。4517 测试。 |
| **v0.25.6** | 2026-08-06 | **P2 Wave2**：P2-4 确定性 playtest 四原语（seed/fixed_delta/step/snapshot/restore）+ P2-5 SEP-2133 extensions 声明（runtime-bridge 发现性）。 |
| **v0.25.5** | 2026-08-06 | **P2 Wave1**：P2-1 overrides 注入 autoload（启动前注入调试脚本）+ P2-6 recipe 验证闭环 + P2-2 validate_scripts autoload 纠偏 + P2-3 nodeType RCE 审计白名单收尾。 |
| **v0.25.4** | 2026-08-05 | **P0（6/6）+ P1（7/7）协议层升级**：SDK v1→v2（`@modelcontextprotocol/server` 2.0）+ MRTR 双时代 + action 级 capability gate + runtime_assert/help 工具 + P1 全 7 项（SEP-2575 modern era/SEP-2549 cacheHints/SEP-2577 per-request logLevel/视觉成本层级/契约 CI/idempotentHint）+ 测试覆盖加固批次。 |
| **v0.25.3** | 2026-08-01 | **全天审查收尾**（SHIPPED）：P2-12 二期 async 改造引入的 arena 前缀碰撞 BLOCKING 根治（方案 B `_mcp_test_persistent` meta opt-out，运行时对照实验闭环）+ NIT-3 抽 `_runWithOpTimeout`（含 return-await 隐藏 bug 修复）+ NIT-2 bpy-sandbox `%` 格式化构造检测 + NIT-1 删死代码。4381 测试。 |
| **v0.25.2** | 2026-08-01 | **P2-12 McpTestSuite 移植**（editor 路线，关闭 P1-5）：AI 可写标准化 GDScript 测试套件（`extends McpTestSuite`），editor 模式 `testing` 工具执行 + 一期/二期 async coroutine 防 keepalive 饿死 + P1-2/P2 安全（execute_bpy 拼接检测/animation coerce/ui theme/export 白名单）+ P3 文档纠正（editor.exists 失真修复 7→0）。36 工具/205 action。 |
| **v0.25.1** | 2026-07-31 | **竞品对比批①-④ 落地**（审查 SHIPPED WITH NITS）：工具数口径修正（21 处漂移 28/29/33/130+→35/203，含 rule-templates 独立副本同步防下游污染）+ `check-tool-count.mjs` CI 校验脚本根治漂移 + 进程生命周期 P0 周期 orphan 扫描/P1 启动清理（STARTUP_CLEANUP opt-in）+ command_helpers 纯函数行为测试（L2 none→partial）+ nav N1-fix（bake_mesh 末行 freed 守卫）。4293 测试 + verify_delivery 3/3 通过。 |
| **v0.25.0** | 2026-07-30 | **A-RCE 安全批次**（headless instantiate_class 白名单堵 `extends Node` RCE + self_update 符号链接校验 + execute_bpy 危险 API 扫描 + profile 硬隔离 + godot_path 白名单）+ **B 可靠性**（nav bake 超时对齐/gdscript spawn orphan 清理/心跳降级区分 timeout-refused/HOL 预检/全系统扫跳过 --editor）+ **C 正确性**（adapter env 白名单合并/nav freed 守卫/doctor stripBom/update-cache 字节上限/updateAddon 原子化）+ **Telemetry 骨架**（opt-in 默认关，零外传）+ **Nav bake 准确性**（async-dispatch，bake_result 从乐观改 get_vertices 判据）+ **测试质量**（e2e 清理 .godot 缓存防假绿 + 弱断言精确化 576 条）。 |
| **v0.24.1** | 2026-07-27 | **文档同步修复**：`rule-templates.ts` 补齐 get_node_layout 同步（独立副本约束 drift，第三方审查发现）+ **AGENTS.md 三段强制流程**（`.claude/rules/` 改后核查 / plan 落地后必出第三方审查文档 / 完成前必登 memory）+ 新增 `docs/reviews/` 目录补 5 条 7 月断档链路审查文档 |
| **v0.24.0** | 2026-07-25 | **self-update 机制**(Godot AI 追赶 3/3：npm 启动检查 + self_update MCP 工具 addon 检查/更新)+ **5 批审查全闭环**(A 安全 RCE class_path/路径穿越/symlink + B 可靠性降级链路/资源写原子化17处 + C 正确性协议契约/undo/参数校验 + D 工具治理 asset/android TOOL_GROUPS + E 测试缺口加固10/10)+ **batch F 测试覆盖深度**(6 task 假绿修复/纯函数单测/安全动态断言/防回归契约/skip 可见化)+ **CI Godot 4.6.3/4.7.1 版本矩阵** + ZCode 深度支持/AGENTS.md + orphan 扫描会话隔离 + editor key 多实例误删修复 + take_screenshot null guard，4030 测试 |
| **v0.23.0** | 2026-07-13 | 安全 CRITICAL(零确认 RCE 复合链 `6406de4` + `confirm_and_execute` elicitation out-of-band gate 堵 AI 自确认 token `18ef867` + `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` opt-in 降级)+ editor 路由解锁(editor-method-map 登记 animation_track/export/particles/nav/animtree/ui 21 action `356a061` + scene/node/open_scene/reconnecting)+ bug 修复(path_generator 死循环/scene vector3 coerce/asset color+count/data-import A1-A3)+ HealthMonitor editor stall 检测 `85f5328` + 删 ReconnectionManager 死代码 410 行 `f2773fb` |
| **v0.22.0** | 2026-07-08 | asset 工具集新工具(11 shape + 路径阵列 discrete/continuous + batch 原子 undo + save 预制件 + 10 材质预设;方案 A 阻塞 continuous ramp 待上游)+ capability-matrix 33 + LICENSE 致谢 AssetForge/Tripo3D |
| **v0.21.0** | 2026-07-06 | csv_to_resources 新工具(CSV→Godot 资源批量导入,双轨 TS+GDScript)+ ToolAnnotations hints(actionRisks 派生 readOnly/destructive)+ 多轮独立审查核实修复(RCE/ipc/data-import/综合审查 editor 路由 -32601 回退+guard 接线+heartbeat 暂停语义)+ editor 4.7 兼容(EditorInterface/super() 回归/Safe save)+ capability reviewer 设施 + e2e L2 opt-in |
| **v0.20.0** | 2026-06-30 | cpp GDExtension 脚手架(scaffold_gdextension 生成 8 文件 C++ 工程骨架)+ 全工具验证靶子(real-project 三层 L1/L2/L3 自动化,28 工具正路径)+ 工具行为修复(default-null 统一/run_project isError/timeout race)+ R3/安全审查修复 |
| **v0.19.1** | 2026-06-27 | 版本元数据同步(manifest/plugin.cfg/README/使用指南)— 功能无变化,补 v0.19.0 npm 元数据漂移 |
| **v0.19.0** | 2026-06-27 | R2 审查响应链 — editor 4 模块 undo_manager(nav/particle/animtree/ui Ctrl+Z 撤销) + super() IMP-4 + IMP-11 touch 双侧契约 + 安全同源 4 点(UI/audio/instance) + @748 detach 双 parent fix + 阶段1b 守卫,2894 测试 |
| **v0.18.2** | 2026-06-18 | 安全加固 — 沙箱绕过组 + 防御深度 + 注入收敛,2670 测试 |
| **v0.18.1** | 2026-06-14 | 功能验证审查 3 CRITICAL 修复 — parseTscn 属性/头部解析（read_scene 现正确返回结构化属性）+ game_wait 轮询等待（pollWaitCondition），2597 测试 |
| **v0.18.0** | 2026-06-10 | 工具合并（39→27 MCP 工具）+ LEGACY 兼容模式 + manage_tools 迁移 + notifyToolsChanged |
| **v0.17.1** | 2026-06-08 | 五维审查 P0+P1 全量修复 — tscn 死代码删除 527 行 + core/tools 解耦 + animation-ops +38 测试 + EditorExecutor +16 测试 + 安全加固，2252 测试 |
| **v0.17.0** | 2026-06-07 | 审查修复 9 项（4C+5I/A）— tscn 编辑正确性 + 确认令牌截断保护 + 字符串 UID + 安全加固，2023 测试 |
| **v0.16.0** | 2026-05-31 | 审查驱动质量提升 — ToolDispatcher 提取 + 87 次提交 + merge_scene + 项目脚手架 + 智能类型转换 + 1638 测试 |
| **v0.15.1** | 2026-05-27 | Godot 4.6 editor plugin 兼容性修复 |
| **v0.15.0** | 2026-05-27 | 6 代理并行审查（14 CRITICAL 修复）+ deny-by-default 安全 + Bridge 录制 + ESLint + 1509 测试 |
| **v0.14.0** | 2026-05-24 | 7 轴全维度审查（8 CRITICAL 修复）+ IK 框架 MVP + Vitest 迁移 1257 测试 |
| **v0.13.0** | 2026-05-23 | Bridge 安全加固 20 项 + requestId 取模 + CSS Grid + EditorConnection 重连上限 |
| **v0.12.0** | 2026-05-23 | 迭代 URL 解码防路径遍历 + verify_delivery 4 维度验证 + dev_loop acceptance |
| **v0.11.1** | 2026-05-22 | Bridge TCP 绑定 127.0.0.1 + 密钥文件读后即删 + opsErrorResult isError 修复 |
| **v0.11.0** | 2026-05-22 | CSS Flexbox 布局翻译层 + GDScript Lint 规则引擎 + 路径遍历防护增强 |
| **v0.10.1** | 2026-05-21 | Bridge TCP 绑定本地地址 + 密钥文件生命周期管理 + opsErrorResult 修复 |
| **v0.10.0** | 2026-05-19 | 场景实例化 + 编辑器实时同步 + 代码优化重构（124 工具） |
| **v0.9.0** | 2026-05-16 | 批量工具 + UI 工具 + 录制系统 + 确认令牌 + Read-Only/Lite 模式（118 工具） |
| **v0.8.0** | 2026-05-13 | 双模式架构 + 测试框架 + 粒子/导航/AnimationTree（96 工具） |
| **v0.7.0** | 2026-05-08 | 安全加固 + 输入转义 + 类型安全 + tscn-parser 修复 |
| **v0.6.0** | 2026-05-03 | 音频播放控制 4 工具 + TileMap 编辑 8 工具 |
| **v0.5.0** | 2026-05-02 | 信号控制 + 物理查询 + 3D 创建 + 导航寻路（8 工具） |
| **v0.4.0** | 2026-05-01 | 版本检测 + validate_scripts + search_and_replace + 截图稳定性 |
| **v0.3.0** | — | edit_script + batch_add_nodes + validate_project + import_resources |
| **v0.2.0** | — | read_scene + read/write_script + query_scene_tree + MCP Resources |
| **v0.1.0** | — | 项目管理 + 场景操作 + 执行控制 + 截图 + execute_gdscript |
