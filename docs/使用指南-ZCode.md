# 在 ZCode 中接入 godot-mcp-enhanced

> **版本**：0.23.0 ｜ **适用 ZCode**：支持 MCP 的版本 ｜ **适用 Godot**：4.x（4.6+ 已测试）
>
> **验证状态**：✅ 协议层（实测，32 工具全发现）｜ ✅ GUI 端到端实测已完成（单元 A/B/C + 场景 A 复测，单元 B 客户端层仅覆盖 yolo 模式）｜ ✅ 项目级 AGENTS.md 注入已确认（场景 A）｜ ✅ 客户端层确认 UI 形态已确认（yolo 模式下零介入，非 elicitation）

---

## 这份指南解决什么

[ZCode](https://zcode.z.ai/) 是智谱官方的 Agentic Development Environment（ADE），深度适配 GLM 系列模型。godot-mcp-enhanced 是 **stdio MCP 服务端**，ZCode 是 **stdio MCP 客户端**——协议层天然匹配。

**关键差异（vs Claude Code）**：ZCode 不读 `CLAUDE.md`，只读 workspace 根 `AGENTS.md`（也不扫描 `.claude/rules/` 子目录、不展开 `@import`）。因此接入后请运行一次 `setup_project_rules`（Task 3/4 起默认双写 `CLAUDE.md` + `AGENTS.md`），让 godot 规则在 ZCode 里生效。

如果你只想快速跑起来，看 [§2 方式 A（GUI）](#方式-a-zcode-gui) 或 [§2 方式 C（从 Claude Code 导入）](#方式-c从-claude-code-导入非-auto-spawn)。

---

## 1. 兼容性结论速览

| 维度 | 结论 | 依据 |
|------|------|------|
| **stdio 传输** | ✅ 完美匹配 | ZCode 是 stdio MCP 客户端；godot-mcp 是 stdio 服务端 |
| **工具发现** | ✅ 协议层实测全列出 | 32 工具全发现，`docs/zcode-protocol-verify.mjs` 实测（2026-07-22） |
| **inputSchema** | ✅ 全工具就绪 | godot-mcp 全部工具声明 Zod schema，ZCode 表单/校验可用 |
| **项目指令注入** | ✅ 通过 `AGENTS.md` | 实测确认（场景 A）：ZCode 读全局 + workspace 根 `AGENTS.md`，不读 `CLAUDE.md`，不扫描 `.claude/rules/`（见 [§3](#3-让-godot-规则在-zcode-生效关键)） |
| **配置作用域** | 用户级 / 工作区级 | `.zcode/config.json` 或兼容 `.agents/mcp.json`（来源 mcp-services 页） |
| **危险操作权限** | ✅ server 层确认 / yolo 下客户端零介入 | `confirm_and_execute` server token 流程走通（单元 B）；yolo 模式下客户端层无 GUI 弹窗、无 elicitation（单元 B 客户端层实测，见 [§5.3](#53-elicitation-与客户端层确认-ui-b-半部分确认)） |

> **结论**：协议层与 ZCode 完全兼容（实测 32 工具全发现）；接入动作是生成 `AGENTS.md` + 运行 `setup_project_rules`（规则文件在 `.claude/rules/`，agent 主动 `Read` 可获取，且 AGENTS.md 会作为 workspace instructions 注入），以及执行模式选择（见 §5）。

---

## 2. 三种配置方式

### 方式 A：ZCode GUI

ZCode 设置 → MCP 服务器 → 新建 MCP 服务器，填入：

| 字段 | 值 |
|------|-----|
| **作用域** | 工作区（仅当前项目）或 用户（所有工作区） |
| **类型** | `stdio（本地命令）` |
| **command** | `npx` |
| **args** | `["-y", "godot-mcp-enhanced"]` |
| **env** | 见 [§4 环境变量](#4-环境变量)（至少建议设 `ALLOWED_PROJECT_PATHS`） |

ZCode 支持三种录入方式（来源 mcp-services 页，2026-07-22 抓取）：GUI 表单（stdio，填 command+args+env）/ file-based（读 `.zcode` 或 `.agents` 配置文件）/ **完整配置粘贴**（直接粘贴 JSON，支持 `{"server":{...}}` 和 `{"mcpServers":{...}}` 两种顶层格式）。

> **方式 A 的变体：本地 build 直跑**。若你 clone 了 godot-mcp-enhanced 仓库做开发，`command` 可换成 `node`、`args` 指向本地 `build/index.js`（实测可用的配置见 [§6.3 实测配置](#63-实测可用配置)）。两者等价：`npx -y` 拉公开分发版，本地 build 指向开发版。

### 方式 B：file-based（`.zcode/config.json` 或 `.agents/mcp.json`）

工作区级 `<项目根>/.zcode/config.json`，键 `mcp.servers`（来源 mcp-services 页，2026-07-22 抓取）：

```json
{
  "mcp": {
    "servers": {
      "godot": {
        "command": "npx",
        "args": ["-y", "godot-mcp-enhanced"],
        "env": {
          "ALLOWED_PROJECT_PATHS": "D:/my-game",
          "GODOT_PATH": "D:/Godot_v4.6.3-stable_win64.exe"
        }
      }
    }
  }
}
```

`.zcode/config.json` 的两个作用域（来源 mcp-services 页，2026-07-22 抓取）：
- 用户级：`~/.zcode/cli/config.json`
- 工作区级：`<项目根>/.zcode/config.json`

或兼容格式 `<项目根>/.agents/mcp.json`，键 `mcpServers`：

```json
{
  "mcpServers": {
    "godot": { "command": "npx", "args": ["-y", "godot-mcp-enhanced"] }
  }
}
```

兼容路径的两个作用域（来源 mcp-services 页）：
- 用户级：`~/.agents/mcp.json`
- 工作区级：`<项目根>/.agents/mcp.json`

> **⚠️ 优先级坑（来源 mcp-services 页，2026-07-22 抓取）**：同作用域内 `.zcode` **强优先**——只要 `.zcode/config.json` 有任何 MCP 服务，同作用域的 `.agents/mcp.json` 会被**整体跳过，不合并**。两者混用时，请把 `.agents` 的配置手动合并进 `.zcode/config.json`，避免静默丢失服务。

### 方式 C：从 Claude Code 导入（非 auto-spawn）

ZCode 设置 → MCP 服务器 → **导入图标**，自动扫描可导入的服务器配置。来源（来源 mcp-services 页，2026-07-22 抓取）含：

- **Claude Code**：`~/.claude/settings.json`
- **Codex CLI**：`~/.codex/config.toml`
- **OpenCode**：`~/.config/opencode/opencode.json`
- **通用 `.agents`**：`~/.agents/mcp.json`

操作流程：点导入图标 → 勾选要导入的服务器 → 写入 `.zcode/config.json`。

> **⚠️ 这是「导入」，不是 Warp 那种运行时 auto-spawn**。ZCode 把选中配置拷贝进自己的 `.zcode/config.json`，**原外部配置文件不被修改**。后续外部配置变更不会自动同步——需重新点导入。与 [使用指南-Warp 方式 C](使用指南-Warp.md#方式-c复用-claude-code-配置零配置最强) 的运行时自动 spawn 语义不同，不要混淆。

### 方式 D：连接常驻 daemon（HTTP）

前三种方式都是 stdio（ZCode 会话启动时 spawn 一个 server 子进程，会话结束子进程消亡）。若已用 CLI 拉起常驻 daemon（`godot-mcp-enhanced daemon start`），ZCode 可改为 http 直连——server 独立后台常驻，面板与 `/mcp` 端点（`http://127.0.0.1:<port>/mcp`，默认 9550 起）不随 ZCode 会话开关而存亡。

`.zcode/config.json`（或 `.agents/mcp.json`）片段：

```json
{
  "mcp": {
    "servers": {
      "godot": {
        "type": "http",
        "url": "http://127.0.0.1:<port>/mcp",
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

- `<port>`：`daemon start` / `daemon status` 输出的实际端口；`<token>`：`godot-mcp-enhanced daemon status --show-token` 获取（`/mcp` 仅认 Authorization Bearer 头，无 token 401）。
- 配置界面 = daemon 面板「设置」页：daemon 由终端拉起拿不到 ZCode 注入的 `GODOT_PATH`/`ALLOWED_PROJECT_PATHS` env，在面板设置页配置后保存即热生效（持久化 `~/.godot-mcp/settings.json`，daemon 启动自动重放），无需重启 daemon、也无需改 ZCode 配置。

**重连语义（与 stdio 的关键差异）**：

- ZCode 会话结束/重开不再杀 server——重开会话直接重连既有 daemon，工具状态（运行中的面板、已配置的白名单）延续。
- `daemon restart` 走受控交接，端口不漂移，但交接窗口（秒级）`/mcp` 拒连——ZCode 侧表现为一次连接闪断，重试/重开会话即恢复。
- **单会话独占**：同一 daemon 同一时刻只服务一个 MCP 会话，第二个 ZCode 客户端（或另一 MCP 客户端）Initialize 会收到 409；需要并行会话时另起 daemon 或退回 stdio 方式。
- ZCode 对 localhost http MCP 端点的实际行为（重连时机、会话保活）以真机为准，异常时先 `daemon status` 核对端点存活。
- daemon 崩溃不自愈（无 watchdog），需手动 `daemon start` 重拉。

---

## 3. 让 godot 规则在 ZCode 生效（关键）

> ✅ **场景 A 复测已确认（2026-07-22）**：在 `godot-test-project`（AGENTS.md 已存在）开新会话，agent 明确回答收到了两份 AGENTS.md——全局 `~/.zcode/AGENTS.md`（user default instructions）+ 工作区 `D:\workspace\projects\godot-test-project\AGENTS.md`（workspace instructions）。原断言成立。单元 C 早期的「项目级未注入」结论归因于时序污染（AGENTS.md 晚于会话初始化创建），详见 §3.5 末尾。

ZCode **不读** `CLAUDE.md`，也**不扫描** `.claude/rules/` 子目录、**不展开** `@import` / `@include`、**不合并**多层级 `AGENTS.md`（来源官方 agents 页，2026-07-22 抓取 + 场景 A 实测确认）。它只读：

- 全局：`~/.zcode/AGENTS.md`（标注为 user default instructions）
- 工作区：workspace 根 `AGENTS.md`（标注为 workspace instructions，workspace = 当前工作目录）

> ZCode 在 onboarding 时会一次性把 `CLAUDE.md` 迁移到 `AGENTS.md`，但这是一次性动作，之后不再读 `CLAUDE.md`。

因此接入 godot-mcp 后，运行一次：

```
project(action="setup_project_rules", project_path="D:/my-game")
```

该工具自 v0.23.0 起 `agents_md` 参数默认 `true`（Task 3/4），会在项目根同时生成：

- `CLAUDE.md`（供 Claude Code 等读取）
- `AGENTS.md`（供 ZCode / Codex / Cursor 等遵循 AGENTS.md 标准的客户端读取）

`AGENTS.md` 是**单文件全量内联**——所有 godot 工具规则（模式决策树 / 各子系统陷阱 / GDScript 规范 / engine-quirks）都打平进这一个文件，不依赖子目录扫描或 `@import` 展开，正好匹配 ZCode 的单文件读取模型。

若只想生成 `AGENTS.md`（不写 `CLAUDE.md`），显式传 `claude_md=false`：

```
project(action="setup_project_rules", project_path="D:/my-game", claude_md=false)
```

### 3.5 两套独立机制：`.claude/rules/` 规则文件 vs `AGENTS.md` 注入

⚠️ **单元 A 实测（2026-07-22）揭示一个易混淆点**：`setup_project_rules` 实际生成的是**两套独立的产物**，不要混为一谈：

| 产物 | 位置 | 性质 | 如何被 agent 获取 |
|------|------|------|-----------------|
| **规则文件组** | `.claude/rules/*.md`（6 个文件：`godot-mcp.md` / `godot-mcp-core.md` / `godot-mcp-bridge.md` / `godot-mcp-editor.md` / `godot-mcp-recording.md` / `godot-mcp-ui.md`）+ `.godot-mcp-manifest.json` | godot 工具用法的详细规则源 | **agent 主动用 `Read` 读**（非自动注入） |
| **AGENTS.md** | 项目根 `AGENTS.md` | 规则的全量内联摘要 | **会话初始化时注入为 workspace instructions**（场景 A 实测确认，见 §3 开头） |

**关键区别**：

- `.claude/rules/*.md` 是**文件**，agent 随时可用 `Read` 工具读取——这与客户端注入机制无关，任何 agent 都能读。单元 A 中 agent 正确引用了这些规则原文（三层架构决策树、持久化分类等），就是靠主动 `Read`。
- `AGENTS.md` 是**注入候选**，是否进入 agent 上下文取决于客户端的注入行为。ZCode 在会话初始化时将其注入为 workspace instructions（场景 A 实测确认）。**注意时序**：必须在会话开始前 AGENTS.md 已存在；会话进行中创建的 AGENTS.md 不会被该会话注入（单元 C 时序污染教训）。

**实践建议**：

- 两套机制互为冗余——AGENTS.md 注入（场景 A 已确认）+ agent 主动 `Read` `.claude/rules/*.md`，任一路径都能让 godot 规则进入 agent 上下文。即使会话中临时生成的 AGENTS.md 未被注入（时序坑），agent 仍可主动 `Read` 规则文件兜底。
- 单元 A 实测中，agent 在项目级 AGENTS.md 未注入的情况下，仍完整答对了「操作 .tscn 该用哪个模式、怎么持久化」——证明 `.claude/rules/` 主动读取路径是可靠兜底。

**单元 C 时序污染的最终归因（场景 A 复测已确认）**：单元 C 早期实测发现 `godot-test-project` 项目级 `AGENTS.md` 未被注入，因 `AGENTS.md` 是会话第一轮才创建的（晚于初始化）。场景 A 复测（AGENTS.md 已存在时开新会话）证实：**项目级 AGENTS.md 会被干净注入为 workspace instructions**。结论：单元 C 的偏差纯系时序导致，ZCode 的注入机制本身符合官方文档断言。**实践教训**：若要让 AGENTS.md 在某会话生效，必须在会话开始前生成它；会话进行中生成的不会热加载。

---

## 4. 环境变量

ZCode 的 `env` 字段直传到 godot-mcp 进程，与 [使用指南-Warp §4](使用指南-Warp.md#4-环境变量) 完全一致（godot-mcp 的 env 契约与客户端无关）。常用变量速查：

| 变量 | 说明 | 建议 |
|------|------|------|
| `ALLOWED_PROJECT_PATHS` | 允许访问的项目根（分号分隔），deny-by-default | **必设**——不设则 godot-mcp 仅允许 `process.cwd()`，而 ZCode 启动 MCP server 的 cwd 通常不是你的 Godot 项目 |
| `GODOT_PATH` | Godot 可执行文件路径 | 不设则自动搜索 PATH / 注册表 / Scoop / Downloads |
| `GODOT_PROJECT_PATH` | 默认项目路径 | 设了可省去每次工具调用传 `project_path` |
| `GODOT_MCP_SANDBOX` | `disabled` / `strict` / 默认 | 控制执行 GDScript 前的危险模式扫描 |
| `GODOT_MCP_UNRESTRICTED` | `true` = 禁用路径限制 | ⚠️ 仅开发环境，生产勿用 |

> 完整变量表见 [使用指南 §13 环境变量参考](使用指南.md#13-环境变量参考)。`working_directory` 同样建议显式设——理由与 [使用指南-Warp §5](使用指南-Warp.md#5-️-working_directory-为什么必须显式设) 完全相同（MCP 客户端的 cwd 通常不是 Godot 项目根）。

---

## 5. 权限与安全

### 5.1 ZCode 执行模式 × godot 危险操作

ZCode 提供 4 种执行模式（来源官方 safety-confirm 页，2026-07-22 抓取）：**变更前确认** / **自动编辑** / **计划模式** / **完全访问**。决策选项含：允许 / 始终允许 / 拒绝 / 始终拒绝 / 允许本会话 / 始终允许本项目。

| ZCode 执行模式 | godot 危险操作行为 |
|----------------|-------------------|
| **变更前确认** | ZCode 在文件/命令改动前弹确认 ✅ **兜底有效** |
| **自动编辑** / **完全访问** | 文件/命令自动改，不拦截 ⚠️ |
| **计划模式** | 仅规划不执行，无副作用 |

### 5.2 `confirm_and_execute` 实测（单元 B，server 层已确认）

godot-mcp 的 `confirm_and_execute` 机制：危险操作（`write_config` / `create_project` / `setup_project_rules` 等）先返回一个确认 token 给 AI，AI 再回传 token 触发执行。**问题**：token 走 `client → server → client` 回路，单客户端下 AI 可以自确认——**无论 ZCode 是否实现 MCP elicitation，自动执行模式下都不能依赖它**。

**实测证据（2026-07-22，`project.write_config` 改 `application/config/name`）**：

```
① Agent 发出 write_config 调用
② godot server 返回:
   { "requires_confirmation": true,
     "confirmation_token": "ZSHjGKAccPsicYxcFkZWm231",
     "message": "Tool \"project\" requires confirmation...",
     "ttl_seconds": 60 }
③ Agent 把 token 喂回 confirm_and_execute(token)
④ godot server 验证 token → 真正执行 → 返回 success: true
⑤ 落盘验证: project.godot 第 13 行 config/name="测试名" ✅
```

**已确认（Agent 侧 100% 可证）**：

- ✅ server 层 token 确认机制真实存在，TTL 60 秒，必须二次调 `confirm_and_execute`
- ✅ 二次确认后真实落盘（`project.godot` 内容已变）
- ✅ **两层确认独立不共享状态**：ZCode 客户端层（hook/权限 UI）与 godot server 层（token）是两套机制，各拦各的，互不感知

**已确认（yolo 模式下，见 §5.3）**：ZCode 客户端层对 godot 工具零介入——无 GUI 弹窗、无输入框、无 elicitation。`write_config` 直接返回 server token JSON，Agent 自行决定是否调 confirm_and_execute。

这是 godot-mcp 协议层的固有限制（单客户端 confirm token 无法形成 out-of-band 通道），与具体客户端无关。

**建议**：

- 在 ZCode 里用 **「变更前确认」** 执行模式兜底，不要依赖 `confirm_and_execute`
- 把 godot 危险操作的拦截责任交给 ZCode 的执行模式 + godot-mcp 自身的路径白名单 / GDScript 沙箱 / Bridge 密钥

godot-mcp 的以下安全层在所有客户端一致生效（与客户端无关）：

- **路径白名单**（deny-by-default）：`ALLOWED_PROJECT_PATHS` 控制可访问的项目根；防 `..` 遍历、UNC 路径、Windows 设备名
- **GDScript 沙箱**：`execute_gdscript` 执行前扫描危险模式（`OS.execute` / `FileAccess(WRITE)` 等）
- **Game Bridge 密钥**：运行时调试的 TCP 通信走 127.0.0.1 + 随机密钥

详见 [使用指南 §11 安全模型](使用指南.md#11-安全模型)。

### 5.3 elicitation 定论（作用域：yolo 模式）

基于单元 B 实测（含客户端层 GUI 观察，2026-07-22）的最终结论：

- **server 层**（已确认）：godot-mcp 自带的 `requires_confirmation` + token + `confirm_and_execute` 是 server 内部确认协议，**不是 MCP 规范意义上的 elicitation**（elicitation 要求 out-of-band server→client→user 通道，token 走的是正常工具返回通道）。
- **客户端层**（yolo 模式下已确认）：**ZCode 客户端层对 godot MCP 工具零介入**——无 GUI 弹窗、无输入框、无 elicitation 形态。`write_config` 调用直接返回 server 的 token JSON，Agent 收到后自行决定是否调 `confirm_and_execute`。实测中 Agent 未调 confirm_and_execute，配置实际未被写入（token 60 秒后失效）。

**最终定论（yolo 模式作用域）**：

| 问题 | 定论 | 依据 |
|------|------|------|
| ZCode 是否实现 MCP elicitation | **当前 yolo 模式下未观察到** | 客户端层无弹窗、无输入框、无 out-of-band 通道 |
| 客户端层是否拦截 godot 工具 | **不拦截**（yolo 模式） | write_config 直接到达 server，未触发 PermissionRequest 回路 |
| `confirm_and_execute` 能否堵自确认漏洞 | **不能** | yolo 下 Agent 可自主决定是否调 confirm_and_execute，无外部强制 |

> ⚠️ **「变更前确认」模式下的行为仍未实测**。yolo 模式（无权限提示）是当前验证的唯一模式。若切到「变更前确认」执行模式，客户端层是否会介入拦截——这是本定论的未覆盖区。保守起见仍建议：在 ZCode 里用「变更前确认」模式兜底，不要完全依赖 `confirm_and_execute`（见 §5.2 建议）。

---

## 6. 验证（Task 8 实测回填，2026-07-22）

本节为 Task 8（协议层脚本 + ZCode GUI 端到端实测）的实测回填。验证分三层：协议层（已确认）/ GUI 端到端（已确认）/ 未覆盖区（不阻塞定论）。

### 6.1 协议层（✅ 已确认，可复现）

复用 [使用指南-Warp §6.2](使用指南-Warp.md#62-协议层验证可复现不依赖-warp) 的 stdio 客户端脚本（`docs/zcode-protocol-verify.mjs`），实测结果：

- ✅ `initialize` 握手成功
- ✅ `tools/list` 全工具发现（32 个工具，与 commit `8e77962` 的协议层验证脚本一致）
- ✅ `inputSchema` 完整

ZCode 的 MCP 客户端行为与官方 SDK 等价（都遵循 MCP spec），协议层完全兼容。

### 6.2 GUI 端到端实测（单元 A / B / C，部分确认）

**单元 A —— godot 规则可被 agent 正确引用（✅ 已确认）**

实测项目 `D:/workspace/projects/godot-test-project`。问 agent「操作 .tscn 该用哪个模式？改完怎么持久化？」，agent 完整答对：

- 三层架构决策树（Headless / Editor / Game Bridge）——选 Headless
- 持久化分类：脚本（`edit_script` 自动写盘）/ 场景节点（`add_node` + **`save_scene`** 必须显式存）/ 运行时工具（不持久化）
- 引用了 `.claude/rules/` 下 6 个规则文件原文

> 完整记录见 `D:/workspace/projects/godot-test-project/docs/godot-mcp-tscn-workflow.md`。

**单元 B —— 危险操作确认机制（✅ server 层 + yolo 下客户端层均已确认）**

实测 `project.write_config` 改 `application/config/name`，server 层 token 确认流程走通并落盘；yolo 模式下客户端层零介入（无弹窗/无输入框/无 elicitation）。详见 §5.2/§5.3。唯一未覆盖：「变更前确认」执行模式下客户端层行为（见 §6.4）。

> 完整记录见 `D:/workspace/projects/godot-test-project/docs/mcp-confirmation-flow-observation-2026-07-22.md`。

**单元 C —— 项目级 AGENTS.md 注入（✅ 场景 A 复测已确认）**

单元 C 早期实测发现项目级 AGENTS.md 未被注入，但受时序污染（AGENTS.md 晚于会话初始化创建）。**场景 A 复测已定论**：AGENTS.md 已存在时开新会话，被干净注入为 workspace instructions（agent 明确回答收到两份 AGENTS.md：全局 + 工作区）。单元 C 偏差归因于时序，注入机制本身符合断言。详见 §3 开头 + §3.5 末尾。

> 完整记录见 `D:/workspace/projects/godot-test-project/docs/mcp-project-rules-injection-test-2026-07-22.md`。

### 6.3 实测可用配置

本次实测使用的 godot MCP 配置（`~/.zcode/cli/config.json`，本地 build 直跑方式）：

```json
{
  "godot": {
    "type": "stdio",
    "command": "node",
    "args": ["D:/GitHub/godot-mcp-enhanced/build/index.js"],
    "env": {
      "DEBUG": "true",
      "GODOT_PATH": "D:/godot/Godot_v4.7-stable_win64_console.exe",
      "GODOT_MCP_MODE": "editor",
      "ALLOWED_PROJECT_PATHS": "D:/workspace/projects/CardGame2;D:/workspace/projects/godot-test-project;D:/GitHub/godot-mcp-enhanced"
    }
  }
}
```

> 与 [§2 方式 A](#方式-a-zcode-gui) 的 `npx -y godot-mcp-enhanced` 等价（公开分发版 vs 本地开发版）。

### 6.4 未覆盖区（不阻塞定论）

以下一项在 yolo 模式下未实测，但不阻塞当前定论（定论已标注适用范围为 yolo 模式）：

| # | 未实测项 | 方法 | 影响章节 | 当前定论的边界 |
|---|---------|------|---------|---------------|
| 1 | **「变更前确认」执行模式下客户端层是否介入** | 切「变更前确认」模式，重跑 `write_config`，观察是否弹客户端层 UI 确认窗 | §5.3 | 当前定论仅覆盖 yolo 模式（客户端零介入）；若「变更前确认」模式客户端会拦截，则 §5.3 定论需扩展。保守建议仍用「变更前确认」模式兜底（见 §5.2）。 |

---

## 7. 限制与故障排查

- **✅ 文档断言实测确认**：本指南的 ZCode 机制依据官方文档（2026-07-22 抓取）+ Task 8 实测（2026-07-22，单元 A/B/C + 场景 A）。协议层 / server 层确认 / 规则主动读取 / 项目级 AGENTS.md 注入均已实测确认（场景 A 证实断言成立，单元 C 偏差归因时序）。唯一未覆盖区是「变更前确认」执行模式下客户端层行为（见 [§6.4](#64-未覆盖区不阻塞定论)），不阻塞定论。
- **AGENTS.md 单文件**：ZCode 不扫描子目录、不展开 `@import`、不合并多层级 `AGENTS.md`（场景 A 实测确认）。**时序注意**：AGENTS.md 必须在会话开始前已存在，会话进行中创建的不会被注入（单元 C 教训）。`setup_project_rules` 生成的 `.claude/rules/*.md` 不依赖注入机制，agent 可随时主动 `Read`（见 [§3.5](#35-两套独立机制clauderules-规则文件-vs-agentsmd-注入)）。
- **方式 C 非自动同步**：从 Claude Code 等导入的配置是**一次性拷贝**，原配置后续变更不自动同步——需重新点导入。
- **`.zcode` / `.agents` 优先级**：同作用域下 `.zcode` 强优先，混用时务必合并，否则 `.agents` 配置静默失效。
- **运行时操作不持久化**：与在其他客户端一致，`signal_connect` / `tilemap_set_cell` / `particles_create` 等运行时操作只在执行上下文生效，不写盘。需持久化用 `add_node` + `save_scene`。详见 [使用指南 §3.3](使用指南.md#33-headless-执行-vs-持久化)。
- **启动时 stderr 日志**：godot-mcp 启动时会在 stderr 打几条日志（`[security] ... is ACTIVE` / `WARN resolveProjectPath` / `Auto-launching Dashboard TUI...`），**不影响功能**。具体含义见 [使用指南-Warp §8](使用指南-Warp.md#8-已知行为启动时-stderr-预期输出)。

---

## 8. 参考

- [ZCode MCP 服务器（官方）](https://zcode.z.ai/cn/docs/mcp-services) — 配置作用域、三种录入方式、外部配置导入
- [ZCode Agent（官方）](https://zcode.z.ai/cn/docs/agents) — `AGENTS.md` 读取模型（不读 `CLAUDE.md`、不扫描子目录）
- [ZCode 安全确认（官方）](https://zcode.z.ai/cn/docs/safety-confirm) — 4 种执行模式 + 决策选项
- [使用指南](使用指南.md) — godot-mcp-enhanced 完整工具用法、核心概念、安全模型
- [使用指南-Warp](使用指南-Warp.md) — env 契约、`working_directory` 坑、协议层验证脚本（与客户端无关，ZCode 复用）
- [README](../README.md) — 1 分钟配置（Claude Code / Cursor / Codex 等其他客户端）

---

*本文档基于 ZCode 官方文档（mcp-services / agents / safety-confirm 页，2026-07-22 抓取）+ Task 8 实测（2026-07-22，单元 A/B/C + 场景 A 复测）撰写。协议层、server 层确认、规则主动读取、项目级 AGENTS.md 注入均已实测确认；yolo 模式下客户端层确认 UI 形态已确认（零介入、无 elicitation）。唯一未覆盖区是「变更前确认」执行模式下客户端层行为（见 §6.4），保守兜底建议见 §5.2。如 ZCode 行为有变，以 [ZCode 官方文档](https://zcode.z.ai/cn/docs) 为准。*
