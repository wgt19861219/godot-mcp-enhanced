# Capability Matrix

> 自动生成，勿手改。由 `npm run build-matrix` 产出，漂移检测见 `npm run diff-matrix`。

## 概览
- 工具总数：34
- securityLevel：danger-api 8 / guarded 16 / safe 10
- risk：read 98 / write 79 / destructive 8 / process 13
- L2 覆盖：covered 0 / partial 0 / none 34
- token 预算：tools/list ≈ 69943B / ~17486 tokens（description 8485B / schema 61458B，schema 占 88%）
> 注：标 read 但实际启进程/有副作用(项目有意信任不确认): `validation.run_and_verify`, `validation.verify_delivery`

## danger-api 工具（L2 安全回归优先）
- `godot_get_context` (core)
- `manage_tools` (core)
- `project` (core)
- `runtime` (core)
- `scene` (core)
- `script` (core)
- `ui` (ui)
- `validation` (core)

## 覆盖缺口（L2=none）
- `android` (android)
- `animation` (animation)
- `animtree` (animation)
- `asset` (asset)
- `audio` (audio)
- `blender` (blender)
- `cpp` (code)
- `csv_to_resources` (unknown)
- `docs` (code)
- `editor` (editor)
- `game` (bridge)
- `godot_advanced_tool` (dynamic)
- `godot_get_context` (core)
- `godot_list_dynamic_routes` (dynamic)
- `godot_list_instances` (multi_instance)
- `godot_select_instance` (multi_instance)
- `load_skill` (code)
- `manage_tools` (core)
- `material` (visual)
- `nav` (navigation)
- `particles` (visual)
- `physics` (physics)
- `profiler` (profiler)
- `project` (core)
- `runtime` (core)
- `scene` (core)
- `screenshot` (visual)
- `script` (core)
- `self_update` (selfupdate)
- `signal` (signal)
- `tilemap` (tilemap)
- `ui` (ui)
- `validation` (core)
- `workflow` (profiler)

## gdScriptImpl 说明
- editor 侧：addons/godot_mcp_server/commands/*_commands.gd 按 group 匹配
- headless 侧：恒为 exists=false（GDScript 由 gdscript-executor 运行时生成，无静态 1:1 文件）
- editor 侧：按工具命令精确路由（EDITOR_COMMAND_ROUTING，源 command_handler.gd handle() 路由表）

## token 预算 TOP 5
-
 
`
u
i
`
 
(
u
i
)
:
 
d
e
s
c
 
3
0
8
B
 
/
 
s
c
h
e
m
a
 
8
9
2
1
B
 
/
 
t
o
t
a
l
 
9
2
2
9
B


-
 
`
s
c
e
n
e
`
 
(
c
o
r
e
)
:
 
d
e
s
c
 
2
7
7
B
 
/
 
s
c
h
e
m
a
 
4
7
8
0
B
 
/
 
t
o
t
a
l
 
5
0
5
7
B


-
 
`
w
o
r
k
f
l
o
w
`
 
(
p
r
o
f
i
l
e
r
)
:
 
d
e
s
c
 
2
2
8
B
 
/
 
s
c
h
e
m
a
 
4
2
2
4
B
 
/
 
t
o
t
a
l
 
4
4
5
2
B


-
 
`
g
a
m
e
`
 
(
b
r
i
d
g
e
)
:
 
d
e
s
c
 
5
9
2
B
 
/
 
s
c
h
e
m
a
 
3
2
7
4
B
 
/
 
t
o
t
a
l
 
3
8
6
6
B


-
 
`
a
n
i
m
a
t
i
o
n
`
 
(
a
n
i
m
a
t
i
o
n
)
:
 
d
e
s
c
 
3
4
5
B
 
/
 
s
c
h
e
m
a
 
3
4
6
6
B
 
/
 
t
o
t
a
l
 
3
8
1
1
B