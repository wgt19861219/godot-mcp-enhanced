# game

> 游戏桥接操作(游戏运行时经 bridge 通信):装拆 bridge、查询(场景树/节点/截图)、写属性/调方法、模拟输入、等待条件、确定性 playtest(seed/锁步长/单步/快照)、freeze、monitor 采样、watch 信号、UI 发现与点击、弱网注入、自定义命令。详见规则文档(或 help 工具)。

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
| `action` | enum (20 项) | ✓ | 操作类型。install/uninstall=装拆 bridge(含 override), game_query=查询(场景树/节点/截图), game_write=写属性/调方法, game_input=模拟输入, game_wait=等待条件, playtest.*=确定性测试, monitor/watch=采样/信号记录, find_ui_elements/click_button=UI, network_conditioner=弱网, sync_state=快照对比, custom_command=自定义命令 |
| `project_path` | string |  | 项目目录（默认 GODOT_PROJECT_PATH 或当前目录） |
| `port` | number |  | install: 起始端口(实际由游戏侧 env 设定+被占自动避让,本参不影响行为;实际端口见 ping 响应/实例 registry) |
| `force` | boolean |  | install: 项目内 mcp_bridge.gd 版本不同时 force=true 覆盖刷新(重启游戏生效);报 Method not found 时用 |
| `clean_stale_secrets` | boolean |  | install: 清理 .godot/ 陈旧 mcp_bridge_*.secret(按 registry 心跳判活防误删);多实例 auth 失败/连错实例时用 |
| `source_script_path` | string |  | install_override/uninstall_override: 源调试脚本绝对路径(须在 ALLOWED_PROJECT_PATHS 白名单内;拷贝到项目根注册 MCPOVERRIDE_<basename> autoload) |
| `sub_action` | enum (4 项) |  | sync_state 子操作:snapshot=收集当前 bridge 状态存快照|compare=比对两快照(浮点容差)|list=快照清单|clear=清空快照。 |
| `label` | string |  | sync_state snapshot: 快照标签;跨实例场景建议带实例前缀(如 gameA-host)防静默覆盖;compare 用 label_a/label_b。 |
| `label_a` | string |  | sync_state compare: 比对快照 A 的标签。 |
| `label_b` | string |  | sync_state compare: 比对快照 B 的标签。 |
| `tolerance` | number |  | sync_state compare: 浮点容差(默认 0.0001;Vector2/3/4 转分量 dict 级容差)。 |
| `group` | string |  | sync_state snapshot: 可选组名(如 mcp_watch)——组内无 _mcp_state 的成员记存在性标记参与节点集比对。 |
| `method` | string |  | 方法名(按 action 选)。game_query: ping/get_tree/find_nodes/get_node_properties/get_node_layout/dump_layout_tree/get_font_report/get_performance/get_viewport_info/take_screenshot/get_errors/clear_errors;game_write: set_node_property/call_method;game_input: send_key/send_mouse_click/send_mouse_move/send_text/send_touch/send_drag/send_input_sequence;game_wait: wait_for_node/wait_for_property;game_playtest: playtest.seed/playtest.fixed_delta/playtest.step/playtest.snapshot/playtest.restore/playtest.freeze/playtest.unfreeze/playtest.step_until。细节见规则文档。 |
| `params` | object |  | 方法参数(形状签名,细节见规则文档)。find_nodes{pattern?,type?,group?,limit?,root?,near_node?,max_distance?,observation_profile?}(near_node 近邻细节见规则);get_node_properties{path,observation_profile?};get_node_layout{path,observation_profile?};dump_layout_tree{path?,max_depth?,visible_only?};get_font_report{path?,max_depth?};get_errors{since_seq?,clear?};set_node_property{path,property,value};call_method{path,method,args}(白名单+GDA_CALLABLE+预检-10 见规则);send_key{key,pressed};send_mouse_click{x,y,button,pressed};send_mouse_move{x,y,button_mask?};send_text{text};send_touch{x,y,pressed,index};send_drag{x,y,index,relative,speed};send_input_sequence{timeline[{at_frame(1-600),type,...}],settle_frames?(0-600),wall_budget_ms?(1000-50000)};wait_for_node{path};wait_for_property{path,property,value};playtest.seed{seed};fixed_delta{hz};step{frames};step_until{conditions[{path,property,op,value}],max_frames?(1-600),wall_budget_ms?(1000-50000,默认30000)};network set{latency_ms,loss_pct,jitter_ms};custom 由游戏方定义。 |
| `timeout` | number |  | 超时毫秒(默认 10000);game_wait 用作轮询窗口总预算;send_input_sequence 自动放宽至 wall_budget+10s(上限 65000) |
| `request_id` | string |  | game_write/custom_command 幂等键(可选):超时(outcomeUnknown)后重试传同一值,bridge 按其去重;不传自动生成 |
| `interval_ms` | number |  | game_wait 专用：轮询探测间隔（毫秒，默认 200，范围 50-2000）。仅 wait_for_node/wait_for_property 生效 |
| `node_path` | string |  | monitor_start: 要监控的节点路径（如 /root/Player） |
| `properties` | array |  | monitor_start: 要监控的属性名列表（如 ["position", "health"]）;被安全过滤的属性会在返回 dropped_blocked 中逐个点名 |
| `interval_frames` | number |  | monitor_start: 采样间隔(60fps 基准帧数,默认 10,范围 1-300;按游戏时间调度,paused/freeze 不采样,样本含 t_game_ms) |
| `signal_name` | string |  | watch_start: 要监听的信号名（如 "pressed"、"health_changed"） |
| `max_events` | number |  | watch_start: 最大记录事件数（默认 1000，最大 5000） |
| `push` | boolean |  | P3-6 watch_start/monitor_start: 启用 push 模式（事件/采样产生时主动推送 MCP notification，无需 poll）。client 需订阅 resources/subscribe 才能收到 |
| `observation_profile` | enum: debug | player |  | 观察档位(默认 debug;player 需游戏侧 env 授权,节点 meta 级联隐藏+字段投影,详见规则文档) |
| `pattern` | string |  | find_ui_elements: 名称/文字匹配(match:wildcard=Godot match 语法,exact/contains=全等/子串) |
| `type` | string |  | find_ui_elements: 按类型过滤（如 "Button"、"Label"） |
| `role` | string |  | find_ui_elements: 按语义角色过滤(同输出 role 枚举):combobox/list/tablist/checkbox/progressbar/button/text/textbox/slider/scrollarea/panel;空=不过滤,非法值报错 |
| `match` | enum: wildcard | exact | contains |  | find_ui_elements: 匹配模式。wildcard(默认)=通配符扫 name/text;exact=全等;contains=子串(额外扫 label) |
| `visible_only` | boolean |  | find_ui_elements: 仅返回可见元素（默认 true） |
| `limit` | number |  | find_ui_elements: 最大返回数（默认 200，上限 500） |
| `text` | string |  | click_button: 按钮文字（和 path 二选一） |
| `path` | string |  | click_button: 按钮节点路径（和 text 二选一） |
| `real_event` | boolean |  | click_button: 走真实输入事件路径(默认 false=emit_signal);true 时注入完整引擎输入管道(button_group 互斥/focus),修复"点击成功但 CheckBox 没勾上"类问题 |
| `op` | enum: set | clear | status |  | network_conditioner: set=注入弱网(latency_ms/loss_pct/jitter_ms),clear=恢复原 peer,status=查状态 |
| `latency_ms` | number |  | network_conditioner set: 注入延迟毫秒(>=0,默认 0) |
| `loss_pct` | number |  | network_conditioner set: 丢包百分比 0-100(默认 0) |
| `jitter_ms` | number |  | network_conditioner set: 抖动毫秒(>=0,默认 0,实际延迟 = latency ± jitter) |
| `godot_path` | string |  | Godot 路径覆盖（可选，优先于配置/env） |

## 风险分布

读 10 / 写 8 / 进程 2

---
<!-- AUTO-GENERATED by scripts/gen-tool-docs.mjs from capability-matrix.json v0.36.2. DO NOT edit manually; re-run npm run gen:tool-docs after tool changes. -->
