# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.11.0] - 2026-05-22

### Added

- **verify_delivery** tool: end-to-end delivery verification with 4 dimensions (scene tree integrity, script health, performance, custom assertions)
- **L1 quickVerify**: optional lightweight verification embedded in write tool return values (`verify=true`)
- **dev_loop acceptance**: acceptance criteria parameter for post-execution verification

### Security

- **迭代 URL 解码**: `sanitizeResPath` 和 `resolveWithinRoot` 迭代解码最多 5 轮，防御 `%252e%252e%252f` 双编码路径遍历。
- **密钥文件生命周期**: Bridge 密钥文件不再由客户端读后即删，改为由 GDScript Bridge `_stop_server()` 统一管理，修复多实例兼容性。
- **认证锁定断开连接**: 超过最大认证失败次数后立即断开 TCP 连接，防止 CPU 空转。
- **编辑器 WebSocket 限速**: websocket_server 添加与 mcp_bridge 对称的暴力破解防护（5 次失败 → 30 秒锁定），消除两服务间的安全防护不对称。
- **重复安全函数标注**: `_constant_time_compare` 在两文件中标注 DUPLICATE 同步注释，防止未来修改时遗漏。

### Fixed

- **断言隔离**: verify_delivery 断言改为逐条独立执行，单条失败不阻塞后续断言。
- **认证失败检测**: game-bridge 客户端用 Bridge 错误码 (-32001/-32002) 替代魔法字符串匹配。
- **findAssociatedScenes 性能**: 场景文件内容缓存，避免 O(n*m) 重复读取。
- **项目有效性验证**: verify_delivery 入口检查 `project.godot` 是否存在。
- **quickVerify 占位**: 未实现的 quickVerify 返回 `passed:false` 而非误导性的 `passed:true`。
- **CRLF 处理**: `wrapAssertionCode` 正确处理独立 `\r`（与 `gdEscape` 一致）。
- **密钥生成 fallback**: `_generate_secret` 添加 10 次重试上限防止理论死循环。
- **parseConfigValue 引号**: 数组解析分割时尊重引号边界，不再误拆引号内逗号。

## [0.10.1] - 2026-05-21

### Security

- **Bridge TCP 绑定本地地址**: MCP Bridge 的 TCP 服务器从 `0.0.0.0` 改为 `127.0.0.1`，消除同网络设备未授权连接风险。
- **Bridge 密钥文件读后即删**: 认证密钥首次读取后立即从磁盘删除并缓存到内存，将凭证暴露窗口从整个会话期缩短到毫秒级。
- **Bridge 密钥缓存自愈**: Bridge 重启导致认证失败时自动清除缓存，下次调用重新从磁盘读取新密钥。
- **临时目录符号链接防护**: `cleanupOldSessions()` 使用 `lstatSync` 替代 `statSync` 并跳过符号链接，防止共享临时目录中的符号链接攻击。

### Fixed

- `opsErrorResult()` 返回结果现在包含 `isError: true`，MCP 客户端可正确检测失败响应。
- 新增 `errorResult()` 辅助函数统一错误返回格式。

## [0.10.0] - 2026-05-19

### Added

- CSS Flexbox 布局翻译层 (`ui_build_layout`)
- GDScript Lint 规则引擎 (`validate_scripts`)
- Flexbox 到 Godot Container 映射
- 布局参数验证与错误提示

### Security

- 路径遍历防护增强
- GDScript 转义顺序修复
- `confirm_and_execute` 只读守卫绕过修复
- Windows 进程终止统一
- 认证锁定绕过修复
- 模取偏差修复

### Fixed

- GDScript 字符串字面量修复
- 死代码清理
- 定时器泄漏修复
- 路径遍历绕过修复
