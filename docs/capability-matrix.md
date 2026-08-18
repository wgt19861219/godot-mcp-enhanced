# Capability Matrix

> 自动生成，勿手改。由 `npm run build-matrix` 产出，漂移检测见 `npm run diff-matrix`。

## 概览
- 工具总数：43
- securityLevel：danger-api 11 / guarded 21 / safe 11
- risk：read 120 / write 94 / destructive 10 / process 16
- L2 覆盖：covered 0 / partial 0 / none 43
- token 预算：tools/list ≈ 88280B / ~22070 tokens（description 15501B / schema 72779B，schema 占 82%）
- annotations：readOnly 10 / destructive 5 / idempotent 13
> 注：标 read 但实际启进程/有副作用(项目有意信任不确认): `validation.run_and_verify`, `validation.verify_delivery`

## danger-api 工具（L2 安全回归优先）
- `audit` (core)
- `godot_get_context` (core)
- `help` (core)
- `manage_tools` (core)
- `project` (core)
- `runtime` (core)
- `runtime_assert` (core)
- `scene` (core)
- `script` (core)
- `ui` (ui)
- `validation` (core)

## 覆盖缺口（L2=none）
- `analysis` (code)
- `android` (android)
- `animation` (animation)
- `animation_track` (animation)
- `animtree` (animation)
- `asset` (asset)
- `audio` (audio)
- `audit` (core)
- `blender` (blender)
- `cpp` (code)
- `csv_to_resources` (unknown)
- `debug` (debug)
- `docs` (code)
- `editor` (editor)
- `engine` (engine)
- `game` (bridge)
- `godot_advanced_tool` (dynamic)
- `godot_get_context` (core)
- `godot_list_dynamic_routes` (dynamic)
- `godot_list_instances` (multi_instance)
- `godot_select_instance` (multi_instance)
- `help` (core)
- `load_skill` (code)
- `manage_tools` (core)
- `material` (visual)
- `nav` (navigation)
- `particles` (visual)
- `physics` (physics)
- `profiler` (profiler)
- `project` (core)
- `qa` (bridge)
- `runtime` (core)
- `runtime_assert` (core)
- `scene` (core)
- `screenshot` (visual)
- `script` (core)
- `self_update` (selfupdate)
- `signal` (signal)
- `testing` (unknown)
- `tilemap` (tilemap)
- `ui` (ui)
- `validation` (core)
- `workflow` (profiler)

## gdScriptImpl 说明
- editor 侧：addons/godot_mcp_server/commands/*_commands.gd 按 group 匹配
- headless 侧：恒为 exists=false（GDScript 由 gdscript-executor 运行时生成，无静态 1:1 文件）
- editor 侧：按工具命令精确路由（EDITOR_COMMAND_ROUTING，源 command_handler.gd handle() 路由表）

## token 预算 TOP 5
- `game` (bridge): desc 1117B / schema 5368B / total 6485B
- `ui` (ui): desc 1207B / schema 4666B / total 5873B
- `scene` (core): desc 277B / schema 4780B / total 5057B
- `workflow` (profiler): desc 228B / schema 4224B / total 4452B
- `screenshot` (visual): desc 269B / schema 3737B / total 4006B