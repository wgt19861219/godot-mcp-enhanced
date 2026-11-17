# 错误码语义表（ERROR_CODES 注册表）

> 单一事实源：`src/core/error-codes.ts`（本表由 `test/core/error-codes-doc.test.ts` 锚定，注册表每码必须在本表出现——改注册表须同步本表）。
>
> **retryable 语义**：`true` = 等待 1-2s 或修复环境（连接/游戏进程/编辑器）后重试有意义；`false` = 按 `suggestion` 改参数/换路径后重试，原样重试只会再失败（连续失败会被工具熔断器拒绝）。
>
> `category` 为结构化枚举（validation/timeout/transport/guard/path/connection/internal，非错误文本推断，无 PII 外传）。
>
> 未登记码保守补 `retryable: false` 并在 server 日志 warn 一次（不拒调用）；新码按本表格式收编。

## 瞬态可重试（retryable=true）

| code | category | retryable | 语义 | 典型自愈动作 |
|------|----------|-----------|------|--------------|
| NOT_CONNECTED | connection | true | 编辑器/bridge 未连接，重连后可成功 | 稍候重试；确认编辑器/游戏已启动 |
| BRIDGE_NOT_CONNECTED | connection | true | Bridge 未连接（未安装/游戏未运行/密钥不匹配） | `game_bridge_install` + 确认游戏运行后重试 |
| EDITOR_NOT_CONNECTED | connection | true | editor 插件未连接（需 launch_editor/安装插件） | `launch_editor` 或安装插件后重试 |
| BRIDGE_TIMEOUT | timeout | true | Bridge 请求超时（outcome 未知，重试须传同一 requestId 幂等） | 查游戏报错（`get_errors`）后同 requestId 重试 |
| TIMEOUT | timeout | true | 操作超时（handler 内部业务超时） | 加大 timeout 参数或拆小操作后重试 |
| TOOL_DEADLINE_EXCEEDED | timeout | true | 超过 dispatcher 全局 deadline 兜底（handler 忘写内部超时） | 拆小任务；检查是否有挂起等待 |
| TRANSPORT | transport | true | 传输层错误（socket 断开等非超时） | 等待自动重连后重试 |
| RATE_LIMIT | guard | true | 速率限制（瞬态限流，窗口重置后重试） | 等 1-2s 再试；检查调用循环是否失控 |
| CONCURRENCY_LIMIT | guard | true | 并发/串行队列占用上限（稍候重试） | 等当前调用完成后再试 |
| TOOL_CIRCUIT_OPEN | guard | true | 工具熔断器打开（冷却期后半开重试） | 等冷却期结束再试（勿高频硬冲） |
| VERIFICATION_IN_PROGRESS | guard | true | editor 连接项目校验进行中（稍候重试） | 等校验完成后再试 |
| SERVER_STALE | internal | true | MCP server 版本/registry 过期（重启即恢复） | 重启 MCP server 后重试 |
| BUSY | guard | true | 资源占用中（会话/实例忙，稍候重试） | 等占用方完成或 stop_project 后再试 |

## 确定性失败（retryable=false）

| code | category | retryable | 语义 | 典型自愈动作 |
|------|----------|-----------|------|--------------|
| INVALID_PARAMS | validation | false | 参数校验失败 | 按错误消息/suggestion 修正参数 |
| UNKNOWN_ACTION | validation | false | action 未声明/拼写错误（附 did-you-mean 建议） | 按建议改 action 名 |
| INVALID_PATH | path | false | 路径非法（穿越/非法字符/非 res:// 形态） | 改为合法 res:// 路径 |
| PATH_NOT_ALLOWED | path | false | 路径不在 ALLOWED_PROJECT_PATHS 白名单 | 用白名单内项目路径 |
| MISSING_PARAM | validation | false | 必填参数缺失 | 补齐必填参数 |
| INVALID_PARAM | validation | false | 单参数值不合法 | 按消息修正该参数 |
| INVALID_PARAM_TYPE | validation | false | 参数类型错误 | 按消息改参数类型 |
| INVALID_TYPE | validation | false | 节点/对象类型不匹配 | 改为期望的节点/对象类型 |
| INVALID_VALUE | validation | false | 取值非法/越界 | 改为合法取值范围 |
| INVALID_ACTION | validation | false | action 值不在枚举内 | 用 schema 枚举内的 action |
| INVALID_SIGNAL | validation | false | 信号名/签名不合法 | 用合法信号名（先 list 查询） |
| INVALID_VECTOR | validation | false | 向量参数格式/分量非法 | 按 {x,y,z} 结构修正 |
| INVALID_TILE_COORDS | validation | false | TileMap 坐标非法 | 改为整数格子坐标 |
| INVALID_TEMPLATE | validation | false | 模板名/内容不合法 | 用已定义的模板名 |
| INVALID_FORMAT | validation | false | 数据格式不合法 | 按消息修正格式 |
| INVALID_FILE_NAME | validation | false | 文件名不匹配约定/含非法字符 | 按约定格式命名（如 `recording_*.json`） |
| INVALID_RECORDING_FORMAT | validation | false | 录制文件名/JSON 结构不合法 | 用 record_stop 原始 events_json 回放 |
| FILE_NOT_FOUND | path | false | 目标文件不存在 | 先创建/确认路径后再试 |
| NOT_FOUND | validation | false | 目标节点/资源/记录不存在 | 先查询确认目标存在 |
| NODE_NOT_FOUND | validation | false | 场景中找不到目标节点 | 先 `query_scene_tree` 确认节点路径 |
| SCENE_NOT_FOUND | validation | false | 场景文件不存在或加载失败 | 确认 scene_path 正确 |
| THEME_NOT_FOUND | validation | false | Theme 资源加载失败或节点未挂 Theme | 确认 theme_path 存在且为 Theme 资源（先 theme_create/ui_set_theme 建主题） |
| TOKEN_NOT_FOUND | validation | false | $token 引用在 theme DesignTokens 中缺键 | `token_list` 审计现有 token 后改引用名，或先 `token_set` 写入 |
| GUARD | guard | false | 守卫拒绝（确认令牌/只读模式拦截） | 按消息取确认令牌或退出只读模式 |
| SANDBOX_VIOLATION | guard | false | GDScript 沙箱扫描阻断危险 API 模式 | 改用白名单 API 或走 opt-in 旁路 |
| SANDBOX_BLOCKED | guard | false | 沙箱阻断（工具级内容拦截） | 按消息调整内容后重写 |
| SCRIPT_EXEC_FAILED | internal | false | GDScript 编译/运行失败（消息附引擎错误行） | 按引擎错误行修脚本后重试 |
| SPAWN_FAILED | internal | false | Godot 进程 spawn 失败（二进制缺失/文件锁） | 检查 GODOT_PATH/清残留进程 |
| GODOT_NOT_FOUND | internal | false | 找不到 Godot 二进制（设 GODOT_PATH 或安装） | 设置 GODOT_PATH 后重启 MCP server |
| EDIT_REVERTED | validation | false | edit_script 内容守卫失败已回滚（读最新内容后重做） | 重新 read_script 后基于最新内容再编辑 |
| EDITOR_SCENE_OPEN | guard | false | headless 改盘与编辑器打开场景冲突（需 Reload 后重做） | 编辑器内 Reload 场景或关闭后重试 |
| AUDIT_WRITE_FAILED | internal | false | 审计日志写入失败 | 检查磁盘/权限后重试 |
| BRIDGE_ERROR | connection | false | Bridge 请求返回错误（游戏侧处理失败） | 按消息修游戏侧状态后重试 |
| INTERNAL | internal | false | 内部错误（PII-safe 固定兜底） | 查 server 日志定位；勿原样重试 |

## did-you-mean 三级机制

拼错不必盲试——三层各有就近建议：

1. **参数级**（`src/core/args-validator.ts` `checkUnknownParams`）：工具顶层未声明参数一律拒绝，与已声明参数做 Levenshtein 相似度匹配，≥ 0.4 时提示"想传 X?"（如 `alpah` → `alpha?`）。
2. **方法级**（bridge `call_method`）：游戏节点方法不存在时，GD 侧按 `String.similarity > 0.6` 取最高分方法名建议。
3. **工具发现级**（`manage_tools` discover / help）：工具名拼错时按 Levenshtein 最近邻提示相近工具名。
