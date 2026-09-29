# web-gui 设置面板批第三方审查（2026-09-29）

> 审查对象：分支 `feat/web-gui-settings` commit `feat(web-gui): 设置面板——Godot 路径/版本 + 项目白名单,保存即热生效+持久化`。
> 审查者：code-reviewer 子代理（与实现者隔离，全部结论 grep/read 实测取证）。
> 审查者工具约束声明：该会话无 Bash，无法复跑 lint/build/test 与 node -e hash 复算，「验证完整性」维度以静态替代证据（build 产物内容抽查 + 测试内锚互证）给出；coordinator 侧已补跑全量验证（见文末）。

## 总体判定：SHIPPED WITH NITS

1 条 Important（审计覆盖不对称）+ 5 条 Nit，无 Blocking。设计正确性、分层约束、快照语义、热生效机制依据、文档同步均实测通过。

## 逐维度结论（审查者原文要点）

### 1. 设计正确性 — 通过

- 热生效机制依据两项实测成立：`ALLOWED_PROJECT_PATHS` 每次调用现读 env（`src/core/path-utils.ts:222-226` 无缓存）；`GODOT_PATH` 缓存失效链闭合（`src/core/godot-finder.ts:366` 首查 `_pathCache` → `src/core/user-settings.ts:125` 无参 `clearGodotPathCache()` 全清）。
- 快照恢复语义：`ensureStartupSnapshot()` 幂等（`user-settings.ts:36-44`）；空字段三态链正确（`:111-124`），测试覆盖三态（`test/user-settings.test.ts:75-91`）。
- 重放位置：`src/index.ts:66` `await applyUserSettingsAtStartup()` 在 C-08 提示（`:68-73`）之前，且在 `startMcpServer()` 唯一入口覆盖全部启动路径。
- merge 语义正确（`src/web-gui/settings-api.ts:157-166`，单字段 patch 不清另一字段，测试实证）；前端恒发两字段 + 清除=恢复快照的语义自洽消除了「无意发送空数组」类误操作风险。

### 2. 安全 — 一处不对称（Important-1）

- 写端点鉴权：POST 白名单注册（`server.ts:307-308`）、`authorized()` 先行（`:459-462`）、GET 同闸（`:367-371`）。
- READ_ONLY：POST `/api/settings` 403 拦截不调 save（`server.ts:557-560`，测试实证）；verify 放行合理（只读探测，二进制执行面被 `isGodotPathAllowed`（`godot-finder.ts:150`）+ `detectGodotVersion` 二次白名单（`:179`）+ 签名校验（`:191`）三重卡住）。
- save 全链校验含白名单（`settings-api.ts:120` → `godot-finder.ts:112-131` 优先级链），stage 透传 UI 人话。
- PII 对称性评估：`GODOT_STAGE_MESSAGES` 不含路径；allowedProjectPaths 校验错误含路径，但属**用户自己刚输入内容的回显**（token 鉴权后的本机单用户面板），与 `detectGodotVersion` 的服务端路径护栏性质不同——**可接受，非问题**。
- 前端 XSS 面：`innerHTML|insertAdjacentHTML|document.write` 零命中；动态内容全 textContent；`data-cand` 委托；契约断言在位。
- `GODOT_MCP_UNRESTRICTED` 无 GUI 开关：get() 仅只读展示（`settings-api.ts:83`），apply 不触碰。

### 3. 仓库级约束独立核查 — 通过

- core 分层：`user-settings.ts` import 仅 node 内置 + core 内模块，无 `../web-gui/`、`../tools/`；`eslint.config.js:28-33` 门禁下合规。
- 模块级 setter 红线：`_startupSnapshot` 为进程语义状态单例（快照须全进程唯一），非依赖注入 setter；`resetUserSettingsSnapshotForTest` 对齐 `clearGodotPathCache` 先例；defects.ts 已登记。**合规**。
- 基线 bump 85→86：注释链格式与历史条目逐字同构；计数自洽（`user-settings.ts` 内匹配仅 1 处）。
- rule-templates/.claude/rules 未动（内容 grep + 版本 0.33.9 未 bump + CHANGELOG 声明三角互证）；无 version bump 硬门禁触发。
- build-matrix：零 MCP 工具清单变更，无需重建。

### 4. 测试质量 — 通过（一小缺口见 Nit-1）

- mock 文件级注册无泄漏；每用例重置；env 备份恢复完备（`settings-api.test.ts` 三键含 `GODOT_MCP_UNRESTRICTED`）；server-settings 同用例双 start 正确 stop 第一次。
- CSP hash 双通道：测试锚与独立重算（split 提取 + CRLF 归一含前导换行）互证自洽；build 产物内容抽查与 src 一致。

### 5. 验证完整性 — 审查者无法复跑（如实声明）

静态替代证据给出；coordinator 补跑结果见文末。

### 6. 文档同步 — 通过

AGENTS.md web-gui 段更新且 dashboard TUI 禁令表述保留；README/CHANGELOG 与实现逐项吻合。

## Blocking Issues

无。

## Important Issues

**Important-1：save 的机器级审计覆盖不对称——allowedProjectPaths 校验失败无留痕（置信度 85）**
- 位置：`settings-api.ts`（处置前 bad-entry/not-absolute/not-a-directory/not-found 四 return 及 empty-patch）
- 白名单是 deny-by-default 安全边界，修改白名单被拒与 godotPath 被拒同属安全事件；原实现仅 godotPath 失败有审计行。
- **处置（已修，commit 2）**：四个 allowed 校验失败分支各补 `auditSave(false, ...)`（empty-patch 豁免——无内容无事件）；`settings-api.test.ts` 扩充断言（4 条拒绝 → 4 行 ok:false 留痕 + 合法通过仅 1 行 ok:true）。

## Nits 与处置

1. **GodotServer 注入无接线层断言** → **已修**：`wiring-projects.test.ts` 补「settings 注入」用例（三方法存在 + isReadOnly 同源透传断言）。
2. **READ_ONLY 拦截位置在 body 读取后（与 file_save 早拒形态不一致）** → **不修（复核后降级为非问题）**：file_save 的早拒是 600KB 大 body 专属设计（server.ts:471-474 注释明示）；settings 与 sessions/start、projects 系列同为 64KB 通用 body 后拦截形态，同文件内多数派一致。影响仅「小 body 先进内存」，64KB 上限兜底。
3. **含分号路径条目静默撕裂** → **已修**：校验层显式拒绝含 `;` 条目（stage `contains-semicolon`，UI 人话「env 以分号分隔,会被撕裂」）+ 失败审计留痕 + 测试断言。
4. **effective.godotPath 展示语义偏差（项目级 override 优先）** → **已修（文案层）**：设置面板 Godot 路径区 hint 补「项目若配了 .godot/mcp-godot.json 等项目级 override,该项目仍优先用 override 的路径」（静态 HTML 区改动，不影响 CSP hash）。
5. **路由层 403_readonly 无机器级审计** → **不修（对齐先例记录为诚实边界）**：与 file_save 的 403_readonly 同形态（仅 logger 留痕，server.ts:468-470 诚实边界注释）；service 层校验失败留痕（Important-1 处置）已覆盖可 attribution 的拒绝事件。后续若统一升级写端点 403 留痕，可一并处置。

## 值得进 memory 的工程教训（审查者提炼）

1. **「GUI 设置热生效」两件套的审查路径**：改 env 热生效前必须先 grep 消费点确认「每次现读」还是「缓存」——本仓 `ALLOWED_PROJECT_PATHS` 是现读（改即生效）而 `GODOT_PATH` 是缓存（须配 `clearGodotPathCache()`）。两种消费形态对应两种失效需求，漏配缓存清理 = 热生效假象。可复用为一切「运行时改 env」功能的核查清单。
2. **完整表单语义 + 快照恢复的语义自洽设计**：前端恒发两字段（空=清除）+ 清除=恢复启动快照（而非置空），使「用户无意发送空数组」天然无害——后端语义兜底消除前端误操作整类 bug，优于前端防呆。

## Coordinator 补跑验证（处置 commit 后）

- `npm run build` 通过；build 产物独立重算 CSP hash = `5um2wvWtsXoE3iwEYpItqUJ0hE/YCdZVRX81SZzTP+M=`（与 server-http.test.ts 锚一致，双通道互证）。
- 受影响 6 测试文件（user-settings / settings-api / server-settings / server-http / html / wiring-projects）96 用例全绿。
- 全量 `npm test` 最终结果见开发日志与 CHANGELOG（471 files / 6986+ tests 全绿）。
