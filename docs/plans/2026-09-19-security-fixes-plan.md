# 安全修复方案:批4(接线与语义修复)+ 批5(审计可核查性演进)

> 日期:2026-09-19。输入:`docs/reviews/2026-09-19-五维安全质量评估.md`(P1×2 + P2×9 + P3 若干)。
> 行号均为 2026-09-19 master@9c6eb58d 工作树实测(评估轮与方案制定轮双重核对)。
> 批次命名对齐既有惯例(security/hardening-batch1/2/3)。

---

## 0. 批次划分与裁决总览

| 修复项 | 级别 | 批次 | 任务 | 一句话 |
|---|---|---|---|---|
| auth_proof 不校验响应语义 | P2 | 批4 | T1 | 对齐 bridge 侧:显式 `authenticated:false` 即失败 |
| 明文降级记忆永不复位 | P2 | 批4 | T2 | 降级记忆加 TTL(10min),到期重试 challenge-response |
| before_values 零生产者 | **P1** | 批4 | T3 | 通用 `_audit` 上报通道 + write_config 接入 |
| caller 归因名存实亡 | **P1** | 批4 | T4 | caller 归一 `mcp[:agentId]` / `web-gui:<子系统>` / `cli:<命令>` |
| readonly 豁免破坏只读承诺 | P2 | 批4 | T5 | ReadOnlyGuard 升级 **action 粒度**(保留工具声明,不删) |
| saveText 绕过沙箱扫描 | P2 | 批4 | T6 | `.gd` 扩展名接 `scanGdscriptSandbox`;bat/sh/ps1 声明例外 |
| 审计静默关闭无痕迹 | P2 | 批4 | T7 | server 启动事件落 machine-audit(含审计开关状态,不受开关控制) |
| web-gui 6 写端点零审计 | P2 | 批4 | T8 | 补线 + caller 细分 + 审计行诚实化(顺手消化 P3) |
| CLI 写面零审计 | P2 | 批4 | T9 | json-config 公共底层单点接机器级审计 + init/skills |
| 杂项(icacls/审计行/token hash) | P3 | 批4 | T10 | 三处小改随批带走 |
| divergence 仅单向行数比对 | P2 | 批5 | T11 | 双副本**逐行内容比对**(检测"改字段不删行") |
| 无轮转+全量读内存 | P2 | 批5 | T12 | 流式逐行读 + 10MB 大小轮转(保留 3 代) |
| hash 链/签名 | — | **不做** | — | 见 §4 裁决:跨进程断链误报 + 与 T11 收益重叠 |

**不做/挂账裁决**(理由见 §4):锁定断开即清、challenge TTL、fs-atomic Windows 降级、EventSource `?token=`、suggest_rollback batch 失真(挂账)、FileAccess Phase3 扩展(挂账)、dispatcher 级路径机械门禁(挂账,架构级)。

---

## 1. 批4:接线与语义修复(分支 `security/hardening-batch4`)

> 全部为 TS 侧改动,无 `.gd`/`.claude/rules` 变更 → 不触发 check:gdscript 与规则模板 version bump 门禁。单分支多 commit(对齐批1/2/3 惯例)。

### T1 auth_proof 语义校验(P2,~15 行)

- **根因**:`src/core/EditorConnection.ts:558-559` 对端回任何 result 即置 `authenticated=true`;bridge 侧 `src/core/bridge-client.ts:552-557` 校验 `authenticated===false` 立即失败——不对称。
- **改法**:照抄 bridge 语义——`const res = await this.request('auth_proof',{proof}); if ((res as {authenticated?:boolean})?.authenticated === false) throw new ConnectionError('auth_proof rejected by peer')`。
- **兼容性**:只拦**显式 false**,不要求显式 true——真插件(`websocket_server.gd` auth_proof 成功路径)与旧端回空 result 均不受影响;拦住"恒回空 result 的半协议异构端"被误判认证成功。
- **测试**:`test/editor-connection.test.js` 补两例:mock 对端回 `{authenticated:false}` → 认证失败不降级;回 `{}` → 成功(兼容锁)。

### T2 降级记忆 TTL 复位(P2)

- **根因**:`EditorConnection.ts:518-525` `_useLegacyAuth` 实例级记忆永不复位(N-2 注释自认);`bridge-client.ts:433-440` `_bridgeLegacyAuth` 模块级同构。一次诱导 → 进程生命周期内持续明文。
- **改法**:两处降级记忆各配套时间戳(`_legacyAuthSince` / `_bridgeLegacyAuthSince`);尝试连接时若 `已降级 && Date.now() - since > LEGACY_AUTH_RETRY_TTL_MS` → 先重试 challengeResponseAuth:成功则清除降级记忆;再挂 `crFallback` 则重置时间戳并继续 legacy。TTL 常量导出(默认 **10 分钟**:旧插件会话不受打扰,攻击窗口从进程生命周期缩到 10 分钟)。
- **不改默认**:不默认硬锁 `REQUIRE_CR_AUTH`(违背"保留旧明文通道为兼容"的既定决策,该硬锁继续作为高安全 opt-in)。
- **测试**:`vi.useFakeTimers` 控时——TTL 内重连不再发 auth_begin(行为兼容锁);TTL 过后重连先发 auth_begin,mock 成功 → 恢复 proof 模式;mock 再拒 → 重置 TTL 继续 legacy。现有降级序列测试同步审阅(默认路径行为不变,预期不破)。

### T3 before_values 上报通道 + write_config 接入(P1)

- **根因**:`audit-log.ts:91` 定义 `before_values`(注释自认"阶段2 工具上报")、`:313-318` suggest_rollback 判定分支、`audit.ts:27,109` 工具描述已宣传——但 grep 全 src 零生产者,死路径。
- **改法**(通用通道,非特判):
  1. **约定**:工具可在 `result.structuredContent._audit` 放 `{ before_values?: Record<string,unknown> }`。
  2. **middleware**(`ToolDispatcher.ts:559-630` audit after hook):从 result 提取 `_audit.before_values` 合入 `details.before_values`;提取后**剥离 `_audit` 键**再返回(after hook 的返回值会传递,剥离防其成为半公共 API)。`_confirmExecute` 补审计路径(`:855-909`)同样提取。
  3. **write_config 接入**(`src/tools/project.ts:626` 起):写配置前读当前值,`result.structuredContent._audit.before_values = { [key]: 旧值 }`。
  4. suggest_rollback 分支(`audit-log.ts:313-318`)自动接通,`audit.ts` 描述从"宣传"变"真实"。
- **顺手(文档诚实化,P3)**:`audit.ts` get_log/suggest_rollback 描述补一句「execute 类(execute_gdscript 等)的 changed_files 不可静态推断,恒为空」——消化 P3"execute_gdscript changed_files 恒空"的声明落差。
- **测试**:write_config 落审计条目含 `details.before_values` 旧值;客户端收到的 result 不含 `_audit`;suggest_rollback 对该条目给出恢复建议(现有分支测试从"永不命中"变命中)。
- **注意**:描述变更后跑 `npm run build-matrix`(保险,matrix 含描述快照)。

### T4 caller 归因归一(P1)

- **根因**:`ToolDispatcher.ts:225-232` 唯一数据源 `_meta.agentId`(注释自认通常 undefined)→ caller 落盘缺省;web-gui 硬编码 `'web-gui'`;CLI 无 caller。
- **改法**(归一命名空间,纯增量不改既有字段语义):
  - dispatcher 构造 ctx 时:`caller = agentId ? \`mcp:${agentId}\` : 'mcp'`(`:613` 的 `?? undefined` 条件落盘随之恒有值;`_meta` 提取保留,跟踪 anthropics/claude-code#32514,未来客户端注入即自动生效)。
  - web-gui:`'web-gui:files'`(T8 统一)。
  - CLI:`'cli:qa'` / `'cli:web-exporter'` / `'cli:godot-installer'`(T9 统一)。
- **测试**(补评估指出的盲区):audit 测试新增 caller 字段断言——mcp 匿名 / mcp:agentId / web-gui:* / cli:* 四形态各一例。
- **验收**:任一审计条目 caller 非空;`audit get_log` 回放可按通道区分操作来源(抗抵赖"谁干的"从完全不可分辨升级为至少通道级可分辨)。

### T5 ReadOnlyGuard action 粒度(P2)

- **根因**:`manage-tools.ts:306-318`(`readonly:true` + `activate/deactivate:'write'`)、`physics-ops.ts:448-455`(`collision_overlay:'write'`)显式声明覆盖派生 → 只读模式下写 action 放行。
- **改法**:**不删工具声明**(评估备选方案会连累 list_groups 等 read action 在只读模式不可用),升级 guard 到 action 粒度:
  1. `ReadOnlyGuard.check(toolName, action?)`:action 为非空字符串且工具 readonly=true 时,查该 action 的 actionRisks——非 `'read'` → block,消息 `action "activate" of tool "manage_tools" is not read-only`;其余路径(无 action/未知 action)保持现状。
  2. 接线:`ToolDispatcher.ts:357`(主调用,`args.action` 可得)与 `:831`(confirm 路径,pending 含 action)传 action;`:166`(工具列表过滤,无 action 语境)不传,保持现状。
  3. 未知 action(动态名等)在只读模式 fail-closed:readonly 工具的未知 action 视为非 read 拒绝(与 A-07 deny-by-default 对齐)。
- **测试**:只读模式 `manage_tools list_groups` 放行、`manage_tools activate` 拒、`physics collision_overlay` 拒、未知工具拒(回归)、平铺只读工具(help 等 action='')不受影响(回归)。

### T6 saveText 接沙箱扫描(P2)

- **根因**:`src/web-gui/files-api.ts:26-28` TEXT_EXTS 含 gd/bat/sh/ps1;`:123-164` saveText 无 `scanGdscriptSandbox`——"全仓写 .gd 必扫描"(`script.ts:79-81`)声明的第四入口,且 web-gui 默认开启(`GodotServer.ts:553`)。
- **改法**:saveText 中 `ext === 'gd'` 时调 `scanGdscriptSandbox(content)`(已导出,`gdscript-executor.ts:474`),违规则拒写:抛 `FilesError('bad_request', 'content blocked by gdscript sandbox scanner: <首条违规>')`。**bat/sh/ps1 无扫描器,明确不覆盖**——在 saveText 注释与本方案 §4 记录例外(威胁模型内 web-gui token 持有者本可直接写盘,增量风险有限;如未来需要,另建 shell 沙箱属新需求)。
- **行为语义**:面板用户手改含危险模式的 .gd 会被拦(与 MCP 通道一致,一致性优先);报错文案指引用户经 MCP 通道(有确认门)完成。
- **测试**:写含 `OS.execute` 的 .gd → 4xx 拒且文件未变(mtime/内容断言);正常 .gd → 过;.bat 含危险内容 → 仍可写(例外锁,防未来误扩)。

### T7 审计启停留痕(P2)

- **根因**:`audit-log.ts:30-33` `GODOT_MCP_AUDIT=false` 全关且无降级痕迹——事后无法区分"没操作"与"审计被关"。
- **改法**:server 启动路径(`src/GodotServer.ts` 构造完成处)落一条机器级审计:`{ tool:'server', action:'startup', risk:'process', ok:true, caller:'mcp-server', details:{ audit_enabled, audit_strict, read_only, multi_instance } }`。
  > 实现偏差(批4审查 N-3 认可):details 第 4 字段实现为 `web_gui`(web-gui 开关状态)而非方案的 `multi_instance`——信息价值等价(均为审计面相关启动状态),multi_instance 默认关闭无独立启动期可读状态。
- **关键约束**:此留痕**必须不受 `GODOT_MCP_AUDIT` 开关控制**(否则失去意义)——实现时核查 `appendMachineAuditLine` 是否受开关影响;若受控,则该条用独立直写(复用 appendFile 原子追加逻辑,绕过 isAuditEnabled 判断)。
- **测试**:默认启动产生 startup 条目;`GODOT_MCP_AUDIT=false` 启动仍留痕且 `details.audit_enabled=false`。

### T8 web-gui 写端点审计补线 + caller 细分 + 诚实化(P2 + P3 顺手)

- **根因**:`src/web-gui/server.ts:299-305` 七个写端点仅 `/api/projects/file`(saveText)有审计;`sessions/stop` 杀进程零留痕(MCP 同语义 stop_project 是 risk=process 有审计)。saveText 审计行 trace_id 固定 `'web-gui-files'`、duration_ms:0、ok:true 硬编码(P3)。
- **改法**:
  1. 新增 `src/web-gui/audit-helper.ts`:`auditWebGui(subsystem, action, risk, opts?)` → appendAuditLine({ caller: `web-gui:${subsystem}`, trace_id: randomUUID 前 16hex, duration_ms 实测, ok 如实, changed_files/details 按需 })。best-effort(catch 后 recordAuditWriteFailure,对齐 saveText 哲学)。
  2. 接线(sessions/start|stop|remove → risk `'process'`;projects/add|remove → `'write'`,details 记目标项目;scan 为 read 不记):在 `handleApiPost` 各分支成功路径调用。
  3. saveText 重构复用 helper(caller 变 `'web-gui:files'`,诚实化 P3 随之消化)。
- **测试**:POST `/api/sessions/stop` → 审计条目 `caller:'web-gui:sessions', action:'stop', risk:'process'`;saveText 条目 trace_id 每次不同(诚实化锁)。

### T9 CLI 写面接机器级审计(P2)

- **根因**:`src/cli/clients/*.ts`(写 MCP 客户端配置——安全敏感:改它即可注入恶意 server)、`cli/init.ts:57,84,95`(写 project.godot)、`cli/skills.ts:58,99`(写 `~/.claude/skills/`)均零留痕。探查结论:写点分散,公共底层是 `json-config.ts`(多 adapter 复用)。
- **改法**:
  1. `json-config.ts` 写函数单点接 `appendMachineAuditLine`(加可选 `auditCaller` 参数,由调用方(configure.ts/setup.ts)透传 `'cli:configure'`/`'cli:setup'`;默认 `'cli'`)。单点接线避免 15 个 adapter 逐个改。
  2. `init.ts` 写 project.godot → `appendAuditLine(projectPath, { tool:'cli', action:'init', risk:'write', caller:'cli:init', changed_files:[...] })`。
  3. `skills.ts` 写 skills 目录 → machine 级,`caller:'cli:skills'`。
  4. 全部 best-effort:审计失败打 warn 不阻断 CLI 操作。
- **测试**:json-config 写后 machine-audit 出现条目;audit 写抛错时 CLI 命令仍成功退出。

### T10 杂项三小改(P3,随批带走)

1. `src/web-gui/registry.ts:117` icacls `:F` → `:M`(对齐 editor/bridge/api secret 惯例;rotateSharedToken 属主写 M 足够;若测试锁了 :F 同步改)。
2. ~~saveText 审计行诚实化~~(已并入 T8)。
3. `src/web-gui/open.ts:71` `?token=` → `#token=`(前端 `html.ts:133-136` 已支持 hash 通道提取;console 打码行同步)。浏览器历史不再留全量 token。EventSource 的 `?token=` 属浏览器 API 限制,不改(§4)。

---

## 2. 批5:审计可核查性演进(分支 `security/audit-hardening-batch5`)

### T11 divergence 升级为双副本逐行内容比对(P2)

- **根因**:`audit-log.ts:165-177` 仅 `projectEntries < externalEntries` 单向行数比对——改字段不删行、双删、仅删外置三者均不可检测。
- **改法**:`getAuditLog(external=true)` 时双副本逐行内容比对(两副本行内容本应完全一致):报告 `{ diverged, line_counts:{project,external}, first_divergent_line, divergence_kind:'length'|'content' }`。旧 `diverged` 布尔保留(消费方兼容),新增字段增量。
- **检测力升级**:现行盲区"改字段不删行"从不可检测 → `divergence_kind:'content'` 检出。"双删两份"(行数相等内容一致)仍不可检测——诚实边界,见 §4 挂账。
- **测试**:篡改项目内副本某行字段(不删行)→ `divergence_kind:'content'` + `first_divergent_line` 正确;删行场景回归 `length`;两副本一致 → `diverged:false`(回归)。

### T12 流式读 + 大小轮转(P2)

- **根因**:`audit-log.ts:211-224` readFile 全量进内存,limit 只裁返回不裁解析;全文无轮转,高频写项目 get_log 随膨胀变慢。
- **改法**:
  1. `readAuditLog` 改 `readline.createInterface` 流式逐行 parse(内存占用从文件大小降为行缓冲)。诚实声明:扫描量不变(取"最后 N 条"仍需全扫,尾部 seek 优化挂账);本项解决的是内存峰值。
  2. `appendAuditLine` 前置 `statSync` 大小检查:> `ROTATE_SIZE`(10MB)→ rename 链式轮转(`.jsonl` → `.jsonl.1` → `.jsonl.2` → 删 `.jsonl.3`,保留 3 代)。项目内与外置副本**各自独立**轮转。
  3. `getAuditLog` 主文件 only,响应附 `rotated_files` 计数提示(轮转代需手动查,不过度承诺合并回放)。
- **测试**:mock 大文件触发轮转 → `.jsonl.1` 产生、主文件重新起头;轮转后 get_log 正常;parseErrors 统计在流式下不回退(回归)。

---

## 3. 任务依赖与实施顺序

| 批4 内部相互独立(T4 先行为 T8/T9 提供 caller 约定),单分支顺序 commit(项目惯例)。
规模估算:批4 每任务 0.5~2 小时(合计约 2~3 个工作日含测试);批5 约 1 个工作日。

```
批4(单分支顺序 commit):
  T4 caller 约定 ──▶ T8(web-gui 用新 caller)/T9(CLI 用新 caller)
  T1、T2(EditorConnection)、T3、T5、T6、T7、T10 相互独立,任意顺序
批5(独立分支,批4 合并后开):
  T11 ← 依赖批4 无;T12 与 T11 同文件(audit-log.ts)顺序做防冲突
```

### 批4 审查处置记录(SHIPPED WITH NITS,2026-09-19)

- **N-1(挂账批5+)**:bridge 侧 auth_proof 空 result 行为"干等超时"应升级为与 editor 侧同款 `authenticated !== true` 立即拒——本批 editor 侧已按更强语义实现(`!== true`),方案原文"照抄 bridge 只拦显式 false"被实现取代(安全性更强且兼容论证经审查实证)。
- **N-4②(挂账批5+)**:auditWebGui 仅成功路径留痕(ok 恒 true),HTTP 面失败操作(500/异常)零留痕——对照 MCP 侧连失败也落审计(ok:false),两通道抗抵赖覆盖不等价;失败路径接线是行为扩展,另批做。
- N-2/N-4①/N-3 已在本批 fix commit 处置(early-return 剥离/CLI 项目级审计接开关/方案偏差说明)。

## 4. 明确不做/挂账裁决(诚实边界)

| 项 | 裁决 | 理由 |
|---|---|---|
| 审计 hash 链/签名 | **不做** | 跨进程并发写(server+CLI 同文件)必然断链误报;T11 内容级比对已覆盖"改字段"检测,链的增量收益不抵格式演进+误报成本。单写者场景可作远期可选增强 |
| 锁定计数断开即清 | 不做 | secret 190bit 暴力不可行;GD 侧注释已自认"仅减速带非主防线" |
| challenge 无 TTL | 不做 | challenge 仅是 HMAC 输入,泄露无价值 |
| fs-atomic Windows 降级直写 | 不做 | 可用性权衡,注释已自认;updateAddon 有独立 staging+回滚不受影响 |
| EventSource `?token=` | 不做 | 浏览器 API 无法带自定义头,技术限制;服务器无访问日志,残余面=浏览器历史 |
| execute_gdscript changed_files 恒空 | 文档诚实化(并入 T3) | 静态不可推断;运行时 diff 超范围 |
| saveText 覆盖 bat/sh/ps1 扫描 | 声明例外(T6 注释) | 无对应扫描器;威胁模型内 token 持有者本可直接写盘;shell 沙箱属新需求另议 |
| FileAccess.open 变量读入 Phase3 | 挂账 | tokenizer 扩展中等成本,属已声明的变量间接盲区框架,批5 后可选 |
| suggest_rollback 对 batch 推断失真 | 挂账 | details.batch=true 已存在,核查者可自知;改进收益低 |
| dispatcher 级路径校验机械门禁 | 挂账(架构级) | 存量工具抽查全接;新工具防漏接需中间层设计,长期项 |
| "双删两份副本"检测 | 挂账 | 需 hash 链/签名,同上不做理由;THREAT_MODEL 已声明黑名单非硬边界 |

## 5. 流程约束(对齐 AGENTS.md)

- 每批独立分支(批4 `security/hardening-batch4` / 批5 `security/audit-hardening-batch5`),不直接在 master 开 commit。
- 每批合并前:`npm run lint` + `npm run build` + `npm test` 全绿,贴输出。
- T3 改 `audit.ts` 工具描述 → 跑 `npm run build-matrix`(描述快照)。
- 本方案无 `.gd`、无 `.claude/rules` 变更 → 不触发 check:gdscript / check:rules-sync / version bump 硬门禁。
- **默认不发版**:变更进 CHANGELOG `[Unreleased]` 段;不 bump 版本、不加 README 版本行。
- 每批落地后派 code-reviewer 独立审查,产出 `docs/reviews/2026-09-XX-安全加固批4.md`(批5 同理);审查者须独立 grep 仓库级约束(本方案 §5 即清单)。
- 完成前登 memory(feature-decision-log + engineering-lesson)。

## 6. 验收清单(批4 全部完成后)

1. 只读模式:`manage_tools activate` 拒 / `list_groups` 过(T5)。
2. web-gui 写含 OS.execute 的 .gd → 拒(T6);`POST /api/sessions/stop` → 审计出现 `caller:'web-gui:sessions'` 条目(T8)。
3. `project write_config` 审计条目含 `details.before_values` 旧值;`audit suggest_rollback` 对该条目给出恢复建议(T3)。
4. `GODOT_MCP_AUDIT=false` 启动 → machine-audit 有 startup 条目且 `audit_enabled:false`(T7)。
5. `npx godot-mcp-enhanced configure ...` 写客户端配置 → machine-audit 有条目(T9)。
6. editor CR 降级后快进 10min 重连 → 恢复 auth_begin 尝试(T2);mock 回 `authenticated:false` → 认证失败(T1)。
7. 任意审计条目 caller 非空,可区分 mcp/web-gui:*/cli:* 通道(T4/T8/T9)。
8. `audit get_log external=true` 篡改单字段(不删行)→ `divergence_kind:'content'`(批5 T11);10MB 轮转后 get_log 正常(T12)。
