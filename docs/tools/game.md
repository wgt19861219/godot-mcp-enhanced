# game

> 游戏桥接操作(游戏运行时经 bridge 通信):安装/卸载 bridge、查询场景树/节点属性/截图、写入属性/调方法、模拟输入、等待条件、确定性 playtest(seed/锁步长/单步/快照)、freeze 控制、monitor 属性采样、watch 信号记录、UI 元素发现与点击、弱网注入、项目自定义命令。完整用法见规则文档(或 help 工具)。

| 属性 | 值 |
|------|-----|
| 所属层 | bridge |
| 安全级别 | guarded |
| 需要 Godot | 是 |
| 需要编辑器 | 否 |
| 只读 | 否 |
| 长耗时 | 否 |

## Actions

- `game_bridge_install`
- `game_bridge_uninstall`
- `install_override`
- `uninstall_override`
- `game_query`
- `game_write`
- `game_input`
- `game_wait`
- `game_playtest`
- `monitor_start`
- `monitor_stop`
- `monitor_poll`
- `watch_start`
- `watch_stop`
- `watch_poll`
- `find_ui_elements`
- `click_button`
- `network_conditioner`
- `custom_command`
- `sync_state`

## Parameters

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum (20 项) | ✓ | 操作类型 |
| `project_path` | string |  | Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录） |
| `port` | number |  | game_bridge_install: 期望的起始监听端口(实际端口由游戏侧 env GODOT_MCP_BRIDGE_PORT 设起点,被占自动递增避让;此参数不影响行为,保留兼容)。实际端口见 ping 响应与实例 registry |
| `source_script_path` | string |  | install_override/uninstall_override: 源调试脚本绝对路径（必须在 ALLOWED_PROJECT_PATHS 白名单内,拷贝到项目根注册为 MCPOVERRIDE_<basename> autoload;插入 [autoload] 段末尾=在游戏 autoload 之后加载,脚本 _ready 可直接访问游戏单例,无需 await <Singleton>.ready） |
| `sub_action` | enum (4 项) |  | sync_state 子操作:snapshot=收集当前 bridge 状态存快照|compare=比对两快照(浮点容差)|list=快照清单|clear=清空快照。 |
| `label` | string |  | sync_state snapshot: 快照标签(如 host/client);进程内全局——跨实例场景建议带实例前缀(如 gameA-host)防静默覆盖;compare 时用 label_a/label_b。 |
| `label_a` | string |  | sync_state compare: 比对快照 A 的标签。 |
| `label_b` | string |  | sync_state compare: 比对快照 B 的标签。 |
| `tolerance` | number |  | sync_state compare: 浮点容差(默认 0.0001,数值 |a-b|<=tolerance 视为相等;Vector2/3/4 自动转 {x,y,z} dict 分量级容差;浮点位置类不逐位相等是多人比对必然,masteryee 亲读坑)。 |
| `group` | string |  | sync_state snapshot: 可选组名(如 mcp_watch)——组内无 _mcp_state 的成员记存在性标记参与节点集比对。 |
| `method` | string |  | 方法名(按 action 选)。game_query: ping/get_tree/find_nodes/get_node_properties/get_node_layout/get_performance/get_viewport_info/take_screenshot/get_errors/clear_errors。game_write: set_node_property/call_method。game_input: send_key/send_mouse_click/send_mouse_move/send_text/send_touch/send_drag/send_input_sequence。game_wait: wait_for_node/wait_for_property。game_playtest: playtest.seed/playtest.fixed_delta/playtest.step/playtest.snapshot/playtest.restore/playtest.freeze/playtest.unfreeze/playtest.step_until。细节见规则文档。 |
| `params` | object |  | 方法参数(紧凑形状,完整说明见规则文档)。find_nodes{pattern?,type?,group?,limit?,root?,near_node?,max_distance?,observation_profile?}(near_node 近邻:同维度升序,锚点排除;player 档下 position 有字段规则的锚点/候选不参与测距);get_node_properties{path,observation_profile?};get_node_layout{path,observation_profile?};get_errors{since_seq?,clear?};set_node_property{path,property,value};call_method{path,method,args}(白名单+GDA_CALLABLE+预检-10 见规则);send_key{key,pressed};send_mouse_click{x,y,button,pressed};send_mouse_move{x,y};send_text{text};send_touch{x,y,pressed,index};send_drag{x,y,index,relative,speed};send_input_sequence{timeline[{at_frame(1-600),type,...}],settle_frames?(0-600),wall_budget_ms?(1000-50000)};wait_for_node{path};wait_for_property{path,property,value};playtest.seed{seed};fixed_delta{hz};step{frames};step_until{conditions[{path,property,op,value}],max_frames?(1-600),wall_budget_ms?(1000-50000,默认30000)};network set{latency_ms,loss_pct,jitter_ms};custom 命令参数由游戏方定义。 |
| `timeout` | number |  | game_query/game_write/game_input/game_wait: 超时时间（毫秒，默认 10000）。game_wait 的 timeout 用作整个轮询窗口的总预算（在窗口内反复探测直到条件成立）。send_input_sequence 延迟响应,timeout 自动放宽至 wall_budget+10s(上限 65000) |
| `interval_ms` | number |  | game_wait 专用：轮询探测间隔（毫秒，默认 200，范围 50-2000）。仅 wait_for_node/wait_for_property 生效 |
| `node_path` | string |  | monitor_start: 要监控的节点路径（如 /root/Player） |
| `properties` | array |  | monitor_start: 要监控的属性名列表（如 ["position", "health"]）;被安全过滤的属性会在返回 dropped_blocked 中逐个点名 |
| `interval_frames` | number |  | monitor_start: 采样间隔(60fps 基准下的标称帧数,默认 10,最小 1,最大 300;实际按游戏时间毫秒调度,帧率变化节奏不漂移,paused/freeze 期间游戏时间停走不采样,样本含 t_game_ms 游戏时间戳) |
| `signal_name` | string |  | watch_start: 要监听的信号名（如 "pressed"、"health_changed"） |
| `max_events` | number |  | watch_start: 最大记录事件数（默认 1000，最大 5000） |
| `push` | boolean |  | P3-6 watch_start/monitor_start: 启用 push 模式（事件/采样产生时主动推送 MCP notification，无需 poll）。client 需订阅 resources/subscribe 才能收到 |
| `observation_profile` | enum: debug | player |  | P7 观察档位(默认 debug;player 需游戏侧 env GODOT_MCP_BRIDGE_ALLOWED_PROFILES 授权,节点 meta 级联隐藏 + agent_field_rules 字段投影生效,详见规则文档) |
| `pattern` | string |  | find_ui_elements: 名称/文字匹配模式（Godot match 语法） |
| `type` | string |  | find_ui_elements: 按类型过滤（如 "Button"、"Label"） |
| `visible_only` | boolean |  | find_ui_elements: 仅返回可见元素（默认 true） |
| `limit` | number |  | find_ui_elements: 最大返回数（默认 200，上限 500） |
| `text` | string |  | click_button: 按钮文字（和 path 二选一） |
| `path` | string |  | click_button: 按钮节点路径（和 text 二选一） |
| `real_event` | boolean |  | click_button: 走真实输入事件路径(默认 false=emit_signal)。true 时注入 press/release InputEventMouseButton 到 viewport,走完整引擎输入管道(切换 button_pressed 状态/触发 button_group 互斥/focus),等 4 帧后返回 signal_counts 信号计数与 verified;延迟响应(同 call_method await_completion)。修复"点击成功但 CheckBox 没勾上"类问题 |
| `op` | enum: set | clear | status |  | network_conditioner: 子操作。set=包装当前 MultiplayerPeer 注入弱网(latency_ms/loss_pct/jitter_ms 参数),clear=拆除恢复原 peer,status=查询当前状态 |
| `latency_ms` | number |  | network_conditioner set: 注入延迟毫秒(>=0,默认 0) |
| `loss_pct` | number |  | network_conditioner set: 丢包百分比 0-100(默认 0) |
| `jitter_ms` | number |  | network_conditioner set: 抖动毫秒(>=0,默认 0,实际延迟 = latency ± jitter) |
| `godot_path` | string |  | 覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量） |

## 风险分布

读 12 / 写 6 / 进程 2

---
<!-- AUTO-GENERATED by scripts/gen-tool-docs.mjs from capability-matrix.json v0.33.2. DO NOT edit manually; re-run npm run gen:tool-docs after tool changes. -->
