# 安全加固改进方案（2026-09-19）

> **依据**：2026-09-19 五维安全评估（保密性★★★ / 完整性★★★★ / 抗抵赖性★★ / 可核查性★★★ / 真实性★★★★）。
> 评估方法：4 个探索子代理全仓调研 + 主线抽查核实，所有 file:line 均经实测。
> **威胁模型前提**（不变）：localhost 单用户开发机 + 防误操作层。本方案目标是把评估发现的缺口收敛到与该威胁模型自洽，不追求对抗多用户主机/恶意内核级对手。

---

## 总览

| # | 改进项 | 批次 | 优先级 | 规模 | 主要收益维度 |
|---|--------|------|--------|------|-------------|
| 1A | 审计写入失败可观测 + STRICT 可选阻断 | 批 1 | P1 | S | 可核查性 |
| 1B | 动态工具审计 fail-closed | 批 1 | P2 | S | 可核查性 |
| 1C | 审计记录调用者标识（best-effort） | 批 1 | P3 | S | 抗抵赖性 |
| 1D | marker 熵 64→122+ bit + 注释修正 | 批 1 | P2 | S | 真实性 |
| 1E | `GODOT_MCP_AUDIT=false` 关闭时启动告警 | 批 1 | P3 | S | 抗抵赖性 |
| 2A | 审计外置副本双写 | 批 2 | P1 | M | 抗抵赖性 |
| 2B | Web GUI token 传递收敛（cookie-first） | 批 2 | P2 | M | 保密性 |
| 2C | Web GUI 文件写接审计 | 批 2 | P2 | S | 可核查性 |
| 2D | 机器级审计 error 脱敏 | 批 2 | P3 | S | 保密性 |
| 3A | editor WS / bridge TCP challenge-response 握手 | 批 3 | P1 | L | 保密性+真实性 |
| D1-D4 | 决策项（见文末，需用户裁决） | — | — | — | — |

批次规模：批 1 ≈ 0.5 天；批 2 ≈ 1-2 天；批 3 ≈ 2-3 天（含双端兼容矩阵测试）。

---

## 批次 1：审计与标记加固（纯 TS 小改，低风险，先行）

### 1A 审计写入失败可观测 + STRICT 可选阻断

**现状**：审计写入失败被空 catch 静默吞掉（`src\core\ToolDispatcher.ts:582-584`，注释自认"best-effort"；`_auditConfirmedExecution` 同，`ToolDispatcher.ts:846-848`；CLI 路径 `src\cli\qa.ts:94` 等）。磁盘满/权限异常时操作照常执行且零留痕零告警。

**设计**：
- `src\core\audit-log.ts` 新增模块级失败计数器与 `getAuditFailureStats()`（返回失败次数/最近错误摘要），**不做 setter**（符合 AGENTS.md 分层约束——模块级单例计数器只增不改注入语义）。
- 三处 catch 改为：计数 + **首次失败 warn**（`getLogger().warn('audit', ...)`，防刷屏用一次性标志）。
- 新增 env `GODOT_MCP_AUDIT_STRICT=true`：`appendAuditLine` 失败时重抛 → 调用方将操作判为失败（供高安全场景 opt-in）。默认 false 保持 best-effort 哲学。
- `audit` 工具 `get_log` 响应增加 `write_failures` 字段（audit.ts readonly 不变）。

**改动面**：`src\core\audit-log.ts`、`src\core\ToolDispatcher.ts`（两处 catch）、`src\tools\audit.ts`、`src\cli\qa.ts`。

**验证**：单测 mock `appendFile` 抛错——断言（a）默认模式工具结果不受影响 + warn 触发一次 + 计数递增；（b）STRICT 模式下调用方收到错误。

**回滚**：纯增量，revert 单 commit 即可。

### 1B 动态工具审计 fail-closed

**现状**：audit middleware 中未映射 `METHOD_TO_TOOL` 的动态工具名 → `getActionRisk` 返回 undefined → 直接跳过审计（`ToolDispatcher.ts:553-557`）。与确认门的 fail-closed（`ToolDispatcher.ts:441` 未映射强制确认）**语义不对称**。

**设计**：undefined 时不再 return，改按保守档落审计：`risk: 'write'` + `details: { dynamic_unmapped: true }`。与确认门对齐为"未知 = 按危险处理"。

**改动面**：`src\core\ToolDispatcher.ts`（middleware 一处）。

**验证**：单测构造未映射动态工具调用（借 `dynamic-risk-map.ts` 的反例），断言审计行落盘且 `dynamic_unmapped=true`；同时确认已映射动态工具行为不变。

### 1C 审计记录调用者标识（best-effort）

**现状**：`AuditEntry`（`src\core\audit-log.ts:46-63`）无 caller 字段；agentId 已在 `ToolDispatcher.ts:223-231` 提取但只进 agentContext。MCP 规范未定义 caller 身份，`_meta.agent_id` 通常 undefined。

**设计**：`AuditEntry` 加可选 `caller?: string`；`ToolDispatcher.ts:570` 与 `:834` 两处调用传入 agentId（无则不写字段）。字段注释诚实标注来源与局限（"未标准化、通常 undefined，多客户端场景仍无法归因"）。

**改动面**：`src\core\audit-log.ts`、`src\core\ToolDispatcher.ts` 两处。

**验证**：单测断言字段透传/缺省两态。

### 1D marker 熵 64→122+ bit + SECURITY CONTRACT 注释修正

**现状**：`generateMarker()` 取 `substring(0, 16)` = 64 bit 熵，而注释宣称 122 bit（`src\gdscript-executor.ts:646-657`）——**注释与实现不符**。

**设计**：`substring(0, 16)` → `substring(0, 32)`（UUID 去连字符全量 32 hex，有效熵 ≥122 bit，含 version/variant 固定位）；注释修正为准确表述，保留 SECURITY CONTRACT（禁 Math.random 等）。

**兼容性（已实测确认）**：
- `parseMcpMarkers` 前缀匹配，长度无关（`gdscript-executor.ts:1076-1104`）。
- full-class 路径 `replaceAll` 用完整字符串（`gdscript-executor.ts:1251-1254`）。
- 间接消费方（`config-parser.ts:116-118`、`data-import.ts:226`、`uid-ops.ts`）全部使用**固定常量** `___MCP_RESULT___` 写探针，由 executor 统一替换，对随机 marker 长度无假设。
- 残余检查项（实现时执行）：`test/regression/defects.ts` 等测试若有 marker 长度硬断言需同步——`npm test` 兜底。

**改动面**：`src\gdscript-executor.ts` 一处 + 可能的测试断言。

**验证**：`grep -n "substring(0" src/gdscript-executor.ts` 确认改动；`npm test` 全绿。

### 1E `GODOT_MCP_AUDIT=false` 关闭时启动告警

**现状**：审计可 env 一键静默关闭（`audit-log.ts:27-30`），关闭行为本身不留痕——抗抵赖评估 R3。

**设计**：`src\index.ts` 启动序列中检测 `isAuditEnabled() === false` 时打一条 `[SECURITY] audit disabled` warn（对齐 index.ts 现有安全告警风格，`src\index.ts:25-43` 先例）。不取消关闭能力（开发调试需要）。

**改动面**：`src\index.ts` 一处。

**验证**：env 置 false 启动单测/手动确认 warn 输出。

---

## 批次 2：审计外置 + Web GUI 收敛（TS 单侧，中复杂度）

### 2A 审计外置副本双写（防篡改第一层）

**现状**：项目审计文件在 `{project}/.godot/mcp_audit.jsonl`（`audit-log.ts:21`），与被审计对象同权限同生命周期；GDScript 沙箱默认模式拦 `FileAccess.open` 写任意路径（`gdscript-executor.ts:64-71`），**但项目内路径即 res:// 可被项目脚本触及**——被审计主体（AI 经 execute_gdscript）可删改自己的审计痕迹。抗抵赖评估 R1（最短板）。

**设计**：
- `appendAuditLine` 改为双写：原项目内文件保留（`audit` 工具读它、现行为零变更）；追加写外置副本 `~/.godot-mcp/audit/<sha256(projectPath).slice(0,16)>.jsonl`。
- 复用机器级审计既有目录惯例（`appendMachineAuditLine` 先例，`audit-log.ts:250-262`）与 appendFile 原子追加模式。
- 外置写失败走 1A 的失败计数（不影响工具结果，非 STRICT 模式下）。
- `audit` 工具 `get_log` 加可选参数 `external: boolean`——读外置副本做回放/比对（项目内与外置不一致 = 篡改信号，get_log 响应可带 `divergence` 提示）。

**安全收益论证（为什么外置有效）**：GDScript 沙箱默认拦 `FileAccess` 读写非 `res://`/`user://` 路径（`gdscript-executor.ts:64-71` 拦读非白名单路径、写模式全拦），home 目录不在沙箱白名单内 → **受沙箱约束的 AI 删不到外置副本**；要删必须先过双 opt-in（`UNRESTRICTED`+`DISABLE_SAFETY`），而那已是管理员明确授权的无限制模式。项目内副本则继续服务便利性。

**改动面**：`src\core\audit-log.ts`（双写 + 外置路径函数）、`src\tools\audit.ts`（external 参数，改后需 `npm run build-matrix`）。

**验证**：单测断言双文件内容一致 + external 读取路径正确 + 项目内文件被删后外置仍可读。

**不做（列为决策项 D3）**：HMAC 哈希链（机器密钥签名每行，防整体重写）。收益递增但复杂度显著上升，先落地外置层。

### 2B Web GUI token 传递收敛（cookie-first）

**现状**：三通道传递 token——URL query / `X-GUI-Token` 头 / HttpOnly cookie（`src\web-gui\server.ts:258-277`）；portal 跳转 URL 带 `?token=`（`src\web-gui\portal.ts` withToken），token 进浏览器历史；包根入口页明文内嵌 token 是 **2026-09-16 用户裁决的零门槛授权**（portal.ts:8-15 注释，本方案不撤销该裁决）。

**设计**（收敛传递面、保留零门槛体验）：
- `server.ts` 新增 `POST /api/auth`：body `{token}` → `timingSafeEqual` 验证 → `Set-Cookie`（HttpOnly，复用已有 cookie 语义）→ `{ok:true}`。
- portal 页 JS 改为：`fetch('/api/auth', {method:'POST', body:...})` 种 cookie 后 `location.href = '/'`——**token 不再出现在 URL/历史**。
- URL query 通道保留（兼容 curl/脚本自动化），仅 portal 不再使用。
- 入口页内嵌 token（裁决保留项）加注释互链到泄露面说明；README Web GUI 节补 token rotate 流程（CLI 已有 rotate，`src\cli\router.ts:64` 打码打印）。

**改动面**：`src\web-gui\server.ts`（新端点）、`src\web-gui\portal.ts`（JS 改 POST）、README。

**验证**：集成测试——POST /api/auth 种 cookie 后无 token 访问 /events 成功；旧 query 通道仍工作；portal HTML 无 `?token=` 拼接。

### 2C Web GUI 文件写接审计

**现状**：Web GUI 的 HTTP 文件写（writeFile/rename）不经 ToolDispatcher、不落 `mcp_audit.jsonl`（`src\web-gui\files-api.ts:141-147`）——旁路写入零留痕。可核查评估 M8。

**设计**：files-api 写操作成功后调 `appendAuditLine`：`tool:'web-gui', action:'write_file'|'rename_file', risk:'write', changed_files:[...]`。projectPath 从 FilesApi 已有的项目根上下文取。web-gui 属 server 内嵌模块，import `core/audit-log` 方向合法（core 不依赖 tools/web-gui 的约束不被触碰）。

**改动面**：`src\web-gui\files-api.ts`（两处写点后追加审计调用）。

**验证**：单测断言 HTTP 写文件后审计行落盘（tool=web-gui）。

### 2D 机器级审计 error 脱敏

**现状**：机器级审计 `details.error` 写原始错误消息未脱敏（`src\cli\godot-installer.ts:246`、`src\cli\web-exporter.ts:110-111`）——URL/网络错误可能带查询串或内部路径。

**设计**：复用 `src\core\logger.ts:68,123-143` 的敏感词脱敏思路，在 audit-log.ts 导出 `sanitizeAuditText()`（或从 logger 导出共享函数），两处 CLI 调用点接入。

**改动面**：`src\core\audit-log.ts` 或 `src\core\logger.ts`（导出函数）、两个 CLI 文件。

**验证**：单测构造含 `token=xxx` 的错误消息，断言落盘已打码。

---

## 批次 3：challenge-response 握手（TS+GD 双端协议变更，高复杂度）

### 3A editor WS / bridge TCP 抗假监听者认证

**现状**：TS 连上端口即发送明文 secret（`src\core\EditorConnection.ts:517-523`、`src\core\bridge-client.ts:458-460`）；本机恶意进程先绑 9090/9081 即可**收到 MCP server 主动送来的凭证**并冒充编辑器/游戏（评估 H3）。协议当前无版本协商（已实测确认握手为单发 auth）。

**协议设计（proof-of-secret，secret 不上线路）**：
1. TS 连接后发 `{"jsonrpc":"2.0","id":-2,"method":"auth_begin"}`。
2. 服务端（插件/bridge）回 `{result:{challenge:"<32hex 随机>"}}`，每次连接随机。
3. TS 发 `{"method":"auth_proof","params":{"proof": hex(HMAC-SHA256(secret, challenge))}}`。
4. 服务端恒时比较 proof（复用现有 `_constant_time_compare`，`websocket_server.gd:611-620` / `mcp_bridge.gd:719-728`），通过后标记 authenticated。

攻击面变化：假监听者只能收到 HMAC（对单次 challenge 有效）——**拿不到 secret 本身，无法连真插件横向复用**。残余面：假监听者仍可冒充插件对 TS 返回假数据（欺骗/DoS 层），凭证不泄露。这是不引入 TLS 的本地威胁模型下的可达上限。

**双端实现要点**：
- TS：`crypto.createHmac('sha256', secret).update(challenge).digest('hex')`。
- GD：Godot 4 `Crypto.hmac_digest(HashingContext.HASH_SHA256, key, msg)`（websocket_server.gd 与 mcp_bridge.gd 各自实现，注意 PackedByteArray 编码一致：secret 与 challenge 都按 UTF-8 bytes）。

**兼容矩阵（关键风险控制）**：
| 组合 | 行为 |
|------|------|
| 新 TS + 新插件/bridge | auth_begin → challenge → proof，secret 不上线 |
| 新 TS + 旧插件/bridge | auth_begin 收到 `-32001 Authentication required`（旧端未认证时对非 auth 方法的响应）或超时（1.5s）→ 回退旧明文 auth + `logger.warn` 降级提示（旧版部署期仍暴露于 H3，收敛靠版本推进） |
| 旧 TS + 新插件/bridge | 插件保留旧 `auth` 明文方法不删（服务端同时接受 auth 与 auth_proof） |
| 旧 TS + 旧插件 | 现状不变 |

**改动面**：`src\core\EditorConnection.ts`、`src\core\bridge-client.ts`、`addons\godot_mcp_server\websocket_server.gd`、`src\scripts\mcp_bridge.gd`（分发链 addons/ 同步）。⚠️ 改 `addons/**/*.gd` 后必须 `npm run check:gdscript`（项目级完整编译，AGENTS.md §6）。

**验证**：
- 双端单测（TS 模拟对端行为测协议序列与降级路径）。
- editor 实测握手（launch_editor + 真实插件）。
- `npm run lint && npm run build && npm test && npm run check:gdscript` 全绿。

**回滚**：协议方法独立（auth_begin/auth_proof 新增、auth 保留），TS 回滚即回旧行为；GD 侧新方法对旧 TS 无影响，可独立留存。

---

## 决策项（需用户裁决，不随批次自动执行）

| # | 决策 | 选项与建议 |
|---|------|-----------|
| D1 | **Web GUI 默认开启是否翻转**（`src\GodotServer.ts:553` `!== '0'` 即启动） | (a) 维持默认开 + 2B 收敛【建议——保留"面板随 server 自动起"的设计初衷，token 面已收敛】；(b) 翻转为默认关（`=== '1'` 才开）——行为变更，现有用户体验受损 |
| D2 | **godot 二进制白名单空=放行是否收紧**（`src\core\godot-finder.ts:122`，现有 back-compat 链：UNRESTRICTED→env→godot-paths.json→放行+签名校验兜底） | (a) 维持 + `doctor` 增加"未设白名单"提示【建议——收紧会破坏未跑 install 用户的直达体验】；(b) 加 `GODOT_MCP_STRICT_GODOT_PATH=true` 收紧开关 |
| D3 | **审计 HMAC 哈希链是否上**（2A 增强：机器密钥 `~/.godot-mcp/.audit-key` 签每行，防整体重写伪造） | (a) 批 2 先做外置双写，哈希链看外置层实效再决定【建议】；(b) 直接一步到位 |
| D4 | **`GODOT_MCP_AUDIT` 关闭开关是否保留** | (a) 保留 + 1E 启动告警【建议——开发调试需要】；(b) 高安全发行版移除关闭能力 |

---

## 通用流程要求（每批次收尾）

1. `npm run lint` + `npm run build` + `npm test` 全绿（AGENTS.md 强制三件套）；批 3 加 `npm run check:gdscript`。
2. 工具描述/schema 变更（audit.ts 加参数）后 `npm run build-matrix`。
3. 每批次独立分支 + Conventional Commits（`fix(security): ...` / `feat(security): ...`）。
4. 每批落地后按 AGENTS.md §8 派 code-reviewer 出独立审查文档到 `docs/reviews/`。
5. 完成后登 memory（feature-decision-log + 工程教训）。
