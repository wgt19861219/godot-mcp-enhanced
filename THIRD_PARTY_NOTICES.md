# Third-Party Notices

本仓库（godot-mcp-enhanced，MIT）包含源自下列第三方项目的移植代码。
各上游 license 于 2026-10-01 经 GitHub API 核实（`repos/<owner>/<repo>` 的 license 字段）；
除 NPGameDev 外均为 MIT，与本仓库 MIT 再许可兼容。

> 维护约定：新增"整文件/函数级移植"时必须同步本表（来源仓库 + 移植位置 + license），
> 并在移植文件头注释标注来源与 license。CI 侧无机械门禁，靠 review 把关。

## Erodenn/godot-mcp-runtime（MIT ✓）

| 移植位置 | 上游文件 | 形态 |
|---|---|---|
| `src/core/gdscript-scanner.ts` | `src/utils/gdscript-scanner.ts` | 整文件移植（2026-09-11 P6 批；适配点仅头注释与尾部 `classifyFirstArgument`） |
| `src/core/function-profiler.ts` | `src/utils/profiler.ts` | 整文件移植（2026-09-11 P2 批；除头注释/import/logger 外逐行一致） |
| `src/core/godot-variant.ts` | `src/utils/godot-variant.ts` | 整文件移植（2026-09-11 P2 批；原文件零依赖，除注释外逐行一致） |

## LuoxuanLove/godot-dotnet-mcp（MIT ✓）

| 移植位置 | 上游文件 | 形态 |
|---|---|---|
| `src/tools/dap.ts` | `addons/.../tools/dap/executor.gd`（791 行 GDScript） | 机制移植（TS 直连 editor 自带 DAP server 的协议驱动逻辑，2026-09 P2 批） |

## masteryee-labs/Open-Godot-MCP（MIT ✓）

| 移植位置 | 上游功能 | 形态 |
|---|---|---|
| `src/tools/game-bridge.ts`（P10 sync_state） | `sync_state` 快照存储与比对 | 移植裁剪（快照/比对两段式，不做进程编排；`mcp_bridge.gd` 侧同步） |
| `src/tools/game-bridge.ts`（P3-1） | `network_conditioner` 弱网注入 | 移植裁剪 |

## regiellis/godot-mcp-go（MIT ✓）

| 移植位置 | 上游功能 | 形态 |
|---|---|---|
| `src/core/args-validator.ts`（P8-2） | `_reject_unknown_params` | 函数级移植 + did-you-mean（similarity ≥ 0.4） |

## NPGameDev/godot-mcp-server（license 未确认 ⚠️）

GitHub API 报 `NOASSERTION`（非标/自定义 license），**需人工核实其 LICENSE 全文后再定
再许可合规性**。移植范围（小，合计 <50 行）：

| 移植位置 | 上游文件 | 形态 |
|---|---|---|
| `src/core/untrusted-wrap.ts` | `untrusted.gd`（26 行 GDScript） | 机制移植（输出侧 untrusted 内容信封，防 GDScript 伪造 MCP 输出） |
| `src/tools/shared/file-guard.ts` | `file_guard.gd:102-115` | 函数级移植（写路径护栏） |

## 已在 LICENSE 致谢（非移植，衍生/资产来源）

- **Coding-Solo/godot-mcp**（MIT）：本项目早期 fork 源，见 LICENSE 版权行。
- **AssetForge**（fork 自 Tripo3D Godot Bridge）：asset 工具集的 GDScript 资产生成逻辑，见 LICENSE Acknowledgements。
