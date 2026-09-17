---
description: "game bridge game_query game_input game_write game_wait game_bridge_install game_bridge_uninstall 运行时 TCP 密钥认证 端口 9081 autoload mcp_bridge E2E 测试 调试"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.17.0+

## 概述与架构

Game Bridge 是 MCP 服务端与**运行中的游戏**之间的 TCP 通信层。

- **三层区别**：Headless（独立 Godot 进程）vs Editor（连接 IDE）vs Bridge（连接运行时游戏）
- **通信方式**：MCP 服务端 → TCP JSON-RPC 2.0 → 游戏内 mcp_bridge.gd autoload
- **使用场景**：E2E 测试、运行时调试、输入模拟、状态验证、截图验证
- **前提**：游戏必须正在运行（F5 或 run_project），且已安装 Bridge autoload

## 工具清单

### 安装管理

| 工具 | 说明 |
|------|------|
| `game_bridge_install` | 安装 Bridge autoload 到项目（注册 autoload + 配置端口 9081） |
| `game_bridge_uninstall` | 卸载 Bridge autoload |

### 查询 — game_query

| method | 说明 |
|--------|------|
| `ping` | 检查游戏是否运行 |
| `get_tree` | 获取场景树结构 |
| `find_nodes` | 按名称/类型/路径查找节点。params 可传 root 限定子树搜索范围（推荐绝对路径如 /root/Main；节点不存在时报错非静默全树）；near_node+max_distance 近邻查询（锚点须 Node2D/Node3D，只收同维度节点按距离升序含 distance 字段，锚点自身排除；max_distance 默认 1000）；observation_profile 观察档见「语义观察层」段 |
| `get_node_properties` | 获取节点属性值 |
| `get_node_layout` | 获取节点完整布局快照（type + position/global_position 成对 + Control anchor/offset + Sprite2D centered + Node3D Vector3，全走 _jsonify） |
| `get_performance` | 获取性能统计（FPS/内存等） |
| `get_viewport_info` | 获取视口信息 |
| `take_screenshot` | 从运行中的游戏截图 |
| `get_errors` | 查询游戏运行时错误（push_error/脚本报错/引擎错误），支持 `since_seq` 增量 + `clear` 读即焚 |
| `clear_errors` | 清空错误 buffer |

### 输入 — game_input

| method | 说明 |
|--------|------|
| `send_key` | 发送键盘事件（key + pressed） |
| `send_mouse_click` | 发送鼠标点击（x, y, button, pressed）。button 支持 int 1-9 或 left/right/middle |
| `send_mouse_move` | 移动鼠标（x, y；可选 button_mask 1=left/2=right/4=middle 位掩码，配合先 press 可模拟按住拖动） |
| `send_text` | 输入文本（text） |
| `send_input_sequence` | H1(2026-08-20) 帧定时输入时间线（timeline=[{at_frame:1-600 开窗后第N帧, type:"action"/"key"/"mouse_click"/"mouse_move"/"touch"/"drag", ...事件参数}], settle_frames, wall_budget_ms）。延迟响应;owner 互斥同 control 层;frozen 下自动开窗播放+完成 refreeze;与 playtest.seed/fixed_delta 组合=确定性完全体。action 事件需 name 在项目 InputMap |

**输入注入管线要点（反馈批次C 2026-09-17 真机定谳）**：
- 坐标口径：x/y 为**窗口/视口坐标**（非屏幕坐标、非控件本地坐标）。引擎派发时自动局部化——Control 的 `gui_input` 收到 `position` 为控件局部坐标、`global_position` 为窗口坐标；跨容器/CanvasLayer 取点用 `get_node_layout` 的 global 值
- 覆盖面（e2e 锚定 `test/e2e-bridge-mouse-gui.test.ts`）：Button/TextureButton 的 pressed 链与普通 Control 的 `gui_input`（含 press→release 位移判 tap 的自定义判定链）均触发；headless 与带窗口 spawn 均正常派发；注入事件 device=0/global_position 与真实管线一致
- 注入无效排查顺序：① 多实例连错——`ping` 核对 pid/project 指纹 ② 坐标口径错位（控件本地/父容器坐标误当窗口坐标）③ 项目内 addons 旧版——`game_bridge_install` 重装同步
- 复杂交互（自定义 tap/drag 判定链）：press 与 release 分两次注入并间隔若干帧；帧对齐需求走 `send_input_sequence`

### 写入 — game_write

| method | 说明 |
|--------|------|
| `set_node_property` | 设置节点属性值（path + property + value） |
| `call_method` | 调用节点方法（path + method + args）。CMP-9-B(2026-08-08)增强:默认只读白名单(get/has_*/get_meta 等),env `GODOT_MCP_BRIDGE_EXTRA_METHODS=method1,method2` 可扩展(含写方法如 take_damage),或游戏侧在节点脚本声明 const `GDA_CALLABLE` := ["方法名"](per-node 声明白名单,2026-09-11,default deny,零执行静态枚举);`EXTRA_METHODS_BLOCKLIST`(free/queue_free/set_script/call/emit_signal 等)是不可覆盖硬底线(env/声明均不可越过);args 按方法声明类型自动强转(传 [1,2,3] 给 Vector3 参数正确转换);强转不可达组合(个数不足/超出、类型不可转如 String→int 非数字、Dictionary→Object、typed Array)调用前显式报错 code -10(P0-1,防 callv 静默失败返回 null 被误读为成功);方法不存在时返回 did-you-mean 建议;response 含 undoable=false(call 不可 undo) |

### 等待 — game_wait

| method | 说明 |
|--------|------|
| `wait_for_node` | 等待节点出现（path） |
| `wait_for_property` | 等待属性值变化（path + property + value） |

### 监控 — monitor_start/stop/poll

| action | 说明 |
|--------|------|
| `monitor_start` | 开始属性采样（node_path + properties + interval_frames）。P0-3(2026-09-11):interval_frames 为 60fps 基准标称帧数,实际按游戏时间毫秒调度(interval_ms=interval_frames*1000/60),帧率变化节奏不漂移;paused/freeze 期间游戏时间停走不采样;样本含 t_game_ms 游戏时间戳。M-EXPLAIN(2026-09-01):返回 properties=实际监控列表,被安全过滤的属性逐个点名进 dropped_blocked;上限 20 属性/500 样本 |
| `monitor_stop` | 停止采样，返回完整时间线（附数值极值摘要 summary：min/max 及发生帧/时刻，仅数值属性） |
| `monitor_poll` | 获取当前采样数据（不停止；同样附 summary 与 interval_frames） |

### 信号监听 — watch_start/stop/poll

| action | 说明 |
|--------|------|
| `watch_start` | 监听信号事件（node_path + signal_name + max_events） |
| `watch_stop` | 停止监听，返回事件列表 |
| `watch_poll` | 获取已记录事件（不停止） |

### UI 发现 — find_ui_elements / click_button

| action | 说明 |
|--------|------|
| `find_ui_elements` | 查找可见 Control 节点（pattern / type / visible_only / limit / observation_profile），输出含 role/label 语义字段（见「语义观察层」段） |
| `click_button` | 点击按钮（text 或 path；real_event=true 走真实输入事件路径） |

### 弱网注入与自定义命令 — network_conditioner / custom_command

| action | 说明 |
|--------|------|
| `network_conditioner` | op=set/clear/status——包装 MultiplayerPeer 出向注入 latency_ms/loss_pct/jitter_ms（多人联机弱网测试，masteryee 同款 MultiplayerPeerExtension 装饰器） |
| `custom_command` | 调用游戏项目 res://mcp_commands/*.gd 声明的 custom.* 命令（method 必须以 custom. 开头，params 透传；支持运行中热加载，见下方「自定义命令热加载」段） |

### 自定义命令热加载 — mcp_commands 状态机（P8）

游戏运行中修改/新增/删除 `res://mcp_commands/*.gd` 会被 bridge 自动感知并重载（LuoxuanLove executor 模式移植），无需重启游戏：

- **扫描节奏**：每 300ms debounce tick 对比文件 mtime（`_process` 限频，无变更秒回）；变更标记 `reload_pending`。
- **quiesce 语义**：命令调用中（`active_calls > 0`）绝不换实例——重载/卸载推迟到调用归零（`waiting_quiesce`），防运行中 Callable 失效。
- **失败回滚**：新版本加载失败（非 Node/缺 get_commands/非 Dictionary 契约违反）→ slot 进 `reload_failed` + `last_error`，**旧实例与旧命令原样可用**（旧版本继续服务）。文件修好后下次 mtime 变更自动恢复。
- **独立加载（不走 ResourceLoader）**：新版本用 `FileAccess` 读源码 + `GDScript.new()` 独立对象加载——同路径 `ResourceLoader.load` 即使 `CACHE_MODE_IGNORE` 也会就地替换 ResourceCache 共享资源，旧实例的方法表随之消失（实测回滚保留的旧 Callable `is_valid()=false`）；独立对象加载失败即丢弃，旧脚本资源从未被触碰，回滚天然有效。
- **删除处理**：文件消失时若调用中则 `removed_pending` 等归零再卸载；空闲直接卸载 slot。
- **重名冲突**：多个 .gd 声明同一 `custom.xxx` → **路径字典序靠前者赢**（索引按 sort 顺序全量重建，与注册时间无关），后者 slot `reload_failed` 清空命令集（`last_error` 报 Duplicate）。
- **内建诊断**：`game(action=custom_command, method=custom.list)` 返回全部 slot 状态快照（state/version/commands/active_calls/pending_reload/last_error）——agent 可观察热加载结果与失败原因。
- **env 开关**：`GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD=0` 关闭热重载（退化为启动加载一次；mtime 变更不再触发重载，状态字段照常上报）。
- **⚠️ 已知引擎限制**：运行中写入**语法坏**的 .gd 会触发 Godot Script Debugger REPL（debug> 提示符停等 stdin，主循环挂死，bridge 不可防）——语法错误请在 IDE 侧先消灭；bridge 防线覆盖"合法语法但违反契约"的坏文件（如 extends RefCounted）。

### 多人状态同步 — sync_state（P10）

masteryee sync_state 移植裁剪——**快照/比对两段式原语，不做进程编排**（多游戏实例由用户/agent 起在各端口，bridge 端口避让已有；借连接切换打多个快照后比对）：

- **收集约定（游戏侧声明）**：节点实现 `_mcp_state() -> Dictionary` 即被 `collect_state` 收集（返回**离散状态**——wave/score/phase 等；浮点位置类建议游戏侧自行量化）。返回非 Dictionary 记 `__error__` 标记；嵌套 Object 递归降级 str()（不炸 JSON）；上限 256 节点/深度 8。
- **group 参数**（如 `mcp_watch`）：组内**无** `_mcp_state` 的成员记 `{"__present__": true}` 存在性标记——参与节点集比对（节点增删可测）。
- **快照流**：`game(action=sync_state, sub_action=snapshot, label=host)` 收集当前 bridge 状态存内存快照（进程生命周期）；切到另一实例连接再 snapshot(label=client)；`sub_action=compare, label_a=host, label_b=client, tolerance=0.0001` 比对；`list`/`clear` 管理快照。
- **浮点容差（关键设计——masteryee 亲读坑）**：数值 `|a-b|<=tolerance` 视为相等（默认 0.0001）；**Vector2/3/4/Color 自动转 `{x,y,z}` dict 走分量级容差**（裸几何类型经 JSON 序列化退化字符串会让容差完全失效——审查 B-1 清偿）；float 的 INF/NaN 降级字符串（防序列化漂移值语义）。原版 dict 严格相等比对在真实多人游戏**永远 false**（host/client 各自物理步进后浮点位置不逐位相等）——容差参数是该坑的修复，比对语义的一部分。
- **比对输出**：`in_sync` / `paths_compared` / `missing_in_b` / `missing_in_a` / `diffs[{path,key,a,b}]`（键级 diff，嵌套数值在容差内不报）。
- **典型用法**（多人同步验证）：起 host+client 两游戏 → 各自连接 → 同一逻辑时刻各 snapshot → compare 容差调到游戏可接受精度 → `in_sync=true` 证明状态同步；diffs 定位失步字段。
- **边界（诚实声明）**：collect_state **不经 P7 观察层**（observation_profile 不生效）——`_mcp_state` 是游戏方声明面（与 custom_command 同构，节点自己决定暴露什么），player 档下需过滤的由游戏方在 `_mcp_state` 内自实现；快照 label 进程内全局（跨实例场景建议带实例前缀防静默覆盖）；256 节点截断时响应含 `truncated: true`（两侧同截断可能漏比，扩容靠游戏侧收窄声明面）。

### 语义观察层 — observation_profile（P7）

观察通道（`find_nodes` / `get_node_properties` / `get_node_layout` / `get_tree` / `find_ui_elements` / `monitor_start` / `watch_start` / `game_wait` 的 wait_for_node·wait_for_property / `call_method` / playtest.step·step_until 的 report 搭车与 conditions）支持 `observation_profile` 参数（`"debug"|"player"`，默认 debug；game_query/game_wait/game_write 走 params 内同名键）：

- **debug**：直通现状——所有节点与属性全量可见（节点有规则也不投影）。
- **player**：投影档。**门禁三态**（env `GODOT_MCP_BRIDGE_ALLOWED_PROFILES`，启动时读一次）：未设/`debug` = 仅 debug（请求 player 得 -21，非法值 -20）；**单值 `player` = host 强制档**——全部观察请求被静默提升为 player（agent 不能自降级绕过投影，对齐 gua "profile 由 host 持有"）；多值 `debug,player` = 请求级可选（开发/测试模式）。生效行为：
  - **可见性级联**：节点或任一祖先 meta `agent_exposure="private"` 或 `visible_to_player=false`（bool 或字符串 "false"，均大小写不敏感）→ 整棵子树不可观察：不进 find_nodes/find_ui_elements/get_tree 结果（get_tree 整枝剪除）；get_node_properties/get_node_layout/monitor_start/watch_start/call_method 对其报 `Node not found`（存在性不泄露，报 404 而非 403）；wait_for_node 对其 exists=false；report 搭车/conditions 对其报 node not found。两维度正交：private=对象级整藏，visible_to_player=玩家不可见；与渲染 visible 无关（纯声明语义）。
  - **字段投影**：节点 meta `agent_field_rules`（Array，每条 `{path, mode, replacement?, quantum?}`；path 是输出 dict 键，支持 `position.x/y/z` 分量级；单节点上限 32 条，重复 path 后者覆盖）——`omit` 删键 / `redact` 数值归 0·bool 归 false·字符串换 "[redacted]" / `replace` 换声明替值（须安全标量，Object 型降级 redact）/ `quantize` 数值按 quantum snapped（整键作用于 dict 值如 position 时逐分量应用）。坏规则 fail-closed 降级为 redact（写错规则不会被惩罚成裸暴露）。规则每次查询实时读取，游戏运行中改 meta 即时生效（战争迷雾类动态语义）。
  - **call_method 读白名单同语义**：player 档下 `get(prop)` 返回值过字段投影（含 await_completion 协程路径）；结构枚举方法（get_children/get_child/get_child_count/get_parent/get_index/get_groups/get_incoming_connections/get_signal_connection_list）整组拒（-22——树已剪枝，枚举语义不成立且 index 两档漂移是错位陷阱，枚举请用 get_tree player 档）；其余白名单方法照常。
  - **wait_for_property / conditions**：current 显示与 match 比较均基于投影后值（防"显示投影值按真值 match"的二分探测侧信道）。
  - **playtest.snapshot / restore 在 player 档拒绝**（-23）——快照必须保真才能恢复，投影快照 restore 会把投影值写回游戏（语义冲突，诚实拒绝）。
  - **monitor/watch 中途隐藏**：采样/事件在节点不可观察期间静默跳过（时间线缺格），恢复可见自动续记；断线重连后订阅重发。
  - **near 联动**：player 档下 position 有任何字段规则的锚点被拒（-11，防距离差分反推隐藏/粗化坐标）、候选节点被静默排除。
  - **边界（诚实声明）**：watch 事件 args 不做字段投影（信号参数是位置参数无字段名——需要隐藏的信号把信号源藏进不可见子树，或不在 player 档监听）；**take_screenshot 是玩家视角的诚实呈现**（private 但渲染可见的节点在截图中视觉存在——渲染层的隐藏是游戏自己的 visible 逻辑，观察投影管数据通道不管像素）；写类操作（set_node_property/输入注入/click_button）不受观察档影响（授权走既有白名单三通道）；editor 层（read_scene 等 headless 文件操作）不经此层——"防看穿"覆盖 bridge 运行时数据通道。

`find_ui_elements` 输出含 `role`/`label`（**全档位**，语义信息非隐私）：Button→button、CheckBox/CheckButton→checkbox、OptionButton→combobox、Slider/SpinBox→slider、LineEdit/TextEdit→textbox、Label→text、ProgressBar→progressbar、ItemList→list、TabContainer→tablist、ScrollContainer→scrollarea、其余 Control→panel；label 取 text 类控件（Button/Label/LineEdit/TextEdit）的 text、OptionButton 取节点名（其 text 是选中项文本）、容器类取节点名。

### 工具组管理 — manage_tools

| action | 说明 |
|--------|------|
| `list_groups` | 列出所有工具组及其启用/停用状态 + 每 profile 实测 bytes/approxTokens 价格标签 |
| `activate` | 启用指定工具组（按名称） |
| `deactivate` | 停用指定工具组（按名称） |
| `sync` | 返回各工具组的 `requires` 连接状态（editor/bridge/headless） |
| `reconnect` | 触发 EditorConnection 重新连接（bridge 无持久连接，no-op） |

**行为说明**：
- `reconnect` 仅影响 Editor WebSocket 连接（端口 9090-9094）。Bridge 为持久 TCP 连接（30s keepalive、断线自动重连并重发订阅），无显式重连语义，故 no-op。
- `sync` 返回结构：`{ groups: [{ name, requires, status }, ...], editor: { installed, connected, state }, bridge: { note } }`。其中 **status**:editor 组 = `connected`/`disconnected`(基于 editor 连接);bridge 组 = `probe-required`(用 `game_query(method=ping)` 探测);无 requires 组(core/animation/ui 等)= `n/a`。**editor.state**:连上时用 healthMonitor(工具调用健康),未连报 `disconnected`,未启动报 `null`。**editor.installed** = editorConn 是否注入(launch_editor 后 true)。

## 使用指南

### 安装流程

1. 调用 `game_bridge_install(project_path)` — 注册 autoload、配置端口 9081
2. 在 Godot 中运行项目（F5 或 `run_project`）
3. 游戏启动后 Bridge 自动监听 TCP 连接
4. 使用 `game_query(method="ping")` 验证连接

### 安全机制

- **密钥认证**：安装时生成随机密钥文件，每次 TCP 连接需认证
- **本地绑定**：TCP 仅监听 127.0.0.1，不暴露到网络
- **密钥生命周期**：读取后缓存 5 分钟（TTL），文件权限收紧（0600/icacls）
- **防符号链接**：密钥文件若是 symlink 则拒绝读取

### 与 dev_loop 集成

dev_loop 的 `bridge` 参数可在执行 GDScript 后自动进行 Bridge 查询：

```json
{
  "bridge": {
    "screenshot": { "path": "user://test.png" },
    "queries": [
      { "method": "ping", "expect": "ok" },
      { "method": "find_nodes", "params": { "pattern": "Player" } }
    ]
  }
}
```

## 调用示例

### 检查游戏运行状态

```
game_query(method="ping")
// → { status: "ok", message: "Bridge connected" }

game_query(method="get_tree")
// → { root: "Node3D", child_count: 15 }

game_query(method="find_nodes", params={ "pattern": "Player" })
// → { nodes: [{ path: "/root/Player", type: "CharacterBody3D" }] }
```

### 模拟输入并等待

```
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 640, "y": 360, "button": "left", "pressed": false })
game_wait(method="wait_for_node", params={ "path": "/root/CanvasLayer/Dialog" })
game_query(method="get_node_properties", params={ "path": "/root/CanvasLayer/Dialog", "properties": ["visible"] })
// → { visible: true }
```

### 修改运行时状态

```
game_write(method="set_node_property", params={ "path": "/root/Player", "property": "position", "value": { "x": 10, "y": 0, "z": 5 } })
game_write(method="call_method", params={ "path": "/root/Player", "method": "take_damage", "args": [25] })
```

### 属性监控

```
game(action="monitor_start", node_path="/root/Player", properties=["position", "health"], interval_frames=5)
// → { monitoring: true, node_path: "/root/Player", properties: [...], dropped_blocked: [], interval_frames: 5, max_samples: 500 }

game(action="monitor_poll")
// → { monitoring: true, samples: [{frame: 100, time: 1.667, t_game_ms: 1666.7, values: {position: {x:10,y:0}}}], sample_count: 1, interval_frames: 5, summary: {...} }

game(action="monitor_stop")
// → { monitoring: false, samples: [...], sample_count: 30, duration_seconds: 2.5, summary: {health: {min: 0, max: 100, min_at_frame: 120, ...}} }  // summary 仅数值属性；position 是 Vector(Dict) 不进摘要
```

### 信号监听

```
game(action="watch_start", node_path="/root/Button", signal_name="pressed", max_events=100)
// → { watching: true, node_path: "/root/Button", signal_name: "pressed", max_events: 100 }

game(action="watch_poll")
// → { watching: true, events: [{frame: 150, time: 2.5, args: []}], event_count: 1 }

game(action="watch_stop")
// → { watching: false, events: [...], event_count: 5, duration_seconds: 8.2 }
```

### UI 元素发现

```
game(action="find_ui_elements", type="Button", visible_only=true)
// → { elements: [{path: "/root/Menu/StartBtn", type: "Button", text: "Start", ...}], count: 3 }

game(action="click_button", text="Start")
// → { clicked: true, button_path: "/root/Menu/StartBtn", button_text: "Start" }
```

### 错误：Bridge 未连接

```
game_query(method="ping")
// → 超时或错误: "Bridge not connected"
// 解决：1. 确认已运行 game_bridge_install
//       2. 确认游戏正在运行（F5 或 run_project）
//       3. 检查项目 .godot/ 目录下是否有 mcp_bridge_9081.secret 文件
```

## 常见陷阱

- **Bridge 未安装**：调用 game_query/input/write/wait 前必须先 game_bridge_install。安装是一次性的（写入 project.godot autoload）。
- **游戏未运行**：Bridge autoload 只在游戏运行时监听。编辑器模式（编辑场景）不会启动 Bridge。
- **密钥文件权限**：Windows 上可能需要 icacls 权限。Linux/macOS 上自动 chmod 0600。
- **密钥权限循环**：Bridge 首次运行后将密钥文件权限收紧为只读（Windows: `(R)` only），导致后续启动时无法重写密钥而中止（"Failed to write secret — aborting Bridge startup"）。**解决**：手动恢复写入权限 `icacls ".godot/mcp_bridge_9081.secret" /grant "%USERNAME%:(W)"`，或删除密钥文件让 Bridge 重新生成。**S4 治本（v0.18.x+）**：设置环境变量 `GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true`，Bridge 复用现有 secret 文件（不重生、不收紧、`_exit_tree` 不删除），彻底打破权限循环并与 MCP 端 5min TTL 缓存保持同步。仅本地测试用（安全降级，生产保持默认 false）。
- **节点路径必须用绝对路径**：`game_write`、`game_wait` 等的 `path` 参数必须以 `/root/` 开头（如 `/root/Main/Player`），不接受 `root/Main/Player` 格式。`game_query(method="get_tree")` 返回的路径可用于参考。
- **与录制系统**：`runtime(action="record_start")` 依赖 Bridge 连接。确保 Bridge 可用后再录制。
- **端口 9081 冲突**：端口被占时自动递增避让（9081 起，最多尝试 10 个候选）；可用环境变量 `GODOT_MCP_BRIDGE_PORT` 设起点，无需修改 autoload 脚本。
- **密钥缓存**：5 分钟 TTL 后首次调用会重新读取密钥文件，可能有短暂延迟。
- **monitor 最大属性数**：单次监控最多 20 个属性（MONITOR_MAX_PROPERTIES），超出会报错。
- **monitor 自动停止**：采样达到 500 条（_monitor_max_samples）后自动停止。
- **watch Lambda 适配器**：信号回调使用 0-4 参数的匹配 Callable，超过 4 参数的信号只记录前 4 个。
- **watch 自动断开**：事件达到 max_events 后自动断开信号连接并停止。
- **find_ui_elements 最大返回**：默认 200，上限 500 条结果。
- **click_button**：默认通过 emit_signal("pressed") 触发，不模拟实际鼠标点击事件（**不切换 button_pressed 状态**——CheckBox/RadioButton 点击"成功"但没勾上时用此解释）。传 `real_event=true` 走真实输入事件路径：press/release InputEventMouseButton 注入 viewport，走完整引擎输入管道（切换 button_pressed/触发 button_group 互斥/focus），响应含 `signal_counts`（pressed/toggled 等信号计数）与 `verified`（等 4 帧延迟响应，同 call_method await_completion 模式）。
- **call_method 白名单只读（S5, v0.18.x+）**：`ALLOWED_METHODS` 仅含只读方法（get/has_*/get_meta/get_signal_list 等），刻意禁状态修改（防 call_method 任意执行）。`emit_signal`/`_on_*` 回调/业务方法默认被拒。需触发业务逻辑时：(a) 设环境变量 `GODOT_MCP_BRIDGE_EXTRA_METHODS=emit_signal,xxx` 显式扩展（opt-in，注意 emit_signal 会触发已连接的任意回调，安全降级）；(b) 用 `set_node_property` 改属性间接触发；(c) 业务逻辑内联到 GDScript 片段。注：`_cmd_call_method` 仍有 `args.size() > 8` 拒绝限制（>8 参数的调用/emit_signal 会失败）。
- **call_method CMP-9-B 增强（v0.27.0+）**：(1) args 按方法声明类型自动强转（传 `[1,2,3]` 给 Vector3 参数正确转换，Godot callv 不自动转，防静默零值）；(2) 方法不存在时返回 did-you-mean 建议（`String.similarity` > 0.6 取最高分）；(3) response 含 `undoable: false`（call 不可 undo，对标竞品）；(4) `EXTRA_METHODS_BLOCKLIST`（free/queue_free/set_script/call/callv/emit_signal/connect/disconnect 等）是不可覆盖硬底线（即使 env 列出也拒，防 RCE/运行时结构破坏）。向后兼容：不设 env 时行为完全不变。(5) P0-1(2026-09-11) callv 参数预检——coerce 后仍不可达方法声明的组合(个数不足/超出、类型不可转如 String→int 非数字、Dictionary→Object、null→int、typed Array/Dict、JSON array→Array[int])在调用前显式拒绝(code -10),防 callv 静默失败返回 null 被误读为成功(与 void 返回不可区分);方法签名取不到的动态方法放行,由 callv 自行处理。(6) GDA_CALLABLE per-node 声明白名单(2026-09-11 P1 批)——游戏侧在节点脚本声明 const GDA_CALLABLE := ["take_damage"],bridge 沿脚本基类链静态读 get_script_constant_map() 枚举(零项目代码执行,default deny:不声明=不可调);信任边界:声明是声明者的断言(进游戏方 code review),bridge 保证未声明方法绝不可调;BLOCKLIST 仍是硬底线(声明也拦)。
- **monitor 游戏时间调度（P0-3, 2026-09-11）**：采样节奏锚定游戏时间(delta*1000 累计,含 time_scale)而非帧数——帧步长在窗口期帧率变化时实际节奏漂移 2-4 倍(satellite #378 同款坑)。paused/freeze 期间不计时不采样;长帧跨多个采样点只 resync 不 burst 补帧;monitor_stop 时若游戏时间推进过但末次采样未赶上会补采终态。已知限制:采样在 bridge 帧前执行,读数统一迟一帧(时间线形状无损);帧末精确对齐需独立采样器子节点(评估后未做,防帧定时输入注入的时序偏移)。
- **P2 control 层增强（2026-09-11）**：(1) report 搭车——playtest.step/step_until 可带 report=[{path,property}](≤16 条,结构化,不引入 Expression,属性过黑名单),响应自带终态读数(省紧随观察往返);逐条失败带 error 不炸。(2) freeze 竞争上报——游戏代码在 freeze 下 unpause 时 bridge re-assert 并计数,unfreeze 响应含 frozen_for_ms/contended_reasserts(>0 = 游戏对抗过 freeze,每次 re-assert 可漏一帧,诚实报数)。(3) 函数级 profiling——run_project(profiling=true) 传 --remote-debug(spawn 前绑端口,attach 会话无此通道),之后 profiler 工具 capture_functions(seconds/top/sort/capture_limit) 一次调用采窗口+排名(引擎原生流,函数级 self/total 热点+最慢帧 top30,等价编辑器 Profiler 面板;帧级分析仍用 get_data)。
- **P3 能力扩展（2026-09-11）**：(1) 弱网注入 network_conditioner——op=set 包装当前 MultiplayerPeer(MultiplayerPeerExtension 装饰器,只改**出向**:静默丢包/延迟+jitter 进队列 16ms flush;无带宽限制;host 侧装=影响 host 发给所有 client,双向对称需两端各装;依赖 SceneMultiplayer 高阶 API,raw socket 不走此管道),无 peer(OfflineMultiplayerPeer)诚实报错不装空壳;clear 恢复原 peer(游戏自行换过 peer 则不覆盖)且幂等;status 报 pending_packets。(2) custom_command 项目本地命令——游戏开发者丢 .gd 进 res://mcp_commands/(get_commands() -> {"custom.xxx": Callable}),bridge _ready 宽容注册(load 失败/非 Node/无方法/非 Dictionary 一律跳过不崩启动),custom. 前缀强制(内建零冲突,default deny;信任边界同 GDA_CALLABLE:声明面=游戏源码方责任,进游戏方 code review);调用 game(action=custom_command, method=custom.xxx, params=...),未声明命令 bridge 返 -32601。(3) manage_tools list_groups 响应加 profiles 价格标签(每 profile 实测 bytes + approxTokens,Buffer.byteLength 口径含中文)——切 profile 前先看价格(对照 BuildersGate 105k 基线)。
- **P8 热加载（2026-09-12）**：mcp_commands 状态机——mtime+300ms debounce tick 感知文件变更；命令调用中不换实例(quiesce,active_calls 归零才重载/卸载)；加载失败回滚旧实例继续服务(slot=reload_failed+last_error,文件修好后自动恢复)；GDScript.new()+FileAccess **独立加载**(不走 ResourceLoader:同路径 load 即使 CACHE_MODE_IGNORE 也就地替换共享资源,旧实例方法表消失、旧 Callable is_valid()=false——实测坑,独立对象加载失败即丢弃,回滚天然有效)；删除文件 quiesce 后卸载 slot；重名冲突路径字典序靠前者赢(后者 reload_failed 清空);`custom.list` 内建诊断返回 slot 状态快照；env GODOT_MCP_BRIDGE_CUSTOM_HOT_RELOAD=0 关闭热重载。已知边界：运行中写入**语法坏** .gd 触发 Script Debugger REPL 挂死主循环(引擎层,bridge 不可防——语法错误 IDE 侧先消灭;bridge 防线覆盖"合法语法坏契约"如 extends RefCounted)。
- **send_key 已支持 physical_keycode（S6, v0.18.x+）**：`_cmd_send_key` 同时设 `keycode` + `physical_keycode`，触发用物理键码映射的 input action（Godot 4 推荐 physical_keycode 映射）。早期版本只设 keycode，physical 映射项目（如 `ui_right` 用 physical）不触发。
- **多用户环境不安全**：Bridge 使用 TCP 绑定 127.0.0.1 + 共享密钥认证。在单用户本地开发环境下足够安全，但在多用户共享系统（如远程开发服务器）上，localhost 通信可被同一机器上的其他用户嗅探。如需多用户隔离，考虑使用 Unix Domain Socket（仅文件权限控制访问）。
