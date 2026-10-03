# Godot Asset Library 提交材料 — v0.34.0

> 提交入口：https://godotengine.org/asset-library/asset/edit （需 Godot 账号登录）
> **本次为编辑已有条目 5193**：更新 Version string + Download URL 两处必改；Description 增补 daemon 亮点并更新计数（271→272）。提交后进入审核队列（初列 Testing，编辑审核后转 Community）。
>
> Download URL 惯例（2026-08-19 纠偏后沿用）：**GitHub commit 归档直链**（非 release zip）：
> `https://github.com/wgt19861219/godot-mcp-enhanced/archive/<完整40位SHA>.zip`
> SHA 取自 master HEAD `0efa371b`（0.34.0 发版+CI 平台耦合修复后的 **CI 全绿点**，run 37092798251 四 job 全过实证;归档含 CI 修复后的测试与入库的 fixture 锚定文件,插件本体与发版 merge 9fdc2bac 完全一致）。

## 表单字段对照

| 字段 | 填写值 | 本次是否改动 |
|------|--------|------------|
| **Title** | `godot-mcp-enhanced — MCP Server for AI` | 不变 |
| **Category** | Tools | 不变 |
| **Godot version** | 4.5 | 不变（插件兼容 4.5–4.7） |
| **License** | MIT | 不变 |
| **Version string** | `0.34.0` | **必改**（原 0.33.1） |
| **Download provider** | GitHub | 不变 |
| **Download URL** | `https://github.com/wgt19861219/godot-mcp-enhanced/archive/0efa371b71299f6d39fac43cd664518d66131bff.zip` | **必改** |
| **Repository / Browse URL** | `https://github.com/wgt19861219/godot-mcp-enhanced` | 不变 |
| **Issues URL** | `https://github.com/wgt19861219/godot-mcp-enhanced/issues` | 不变 |
| **Icon URL** | `https://raw.githubusercontent.com/wgt19861219/godot-mcp-enhanced/master/icon.png`（256×256 PNG） | 不变 |
| **Previews** | 主图 `https://raw.githubusercontent.com/wgt19861219/godot-mcp-enhanced/master/store-thumbnail.png`（1280×720） | 不变 |

**归档内容校验（已实测）**：commit `0efa371b` 归档内 `addons/godot_mcp_server/plugin.cfg` 的 `version="0.34.0"`（`git show HEAD:addons/godot_mcp_server/plugin.cfg` 核实）；工具计数 46 tools / **272 actions**（`node scripts/check-tool-count.mjs` 权威值，27 处文档校验一致，matrix version=0.34.0）。

## Description（BBCode，直接粘贴）

> 相比在库版本（0.33.1）更新：亮点列表**新增 daemon 常驻进程条目（置顶第二条）**；计数 271→272；其余不变。

```bbcode
[b]godot-mcp-enhanced[/b] — a production-grade [b]Model Context Protocol (MCP)[/b] server bridging AI coding agents (Claude Code, Cursor, CodeBuddy, Cline, Codex CLI, ...) to the Godot editor.

This editor plugin is the Godot-side companion of the [url=https://github.com/wgt19861219/godot-mcp-enhanced]godot-mcp-enhanced[/url] npm package — together they give your AI agent:

[list]
[*][b]Live editor integration[/b] — real-time scene tree sync, undo/redo integration, multi-instance routing
[*][b]Optional resident daemon[/b] — run the server as a persistent background process ([code]daemon start[/code]) exposing a streamable-HTTP [code]/mcp[/code] endpoint for type:http clients, with single-session exclusivity, controlled restart handover, and a web GUI settings tab (Godot path & project whitelist, hot-reload on save)
[*][b]Native DAP debugger[/b] — the MCP server speaks Godot's built-in Debug Adapter Protocol directly: breakpoints, stack traces, variable inspection, stepping, REPL
[*][b]Deterministic playtest control[/b] — freeze/unfreeze/step_until with structured conditions, snapshot/restore, seed locking, frame-timed input timelines (L3 true determinism)
[*][b]Game bridge[/b] — query/write running games, input simulation, watch/monitor with explainable output (per-property drop naming + numeric min/max summaries), UI discovery, network condition emulation for multiplayer testing
[*][b]Hot-reloadable project commands[/b] — drop a .gd into res://mcp_commands/ to extend the bridge at runtime, plus multi-instance state snapshots for sync verification
[*][b]Systematic safety guards[/b] — GDScript sandbox scanning (regex + tokenizer), dangerous-API deny-lists, path whitelisting, untrusted-output envelopes, self-asset write protection, operation-level audit log
[*][b]46 tools / 272 actions[/b] — scenes, scripts, animation, TileMap, navigation, particles, audio, UI layout, recording, profiler, and more
[/list]

[b]Requirements[/b]
Godot 4.5–4.7 (tested on 4.6.3 & 4.7.2). The MCP server itself runs on Node.js: [code]npm i -g godot-mcp-enhanced[/code]

[b]Quick start[/b]
1. Enable this plugin: Project Settings → Plugins → [i]MCP Server[/i]
2. Install the server: [code]npx godot-mcp-enhanced setup[/code] (auto-configures your MCP client)
3. Ask your AI agent to open a scene, run the game, or set a breakpoint — in natural language

中文说明与完整文档见 [url=https://github.com/wgt19861219/godot-mcp-enhanced#readme]README[/url]（简体中文为主）。
```

## 备选（若表单 Provider 无 GitHub 项）

download_provider 选 Custom link，Download URL 不变（同一归档直链）。

## 提交后跟进

- 审核期间状态为 Testing；被编辑批准后转 Community
- 本次变更说明（若表单有 notes 字段可附）：
  - **v0.34.0（daemon 专项 + 审查收口）**：可选常驻守护进程——CLI `daemon start/stop/status/restart` 四命令，内嵌单 GodotServer + streamable HTTP `/mcp` endpoint（type:http 客户端直连，Web 面板不再随 stdio 会话生灭），单会话独占（第二 Initialize 409）+ 受控交接；web-gui 实例管理（daemon 三态/端口占用/交接指引）与设置面板（Godot 路径与项目白名单 GUI 配置，保存即热生效）；2026-10-01 全维度审查修复八批（npm 打包守护/daemon 与 web-gui 安全项/Node 20 元数据统一/THIRD_PARTY_NOTICES 三方声明等）；易用性收尾——GODOT_PATH 显式配置校验失败按 stage 分层报错不再静默 fallback（doctor 透出原因）、Linux CI 平台耦合测试债清偿
  - 工具计数 271→272 actions（46 tools 不变）
