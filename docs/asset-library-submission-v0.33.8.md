# Godot Asset Library 提交材料 — v0.33.8

> 提交入口：https://godotengine.org/asset-library/asset/edit （需 Godot 账号登录）
> **本次为编辑已有条目 5193**：更新 Version string + Download URL 两处必改；Description 安全条目微补。提交后进入审核队列（初列 Testing，编辑审核后转 Community）。
>
> ⚠️ **前置依赖（提交 AssetLib 前必须完成）**：
> 1. **`git push` master**——Download URL 是 commit 归档直链,基准 commit `f72db504` 必须先在 GitHub 远端可达,否则审核员点开 404 直接拒。
> 2. 基准选择说明(2026-09-18):master HEAD(252d5889,EXPORT-1 导出守卫)版本链未走完(BRIDGE_SCRIPT_VERSION 0.33.9 vs package.json/plugin.cfg/matrix 0.33.8),故本次材料锚定**最后一个版本一致点 f72db504(v0.33.8 全链)**;EXPORT-1 链走完后下次更新再上。
>
> Download URL 惯例（2026-08-19 纠偏后沿用）：**GitHub commit 归档直链**（非 release zip）：
> `https://github.com/wgt19861219/godot-mcp-enhanced/archive/<完整40位SHA>.zip`

## 表单字段对照

| 字段 | 填写值 | 本次是否改动 |
|------|--------|------------|
| **Title** | `godot-mcp-enhanced — MCP Server for AI` | 不变 |
| **Category** | Tools | 不变 |
| **Godot version** | 4.5 | 不变（插件兼容 4.5–4.7） |
| **License** | MIT | 不变 |
| **Version string** | `0.33.8` | **必改**（在库 0.33.1,2026-09-14 过审） |
| **Download provider** | GitHub | 不变 |
| **Download URL** | `https://github.com/wgt19861219/godot-mcp-enhanced/archive/f72db504c25a092b0af13fb59bd9f427f9260610.zip` | **必改** |
| **Repository / Browse URL** | `https://github.com/wgt19861219/godot-mcp-enhanced` | 不变 |
| **Issues URL** | `https://github.com/wgt19861219/godot-mcp-enhanced/issues` | 不变 |
| **Icon URL** | `https://raw.githubusercontent.com/wgt19861219/godot-mcp-enhanced/master/icon.png`（256×256 PNG） | 不变 |
| **Previews** | 主图 `https://raw.githubusercontent.com/wgt19861219/godot-mcp-enhanced/master/store-thumbnail.png`（1280×720） | 不变 |

**归档内容校验（已实测,2026-09-18）**：commit `f72db504` 归档内 `addons/godot_mcp_server/plugin.cfg` 的 `version="0.33.8"`、`package.json` `"version": "0.33.8"`（`git show f72db504:...` 核实）；工具计数 46 tools / 271 actions（`node scripts/check-tool-count.mjs` 权威值,24 处文档校验一致,matrix version=0.33.8）——计数与在库 0.33.1 相同（0.33.2–0.33.8 无新工具,为鲁棒性/安全/重构批次）。

## Description（BBCode,直接粘贴）

> 相比在库 0.33.1：计数不变（46 tools / 271 actions）；亮点列表的 Systematic safety guards 条目补"hardened numeric parameter guards"一句（0.33.2–0.33.8 架构审查六批次的用户可感面）;其余不变。

```bbcode
[b]godot-mcp-enhanced[/b] — a production-grade [b]Model Context Protocol (MCP)[/b] server bridging AI coding agents (Claude Code, Cursor, CodeBuddy, Cline, Codex CLI, ...) to the Godot editor.

This editor plugin is the Godot-side companion of the [url=https://github.com/wgt19861219/godot-mcp-enhanced]godot-mcp-enhanced[/url] npm package — together they give your AI agent:

[list]
[*][b]Live editor integration[/b] — real-time scene tree sync, undo/redo integration, multi-instance routing
[*][b]Native DAP debugger[/b] — the MCP server speaks Godot's built-in Debug Adapter Protocol directly: breakpoints, stack traces, variable inspection, stepping, REPL
[*][b]Deterministic playtest control[/b] — freeze/unfreeze/step_until with structured conditions, snapshot/restore, seed locking, frame-timed input timelines (L3 true determinism)
[*][b]Game bridge[/b] — query/write running games, input simulation, watch/monitor with explainable output (per-property drop naming + numeric min/max summaries), UI discovery, network condition emulation for multiplayer testing
[*][b]Hot-reloadable project commands[/b] — drop a .gd into res://mcp_commands/ to extend the bridge at runtime, plus multi-instance state snapshots for sync verification
[*][b]Systematic safety guards[/b] — GDScript sandbox scanning (regex + tokenizer), dangerous-API deny-lists, path whitelisting, hardened numeric parameter guards on all bridge/editor channels (malformed params get readable errors instead of silent failures), stale-version self-diagnostics, untrusted-output envelopes, self-asset write protection, operation-level audit log
[*][b]46 tools / 271 actions[/b] — scenes, scripts, animation, TileMap, navigation, particles, audio, UI layout, recording, profiler, and more
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

## 在库版本历史(条目 5193)

- v0.29.0 — 2026-08-15 上线(Community 首发过审)
- v0.33.1 — 2026-09-14 过审(当前在库,本次更新基准前值)
- v0.33.8 — 本次提交(审核中 → Testing → Community)
