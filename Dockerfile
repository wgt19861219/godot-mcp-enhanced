# godot-mcp-enhanced — Enhanced MCP server for Godot 4.5-4.7
#
# 用于 Glama / MCP 目录的 introspection 验证：
# Glama 跑此镜像 → 连 stdio → 发 initialize + tools/list → 验证响应。
# server 启动 + 响应 introspection 不需要 Godot 引擎（Godot 仅在工具调用时才查找）。
FROM node:18-slim

# 安装已发布的 npm 包（含 bin: godot-mcp-enhanced -> build/index.js）
RUN npm install -g godot-mcp-enhanced@0.33.5

# 本地开发模式（跳过 ALLOWED_PROJECT_PATHS 白名单校验）
# Glama check 只发 initialize/tools/list 不调工具，但开启更稳，避免任何路径相关警告中断
ENV GODOT_MCP_UNRESTRICTED=true

# stdio MCP server — Glama 经 stdin/stdout JSON-RPC 通信
ENTRYPOINT ["godot-mcp-enhanced"]
