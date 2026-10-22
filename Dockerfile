# godot-mcp-enhanced — Enhanced MCP server for Godot 4.5-4.7
#
# 用于 Glama / MCP 目录的 introspection 验证：
# Glama 跑此镜像 → 连 stdio → 发 initialize + tools/list → 验证响应。
# server 启动 + 响应 introspection 不需要 Godot 引擎（Godot 仅在工具调用时才查找）。
FROM node:20-slim

# 安装已发布的 npm 包（含 bin: godot-mcp-enhanced -> build/index.js）
RUN npm install -g godot-mcp-enhanced@0.35.0

# Glama check 只发 initialize/tools/list,不调工具,无需任何安全旁路 env。
# B-1(2026-10-22 审查):曾设 GODOT_MCP_UNRESTRICTED=true,与 index.ts runStartupSequence
# 的生产模式 FATAL 检查冲突,容器启动即 exit 1。已删除。

# stdio MCP server — Glama 经 stdin/stdout JSON-RPC 通信
ENTRYPOINT ["godot-mcp-enhanced"]
