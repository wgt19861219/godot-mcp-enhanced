# Threat Model(威胁模型声明)

> 本文档声明 godot-mcp-enhanced 的安全机制分层、信任边界与已知限制。
> 格式借鉴 satelliteoflove-godot-mcp `docs/architecture.md`「Security posture」段,但 enhanced 有 10 层防护,需分层声明。
> **所有判定基于代码实测(file:line),非自述臆测。**

---

## 0. TL;DR(一锤定音)

enhanced 提供**本地单用户开发场景下的多层 accident guard**(路径白名单 / GDScript+bpy 注入防御 / out-of-band 确认令牌 / 输出标记防伪造 / localhost + secret + HMAC 鉴权),显著强于赛道内无任何安全机制的方案;但**非多用户/不可信输入的 security boundary** —— 两个根本限制:
1. **GDScript Turing-complete**,regex 黑名单沙箱本质不完整(变量间址/反射可绕过);
2. **同机其他用户可读 secret 文件**,多用户/共享主机场景需手动 chmod + 容器隔离。

> 需真正隔离用容器/VM + `GODOT_MCP_ALLOW_UNSAFE=false`。

**核心句式(对齐 satellite)**:各防护层是 **accident guard, not a security boundary** —— 它防止 AI 心不在焉地误操作,不防御有准备的对抗性输入。

---

## 1. 信任模型(Trust Model)

### 1.1 信任主体

| 主体 | 信任度 | 说明 |
|---|---|---|
| MCP client(AI) | **半可信** | 会尝试自读自确认 token;由 out-of-band elicitation gate 门控(见 §2.4) |
| 同机当前用户 | **可信** | 默认场景(单用户开发机) |
| 同机其他用户 | **不可信** | 多用户/共享主机威胁:可读 secret 文件 → 本地提权 |
| 远程网络 | **不可信** | 所有 server 强制 `127.0.0.1` bind;无 TLS(localhost 可接受) |
| GDScript 代码(AI 注入) | **不可信** | sandbox blacklist 防,但 Turing-complete 可绕过 |

### 1.2 信任边界

```
MCP client ──stdio──▶ enhanced server ──127.0.0.1:WS──▶ editor plugin(addon)
                          │
                          ├──127.0.0.1:TCP 9081──▶ game bridge(运行中游戏)
                          │
                          └──127.0.0.1:HTTP──▶ multi-instance(默认关闭)
```

所有跨进程通道均 **localhost-only**;stdio 是唯一对外通道(受 MCP client 进程边界保护)。

---

## 2. 防护层清单(逐层声明:accident guard vs security boundary)

### 2.1 路径白名单(deny-by-default)

- **机制**:`ALLOWED_PROJECT_PATHS=path1;path2` 白名单,未配置回落 `cwd`。`src/core/path-utils.ts:261-309`(`isPathInAllowedRoots`)、`:157-191`(`resolveWithinRoot`)。入口:`ToolDispatcher.ts:333/651`(validatePathArgs)、`addon-version.ts:17/22/33/41`(双重校验)。
- **防 junction/符号链接**:是。请求路径 + 白名单条目**两边都 realpath 归一**(`path-utils.ts:281,297-307`,C-1/C-SEC-1 修复)。
- **判定**:**accident guard + 本地单用户硬隔离混合**。`GODOT_MCP_UNRESTRICTED=true` 全放行(dev)。
- **已知限制**:realpath 后到实际写文件前存在 TOCTOU 窗口(`path-utils.ts:155-156` 承认,本地场景接受)。

### 2.1.1 Godot 二进制白名单 + CLI 自动安装信任链(批 2,2026-08-20)

- **白名单优先级链**(`src/core/godot-finder.ts` `isGodotPathAllowed`):`GODOT_MCP_UNRESTRICTED` 旁路 → `GODOT_MCP_ALLOWED_GODOT_PATHS` env(设了即用,显式用户意图,config 被忽略)→ `~/.godot-mcp/godot-paths.json`(CLI `install` 登记的路径视为可信)→ 两者皆无 back-compat 放行(签名校验 `isGodotVersionSignature` 兜底不变)。config 容错读:文件不存在/JSON 损坏/字段非法 → 视为未登记(不放大信任面)。
- **config 写入方唯一**:CLI `install`(`src/cli/godot-installer.ts`,用户 y/N 确认后)。AI/MCP 链路**无任何写入口**——godot-paths.json 不是 AI 可扩大的信任面。
- **下载信任链**:下载域名硬编码白名单(github.com / objects.githubusercontent.com / api.github.com,https 强制)——**白名单只约束首跳 URL**,`redirect: 'follow'` 的重定向目标域不校验;内容的真正防线是 **SHA512 与二进制同 release 同信道**(`SHA512-SUMS.txt`,官方 releases 自带)——无论重定向到哪,拿到的内容必须匹配同源哈希,信任根 = github.com release 本身,无跨信道信任假设(spec 未决项 1 实测结论:官方不提供独立 SHA256,提供同源 SHA512)。校验失败即删,不留半成品;解压后非 Windows 平台补执行位(0o755)+ `validateGodotBinary` 回读自检(防「解压成功但不可执行」虚假成功,审查 I-1)。
- **解压**:自写零依赖 zip reader(`src/cli/zip-extract.ts`)——系统 tar 方案废弃(Linux GNU tar 不支持 zip;Windows GNU tar 把 `C:\` 绝对路径当 host:path 远程语法)。条目名路径穿越防护(绝对路径/盘符/`..` 段任一命中 → 整包拒绝);完整性由外层 SHA512 保证,内层 CRC 不重复校验。
- **审计**:install 成功/失败均落机器级 `~/.godot-mcp/machine-audit.jsonl`(复用 `AuditEntry` + appendFile 原子追加)。
- **行为变化提示**:登记后白名单收紧为登记路径——用户既有的 `GODOT_PATH` 指向路径可能被拒;继续使用多 Godot 需显式设 `GODOT_MCP_ALLOWED_GODOT_PATHS` 列全(CLI install 完成提示与 README 环境变量表均已说明)。

### 2.2 GDScript 注入防御(blacklist sandbox)

- **机制**:`src/gdscript-executor.ts:46-108`(`DANGEROUS_PATTERNS`)、`:421-465`(`scanGdscriptSandbox`)、`:196-249`(字符串拼接绕过检测 + `%` 格式化)。覆盖 OS.execute/kill、FileAccess.WRITE、Engine/ClassDB 反射、JavaScriptBridge.eval、str2var/bytes2var、网络回连(WebSocketPeer/HTTPClient,2026-08-07 加)等。双 opt-in 旁路(`:1054-1055`:`UNRESTRICTED` 且 `DISABLE_SAFETY`/`ALLOW_UNSAFE`)。
- **判定**:**accident guard**。文件头自述(`:10-15`):「blacklist to catch accidental misuse, NOT a security boundary — GDScript is Turing-complete so regex cannot exhaustively block indirect/reflection bypasses」。
- **已知绕过**(`:33-44` 列举):① 变量间址 `var cmd="OS"; cmd+".execute"`;② `Expression.execute` 计算串;③ `.call()` 非字面量首参;④ `ClassDB.class_call/class_set_property` 反射。

### 2.3 bpy(Blender)注入防御

- **机制**:`src/core/bpy-sandbox.ts:8-24`(`DANGEROUS_BPY_PATTERNS`:os.system/popen/exec*/spawn*/subprocess/shutil.rmtree/eval/ctypes 等)、`:55-111`(拼接检测)。双 opt-in(`:117-118`,S-1/S-2 加固:单设 DISABLE_SAFETY 静默忽略)。
- **判定**:**accident guard**。`:3` 自述「防误用层非防对抗(字符串拼接/反射可绕过),真正隔离须容器/VM」。

### 2.4 危险操作确认令牌(out-of-band elicitation)★ 强门控

- **机制**:`src/guard.ts:71-107`(createPendingToken,`randomBytes(18).base64url` ≈ 144 bits)、`:118-143`(consume/peek,P0-2 MRTR 两轮)。`ToolDispatcher.ts:336-397` confirm_and_execute 分支:经 MCP `elicitation/create` 协议(server→client→**user UI**)问用户,out-of-band。
- **防 AI 自读自确认**:**核心机制**。`guard.ts:111-117` 注释:单客户端 caller/session 绑定不堵 AI 自确认(AI 同 session 产生+消费 token),**由 confirm_and_execute 的 out-of-band elicitation gate 堵** —— AI 经 tools/call 通道无法伪造 elicitation 响应。
- **判定**:**强门控(防 AI 自确认)**。token 强度防猜测/暴力;elicitation out-of-band 是真隔离 AI 单 session 自确认。
- **已知限制**:① `GODOT_MCP_ALLOW_UNSAFE_CONFIRM=true` 降级为纯 token(同 session AI 自确认即过,仅可信本地/CI);② client 不支持 elicitation 时走最严 path(中止,UX 受损)。

### 2.5 输出标记防伪造(per-execution random marker)

- **机制**:`src/gdscript-executor.ts:548-559`(`generateMarker`,122 bits crypto.randomUUID)、`:1104-1138`(每次执行注入随机 marker `__MCP_<16hex>__`,GDScript 必须真跑完 print 该 marker 包裹的结果)、`:973`(parseMcpMarkers 校验)。
- **判定**:**accident guard + 弱对抗边界**。防 AI 注入的 GDScript 凭空 print 固定 marker 伪造成功输出(早期固定 marker 可伪造);随机 marker 后无法预知,只能真跑。
- **已知限制**:GDScript 通过 `get_script()` 反射读取被注入的 marker 字面量回放(理论可行,沙箱已拦 `.get_script` 但反射变种未必穷尽)。

### 2.6 editor 鉴权(WebSocket secret)★ localhost 强门控

- **机制**:`src/core/editor-auth.ts:72-97`(readEditorSecret)、`:117-167`(waitForEditorSecret,**S-3 每轮 lstatSync 复检**防 TOCTOU)。GD 端 `addons/godot_mcp_server/websocket_server.gd:228`(强制 `127.0.0.1`)、`:51-137`(secret 生成 + symlink 预检 SEC-P2-2)、`:283-309`(per-peer auth + lockout)。secret 32 字节,经环境变量传(不经命令行,I-3)。权限:Windows icacls `/inheritance:r /grant ${user}:M`,POSIX `chmod 0o600`(`editor-auth.ts:32,59`),world-readable 拒绝。
- **判定**:**localhost 强门控**。
- **已知限制**:① 多用户/共享主机其他用户读 secret 文件 → 本地提权(`websocket_server.gd:53-54` 自述,Godot FileAccess 无权限参数);② `GODOT_MCP_EDITOR_PERSISTENT_SECRET=true` 固定 secret 复用(测试用)。

### 2.7 TCP game bridge 鉴权(9081)★ localhost 强门控

> ⚠️ **纠正**:竞品报告附录 C 曾称"game bridge 无鉴权"——**实测错误**。game bridge 有完整鉴权,与 editor 同强度。

- **机制**:`src/tools/game-bridge.ts:17-18`(localhost)、`:99-145`(readBridgeSecret + symlink + ACL)、`:164-291`(auth handshake:TS 发 `{method:'auth',params:{secret}}`,GD 比对后返 `{authenticated:true}` 才通过)。GD 端 `src/scripts/mcp_bridge.gd:277`(强制 `127.0.0.1`)、`:294-430`(32 字符 secret + 0o600/icacls)、`:339-364`(_generate_secret)、per-peer lockout(`:27-28`)。
- **判定**:**localhost 强门控**(bind + 32 字符 secret + handshake + ACL + symlink + lockout)。
- **已知限制**:① TCP 9081 端口固定(可猜测);② plaintext 无 TLS(localhost 可接受);③ 多用户同机读 secret → 本地提权(同 editor)。

### 2.8 multi-instance 隔离(HMAC,默认关闭)

- **机制**:`src/core/instance-manager.ts:47-63`(isInstanceInfo 类型守卫,S-6 id 正则 `^[A-Za-z0-9_-]+$`)、`:92-104`(S-5 icacls owner:F)、`instance-http-server.ts:105/159-171/229`(127.0.0.1 + Bearer + toolName 正则 + MAX_BODY 1MB S-7)、`instance-api-auth.ts:45-167`(HMAC 签名 + nonce 防重放 + 60s TTL + 常量时间比较)。GD 端 `instance_registry.gd:40-164`(S-4 symlink fail-closed:PowerShell ec≠0 且≠3 拒写)。
- **判定**:**localhost 强门控(HMAC + nonce + ACL + 类型守卫)**。但 `MULTI_INSTANCE` **默认关闭**(`instance-api-auth.ts:13`),需显式启用。
- **已知限制**:同机用户读 `.api-secret` 仍可冒充实例(本地提权前提)。

### 2.9 ReadOnlyGuard

- **机制**:`src/core/ReadOnlyGuard.ts:14-35`。`GODOT_MCP_READ_ONLY=true` 启用,**deny-by-default**(未知工具直接 block,I-08)。
- **判定**:**accident guard / 模式开关**。仅在工具调度入口生效。
- **已知限制**:绕过 `GodotServer.handleToolCall` 单一入口的直调;env 关闭。

### 2.10 capability securityLevel(纯审计维度)

- **机制**:`src/capability/schema.ts:11`(SecurityLevel = danger-api/guarded/safe)、`:65-69`(classifySecurityLevel)。产物 `docs/capability-matrix.{json,md}`。
- **判定**:**纯审计报告维度**。grep 全仓 `securityLevel` 仅在 `src/capability/`,**运行时调度完全不读**(dispatcher/guard/middleware)。运行时门控由 `guard.ts:requiresConfirmation` 读 `ToolMeta.actionRisks`(独立维度)。作用:驱动 L2 安全回归测试 + diff-matrix 监控降级。

---

## 3. 已知威胁与缓解(Threat Catalog)

| # | 威胁 | 缓解(层) | 残余风险 |
|---|---|---|---|
| T1 | AI 自读自确认 token | out-of-band elicitation(§2.4) | `ALLOW_UNSAFE_CONFIRM` 降级时失效 |
| T2 | AI 注入 GDScript RCE | sandbox blacklist(§2.2) | 变量间址/反射绕过(本质不完整) |
| T3 | GDScript 伪造 MCP 输出 | 随机 marker(§2.5) | 反射读取 marker 回放(理论) |
| T4 | 路径穿越/junction | realpath 归一(§2.1) | TOCTOU(本地接受) |
| T5 | 多用户同机读 secret | icacls/chmod(§2.6/2.7) | **不防**(Godot FileAccess 无权限参数,需手动 chmod) |
| T6 | editor 模式 err.message PII 外泄 | G2 PII 护栏(§2.10) | **EditorToolExecutor catch→return 盲区**(I-1,deferred) |
| T7 | symlink 换链 TOCTOU | S-3 每轮复检 + 写前预检(§2.6) | 非原子窗口 |
| T8 | 多实例 nonce 重放 | HMAC + nonce 查重(§2.8) | secret 泄漏后冒充 |
| T9 | web-gui HTTP 面越权侦察(假路径/白名单外 403 探测)零留痕,事后不可核查 | 批6(2026-09-19):sessions/start 与 projects/add 的 readonly/白名单 403 拒绝接审计(`server.ts:619,624,550`);路径不存在的失败留痕由 `web-gui/audit-helper.ts:38-42` 分流落机器级 `~/.godot-mcp/machine-audit.jsonl`(不建目录零垃圾,`details.project_path_absent` 标注事实) | file_save 的 readonly 403 在 body 解析前拦截、无 projectPath 可归属,仅 logger 留痕(`server.ts:457-466` 边界注释);认证层 401/403(Origin/token)同样无路径信息仅 logger |

---

## 4. 诚实边界声明(Honest Limitations)

对齐 satellite「accident guard, not a security boundary」+ enhanced 代码自述:

1. **GDScript 不可沙箱**(`gdscript-executor.ts:10-15`):Turing-complete,regex 黑名单本质不完整。4 类已知绕过(§2.2)。**真沙箱用容器/VM**。
2. **多用户/共享主机不安全**(`websocket_server.gd:53-54`):Godot FileAccess 无权限参数,secret 文件可被同机其他用户读 → 本地提权。**多用户需手动 chmod 0600 + 容器**。
3. **TOCTOU 接受风险**(`path-utils.ts:155-156`):symlink 检查到实际写文件的窗口。本地单用户场景接受;S-3 每轮复检缓解。
4. **securityLevel 纯审计**:不接运行时门控(§2.10)。是静态 grep 命中,非动态行为度量。
5. **所有网络服务 localhost-only 无 TLS**:plaintext 在 localhost 可接受;`GODOT_MCP_EDITOR_PERSISTENT_SECRET`/`ALLOW_UNSAFE_CONFIRM` 等 opt-in 降级仅可信环境用。
6. **G2 PII 护栏盲区**(`EditorToolExecutor.ts:152,172,277,305,319`):多个 catch→return 透传 err.message,绕过主 catch classifyError。editor 模式错误含路径时 PII 外泄(deferred,见 G2 审查 I-1)。
7. **措辞统一**:本文档统一称「防误操作层 / accident guard」(对齐 `gdscript-executor.ts:10-15` 文件头自述)。`path-utils.ts:280` 旧注释称「本地单用户信任场景的安全边界」措辞偏强,应以本文档为准。
8. **web-gui 拒绝留痕覆盖边界**(批6,2026-09-19):业务路径 403(sessions/start、projects/add)已接审计,T9;但 file_save readonly 403(拦截在 body 解析前,无 projectPath)与认证层 401/403(Origin/token,无路径信息)仅 logger 留痕——无项目归属的安全事件机器级落条目价值低,裁决不做,留痕覆盖以业务路径为准。

---

## 5. 推荐部署场景

| 场景 | 配置 | 安全度 |
|---|---|---|
| **单用户开发机**(默认) | 默认 basic profile(G7:lite 9 组 + RCE gated,省 ~60% context;回退 `GODOT_MCP_PROFILE=full`) | ✅ accident guard 足够 |
| **CI/Docker** | `GODOT_MCP_ALLOW_UNSAFE=false` + 容器隔离 | ✅ 真 isolation |
| **多用户/共享主机** | **不支持默认配置** | ⚠️ 需手动 chmod secret + 容器,否则本地提权 |
| **不可信 AI/对抗输入** | 容器/VM + 禁用危险 action | ⚠️ GDScript 沙箱不防对抗,必须容器 |

---

## 6. 引用

- **AGENTS.md「安全体系」段**:诚实边界声明(防误操作层,真隔离用容器/VM)
- **各层 file:line**:见 §2 各层(全部实测)
- **satellite `docs/architecture.md`「Security posture」**:格式参考(简洁「accident guard, not a security boundary」声明)
- **代码诚实注释**:`gdscript-executor.ts:10-15/33-44`、`bpy-sandbox.ts:3/52-53`、`path-utils.ts:154-156`、`guard.ts:111-117`、`websocket_server.gd:52-54`

---

## 变更日志

| 日期 | 变更 |
|---|---|
| 2026-08-13 | 初版(G8 速赢批),10 层防护实测声明 + 诚实限制。纠正附录 C「game bridge 无鉴权」误判(实测有完整鉴权)。 |
| 2026-09-19 | 批6(批5审查挂账 N-d/N-e 处置):新增 T9(web-gui 越权侦察留痕)与诚实边界第 8 条;bridge 端口解析新增显式覆盖入口 `GODOT_MCP_BRIDGE_PORT_OVERRIDE`(`bridge-client.ts:134`,测试注入先例对齐 REGISTRY_DIR,发现类信息不涉安全边界)。 |
