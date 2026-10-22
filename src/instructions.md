# Godot MCP Enhanced 使用速查

三层架构（headless + editor + bridge），覆盖场景/脚本/UI/动画/物理/粒子/导航/音频/测试/导出等领域。工具清单见 `manage_tools`（action=list_groups/discover 可查全量工具与激活态）。

## 三层模式决策

- **静态读写 .tscn/.gd** → headless：`edit_script`（优先 `search_and_replace`）/ `write_script` / `batch_*`
- **编辑器实时场景** → editor：`launch_editor` + `editor_*`（需插件连接）
- **运行中游戏** → bridge：`game_query` / `game_input` / `game_write`（需 `game_bridge_install` + 游戏运行）
- **一次性验证** → `run_and_verify` / `verify_delivery` / `validate_scripts`

## 五大致命陷阱

1. **运行时工具不持久化**：`signal_*` / `particles_*` / `ui_*` / `audio_*` 等 headless 运行时变更在进程退出后丢失；需持久化用 `add_node` + `save_scene` 或 `write_script`。
2. **edit_script 优先 search_and_replace**：基于内容匹配，对行号偏移鲁棒、CRLF 安全；勿用 Claude 内置 Edit 编辑 .gd（tab 缩进匹配率极低）。
3. **2D 截图 headless 空白**：headless 不渲染 2D CanvasItem，`screenshot` 返回 `BLANK_DETECTED` 时改用：① Bridge `take_screenshot`（游戏运行中）/ ② `screenshot(action=analyze)` 传外部截图 / ③ 手动截图。3D 不受影响。
4. **节点路径须 /root/ 前缀**：凡带 path/node_path 的 game_* 工具（game_query / game_write / game_wait / game_input / click_button / monitor / watch）必须 `/root/` 开头（如 `/root/Main/Player`）。
5. **Bridge 密钥 5min TTL**：长时间未操作后首次调用可能稍慢；权限循环设 `GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true`（由 bridge 游戏进程读取，须启动游戏前设置、重启生效）。

## 安全模型

deny-by-default 路径白名单（`ALLOWED_PROJECT_PATHS`）+ GDScript 沙箱是**防误操作层**，非不可绕过的安全边界；不可信环境用容器/VM。

## 运行时详情

`manage_tools`（工具组启用/状态）· `godot_get_context`（会话全景：mode/connections/scene/performance）
