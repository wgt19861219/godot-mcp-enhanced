# 2026-09-17 架构审查修复方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 2026-09-17 架构审查的 4 High + 11 Medium 发现(15 Low 择要并入),分 6 个独立批次交付,每批独立分支、独立验证、可独立合并。

**Architecture:** 按子系统分批隔离风险——批1 GD 参数守卫(bridge 毒消息面)/批2 shutdown 完备性(close() 不变量)/批3 web-gui 安全 hygiene/批4 bridge 行为对称/批5 O1 哨兵收敛重构(独立)/批6 工程卫生。批1-4 相互独立可任意顺序;批5 必须在批1 之后(同文件减少冲突);批6 随时。

**Tech Stack:** TypeScript(ES2022/strict/ESM)+ GDScript(Godot 4.5-4.7)+ Vitest。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\reviews\2026-09-17-架构审查.md`(本方案从该报告论证,执行者两份都读;行号均为 2026-09-17 快照,执行时以 grep 重定位为准)

---

## Global Constraints

- **分支策略**:默认分支 master 不开 commit,每批开独立分支,命名 `fix/arch-fix-<N>-<slug>`;提交遵循 Conventional Commits(type 英文前缀+中文 subject)。
- **版本策略**:凡改 `src/scripts/mcp_bridge.gd` 的批次(批1/4/5),合并时 `BRIDGE_SCRIPT_VERSION` 与 `package.json` 同步 bump 一个 patch 并 `npm run version-sync` 校验、CHANGELOG 定版段(先例 0.33.4/0.33.5;按 2026-08-20 N-C 裁决,bump≠发版,npm publish/tag 待用户指令)。纯 TS 批次(批2/3/6)变更进 CHANGELOG `[Unreleased]` 不 bump。
- **每批合并门禁**(AGENTS.md「完成前强制检查」):`npm run lint` → `npm run build` → `npm test` 全绿;改 `addons/**/*.gd` 或 `src/scripts/*.gd` 后额外必跑 `npm run check:gdscript`(项目级完整编译,validate_scripts 有缩进盲区不可替代)。
- **GDScript 守卫先例**:全部数值守卫对齐 `src/scripts/mcp_bridge.gd:2480-2485` `_num` 模式(仅 int/float/合法数字串放行,其余回 fallback),不得发明新形态。
- **测试红线**:负向断言必须覆盖"全文件"而非当批函数(教训:批次 C 负向断言只扫 send_mouse_click/send_touch 致 H-1/H-2 漏网);先写失败测试再实现(TDD)。
- **快照护栏**:执行时所有 file:line 先用 grep 重定位(行号会漂移);报告中的行号写进 commit message 前同样重验。

## 批次总览

| 批 | 分支 | 覆盖发现 | 改动域 | 版本 bump | 依赖 |
|---|---|---|---|---|---|
| 1 | `fix/arch-fix-1-bridge-guards` | H-1 H-2 Low(add_node 静默丢弃) | GD 三副本+契约测试 | **是** 0.33.6 | 无 |
| 2 | `fix/arch-fix-2-shutdown` | H-3 H-4 M-9 M-10 | TS(core/tools/GodotServer) | 否 | 无 |
| 3 | `fix/arch-fix-3-web-gui-hygiene` | M-1 M-2 M-3 M-4 Low×5 | TS(web-gui) | 否 | 无 |
| 4 | `fix/arch-fix-4-bridge-symmetry` | M-5 M-6 M-8 Low(TOCTOU/lastSeen) | TS+GD | **是**(若 GD 侧改动) | 建议在批1 后(避免 mcp_bridge.gd 冲突) |
| 5 | `refactor/arch-fix-5-deferred-ctx` | M-7(O1 收敛) | GD(mcp_bridge.gd 核心) | **是** | 批1 |
| 6 | `chore/arch-fix-6-hygiene` | 工程卫生+README 安全陈述 | gitignore/文档/分支 | 否 | 无 |

**建议执行顺序:批1 → 批2 → 批3 →(批4 ∥ 批6)→ 批5**(批5 风险最高独立压轴;批2/3 是低成本高收益优先)。

## 决策点(执行前需用户裁决)

1. **app-window 分支处置**:`feat/web-gui-app-window`(4d66da8e,402 行,含测试)——**推荐:由用户 review 后决定合并**(它是完整的在途 feature,不该由修复方案代废);若废弃则 `git branch -D` + 删工作区 `面板独立窗口.bat`。
2. **M-11(inflight 每调用 2 次同步 I/O)修不修**:**推荐:不修,辩护记录在案**——inflight 文件是进程崩溃死亡证据(下次启动报丧依据),防抖/异步写会降低崩溃时报丧准确性,与微秒级收益不成比;M-10 竞态已在批2 用双清方案修复,不依赖 M-11。
3. **O1 收敛(批5)现在做还是推后**:**推荐:做完批1-4 后做**(收敛建制一次清偿 5 变体,再拖会到 6 变体);若用户想最小化风险可推后,不影响其他批。

---

## 批 1:bridge 参数守卫统一收口(H-1 + H-2)

> 根因:H-1/H-2 同源——GDScript 对 null/容器参数裸 `int()/float()` 触发 SCRIPT ERROR,同步分发无异常隔离→响应静默 `result:null`/超时。批次 C 只修了顶层 x/y。守卫先例 `_num`(`mcp_bridge.gd:2480-2485`)已存在且其注释自证此坑。

### Task 1.1:mcp_bridge.gd 守卫函数 + `_math_comp` 类型白名单

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\scripts\mcp_bridge.gd`(grep 重定位 `func _math_comp`、`func _num`)

- [ ] **Step 1:写失败的 GDScript 单测**(文件 `test/fixtures/gdscript-check/` 或现有 gdscript-unit 测试挂载点,执行时探查 `test/gdscript-unit.test.ts` 的用例注册模式后同款追加)

```gdscript
# 毒参数用例:H-1/H-2 负向锚——容器/null 分量不得触发 SCRIPT ERROR
# 经 game_write set_node_property 传 position={"x": {}, "y": 2} → 应收到 error 响应而非 result:null/超时
# 经 game_input send_input_sequence 传 {"at_frame": null, "type": "key"} → 应收到 error 响应
```
(执行者按现有 L2 契约测试形态落为可跑用例,断言=返回 error dict 且 bridge 存活)

- [ ] **Step 2:跑测试确认失败**(现状崩溃/超时即红)

- [ ] **Step 3:实现**——`_num` 旁新增(紧邻放置,注释引 2026-09-17 审查 H-1/H-2):

```gdscript
# H-2(2026-09-17 审查):int 守卫,对齐 _num 先例——仅整值/合法数字串放行,其余回 fallback。
func _int_guarded(v: Variant, fallback: int) -> int:
	if v is int:
		return v
	if v is float and is_finite(v) and v == floor(v):
		return int(v)
	if v is String and String(v).is_valid_int():
		return int(v)
	return fallback

# H-2 同款:float 守卫(直接复用 _num 即可,不新增——凡 float 裸转处改调 _num)
```

`_math_comp`(约 :1754-1764)返回前加类型白名单:

```gdscript
func _math_comp(value: Variant, index: int, key: String) -> Variant:
	# H-1(2026-09-17 审查):分量取出后必须过类型白名单,容器分量进 float() 即 SCRIPT ERROR
	# (同步分发无异常隔离→result:null)。对齐 _num 先例。
	var out: Variant = null
	if value is Array:
		var arr: Array = value
		if index < arr.size():
			out = arr[index]
	elif value is Dictionary:
		var dict: Dictionary = value
		if dict.has(key):
			out = dict[key]
	if out is int or out is float or (out is String and String(out).is_valid_float()):
		return out
	return null
```

- [ ] **Step 4:跑测试确认通过**
- [ ] **Step 5:Commit** `fix(bridge): _math_comp 分量类型白名单+_int_guarded 守卫——H-1/H-2 毒消息面收口`

### Task 1.2:替换 23 处裸转

**Files:** Modify `src/scripts/mcp_bridge.gd`(下表行号为快照,逐处 grep 重定位)

替换模式:`int(params.get("x", d))` → `_int_guarded(params.get("x"), d)`;`float(params.get("x", d))` → `_num(params.get("x"), d)`。`get` 不再传默认值(守卫函数回 fallback)。

| 组 | 行(快照) | 形态 | 备注 |
|---|---|---|---|
| int params.get | 1244/1352/2460/2502/2651/2696/3025/3226/3329/3340/3536/3635/3638/3724/3727(15 处) | `_int_guarded` | 2460/2502 index 后续还有 `_is_valid_touch_index` 校验,但裸转在先仍崩,一并替换 |
| float params.get | 1376/4064/4065/4066(4 处) | `_num` | 4064-4066 弱网注入参数 |
| `int(e["at_frame"])` | 3696 | `_int_guarded` | **最高危**:深预检首步;at_frame 非法时守卫回 0→落入既有 1-600 范围报错分支,错误消息可读 |
| `float(ev["strength"])` | 3749 | `_num`(回退 0.0) | `_process` 帧路径,崩溃会中断当帧 pending 处理 |
| `int(e["seq"])` | 3945 | `_int_guarded`(回退 -1) | seq 为内部生成可信来源,守卫属顺手纵深 |

- [ ] **Step 1:逐处替换**(分 3 个 commit:控制族/查询族/输入序列族,便于回滚定位)
- [ ] **Step 2:`grep -nE "int\(params\.get|float\(params\.get" src/scripts/mcp_bridge.gd` 确认零残留**
- [ ] **Step 3:跑 bridge 相关测试** `npx vitest run test/game-bridge.test.ts test/bridge-feedback-batch-c-contract.test.ts`

### Task 1.3:godot_operations.gd 同款收口 + add_node 静默丢弃修复

**Files:**
- Modify: `src/scripts/godot_operations.gd:58-84`(`_has_components`)、`:97-144`(`_coerce_math_value`)、约 `:549-557`(add_node `_is_safe_property` 无 else 分支)
- Modify: `addons/godot_mcp_server/commands/` 下探查是否有 `_coerce_math_value` 第三副本(`grep -rn "_coerce_math_value\|_has_components" addons/`),有则同款收口

- [ ] **Step 1**:`_coerce_math_value` 内所有 `float(...)`/`int(...)` 裸转点(分量取值后)过 `_math_comp` 同款白名单——GD 侧若无 `_num`,从 mcp_bridge.gd 复制 `_num`/`_int_guarded` 并加"Keep in sync"注释(对齐 O5 既有惯例)
- [ ] **Step 2**:add_node fallback 的 `if _is_safe_property(property):` 补 else 分支(对齐 edit_node `:619-621` 先例):`log_error` 点名被拦属性 + 响应附 `blocked_props` 警告(不判失败——节点已创建,但用户必须知道哪些属性没写上)
- [ ] **Step 3:验证** `npm run build` + `npm run check:gdscript`(**必跑**,GD 改动)+ `npx vitest run test/scene-batch-b-contract.test.ts test/gdscript-unit.test.ts`

### Task 1.4:契约测试负向断言扩全文件 + 版本 bump

**Files:**
- Modify: `test/bridge-feedback-batch-c-contract.test.ts:44-56`(负向断言从"仅扫 send_mouse_click/send_touch"扩到全文件)
- Modify: `src/scripts/mcp_bridge.gd:25`(`BRIDGE_SCRIPT_VERSION := "0.33.6"`)、`package.json`(version 同步)

- [ ] **Step 1**:负向断言改为:

```typescript
// H-1/H-2(2026-09-17 审查):守卫必须是全文件性质——批次C只扫两个函数致分量层/19处裸转漏网
const src = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');
expect(src).not.toMatch(/int\(params\.get\(/);      // 全文件禁绝 int 裸转
expect(src).not.toMatch(/float\(params\.get\(/);    // 全文件禁绝 float 裸转
expect(src).toContain('func _int_guarded');          // 守卫存在锚
```

- [ ] **Step 2**:版本 bump:`npm version patch --no-git-tag-version` + 手改 `BRIDGE_SCRIPT_VERSION` → `npm run build` → `npm run version-sync` 校验一致 → CHANGELOG 定版段 `[0.33.6]`
- [ ] **Step 3:全量门禁** `npm run lint && npm run build && npm test && npm run check:gdscript`
- [ ] **Step 4:Commit** `fix(bridge): 裸转23处全量替换+契约负向断言扩全文件+0.33.6(审查H-1/H-2收口)`

---

## 批 2:shutdown 完备性(H-3 + H-4 + M-9 + M-10)

### Task 2.1:dap 会话纳入 close()(H-4)

**Files:**
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\tools\dap.ts:130-145`(`_resetForTest` 旁)
- Modify: `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\src\GodotServer.ts`(close() safeStep 链,grep `'clearInflight'` 定位插入点)

- [ ] **Step 1:写失败测试**(新增 `test/dap-shutdown.test.ts`):创建 session(mock socket)→ 调 `closeAllDapSessions()` → 断言 `_sessions`/`_breakpoints` 清空、socket.destroy 被调。首跑失败:函数不存在(TS 编译错即红)。
- [ ] **Step 2:实现**——dap.ts 导出(核心循环与 `_resetForTest` 共用,`_resetForTest` 改为调它):

```typescript
/** H-4(2026-09-17 审查):GodotServer.close() 清理钩子——销毁全部 DAP socket 并清簿记。 */
export function closeAllDapSessions(): void {
  for (const s of _sessions.values()) {
    try { s.socket.destroy(); } catch { /* best-effort */ }
  }
  _sessions.clear();
  _breakpoints.clear();
}
```

- [ ] **Step 3:接线**——GodotServer.close() safeStep 链中(建议紧邻 `'clearInflight'` 后)加:

```typescript
import { closeAllDapSessions } from './tools/dap.js';  // GodotServer 是控制面装配层,import tools 合法(先例 :15-48)
await safeStep('closeDapSessions', () => closeAllDapSessions());
```

- [ ] **Step 4**:测试过 + Commit `fix(dap): closeAllDapSessions 导出+close()接线——socket/断点簿记不再跨实例残留(审查H-4)`

### Task 2.2:O2 归位——setOnBridgeConnected 挪入 GodotServer(H-3)

**Files:**
- Modify: `src/tools/game-bridge.ts:110`(删模块顶层副作用行,保留注释说明迁往)
- Modify: `src/GodotServer.ts`(run() 装配区,grep `setInstanceRouter` 定位同层插入点;close() finally 区 grep `setOnGroupsChanged` 定位对称清理点)

- [ ] **Step 1:写失败测试**:import game-bridge 模块后断言 `setOnBridgeConnected` 回调为 null(模块顶层不再自装配);GodotServer.run() 后非 null;close() 后复为 null
- [ ] **Step 2:实现**——game-bridge.ts:110 三行移除;GodotServer.run() 装配:

```typescript
import { launchDashboardOnce } from './dashboard/launcher.js';
import { setOnBridgeConnected } from './core/bridge-client.js';
// O2 归位(2026-09-17 审查 H-3):首连拉起 Dashboard 从 game-bridge 模块顶层副作用迁入控制面装配,
// close() 可对称清理;dashboard⇄game-bridge 的 import 链在控制面汇合,方向不变
setOnBridgeConnected(() => launchDashboardOnce());
```

close() finally 对应:`safeStep` 外直接 `setOnBridgeConnected(null);`(与 setter 两件套清理先例同款)

- [ ] **Step 3**:测试过 + Commit `refactor(game-bridge): 首连拉起Dashboard迁入GodotServer装配——close()对称清理(审查H-3/O2清偿)`

### Task 2.3:profiler 直关 + inflight 双清(M-9 + M-10)

**Files:**
- Modify: `src/GodotServer.ts`(close():`'killAllRunSessions'` safeStep 后补一步;末步再补一次 clearAllInflight)

- [ ] **Step 1:写失败测试**:ctx.functionProfiler 存活时调 close() → 断言 profiler.closed===true;close 进行中 markInflight(模拟)后 close 完成 → 断言 inflight 文件不存在
- [ ] **Step 2:实现**:

```typescript
// M-9:killProcess 5s 超时兜底路径不等 proc close 事件,profiler 的 net.Server 须直关
await safeStep('stopFunctionProfiler', () => {
  const p = this.dispatcher?.getContext().functionProfiler;
  if (p) { try { p.close(); } catch { /* best-effort */ } }
});
// ……close() 末尾(server.close 之前):
// M-10:首步清理后,close 窗口内并发工具调用的 markInflight 会重建文件,末步再清一次
await safeStep('clearInflightFinal', () => clearAllInflight());
```

- [ ] **Step 3**:全量门禁 + Commit `fix(core): profiler直关+inflight末步双清——close()窗口竞态收口(审查M-9/M-10)`
- [ ] **Step 4:批2 收尾**:CHANGELOG `[Unreleased]` 补条目;**不 bump 版本**(纯 TS,无规则模板变更)

---

## 批 3:web-gui 安全 hygiene(M-1 + M-2 + M-3 + M-4 + Low×5)

### Task 3.1:tokenEquals 恒定时间比较 + /api/auth Origin 校验(M-1 + Low)

**Files:**
- Modify: `src/web-gui/server.ts:257/316/325/394`(grep `=== this.token` 重定位)

- [ ] **Step 1:写失败测试**(扩展 `test/web-gui/server-http.test.ts`):断言 server 模块引入 `crypto.timingSafeEqual`(或行为等价:错误 token 与正确 token 的比较耗时无前缀相关性——行为级测试难写时,以源码契约断言 `expect(src).toContain('timingSafeEqual')` 兜底,注明理由)
- [ ] **Step 2:实现**——server.ts 顶部加私有方法,4 处调用点替换:

```typescript
import { timingSafeEqual } from 'node:crypto';
/** M-1(2026-09-17 审查):token 比较恒定时间——长度先守卫防长度泄露,timingSafeEqual 防逐前缀定时探测。 */
private tokenEquals(candidate: string | undefined | null): boolean {
  const a = Buffer.from(this.token, 'utf8');
  const b = Buffer.from(String(candidate ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`/api/auth` 端点(`:316` 附近)补 `if (!this.originAllowed(req, url)) { res.writeHead(403).end(); return; }`

- [ ] **Step 3**:测试过(含既有 401/403 区分用例不回归)+ Commit

### Task 3.2:health ACAO 白名单回显 + 去 startedAt(M-4)

**Files:** Modify `src/web-gui/server.ts:283-291`;Test `test/web-gui/server-http.test.ts:280`(锁定旧行为的断言同步改)

- [ ] **Step 1**:改测试先红——health 响应断言:Origin 命中 `http://127.0.0.1:<9550-9569>` 时 `access-control-allow-origin` 回显该 Origin;其余 Origin 无该头;响应体不含 `startedAt`
- [ ] **Step 2:实现**:解析 `req.headers.origin`,命中 `/^http:\/\/(127\.0\.0\.1|localhost):955\d$/` 才回显;响应体删 `startedAt` 字段(前端自愈只消费 `ok`——grep `src/web-gui/html.ts` 确认无 startedAt 消费点,有则一并改)
- [ ] **Step 3**:测试过 + Commit

### Task 3.3:READ_ONLY 跳过入口页写入 + env 开关(M-3)

**Files:** Modify `src/web-gui/server.ts:183/448/493`(三调用点收敛为一处入口判断)、`portal.ts`

- [ ] **Step 1:写失败测试**:isReadOnly=true 时 start()/scan/add 后项目目录无 `面板入口.html` 新写入
- [ ] **Step 2:实现**——`refreshProjectEntries`(`:825`)头部加:

```typescript
// M-3(2026-09-17 审查):READ_ONLY 语义不得在"向用户项目目录写文件"维度被穿透;
// GODOT_MCP_WEB_GUI_ENTRY=0 可全局关闭入口页落盘(不想被写入项目目录的用户出口)
if (this.opts.isReadOnly?.()) return;
if (process.env.GODOT_MCP_WEB_GUI_ENTRY === '0') return;
```

- [ ] **Step 3**:测试过 + Commit

### Task 3.4:rotate-token + CLI 打码(M-2)

**Files:**
- Modify: `src/web-gui/registry.ts`(导出 `rotateSharedToken()`:删 token.txt→重走 getOrCreateSharedToken 生成新值→重写包根入口页若存在)
- Modify: `src/cli/router.ts` + `src/web-gui/open.ts:67`(打码:`token=${t.slice(0,4)}****` 打印;完整 URL 已在浏览器打开无需人眼复制——保留一个 `--show-token` 显式旗标输出全量)

- [ ] **Step 1:写失败测试**:rotate 后旧 token 401、新 token 200;open 输出不含全量 token(除非 --show-token)
- [ ] **Step 2:实现** + CLI 子命令接线(`dashboard --rotate-token` 走 router.ts 既有子命令模式)
- [ ] **Step 3**:测试过 + Commit

### Task 3.5:纵深五小件(Low)

**Files:** Modify `src/web-gui/files-api.ts:138-139`(备份 icacls,调既有 `hardenFilePermissionsWindows`)、`server.ts` readJsonBody(`:377-385` 统一 64KB content-length 预检)、`server.ts:93-98`(CSP:启动时对 INDEX_HTML 内联脚本算 sha256 塞 `script-src 'sha256-...'`;补 `frame-ancestors 'none'`)、`src/dashboard/log-reader.ts:119/131`(pollTimer/watcher `.unref()`)、`registry.ts`(sweep/list 共用 `parseRegistrationFile()` 抽取)

- [ ] **Step 1-5**:逐件"失败测试→实现→过→commit"(每件独立 commit,tag 注明审查 Low 编号)
- [ ] **Step 6:批3 收尾**:全量门禁 + CHANGELOG `[Unreleased]`;真机冒烟(`npm run inspector` 或双击入口页过一遍 401→auth→files 链路)

---

## 批 4:bridge 行为对称(M-5 + M-6/O3 + M-8 + Low×2)

> 范围增补(2026-09-17 批 1 终审 I-1):addons editor 命令族 33 处同款 `int/float(params.get(...))` 裸转(animtree_commands.gd:182 / asset_factory.gd:49-79×15 / custom_meshes.gd:14-205×19 / debug_commands.gd:107/124/325 / nav_commands.gd:273-274 / test_commands.gd:108)——2026-09-17 审查 H-2 的覆盖盲区(报告只锁 mcp_bridge.gd)。风险低于 bridge(editor 常驻不挂死 + TS zod 前置),按批 1 先例建 editor 侧守卫副本 + 契约负向断言。改 addons 触发 `npm run check:gdscript`。

### Task 4.1:uninstall 判活护栏(M-5)

**Files:** Modify `src/tools/game-bridge.ts:694-702`(grep `mcp_bridge_.*secret` 的删除逻辑重定位)

- [ ] **Step 1:写失败测试**:两实例 secret 存在、一实例有新鲜心跳 → uninstall 只删无心跳端口 secret,响应点名保留项
- [ ] **Step 2:实现**——删除前调既有 `liveHeartbeatPortsFor(projectPath)`(install 侧 `:598-601` 先例),保留活实例端口;响应 message 列出已删/保留端口及警示
- [ ] **Step 3**:测试过 + Commit `fix(bridge): uninstall 判活护栏——与 install 侧 clean_stale_secrets 哲学对称(审查M-5)`

### Task 4.2:sync_state 快照 project 维度(M-6/O3)

**Files:** Modify `src/tools/game-bridge.ts:142-161`(SyncSnapshot 接口)与 snapshot/compare 实现(`:967-1034`)

- [ ] **Step 1:写失败测试**:同 label 跨项目 snapshot→compare 响应含 `cross_project: true` 且双方 projectPath 回显;同 label 不同项目覆盖时响应带警告
- [ ] **Step 2:实现**——snapshot 时记录 `getBridgeProjectDir()`+当前端口入快照;compare 两侧 projectPath/port 不一致时置警告字段(不改 diff 语义,纯增信息)
- [ ] **Step 3**:测试过 + Commit(审查 M-6/O3 清偿)

### Task 4.3:-32601 自动版本比对(M-8)

**Files:** Modify `src/tools/game-bridge.ts`(sendToBridge 错误路径,grep `-32601` 定位消费点;`sendToBridge` 在 `src/core/bridge-client.ts` 则在错误响应组装处由 game-bridge 层拦截)

- [ ] **Step 1:写失败测试**:mock bridge 返回 -32601 → 响应 error message 内嵌 `versionWarning`(自动补发一次 ping 比对)
- [ ] **Step 2:实现**——game-bridge 层收到 -32601 时 `sendToBridge('game_query', {method:'ping'})` 比对 BRIDGE_SCRIPT_VERSION,把既有 versionWarning 逻辑(`:100-105`)的结果拼进错误文案
- [ ] **Step 3**:测试过 + Commit

### Task 4.4:TOCTOU 单次解析 + lastSeen 毫秒决胜(Low)

**Files:**
- Modify: `src/core/bridge-client.ts:334-446`(`_doConnect` 先解析 port 一次,secret 读取改 `bridgeSecretPathFor(_projectDir, port)` 显式传参)
- Modify: `src/scripts/mcp_bridge.gd:876`(心跳时间戳加毫秒:`Time.get_datetime_string_from_system()` → 拼 `Time.get_ticks_msec()` 或 ISO+ms 形态)+ `bridge-client.ts:134-139`(同秒时以 pid 决胜)

- [ ] **Step 1-4**:各"失败测试→实现→过→commit";GD 改动触发 **BRIDGE_SCRIPT_VERSION bump**(0.33.6 之后顺延 0.33.7)+ `npm run check:gdscript` + version-sync
- [ ] **Step 5:批4 收尾**:全量门禁 + L2 e2e bridge 套件(`npx vitest run test/e2e-bridge-*.test.ts`,需 GODOT_PATH)

---

## 批 5:O1 哨兵延迟通道收敛(独立重构,M-7)

> 前置:批1 已合并(同文件)。这是行为敏感重构:动 `_handle_message` 识别分支、`_pending_*` 五变量、`_process_buffer_bytes` 消费 if 链(`mcp_bridge.gd:97-103/77/1189-1211/995-1054`)。**必须有 L2 e2e 全量护栏才动**。

- [ ] **Task 5.1:写守恒测试**——5 条延迟命令(call_method/click real_event/step_until/input_sequence/playtest_step)各一条 e2e 用例,断言延迟响应语义不变(这是重构的安全网,先于任何重构落地)
- [ ] **Task 5.2:实现单例槽**——`var _deferred: Dictionary = {}`(键:`{"kind": String, "id": int, "payload": Dictionary}`);5 个 `_pending_*` 变量删除;handler 返回哨兵 dict 统一为 `{"__deferred__": kind}`;`_handle_message` 识别单键;`_process_buffer_bytes` 消费端 switch kind 分派到原 5 个消费函数体(函数体不动,只改挂载方式);`_last_step_request_id`(`:77`)并入 payload
- [ ] **Task 5.3:验证链**——`npm run check:gdscript`(必)→ 全量 `npm test` → L2 e2e 全量 → BRIDGE_SCRIPT_VERSION bump + version-sync + CHANGELOG 定版段
- [ ] **Task 5.4:第三方审查**——按 AGENTS.md「plan 落地后必出第三方审查文档」派 code-reviewer 独立审查,报告落 `docs/reviews/`

---

## 批 6:工程卫生(chore)

- [ ] **Task 6.1**:`.gitignore` 追加 `面板独立窗口.bat` 与 `.playwright-mcp/`(决策点 1 裁决后若废弃 app-window 分支,bat 直接删;若合并则该文件进 git 由分支带来,gitignore 只补 `.playwright-mcp/`)
- [ ] **Task 6.2**:删除 19 个已合并分支(用户确认后):`for b in $(git branch --format='%(refname:short)' | grep -v master); do git merge-base --is-ancestor "$b" master && git branch -d "$b"; done`
- [ ] **Task 6.3**:README 安全章节补 web-gui 姿态陈述:默认启用(`GODOT_MCP_WEB_GUI=0` 关闭)、监听 127.0.0.1、token 位置与 rotate-token 命令、files API allowlist deny-by-default——一段话+指向 docs
- [ ] **Task 6.4**:CHANGELOG `[Unreleased]` 收口;组合根外 import 口径已在 2026-09-17 审查报告§观察项3 修正,历史报告不改(快照原则),无代码动作

---

## Self-Review 记录

- **覆盖核对**:H-1(批1)/H-2(批1)/H-3(批2)/H-4(批2) ✅;M-1~M-4(批3)/M-5~M-8(批4,其中 M-6 即 O3、M-7 即 O1)/M-9~M-10(批2)/M-11(决策点 2 辩护不修) ✅;Low 并入:web-gui 5 件(批3 Task3.5)、add_node(批1 Task1.3)、TOCTOU/lastSeen(批4)、分支卫生(批6);未列入修复的 Low(process-state 复位/_failedPorts close 清/pid 复用/saveText TOCTOU/CSP 已在 3.5)均有审查报告"辩护理由在案"或随批3 覆盖。spec 30 条发现全部有归属。
- **占位符扫描**:Task 1.1 Step1 的测试挂载点标注"执行时探查现有 gdscript-unit 注册模式"——这是探索指令非占位符(具体注册形态随仓库演进,锁定反而漂移);其余 task 均给出代码块或精确模式。
- **类型一致性**:`_int_guarded(v, fallback: int) -> int`/`closeAllDapSessions()`/`tokenEquals(candidate)`/`rotateSharedToken()` 各 task 间无交叉引用冲突。
