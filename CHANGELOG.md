# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed — editor debug 一次性 stack_dump 信号错过致 frames 恒空(issue #63)

- **根因(4.7 源码实证 + 本地确定性复现)**:Godot 4.7 起 `ScriptEditorDebugger._parse_message` 为 handler-map 优先——`stack_dump`/`stack_frame_vars` 等内置消息走内置 handler,**不再进入 `plugins_capture`**,`debugger_bridge.gd` 的 `_capture` 权威路径对这些消息恒不触发;frames/vars 唯一来源退化为面板信号兜底(`_on_panel_stack_dump` 等)。而引擎只在 break 瞬间请求一次 `get_stack_dump` → 面板只 emit 一次 `stack_dump` 信号:**若此刻 `ensure_connected` 尚未连接面板信号**(play 返回到首次 stack_trace 轮询之间的窗口;CI editor 首次导入期首个请求可延迟数秒,晚于游戏起跑),信号永久丢失,frames 恒空直至 continue 触发新 break——`waitForBreaked` 只能超时,快照 `breaked:true, frames:[]`。weekly run 32609819861(2026-08-23)即此模式;同代码次日重跑全绿(run 32627102577)= 间歇性时序竞态。
- **修复(两层防御)**:① 层 2 防错过——`_toggle_breakpoint`(set_breakpoint 是 play 前最后一步)成功路径提前 `ensure_connected()` 连接面板兜底信号,把错过窗口压到 play 之前;② 层 1 自愈——`debugger_bridge.gd` 新增 `refetch_stack(state)`:`handle_stack_trace`/`handle_inspect_frame` 在 `breaked && !has_stackdump`(错过症状)时经 `session.send_message("get_stack_dump")` 主动补拉(游戏 break 循环内处理,无副作用;回包后面板再次 emit stack_dump,已连接的兜底信号接住;settle 700ms 自然节流,不做每周期一次限制以保证"首次补拉时信号仍未连上"场景下次调用继续自愈)。inspect_frame 同步受益(select_frame 依赖面板栈 Tree 由 stack_dump 驱动填充,frames 空则必败)。
- **验证**:新增 e2e 用例 4「错过窗口回归」确定性复现(play 后刻意 8s 不发任何查询再首查)——修复前必红且失败快照与 CI 逐字节一致(`breaked:true, frames:[]`),修复后绿(frames 含断点行落点);反向验证通过(回退修复→用例红→恢复→绿,非接线零验证)。本地 4.7.1 e2e 4 用例全绿(链路 3.3s 反而快于修复前 4.5s,提前连信号消除 settle 等待);`npm run check:gdscript` 零错;lint/build/test 全绿(6147 passed)。

## [0.32.11] - 2026-08-21

### Fixed — CI e2e 文件级并行竞态(端口随机化暴露)

- **ci.yml e2e 步骤加 `--no-file-parallelism`(文件级串行)**:full-tool(L2 recording)/get-node-layout/resilience 三文件共用 real-project——并行时 get-node-layout 的 beforeAll `rmSync(.godot)` 会删掉旁侧实例已写好的 bridge secret;且 PR#57 端口随机化后,TS 侧在 CI(registry 未命中)按 secret 文件扫描发现端口,双 bridge 实例并行时 secret/端口串门致 `run_project` 的 `wait_for_bridge` 失败。master run 32485788334 两连红同一用例(4.6.3 job),同一代码 PR#58 分支 run 全绿 = 时序竞态非代码回归;PR#57 之前 GD 确定性绑 9081 恰好掩盖此竞态。本地(Windows+4.6.3)同文件清单串行模式全绿 + 单用例复现正路径绿。PR#57 披露的残留缝隙(实例级隔离靠 auth 兜底)不变,本条只消除 CI 并行竞争窗口。

### Fixed — 反馈四坑之三收口(2026-08-19 CardGame2 全量走查反馈,2026-08-21 批;坑 1 button 语义已随 0.32.10 批 2 修)

- **find_nodes 消费 root 参数(坑 2)**:`_cmd_find_nodes` 此前忽略 root(传子树根仍从 /root 全树搜返回无关节点)——现按 root 限定 `_traverse_tree` 起点(推荐绝对路径);无效 root 报结构化错误(-7 Root node not found)而非静默全树。
- **install_override 插入 [autoload] 段末尾(坑 3)**:autoload 声明顺序即 _ready 执行顺序,段头插入曾致 override _ready 先于游戏单例(如 GameData)初始化得 null,须手动 `await <Singleton>.ready` 兜底且文档未说明——现插段末尾(游戏 autoload 之后,_ready 可直接访问游戏单例);工具描述/安装响应明示插入位置;多次安装保持顺序;EOF 无尾换行兜底。
- **call_method 协程双模式(坑 4)**:callv 对协程方法在首个 await 挂起并返回 GDScriptFunctionState(内部类型,`is` 类型名不可解析,经 get_class() 字符串判定;4.5.1/4.6.3/4.7.2 三版探针实证),此前被 _jsonify 序列化为无用信息、AI 误以为拿到返回值——现默认返 `{coroutine:true, result:null, note}` 显式标记;`params.await_completion=true` 走哨兵延迟响应(`await callv` 等真值后推送,形态统一 `{result, undoable, awaited:true}`;非协程穿透立返;peer 断开丢响应/节点失效守卫;长协程由 TS 侧 timeout 兜管)。
- 测试:契约 7 用例(bridge-feedback-pits-contract)+ overrides 顺序单测 3 例 + **行为级 e2e 6 例真机全绿**(find_nodes 子树限定/全树回归/无效 root/协程默认标记/await 真值 33/非协程统一形态);CMP-9B 契约切片改函数边界(固定 3200 窗口脆性);fixture probe 补 slow_add 协程探针 + mcp_bridge fixture 拷贝随批刷新(A2 托管语义:内容不同不覆盖)。

### Fixed — 端口竞态缓解落地(2026-08-21 裁决;批 2 open 项收口)

- **`_bind_available_port` 默认场景起始候选随机化**:env `GODOT_MCP_BRIDGE_PORT` 未指定时起始候选 = `PORT_DEFAULT + crypto 随机 % PORT_ATTEMPTS`(env 显式指定保持确定性)。实测:无缓解时双实例同瞬 spawn 20 轮 **18 轮双 bind 假成功**(双方都从 9081 起步是碰撞主因);随机起点后 50 轮竞态命中 **2(≈4%)**,撞端口率 ≈10-15% 符合理论值且大部分被探测+递增避让消化。随机源用 `_crypto.generate_random_bytes` 而非 `randi()`——`playtest.seed` 锁全局 randi/randf,双实例同 seed 时 randi 同值随机化会失效。
- **危害重估(降级)**:连错实例会被 auth 拒(secret 每实例密码学随机 + 严格本实例比对)——危害=显式 auth failed 需重跑(可用性),**非静默错连**(无数据安全问题),auth 是语义防线;且 qa nightly 为串行循环,实际触发面为多进程并行+毫秒级同瞬。非根治定位如实保留(1/PORT_ATTEMPTS 概率仍可命中,由 auth 兜底)。**残留缝隙(审查 Important-B,与碰撞类不同)**:TS 侧 registry 不可读/漂移时回落 9081——随机化后 GD 约 90% 场景不在 9081,该回落从「无害」退化为「连不上」(触发面=Linux/macOS 显式 XDG_DATA_HOME 漂移等 registry 故障,桌面三平台基本可靠)。
- 契约测试 3 用例(`test/port-race-mitigation-contract.test.ts`:随机化分支存在/禁 randi·randf/env 优先)+ 审查处置:环形取模保候选恒为 9081-9090(Nit-A 窗口漂移)/registry 回落措辞与残留缝披露(Nit-B)/批 2 审查文档带入本分支(Important-D 死链)/三处 9081 文案同步(game-bridge 提示+resources);check:gdscript 零错;全量 6082 passed。


## [0.32.10] - 2026-08-21

### Fixed

- `check:modules-sync` 修复架构审查 D-2 漏改的旧路径(仍指 `src/core/module-loader.ts`,实际已移至 `src/module-loader.ts`)+ import 深度正则与 `generate-all-modules.mjs` 对齐(兼容 `./tools/`)——此前该检查必挂,推上 CI(`ci.yml` 跑此检查)必红;`check:tool-groups` 失败消息中的旧路径同步更正。(业务流程复跑发现,2026-08-21)

### Changed — 审查修复批 1:测试基建(2026-08-20 六专项审查 G-1/G-2/G-4 处置;plan `docs/superpowers/plans/2026-08-21-audit-fixes-master-plan.md`)

- **弱断言还债 860→732(测试G-1 P1)**:防恶化门禁顶格 860/860 零余量(两次复发前科 2b4bc8c/f5e3a8e),本批恢复 **128 预算**。113 处布尔表达式 `toBeTruthy()` 机械强化为 `toBe(true)`/`toBe(false)`(表达式含严格 boolean 信号:比较式/some/every/includes/existsSync 等)+ error-analyzer 15 处 `hasErrors` 布尔字段断言手工强化;2 处替换脚本误改人工修正(qa-index 泛型尖括号误命中判据→`toHaveProperty`;ui-import `find()` 返元素对象→改 `some()` 语义等价强断言)。B 类 83 处(访问前置)与 C 类 657 处(存在性语义)显式不动——达标即止,避免大面积分散改动引入新风险。
- **e2e workflow 非空执行守门(测试G-2 P2)**:vitest 全 skip 返 exit 0(实测 total=2/pending=2 仍 0),fixture 供给链断掉时 e2e 假绿数月无人察(C5 家族)。`ci.yml` matrix e2e 步骤后加单行 gate(对齐 gdscript gate 范式,断言 `numTotalTests>0 && numPendingTests<numTotalTests`);`editor-e2e.yml` 5 个 vitest 步骤后加同款 gate(upload artifact 前)。判据红绿两态实测:正常报告 PASS exit 0/全 skip 报告 FAIL exit 1;YAML 语法 pyyaml 校验通过。
- **mock-results 工厂编译期锚定(测试G-4 P3)**:`test/helpers/mock-results.js`→`.ts`,六工厂 import 真实类型(`ExecuteGdscriptResult`/`SpawnResult`)+ `satisfies` + `Partial` 参数 excess check;配套 `tsconfig.test.json` + `npm run typecheck:helpers` + ci.yml check job 接线——**防假接线**(test/ 不在主 tsconfig、eslint 只查 src、vitest esbuild 只剥类型不检查,单纯 satisfies 无人消费)。反向红测实测:接口外字段 `_probe` → TS2353 + exit 2。20 个消费文件 import 路径零改动(vite .js→.ts 解析,三类消费文件 84/84 验证)。**锚定边界(部分解决)**:接口加/删/改**必选**字段才红,可选字段(如 `autoload_detected?`)不触发;消费文件内联极简对象(不走工厂)仍无锚定。

### Fixed — 审查修复批 2:GD bridge 对称性(2026-08-20 专项审查 审查G-1/G-2/G-3/可靠性P2/F-4 处置;plan `docs/superpowers/plans/2026-08-21-audit-fixes-master-plan.md` 批 2 段)

- **`_compare_values` 数值分支类型白名单(审查G-1 P2)**:target 非数值(int/float 外)return false,对齐 Vector 分支的 N-1 修复——防 String 条件值经 `float("abc")=0` 静默按 0 比较致 `step_until` 假阳性 PASSED(比 N-1 修的假阴性更隐蔽)。
- **freeze 入口 pending 守卫(可靠性 P2)**:开窗期间(input_seq/step_until in flight)并发 freeze 拒(对齐 step 的 D-6 范式)——防 bridge PROCESS_MODE_ALWAYS 下帧照走事件照注入(游戏不消费)的时间线假成功。
- **mouse button 语义 + 深预检扩展(审查G-2 P3)**:新增 `_mouse_button_from_value`(int 1-9 直通/left/right/middle 映射/非法 -1),底层 `send_mouse_click` 与 timeline 深预检同享——`button:"left"` 不再 `int()=0=MOUSE_BUTTON_NONE` 注入无效事件仍报 success;touch/drag 深预检 `index` 非负整数。
- **isq_result 补 `all_applied` 诊断字段(F-4 Nit)**:部分事件 ok:false 时 success 仍 true(截断语义只看 wall_timeout),加 `.all()` 折叠字段一眼区分全量/部分注入,不改 success 判定;qa runner 截断诊断同步透传。
- **coerce String 数值严格判定(审查G-3 P3)**:TYPE_INT/TYPE_FLOAT 的 String 分支改 `is_valid_int()/is_valid_float()` 严格判定——裸 `int()` 部分解析("5px"→5)/失败零值("abc"→0)消除,非法保留原值由类型不匹配显式暴露。
- **端口竞态实测归档(open,修复被证伪回退)**:双进程同瞬 spawn 20 轮 **18 轮双 listen OK**(Windows 双 bind 假成功坐实,远超预估);「listen 后回探自连判属主」修复真机证伪(双属主 15/20 与零属主 6/6 两态漂移)已回退,`_bind_available_port` 注释留实测事实+候选缓解(起始候选随机化);途中抓到 TCPServer 无 poll() 方法(check:gdscript 逐文件 parse 查不出运行时方法存在性)。
- **测试**:契约 12 用例(`test/gd-symmetry-contract.test.ts`,sliceBetween 正负断言,删守卫红测实验双红实证 G-1a/P2a)+ 行为级 e2e 4 用例真机(`test/e2e-gd-symmetry.test.ts`:String value 假阳性回归/数值正向不误伤/button:"left" 映射 1/button:"abc" 结构化拒;freeze 守卫单连接 _sendLock 下行为不可达,契约级覆盖诚实标注)+ 既有 input_sequence e2e 6/6 回归 + 全量 6091 passed。


### Fixed — 审查修复批 4:安全+隐私+杂项清挂账(2026-08-20 专项审查 安全P3-1/2/3、隐私P2/P3/Nit、审查F-3、claudemd 挂账处置;plan `docs/superpowers/plans/2026-08-21-audit-fixes-master-plan.md` 批 4 段)

- **zip-extract 拒 NTFS 交替数据流(安全P3-1)**:`assertSafeEntryName` 补基名含 `:` 拒——`foo.txt:ads` 原可过全部校验,win32 `writeFileSync` 落 NTFS ADS 隐藏流(经典恶意载荷藏匿位)。负向 4 形态用例(foo.txt:ads/dir/hidden:stream/plain:colon/a:b:c)全拒,正向回归不破。
- **web serve 仅 SVG 响应加 CSP(安全P3-2,方案修正稿)**:原待办草案「统一加 `default-src 'none'`」会**弄坏 Godot Web 试玩**(导出 index.html 需同源 js/wasm)——修正为仅对 `image/svg+xml` 响应加 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,封「直接导航 SVG URL」的同源脚本执行面;真 HTTP 往返断言 SVG 带 CSP/index.html/pck 不带。
- **qa readReport 过 realpath(安全P3-3)**:前缀检查前先过 `realpathSync`(dir 对称)——qa-reports 内预置 symlink 指向外部文件可绕字符串前缀比对读任意 JSON;symlink 负向用例实证(本机 symlink 可用,非 skip 假绿)。
- **代理披露实测订正(隐私P2)**:三处(telemetry.md/README 双版)「fetch 遵守 HTTP_PROXY/NO_PROXY(Node 默认 trustEnv)」被实测证伪——Node 原生 fetch(undici)**默认不读**环境代理变量(实测:必拒代理端口下 fetch registry.npmjs.org 仍直连 200;≥24 可 `NODE_USE_ENV_PROXY=1` 启用)。`NO_PROXY` 从「零外传手段」清单移除(声称有遮蔽手段实际没有,误导企业代理与隐私敏感用户);行号漂移订正(src/index.ts:125-133 → :152-153);ToolDispatcher.ts:501 注释 `~/.godot/mcp/` 笔误改 `~/.godot-mcp/`(telemetry/config.ts:12 实证)。
- **CLI 下载链披露补齐(隐私P3)**:telemetry.md 新增「非 telemetry 外传点:CLI 下载链」段——`install`/`web` 的 GitHub releases 下载(api.github.com + 自定义 UA godot-mcp-enhanced-installer,域名白名单+SHA512 同源+y/N 确认+审计仅本机+GODOT_MCP_INSTALL_TAG pin);README 双版各补一句指向。
- **zip-extract 死赋值(审查F-3)**:zip64 extra field 末字段 `q += 8` 删(无后续消费),lint 恢复 0 warning。
- **claudemd-builder 旧工具名清理(挂账)**:`capture_screenshot` → `screenshot(action="capture")`(与 0.32.9 批 P3-1 同点修复,合并取规范形态)(批 1 B-1 挂账,merged 架构改名残留最后一处 src 残留);改动触发 rules-version-bump 硬门禁(check-rules-version-bump.mjs:18 纳入 claudemd-builder.ts),按 N-C 例外条款照常 bump **0.32.10**(原定终态 0.32.9 已被同日七维度审核批用掉,版本终态后移)+ version-sync + 本定版段 + README 版本行(npm publish/tag 待用户)。

### Fixed — 合并善后与批 3 处置

- `e2e-gd-symmetry.test.ts` import 补跟 module-loader 移位(仍指 `src/core/module-loader.js`,套件级 Cannot find module 失败;audit-2 分支自建文件基于移位前 master,合并 master 后暴露)。
- **批 3(`fix/audit-3-cli-args` = d20b1ff)处置**:CLI 参数双形式(init --template/qa --project/skills --target)已随 0.32.9 七维度审核批(P2-7/8/9/10)等价合入;独有内容(in-flight 计数器根治 setBridgeProjectDir 恒误报、`test/cli-args.test.ts`、qa parseFlag 收敛)已移植,分支废弃删除——本版本不含独立批 3 段。


## [0.32.9] - 2026-08-21

### Fixed — 架构审查修复批补登(deffcc6 / a7d865d / 0becdfe,2026-08-21 全仓架构师审核产出)

- **deffcc6(A/B 组)**:未知 CLI 命令显式报错退出(此前静默挂起等 stdin);zip 解压流式化(~1GB export templates 不再整体读入内存,低内存机 OOM 修复);web 静态服务器安全加固(仅绑 127.0.0.1/Host 校验防 rebinding/仅 GET/HEAD/路径校验下沉 resolveWithinRoot/nosniff)。
- **a7d865d(C 组)**:bridge 客户端下沉 `src/core/bridge-client.ts`;CLI 子命令收敛 `src/cli/bridge-session.ts` 会话链(装 bridge → run_project → teardown);eslint 分层门禁(`src/core/**` 禁止 import tools,no-restricted-imports 机械强制)。
- **0becdfe(D 组)**:15 客户端适配器工厂折叠(json-adapter 统一 detect/isConfigured/configure);module-loader 移位组合根;game-templates manifest 双向对账测试守护。

### Fixed — 七维度审核修复批(全仓功能/业务全方向审核;报告 `docs/reviews/2026-08-21-seven-dimension-audit.md`,6 P1 + 12 P2 + P3)

- **P1-1 help 工具 enum 动态化**:`TOOL_NAMES` 从硬编码 38 名单改为 tool-registry 注册表动态构建——原漏 `analysis`/`audit`/`debug`/`engine`/`qa`/`translation`/`uid` 7 个新工具,inputSchema enum 直接拒绝其 help 调用(docs/tools/ 文档存在却不可达);顺带清理 TOOL_META 的 4 个 v0.18 merged 旧工具名残留(`getAllToolNames()` 49→45,不再污染 `isKnownTool`/动态注册判定;旧名映射职责归 `LEGACY_TOOL_MAP`)。
- **P1-2 recording 规则通篇旧 action 名更正**:分发模板与 `.claude/rules/` 双副本的 `recording_*`(17 处)全部更新为 `runtime(action="record_*")` 新名——按旧规则调用必被 enum 拒绝;`STRICT=1 check:rules-sync` 此前绿(双副本一致地错),本次同步修正。
- **P1-3 CHANGELOG 补登**:即本段(架构批 3 commits 此前漏登,违反 2026-08-19「默认不发版,变更进 [Unreleased]」定规);[Unreleased] 空段置顶修正段序(Keep a Changelog)。
- **P1-4 README bridge 协议更正**:`game_bridge_install` 从误标"WebSocket 服务端"更正为"TCP 服务端(NDJSON 协议)"(WebSocket 是 editor 层另一套)。
- **P1-5 分发模板 editor 端口 13100 清除**:三处错误端口(实际 `BASE_PORT=9090`,被占递增至 9094;同文件自相矛盾且随 agentsmd 分发扩散);"Bridge TCP 一次性连接"过时措辞更新(现为持久连接 + 30s keepalive + 订阅断线重发);bridge 段"端口冲突需手动改脚本"更新为自动递增避让 + `GODOT_MCP_BRIDGE_PORT`。
- **P1-6 bridge-session 补单测 + 假就绪文案修复**:`test/bridge-session.test.ts` 锁定 install 判定子串与 "Bridge ready" 契约(接线零验证);`runtime` run_project 在 `wait_for_bridge=false` 时不再无条件宣称 "Bridge ready."(该子串是 bridge-session/qa-runner 的 load-bearing 判据)。
- **P2 组(CLI 参数/可靠性/安全纵深)**:CLI 参数双形式统一——`init --template`/`qa --project`/`skills --target` 此前各只认一种形式致参数静默丢失/装错目录,`args.ts` 扩为完整版(补 `hasFlag`/`num` range),五命令(gif/web/qa/init/skills)统一消费;MCP server 进程加 `unhandledRejection`/`uncaughtException` 全局兜底(此前任一 floating promise 直接 crash 长驻进程);重连后项目校验 promise 链补 `.catch`(现实引爆点);qa teardown 补 `playtest.unfreeze` 兜底(freeze 后 abort 不再残留外部游戏永久暂停);zip 解压读侧强校验(inflate 累计超声明 uncompressedSize 立即断流,不再写满盘后才比对);editor WebSocket `listen` 前端口 connect 预探测(对齐 bridge 侧双 bind 假成功缓解);工具层 PII——catch-and-return 路径不再直泄 `err.message`/绝对路径(runtime-assert 顶层兜底走 `classifyError.safeMessage`、qa 报告/截图/目录错误回显文件名或用户原始输入);web-server `[::1]` Host 解析修复(原为死代码)+ 目录跳 index.html 后复过 `resolveWithinRoot`;bridge auth 被拒(secret 不匹配)立即失败不再干等超时;`game-fs` user:// 相对路径补段级 `..` 拒绝;spawn-helper 异步 spawn 错误补 `SPAWN_FAILED:` 前缀(与同步路径错误分类一致);`validate_scripts` 文档措辞更正(逐文件 parse,非项目级完整编译——README/migration/AGENTS 与 2026-08-01 教训记录对齐)。
- **P3 组**:claudemd 分发副本 `capture_screenshot` 旧名残留清零(改 `screenshot(action="capture")`);规则模板 `node_create_3d`/`physics_raycast`/`scene_commit` 旧调用名更新;`test/cli/router.test.ts` 硬编码子命令清单改 import `SUBCOMMANDS` 单一真相源;`test/game-bridge.test.ts` 头部旧行号注释更新(实现已下沉 core/bridge-client.ts);覆盖率阈值上调至实测值-4%(statements 60→76/functions 69→79/lines 61→77,原滞后 ~20%;branches 实测未取保守不动)。
- 版本号由规则模板变更硬门禁强制 bump(recording/端口/旧名修正触发);npm 发版待用户定夺。

## [0.32.8] - 2026-08-20

### Added — 确定性完全体批(护城河研究 H1 + 叙事正名;报告 `docs/research/2026-08-20-护城河方向研究.md`)

- **`send_input_sequence` 帧定时输入时间线(bridge `game_input` 第 7 个方法)**:`timeline=[{at_frame:int(1-600,开窗后第 N 帧注入), type:"action"|"key"|"mouse_click"|"mouse_move"|"touch"|"drag", ...事件参数}]` + `settle_frames`(0-600)+ `wall_budget_ms`(clamp 1000-50000,D-5 同款)。**延迟响应**(step_until 同款哨兵+pending 通道,登记帧不计数);**owner 互斥**同 control 层(第 4 处校验);**frozen 状态下自动开窗播放、完成后 refreeze**(与 `playtest.freeze` 无缝组合);注入直接复用 `_cmd_send_*`(自带校验,零重复),action 类型走 `InputEventAction`;**深预检 all-or-nothing**(key 可解析/`InputMap.has_action` 存在性/at_frame 范围/类型集合/事件数 ≤256),运行时注入错误记 `applied` 如实上报不中断;响应含 `applied_count/total_events/frames_elapsed/wall_timeout/refrozen`。与 `playtest.seed`/`fixed_delta` 组合达成 **L3 真确定性完全体**(seed 锁随机+时间线锁输入+快照恢复)——竞品最高仅 L1(固定帧 step 无 RNG 锁)或 L2(输入时序无暂停/seed),详见 README「确定性分级」表。
- **超时接线(两处同款)**:game 工具 `game_input` 与 qa `input` 步骤对 `send_input_sequence` 未显式传 timeout 时按 `wall_budget_ms+10000` 自动放宽(60s 硬钳)——默认 10s/30s 会先于延迟响应超时致响应丢失。
- **qa 接线**:`QaStepSchema` input 枚举加 `send_input_sequence`(freeze→input(send_input_sequence)→step_until→assert 编排成立)。
- **README 叙事三连(N1/N2/S1,中英双版)**:①「AI 游戏开发的持续验证管线」定位(竞品押 authoring,本项目押 verification);②「确定性分级」表(L1 帧步进/L2 输入时序/L3 真确定性,回应竞品 "Deterministic" 术语挪用——无 RNG 锁定的帧步进不可复现);③ editor undo 叙事(8 命令模块 45 处 `create_action` 注册,核查命令随文,同赛道最宽)。
- **测试**:18 单测+契约(`test/game-bridge-input-sequence.test.ts`:方法集/schema/qa 枚举正负向/GD 关键结构文本契约——dispatch 注册/owner 互斥第 4 处/at_frame 下限/深预检/D-1 双路径清理/双开窗者互斥还原计数锁定)+ e2e 6 用例真机全绿(`test/e2e-bridge-input-sequence.test.ts`,L2 opt-in;fixture `test/fixtures/input-seq-e2e` 探针记录 `first_seen_frame` 锚定帧对齐——press 被游戏读到/release 生效/refrozen/非 frozen 直播/wall_timeout 截断/三类负向预检拒绝)。
- **第三方审查处置**(SHIPPED WITH NITS,报告 `docs/reviews/2026-08-20-input-sequence.md`):**I-1 已修**——qa input 步骤显式判 result 层 `success=false`(延迟通道 wall_timeout 截断不走顶层 error promote,只查顶层 error 会把截断报 PASSED 的假绿)+ detail 改 `condense(resp.result)` 暴露诊断;**N-1 已修**(schema 补 settle 0-600/wall 1000-50000/事件≤256 范围);**N-2 已修**(还原条件计数断言锁 2 处,防 `includes` 对相同字符串只锁任一);**N-3 已修**(e2e 新增 wall_timeout 正向场景:超长 timeline+1s wall 截断,真机断言 success=false/wall_timeout=true/applied_count=0);**N-4 已修**(`computePlaytestTimeoutMs` 扩展覆盖 send_input_sequence(wall+10s/上界 65000),game_input 与 qa input 两处内联公式收敛删除,附档位行为测试)。审查两条工程教训见 memory:延迟通道响应的 success 语义断层、includes 契约计数盲区。
- **修复 CLI qa opsScript 路径 bug**(demo 套件暴露的既有缺陷):`src/cli/qa.ts` 的 `join(__rootDir,'scripts',...)` 在开发态与 npm 态都不存在(根 `scripts/` 是构建脚本目录无 `.gd`;`package.json` files 的 gd 在 `build/scripts/`)——CLI `qa run/nightly` setup 阶段「Bridge script not found」恒失败。改为 `build/scripts/` → `src/scripts/` 探测式解析。
- **新增确定性 playtest 演示套件** `docs/demo/deterministic-playtest.qa.md`(qa-spec 围栏,一条命令复现):freeze→帧定时输入时间线→step_until→node_state 断言→unfreeze 的 L3 闭环;实测两跑均 5/5 PASSED + `qa diff` 零回归(同 seed+同时间线 ⇒ 状态演化一致),为 README「确定性分级」表的可运行注脚与 gif 录制素材。
- **push 前完整第三方审查**(SHIPPED WITH NITS,报告 `docs/reviews/2026-08-20-input-sequence-full.md`,审查者含 Bash 全命令真机复跑+删守卫红测实验):上轮 I-1/N-1~N-4 处置复核无虚报(两项红测验证断言真锁行为);N-4 收敛对即时方法与 master 逐字等价证明;npm pack 实证 CLI 路径修复在发包态命中;**IMP-1**(CLI qa run 残留 fixture [autoload] 段,既有缺陷被 demo 放大)以文档提示处置(代码侧自动还原会误删用户自装 bridge,不可取);N-A(e2e 计数 5→6)/N-B(NVIDIA 驱动日志目录 gitignore)已修;N-C(「默认不发版」vs 模板 bump 硬门禁的规则冲突)留用户裁决。
- 版本号由规则模板变更硬门禁强制 bump(bridge rule 双副本加 `send_input_sequence` 行,`check:rules-sync` STRICT 通过);npm 发版待用户定夺。

### Added — 小白一条龙批 5:game-wizard 向导(收官批,六批全落地)

- **`skills/game-wizard/SKILL.md`**(第 7 个打包 skill,双副本分发):四档分诊(没想法/模糊/清晰/已有项目)→ 阶段机 S0-S5(环境→造→改玩法→**qa 硬门**→导出→分享);**gate 以 qa CLI 退出码为唯一真相**(0=全 PASSED 才放行——「不问文档写了吗,问游戏跑通了吗」,对标 CCGS gate-check 的文件存在检测);改玩法纪律「GDD→调参表→代码」(能改 `tuning-src/*.csv` 不写码);非 Claude Code 客户端触达(`--target` 项目级安装 / `GODOT_SKILL_LIBRARIES` load_skill 检索 / 纯 CLI 序列直跑);首跑冷启动预热规则内置。
- **不新增 MCP 工具**(SKILL.md 形态,零版本门禁);`skills install` 分发扫描自动识别(实测 listPackagedSkills 第 7 项)。
- **端到端小白旅程实走(Windows+4.7.2,按向导阶段机)**:S1 `init --template=snake` → S3 qa 首跑冷启动 15.4s skipped(按向导规则预热复跑)**exit=0,7/7 PASSED** → S4 EXPORT OK + serve 200 → S5 GIF 95KB 12 帧;S2 调参链路由批 3 CSV↔tres 对应测试+`csv_to_resources` 工具承担(诚实标注:端到端沿用默认参数)。录屏属人工步骤,以 GIF 产物+本记录代素材(业务线教程素材待人工补录)。
- README/README.en 向导段(roadmap 收官注记:六批全落地)。

### Added — 小白一条龙批 4b:Web 试玩闭环(spec B-2 处置落地)

- **CLI `web <project> [--port N]` + `web --serve-only <dir>`**(router 加路由,参数双形式):findGodot → detectGodotVersion → export templates 检测/安装(y/N 确认,首次 ~1GB)→ ensureWebPreset(项目无 export_presets.cfg 时生成最小 Web preset)→ headless `--export-release`(官方路径,绕开 editor stub,超时 300s)→ 确认起服 → 打印 `http://127.0.0.1:<port>/`;Ctrl+C 优雅关服。
- **export templates 安装复用批 2 信任链**(tpz 同为官方 GitHub releases 资产:域名白名单/SHA512 同源/失败审计);安装位置 `export_templates/<ver>.stable/`(模板文件直接位于版本目录下,无中间层——本机 4.6.2 结构为证);**web 模板检测双形态**(≤4.5 裸 wasm / 4.6+ web_release.zip)。
- **零依赖静态服务器** `src/cli/web-server.ts`:仅绑定 127.0.0.1;路径穿越防护(decode 后校验绝对路径/`..`/盘符/反斜杠/normalize 越界全拒);MIME 表(html/wasm/pck/js/png/svg/woff2 等);405/404/403 语义;目录自动落 index.html。
- **真机端到端四连修(Windows + Godot 4.7.2)**:①官方 tpz 是 **zip64**——zip reader 补 EOCD64 locator/记录 + CD 条目 zip64 extra field(带往返测试);②1GB 下载在 787MB 处被远端断连——downloadWithProgress 加 **Range 断点续传**(3 次指数退避,GitHub assets 支持 206);③导出器不建输出目录——预建 build/web;④**tuning CSV 被 Godot 当翻译表 import**(生成损坏 .translation)——模板结构改为 `tuning-src/`(含 .gdignore,CSV 调参源不进 import)+ `tuning/`(仅 .tres 供运行时 load),三模板四件套/注册表/测试/GDD 工作流同步。
- **真机验证**:templates 下载(断点续传生效)→ 安装(层级正确)→ `EXPORT OK`(2048 模板 build/web 产物齐:index.html/wasm/pck/worklet)→ serve:curl **200×3**(html text/html、wasm application/wasm、pck octet-stream)+ **403×2**(穿越与编码穿越)。
- 测试 +11(web-export.test.ts 10 + zip64 往返 1;含 raw-path 穿越负向——**%2e%2e 会被规范 URL 客户端消段,防护针对 raw 客户端**,测试用 {path} 形态直发原始串实证);README/README.en(roadmap「浏览器试玩」转已支持);零 GD 改动、不新增 MCP 工具。

### Added — 小白一条龙批 4a:demo GIF(spec B-1 处置落地)

- **CLI `gif <project>` 子命令**(router 加路由):`--fps`(1-10,默认 4)/`--seconds`(1-30,默认 8)/`--keys`(逗号分隔小写键名,默认方向键循环;breakout 用 `--keys left,right`)/`--seed`(按键取样顺序,Node 侧 LCG 派生,不依赖游戏 RNG)/`--out`(默认项目内 `dist/demo.gif`;**项目外路径 y/N 确认门**,实测非 TTY 自动拒)。
- **链路**:装 bridge → 起游戏(wait_for_bridge)→ 循环:send_input_sequence 按键时间线(直播模式)+ wall 定时(1000/fps ms)→ take_screenshot → `resolveGameDataPath` 取本机 PNG → pngjs 解码 → 编码落盘;teardown 停游戏。**frozen+playtest.step 通道被实测否决**(「game is frozen; unfreeze before stepping」)——demo GIF 无帧级确定性诉求,直播模式 + wall 定时即 spec B-1 的「低频截图循环」。
- **零依赖 GIF89a 编码器**(`src/cli/gif-encoder.ts`):合并帧量化——unique 色 ≤256 **精确直通**(零量化误差,色块游戏常态命中)/ >256 中位切分;GIF 变体 LZW(可变码长 9-12、字典 4096 满发 CLEAR 重置、LSB-first、255 子块);Netscape 无限循环 + GCE 延时。位宽增长时机 = 分配前 `nextCode===1<<bits`(omggif 对齐,早/晚一位都会位流错位——实测踩过)。
- **生产级解码器** `decodeGifFrames`(首帧 diff 验证用;与测试内独立解码器**分开实现**保留锚定独立性)。
- **验证(Windows + Godot 4.7.2)**:三模板真机各出 32 帧 1280×720 GIF(2048 387KB/28 相邻帧变化、snake 260KB、breakout 204KB);**首帧像素 diff PASS**(GIF 首帧 vs 录制源 PNG:超 8/255 差异像素 0.000%、最大通道差 1);单测 7 用例(**测试内自写独立 GIF-LZW 解码器**做编码往返锚定:2/16/256 色 × 多尺寸、200K 像素 4096 重置、精确直通 RGB 全等、结构断言)。
- README/README.en 小白叙事 GIF 段(roadmap「demo GIF」移已支持);plan `docs/superpowers/plans/2026-08-20-xiaobai-batch4a-demo-gif.md`;零 GD 改动(不动 addons,无 check:gdscript 触发)、不新增 MCP 工具(零版本门禁)。

### Added — 小白一条龙批 3:可玩模板库第一期(2048/贪吃蛇/打砖块;spec 未决项 3 选型裁定)

- **CLI `init <name> --template=2048|snake|breakout`**(原 `--template` 死参数赋予真实语义):一条命令落地**可玩**游戏项目四件套——①可玩 demo(`main.tscn` + scripts,色块程序化占位美术,零外部资产);②GDD(`design/gdd/<slug>.md`,8 段过自家 `validate_gdd` 零 error,自产自销;路径与 CCGS `design/gdd/` 惯例互通);③qa 确定性套件(`qa/<slug>.qa.md`,freeze+send_input_sequence 帧定时时间线+step_until 结构化条件+node_state 断言);④调参表(`tuning/<slug>.csv` + 首发 `.tres`,Custom Resource 运行时加载;改表→`csv_to_resources` 重导→重启生效)。
- **资产形态**:独立散文件 `src/game-templates/<slug>/`(7 文件/模板;GDScript 保持原样可被语法校验)+ 新构建拷贝脚本 `scripts/copy-game-templates.mjs` + npm files 扩展 `build/game-templates/**`;注册表 `src/cli/game-templates.ts`(开发态 src/npm 态 build 探测式定位)。
- **真机验证(Windows + Godot 4.7.2,零编辑器预打开)**:三模板游戏启动零 parse error;qa **2048 两跑 6/6 PASSED + `qa diff` NO_STATUS_CHANGE 零回归**(AC-2 确定性)、snake 两跑 7/7 + 零回归、breakout 三连跑 6/6 + 零回归。
- **可玩性工程要点**:输入用运行时注册 action + `Input.is_action_just_pressed`(demo 探针实证模式,bridge 注入 key 设 physical_keycode 可触发);config 用动态字段访问(`cfg.get(...)`)——零编辑器预打开的新项目没有 `global_script_class_cache`,`class_name` 静态引用会 parse error;随机全用全局 RNG(`playtest.seed` 可锁)。
- **测试方法论发现**:freeze 只锁「现在」不锁「过去」——游戏启动到 freeze 间自然帧数存在进程级漂移,**绝对终态断言**(breakout 的 lives)对此敏感需 tolerance,输入驱动型状态(2048 moves/snake steps)天然免疫;breakout lives 断言带 tolerance 1 并在套件注释说明。另:qa 首跑冷启动(资源首 import)可能超 bridge 15s 窗口,预热后稳定。
- **测试**:15 新用例(it.each 参数化,实测 `npx vitest run test/game-templates.test.ts` 15 passed;注册表/文件实存/GDD 过校验器×3/qa JSON 契约×3/CSV↔tres 数值等价×3/init 落地);不新增 MCP 工具 → 不触发 matrix/check:budget/版本硬门禁。
- README/README.en 小白叙事加模板段(「内置可玩模板库」从 roadmap 转已支持);plan `docs/superpowers/plans/2026-08-20-xiaobai-batch3-game-templates.md`。

- **第三方审查处置**(SHIPPED WITH NITS→SHIPPED,报告 `docs/reviews/2026-08-20-xiaobai-batch3.md`):**B-1 已修**——init 未知模板显式报错列出可用项(原静默降级空骨架,plan 验收点「测试测错层」被审查抓出,补 init 层测试);N-1 four_probability 反语义改名 two_probability(四件套全链);N-2 GDD 钳制描述对齐实现 + snake initial_length 钳上限 n/2;N-3 breakout GDD AC 与 qa 断言面对齐 + AC-2 加输入驱动限定;N-4/N-5 代码残留与笔误。处置后复验:16/16 单测 + 三模板真机 qa 全绿(6/7/6)+ 全量 6055 passed。
### Added — 小白一条龙批 2:Godot 自动安装 + 通用官方资产下载基建(近零依赖,仅 Node 内置)

- **CLI `install [tag]` 子命令 + `setup` 缺失引导**:`npx godot-mcp-enhanced install`(默认 latest stable,`GODOT_MCP_INSTALL_TAG` 可 pin;版本 tag 白名单 `/^\d+\.\d+\.\d+-stable$/`);`setup` 检测不到 Godot 时 TTY 交互 y/N 引导安装(非 TTY 保持 exit 1 指引,不阻塞 CI)。Windows 真机手测:4.7.2-stable 全链路 15.1s(下载 SUMS+86MB zip→SHA512 校验→解压→执行位修复→validate 回读自检→登记→审计),`doctor` 确认发现新装二进制。
- **下载信任链(安全子系统)**:域名硬编码白名单(github.com / objects.githubusercontent.com / api.github.com,https 强制);**SHA512 与二进制同 release 同信道**——官方 releases 自带 `SHA512-SUMS.txt`(33 条覆盖全部二进制资产;spec 未决项 1 实测结论:官方不提供独立 SHA256,提供同源 SHA512,信任根=域名白名单,无跨信道假设);校验失败即删不留半成品;流式下载/流式哈希(60MB 级不整读)。
- **白名单架构改造(spec B-3 处置)**:`~/.godot-mcp/godot-paths.json` 机器级登记文件——`isGodotPathAllowed` 优先级链 UNRESTRICTED 旁路 → env 设了即用(显式用户意图)→ config(CLI install 登记路径视为可信)→ 两者皆无 back-compat 放行(签名校验兜底不变);config 写入方唯一(CLI install 用户确认后),**AI/MCP 链路无写入口**,不是 AI 可扩大的信任面;`findGodot` 搜索链接入 config 候选(优先于 PATH)。真机实测新语义:登记后旧 `GODOT_PATH` 指向路径被 config 白名单拦截、登记路径放行——行为正确,收紧提示已写进 install 输出与 README 环境变量表。
- **自写零依赖 zip reader**(`src/cli/zip-extract.ts`,store+deflate,zip64/加密不需要):**系统 tar 方案被真机手测双杀**——Linux GNU tar 不支持 zip 格式;Windows(Git Bash)GNU tar 把 `C:\...` 绝对路径当 host:path 远程语法("Cannot connect to C:")。条目名路径穿越防护(绝对路径/盘符/`..` 段 → 整包拒绝,负向测试覆盖);完整性由外层 SHA512 保证,内层 CRC 不重复校验。
- **机器级审计**:`~/.godot-mcp/machine-audit.jsonl`(install 成功/失败均记;复用 `AuditEntry`+appendFile 原子追加模式;`details` 类型加 index string 自由载荷)。
- **export templates 基建就绪**:下载/哈希/审计链资产名参数化(`buildReleaseUrls(tag, assetTemplate)` + `downloadWithProgress`),tpz 的解压消费留批 4b 复用。
- **测试**:40 新用例(实测 `grep -c "  it("` → 11+29):白名单优先级链 5/读写容错 5/搜索链护栏 1/URL 域名与 tag 白名单 9/平台映射 2/SUMS 解析 4/流式哈希 1/校验失败即删 2/mock fetch 下载 3/pin tag 2/机器审计 1/zip 解压 3(含路径穿越负向)/CLI 确认非 TTY 1/穿越负向多形态 1;fixture 代码自生成(不提交二进制,遵循 pngjs globalSetup 惯例)。
- **文档**:THREAT_MODEL 新增 §2.1.1(下载信任链+config 写入方唯一+行为变化);README/README.en 小白叙事 install 段(「零预装自动安装」从 roadmap 挪入已支持)+ 环境变量表 ALLOWED 回落语义 + GODOT_MCP_INSTALL_TAG。
- 本批不动 MCP 工具清单/规则模板/`addons/`,不触发 matrix、check:budget 与版本硬门禁。

### Added — 小白一条龙批 1:分发/声量(路线图 spec `docs/superpowers/specs/2026-08-20-xiaobai-onestop-roadmap-design.md` 随本批入库;近零代码,纯文档)

- **CCGS 集成指南** `docs/guides/ccgs-integration.md`(新目录 `docs/guides/`):面向 Claude Code Game Studios 存量用户的实战指南——互补性实测(49 agents/73 skills/24225★ 均附核查命令;全 `.claude/` grep "mcp" 零命中、`/playtest-report` 为模板生成器)、三关节点验证工作流(写码后 `run_and_verify`+`validate_scripts` → `qa run` 真跑断言 → `verify_delivery` 交付门禁)、GDD 8 段逐字同源对照表(`validate_gdd` 精确匹配 `^## <段名>$`,个别 `## Tuning` 变体判 missing 的注意项)、CCGS skill → 本项目工具动作对照 7 条、非 Claude Code 客户端触达说明;适配上游 v1.0.0 现状(最后推送 2026-05-21 实测,不承诺上游配合)。README/README.en 致谢节挂指南入口。
- **README 小白叙事节(中英双版)**「小白上手:不用打开 Godot 编辑器也能做游戏」:五步旅程(说需求→看效果→迭代→验收→undo 兜底)**只写已真能做的**(create_project/quick_scene/write_script/run_and_verify/capture_screenshot/edit_script+validate_scripts/qa+playtest.seed/verify_delivery/undo);GIF/Web 分享、自动装 Godot、模板库、wizard 明确标注「路线图,当前版本尚未支持」(spec B-1/B-2 审查约束:批 4a/4b 落地前不得写成已支持)。
- **undo 口径统一(spec 审查 N-2 处置)**:README/README.en 的 editor undo 叙事从「8 命令模块 45 处」修正为「10 生产命令文件 53 处 `create_action` 注册」(递归含 `commands/asset/` 子目录,核查命令随文 `grep -rc ... | grep -v ":0"`,2026-08-20 实测 7+4+6+1+14+7+5+1+3+5=53);护城河报告 N1(确定性分级)叙事已随 0.32.8 落地,本批无重复改动。
- **赞助入口(C-3)待输入**:GitHub Sponsors 经实测**未开通**(profile 无 Sponsors 标签,2026-08-20),BMAC/ko-fi 账号未提供——按「不编造占位符」红线不落无效链接的 FUNDING.yml;待用户提供赞助平台账号后一行 `.github/FUNDING.yml` + 一行 README 徽章即可补齐。
- 本批不动工具清单/规则模板/`addons/`,不触发 matrix、check:budget 与版本硬门禁。

### Added — Godot 4.7.x 适配批(4.7.1/4.7.2 维护版正式发布跟进;两版官方声明零 API 不兼容)

- **cpp scaffold 支持 `godot_version=4.7`**:枚举扩为 `4.4–4.7`,默认 4.7。godot-cpp 自 v10(独立版本号,master 分支)起不再发布 `godot-{ver}-stable` ref,故分轨——4.6/4.7 生成 `git clone`(master)+ SConstruct 显式 `{"api_version": "{ver}"}`(官方推荐,防 master 默认 target 漂移);4.4/4.5 保持旧 `godot-{ver}-stable` 分支。clone 命令收敛为 `godotCppCloneCommand()` 单一来源(README 模板与工具返回值共用)。
- 逐模板真验证:`TEMPLATES`(11)+架构模板(4)的 `generate({})` 产物在 **Godot 4.7.2** `--check-only` 独立编译 13/14 过(T003 混合粘贴片段/A002 模式骨架经 4.6.3 对照行为逐字一致定性),`verifiedGodotVersion` 全量升 4.7、`lastVerified` 2026-08-19;4.7 唯一 GDScript breaking(accessibility,L025)不涉及。

### Fixed

- **cpp scaffold 4.6 选项先行 bug**:原模板生成 `git clone -b godot-4.6-stable ...`,该分支/tag 在 godotengine/godot-cpp 不存在(2026-08-19 GitHub API 实测:分支仅 4.0–4.5),用户照 README 执行必失败——随分轨改造一并修复。
- **T010(state_machine_simple)产物永远编不过**:match 分支生成裸枚举标识符(如 `IDLE:`),缺 `State.` 前缀,Godot 4.6.3/4.7.2 双版本 `--check-only` 均报 "Identifier not declared"(历史 bug,原 `verified 4.6` 从未独立编译验证);修复为 `State.IDLE:` 形态并补测试断言。

### Changed

- **CI Godot 矩阵 4.7.1 → 4.7.2**(`ci.yml` godot-matrix + `editor-e2e.yml`):本地 Godot 4.7.2 实测 `check:gdscript` errors=0 + 模板验证全绿后才切;4.7.2 Linux asset URL 经 GitHub API 核实存在。
- `create_project`/CI 模板默认 `godot_version` `4.4`→`4.7`(与 README "已测试 4.7" 口径一致)。
- `gdscript-lint` `godot_target` `4.6`→`4.7`,与 `docs/api/extension_api.json`(已 4.7.stable 快照)恢复一致;回归登记 `api-db-version-stale` 移 FIXED(135/8 计数同步,detect 查 4.6 残留防回退)。

### Fixed — 反馈批次处理（bridge 多实例劫持 / mcp_bridge.gd 工作区污染 / headless save_scene 抹 uid / run_tests GUT 9.6 兼容）

**Bridge 多实例端口劫持根治（2026-08-19 反馈）**
- GD 侧（`src/scripts/mcp_bridge.gd`）：listen 前主动 connect 探测端口占用（Windows 下两个进程 bind 同一端口可能都"成功"，流量实际都到先占实例——listen 错误码测不出），被占自动递增避让（9081→9090）；env `GODOT_MCP_BRIDGE_PORT` 可设起点；端口全失败的 warning 附 Windows 保留端口段（`netsh ... excludedportrange`）排查提示；ping 响应新增 `pid`/`project` 实例指纹（连错实例一眼可辨）。
- 实例 registry 升级双写：machine-level（`~/.godot-mcp/instances/`，MCP server 解析源）+ project-level（原有）。
- TS 侧（`src/tools/game-bridge.ts`）：新增 `resolveBridgePort`——按 projectPath 匹配最新存活心跳条目（capabilities 过滤 server 自注册条目，>5min 无心跳的超龄条目忽略）解析实际端口，连接/auth 探测/secret 路径全链路接入；registry 不可读时回落 9081（旧版 GD 完全兼容）。
- 双实例 e2e 验证：两实例 9081/9082 各自 auth+ping 通，pid 指纹可区分。

**mcp_bridge.gd 工作区污染守卫（2026-08-18 反馈）**
- `game_bridge_install`：目标 `mcp_bridge.gd` 内容与工具自带版本不同（项目自管/git tracked + 本地修改）时**不覆盖**（保留用户版本并在响应中说明）；一致才覆盖刷新。
- `game_bridge_uninstall`：内容不同时**不删除**（只清 autoload 注册）；自带 bundled 脚本缺失（工具安装损坏，无法证明托管）时同样保守不删（增量复审 N-5 收紧）；uninstall 同时清理全部端口的 secret 文件（避让端口残留）。

**headless 场景写盘保留 uid（2026-07-19 反馈）**
- `_save_atomic` 新增 `preserve_uids_from` 参数：save 后按原文快照文本回填 `[gd_scene]` header uid 与 `[ext_resource]` uid（按 path 匹配、已有不覆盖、失败不阻断 save）。根因：`pack()` 新建 PackedScene 的 uid 为空（ResourceSaver 便不写 `uid=`）、ext uid 依赖 ResourceUID 注册表（headless 未 import 缺失）；Resource 无公开 uid 属性（4.6.3 实测），文本回填是唯一兼容 4.5-4.7 的修法。
- `save_scene`/`add_node`/`edit_node`/`batch_add_nodes`/`load_sprite` 传原路径；`create_scene`（新文件）/`resave_resources`（语义=重生成）不传。
- e2e 验证（Godot 4.6.3）：修前 header+ext uid 全丢 → 修后全保留；`edit_node` 属性持久化与 `batch_add_nodes` res:// 资源绑定（ExtResource 落盘）同轮验证通过。

**runtime 工具**
- `run_tests` 新增 `quit_flag` 参数（`gquit`/`gexit`，默认 `gquit` 保持兼容）——GUT 9.6+ 移除 `-gquit`（报 `Unknown arguments`）时切 `gexit`（2026-07-04 反馈）。
- `run_project` 的 `timeout` schema 描述补强：明示冷启动 >30s 项目可传大值（自 0.24 起 `computeRunTimeout` 已无上限，仅下限 5）与 `wait_for_bridge` 自动 `max(bridge_timeout+10, timeout)` 语义（2026-08-14 反馈）。

### Added — scene_commit 新增 TileSet 资源层配置 9 op(14 个 Godot MCP 竞品中首创,physics/navigation/custom data 三层全可编程,消除「AI 铺瓦片后必须手动配置层」断点)

**碰撞(physics)**
- **`tileset_physics_layer_add`**:向外部 `.tres` TileSet 添加 physics layer,可选 `collision_layer`/`collision_mask` 位掩码,上报新 layer_id。
- **`tile_collision_set`**:为 atlas 瓦片配置碰撞多边形——`shape:"rect"` 全格四点(运行时由 `tile_size` 生成,等价编辑器按 F);`shape:"polygon"` 自定义 `{x,y}[]` 点集;可选 `one_way` 单向碰撞。
- **`tileset_physics_layer_set`**:修改既有物理层位掩码(不必 remove+add 丢数据)。
- **`tileset_physics_layer_remove`** / **`tile_collision_clear`**:对称删除/清空。

**导航(navigation)**
- **`tileset_navigation_layer_add`**:加导航层(可选位掩码),配 nav 工具族形成「AI 铺瓦片+配导航→寻路」闭环。
- **`tile_navigation_set`**:per-tile 导航多边形(rect/polygon);注意与 collision 的 API 不对称——引擎侧是对象级 `set_navigation_polygon(layer, NavigationPolygon)`,生成器构造 `vertices + add_polygon(索引)`。

**自定义数据(custom data)**
- **`tileset_custom_data_layer_add`**:加自定义数据层(`name` + 可选 `type`:int/float/bool/string/color/vector2)——per-tile 玩法元数据(伤害值/摩擦系数等)。
- **`tile_custom_data_set`**:per-tile 写入数据值(`set_custom_data_by_layer_id`)。

**基础设施与安全**
- per-tile 守卫链(资源→source→TileSetAtlasSource→`has_tile`→layer 越界→TileData null)四 op 共用(`tileGuardChain` helper),全结构化报错不崩溃;保存分支对被改 `.tres`(去重)逐个 tmp+rename 原子写(`_save_resource` helper),纯节点 commit 生成物零变化(测试锁定)。
- 安全分层:生成器层浅校验(`res://` 前缀 + 明文 `..` 段拒绝,`TILESET_RESOURCE_OPS` 9 op 全覆盖)+ handler 层对已存在 `.tres` 的 `resolveWithinRoot` realpath 纵深(URL 编码 `%2e%2e` 绕过浅校验的形态被兜底拦截,负向测试含扩展批 op 接线判别);不存在的路径放行至 GD 侧 "TileSet resource not found" 守卫(无覆写面)。
- schema 描述经 token 预算约束压缩(6000B 阈值内),points 逐项校验由运行时 F-5 守卫承担。
- 端到端 Godot 4.6.3 实测:11 op 序列全链(physics 双 add→nav add→cdata add→双 collision set→nav set→cdata set→physics set→clear→remove)+ 重载断言 12 项(含 `V_nav_poly` 四点/`V_cdata_value=12.5`/clear 后 polys=0)+ 负向 3 类结构化报错;**证据归档** `docs/reviews/2026-08-19-tileset-collision-ops-e2e-evidence.md`(COMMIT_RESULT 原文,补首批审查"端到端不留痕"教训)。
- 端到端另修正两处文档与实现偏差:`PackedVector2Array` 构造器只接受 Array;`has_tile` 实收 1 参。
- MVP 边界:排除内嵌 TileSet(subresource 链路复杂,`tileset_assign` 已确立外部 `.tres` 模式)。

## [0.32.7] - 2026-08-20

### Added — 分发优先批（竞品横扫行动:P0-2 configure / P1-1 UID / P1-2 翻译 / 新 resources 组）

- **`skills` 子命令 + skills 分发（P2-2,对标 godogen 分流路线）**:`build:skills` 双输出（.claude/skills/ 仓库自用 + 顶层 skills/ 分发源,后者进 npm files）;`godot-mcp-enhanced skills [list|install]` 一条命令把打包的 6 个 Claude Code skills（godot-router 路由器/godot-mcp-safe-edit 安全编辑/godot-mcp-verify-loop 验证闭环/godot-mcp-bridge-e2e/screenshot-verify 截图留证/godot-tween-taste Tween 审计）装入 `~/.claude/skills/`,`--target <目录>` 装项目级、`--force` 覆盖、幂等 skip。安装摩擦低于手工 MCP 配置（对标 godogen 5.5k★ 分流验证的"安装摩擦是分发核心变量"）。load_skill 生态复用度评估:打包 skills/ 目录（SKILL.md 子目录结构）可直接经 `GODOT_SKILL_LIBRARIES` 注册为 load_skill 库（其 walkMd 递归扫 .md,格式天然兼容）,无需额外适配。

- **`configure <client>` 一键配置子命令（P0-2）**：定向配置单个 AI 客户端，替代手工 docs/使用指南-Warp.md。`--list` 列出全部支持客户端与安装/配置状态；`--force` 越过未检测闸与幂等跳过（客户端装在非默认位置/提前预置配置）；客户端名归一化匹配（"claude-code" ≡ "Claude Code" ≡ "CLAUDE CODE"）。`setup` 的 `detectMcpCommand` 导出共用。
- **Warp 适配器（第 14 客户端）**：写 `<项目>/.warp/.mcp.json`（project scope），`working_directory` 显式设为项目根（使用指南-Warp §5 最大坑：Warp spawn 的 cwd 默认不是 Godot 项目，resolveProjectPath 每次 WARN）；配置后提示 Warp 项目级审批闸步骤；env 白名单保留/损坏 JSON 备份/原子写+mode 保持对齐其他 13 adapter。
- **`uid` 工具（P1-1,4 action,Godot 4.4+ 文件 UID 管理）**:`uid_scan` 全量扫描（缺 .uid 资源 + 孤儿 .uid）/`uid_get` 查询（批量）/`uid_set` 写 .uid（指定 uid、按路径确定性生成 `ResourceUID.create_id_for_path` 与编辑器一致、`fix_missing` 批量修复）/`uid_check_refs` 悬空 `uid://` 引用检测。主数据源为文件系统 .uid（非 headless 下可能过期/缺失的 uid_cache.bin）；脚本走 `executeGdscriptTrusted`（工具自生成 + TS 侧 uid 正则/sanitizeResPath/extensions 白名单校验,对齐 data-import/material-ops 模式）。真机 Godot 4.6.3 全链验证（scan 识别缺失/孤儿 → set 生成 → get 读回 → fix_missing 幂等 → check_refs 抓悬空引用）。
- **`translation` 工具（P1-2,3 action,翻译文件管理,纯 TS）**:`translation_read` 读 CSV（Godot 国际化表格）/PO（gettext,含多行 msgid/msgstr 与 Language header）条目（limit 截断防大文件撑爆上下文）/`translation_write` 写 Godot 兼容 CSV（RFC 4180 转义:逗号/引号/换行;原子写）/`translation_register` 把 .translation/.po 注册进 project.godot `internationalization/locale/translations`（合并去重/幂等/`remove=true` 反向移除;csv 拒绝——CSV→.translation 编译属编辑器导入器职责,诚实边界）。全部文件 IO 过 `resolveWithinRoot` 白名单 + 负向测试（路径遍历/幽灵文件/坏扩展/坏语言码）。
- **TOOL_GROUPS 新增 `resources` 组**（uid + translation,无 editor/bridge 依赖）;工具总数 43→45、action 241→248（read 124/write 98/destructive 10/process 16,matrix 实测）,README/README.en/manifest/server.json/distribution/migration/规则双副本 24 处计数同步。

## [0.32.6] - 2026-08-19

### Added — tilemap 支持可选 scene_path(对任意场景操作,不再局限主场景;PR#36 外部贡献集成)

- **`tilemap` 八个 action 新增可选 `scene_path`**:传入时用 `_mcp_load_scene()` 加载指定场景、`_mcp_get_scene_node()` 在其中解析节点(自动剥离 `root/` 前缀与场景根节点名,`"root/Ground"`/`"Ground"`/`"TrackA/Ground"` 均可);省略时生成脚本逐字节不变(仍 `_mcp_load_main_scene()` + `_mcp_get_node()`,有测试锁定)。此前八个生成器一律硬编码加载 `application/run/main_scene`——主场景是菜单的项目(常见布局)无论怎么写 `node_path` 都只拿到 `TILEMAP_NOT_FOUND`,报错形态还误导排查方向。
- `scene_path` 经 `resolveWithinRoot(normalizeUserProjectPath(...))` 白名单归一(同 ui 工具),越界 → INVALID_PARAMS;九处重复 preamble 收敛为 `scenePreamble` helper。
- 集成对齐(基于 0.32.1 时代 fork 基底):转义按债务批约定对齐 escapeForGdLiteral;handler 越界映射 INVALID_PARAMS + `../` 逃逸负向测试;matrix 重生成。作者 @thefireKS 在真 Godot 4.6.2 项目端到端验证(575 cells 解码)。

## [0.32.5] - 2026-08-19

### Fixed — 债务清理批

- **screenshot_capture 空白检测采样退化修复**：`screenshot_capture.gd` 步进采样在整除视口上退化为最左单列（step 精确整除时采样点全落同列）→ 换 10×10 网格分层采样；screenshot 工具族 800×600 类视口不再误报 BLANK hint；GD 真跑回归测试含「左列均匀 + 其余噪声」铁证用例（该输入下旧算法必假报 BLANK、新算法正确放行）。
- **gdEscape→escapeForGdLiteral 转义类闭类（三批 + 终审 fix wave）**：按上下文语义分流——① 三变量名上下文 22 文件（标识符位禁 `%`）；② 路径类变体 + test-framework 混合上下文拆分（`_path_escape` 等中间层）；③ 四处任意值类（expected/emit args/JSON payload）。效果口径：按三波口径闭类（路径类全量 + 四处任意值类），闭类口径内含 `%` 的路径与值不再被双写（`gdEscape` 会把 `%` 转义成 `%%`，字面量上下文属误伤）——非全量清零声明。终审 fix wave 复查又修 4 处漏网任意值类（ik `target_nodepath` / assertions `expected`+`desc` / ui-draw `draw_string` 渲染文本，各补含 `%` 回归双断言）；值域受限低频残留与待审点另列挂账（见下「转义残留清单」）；唯一 `%` 格式串上下文（test-framework:176）维持 `gdEscape`。
- **PR-4 终审 Minor 清账**：M-1 uiErrorMapper 断言强化 / M-2 mock 死键清理 / M-5 标点修正；M-3 已随 PR#37 CI 修复消解，不再重复处理。**M-4 决策注记：executor timeout 30s 维持**——单 spawn 实测 2935ms 余量 ~10x，不随双倍工作量调整。
- **README 正文口径三处修复**：235→241×2、36→43、205→241 + README.en 同款（116 行 200+→241 actions）。

### Changed

- **check-tool-count 防复发**：新增 4 个数字口径 pattern（覆盖「工具数/action 数」双类声明），防护面 20→24 处。
- **spec §10.5 两决策输入落答**（实验数据 2026-08-18，生产路径 genUiImportSingleScript 真跑 4.7.1 实测）：flow FILL h=39 根因 = Holder 外层 Panel 比例锚点 float32 残差（anchor_top=100/720=0.138888895511627）→ 容器实测 h=39.9999923706055 + HBoxContainer 给 FILL 子的高度整数截断 floor(39.9999924)=39（位置保留浮点残差 y=100.0000076）；dh=+7 为系统性 FILL 拉伸非噪声，修正渠道维持开放（原型侧等高输入或后续翻译规则垂直映射）。flow 容差**维持 2**——系统性偏差是 flow_verify 的价值（如实红），加宽容差只会隐藏；1px 锚点截断噪声成分已在 2px 内。集成测试注释同步根因指针（`test/integration/ui-import-integration.test.ts`）。
- **挂账移交（转义残留清单，单一合并）**：① 值域受限低频值类残留（`node-3d-ops:58`/`ui-theme:33`/`audio-ops:82`，值域实际不含 `%`，终审裁定挂账不扩本批）；② `valueToGd` 序列化器全消费点审计；③ test-framework `property`/`signalName`/`methodName` 三点转义上下文归类——本批未动（① 值域受限、②③ 超出小批范围），留后续批。

## [0.32.4] - 2026-08-18

### Changed — 原型翻译层单 spawn 合成（ui_import_prototype 内部链，PR-4）

- **单进程优化**：`ui_import_prototype` 内部链 build→persist→reload→measure 由两次 Godot spawn（首版实测 ~6s）合成单 spawn（新独立脚本模板 `src/tools/ui/ui-import-single.ts`；二轮审阅 N-2 拍板：不扩 ui-measure、不动共享 `_mcp_load_scene`）；reload 用 `ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)` 绕过 ResourceCache——同进程裸 load 二载命中缓存旧实例 → verify 全红（spec §6 B-1）；「篡改磁盘后 reload 测出差异」断言（换 Hacked 场景/垃圾内容两例集成用例）证明 reload 真读磁盘；reload 失败错误内嵌「build 已持久化，可重跑 ui_measure_layout」恢复语义（persist 先于 measure 既有顺序保持）；实测耗时 2935ms（RTS 23 节点一次调用；两次 spawn 历史基线 ~6s，降约 51%）。capture 不并入（`ui_pixel_verify` 保持独立调用）。
- **规则双副本措辞精确化（PR-3 终审 M-1/M-2/M-7）**：内缩公式补 `max(0,·)` 下限（短边<4 回落 0，防负内缩）；`alpha<1` → `alpha<0.999`（对齐代码窄界）；未映射控件采样预期红进规则文档（与 build_warnings 样式丢失警告互为印证）。

## [0.32.3] - 2026-08-18

### Added — 原型翻译层像素终验（ui_pixel_verify，PR-3）

- **`ui_pixel_verify` 像素终验**：ui 工具新 action——入参同 `ui_import_prototype`（geometry/geometry_path 二选一）+ 必填 `scene_path`（已构建场景，persist 产物）；窗口模式截图（Windows 专属，headless dummy renderer 空白）→ PNG 解码 → 每 bg 节点采样中心+四角内缩点（内缩 clamp `min(borderRadius+border.width, 短边/2−2)` 防圆角越界）→ 与目标色 0-255 空间 RGB 欧氏距离判定（中心容差 20、角点 60——2026-08-18 集成校准 css-card 真渲染 13 采样点 distance=0.0，零底噪零偏移，阈值维持初值）。采样跳过两类（诚实 skip 不伪装判定）：半透明 bg（alpha<0.999，合成后采样色≠bg_color）与 ProgressBar 系（type/value/fill 任一——fill+百分比文字覆盖 bg 渲染面，无可采样纯色区，bg 槽依赖 style_verify）；带 text 节点跳中心点（居中排版必踩文字像素，仅采 4 角）。BLANK 双条件拦截（stdout BLANK_DETECTED 且 PNG 全图 8x8 网格均匀色，两证据独立一致才拦——防 capture 层步进采样在部分视口退化单列的假拦）；PNG 中间产物临时落 `.godot/` 且失败路径 try/finally 清理；PNG/viewport 尺寸不一致时线性缩放采样坐标。定位**终验**——几何 layout_verify + style_verify 全绿后才跑一次（每次 capture 窗口模式弹窗+秒级耗时）。`actionRisks: write`；action 计数 240→241（规则文档双侧+单测同步）。

### Changed

- **半开区间采样修正**（集成首跑取证 F4）：rect 覆盖像素列 `[x, x+w)`、行 `[y, y+h)`——角点右/下分量取 `x+w−1−inset` / `y+h−1−inset`（否则 inset=0 时角点落覆盖区外一像素格、采到节点外背景，实测 css-card HpBar 角点 d=65.7 假红）；中心点 floor 到 0-indexed 像素格。
- **T5a 措辞修正**（4 处）：border 四边各异「以 style_verify 数值暴露」→ 准确语义——style_verify 期望/实测同源（同一翻译产出）恒绿暴露不了，真暴露渠道是 ui_pixel_verify 像素采样（规则双副本 + README v0.32.1 行 + CHANGELOG 0.32.1 段）。
- **T5c 孙层措辞精确化**（5 处）+ 七槽互指注释：「孙层为近似覆盖」→「孙层由 layout_verify 近似覆盖（非 flow_verify，期望相对输入父原点，容器排布后天然带偏移）」（规则双副本 + measure `_note` + 翻译器 B-2 warning + layout-diff 注释）；STYLEBOX_SLOTS（TS）与 measure 生成脚本 `_all_slots`（GD）双份硬编码加互指注释。

> [0.32.2] 2026-08-18 同日短命 bump（0.32.1→0.32.2→0.32.3 连续，pickaxe 7fce9e2/5c0b87d 证实），变更已并入 [0.32.3] 段；npm 无独立发布（versions 实测无此号）。

## [0.32.1] - 2026-08-18

### Added — 原型翻译层 verify 层（style_verify + flow_verify，PR-2）

- **style_verify（逐节点逐槽位逐属性 diff）**：`ui_import_prototype` 返回与 `ui_measure_layout`（expect_tree 时）新增 `style_verify: [{path, slot, field, target, actual, delta, ok}]`——measure 脚本按需读回（期望清单 ∪ `has_theme_stylebox_override` 并集，期望清单 TS 侧序列化内嵌防「override 没设上被静默架空」）`get_theme_stylebox(slot)` 生效值；非 StyleBoxFlat（如 Label 未 override 的 StyleBoxEmpty）以 type 红条目暴露；颜色容差 0.002（Color float32 精度）。
- **flow_verify（消解上轮 B-2 盲区）**：`TranslateResult` 产出 `flow_expect`（flow 直接子节点最终树路径 + 输入视口绝对 rect，合成根改名后实际名字），import 链与 measure 实测 global rect 直接 diff → `flow_verify: [{path, target, actual, delta, ok}]`；B-2 补偿防线从「screenshot diff 兜底」升级为数字清单；孙层维持近似覆盖（防系统性偏差噪声）。
- **validate 层补强（PR-1 终审 M-2/M-5）**：`bg_color`/`border_color` 四元 number 数组对称校验；`corner_radius` 布尔/null/数组显式拒（原先静默当 0）。
- **fill-only 灰底 warning（PR-1 终审顺手项 3/4）**：显式 Panel/推断布局壳 fill-only（无 bg/border）时声明将以默认主题灰底渲染（透明壳被 fill 输入阻断）；fill+bg 场景不误报。
- **M-1 border 降级声明**：border 四边各异不单独 warning（生产者仅取 top；该差异 style_verify 同源恒绿暴露不了，真暴露渠道为 0.32.3 的 ui_pixel_verify 像素采样），规则双副本显式声明。

## [0.32.0] - 2026-08-17

### Changed — 原型翻译层 StyleBox 通道（bg/fill/borderRadius/border → StyleBoxFlat，PR-1，bg 为 BREAKING）

- **样式翻译从 modulate 近似染色迁移到真 StyleBoxFlat（BREAKING）**：`ui_import_prototype` 的 `bg` 不再产 `modulate` 近似染色（warning 声明偏差的旧行为移除），与新增 `fill`/`borderRadius`/`border` 三字段统一翻译为 StyleBoxFlat override——经 `add_theme_stylebox_override` API 写入（落盘属性名 `theme_override_styles/<slot>`；`node.set()` 该路径 pack 落盘会丢 override，勿手写）。槽位映射：Panel→panel、ProgressBar→background+fill、Button/Label→normal；其余控件 warning+忽略；bg 缺省而 border/radius 存在→`draw_center=false` 保 CSS 透明底。
- **类型层**：StyleBoxSlot 七值白名单 + StyleBoxFlatSpec 校验（`src/tools/ui/types.ts` 类型 + `src/tools/ui/ui-layout.ts` validateUiNodeSpec 校验层）；`UiNodeSpec.styleboxes` 使 `ui_build_layout` 手写树同样可挂 StyleBoxFlat override。
- **GD 生成器**：StyleBoxFlat 构造块 `_sb_N`（1-based 专属计数防同名 var）；`draw_center` 布尔校验（堵 GD 注入向量，审查 I-1）。
- **规则 7 钳制预警恢复无条件（实测推翻条件化）**：实测 Godot 4.7.1 rect.h=16 时无 override→27、bg-only→23、fill-only→27、bg+fill→23，全组合被钳——override 只改变钳制值不消除钳制，故 `rect.h < 27 → "will be clamped"` warning 无条件发出（具名常量 `PROGRESS_BAR_MIN_HEIGHT=27`）。
- **evaluate 取数脚本模板升级**：`toHex`（`#rrggbb` 丢 alpha）→ `toRgba`（`[r,g,b,a]` 0-1 数组保留 alpha；fg/bg 消费点改数组判定跳过浏览器默认黑）；循环体尾部追加三件套采集——`borderRadius`（四角统一 number 或 `{tl,tr,br,bl}`）/ `border`（CSS 四边不同时取 top 的 width+color）/ `fill`（`[data-fill]` 子元素背景，ProgressBar fill 槽色）。
- **规则双副本同步**：`godot-mcp-ui.md`（字段清单 +3 字段 / 翻译规则 StyleBox 槽位映射 / 引擎预警无条件表述 / evaluate 要点 toRgba / 模板本体）与 `godot-mcp-engine-quirks.md`（modulate 段「bg 走 StyleBoxFlat 通道」/ ProgressBar 27px 段无条件预警）↔ `rule-templates.ts` 镜像逐字同步，`STRICT=1 check:rules-sync` 绿（9 模板双向对账一致）。

## [0.31.4] - 2026-08-17

### Added — QA 断言四件套 + 应用级异步长跑（QA 深化 PR-1a/PR-1b）

- **qa 套件 4 新断言 + 4 控制步骤（PR-1a）**：`assert` enum 4→8（+`screenshot_diff`/`signal`/`errors`/`monitor`）；新增 `watch_start|stop`/`monitor_start|stop`（17 种步骤类型）。signal 按 GD `_jsonify` 后形态深比较（Vector2→{x,y}）计数区间；errors 以 setup 后 `next_seq` 锚点增量断言（默认排除 warning，旧 bridge 降级）；monitor 区间 + 单调四档；**B-2 取数铁律**——GD 侧事件满/node_lost 自动置 inactive 后 poll 返空，断言取数 poll 优先 → 补 stop 取全量（不假红）；套件外订阅拒收 + 空缓存 `!== null` 判据（不假绿）。
- **runtime-assert `screenshot_diff` 真实现（PR-1a）**：NOT_IMPLEMENTED 占位 → 像素级对比（复用 `diffPngBuffers`，**差异容忍**语义，threshold 默认 0.12，修复原 0.85 相似度语义反转）；`max_diff_ratio`（默认 0.05）；evidence 染红图落 qa-reports（PASSED/FAILED 均回填）；导出供 qa 同源复用。
- **`qa run mode:'async'` 应用级异步长跑（PR-1b）**：立即返回 run_id 后台执行（化解客户端 ~60s 工具超时）；新增 `qa status`（轮询进度/列表）/`qa cancel`（步骤间生效，teardown 照常）action；run 注册表（SEP-1686 词汇，单 working 互斥 BUSY，TTL 惰性清扫，PR-2 tasks 层单一事实源）；`CANCELLED` 终态（优先于 FAILED）且不作 nightly 基线；close 优雅收尾进行中 run。
- **qa 工具描述重构**：descBytes 773→469（细节移入 schema 字段 description）。

- **MCP Tasks 协议层(2025-11-25 wire,PR-2)**:`tasks/get|list|cancel|result` 四协议 method(单 working 注册表直读,wire 五字段校验)+ `notifications/tasks/status` 终态通知(客户端 tasks 能力门控,best-effort)+ capabilities.tasks 细粒度声明;客户端声明 tasks 能力时 `qa run` 自动 async(`_meta.relatedTask` 回指,显式 mode 优先);`tasks/cancel` audit 留痕(B-3:免二次 elicitation);`@modelcontextprotocol/core` 提升直接依赖(pnpm/PnP 兼容);makeRunId 加随机后缀防同秒覆盖(M-7)+ RunRecord.error 失败原因透传(M-8)。

### Fixed
- **`evidence_path` 任意路径写入注入（PR-1a 终审 I-1，安全）**：内部参数可从 MCP args 注入（args-validator 未知字段允许）→ 前缀校验锁 qa-reports 目录内（含兄弟目录伪装防护）。
- **`assertNodeState` 嵌套 shape 失真（PR-1a e2e 发现的既有缺陷，PR-1b 修）**：真 bridge `get_node_properties` 返回 `{properties:{...}, node}`，原平铺取值致 actual 恒 undefined——双 shape 兼容（嵌套优先）。
- **skill-builder 过时文案**：screenshot-verify skill 清理 NOT_IMPLEMENTED/0.85 相似度残留。

## [0.31.3] - 2026-08-16

### Added — QA 编排收尾（v0.30 方向 B 收口：nightly diff + 录制集成 + 审查 NIT-7/8 处置）

- **`qa nightly <spec-dir>` CLI（夜间跑批）**：跑目录下全部 `*.json`/`*.md` spec，每套件自动与**上次同套件**结果 diff（按报告时间序查基线，首次运行跳过 diff），汇总回归/修复清单 + 退出码（任一套件 FAILED → 1）。`report.ts` 新增 `findPreviousReport`；`qa run` 响应补 `suite_name`/`project_path`。
- **`record_on_failure` 套件选项（失败自动留录制）**：setup 就绪后 `recording.start`，teardown（stop_project 杀游戏断 bridge 前）`recording.stop`；结果非 PASSED 时 events 落盘 `qa-reports/<run_id>-recording.json`（格式与 `recording_play` 的 events_json 兼容，可离线回放复现），成功丢弃。旧 bridge 无录制命令仅记 `teardown_warning` 降级不阻断（同 screenshot 降级哲学）。
- **CLI audit 留痕（v0.30 审查 NIT-7）**：`qa run`/`qa nightly` 直调 `handleTool` 不经 dispatcher 确认/审计门，CLI 层手动 `appendAuditLine`（best-effort），夜间跑批操作审计可追溯。
- **测试补全（v0.30 审查 NIT-8 收口）**：freeze/unfreeze/snapshot/restore 分支 + suite budget 耗尽路径 + record_on_failure 四场景（失败落盘含 recording.stop 先于 stop_project 顺序断言/成功不落盘/start 失败降级/默认关闭负例）+ nightly CLI 四场景（回归检出+汇总+exit 码/多套件无基线/spec 错误不中断/空目录）+ findPreviousReport。

### Fixed — 原型翻译层迭代小修批(2026-08-16 实施审查遗留 ①②⑤)

- **显式 `type:'Panel'` 无 bg 行为翻转无提示**:HTML div 默认透明而 Godot 默认 Panel 主题灰底 stylebox,渲染行为翻转(灰底可见)此前静默——翻译器补 declaration warning(建议补 bg 匹配原型或去掉 type 走推断透明壳),正负测试锁定。
- **`ui_import_prototype` 根级 diff 限制提示假阳性**:`parent_path` 尾斜杠变体(`root/`/`/root/`)与 `/root` 语义等价,字符串全等比较会多弹 warning——改归一化判定(去尾斜杠);场景根名(如 `/Main`)仍保守提示(原点对齐理论差异仍在)。
- **token budget totalSum warn 基线校准**:实测 86412B 超旧线 80KB 达 5.5%,按"覆盖率阈值持续超 4% 应上调"惯例上调至 90KB,消除长期恒 warn 噪声;error 120KB 硬线与单工具 desc warn(有意义的瘦身提醒)不动。

### Changed — 双副本内容一致性 STRICT 门禁(遗留 ③)

- **`.claude/rules/` ↔ `rule-templates.ts` 历史 drift 全量清零 + CI 启用 STRICT**:8/9 文件存在双向内容 drift(core 模板缺 13 行陷阱知识/bridge 模板缺 monitor/watch/UI 发现/manage_tools 四节与 10 条陷阱且示例节点路径用相对形态[GD 侧 `get_node_or_null` 从 autoload 解析,相对路径必失败]/recording 模板字段 `timestamp_ms`+`x,y` 与 GD 权威产物 `time_offset`+`position` 不符且缺自动命名语义/editor 双向缺段/workflow 三件套 rules 侧缺 frontmatter)。逐处仲裁权威侧(GD 实现/工具真实行为)双向合并。
- **校验脚本升级**:`check-rules-content-sync.mjs` 归一化收紧(旧版全 semver 抹平会掩盖 Godot 4.x 真实差异+压缩空白使 diff 粒度退化;新版仅抹版本行锚定 `godot-mcp-enhanced` 前缀+换行归一)+ 双向对账(文件↔模板键)+ 行级差异定位;`ci.yml` 传 `STRICT=1` 阻断(去掉 `continue-on-error` 假接线)。

### Fixed — CI Linux 平台债(2026-08-15 run#122 三 job 全红根因修复)

- **check job 4 文件 23 用例稳定超时/输出丢失**:CI 的 vitest 步骤跑在 `check:gdscript` 之前,而 gdscript-check fixture 的 `src/scripts/`+`addons/` 是被 .gitignore 的运行时拷贝产物 → CI checkout 后 fixture 是空壳,Godot `load()` 得 null → SCRIPT ERROR → `extends SceneTree` 脚本 `_init` 中断、`quit()` 不执行 → headless 进程无限挂 → vitest 10s 超时(本地 Windows 绿是因开发机留有旧拷贝残留,属环境假绿)。修复:`check-gdscript.ts` 抽出 `syncCheckProjectFixture()` 导出函数,vitest 新增 `globalSetup`(`test/global-setup.ts`)在所有测试 worker 启动前填充 fixture——本地/CI 任意 vitest 入口统一就绪,ci.yml 零改动。
- **screenshot-structured-content 3 用例挂(analyze 路径)**:依赖被 `test/fixtures/**/*.png` gitignore 规则忽略的 E2E 运行产物 `e2e-project/screenshot.png`,CI 缺文件。修复:pngjs 自生成 64×64 渐变 PNG 写入测试临时目录,零磁盘 fixture 依赖。
- **matrix job L2 2 用例挂(bridge 正路径/recording)+ `e2e-bridge-get-node-layout` 整 suite 静默 skip**:`buildSafeEnv()` 环境白名单缺 `XAUTHORITY` → xvfb-run 环境下 spawn 的 Godot 游戏进程无法认证 X11 连接秒退(实测:unset XAUTHORITY exit=1 秒退,保留则存活)→ `run_project` 报 `Bridge not ready (process exited during probe)`。修复:白名单补 `XAUTHORITY`(与已透传的 `DISPLAY` 配对的 X11 凭证文件路径)+ `helpers.test.js` 断言防回归。

## [0.31.2] - 2026-08-16

> prototype-import final review 修复波（P2：透明壳误伤 / parent_path 参照系声明 / 坏图可区分性补证据 / screenshot 两处 Minor）。

### Fixed

- **规则 4 透明壳收窄（final review I-1，行为修复）**：旧实现对一切无 text 节点设 `self_modulate:[1,1,1,0]`，`value` 推断的 ProgressBar（无 text/bg）命中 → HP 条不可见而 layout diff 不查 visible（验收假绿，RTS fixture HpBar 即中招）。现只对**推断为布局壳 Panel**（flow 壳，或无显式 type/text/value 的纯布局节点）设透明壳；自带视觉控件一律豁免——ProgressBar（推断或显式）、Button（推断或显式）、任何显式 type（含显式 Panel）。被设透明壳的推断 Panel 追加 build_warnings 使用提示（"set bg or type to keep it visible"）。集成测试补 HpBar 落盘段无 self_modulate 断言（已做负例验证：旧条件下该断言 FAIL）。
- **`screenshot` threshold 显式 null 落默认 0.12（final review Minor-2）**：旧 `Number(null)=0` 把阈值静默变 0（全像素计差）；现 `== null` 覆盖 undefined 与显式 null。
- **`screenshot` action 缺失提示补 diff（Minor-1）**：`(capture or analyze)` → `(capture, analyze or diff)`。

### Docs

- **`parent_path` 根级参照系限制声明（I-2，声明式修复不改 diff 算法）**：`ui_import_prototype` 的 parent_path schema description 加"须为原点对齐（global_position≈0,0）的节点，默认 root——非原点挂载时 layout_verify 根级条目期望按视口原点求解，根级 diff 恒误报"；handler 在 parent_path 非 root 时给 build_warnings 追加同语义提示（mock 单测断言）。
- **坏图可区分性实测证据（I-3，双副本 ui.md/rule-templates.ts 同步）**："坏图 > 0.4" 从无来源声明改为以同布局好图对为基线：本仓实测（threshold=0.12）好图对 web-prototype vs godot-hud ≈0.1762，下半部内容消失合成坏图（godot-hud y>360 置纯黑，模拟 modulate 级联内容消失）≈0.4797（约基线 2.7 倍，> 0.4 成立）；跨项目以自身好图对为基线校准。screenshot-diff 测试补程序化合成坏图用例（断言 bad > good×1.5）。
- 规则双副本（`.claude/rules/godot-mcp-ui.md` + `rule-templates.ts`）同步规则 4 收窄契约与 diff 基线口径；本次同步顺带消除 ui.md 副本历史 drift（归一化 diff 0 差异）。

## [0.31.1] - 2026-08-16

> prototype-import Task 5 审查修复波（SHIPPED 后 Minor-2/3，防首次真实使用翻车）。

### Fixed

- **evaluate 取数脚本模板补 `align` 采集（双副本）**：读 `getComputedStyle(el).textAlign`，映射 left/start→'left'、center→'center'、right/end→'right'，其余值（justify 等）不输出字段（走翻译器缺省 center）。此前模板不采集水平对齐——CSS 默认 left 而翻译器缺省 center，所有未显式设 text-align 的元素会系统性丢失对齐语义。
- **evaluate 模板 `data-value` 守卫（双副本）**：解析改为 `Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined` 并注释"value 必填 0-1 小数，百分数（如 72）请先除以 100"——`NodeSchema.value` 为 `min(0).max(1)`，`data-value="72"` 直接透传会被 zod 拒（INVALID_PARAMS）。

## [0.31.0] - 2026-08-16

> prototype-import Task 5：登记收尾（规则双副本 / 版本 / 文档归档）。v0.31.0 为原型翻译层 + 视觉验收批次（spec `docs/superpowers/specs/2026-08-16-prototype-import-design.md`）的目标版本；工具实现详录见 [0.30.4]（ui_import_prototype）与 [0.30.5]（screenshot diff）段。

### Added

- **`ui_import_prototype`（ui 工具族 action）**：HTML 原型几何 JSON（扁平视口坐标，strict schema 拒未知字段）**一次调用**完成 翻译→build（固定 persist，无 persist 参数）→measure（二次 spawn）→layout_verify；树按 rect 包含关系自动推导（容差 1px），交叉重叠/等 rect 直接 `INVALID_PARAMS` 拒绝；翻译规则 12+1 条（Label `vertical_alignment:1`、透明壳 `self_modulate`、flow Holder 壳、bg→modulate 近似、ProgressBar 最小高 27 预警、行高钳制预警）；返回含 `verify_coverage`（targets 含合成根 `_PrototypeRoot`，无 flow 时 = 输入节点数+1；flow 直接子节点不受几何 verify 覆盖，补偿防线为 screenshot diff）。
- **`screenshot(action=diff)`**：两张 PNG 逐像素对比（纯 TS + pngjs，零新依赖）；per-pixel 归一化欧氏距离，`threshold` 默认 0.12（严格大于才计差、忽略 alpha）；返回 `{width,height,diff_pixels,diff_ratio,bbox}`；可选 `diff_path` 红染差异图。

### Docs

- **`godot-mcp-ui.md` 规则双副本**（`.claude/rules/` + `rule-templates.ts`）新增 `ui_import_prototype` 专节：AI 全链路工作流（写 HTML 原型→浏览器 evaluate 取数→一次调用→**不绿回 HTML 改（原型是唯一真源）**→绿后像素验收）；proto-geometry JSON 格式与颜色三格式（仅 `#rrggbb`/`[r,g,b]`0-255/`[r,g,b,a]`0-1，CSS `rgb()` 需转换）；**浏览器 evaluate 取数脚本模板**（读 `[data-name]`/`getBoundingClientRect`/`getComputedStyle` background-color 非透明才填 bg，内置 rgb()→#hex 转换，chrome-devtools / playwright 通用）；容差模糊带提示（避免 ≤2px 宽相邻独立节点）与引擎下限预警（fontSize*1.5 行高 / ProgressBar 27px）；Task 4 审查留的 2 条用法契约：**capture 的 viewport 必须与原型 viewport 一致**、**diff_ratio 含字体抗锯齿底噪须设区间断言而非精确值**（实测参考：同布局跨渲染器历史图对 threshold=0.12 时 ≈0.1762）。
- **`godot-mcp-engine-quirks.md` 规则双副本**新增「UI 渲染与控件尺寸」段 4 条：★`modulate` 乘性级联影响整个子树（透明壳必须 `self_modulate`）；★Label 垂直对齐默认 TOP（CSS line-height 居中惯用法需显式 `vertical_alignment=1`）；Control 高度被字体最小行高钳制（rect.h ≥ fontSize*1.5）；★ProgressBar 默认主题最小高 27px（实测 rect.h=16 落地 27px）。
- `claudemd-builder.ts` 分发规则 UI 段补一句：HTML 原型还原优先 `ui_import_prototype`。
- 控制器文档入库：spec（`docs/superpowers/specs/2026-08-16-prototype-import-design.md`）、plan（`docs/superpowers/plans/2026-08-16-prototype-import.md`）、spec 审查（`docs/reviews/2026-08-16-prototype-import-spec.md`）。

### Fixed

- 双副本历史 drift（`rule-templates.ts` 与 `.claude/rules/godot-mcp-engine-quirks.md`）：`set_anchors_preset` 不改 offset 条目（commit a97c6cc 只改了 `.claude/rules` 未同步模板）与 frontmatter 缺失（实际文件无 `--- description ---` 头，其余规则文件均有）——本批以 `.claude/rules` 为准同步模板并补齐 frontmatter，归一化 diff（转义还原 + 版本行归一）核对逐行一致。

## [0.30.5] - 2026-08-16

> prototype-import Task 4：`screenshot` 像素级双图对比。

### Added

- **`screenshot(action=diff)`**：两张 PNG 逐像素对比（纯 TS + pngjs，零 Godot 依赖、零新依赖）。语义：per-pixel 归一化欧氏距离 `sqrt(Δr²+Δg²+Δb²)/(√3×255)`，`threshold` 默认 0.12（0-1，恰好等于阈值不计差，严格大于才计）；**忽略 alpha 只比 RGB**；返回 `{width,height,diff_pixels,diff_ratio,bbox}`（bbox 为差异像素包围盒，无差异为 null）；可选 `diff_path` 写出红染差异图（差异像素纯红 255,0,0，其余保留 a 图原色）。路径策略沿用同工具先例（读取链同 `analyze` 的 image_path 白名单双分支，写出链同 `capture` 的 output_path）；尺寸不一致 / 非法 threshold / 图片缺失 → `INVALID_PARAMS`。历史图对校准（`test/fixtures/visual/{web-prototype,godot-hud}.png`，1280x720 入库）：threshold=0.12 实测 diff_ratio≈0.1762（162408/921600）。
- `decodePng`（`src/tools/screenshot-detail.ts`）加 export；新增纯函数 `diffPngBuffers`（O(n) 单 pass）。

### Fixed

- action 数 drift：`screenshot` 新增 diff action 后 `rule-templates.ts` / `.claude/rules/godot-mcp-core.md` 手写 action 数未同步（237 → 238，check-tool-count 红），本批随版本 bump 0.30.5 修复。

## [0.30.4] - 2026-08-16

> prototype-import Task 3 集成验收 + Task 2 遗留修复波。

### Added

- `ui_import_prototype` 集成验收（真跑 Godot，GODOT_PATH gated）：RTS HUD fixture（23 节点，chrome-devtools 实测 DOM 产出，`test/fixtures/prototype-geometry/rts-hud.json`）经 `geometry_path` 一次调用 → **23/23 节点 layout_verify 全绿 + overlaps/out_of_bounds 空** + `verify_coverage` + `persist saved:true` + 独立重载 measure 验证落盘 `.tscn`；HpBar 按 Godot 4.7 默认主题 ProgressBar 最小高 27px 校准（fixture y=599/h=27），翻译器新增同类引擎下限预警（will be clamped）+ mini-flow 覆盖率语义 + 逃逸负向；一次调用（build+measure 两次 spawn）实测约 5.7s。
- **引擎校准数据**：Godot 4.7 默认主题 ProgressBar 最小高度 27px（实测原型 rect.h=16 落地 27px，`Control.minimum_size` 硬下限）——与 Button 默认主题高 8px 同类的主题硬约束，非翻译器 bug；处置 = 翻译器引擎下限预警（具名常量 `PROGRESS_BAR_MIN_HEIGHT=27`，warning "will be clamped"，规则 7 字体行高同族）+ fixture 按下限校准。

### Fixed

- Task 2 遗留：`ui_import_prototype` measure 阶段失败的错误信息附 `(build 已持久化,可重跑 ui_measure_layout)`——B-1 契约下 build 固定持久化，AI 无需重新 import 即可补测量。
- Task 2 遗留 drift：`ui_import_prototype` 新增 action 后 `rule-templates.ts` / `.claude/rules/godot-mcp-core.md` 手写 action 数未同步（236 → 237，check-tool-count 红），本批随版本 bump 0.30.4 修复。

## [0.30.3] - 2026-08-16

> UI 布局保真 final-review 修复波（合并前唯一修复批次）。

### Fixed

- **嵌套 rect 坐标系修正（C1）**：子节点 rect 此前恒以 viewport(默认 1280x720)求解，嵌套时双双重错位——现按**父尺寸**求解：根节点相对 `viewport` 参数，子节点相对父节点 `rect.w/h`；父未声明 rect（非根、非容器）时降级 viewport 并发 warning（`parent's size is unknown`）。集成测试以真实 Godot 验收：`Panel(rect 100,50,600,400)` 内 `Button(rect 50,30,120,48)` 落地 global=(150,80)、anchors=50/600（相对父尺寸，非视口）。
- **layout_verify.diff 基准修正（C1）**：diff 由"target(父相对) vs measured(global) 直接相减"改为**父相对坐标比较**（子 global − 父 global，与 target 同构；根级 target 以视口原点为参照；父不在测量集时 delta 为 NaN）——嵌套 rect 的 Δ 数值从此真实反映偏差。
- **wrap/grid + space-\* 双 warning 矛盾消除（I1）**：`wrap: "wrap"` 或 `direction: "grid"` 时不再推 "implemented via injected spacer nodes"（与 "ignored when wrap/grid" 语义矛盾），仅保留后者。

### Added

- `ui_build_layout` 顶层 `viewport: {w, h}` 参数：根节点 rect 的求解基准（默认 1280x720，非正数报 INVALID_PARAMS）。
- `ui_measure_layout` 输出新增 `viewport`（项目声明视口尺寸，取 `root.content_scale_size`——headless `--script` 下 Window.size/get_visible_rect 不反映 project 设置，实测 100x100/2496，不可用）与 `stalled` 标志（5 帧上限内未达 2 帧稳定快照时 true）。
- `layout_verify` 透传 `viewport` 字段（根级 rect 参照系上下文）。

### Docs

- `.claude/rules/godot-mcp-ui.md` 与 `src/tools/rule-templates.ts` UI 模板段双副本同步：rect 小节改写为真实父相对语义（含 viewport 参数、容器自身 rect 仅作对照目标）、justify space-\* 小节补 wrap/grid 不注入说明、布局收敛闭环小节改父相对坐标语义（归一化 diff 核对逐字一致）。

## [0.30.2] - 2026-08-16

> UI 布局保真批次（spec v0.31 主菜，`docs/superpowers/specs/2026-08-16-ui-layout-fidelity-design.md`）：rect 绝对几何 + 整树测量 + 期望树 diff 收敛闭环 + persist 持久化。

### Added

- **`ui_measure_layout`**：headless 整树 computed rect 测量（等布局稳定后输出；`node_path` 可选，省略则从场景根整树测；`max_depth` 默认 16 上限 64）。支持 `expect_tree`（同 `ui_build_layout` tree，含 rect）→ `data.layout_verify`：`targets`/`diff`（逐节点 Δ，容差默认 2px）/`overlaps`（兄弟重叠）/`out_of_bounds`（溢出父边界）。
- **`ui_build_layout` rect 绝对几何 + 锚点求解**：节点支持 `rect: {x,y,w,h}`（相对父左上角），反解为显式四值 anchors+offsets（snap 0/0.5/1，比例兜底；不用 set_anchors_preset——引擎陷阱 preset 不重置 offsets）；优先于 `anchor_preset`；父为 Container 时 TS warning + 运行时跳过（容器强制重排子节点）。
- **`ui_build_layout` persist 原子写**：`persist=true`（默认 false）在 build 完成后原子写 .tscn（pack → tmp → rename，失败清理，同 scene-commit F-2 模式）。
- **布局收敛闭环用法**：`ui_build_layout(tree 含 rect)` → `ui_measure_layout(expect_tree=同一棵 tree，不带 node_path)` → 按 diff Δ 修 tree 循环至全绿 → `persist=true` 落盘。

### Fixed

- justify `space-between/space-around/space-evenly` 由近似映射改为 `_spacer_N` spacer 注入真实现（原映射语义丢失；与子节点 `flex.grow` 并存时给出"瓜分剩余空间、分配语义不同于 CSS"的 warning）。

### Docs

- `.claude/rules/godot-mcp-ui.md` 与 `src/tools/rule-templates.ts` UI 模板段双副本同步：工具清单补 `ui_measure_layout` 行、新增 rect/justify/布局收敛闭环三小节、description 关键词补 `ui_measure_layout`/`测量`/`rect`（修复 Task 3 审查 Minor：关键词列表未含 measure）。

> [0.30.1] 2026-08-16 同日短命 bump（0.30.0→0.30.1→0.30.2 连续，pickaxe dcc62fa/0e19620 证实），ui_measure_layout 等变更已并入 [0.30.2] 段；npm 无独立发布（versions 实测无此号）。

## [0.30.0] - 2026-08-15

> 方向拍板（2026-08-15 竞品调研，见 `docs/research/2026-08-15-新版本方向竞品调研.md`）：B AI QA + C 理解层 + D 协议债；A（Asset Store/HTTP transport/dock）因 Asset Store 提交通道问题搁置。零 GDScript 改动（纯 TS 侧批次）。

### ⚠️ Breaking / 迁移需知

- **MCP Roots 动态授权退役**：MCP `2026-07-28` 规范正式废弃 Roots（12 个月窗口），v0.30 删除 `initRootsIntegration` 与 path-utils 动态 roots 三函数。modern era 客户端零行为变化（SDK roots 拉取本就抛错回落 env）；**legacy + 配置了 roots 的客户端此后统一走 `ALLOWED_PROJECT_PATHS` env**（SDK 官方迁移路径即 configuration）。详见 `docs/protocol-debt-2026-07-28.md`。
- **默认 profile（basic）新增 `qa` 与 `analysis` 两个工具**（分别归 bridge/code 组，lite/basic 随组可见；`qa.run` 是 process 风险，经 dispatcher confirm+audit 门）。

### Added — B 批：`qa` 工具（AI QA 测试套件编排，免费开源闭环游戏 QA）

- **`qa` merged 工具（bridge 组，3 action）**：`run`（结构化测试规范 → 自动 `game_bridge_install` → `run_project` → 逐步执行 → 聚合报告）、`report`（读报告，latest/prev/run_id）、`diff`（两份报告按用例回归对比：回归/修复/新增/移除，nightly 跑批用）。
- **13 种步骤类型**：`input`（key/mouse_click/mouse_move/text/touch/drag）、`wait`（wait_for_node/wait_for_property 轮询）、`wait_frames`（确定性帧推进）、`freeze`/`unfreeze`、`step_until`（结构化条件，规避 Expression RCE）、`snapshot`/`restore`、`set`、`call`（bridge 只读白名单 + `GODOT_MCP_BRIDGE_EXTRA_METHODS` 逃生口，不绕过）、`assert`（node_state/scene_structure/screen_text/perf，复用 runtime-assert 同源实现）、`screenshot`（报告证据 PNG）、`sleep`。
- **spec 双源**：inline JSON 对象或 `.json`/`.md` 文件（markdown ```qa-spec 围栏），zod v4 严格校验（仓库既有依赖，零新增）。确定性选项：`seed`/`fixed_delta_hz`/`continue_on_failure`/`suite_budget_ms` 等。
- **报告落盘 `~/.godot-mcp/qa-reports/<run_id>.{json,md}`**（`GODOT_MCP_QA_REPORTS_DIR` 可重定向；不污染用户项目）：每步 PASSED/FAILED/ERROR/SKIPPED + mismatch + 截图证据路径 + 套件汇总；setup 失败全步骤 SKIPPED('setup failed') 如实标注。
- **CLI：`godot-mcp-enhanced qa run <spec> [--project p] [--json]` / `qa report` / `qa diff`**（`npm run qa`；run 退出码 0/1 供 cron 夜间跑批直接判定）。
- **安全设计**：`qa.run` 声明 `process` 风险——整个套件经 ToolDispatcher confirm+audit 门一次性覆盖（与 confirm_and_execute 对已确认操作直调模块的语义一致），步骤层直调 `sendToBridge` 不产生绕门；断言复用 `runtime-assert.ts` 导出的 4 个 assert 函数（v0.30 起导出，同源防 drift）。

### Added — C 批：`analysis` 工具（理解层：免费开源版信号影响面分析）

- **`analysis` merged 工具（code 组，OFFLINE_TOOLS，纯静态零 Godot 依赖）**：`signal_map`（全项目信号连接全景，editor `.tscn [connection]` 与 code `.gd` 文本扫描两来源分开标注 + 盲区诚实声明）；`impact_check`（改动前影响面：signal 目标列全部连接方/发射方/监听方，script 目标列引用场景+节点绑定+文本引用，scene 目标列连接/脚本/被实例化处）。
- **`tscn-parser` 连接属性补全**：`[connection]` 的 `flags`/`binds`/`unbinds` 此前被头部正则静默丢弃（只匹配引号值），现完整捕获（binds 含空格数组覆盖）。
- **`gdscript-lint` helper 导出**：`isInComment`/`isInString`/`isInCommentOrString` 改导出，analysis 的 .gd 信号扫描同源复用（注释/字符串内同名调用不误报，负向用例锁定）。
- 对标 GodotIQ Pro（$19）的空间/影响面分析能力，免费开源且支持到 Godot 4.7（GodotIQ 仅 4.0-4.4）。

### Changed — D 批：协议债处置（详见 `docs/protocol-debt-2026-07-28.md`）

- **Logging（SEP-2577）**：4 处 `sendLoggingMessage` 调用点窗口内保持（SDK 承诺 12 个月兼容），2027-04 前启动 stderr 迁移（文档记录路径）。
- **Sampling**：实测零使用，零影响。
- **Tasks / MCP Apps**：SDK 2.0.0 分别仅 wire 词汇无 runtime / 零支持——自研任务注册表与 `dashboard://` 降级资源 defer，文档记录两条路径的底座评估。
- `oninitialized` 回调保留（承载 logger/progress client-ready，与 Roots 无关）；负向契约测试锁定源码无 Roots API 引用。

### Tests

- B 批 35 新用例：spec 解析正负向（13 步骤类型全解析/未知 type 拒绝/围栏语法错误不进 zod）、报告 diff（回归/修复/新增/移除/ERROR 视为 not-passed/无 label 按 index:type 对齐）、runner mock 编排（install→run→seed→steps→stop 全链调用序列/断言 mismatch 中止/continue_on_failure/bridge error→ERROR/wait 超时→FAILED/setup 失败全 SKIPPED/teardown_warnings）。
- C 批 15 新用例：connection flags/binds 回归、gdscan 正负向（注释/字符串内 emit_signal 不误报/connect_to_host 不误报）、signal_map 两来源/过滤、impact_check 三类目标 + 参数校验。
- D 批：`godot-server-oninitialized.test.ts`（接线 + 负向断言）替换随功能删除的 8 个 roots 注入用例。
- 契约更新：LITE_TOOLS 补 `qa`/`analysis`；GUARDED_KEYS 补 `qa`（run=process 有意设计）；tool-count 20 处文档同步 43 工具/235 action（含 rule-templates.ts + godot-mcp-core.md 独立双副本）。
- 新增 L2 e2e：`test/e2e-qa-suite.test.ts`（真 Godot + 真 bridge 的 qa.run 端到端，`GODOT_MCP_E2E_L2=1` opt-in）。

## [0.29.0] - 2026-08-15

### ⚠️ Breaking / 迁移需知 — autoload 键名迁移(2026-08-14 批次,影响 bridge 安装)

- **autoload 键名去前缀,旧项目重跑 install 自动迁移**:≤0.28.3 的 `game_bridge_install` / `install_override` 在 `project.godot` 的 `[autoload]` 段写入**带 `autoload/` 前缀的坏键**(`autoload/MCPBridge`、`autoload/MCPOVERRIDE_<name>`)。autoload 段键名即 Godot autoload 节点名,`/` 前缀使多个键被 Godot 截断为同名 `autoload` 节点 → **`install_override` 注入的调试脚本不被加载(静默失效,批内实测复现)**;且 bridge 连接预检的裸字符串匹配对新旧形态判定不可靠 → `BRIDGE_NOT_CONNECTED` 误报。修复后:①写入侧键名无前缀(`MCPBridge` / `MCPOVERRIDE_<name>`);②**旧项目重跑 `game_bridge_install` 或 `install_override` 即自动迁移**(检测到旧键删旧写新);③`game_bridge_uninstall` / `uninstall_override` 双键清理;④读侧(连接预检)去前缀比较,新旧两种形态都正确判定——无需手动改 `project.godot`。

### Fixed — 2026-08-14 open findings 分批修复(editor/连接链)

- **P0 编辑器重启后重连恢复链死**:editor auth 失败被计入 reconnect exhaustion,但 exhaustion 事件从未 fire 降级回调 → 编辑器重启后 EditorConnectionManager 卡在不可用状态不自愈,须重启 MCP server。修复:auth 失败路径打通 exhaustion → 降级/恢复链(commit `c42c06c`)。
- **P1 遗留重连 timer 弹跳 + 并发 rebuild 竞态**:重连成功后旧 backoff timer 未清,后续 tick 把好连接当失联再次断开重连(连接弹跳);并发 rebuild 去重,防迟到的竞争连接误清胜者(commit `7a11d2e`)。
- **P3 debug 协程挂死 watchdog + WebSocket 握手超时回收槽位**:editor WS 协程中途 script error 时 reply 永不发出 → 客户端 30s 超时挂死;新增 watchdog 兜底发错误 reply。握手卡在 CONNECTING 的 peer 此前永久占用 MAX_PEERS 槽位,现握手超时回收(commit `cf8be32`)。
- **P2 server close() 清理链补漏**:close() 补 `registerBridgePushHandler`/`dynamicSchema.setFetcher` 两个模块级注入点清理(原持已 close 旧 server 闭包,热重启后 push 事件/动态 schema 错路由到死 server),清理链逐项 try 容错(commit `2fe4eeb`)。

### Fixed — 同批次(bridge / playtest 运行时)

- **P1 订阅断线静默丢失永不恢复**:bridge TCP 断连(60s idle/游戏重启)后 watch/monitor 的 push 订阅静默消失,重连后事件不再推送且无任何报错。修复:连接时登记订阅表 + 重连成功自动重发登记 + 30s keepalive 防 idle 断连(commit `889a712`)。
- **P2 playtest 永久暂停**:freeze 后若 step_until 请求在途,unfreeze 不清 pending 唤醒 → 游戏永久 paused 只能杀进程;现 unfreeze 清 pending。snapshot/restore 补 paused 状态保存-还原(`saved_valid` 守卫,不存在时还原为未暂停而非还原成假值)。`seed`/`fixed_delta` 补 owner 互斥(两 playtest 间锁状态不互斥可互相污染),`_playtest_active` 复位防悬挂(commits `72d8ffb`/`d323aea`/`fd82f64`/`be5bdb0`)。
- **P2 `step_until` 超时竞态**:TS 侧超时与 GD 侧 `wall_budget` 不一致,TS 先超时返回时 GD 循环仍在跑;TS 超时对齐 `wall_budget+5s` 余量,`wall_budget` 钳制范围改 1000-50000ms(commits `8e6d598`/`be5bdb0`)。
- **P2 headless + bridge 属性写入 no-op 假成功**:headless `edit_node` 数学类型属性(Vector2/3 等)传 Array/Dict 时静默不转换直接赋值失败却报成功,现补真实类型转换;bridge `set_node_property` 裸 `set` 对不存在属性/数学类型输入返回假成功,现补存在性校验(String 输入报错)+ 数学 coerce,plain var(未声明脚本属性)存在性放行(commits `7de9ed0`/`0bf53a0`/`71fb911`)。

### Fixed — 同批次(scene / 工具行为)

- **P1 `scene` commit 绕过编辑器写守卫 + 保存失败假成功**:commit 顶层 `success` 硬编码 true——编辑器场景只读未保存时照样"成功";现补 `checkEditorSceneSave` 守卫,保存失败如实报错,`isError` 条件改 success 驱动(覆盖 `stopOnError` 中止 corner)(commits `e590b64`/`7d40fc0`)。
- **P2 `audit` 工具不可见(生产 bug)**:audit 工具未归入任何工具组 → `isToolAllowed` 恒 false,基本/完整 profile 下均不可调用;现归入 core 组(commit `4cdc0ef`)。
- **P2 审计动态通道缺失**:CMP-16-B 动态注册工具经 `godot_advanced_tool` 代理调用时,审计中间件查不到静态 risk 表 → 危险操作不落审计日志;现接 A1 的 dynamic-risk-map 反查,补 9 场景集成测试 + wrapper 直接测试(commits `c11fd30`/`32b27ed`)。
- **P2 debug `reload_scripts` 会话串台 + breakpoint 路径穿越**:reload 改 `resolve_session()` 单 session 语义(多 session 明确报错,不再发 A 读 B);`set_breakpoint`/`clear_breakpoint` 补 `..` 穿越校验(commit `f7d518b`)。
- **P3 undo 回放 freed Object 防御**:undo action 注册期 args 中的已释放 Object(批孤儿扫描 free 后)`callv` 回放即 SCRIPT ERROR;注册期按 `typeof==TYPE_OBJECT and not is_instance_valid` 防御跳过(注意:`is` 对 freed 实例求值本身抛错,惯用法必须先 typeof)(commit `ef66213`)。
- **P3 `list_projects` max_depth 钳制 ≤10**:深目录递归扫描无上界,现钳制;转发孤儿执行观察 log(commit `c402158`)。
- **K-4 实测发现:TS 侧 bridge secret 读路径 ACL 收紧 `:R` 漏改 `:M`**:`readBridgeSecret()` 每次读 secret 用 icacls 收紧为 owner `:R`——GD 侧 `mcp_bridge.gd`/`websocket_server.gd` 的 `_restrict_secret_permissions` 已从 `:R` 改 `:M`(R 是 anti-pattern),但 TS 第三副本漏改,把 GD 写路径的 M 覆写回 R → R-only secret 删不掉(无 DELETE 权限)→ e2e L2 结束后清理失败 → 后续连续跑 e2e 整 suite 静默 skip(本地实测复现,两次干净跑 75 passed、第二次起 beforeAll EPERM 全 skip)。现对齐 `editor-auth.ts:32` 改 `:M`(本批次)。
- **`test_run` editor 路径自 P2-12 起不可用**:GD `websocket_server` reply 构造用点访问读不存在的 `result` 键即 SCRIPT ERROR,`test_run`/`test_manage` 返回 `{"data":...}` 形态的 coroutine 在发 reply 前中断 → 客户端 30s 挂死;reply 改 `response.get("result", response.get("data"))`(commit `ffd6172`)。
- **K-1 push 通知只发已订阅客户端**:`resources/subscribe` 此前为空 handler + push 事件无条件广播,违反 MCP 协议(notifications/resources/updated 应只发订阅者)且 capabilities 未声明 `subscribe: true`;现订阅记录(Set,重复订阅幂等)/unsubscribe 移除/push 仅发已订阅 `bridge://events` 客户端,与 watch_start/monitor_start 文档"client 需订阅 resources/subscribe"语义对齐(本批次)。

### Security — 同批次

- **write_script 沙箱 3 个旁路入口封堵(SEC-P1-1)**:`quick_scene`/`create_files`/`apply_template` 三个写 `.gd` 入口裸 `writeFileSync` 绕过 `scanScriptSandboxOrThrow`(tscn 绑 ExtResource 后编辑器打开/run_project 即执行,与 write_script 同一威胁面);现统一接线落盘前扫描,危险 `.gd` 拒入 failed 不落盘(commit `7d967eb`)。
- **`engine call_method` deny-list 拼写错误 + 内层检查(cmp-9 关联)**:deny-list 条目拼写错误致对应方法从未被挡;补 args 带内层方法名的间接调用检查,契约测试从 `godot-classes.json` 生成防拼写再固化(commit `b7aaf52`)。
- **`load_skill` libraries 白名单 + API nonce 持久化防 symlink 覆写**:`load_skill` 的 `libraries` 参数可读白名单外路径,现限 ALLOWED_PROJECT_PATHS;多实例 API nonce 持久化时补 symlink 预检(commit `effb5fc`)。
- **project create `godot_version` 注入面校验**:`create_project`/`apply_template` 的 `godot_version` 直接进 CI 生成物,现补格式校验(支持 `4.4.1-rc1` pre-release 形态)(commits `3b80e36`/`dd09899`)。

### Docs — 同批次

- **telemetry 披露对齐实现**:`error_category` 字段表改为 T1 固定枚举(原文暗示自由文本与实现矛盾);vision 外传截图描述改为降采样后数据(PNG 最长边 1024px、超 1MB JPEG 拒传),对齐 `screenshot.ts` 实际行为(commit `9bc9aa5`)。
- **blender 工具描述对齐自身沙箱**:`execute_bpy` 描述补"已知危险 API 模式扫描 + 双 opt-in 旁路",对齐 `bpy-sandbox.ts` 实际防护(此前描述低估)。

### Tests — 同批次

- **debug 子系统 e2e 首次真跑**:3 用例(breakpoint 命中/stack_trace/断点穿越校验),新增 `test_debug_driver.gd` 在 editor 主循环内代按"运行场景"驱动(实测踩坑:test_name 子串匹配陷阱/断点注释行陷阱/声明行无 opcode 不命中均记录于批 H 报告);发现并修复上述 `test_run` 挂死。
- **`batch_add_nodes` editor 套件**:5 用例对齐 test_undo_manager 范式真跑绿,锁定 B5 `is_inside_tree()` 计数契约。
- **undo_manager e2e 首次真跑**:修 action 键笔误与两处解析 bug(从未真跑过故从未暴露),commit `66b615e`;e2e-full 补 `.godot` 缓存清理对齐 p1-p5 模式(commit `1075ed7`)。
- **K-1/K-2 行为锁定**:subscribe→push 仅达订阅者/未订阅不收/重复订阅幂等/unsubscribe 停发/close 清理 10 用例;真实 SDK 实测锁定"声明 logging capability 即自动注册内置 setLevel handler"(finding :942④ 前提不成立,详见 test/k-subscribe-setlevel.test.ts)。

### Security — 2026-08-11 审查 open findings 批次(A1-A7)

- **A1 [P1] 动态工具 confirm/action-gate 双绕过修复**:CMP-16-B 动态注册的平铺工具(`engine_call_method`/`debug_evaluate` 等)不在静态 metaRegistry → guard 查不到 risk 永不确认、action-gate 永不命中,等价静态调用(write 需确认)经动态通道绕过双层门。修复:`src/core/dynamic-risk-map.ts`(method→静态 (tool,action) 反查表)+ ToolDispatcher 两道门用反查结果判定;未映射动态方法 fail-closed 要求确认。双副本与 `check-command-docs-drift.mjs` 的 METHOD_TO_TOOL 经契约测试同步。
- **A2 [P1] debug 异步请求 _states 串台修复**:editor WS packet 循环不串行化 coroutine,两个并发 evaluate/inspect_frame 竞争同一 `_states[session_id]`(eval_result 单槽被后发者重置/错消费)。修复:websocket_server debug 请求 in-flight 互斥(新请求立即拒绝,120s stale 自愈)。
- **A4 [P2] debug session 归属错配修复**:`current_break()`(第一个 breaked)与 `active_sessions()[0]`(首个 session)可能指向不同 session,evaluate 发 A 读 B。修复:新增 `resolve_session()` 单 session 语义(多 session 明确报错),stack_trace/inspect_frame/evaluate 三件套统一接线。
- **A5 [P2] bridge EXTRA_METHODS_BLOCKLIST 补间接调用入口**:补 `call_deferred`/`call_threadsafe`/`queue_delete`(可经 args 带内层被禁方法名绕顶层 BLOCKLIST)。
- **A6 [P2] multi-instance HMAC token 加固**:补 timestamp future-skew 上界(5s,原远未来 token 在真实时间追上前持续有效)+ 已用 nonce 持久化 `~/.godot-mcp/.api-nonces.json`(原重启清内存,60s TTL 重放窗口重开;失败降级内存-only)。

### Fixed — 同批次 GDScript 修复(B1-B5,行为契约测试 gd-open-findings-contract)

- **B1 [P1] debugger_bridge 生命周期修复**:`EditorDebuggerPlugin` extends RefCounted,面板信号连接持有绑定 bridge 的 Callable(引用计数)——从不 disconnect 则 bridge 永不释放,插件 reload 后残留连接致新 bridge 重连同一持久化面板、调试器消息双重处理。修复:`_connect_tracked` 登记 + `dispose()` 断全部信号 + `_exit_tree` 接线(引用归零自动释放,不手动 free——check:gdscript 实测 RefCounted free() 报错,审查原始描述"需手动 free"有误)。
- **B2 [P2] _capture/面板信号双重消费 vars 翻倍**:计数去重协议(capture 权威,面板回调发现自己序号 ≤ capture 已消费数时跳过;capture 不触发时面板兜底全量)。
- **B3 [P2] instance_registry 多实例互删**:删除验 pid(原 B 退出删掉 A 的 registry 文件)+ tmp 文件 pid 后缀(原固定路径两实例交错损坏)。
- **B4 [P2] bridge `_jsonify` 补 Object 分支**:非 Node/非 Resource Object 返 `{type, instance_id}`,对齐 editor 侧序列化(原 return val 原样,JSON.stringify 可能失败)。
- **B5 [P2] `batch_add_nodes` added 假成功**:added 改基于 `is_inside_tree()` 真实计数(原 `validated.size()` 把 C11 孤儿扫描 free 掉的也计入)。

### Changed

- **A3 [P2] `GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE` 语义改追加**:env 非空 → env ∪ DEFAULT_CALL_DENYLIST(只能加不能减;原完全替换是 footgun,想多挡一个方法会丢全部默认防护)。显式空串 = 完全放开(逃生口保留)。

### Tests

- **C2 弱断言精确化收尾**:11 处 `includes().toBeTruthy()` → `toContain`(含 instance-scene 4 处 OR 模糊匹配改解析 `error_code` 精确断言)+ 3 处 `length>0` 拆分。
- **C3 project-management 失败分支**:补 7 个 fs 级错误分支用例(缺 project.godot/非法 renderer/已存在项目/白名单外 key/UNKNOWN_ACTION;核实 project.ts 不调 executeGdscript,mockFailureResult 形态不适用)。
- **C5 L2 CI 假接线修复**:`GODOT_MCP_E2E_L2=1` 在 ci.yml matrix 早已设置,但 e2e 内三个 L2 describe 的 skipIf 含 `process.env.CI` 永真短路(从未真跑)。去 CI gate + matrix E2E 步骤包 `xvfb-run`(L2 run_project 起游戏进程需显示);editor 韧性 weekly cron 改每日(回归窗口 7 天→1 天)。

## [0.28.3] - 2026-08-13

### Added — 战略批收尾（14 竞品路线图 G1/G3/G7 落地，详见 [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)）
- **G3 操作级审计日志**（借鉴 devtool）：danger-api 操作落 `audit.jsonl`（timestamp/operation/changedFiles/details），`appendFile` 原子追加修复 devtool read-modify-write 竞态（多实例并发安全）；confirm gate 真实审计修复（原 getActionRisk 耦合致令牌虚假 ok 绕过审计）。
- **G1 deterministic playtest control 层**（借鉴 satellite）：`freeze`/`unfreeze`/`step_until` 三 action，结构化条件（frame/signal/property/state）规避 Expression RCE；process_mode=ALWAYS 保 bridge freeze 后不自停。
- **G7 能力 profile 默认面**（借鉴 GoPeak）：basic（9 组：core/bridge/animation/audio/signal/visual/code/test/profiler）/ advanced / full 三 profile，复用现有 securityLevel 三层自动分 profile。**BREAKING**：默认 profile 从 full 改 basic（schema 79KB→~30KB，省 ~60% context window）；`GODOT_MCP_PROFILE=full` / `manage_tools` 可切回 full。

## [0.28.2] - 2026-08-12

### Security
- **SEC-P2-1**: `test-framework.ts` 补 `requireProjectPath` root 白名单校验（原裸 `validatePath` 仅 resolve 零安全校验，依赖全局门兜底）。
- **SEC-P2-2**: editor + bridge 两处 GD 侧 secret 写加 symlink 预检（Windows PowerShell `Test-Path`+`Get-Item LinkType`+`exit 3` 拒写；Linux/macOS `readlink` 检测。防预置 symlink follow 覆盖目标文件）。
- **SEC-P1（披露）**: vision-router 外传截图 base64+prompt 到 groq（commit `6f068e8` 引入，双重 opt-in 门控默认零外传）。[docs/telemetry.md](docs/telemetry.md) 补「非 telemetry 外传点：Vision Router」段完整披露外传内容/门控/可控边界/endpoint 覆盖（`GODOT_MCP_VISION_BASE_URL`）。

### Added
- **Tier1-1 structuredContent**: `add_node`/`screenshot` 成功路径补 structuredContent（action/node_name/node_type + image_path/width/height/blank_warning）。
- **Tier1-2 scene_editing_strategy prompt**: 三层 SOP prompt（能力发现 + 决策树 + 闭环验证），引导 LLM 正确调用工具。
- **Tier1-3 execute_gdscript 引导**: script 工具 description 加分步执行最佳实践（每步验证，避免一次性大脚本出错难定位）。
- **Tier2-1 skills**: 新增 3 个 godot skill（godot-router 路由器 / screenshot-verify 视觉验证 / godot-tween-taste Tween 审计）。
- **Tier2-2 tscn parser**: 补 Vector2i/Vector3i/PackedInt32Array/Transform3D 四类型解析（原 fallback 字符串丢失）。
- **CMP-13 generate-all-modules**: 构建期从 module-loader import 块自动生成 ALL_MODULES 数组（新增工具只需加 import 行）。
- **Vision Routing**: `screenshot` analyze action 加 `vision_route` 参数，把截图路由到视觉模型（groq llama-4-scout）翻译成文字描述，让纯文本模型也能"看"截图。双重 opt-in 门控（`vision_route=true` + `GODOT_MCP_VISION_KEY`，默认零外传）。详见 [docs/telemetry.md](docs/telemetry.md) 诚实披露段。
- **G2 trace_id + 结构化错误分类**（速赢批，借鉴 xulek，commit `20f9832`）：每响应附 `trace_id`（16hex 全链路）+ `duration_ms` + 结构化 `error_category`（7 类）+ `retryable`；PII 护栏（主 catch 类型映射，`err.message` 不直泄 client）。审查 SHIPPED WITH NITS（EditorToolExecutor catch→return 盲区 deferred，详见 [docs/reviews/](docs/reviews/)）。

### Security（加固批次）
- **S-1/S-2**: bpy-sandbox 双 opt-in 对齐（`GODOT_MCP_ALLOW_UNSAFE` + `execute_bpy` 显式门）+ spawn 清单补全（commit `53d80be`）。
- **S-3~S-7**: 多实例 registry/editor-auth/http-server 加固（commit `6fe24b7`）。

### Fixed
- **P0（F-6 CRITICAL）**: `animtree_state_edit` sub_action 死代码修复（commit `eed26f2`）。
- **P1（F-1/F-2）**: data-import timeout 钳制 + isErrorText 测试加固（commit `2ee8cc2`）。
- **P2（F-3/F-4/F-5/F-7/F-8）**: 工具层校验精确化（commit `690838d`）。

### Docs
- **G8 威胁模型文档**（借鉴 satellite）：[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) 声明 10 层防护实测 + accident guard 边界（诚实区分 accident guard vs security boundary，commit `db44d43`）。
- deprecated 注释纠偏 + 全功能审计文档（F-Nit / 2026-08-12 audit，commit `619ab6a`）。

### Testing
- **P2-6**: `waitForEditorSecret` 时序状态机 characterization（4 测试：超时返 null 不抛错 / 无跨调用缓存 secret 刷新读到新值 / 轮询 pickup 200ms / 空内容继续轮询）。
- 新增 `check:changelog-sync` CI 检测（advisory）：`fix(security)`/`feat`/`BREAKING` commit 漏登 `[Unreleased]` 时 warn。

## [0.28.1] - 2026-08-11

### Security
- **批次 C 安全加固**（commit `fdf04ec`）：deny-list / symlink / path / debug.evaluate RCE 多点加固。
- **instance_registry 目录权限**（commit `6bb2755`）：Linux 收紧到 0o700（P2-4）。

### Testing
- 弱断言精确化 + 接线守护批次（P1-3~P1-5 / P2-1 / P2-2：cpp `stubEnv` 隔离 / game-bridge TCP 分片重组 / dispatcher `isPathInAllowedRoots` 接线守护 / scene `add_node` 错误路径 / `length>0` 与 `isError` 全局精确化）。

### CI / Docs
- ci: MULTI_INSTANCE 接入 godot-matrix 版本矩阵（P1-2）。
- docs: 全批次第三方审查文档（SHIPPED WITH NITS，无 Blocking，commit `9b53dcb`）+ script 工具描述沙箱措辞 generic 化（P2-2，commit `17e22a3`，本 commit 引入 0.28.1 version bump）。

## [0.28.0] - 2026-08-09

### Added — CMP-14 debug Phase 2/3 + 后续批次(CMP-16-B/C advanced-proxy/drift 扩充 + CMP-9 confirm gate)

**CMP-14 debug Phase 2/3**(debug 工具组从 3 action 扩到 10,完整交互式调试器):
- **新建 EditorDebuggerPlugin 子类**(`debugger_bridge.gd`):hook 调试器信号,拿 EditorDebuggerSession,处理 stack_dump/stack_frame_vars/evaluation_return 消息
- **Phase 2 栈帧/变量**:`stack_trace`(读调用栈+变量)/ `inspect_frame`(切帧+读变量)/ `evaluate`(断点上下文 REPL)
- **Phase 3 执行控制**:`step`(into/over)/ `continue`(继续到下断点)/ `pause`(请求中断)— 走"按图标找按钮 emit pressed"(send_message("step") 需 thread id 设不了)
- **热重载**:`reload_scripts`(指定脚本重载到运行中游戏)— 4 道安全守卫(playing/session/暂停态拒/MCP 自身保护)
- **异步路由**:`handle_debug_async`(对标 handle_nav_async),websocket_server 按 debug_ 前缀分流(Phase 1 断点保持同步)
- **自动打开脚本**:修 Phase 1 限制(`EditorInterface.edit_script`),set_breakpoint 不再要求脚本已激活
- 对标竞品 regiellis/godot-mcp-go debug 组 + Godot-MCP-Native 调试能力

**CMP-16-B advanced-proxy 改造**:`godot_list_dynamic_routes` 从"假动态"(只读本地)改真动态(调 dynamicSchema.getDynamicTools 拉 editor addon 命令),修复"文档过承诺"技术债

**CMP-16-C drift 映射表扩充**:从 7 method(debug+engine)扩到全 64 method(57 + 7 新 debug),括号匹配版 extractTsSchemas + KNOWN_RENAMES/KNOWN_SCHEMA_SIMPLIFIED 豁免

**CMP-9 confirm gate 二期**:engine call_method 的 confirm gate 通过 CMP-9-A actionRisks=write 自动生效,加守护测试防回退

## [0.27.0] - 2026-08-08

### Added — CMP-9 双通道通用方法调用 + CMP-16 live schema(竞品 regiellis/godot-mcp-go 深度对标)

**CMP-9-A editor 通用方法调用**（`engine` 组新增 `call_method` action）：
- 编辑器场景树节点实例方法调用(对标竞品 `node.call`)。AI 可调任意 ClassDB 暴露的实例方法,不必为每个方法写专用 wrapper。
- 安全护城河:deny-list 默认挡危险方法(`free`/`queue_free`/`set_script`/`call`/`emit_signal` 等),env `GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE` 可定制。不照搬竞品"无过滤"缺陷。
- args 按方法声明类型自动强转(传 `[1,2,3]` 给 Vector3 参数正确转换)。方法不存在时 did-you-mean 建议。response 显式 `undoable=false`。

**CMP-9-B bridge 通道放宽**（`_cmd_call_method` 增强）：
- 复用现有 `GODOT_MCP_BRIDGE_EXTRA_METHODS` env 扩展写/副作用方法(对标竞品 `runtime.call`)。向后兼容,不设 env 时行为不变。
- 新增 did-you-mean + args 类型强转 + `undoable=false`。`EXTRA_METHODS_BLOCKLIST` 硬底线保留。

**CMP-16-A GD param docs metadata**（13 个 command 文件）：
- 每个 command module 实现 `get_command_docs()` 返回结构化 param docs(对标竞品 `base_command.gd doc_param`)。
- `command_handler.gd` 新增 `list_param_docs` 聚合入口(对标竞品 `engine.commands {docs:true}`)。
- `command_helpers.gd` 新增 `doc_param` helper + `godot_type_to_schema_type` 类型映射。
- 共 57 个 method docs 覆盖全部对外 command。

**CMP-16-B TS live schema 构建**（对标竞品 `serve.go fetchTypedTools + buildTypedTools`）：
- 新增 `src/core/dynamic-schema.ts`:从 editor addon 拉 param docs 动态构建 MCP 工具。
- 缓存 + editor 离线降级(返空,只留 `godot_advanced_tool` 兜底)。editor 重连时刷新(修竞品"只 fetch 一次"缺陷)。
- 排序保证幂等 + 名字冲突保留先到 + 体积自限。
- `tool-registry.ts` 新增 `registerDynamicTools` API(动态工具归入 `dynamic` 组,`isToolAllowed` 放行)。
- `GodotServer.ts` tools/list handler merge 动态工具。

**CMP-16-C drift 检测 CI**：
- 新增 `scripts/check-command-docs-drift.mjs`:比对 GD param docs 与 TS inputSchema 参数一致性。
- 一期覆盖 debug + engine 工具组(7 method),其余 50 method 标一期豁免(映射表后续扩充)。
- 已接入 `npm run check:command-docs-drift` + CI。

**CMP-13**:确认已以替代方案(`check:tool-groups` CI invariant 脚本)落地,标记完成。

## [0.26.0] - 2026-08-08

### Changed — P1+P2 批次修复（18 项审查 finding 闭环，竞品对标 + 可靠性 + GDScript 健壮性 + 安全）

**P1 批次（7 项）**：
- **GD-R1** nav bake_mesh_async status/success 同源（消除 deadline 耗尽但 mesh 已生成时矛盾语义）
- **GD-R2/IPC-R7** `_ErrorCapture` _in_log 复位结构重构（GDScript 无 try/finally，有风险操作集中 _capture_entry 辅助方法）
- **GD-R3** debug_commands 注释对齐实现（get_current_script 非 get_open_scripts）
- **IPC-R1/R5** STARTUP_CLEANUP env 传递改显式 options 参数（消除 env 全局状态与周期 orphan 扫描竞态）
- **IPC-R2** 删除 CMP-6 gap 检测（挂在 message 事件但 OS 挂起后无消息恰好不触发，"检测但不动作"是最差状态）
- **IPC-R3** nav bake/test_run 长操作暂停 TS 心跳（pauseHeartbeat/resumeHeartbeat，防 75s 误降级）
- **SEC-P1-1** write_script/edit_script 沙箱扫描（scanScriptSandboxOrThrow 4 写入点阻断式，对齐 execute_gdscript）

**P2 批次（11 项）**：
- **GD-R4** engine enum 补返回值（class_get_enum_constants + class_get_integer_constant，ENUM_CONSTANTS_LIMIT=50）
- **GD-R5** undo_manager reference op Resource 分支警告显式化
- **GD-R6** engine search 字母序排序（原 ClassDB 注册序不可预测）
- **GD-R7** debug _get_current_code_edit 返 Dictionary 含 reason（区分版本不兼容/无 tab/类型不符）
- **GD-R8** scene save_scene_as 错误诊断细化
- **GD-R9** export Array/Dictionary JSON 化（原 str() 非 JSON）
- **GD-R10** recording editor 路由移除（3 个永远返 -32009 的噪音路由 + static-grep 登记同步删）
- **IPC-R4** 重连后 sendLoggingMessage 通知场景树 stale
- **IPC-R6** health-monitor baseline 用 trimmedMean 排除离群点（防 GC 卡顿拉高 baseline）
- **CMP-7** editor instance discovery（addon 新建 instance_registry.gd 写 JSON + 30s lastSeen + 原子写；TS 侧 pid liveness probe）
- rule-templates.ts + .claude/rules 同步补 write/edit 沙箱扫描说明

4667 测试。三次第三方审查（P1 SHIPPED / P2 初审 BLOCKING→修后 SHIPPED / 全量合并 SHIPPED WITH NITS）。

## [0.25.11] - 2026-08-08

### Added — CMP-4 实时 ClassDB 内省（2026-08-08，竞品 godot-mcp-go 深度对标产出）

- **新增 `engine` 工具组（editor-only）**：3 个 action——`class_info` / `search` / `get_inheritance`。走 editor 层直调 ClassDB（不经沙箱），让 AI 发现运行中引擎的实际可用类/方法/属性/信号/枚举。补静态 docs 工具（extension_api.json 4.7 快照，不含第三方 addon/自定义类/4.6/4.8 差异）的缺口。
  - GD 侧新增 `engine_commands.gd`（3 handler + ClassDB.class_get_property_list/method_list/signal_list/enum_list + get_class_list + get_parent_class + Variant.Type 名称映射 + SEARCH_LIMIT=100 防全量返回）。
  - 心智模型：静态查 docs / 实时查 engine。docs 是离线 4.7 快照，engine 是运行中引擎的真实 ClassDB。
  - 9 个新测试（`test/engine-tools.test.ts` TS 契约 + GD 契约 + 注册链路 + static-grep drift）。

## [0.25.10] - 2026-08-08

### Added — CMP-3 debug 组 Phase 1 断点管理（2026-08-08，竞品 godot-mcp-go 深度对标产出）

- **新增 `debug` 工具组（editor-only）**：3 个同步 action——`set_breakpoint` / `clear_breakpoint` / `list_breakpoints`。走 CodeEdit gutter 路径（竞品验证可行），断点进入 editor breakpoint map：gutter 可见 + 现行 game 命中 + 下次 run 同步保持。AI 能预置断点，用户 F5 运行后命中——从无到有的质变。
  - GD 侧新增 `debug_commands.gd`（3 handler + CodeEdit gutter + 二次校验 + 1-based→0-based 行号转换 + res:// 路径校验）。
  - Phase 1 限制：脚本必须在编辑器中打开且是当前活跃 tab（避免异步等帧复杂度，纯同步分发）。
  - 10 个新测试（`test/debug-tools.test.ts` TS 契约 + GD 契约 + 注册链路 + static-grep drift）。
  - 留 Phase 2：step/resume/pause + 栈帧/变量读取（需 EditorDebuggerPlugin + async 分流）。
  - 留 Phase 3：热重载 + 永不命中行检测 + hot callback 警告。

## [0.25.9] - 2026-08-08

### Added — CMP-2 game bridge runtime error 捕获（2026-08-08，竞品 godot-mcp-go 深度对标产出）

- **game bridge 通道新增 runtime error 捕获**（`src/scripts/mcp_bridge.gd`）：新增 `_ErrorCapture` 内部 Logger 子类，`_ready()` 注册 `OS.add_logger`，捕获游戏运行时 `push_error` / 脚本 setter 报错 / 信号回调错误，存入 ring buffer（MAX_ENTRIES=200）。AI 现在能看到游戏运行时错误，不再只靠 `take_screenshot` 间接推断——闭环调试。
  - 新增 2 个 bridge method：`get_errors`（支持 `since_seq` 增量查询 + `clear` 读即焚）、`clear_errors`（清空 buffer）。
  - 错误结构：`{seq, kind, message, code, function, file, line}`，`kind` 分 `error`/`script`/`shader`/`warning`。
  - 捕获全部 4 种 Godot ErrorType（NIT-1 修复后超越竞品只捕 SCRIPT/SHADER/WARNING）。
  - re-entrancy guard（`_in_log` flag）防 error storm 递归卡死；message/code/function/file `substr(0, 4096)` 截断防撑爆消息上限（NIT-4）；rationale 优先于 code（Godot 把错误文本拆两段，前者是人话描述）。
  - `_exit_tree()` 注销 logger（Logger 是 RefCounted，remove_logger 让引擎 logger 链释放引用）。
  - 11 个新测试（`test/regression/bridge-error-capture-contract.test.ts` GD 契约 + `test/game-bridge.test.js` 白名单 + `test/workflow.test.js` size 断言更新）。

### Security — CMP-1 editor 项目匹配检查（2026-08-08，竞品 godot-mcp-go 深度对标产出）

- **editor 连接建立后校验项目匹配**（`src/GodotServer.ts`）：连接成功后发 `editor_get_project_path` RPC 读 editor 的 `res://` 绝对路径，与 `resolveProjectPath()` 结果归一化比对。mismatch → disconnect + 返回 `connected: false`（走降级路径：`noFallback` → exit，否则 → headless）。防跨项目误操作（A 项目开 editor + MCP 配 B 项目 → 拿 A 场景树当 B 操作）。`editorProjectPath=null`（无 project.godot 上下文）→ 跳过校验不阻断。归一化：反斜杠→正斜杠 + 去尾分隔符 + Windows lowerCase + junction/symlink `safeRealPath` fallback。
  - GD 侧新增 `editor_get_project_path` RPC（`addons/godot_mcp_server/command_handler.gd`）：复用 `ProjectSettings.globalize_path("res://")`（与 `websocket_server.gd` `_get_project_dir()` 同款），不依赖 EditorInterface/打开场景。
  - 覆盖三条路径：首次连接（`establishEditorConnection`）、显式 rebuild（`rebuildEditorConnection`）、自动重连（`addOnReconnectHandler`，NIT-1 修复后补重校验 + handleEditorStall 降级）。
  - 10 个新测试（`test/editor-project-check.test.ts`）+ 4 个集成测试 mock 更新（`editor-fallback-integration.test.js` + `godot-server.test.js`）。

### Changed — rule-templates.ts 同步（触发 version bump 0.25.8→0.25.9）

- `src/tools/rule-templates.ts` bridge 段补 `get_errors`/`clear_errors` method 表行。触发 check-rules-version-bump 强制 version bump（0.25.8→0.25.9）。

## [0.25.8] - 2026-08-07

### Fixed — 2026-08-07 审查待办批量修复（5 批 × 60 项 → 26 项新代码 + 13 项核实已落地）

基于 2026-08-07 六份审查报告整理的 60 项真实待办，分 5 批修复。分支 `fix/batch1-gdscript-fake-success` + `fix/batch2-ts-reliability` + `fix/batch4-test-gaps` + `fix/batch3-security-depth` + `fix/batch5-docs-cleanup`（本批）。

- **批次1 GDScript 假成功与清理不对称（10 项 P1/P2）**：save_scene/load_sprite/screenshot 失败补 `quit(1)`（防假成功致数据丢失却报告成功）；_cleanup_peer_state 补清 _playtest_snapshot（防内存泄漏+误恢复）；_cmd_playtest_restore 加 Resource/Node 反向转换（防类型损坏）；export_commands/animtree/asset 类型校验与 null 守卫；recording MAX_ZERO_DELAY 达上限不重发；序列化补 _is_safe_value；inspect_node/query_scene_tree scene_path traversal 过滤。
- **批次2 TS 可靠性（7 项 + 3 项核实已落地）**：resetBridgeState 清 push 子系统状态；STARTUP_CLEANUP 临时设 FULL_SYSTEM_SCAN 让第二层也跑（防 no-op 虚假安全感）；health-monitor baseline 滑动重算（防冷启动误判）+ degraded 不被心跳过早清除（防掩盖工具层失败）；establishEditorConnection rebuild 显式 destroy；playtest owner_pid 多 peer 独占保护。核实已落地：nav bake 超时对齐 / headless spawn orphan 清理 / 心跳降级 B-T5 分流。
- **批次4 测试缺口（7 项 + 4 项 deferred）**：P3-6 socket 竞态并发测试（P0）；C# dotnet build 失败原子回滚测试；4 个 CI 守门脚本（rules-sync / matrix version / C7 目录式 / protocol-versions）。
  - *deferred 明细*（4 项）：① guard actionRisks CI 校验——当前无缺口（破坏性工具都已覆盖），留 follow-up；② bridge change_scene 断连 characterization——需 weekly GUI editor 环境真跑，留 follow-up；③ runtime auth 超时 characterization——同上需 weekly；④ EditorConnection 进程级状态/Windows GUI/项目内 addons——3 类已知盲区（无低成本测试方案），记录性质靠人工反馈。
- **批次3 安全纵深（2 项 + 3 项核实已落地）**：FileAccess READ 非 Godot 协议路径拦截（决策2 升级版，对齐 load() 非 res:// 拦截）；网络回连 API（WebSocketPeer/HTTPClient/StreamPeer）进沙箱清单；stripLiterals 扩 GODOT_PROTOCOLS 支持 res://+user://。核实已落地：execute_bpy 沙箱扫描 / headless 白名单 / defects detect 修正。
- **批次5 文档收尾（4 项 + 2 项外部提示词留用户）**：update-checker 门控文档漂移修正（README×2+CHANGELOG）；update-checker 门控语义健壮化（`=== 'false'` → `/^(false|0|no|off)$/i`，认 falsy 变体+大小写不敏感）；docs/telemetry.md safeErrorCategory 删除标注；launch_editor 崩溃恢复路径文档化（rule-templates editor 段）。
- **外部提示词文件（`D:/AI/提示词精选/godot-mcp-enhanced/`）**：提示词画像过时（#4）+ create_action_mixed 数字滞后 38→69（#6）不在本仓库，留用户更新。本轮所有审查已跑基线实测对照画像，审查流程验证有效。

### Changed — rule-templates.ts 同步（触发 version bump）

- `src/tools/rule-templates.ts` editor 段补「launch_editor 崩溃恢复」文档化条目（fire-and-forget 语义 + 非 PERSISTENT_SECRET rebuild 失败说明 + B-T5 心跳降级分流）。触发 check-rules-version-bump 强制 version bump（0.25.7→0.25.8）。

### Fixed — 2026-08-06 全风险面审查修复（6 份提示词 × 44 findings 分 5 批）

基于 `D:\AI\提示词精选\godot-mcp-enhanced`（通用版 + 专项1-5）对 v0.25.2~v0.25.7 新增 8 个子系统的全方位审查。报告见 Obsidian vault `开发日志/2026-08-06 *.md`（6 份）。

**P0 致命 bug**：
- **action-gate key 漏配**（`src/core/action-gate.ts:19`）：`GATED_ACTIONS['code-execution']` 写 `'runtime.execute_gdscript'`，但 execute_gdscript 实际工具名是 `script` → isActionGated 永不命中 → gate 形同虚设。一行修：`runtime` → `script`。补单测反向断言 + defects detect `action-gate-key-toolname-match`（CRITICAL 防漂移）+ check-contract C7
- **MRTR GODOT_MCP_ALLOW_UNSAFE_CONFIRM 绕过**（`src/index.ts:15`）：启动拦截 dangerousBypassFlags 漏此 env，生产误设则 AI 可自确认 token 直执。补列表
- **runtime_assert screenshot_diff 假阳性**（`src/tools/runtime-assert.ts:264`）：占位返 `pass()`（success:true）致 agent 视觉回归假绿。改返 `error_code: 'NOT_IMPLEMENTED'`

**P1 安全沙箱对称**：
- **overrides 注入不走沙箱**（`src/core/overrides.ts:80`）：installOverride 注入任意 .gd 到项目 autoload 段（_ready=任意代码执行），未调 scanGdscriptSandbox（与 execute_gdscript 严重不对称）。补沙箱扫描 + 双 opt-in 旁路（DISABLE_SAFETY/ALLOW_UNSAFE）
- **C# dotnet build 无沙箱**（`src/tools/script.ts:134`）：csharpValidateAndRevert 调 dotnet build 执行任意 MSBuild Target = RCE 面。加 `GODOT_MCP_PRIVILEGED_GROUPS=code-execution` opt-in 校验；**BREAKING**：已有 C# 项目的用户编辑 .cs 需设此 env 才走 build（未设则 skip）。回滚改原子写（tmp+rename）；抽公共 `runDotnetBuild` helper 消除 `validation.ts:913` 漂移

**P1 GDScript + 进程通信**：
- **playtest physics 锁 peer 断线无 restore**（`src/scripts/mcp_bridge.gd:_cleanup_peer_state`）：peer 断线后 Engine.physics_ticks_per_second 等全局值永久停留测试值。补 restore + step_pending 按 pid 过滤
- **`_collect_node_snapshot` 无递归上限**：大场景 OOM/栈溢风险。加 PLAYTEST_SNAPSHOT_HARD_STOP=50000 守卫
- **set_instance_property owner 误拒**（`addons/.../scene_commands.gd:183`）：`owner != root` 误拒合法嵌套 instance 子节点。改只拒场景根
- **test_assert property_equals 缺 BLOCKED 守卫**（`addons/.../test_commands.gd:33`）：可读 script 等敏感属性。补 BLOCKED + `_` 前缀 + `:`/`/` 守卫 + Object jsonify
- **EditorConnection reconnectExhausted 迭代中修改**（`src/core/EditorConnection.ts:490`）：handler 内调 disconnect().clear() 致后续 handler 静默丢失。三处 fire* 统一加 `Array.from()` 快照 + reconnectExhausted 补 try/catch

**测试加固**：
- `playtest-gd-contract.test.ts` 扩 4 describe 校验三副本 BLOCKED_PROPERTIES 含 instance + 字面量一致
- 3 个 e2e beforeAll 加 `.godot` rmSync（对齐 e2e-p1-p5:53 模式）
- `defects.ts:705` instance detect 加 command_helpers.gd 第 3 副本
- 新增 `runtime-assert-screenshot-diff.test.ts` 锁定 NOT_IMPLEMENTED known-limitation
- 新增 `overrides.test.ts` 3 沙箱扫描测试

**P2/P3 收尾**：
- nav bake timeout 改可配（`navigation.ts:493`，validateTimeout clamp 30-600）
- check-contract 新增 C7 action-gate key × tool_registry 一致性校验
- `docs/telemetry.md` sendBatch 段标注 Stage 0 stub + 新增 dotnet MSBuild Target 外传披露 + update-checker env 门控段更新
- help 候选路径加 `path.basename` 纵深防御
- update-checker 加 `GODOT_MCP_UPDATE_CHECK=false` env 门控

**基线订正**：T3「config.ts readFileSync 未包 try/catch」审查基线声称 open，实测 :37-39 已包 try-catch **已闭合**（提示词漂移）。

**第三方审查 NIT 修复（2026-08-07，commit af63b77）**：

- **NIT-1 [威胁面泄漏]**：`src/tools/validation.ts:912` validate_project 的 dotnet 调用未对称 gate（抽公共 runDotnetBuild helper 后 script.ts 做了 opt-in 但 validation.ts 漏）。补 `GODOT_MCP_PRIVILEGED_GROUPS=code-execution` 校验，未 opt-in 时 `status:'skipped'`
- **NIT-2 [workflow 必崩]**：`.github/workflows/editor-e2e.yml` undo_manager step 原用 `GodotServer.makeCtx()`（不存在）+ 错误构造签名，weekly 首跑必崩。新建 `test/e2e-testing-undo-manager.test.ts`（复用 e2e-resilience-editor 的 spawn + EditorToolExecutor 模式），workflow 改跑此 vitest 文件
- **NIT-3 [测试盲区]**：`test/script-csharp.test.ts` 补 PRIVILEGED_GROUPS gate 测试（现有 .cs 测试都走"无 .csproj"路径到不了 gate 校验，补 1 测试建空 .csproj + 不设 env 断言 skip）

**补充修复（5 个原 TODO 全部落地）**：

- **#1 EditorConnection 崩溃注入 + test_undo_manager editor 实测**（原标 TODO）：新增 `.github/workflows/editor-e2e.yml`，weekly（每周日 00:00 UTC）+ manual 触发，Ubuntu + Xvfb 跑 GUI Godot editor，设 `E2E_EDITOR=1` 启用 `e2e-resilience-editor.test.ts`（SIGKILL 崩溃注入重连 + N=5 并发串行 undo 安全），跑 `test_undo_manager.gd` 5 个 undo 行为测试（经 testing 工具 test_run editor 路由）。不阻塞主 CI，失败通知 last committer
- **#2 env 隔离 footgun lint 守护**（原标 TODO）：新增 `scripts/check-env-isolation.mjs` 扫 test/ 检测危险 env（UNRESTRICTED/DISABLE_SAFETY/SANDBOX/ALLOW_UNSAFE）直接赋值（绕过 stubEnv 致 afterEach restore 漏清），首版 warn-only（现有 60+ 处逐批迁移后升 error）+ package.json 加 `check:env-isolation` script
- **#3 security-path-traversal-task2/3 加 isolatePathEnv**（原标 TODO）：两测试文件 beforeEach 加 `isolatePathEnv({allowed:[tmpProj]})` 三件套（清 UNRESTRICTED + 设 ALLOWED + reset），防 setup.js 全局 UNRESTRICTED=true 致路径安全测试走旁路假绿。13 测试加 env 隔离后仍全绿
- **#4 e2e-bridge-get-node-layout 去 !CI 接 godot-matrix**（原标 TODO）：`RUN = GODOT_MCP_E2E_L2 && !CI` 改为 `RUN = GODOT_MCP_E2E_L2`（去 !CI），`.github/workflows/ci.yml` godot-matrix job 设 `GODOT_MCP_E2E_L2=1` + 把此测试加入 E2E step。bridge 字段级守护（core feature）现在 CI 真跑。e2e-asset-tools 仍需 GUI editor 不接（走 editor-e2e.yml）
- **#5 setBridgeProjectDir 检测 _sendLock 未 settle**（原标 TODO）：`game-bridge.ts:setBridgeProjectDir` 加 in-flight 检测——若 `_sendLock !== Promise.resolve()`（有 sendToBridge in-flight），记录 warn（可视化跨项目并发切换风险）。彻底修复需 per-project 锁（架构级改造，留 follow-up）

## [0.25.7] - 2026-08-06

### Added — P3 选做三批（分支 `feat/p3-selection`）

基于 `docs/plans/2026-08-06-p3-review-and-selection-plan.md`（3 路并行 Explore 核查）。commits: `9d73e72`(P3-1/P3-2) + `021fb6a`(P3-7) + `4a1031a`(P3-6) + `90f065e`(审查修复)。

- **P3-1/P3-2 版本同步收口**：`version-sync.mjs` 的 `TARGET_FILES` 加 `server.json`/`Dockerfile`，根治分发产物版本漂移（根 server.json 0.25.0、Dockerfile 0.24.0 vs package.json 0.25.7）。A 类 5 文件同步到 0.25.7。删除 `docs/distribution/server.json`（0.20.0 旧副本），根 server.json 为唯一真相源；`check-tool-count.mjs` 改读根。审查 SHIPPED WITH NITS（`docs/reviews/2026-08-06-p3-three-batches.md`）。
- **P3-7 C# 阶段一收尾**：`project_replace` 白名单加 `.cs`（原反向禁止）；`read_script` C# 分支补 `using` 列表提取；`edit_script` 验证回滚新增 `csharpValidateAndRevert`（调 `dotnet build --no-restore`，失败回滚；无 .csproj/dotnet 不可用时优雅降级）。generate_test/NUnit 延后。
- **P3-6 subscriptions/listen**：bridge 事件主动推送（server→client notification），三层改造 — addon GDScript `_push_event_to_peer`（watch/monitor `push:true` 模式）+ TS bridge 常驻 data handler（与 sendToBridge 临时 handler 共存）+ GodotServer `registerBridgePushHandler` → `notifications/resources/updated`。opt-in（默认 false，watch_poll/monitor_poll 保留向后兼容）。

### Fixed — P3-6 审查 BLOCKING（commit `90f065e`）

- **sendToBridge 误把 push 消息当响应 resolve**：`sendToBridge` L337 原 `resp.id != null && resp.id !== id` 在收到无 id 的 push 消息时不 continue，误 resolve 正在等待的 request。改为 `resp.id == null || resp.id !== id`（无 id 一律跳过）。76 个 bridge 测试验证无回归。

### Fixed — P2 第三方审查 B-1/I-1/I-2/I-3 + N1/N2/N4（commit `3b57b8b` + `d6fdbf7`）

- **审查 B-1 修复（critical security）**：`mcp_bridge.gd` 的 `BLOCKED_PROPERTIES` 新抄第 4 副本漏 `"instance"`，重开 I-2 ExtResource 注入 RCE。已补 instance + 扩 `defects.ts` detect 扫描范围到 `src/scripts/*.gd`。
- **审查 I-2 修复**：`playtest.step` 的 `frames=1` 在同一 `_process` tick 完成（physics 未推进），加 `_added_this_frame` 标记让加入帧不递减。
- **审查 I-3 修复**：`check:gdscript` 扩编译范围到 `src/scripts/`（原只编译 `addons/`，漏 `mcp_bridge.gd`）；补 GD 侧契约测试（B-1 类 BLOCKED_PROPERTIES 漂移守护）。

## [0.25.6] - 2026-08-06

### Added — P2 Wave2（commit `ff45af5`）

- **P2-4 确定性 playtest 四原语**：`game_playtest` action 新增 5 方法 — `playtest.seed`（锁全局 RNG）、`playtest.fixed_delta`（锁 physics 步长 `physics_ticks_per_second` + `max_physics_steps_per_frame=1` + `physics_jitter_fix=0`，不碰 `time_scale`）、`playtest.step`（单步推进 N 帧，走哨兵+pending 队列延迟响应）、`playtest.snapshot`/`playtest.restore`（结构+属性快照，5 个 accept 限制：不保信号拓扑/Resource 用 resource_path/不复活 free 节点/不保物理流/monitor 不在范围）。
- **P2-5 SEP-2133 extensions 声明**：`GodotServer` capabilities 加 `extensions['io.godot-mcp/runtime-bridge']`（description/version/capabilities），让 modern-era 客户端发现 enhanced 的 runtime-bridge + 确定性 playtest 能力。era-gated（2026-07-28 引入，legacy SDK strip 无害）。

## [0.25.5] - 2026-08-06

### Added — P2 Wave1（commit `9d7ab76`）

- **P2-1 overrides 注入 autoload**：`game_bridge` 工具新增 `install_override`/`uninstall_override` action，启动游戏前注入任意调试脚本（日志钩子/状态快照）到项目 `[autoload]` 段，key 用 `MCPOVERRIDE_` 前缀。新建 `src/core/overrides.ts`。源/目标路径过 `isPathInAllowedRoots`。`--overrides=` CLI flag / `GODOT_MCP_OVERRIDES` env 声明默认脚本（close 时批量卸载；⚠️ CLI flag 本身不 install，须 agent 调 action）。
- **P2-6 recipe 验证闭环**：`ui_draw_recipe` 绘制后 `await process_frame` 读回 `draw_result`（draw_signal_connected + node_valid），非 fire-and-forget。

### Changed — P2 收尾

- **P2-2 validate_scripts autoload**（关闭+纠偏）：核查发现 plan 措辞错误 —— autoload 感知早在 `validate_scripts`（`validation.ts:200-202` `extends SceneTree` + `_initialize` + `load`）落地，`validate_gdd` 实为纯 markdown 校验。补回归测试 + plan 纠偏块。
- **P2-3 nodeType RCE 审计收尾**：`scene-commit` node_add 从黑名单（9 项敏感类）收紧为白名单（`ALLOWED_COMMIT_NODE_TYPES` 58 类镜像 GD `ALLOWED_HEADLESS_TYPES`），堵第三方 addon 注册的 extends Node 恶意 class_name RCE。

## [0.25.4] - 2026-08-05

### Added — MCP 生态调研升级方案 P0（6/6）+ P1（7/7）

基于 `docs/plans/2026-08-05-mcp-ecosystem-research-and-upgrade-plan.md`。P0 协议层关键路径 + P1 协议适配。commits: `5887f2f`~`857f69d`(P0-1/P0-2) + `09b212d`(P0-4) + `d964c7c`(P0-3) + `7315325`(P0-5/P0-6) + `81f7c12`~`8b7e78d`(P1 全 7 项)。

- **P0-1 SDK v2 升级**：`@modelcontextprotocol/sdk` 1.29 → `@modelcontextprotocol/server` 2.0（包名拆分 / `setRequestHandler` method 字符串化 / Node 20+ / zod v4）。用 `serveStdio` 默认双时代行为，2025-era 客户端零破坏。
- **P0-2 MRTR 改造**：`confirm_and_execute` 改用 `inputRequired` 双时代模式（2026-era 返 `inputRequired` result，2025-era 走 `elicitInput`）。
- **P0-3 action 级 capability gate**：默认 gate RCE action（execute_gdscript/execute_bpy/blender），`manage_tools` activate/deactivate 动态开关。
- **P0-4 UndoRedoManager 补全测试**：reference op + asset_placer undo 回归测试。
- **P0-5 runtime_assert 工具**：agent 任意时刻验证节点状态/场景结构/屏幕文本/性能/截图对比，不必走 workflow。
- **P0-6 help 工具**：工具表分层压缩 + help 按需展开，省 4000-8000 tokens。
- **P1-1/P1-2 idempotentHint + annotations 进 matrix**：idempotentHint 派生规则改进 + annotations 进 capability-matrix。
- **P1-3 SEP-2575 opt-in modern era**：双时代支持（2026-07-28 modern era opt-in）。
- **P1-4 SEP-2549 cacheHints**：cacheHints 配置 + listChanged capabilities 补全。
- **P1-5 视觉成本层级**：`detail=full/thumbnail/ascii`（screenshot 工具 token 成本分层）。
- **P1-6 契约检查独立 CI job**：`check-contract.mjs`，6 项核心校验。
- **P1-7 SEP-2577 per-request logLevel**：logging 合规化（修 2 个 pre-existing bug）。

### Changed — 测试覆盖加固批次（P2-8..P2-12 + P1-2/P1-3/P1-4 + N-1，审查 SHIPPED WITH NITS）

纯测试加固，无用户可见行为变化。对应 2026-07-10 测试覆盖审计遗留项 + coverage batch 审查 nit 闭环。

- **P2-8 health-monitor 状态恢复断言 + P1-2 WS 断连批量 reject 故障注入**（`20b20c8`）。
- **P2-9 resetReconnectState 直接单测**（`196485e`）。
- **P2-10 场景树并发竞争真测试**（`641738d`）。
- **P1-4 scene 操作状态反查断言**（`d7f5347`）。
- **P1-3 统一 executeGdscript happy/失败 mock 工厂**（`1010860` + `125239d`）。
- **P2-11 ui schema 瘦身消除 check-token-budget WARN**（`bbca356`）：ui inputSchema 8921B→3560B。
- **N-1 修复 build-matrix TOP5 渲染乱码**（`2985d1b`）。
- **P2-12 slimSchema 直接单测**（`f31c95a`）。

### Fixed — N-3 流程清理

- **N-3 mock-results.js docstring 精度**（coverage-batch 审查 N-3）：去易漂移的具体行号，改述为"对齐 ExecuteGdscriptResult 的 compile/run/sandbox/binary 四种字段形态"。


## [0.25.3] - 2026-08-01

### Fixed — 全天审查 BLOCKING 根治 + NIT 收尾

- **fix(testing): arena 前缀碰撞 BLOCKING 根治（方案 B `_mcp_test_persistent` meta opt-out）**：修复 P2-12 二期 async 改造引入的 arena 在测试间被误 free（第 2 个测试起 SCRIPT ERROR）。根因：`await process_frame` 让 `queue_free` 帧末落地，命中 `_McpTest` 前缀清理规则的 suite 级 arena 被误清。修复：`mcp_test_runner.gd:_free_mcp_test_nodes_recursive` 加 meta opt-out，arena 设 `_mcp_test_persistent`。运行时对照实验闭环（修复版 EXIT_CODE=0 / 对照组 EXIT_CODE=1）。
- **refactor(editor): NIT-3 抽 `_runWithOpTimeout` 辅助方法**：nav_bake 与 test_run 重复结构抽私有方法。实施中修复 `return` 未 `await` 致 reject 绕过 try/catch 的隐藏 bug + 回归测试。
- **feat(security): NIT-2 bpy-sandbox 补 `%` 格式化构造检测**：新增 `detectBpyFormatStringBypass`（对齐 gdscript-executor C-01-fix:217），检测 Python `"os%s" % ".system"` 等价拼接绕过。+ 3 测试。
- **chore(testing): NIT-1 删 testing.ts textResult 死代码**。
- **docs(review): 全天审查报告** `docs/reviews/2026-08-01-full-day-review.md`，SHIPPED。

## [0.25.2] - 2026-08-01

### Added — P2-12 一期 McpTestSuite 移植（editor 路线，关闭 P1-5）

AI 可写标准化 GDScript 测试套件（`extends McpTestSuite`），editor 模式 `testing` 工具执行。借鉴 godot-ai MccpTestSuite，走 enhanced headless/editor 三层架构的 editor 路线（独立 addon 进程，非主线程）。

- **feat(testing): McpTestSuite 框架 + test_run/test_manage 工具**：移植 godot-ai 4 文件到 `addons/godot_mcp_server/testing/`：`mcp_test_suite.gd`（断言 latch + track + skip + SCRIPT ERROR capture + editor_undo/redo，去 McpLogBuffer/McpScenePath 依赖）/ `script_error_capture.gd`（原样）/ `mcp_test_runner.gd`（同步路径 + 发现 + leak cleanup，丢 serviced/checkpoint transport 防饥饿 —— 一期限制 suite <30s，二期补 deferred-response hard gate）。TS 侧新增 `src/tools/testing.ts`（editor-only，headless 硬返 EDITOR_ONLY）+ `editor-method-map.ts` 登记 testing 族 + `module-loader.ts` 自动注册 + `static-grep.ts` EDITOR_COMMAND_ROUTING 补 test_run/test_manage。
- **test(undo_manager): P1-5 套件覆盖 5 方法**（关闭 P1-5）：`addons/.../testing/suites/test_undo_manager.gd` 5 test 覆盖 undo_manager.gd 全部 5 func（setup / create_action_mixed / _add_method freed 守卫 / _apply_op property do+undo / _apply_op unknown type fallthrough）。P1-5 此前零行为测试（headless 编译期拒绝 EditorUndoRedoManager），随本期 editor 路线落地关闭。
- **chore(tool-count): 36 工具 / 205 action 同步**：build-matrix 重建权威源（35→36 / 203→205），20 处文档漂移同步（README/manifest/README.en/server.json/distribution/migration + rule-templates.ts/godot-mcp-core.md 独立副本）。version bump 0.25.1→0.25.2（独立副本同步约束）。

### 限制（一期边界，诚实标注）

- **不测编辑器操作 undo 合约的 transport 防饥饿**：长 suite（>30s）会饿死 editor WS keepalive。二期补 deferred-response hard gate（抄 godot-ai v3 drain-and-reject）。
- **test_undo_manager.gd 5 测试需本地 editor 实测**：CI godot-matrix job 双版本跑 e2e，但 undo_manager 5 测试的 editor 实测需本地 `test_run(suite="undo_manager")` 确认（headless 无 EditorUndoRedoManager）。TS 侧仅测 EDITOR_ONLY 拒绝路径 + 路由登记。

## [0.25.1] - 2026-07-31

### Fixed — 竞品对比批①-④ 落地（feat/competitor-followups，审查 SHIPPED WITH NITS）

- **docs(tool-count): 工具数口径修正**（批①，`e650053`）：核实发现 21 处文档漂移（28/29/33/130+ 五种过时数字），统一为权威值 35 工具 / 203 action（capability-matrix CI 锁定）。最高优先：`src/tools/rule-templates.ts:24` 与 `.claude/rules/godot-mcp-core.md:10` 独立副本重新同步（防 `setup_project_rules` 下游污染）；`docs/distribution/server.json` 防 MCP Registry 错误扩散。version bump 0.25.0→0.25.1（独立副本同步约束）。
- **chore(tool-count): CI 校验脚本根治漂移**（批②，`05ef998`）：新增 `scripts/check-tool-count.mjs`（仿 check-token-budget.mjs，readFileSync 不走 git / 导出纯函数 / 退出码 0-1），从 capability-matrix.json 动态读权威值校验各文档手写数字，支持 negate（反向断言「不应残留 130+」）和双捕获组（rule-templates/core.md 工具数+action 数）。补 `check-rules-version-bump` 只校验版本不校验内容的盲区。+ 6 个单测 + ci.yml 接入。
- **feat(process): P0 周期 orphan 扫描 + P1 启动清理**（批③，`e46ead6`）：`GodotServer.run()` 挂 60s setInterval 周期调 `killOrphanGodotProcesses`（60s 规避内部 30s 节流，unref 不阻塞退出，close() clearInterval 防竞争，第一层只扫本会话 `_spawnedGodotPids` 不误杀用户 Godot）；新增 `STARTUP_CLEANUP` feature flag（默认关 opt-in）启动时清理上一会话残留，不 await 避免拖慢启动。godot-ai 的 detached+lease+reaper 不适用 enhanced（stdio 单 client）不照搬。
- **test(gdscript): command_helpers 纯函数行为测试**（批④，`1d2e56a`）：补强 GDScript 侧零行为覆盖（capability-matrix L2 从 none 35 → partial 1）。用 executeGdscript 在 headless `--script` 模式覆盖 `values_equal`（同类型/Array↔Vector3 分量比/int↔float/bool↔int fallback）/`parse_vec3`/`has_path_traversal`。复用 e2e-p1-p5 的 skipIf 无 GODOT_PATH 模式防 CI 假绿。CI godot-matrix job 双版本（4.6.3/4.7.1）跑。
- **fix(nav): N1 补全 bake_mesh_async 末行 freed 守卫**（`b1b9f51`，两天批次审查发现）：`nav_commands.gd:196→198` 末行属性访问缺 `is_instance_valid` 守卫，deadline 耗尽退出后 nav 可能被并发 peer 删除（MAX_PEERS=5），访问 freed 对象 → GDScript SCRIPT ERROR。对齐同文件 :144（create_region_async 末行）。配套两天批次审查报告 `docs/reviews/2026-07-31-two-day-batch-review.md`（130 commits，SHIPPED）。
- **docs(review): 批①-④ 第三方审查报告**（`12b4344`）：`docs/reviews/2026-07-31-competitor-followups-batch1-4.md`，SHIPPED WITH NITS，无 Blocking。

## [0.25.0] - 2026-07-30

### Security — A-RCE 批次（headless RCE + 沙箱硬化）

- **P1 headless instantiate_class 合并白名单**：`src/scripts/godot_operations.gd` 移除 `is_parent_class("Node")` 兜底（Node 是 Node 的父类 → `extends Node` 恶意脚本绕过 → `_ready` RCE，不经 execute_gdscript 沙箱），改 `ALLOWED_HEADLESS_TYPES`（NODE_TYPES ∪ CONTROL_TYPES ∪ Control − Node）双分支∈检查，对齐 editor `node_commands.gd` 纯白名单。**BREAKING**：`create_scene(root_node_type="Node")` / `add_node(node_type="Node")` 被拒（罕见，用 Node2D/Node3D/Control 或 execute_gdscript）。
- **P1 self_update dest 符号链接校验**：`src/core/addon-version.ts` updateAddon/readAddonVersion 补 `safeRealPath(dest)+isPathInAllowedRoots`，堵 `addons/` 子段符号链接 cpSync/readFileSync 跟随写出/读出 allowlist 外（monorepo 共享 addon 常见）。
- **P2 execute_bpy 危险 API 扫描**：新增 `src/core/bpy-sandbox.ts` `scanBpySandbox`（os/subprocess/eval/exec/__import__/ctypes，negative lookbehind 避免误报 `bpy.ops.image.open()`），对齐 execute_gdscript `scanGdscriptSandbox` 纵深防御；warnings 非空 BLOCK（除非 `GODOT_MCP_DISABLE_SAFETY=true`）。
- **P2 profile 硬隔离**：`src/core/ToolDispatcher.ts` `executeToolCall` 入口加 `isToolAllowed` 强制检查（原仅 getFilteredTools 广告层），堵被转发 MCP 客户端调用 TOOL_GROUPS/slim 过滤工具。
- **ADVISORY godot_path 白名单**：实现 `GODOT_MCP_ALLOWED_GODOT_PATHS` env（分号分隔，realpath 归一），接入 validateGodotBinary/detectGodotVersion/findGodot 全出口，签名校验之上的硬隔离。
- **detect 假绿修正**：`rce-script-branch-no-node-check` 不再把 is_parent_class 当充分守卫（+反向 Node 不在白名单）；`set-prop-no-type-whitelist` 扩扫 headless。
- **Docs**：update-checker 披露 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 遵守（刻意不设 `trustEnv=false`，避免断企业代理用户）。

### Fixed — Reliability (B 批次)

- **P1 nav bake 请求超时对齐**：`EditorToolExecutor` nav bake `conn.request` 传 `{timeoutMs: NAV_BAKE_OP_TIMEOUT_SEC*1000}`（原默认 30s），消除 >30s 烘焙误报 `editor_disconnected/do_not_retry`（GD 实际烘成但客户端禁重试）。
- **P1 headless gdscript spawn orphan 清理**：`gdscript-executor` spawn 注册 `_spawnedGodotPids`（exit/error/timeout 三路径 unregister）；`GodotServer.close` 遍历活跃 spawn `killPidTree` best-effort 清理 in-flight（原只 kill run_project 长进程，挂起脚本+关闭→孤儿无兜底）。
- **P1 心跳降级区分 timeout/refused**：pingFn catch 保留 err.code；`REQUEST_TIMEOUT`（TCP OPEN 主线程卡死）→ `handleEditorStall` 降级；`NOT_CONNECTED/CONNECTION_LOST`（下线/重启）→ 不 `disconnect` 抢占，让 EditorConnection 20 次退避自动重连兜底。重连成功 `hm.reset()` 复位 connected；重连耗尽 `reconnectExhausted` 兜底降级。
- **P2 半开 HOL 预检**：`EditorToolExecutor._executeInner` 入口查 `healthMonitor.getState()`，reconnecting 时即时返 NOT_CONNECTED，跳过 30s conn.request 等待（串行 executeChain ×30s HOL 放大）。
- **P2 全系统扫跳过 --editor**：`fullSystemScanGodot` Windows PowerShell + POSIX sh 过滤加 `--editor` 排除，opt-in 开启时不误杀同项目编辑器。
- 5 条 defects detect 补全（nav-bake/HOL/spawn/heartbeat/fullsystem-scan；#1/#2/#4 原零 detect）。

### Fixed — Correctness (C 批次)

- **P1 adapter env 白名单合并**：14 adapter（含 codex TOML / opencode environment）env 写入抽 `buildEnv(godotPath, oldEnv?)` 共享 helper，reconfigure 时白名单保留 `ALLOWED_PROJECT_PATHS` / `GODOT_MCP_BRIDGE_*` / `GODOT_MCP_EDITOR_*`（原覆盖致用户配置重跑 setup 静默丢失；复发 cli-configure-env-field-overwrite）。
- **P2 nav freed 对象访问**：`nav_commands.gd` 两处 freed 分支删 `nav.bake_finished` 访问，直接 return（对齐 headless navigation.ts:45；freed 对象属性访问致 -32003 丢失）。
- **P2 nav status 动态**：bake status 按 success/`_bake_state["done"]` 派生（bake_completed/bake_failed/bake_timeout），非硬编码（原 success:false 与 status:bake_completed 矛盾）。
- **P2 doctor stripBom**：`doctor.ts` 改用 `readJsonForCheck`（含 stripBom），带 BOM 的 mcp-godot.json 不再静默吞错。
- **P2 readCache 字节上限**：`update-checker.ts` readCache 加 `statSync` 64KB + `latest.length<=64`（防大文件/恶意文件启动期 OOM）。
- **P2 updateAddon 原子化**：`addon-version.ts` 裸 cpSync 改 staging+校验+备份+平台 rename（POSIX rename 原子 / Windows rm+rename+dest.bak 备份回滚），中断不留破损 addon。
- **P2 adapter 文件权限保持**：13 adapter 原子写抽 `writeFileAtomicWithMode`（statSync 旧 mode + writeFileSync{mode}），Unix 保持 0o600 / Windows no-op。
- 7 条 defects detect 补全。

### Added — Telemetry Skeleton (Stage 0, zero egress)

- **feat(telemetry): 新增匿名遥测骨架**（`src/telemetry/`，opt-in 默认关闭，阶段 0 endpoint 空零外传）。`GODOT_MCP_TELEMETRY=true` 启用，`CI=true` 强制关闭。ToolDispatcher after-hook 记录 tool 名 + success + duration_ms + 错误分类（白名单脱敏）+ 加盐 sha256 项目 hash；红线：绝不收集源码/路径/项目名/editor 日志/邮箱 IP 账号。详见 `docs/telemetry.md`。
- **诚实披露 update-checker 外传点**：`docs/telemetry.md` + `README.md` + `README.en.md` 明确标注——每次 MCP server 启动时 `src/core/update-checker.ts` 的 `fetch(REGISTRY_URL)` 被动 fetch npm registry（24h 缓存）。**[2026-08-07 更新]** v0.25.7 起已加 `GODOT_MCP_UPDATE_CHECK=false`(或 `0`/`no`/`off`,大小写不敏感)门控,原文"当前无 env 门控"已过时;`self_update` check action 不受门控(用户主动查询)。

### Fixed — Nav Bake Accuracy (C4 async-dispatch)

- **MCP 调用路径 nav bake_result 准确**：`nav_create_region(bake=true)` / `nav_bake_mesh` 的 bake_result 从乐观 `navigation_mesh != null` 改为 bake 真正完成后 `get_vertices().size() > 0` 判据。
- 实现：A-lite 精确局部化 async-dispatch——`websocket_server` 按 `method.begins_with("nav_")` 分流到新增 coroutine 入口 `handle_nav_async`，非 nav 仍走同步 `handle`（30+ handler 契约不变，packet 循环不串行化）。
- bake 完成检测：`bake_finished` 信号 + Dictionary holder（GDScript 4 lambda by-value 实测）+ 循环内 `is_instance_valid` 守卫 + 超时退化兜底（fallback 方案，Task 0 实测 NavigationRegion3D 无 is_baking 属性）。
- 心跳：nav bake 长操作经 `EditorToolExecutor` 接线 `operation_start/end`（EditorConnection 已有方法）暂停心跳，GD P1#3 hard timeout 兜底。
- headless 侧：`navigation.ts` 同款 fallback + `get_vertices().size()`（`extends SceneTree` 无 `get_tree()`，用 `await process_frame`）。
- **已知局限**：redo 路径 bake 仍乐观（editor undo 系统 `commit_action` 同步执行 do_ops，MCP 层插不进 await）。workaround：redo 后调 `nav_bake_mesh` 走 MCP 路径得准确 bake。
- 详见 `D:\GitHub\godot-mcp-enhanced\docs\superpowers\specs\2026-07-28-c4-nav-async-dispatch-design.md` + plan。

### Fixed — Test Quality

- **e2e beforeAll 清理 `.godot` 缓存**：`test/e2e-p1-p5.test.ts` 的 `beforeAll` 加 `rmSync(test/e2e-scene/.godot, recursive)`，本地运行以 CI fresh-checkout 干净状态起步，防过期导入缓存致 P3-import 的 `.godot/imported` 存在断言命中残留目录而假绿（:101，报告4 P2-10）。
- **弱断言精确化**：机械转 576 条 `includes().toBeTruthy()` → `toContain`（括号感知 codemod，贪婪切分 + receiver 白名单守卫，排除复合 `||` / 函数调用 / negation）+ 鉴权维度 5 条语义强化（inputSchema 形状 / suggestion 类型，delete-red）。gate 弱计数 1349 → 768，上限 1400 → 810（:99，报告4 P2-7）。

## [0.24.1] - 2026-07-27

### Fixed — Documentation Sync

- **rule-templates.ts 同步**：第三方审查（`docs/reviews/2026-07-27-get-node-layout.md`）发现 commit `3d11541` 改了 `.claude/rules/godot-mcp-bridge.md` + `godot-mcp-engine-quirks.md`（get_node_layout method 表 + 节点定位段）但未同步独立副本 `src/tools/rule-templates.ts`（违反 `AGENTS.md` 独立副本同步约束，CI `check-rules-version-bump.mjs` 不校验内容 drift）。本次补齐：method 表加 get_node_layout 行 + engine-quirks 模板补「节点定位与坐标实测」整段（含 Node3D.scale bullet 顺手补 ★ 标记）。

### Docs — Process

- **AGENTS.md 加三段强制流程**：(1)「改动 `.claude/rules/` 后」核查 step；(2)「plan 落地后必出第三方审查文档」；(3)「完成前必登 memory」。源于 get_node_layout PR 第三方审查反馈 + 用户反馈 memory/review 双断档。
- **新增 `docs/reviews/` 目录**：补 7 月 5 条断档链路的第三方审查文档（get-node-layout / client-adapters / ci-godot-matrix / self-update / batchf），每条派独立 code-reviewer 子 agent 审查。

## [0.24.0] - 2026-07-25

### Added — Self-update（Godot AI 追赶 3/3）

- AI 客户端配置 adapter 从 4 个扩到 **13 个**（+9：Claude Desktop / Windsurf / Cline / Zed / Gemini CLI / Antigravity / Trae / Cherry Studio / Qwen Code），对标 Godot AI 19 client auto-configure
- `ClientAdapter` 接口加必需 `scope: 'project' | 'global'` 属性
- scope 分布（plan 前置核实）：**global 8**（Codex/Claude Desktop/Windsurf/Cline/Zed/Antigravity/Trae/Cherry Studio）+ **project 5**（Claude Code/Cursor/OpenCode/Gemini CLI/Qwen Code）
- BOM 防御：`json-config.ts` 加 `stripBom` + `readJsonForCheck`，所有文件型 adapter 的 `isConfigured` 统一经 `readJsonForCheck`（修复带 BOM 合法配置被误判 → doctor 误报 + setup 破坏幂等）
- user-state 字段 per-client 白名单保留（Cline `disabled`/`autoApprove`、Cherry `isActive`/`installSource`、Antigravity `disabled`/`disabledTools`、Gemini CLI `trust`/`timeout`/`includeTools`/`excludeTools`、Qwen Code `trust`/`includeTools`/`excludeTools`/`timeout`/`description`、OpenCode `enabled`）
- `setup` / `doctor` 日志标 `(global)`/`(project)` 让用户知情改了哪些全局配置
- Cherry Studio entry 含 `type:"stdio"`（schema enum 强制，唯一需 type 的 client）
- 注：client adapter 是 CLI 侧配置，不进 capability-matrix（非 MCP 工具能力）
- 新增 `self_update` 工具（action=check/update）：check 查 npm 最新版 + 各项目 addon 版本漂移（只读，免确认）；update 覆盖安装包内 addon 到指定项目（需确认，三层路径校验 + 降级保护）
- MCP 服务端启动异步查 npm registry，有新版 stderr 提示（24h 缓存，失败静默）
- 单工具 + action enum 设计避 `guard.ts:65` confirm 门旁路；readOnly 模式拒整工具

### Fixed — Security（批次 A：RCE + 路径穿越，2026-07-23）

- A1 data-import `class_path` 补 root 校验（堵 RCE，gdscript-template-injection 复发实例）
- A2/A6/A7/A9 TS 路径参数统一 resolveWithinRoot
- A3 workflow user://.. 穿越×3 段级拒绝
- A4 game-bridge symlink 检查移到权限收紧前
- A5 asset_factory material load 补 has_path_traversal
- A8 logger error + call-recorder msg 套 sanitizeMsg
- A10 ui/scene property 改走 coerce_property_value + 删本地 blocked（instance 纵深统一）

### Fixed — Reliability（批次 B：降级链路 + 进程通信 + 资源写原子化，2026-07-23）

10 条可靠性 finding 修复（5 份审查：专项2 可靠性 4 条 + 通用版进程通信 6 条）：

- **降级链路统一（B1+B2+B3+B6）**：B1 evaluateState 按 errorType 分流（仅 heartbeat 驱动 reconnecting，工具失败不再误降级）；B3 心跳用独立 5s 超时（原复用 30s，TCP 半开降级 ~225s→~85s）；B2 handleEditorStall disconnect 清 zombie；B6 重建后 setState('connected') 即刻复位
- **进程通信（B4+B5）**：B4 连接类错误结构化 err.code（do_not_retry 覆盖 Disconnected/JSON parse error，Executor 合并 I-12 分支）；B5 fireDisconnect/fireReconnect try/catch 容错
- **资源写原子化（B7）**：17 处 ResourceSaver.save 改 tmp+rename 原子提交（三环境：headless godot_operations.gd 9 处 + addons 3 处 + TS 生成 5 处），防超时 kill 产半截损坏资源阻塞项目加载
- **advisory（B8+B9+B10）**：isConnected 活性语义 JSDoc；orphan 崩溃恢复 opt-in 文档；authTimeoutMs 参数化

### Fixed — Editor（mcp_editor.key 多实例互删，2026-07-23）

- **editor-secret-cross-instance-delete**：`addons/godot_mcp_server/websocket_server.gd` `_delete_secret_file` 原无条件 `DirAccess.remove_absolute(_secret_file)`，多个 editor 实例（或禁用→启用插件）共享固定路径 `.godot/mcp_editor.key` 时，任一实例 `_exit_tree` 会删掉仍存活实例的 key。现象：editor 日志称 `Auth secret written` 但文件找不到；TS 端 TTL 缓存（5 min）过期后重连读不到 key → editor 工具连不上。改为删前 `FileAccess.get_file_as_string` 校验 `on_disk == _secret`，只清自己生成的 key（读失败返 "" != _secret 也不删，安全侧）。defects.ts 加 FIXED 条目（detect 查 `on_disk == _secret`）+ 计数 80→81。

### Fixed — Correctness（批次 C：协议契约 + 返回值语义 + undo 完整性 + 参数校验，2026-07-23/24）

12 条正确性 finding 修复（5 份审查协议正确性/参数校验段 + addons GDScript 正确性 + data-import）。**C4 deferred**（架构阻塞，见末段）：

- **协议契约（C1+C3）**：C1 `sync_commands.gd` `_on_node_added/_on_node_removed` 改用现成 `_plugin` 字段（删 dead `_command_handler.get_plugin()` indirection——command_handler extends Node 无此方法，has_method 恒 false→传 null→get_edited_scene_root(null) fallback get_child(0) 错场景）；C3 `websocket_server.gd` params:null 改 reject -32602（原 `_rpc_params != null and not is Dictionary` 的 and 短路放行 null→Dictionary 强类型 SCRIPT ERROR 中断帧 packet 循环）
- **返回值语义（C9）**：`test_commands.gd` test_assert 改用 `CommandHelpers.values_equal` 类型感知比较（原 str() 比较 str(Vector3)≠str([10,0,5]) / str(true)≠str(1)，致 Vector3 vs Array / bool vs int 断言永不等；values_equal：同类型直接 ==，Array↔Vector2/3/Color 分量比，bool↔int 严格不等，int/float 宽松）
- **undo 完整性（C10+C11+C12）**：C10 `animtree_commands.gd` add_state/add_transition/set_blend 加 create_action_mixed undo（原仅 create 有 undo，Ctrl+Z 只撤 create；undo: add_state→remove_node / add_transition→remove_transition / set_blend→property old_val）；C11 `node_commands.gd` batch_add_nodes commit 后扫孤儿 is_inside_tree()+free()（GDScript 无异常机制，commit 失败已 instantiate Node 孤儿 leak）；C12 edit_node/set_instance_property 记 undo 前查 PROPERTY_USAGE_READ_ONLY 跳过只读（原 old_val=node.get(key) 对只读/不存在属性返 null→undo 回放 set(key,null) 错误赋值，加 _get_property_usage helper）
- **参数校验（C13+C5）**：C13 `ui_commands.gd` set_params 加 `_theme_has_property` 守卫（theme.set 前校验 Theme 有效属性，避免无效 key silent no-op/动态属性污染）+ default_font/stylebox load null 守卫；C5 `path_generator.gd` resolve_points strip "root/" 前缀（对齐 command_helpers.find_node，内联 strip 保 path_generator 纯几何静态类独立性）
- **TS 正确性（C2+C6+C7+C8）**：C2 `gdscript-executor.ts` extractCompileError 改 \b 词边界正则（原裸 includes 致用户 print("Parse Error: debug") 误判 compile 失败，marker/no-marker 两路径共用一处覆盖）；C8 proc.on('error') :1344 + catch :1143 裸 rm(sessionDir) 改 retryRm（对齐 timer/close，Windows EPERM 容错）；C6 `data-import.ts` csv_content 分支前置 size 守卫（原后置太晚，MCP SDK JSON.parse 阶段已载入 OOM）；C7 data-import GD 模板 `.tmp.tres` 自清从只扫 _output_dir 扩为 `_clean_tmp_global("res://")` 递归扫全局（跨 output_dir 残留，对齐 godot_operations find_files 跳过 .godot + depth≤10）
- **C4 deferred**：nav bake accurate bake_result（coroutine await + vertices_count 判据）——同步 dispatch（command_handler return 无 await + websocket_server not response is Dictionary 检查）不支持 coroutine handler，含 await 会使 handle_nav_create_region 成 coroutine 返 state 命中 -32603（比原 bake_result 不准的 bug 更糟）。需 async-dispatch 重构或 sync-bake API 研究（架构阻塞，超 bug-fix 范畴）。当前 bake 作 do_method 入 undo do_ops（P1 fix 保留），bake_result 乐观（!=null），`defects.ts` nav-bake-in-undo-action deferral 注释跟踪。

defects.ts 加 12 条 FIXED detect（C1/C2/C3/C5-C13）+ 计数 81→93。C4 由 nav-bake-in-undo-action（P1 bake 在 do_ops fixed）+ deferral 注释跟踪，不加新 OPEN detect（accurate bake_result 是架构 follow-up，非 bug-fix 可修）。

### Fixed — Tooling（批次 D：asset/android 工具游离，2026-07-24）

- **asset-android-tool-orphan（D1）**：`src/core/tool-registry.ts` asset/android 工具在 module-loader 注册（`module-loader.ts:57,71,75`）但不在 `TOOL_GROUPS`/`ALWAYS_ALLOWED` → `isToolAllowed('asset'/'android')` 恒 false（发现层 tools/list 隐藏 + profile 不强制，执行层 ReadOnlyGuard 兜底非 RCE）。补 `asset`(requires editor) + `android`(requires []) 2 组，toolToGroup reverse map + activeGroups + getFilteredTools 链自动派生一致。方案 a（不修 executeToolCall，避免破坏 advanced-proxy delegateCall 逃生舱）。android requires:[] 核实（`android.ts:212` deploy=spawnGodot headless export，无 EditorConnection）。

**D2 撤销**（find_node 内置 has_path_traversal）：经 eng-review + memory [[nodepath-traversal-category-error]] 核实为范畴错误复活（批次 A A11 已否决同建议）——has_path_traversal 是 resource 范畴（`command_helpers.gd:46` 注释 "resource path"），find_node 出口 get_node_or_null 纯场景树，NodePath `..` 是 Godot 合法父引用（`../Sibling`）非 fs traversal。D2 转 follow-up（NodePath `..` 策略统一：node_commands:51 项目拒 .. vs memory 范畴错误，历史痕迹需项目方拍板；若对齐 memory 撤既存 8 处节点路径前置，若禁 .. 走 schema pattern 非内置）。

**D2 follow-up 闭环（2026-07-24，方向 A）**：用户拍板撤节点路径前置（对齐 memory 范畴错误判断）。撤 6 处节点路径范畴 `has_path_traversal` 前置（`node_commands:52/108/161/231` + `asset_placer:154/203`）——范畴错误修正：`has_path_traversal` 是 resource 范畴（res:// fs traversal）误用于 scene tree 节点路径，get_node_or_null 受 SceneTree root 子树限制，`..` 是合法父引用（`root/A/../B` 等价 `root/B`）不能逃逸 fs。撤前置后 get_node_or_null 兜底（null→报 not found，-32002 与撤前同 code）。保留 6 处资源范畴前置（command_helpers:203 / scene:23 / ui:387 / asset_commands:112 / asset_factory:131，res:// 真 fs traversal）。memory 分类更正：原「8 处节点路径」误把 resource scope 的 scene/ui 算入，实测节点路径 6 + 资源 6 = 12。defects detect `nodepath-traversal-category-error`（两文件 CommandHelpers.has_path_traversal 计数=0）防复发。

### Fixed — Bridge（take_screenshot null 崩溃吞错，2026-07-24）

- **bridge-take-screenshot-null-crash-swallow**：`src/scripts/mcp_bridge.gd` `_cmd_take_screenshot` 的 `get_viewport().get_texture().get_image()` 链无 null guard，`get_image()` 返回 null（窗口后台/viewport 未就绪/DummyRenderer）时 `img.save_png()` 触发 runtime error 中断函数，`_handle_message` result 停 null → promote error 不触发（null 非 Dictionary）→ 返回 `{"result":null}` 吞错（客户端只见 null，既无 result 也无 error，无法定位）。补 viewport/texture/img 三层 null guard 各返结构化 `{"error":{code:-3,message}}`，`_handle_message` promote error 触发客户端可见。defects.ts 加 FIXED detect（`_cmd_take_screenshot` 函数体含 `get_image()` 必须有 `== null` 守卫）+ 计数 96→97。

### Not Fixed — 经审查否决

- ~~A11 find_node traversal~~：eng-review 否决（范畴错误）。find_node 唯一出口 `root.get_node_or_none` 纯内存，返 Node 零流入 load/DirAccess；NodePath `..` 是 Godot 父节点引用语法不逃逸场景树。若需禁 node_path `..` 应走 schema 契约变更（归 D 工具治理批次）。

### Added — Security（execute 取证，对照 UE 9b128514）

- **execute_gdscript 崩溃取证套件**：spawn godot 之前对【原始用户 code】算字节级 SHA-256 + 生成 `executionId`，记一条 `EXECUTE_BEGIN` 结构化审计日志（不含原始 code，对齐 I-10 字面量脱敏）；`ExecuteGdscriptResult` 回填 `executionId`/`scriptSha256`（成功 / RID leak / 无 marker 三路径都回填）。崩溃/超时后可凭日志反查具体执行（哪段 code 的 hash、写到哪个临时文件），无需原始 code 入日志。新增 `buildExecAuditEvent()` 纯函数 + 8 测试（5 单元 + 3 源码契约锁 log-before-exec 顺序）。差异化护城河：Godot AI 的 `game_eval` 是运行时求值，无 execute 前哈希留痕与崩溃溯源。

### BREAKING — scene 工具行为对齐（spec A 闭环）

- `scene edit_node` 现在自动落盘到 .tscn（之前仅改内存，需配合持久化操作）。迁移：直接调 edit_node 即落盘，无需再调 save_scene
- `scene edit_node` / `batch_add_nodes` 资源属性（texture/font/audio_stream 等 `res://` 路径）现正确 load 成 Resource（之前字面赋值字符串致属性错）
- `scene edit_node` 传 `instance` 属性现被 block（I-2 安全：防注入 ExtResource 实例化恶意场景）
- `scene batch_add_nodes` 部分节点失败现返错误（之前 exit 0 静默）

### 行为变更 — ZCode 深度支持（AGENTS.md 双写 + engine-quirks 分发）

- `setup_project_rules` 现在默认同时生成 `AGENTS.md`（与 `CLAUDE.md` 并列）。`AGENTS.md` 是 ZCode / Codex / Cursor / Cline 等遵循 AGENTS.md 标准的客户端的指令来源。升级后首次运行会在项目根新增 `AGENTS.md` 并进入 git。如不需要，传 `agents_md=false`。
- `setup_project_rules` 现在分发 `godot-mcp-engine-quirks.md`（引擎陷阱知识，原仅在仓库自用 `.claude/rules/`，未纳入分发）。升级后目标项目 `.claude/rules/` 会新增此文件。

## [0.23.0] - 2026-07-13

### Fixed — Security（CRITICAL，多轮独立审查核实）

- **零确认 RCE 复合链**（`6406de4`）：`edit_script` `search_and_replace` 经 `dynamicRiskOverride` 降级 read 绕确认令牌 → 写盘注入恶意 `class_name` + `ensureClassNameImport` 自动注册 + `create_scene` `root_node_type` 无校验 + `godot_operations.gd` 脚本分支 `script.new()` 无 `is_parent_class("Node")` 检查 = 零确认 RCE。修：删 override + create_scene 加 `^[A-Za-z0-9_]+$` + script 加 `get_instance_base_type`/`is_parent_class` 对称 ClassDB 校验
- **`confirm_and_execute` elicitation out-of-band gate**（`18ef867` + review `8819ad5`/`a21fecd`）：堵 AI 自读自确认 token。单客户端 caller/session 绑定无效（AI 同 session 产生+消费 token = 假保护）→ 改 MCP `elicitInput`（server→client→user UI，AI 无法伪造响应）。review 加固：I-1 消息含 `pending.args` 预览（>500 字截断，防盲批）+ I-2 `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` opt-in 降级（默认 fail-closed，显式 true 降级+审计，与仓库 `GODOT_MCP_UNRESTRICTED` 等惯例一致）

### Fixed — editor 路由（协议断链，editor 模式工具此前系统性失效）

- **editor-method-map 登记 6 族 21 action**（`356a061`）：`animation_track`（TS 全名 action→method + `shortenAction` 转短名 add_track→add）/ `export_*`（打通 editor→GD，原 fallback headless 撞 EDITOR_ONLY 死锁）/ `particles`/`nav`（action 加 nav_ 前缀）/`animtree`/`ui`（theme 归 ui）。`ui_set_theme`/`theme_create` 因 GD handler 读 action 做聚合子分派（与 TS 顶层 action 契约不一致）不登记避 -32004 回归；`recording` GD editor 主动禁用走 bridge 不登记
- **scene/node editor 路由**（`214d44a` 等）+ `open_scene` 死映射（`7247682`，TS 入口未接 ACTIONS/switch/actionRisks）+ `manage_tools` reconnecting 卡死（`b008293`，reconnect 失败启动后台重连循环）

### Fixed — bugs

- **path_generator align_vertices 死循环**（`5b63a9c`）：`spacing<=0`+`count>=1`+`align_vertices` 组合 while d+=spacing 永真死循环卡 @tool 编辑器主线程；align_vertices 分支入口加 `spacing<=0.0` early-return 守卫（fbdd684 BUG2 count 优先修复漏此独立 if 分支）
- **scene vector3 set coerce**（`8cbac21`）：`instance_scene`/`set_instance_property` 收 Array `[0,0,-6]` 静默 no-op（Godot 4.7 `Object.set` 不自动转 Array→Vector3）；`coerce_value_for_property` 按属性真实类型转
- **asset Array color 崩 + path count 优先**（`fbdd684`）：create_material 传 `[r,g,b]` 调不存在的 String(Array) 抛 SCRIPT ERROR 材质丢失；count>=1 优先于 spacing 默认 1.0
- **data-import A1/A2/A3**（`e0882c9`/`4d5059f`）：绝对路径双盘符 + csv_to_resources 用 ctx.projectDir 非 args.project_path + instance_scene 无 pack+save 回写

### Fixed — Reliability

- **HealthMonitor 控制回路**（`85f5328`）：editor stall 检测（setState 加 onStateChange 回调 → GodotServer heartbeat 监听 → handleEditorStall 统一降级，15s×5≈75s 远快 OS keepalive ~2h）

### Changed

- **删 ReconnectionManager 死代码**（`f2773fb`，410 行）：src/ 生产零引用，真重连逻辑在 `EditorConnection.ts:448` scheduleReconnect 自实现；审查批评为假保护（与 confirm token caller 绑定同类）

## [0.22.0] - 2026-07-08

### Added — asset-forge 整合（主打：参数化 3D shape 生成）

- **merged `asset` 工具**（7 action：`create`/`path`/`batch`/`undo`/`save`/`list_shapes`/`list_materials`）：单工具聚合参数化 shape 生成 + 路径阵列 + batch 原子 undo + save 预制件。create/path/batch/undo/save 经 editor 持久化（视口可见、可 undo）；list_* 静态返回
- **11 shape**：内置 6（box/cylinder/sphere/prism/wall/ramp）+ 手写 5（cone/tube/torus/stairs/fence）
- **路径阵列**：discrete（离散放置）+ continuous（连续采样）+ align_vertices（贴合表面）
- **batch 原子 undo**：多 shape 混合批量放置，单次 undo 回滚整批
- **10 材质预设**：wood/metal/stone/glass/gold/coral/sand/seaweed/water/default
- **save resource_path 安全校验**：TS 侧 realpathSync + resolveWithinRoot 白名单（防路径遍历）
- **已知限制**：ramp 在 continuous path 模式被拒（方案 A，continuous ramp 顶点对齐复杂度阻塞；discrete 可用）

### Added — MCP 协议增强

- **`godot_get_context` 元工具**（core）：一次调用返回会话全景 11 字段（mode/project/connections/scene/recentCalls/callStats/toolGroups/workflows/rules/performance/hint），替代 AI 探路循环。readScene 三态真实采集（editor EditorInterface / bridge current_scene / headless null）+ CallRecorder 单例记录调用历史
- **MCP Roots 动态授权**（core）：client 运行时动态声明授权根（替换 `ALLOWED_PROJECT_PATHS` env 启动期固定，免改 env 须重启）。Roots 优先 env 兜底（替换式非合并）+ re-fetch 失败保留旧 roots
- **MCP Server Instructions 注入**（core）：initialize 响应携带静态中文速查卡（1417 码元，5 节 + 5 陷阱）注入 client LLM 上下文。失败兜底 undefined 优于泄露错误
- **MCP Logging 协议**（core）：`sendLoggingMessage` 按 warn/error 级 fire-and-forget 推 client（文件 + stderr 双写不变）。四重 guard 保证日志观测层绝不影响主流程

### Changed — 安全标注诚实化

- **idempotentHint 注释修正**：idempotent = 重试安全 ≠ 无副作用，readOnly 是充分条件非定义。merged action 工具保守只在纯读标 true（写动作含创建/删除/任意方法调用，auto derive 写→false 已是协议合规安全姿态）
- **README 沙箱拼装绕过例子**：诚实标注 `execute_gdscript` 检测边界（`"cu"+"rl"` / `str("OS")+".execute()"` 字符串拼装构造 API 名绕过静态正则，深度绕过由容器隔离兜底）

## [0.21.0] - 2026-07-06

### Added — csv_to_resources 新工具（CSV → Godot 资源批量导入）

- **`csv_to_resources` action**（data-import）：从 CSV 批量生成 Godot .tres 资源，双轨实现（TS parseCsv/generateImportScript + GDScript 反射/FileAccess/ResourceSaver）。CRITICAL-1 注入防护（FileAccess 零进脚本，类型白名单反射）+ CRITICAL-2 遍历防护（白名单 + resolveWithinRoot）。集成测试覆盖真 Godot 各类型 + 空值 + 遍历 + 类型错误
- **MCP 标准 ToolAnnotations**（core）：从 actionRisks 派生 `readOnly`/`destructive` hints，客户端据此优化 UI（破坏性操作确认提示等）
- **测试基础设施**：capability reviewer 设施（按子系统切 5 个只读 reviewer agent：bridge/editor-plugin/headless/data-import/recording）+ e2e L2 opt-in（`GODOT_MCP_E2E_L2=1`，默认 skip flaky bridge/recording）

### Fixed — Security（多轮独立审查核实修复）

- **RCE 安全审查 5 条**：EXTRA_METHODS 危险方法黑名单 / command_handler 客户端 force 永远视为 false / DISABLE_SAFETY+SANDBOX=disabled 双开关需 UNRESTRICTED / sanitizeMsg 敏感值脱敏 / 动态路由调 sender 前补只读拦截
- **三份审查报告 9 条 P0/P1**（ipc do_not_retry 防断连期间重试 + particle 4 setter undo + undo is_instance_valid + nav commit 顺序 + editor 录制禁用 + EditorToolExecutor 串行化 + websocket ping 响应/send_text 检查/params 防御 + sync_commands 信号清理 + gdscript-executor slot 兜底）
- **GDScript defect 批**（P1-5/P1-6/P2#1/P1-9）
- **data-import F-5~F-8 审查闭环**：`_safe_float` is_finite 守（Vector2(INF) 落盘视觉损坏）/ csv_path statSync 预检（绕过 readFileSync 阶段 OOM）/ Vector2·Color 显式 `float()` cast + Color.html `is_valid_html_color` 校验

### Fixed — Reliability（ipc + 综合审查）

- **ipc P1-4** connectGeneration 防 disconnect 后进行中 connect() 复活已断开连接
- **ipc P1-7** gdscript-executor slot 泄漏兜底
- **ipc P1-8** game-bridge invalidate race（`_socket === sock` 守卫防废弃 socket 异步 close 错误 invalidate 新 socket）
- **综合审查 P1-1** editor 模式 -32601 Unknown method 自动回退 headless（command_handler 只认扁平 method，TS (tool,action) 工具转发后落 -32601 静默失效，EditorToolExecutor 无回退）
- **综合审查 P1-2** editor_guards 接线（TS 写脚本/场景经 WS 调 guard_text_resource_write/guard_offline_scene_save，防绕过 ScriptEditor/ResourceLoader 缓存致磁盘/内存版本撕裂）
- **综合审查 P1-3** heartbeat 暂停超时改恢复 normal 检测（原 emit timeout_detected 断连与暂停容忍长操作的语义相反）

### Fixed — editor 插件 EditorInterface 4.7 兼容

- Engine singleton → `EditorPlugin.get_editor_interface()`（4.7 EditorInterface 不再注册为 Engine singleton）

### Changed

- **capability gdScriptImpl.editor 按工具命令精确路由**（EDITOR_COMMAND_ROUTING 取代 group→单文件粗粒度映射）
- **M2 证伪订正 + drift CI gate**（移除 generatedAt 噪音）

### Docs

- core.md 吸收 enhanced-boundaries 3 条工具陷阱
- agent-arch 落地状态复核 callout + agentId 假设注释
- ROADMAP #13 分发（awesome-mcp-servers PR #9067 已发 + MCP Registry 待 npm 包带 mcpName）

### Fixed — editor 插件原生类虚函数 super() 回归（654b162）

- **移除 6 处 super()**（`addons/godot_mcp_server/plugin.gd` `_enter_tree`/`_exit_tree` + `websocket_server.gd` `_ready`/`_process`/`_exit_tree` + `ui/status_panel.gd` `_ready`）：`super()`（无方法名）对原生类（EditorPlugin/Node/VBoxContainer）虚函数是 Godot Parse Error "Cannot call the parent class' virtual function ... hasn't been defined"（**4.6.2+ 均报，非 4.7 特有**），addon 加载失败/9090 不监听。IMP-4 "虚函数首行调 super" 仅适用 extends 自定义基类。
- **溯源**：654b162（v0.19.0）违反 `docs/review-followup-2026-06-18.md:93` 与 `mcp_bridge.gd` 移除 super 先例，误将 IMP-4 用到原生类；提交自承"editor 实测待专项"，从未真验证。同期 `.claude/rules/godot-mcp-editor.md` "2026-06-26 4.7 `--check-only` 全编译通过"系假绿（`--check-only <file>` 空跑不触发编译）。
- **验证**：reproducer 红绿闭环（4.7+4.6.2 super 在→parse error / super 删→通过）+ `--headless --import`（`test/fixtures/gdscript-check`）addon 全量编译干净；`defects.ts` `plugin-no-super-call` detect 反转计数"原生类虚函数有 super"=0 留 FIXED 防 654b162 式回归。

### Fixed — editor 插件 Safe save 红字（Godot #40366）

- **消除 `websocket_server.gd` "Safe save failed" 红字**：Windows 上 `FileAccess.open(WRITE).close()` 总走 atomic（写 .tmp + rename，`drivers/windows/file_access_windows.cpp:276`），杀软拦 rename → 红字（非致命，fallback 直接写仍成功，addon 照常起、9090 监听，但红字误导用户以为 addon 损坏）。代码层绕开：Windows 改用 `OS.execute("powershell", WriteAllText)` 直接写（secret 经环境变量传递，不经命令行暴露）；Linux/macOS 的 `FileAccess.close` 不走 atomic，保留 `FileAccess`；PowerShell 失败有 `FileAccess` fallback 兜底。
- **修 `_restrict_secret_permissions` anti-pattern**：`icacls /inheritance:r /grant:r USERNAME:R`（自己只读）→ `USERNAME:F`（自己全控）。R 是 anti-pattern——addon 以 USERNAME 身份运行却要覆盖自己只读的 key，只能靠 FileAccess atomic rename 绕 ACL，正是红字根源。F 让 PowerShell 能直接覆盖写；其他用户因 `inheritance:r` 无 ACE（比 R + 继承残留更严，实测仅 `USERNAME:F`）。
- **验证**：4.7 `--editor --headless` 实测两次（key 新建 + 覆盖）零 Safe save 红字 + `Listening 9090` + key 写成功；`icacls` 实测 ACL 仅 `USERNAME:F`、其他用户零 ACE；F key 可覆盖写。
- **同步 `src/scripts/mcp_bridge.gd`**（DUPLICATE 注释约束）：`_write_secret_to_file` + `_restrict_secret_permissions` 同款修复（Windows PowerShell 绕 atomic + F ACL）。4.7+4.6.2 `--headless` load 编译干净。

## [0.20.0] - 2026-06-30

### Added — cpp GDExtension 脚手架 + 全工具验证靶子

- **cpp `scaffold_gdextension`**：新工具，生成 8 文件 C++ GDExtension 工程骨架（不联网/不编译），填补竞品 C++/GDExtension 赛道空白
- **全工具验证靶子**：`test/fixtures/real-project/` 真实多子系统无 autoload 靶子 + 三层（L1 headless 静态 / L2 运行态 / L3 特殊环境）全自动化验证，覆盖 28/30 顶层工具正路径
- 含 R3 审查修复、全面安全审查 H1-M4 修复（累计自 v0.19.1 的本地增量）

### Fixed — 工具行为一致性(反假绿驱动)

- **default-null 统一**:25 处 `default return null` + 6 处 action 校验 null → `opsErrorResult('UNKNOWN_ACTION')`(工具自报,替代 dispatcher 兜底 HANDLER_NULL);同步修现有 e2e 假绿(ui build_layout/create_control、project info 从未真执行却"通过")
- **run_project bridge-not-ready isError**(bug):`wait_for_bridge + !ready` → `errorResult`(isError:true);修复前 `textResult` isError:false 误报(到 game_query ping 才暴露 BRIDGE_NOT_CONNECTED)
- **run_project timeout race**:提取 `computeRunTimeout` 纯函数,`wait_for_bridge` 时 `timeout ≥ bridge_timeout + 10`(防 auto-stop 与 bridge 就绪 race 致游戏被提前 kill)

## [0.19.1] - 2026-06-27

### Fixed — 版本元数据同步

v0.19.0 发版后版本元数据漂移修复(npm v0.19.0 基于 tag 2a48d06,manifest/plugin.cfg 仍 0.18.2):

- `manifest.json` / `addons/godot_mcp_server/plugin.cfg` / `docs/使用指南.md`: 0.18.2 → 0.19.1(同步)
- `README.md` 版本表补 v0.19.0/v0.18.2 行

注: v0.19.0 npm 包元数据漂移(manifest/plugin.cfg 0.18.2),v0.19.1 彻底同步。功能无变化。

## [0.19.0] - 2026-06-27

### R2 审查响应链(12 commit, CI 全绿)

3 CRITICAL(1 修 + 2 push back 经 TDD 实测) + 安全同源 4 点 + IMP-11 touch 双侧 + 阶段1b 守卫 + editor 插件 undo_manager + super() IMP-4 + 2 defect 闭环(@739 wontfix / @748 fixed)。

#### Fixed — CRITICAL

- **detachInstance 双 parent 属性**(`tscn-editor-detach.ts:441/444/445`): `parent=""` 空串子节点 detach 时,原 `[^"]+` 正则不匹配空串走 else 叠加,残留 `parent=""` → 双 parent 属性致 Godot 解析失败。修复: 正则 `[^"]*` + `:444` 空串等同 `.` 守卫。诚实纠错 CRITICAL-3(阶段3 push back 漏网双 parent)
- **recording MAX_EVENTS 双侧上限**(`recording.ts` + `mcp_bridge.gd`): 录制事件无界增长 → TS 回放 + GDScript 录制双侧上限

#### Fixed — 安全同源(已修未传播至同类)

- **UI BLOCKED_PROPS**(`ui/types.ts` + `ui/index.ts` + `ui-layout.ts`): findBlockedProps 抽 shared + handler 前置硬拒(平铺)/生成层 warnings(嵌套)
- **audio stream_path sanitizeResPath**(`audio-ops.ts`): 同源对齐 res:// 路径校验
- **instance-api-auth symlink**(`instance-api-auth.ts`): lstatSync 检测 + unlink 防 writeFileSync follow symlink
- **instance-manager 段级路径遍历**(`instance-manager.ts`): `includes('..')` 误拒合法路径 → 段级 `seg === '..'`

#### Fixed — 契约双侧

- **IMP-11 touch/ScreenDrag 双侧契约**(`recording.ts` + `mcp_bridge.gd`): TS 回放加 touch 分支(此前 silently skip) + bridge 补 `_cmd_send_touch`/dispatch/`_input` 录制(对齐 `recording_commands.gd`)

#### Added — editor 插件 undo_manager + super 一致性

- **:649 nav/particle/animtree/ui commands 接入 undo_manager**(`command_handler.gd` + 4 模块): setup 加 undo_manager 参数 + 7 处 `add_child+set_owner` 包装 `create_action_mixed`(逐字复用 `node_commands:60-73` 已验证模式) + 补 cleanup()(统一接口)。editor 模式 nav region/agent/link、particles、AnimationTree、UI control/container 创建可 Ctrl+Z 撤销
- **super() IMP-4 一致性**: plugin.gd `_enter_tree`/`_exit_tree` + websocket_server.gd `_ready`/`_process`/`_exit_tree` + status_panel.gd `_ready` 共 6 处加 super()

#### Fixed — 守卫

- **阶段1b 守卫**: EditorConnection connect catch 加 `authenticated=false`(覆盖 performAuth reject/timeout/catch 三路径); ui-theme color 元素 `Number.isFinite` + constant NaN 守卫; tscn-editor-add `incrementLoadSteps` `-?\d+` 匹配负值 + `Math.max(1,n)` clamp

#### Defect 闭环

- **@739 scene-merge 字面量 wontfix**(= CRITICAL-1): 双重保护(正则 `[^"]+` 护城河 + map key 隔离)防字面量 ExtResource/SubResource 篡改。双侧回归测试固化。detect 精确化(避免粗略 detect 复测误重开)
- **:383 nodeName 注入确认已修**(IMPORTANT-5): escapeTscnAttr `$→$$` 转义(`tscn-editor-shared.ts:38`)根因修复覆盖所有 detach/merge 调用点

#### 验证

- TDD red→green(@748 双 parent / IMP-11 touch / 守卫); validate_scripts 0 errors(editor 插件 5 文件); tsc 0; 全测试套无回归
- CI 全绿(12 commit)
- 2 次诚实纠错(阶段5 super push back + @748 CRITICAL-3 push back): push back 须查项目规则 + 穷尽失败模式,静态推理易漏

## [0.18.2] - 2026-06-18

### 安全 — 沙箱加固与防御深度

全面审查修复(GDScript 沙箱绕过组 + 防御深度一致性 + 注入面收敛):

- **沙箱绕过组**(`gdscript-executor.ts`):拼接窗口 4→8(MAX_CONCAT_WINDOW)、补 `Engine/FileAccess/DirAccess/JavaScriptBridge` 索引访问拦截、`Expression.execute` 正则跨行(`[\s\S]{0,500}?` 防 ReDoS)、`ResourceLoader.load` 正则去贪婪、`detectAutoloadUsage` 改 stripLiterals 骨架扫描消除注释误触
- **stripLiterals res:// 保留 + 三引号归一**:剥字符串内容时保留 `res://` 前缀(消除 `load("res://")` 误报回归);三引号开/闭引号归一为单个(让单 `"` 正则覆盖三引号,避免负向预查回溯陷阱)
- **HMAC 启动警告**(`GodotServer.ts`):MULTI_INSTANCE 启用时警告 verifyApiToken 是发送端 only(零生产接线)(注:0.28.x 起 MULTI_INSTANCE 接收端已落地 `verifyApiToken` 闭环——见 instance-http-server.ts 入口验签,本行描述仅反映 0.18.2 当时状态)
- **rate limit 中间件**(`middleware.ts`):createRateLimitMiddleware(全局 60 次/秒软限防 AI 失控循环)
- **scene-commit 转义 + 校验**:serializeGdValue 补 `\r`/`\t` 转义、validateCommitOperations 结构校验(替代 as unknown as 强转)
- **P0 命令注入收敛**:`generate-doc-db.js` execSync → execFileSync 数组参数;`.cursor/mcp.json` 本地路径 example 化 + gitignore

### GDScript 插件

- **bridge super() 修复**(`mcp_bridge.gd`):移除 extends Node 虚函数的 super()(Godot 4.6.2 Parse error;IMP-4 convention 仅适用自定义基类)。GUI 4.6.2 闭环验证(Listening + pong + WASD)
- **command_handler .name**(`websocket_server.gd`):设 `.name="command_handler"`,修 plugin.gd cleanup 死代码
- **instantiate_class Node 检查**(`godot_operations.gd`):补 is_parent_class("Node") 堵非 Node 引擎类
- **ui_commands 白名单**:ALLOWED_CONTROL_TYPES(29 种)替代 is_parent_class 兜底

### 可靠性

- **cleanupOldSessions 降噪+防卡**(`gdscript-executor.ts`):try 移入循环 + EPERM 聚合 + MAX_CLEANUP_PER_RUN=10 上限(根因:190 累积 stale 目录 × retryRm 退避致 E2E 60s 超时,全量 461s→13s)

### 测试与文档

- **E2E CI 假绿修复**:GODOT_PATH 默认空(强制显式,避免 CI 静默 skip 假绿)
- **deprecated TODO v0.20.0**、**ROADMAP 历史里程碑化**、**增量复审 issue 清单**(`docs/review-followup-2026-06-18.md`)

### 验证

- 全量 **2670+ passed / 0 failed**(155 文件)、build/lint EXIT 0、EPERM 0、E2E 13s
- 2026-06-18 全面审查(16 IMPORTANT + 17 ADVISORY)与增量复审(Top 3 P0)已处理

## [0.18.1] - 2026-06-14

### Fixed — 3 个阻塞性 CRITICAL（功能验证审查发现并修复）

经实际 MCP 工具调用验证（在 godot-test-project 端到端测试），修复了 3 个导致核心功能不可用的 CRITICAL 缺陷：

1. **parseTscn 节点属性解析**（`src/tscn-parser.ts`）：`parseTypedValue` 原用冒号 `:` 查找类型分隔符，但 Godot 4.x 节点多行属性格式为 `key = value`（等号），导致 `position`/`script`/`color`/`texture` 等所有多行属性被整行塞进 `name`/`value`，`ExtResource`/`Color`/`Vector2`/`Vector3`/`NodePath`/数组/字典的类型解析逻辑从未触发。改为优先用 `=` 分隔，`value` 经 `parseValue` 正确解析为结构化对象。**实测**：`read_scene` 现在返回 `{name:"script", value:{__type:"ExtResource", id:"1_dodge"}}` 而非整行字符串；`color = Color(0,0,0,1)` 解析为 `{__type:"Color", value:"0, 0, 0, 1"}`；含 `/` 的属性名（如 `theme_override_font_sizes/font_size`）保留完整路径。

2. **parseTscn 头部解析**（`src/tscn-parser.ts`）：`startsWith('gd_scene')` 漏了方括号，实际行是 `[gd_scene ...]`，导致 `header` 恒返回 `{}`，`format`/`load_steps`/`uid` 全部丢失。改为 `startsWith('[gd_scene')` + 正则提取方括号内属性。

3. **wait_for_node / wait_for_property 真正等待**（`src/tools/game-bridge.ts`）：Bridge 端（`mcp_bridge.gd`）的 `_cmd_wait_for_*` 是单次同步快照，工具命名与文档却暗示异步等待，导致所有依赖"等待条件成立"的自动化流程静默失败。新增 `pollWaitCondition`：在 `timeout` 窗口内按 `interval_ms`（默认 200ms，范围 50-2000）反复探测，条件成立立即返回，超时返回 `timed_out`，error 立即中止。返回值新增 `wait_completed`/`elapsed_ms`/`timed_out`，向后兼容。

### 验证

- 全量测试：**2597 passed / 0 failed**（+20 新测试覆盖修复，0 回归）
- 新增测试：`test/tscn-parser.test.js`（属性/头部解析各类型）、`test/game-bridge-wait.test.ts`（轮询/超时/error 中止/向后兼容）
- 端到端实测：`read_scene` 在 dodge/pong/main 三场景确认属性与头部正确解析（ExtResource/Color/数字/字符串/负数/浮点/含 `/` 的属性名）

## [0.18.0] - 2026-06-10

### Breaking Changes — 工具合并（39 → 27 MCP 工具）

9 个独立 MCP 工具被吸收进相关工具组，工具名不再独立存在：

| 旧工具名 | 新路由 | 说明 |
|----------|--------|------|
| `node_create_3d` | `scene(action="create_3d_node")` | 3D 节点创建并入场景工具 |
| `scene_commit` | `scene(action="commit")` | 批量场景提交并入场景工具 |
| `recording` | `runtime(action="record_start/stop/save/load/play")` | 录制系统并入运行时工具 |
| `templates` | `project(action="list/apply")` | 代码模板并入项目工具 |
| `ik` | `animation(action="ik_modifier_create/get/set/list_bones")` | IK 系统并入动画工具 |
| `test` | `validation(action="assert/stress/export_*")` | 测试框架并入验证工具 |
| `game_design` | `validation(action="validate_gdd/chain_verify")` | 游戏设计验证并入验证工具 |
| `verify_delivery` | `validation(action="verify_delivery")` | 交付验证并入验证工具 |
| `batch` | `workflow(action="create_files/run_verify/diff_scenes")` | 批量工具并入工作流工具 |

### Migration Guide

**自动迁移**：调用 `manage_tools(action="migrate")` 获取完整映射 JSON。

**Legacy 兼容模式**：设置环境变量 `GODOT_MCP_WARN_LEGACY=1` 可让旧工具名继续工作（打 warning），保留一个版本后移除。

**手动迁移**：将旧工具调用替换为新路由：
```
旧: node_create_3d(type="Node3D", name="Player", ...)
新: scene(action="create_3d_node", type="Node3D", name="Player", ...)

旧: recording(action="start", ...)
新: runtime(action="record_start", ...)
```

### Added

- **LEGACY_TOOL_MAP**: 旧工具名到新 (tool, action) 的迁移映射表
- **notifyToolsChanged**: `manage_tools` 的 activate/deactivate 操作后发送 MCP `notifications/tools/list_changed`
- **manage_tools migrate action**: 输出完整迁移映射 JSON
- **ErrorCodes 集中定义**: `src/core/error-codes.ts` — MISSING_ACTION/UNKNOWN_ACTION/MISSING_REQUIRED_PARAM/HANDLER_ERROR
- **ActionResult 统一响应**: `src/core/action-response.ts` — wrapResult/toToolResult 兼容旧格式
- **Common Schema**: `src/core/common-schemas.ts` — 共享参数定义 + withCommonParams
- **50 条意图→action 选准率测试**: 验证 action 命名语义化

### Changed

- `ToolDispatcher.dispatchTool`: 新增 legacy fallback 路由，旧工具名自动映射到新 (tool, action)
- `GodotServer`: 注入 MCP Server 实例给 tool-registry（listChanged 支持）
- `module-loader`: 移除 9 个被吸收模块的注册（文件保留，handler 被目标模块导入）

## [0.17.2] - 2026-06-09

### Security

- **F-05**: `_generate_secret()` 截断时返回空字符串 + 拒绝启动 WebSocket/Bridge 服务 — 防止使用弱密钥运行（`websocket_server.gd` + `mcp_bridge.gd`）
- **F-01**: CI/非 TTY 环境下 `isPathInAllowedRoots` 日志级别从 `info` 提升为 `warn`，提醒运维人员配置 `ALLOWED_PROJECT_PATHS`
- **F-02**: `EditorConnection` 客户端白名单移除 `0.0.0.0` 和 `::` — 仅允许明确的 localhost 地址

### Changed

- **F-03**: 移除 `EditorToolExecutor` 中 `_use_undo` 半实现标志 — 插件端未准备好，参数改为原样透传
- **F-04**: 多实例路由添加 `EXPERIMENTAL` 警告日志，明确告知用户功能未完成

### Removed

- A-04: `index.ts` Profile 类型从 `as` 强制断言改为显式 `string`

### Added

- A-03: `parseConfigValue` 递归深度限制（8 层）添加说明注释

## [0.17.1] - 2026-06-08

### Fixed

- **CRITICAL-1**: 删除 `tscn-editor.ts` 中 8 个无引用导出函数（`editNodeProperty`、`deleteNode`、`addConnection`、`removeConnection`、`setNodeScript`、`changeNodeType`、`addExtResource`、`addSubResource`）及 `ResourceAddResult` 接口 — 净减 ~527 行死代码
- **CRITICAL-2**: 解耦 core ↔ tools 双向依赖 — `ToolCallDelegate` 类型定义提升到 `types.ts` 共享层，`ToolDispatcher` 改用构造函数注入 delegate，`GodotServer` 组合根负责连接
- **CRITICAL-3**: `animation-ops.ts` 补充 38 个单元测试 — 参数验证（15）、GDScript 生成验证（13）、路由与导出（5）、边界（5）
- **CRITICAL-4**: `EditorToolExecutor.ts` 补充 16 个 mock 测试 — sync 生命周期、treeChangeRing 缓冲区、reconnect 处理、execute 分支
- **S-03**: `game-bridge.ts` 移除 Bridge 密钥 tmpdir 回退 — `_projectDir` 未设置时抛出明确错误，不再静默回退到全局可读的临时目录
- **S-04**: `editor-auth.ts` 权限检查顺序修正 — `checkFilePermissions()` 先于 `readFileSync()` 执行，拒绝不安全权限的密钥文件
- **D-02**: 删除 `spatial-ops.ts` 空壳文件及 `module-loader.ts` 引用 — 功能已迁移到 `physics-ops.ts`

### Changed

- 工具模块统一使用 `requireProjectPath` 辅助函数，减少重复代码

### Removed

- `src/tools/spatial-ops.ts`（空壳，功能已在 physics-ops.ts）
- `test/spatial-ops.test.js`（对应测试）
- `test/tscn-editor-resources.test.ts`（仅测试死代码函数）

## [0.17.0] - 2026-06-07

### Fixed

- **C-01**: `parseTscn` 中 `rootNode` 多根节点覆盖保护 — 防止畸形 .tscn 文件解析错误
- **C-02**: `deleteNode` 删除节点后递减 `load_steps`，与 `addNode`/`detachInstance` 行为一致
- **C-03**: `addNode` 对含路径的 parent 参数使用 `findNodeSectionLine` 精确匹配，避免同名节点歧义
- **C-04**: 沙箱安全限制文档扩展——列出已知绕过向量（字符串拼接、变量间接调用）和适用场景
- **I-02**: `EditorConnection` 构造函数增加 `0.0.0.0` / `::` 拦截，防止绑定所有接口
- **I-04**: `normalizeArgs` 递归深度超过 5 层时输出 log 警告
- **I-06**: `remapSubResourceIds` / `remapSubResourceRefs` 支持 Godot 4.x 字符串 UID（如 `StyleBoxFlat_xb1kx`）
- **I-07**: `confirm_and_execute` 检测 args 截断标记，拒绝执行不完整代码并返回 `ARGS_TRUNCATED` 错误
- **I-08**: editor 模式 `_duration_ms` 追加前检查是否已存在，避免重复输出

### Security

- **SEC-REV-01**: `isPathInAllowedRoots` 策略从 deny-by-default 恢复为 allow-by-default。v0.15.0 的 C-SEC-01 引入 deny-by-default（未配置时仅允许 `process.cwd()`），但 `npx` 启动场景下 `cwd` 是缓存目录而非用户项目，导致合法用户被阻断且无恢复路径。现改为：未配置 `ALLOWED_PROJECT_PATHS` 时允许所有路径并记录 info 日志；用户可通过设置 `ALLOWED_PROJECT_PATHS=/path1;/path2` 选择性启用白名单限制

### Fixed

- `DEFAULT_SKIP_DIRS` 移除 `'addons'` 和 `'tools'` — 插件和工具是用户代码目录，不应被默认跳过。修复 `list_files`、`get_project_info`、`validate_scripts`、`validate_project` 无法发现 addons 资源的问题
- `collectFilesByExt` / `validate_project` / `project_replace` 中硬编码的 `['addons', 'tools']` 同步移除
- `verify_delivery`（交付检查）**有意保留**跳过 addons — 第三方插件代码不纳入交付质量门禁
- `_pathAllowLogged` 从共享 boolean 改为 per-key `Set` 去重 — `GODOT_MCP_UNRESTRICTED` 和未配置 `ALLOWED_PROJECT_PATHS` 的日志消息各自独立去重

## [0.15.1] - 2026-05-27

### Fixed

- **#7**: Godot 4.6 editor plugin 兼容性 — `undo_manager.gd` 使用 `Callable.bindv()` 替代多参数 `add_do_method`；`scene_commands.gd` 替换已移除的 `String.is_alpha()`；`ui_commands.gd` 替换已移除的 `GROW_DIRECTION_UP/DOWN/LEFT/RIGHT`
- `nav_commands.gd` 修复遗漏的 `bake_navigation_mesh()` 返回值捕获
- `navigation.ts` 生成的 GDScript 中 `bake_navigation_mesh()` 返回值捕获 — 去掉 void 返回值捕获，改用 `navigation_mesh != null` 检查
- `ui_commands.gd` match 语句添加 `_` 默认分支返回错误
- `undo_manager.gd` 添加 null target 防御
- `validation.ts` 嵌套 spawn 补上 `buildSafeEnv()`
- `screenshot.ts` 和 `project.ts` 替换 `as string` 为类型守卫/requireString

## [0.15.0] - 2026-05-27

### Security

- **C-SEC-01**: `isPathInAllowedRoots` 改为 deny-by-default — 未设置白名单时仅允许 `process.cwd()`，新增 `GODOT_MCP_UNRESTRICTED` 环境变量作为逃生阀
- **I-SEC-01**: `list_projects` 的 `search_dir` 参数添加白名单检查，修复绕过漏洞（含 editor 分支）
- **C-SEC-02**: 可选 GDScript 沙箱警告扫描器 — `GODOT_MCP_SANDBOX=strict` 启用，检测 `OS.execute`/`DirAccess.remove`/`FileAccess.open(WRITE)` 等危险操作

### Fixed

- **C-TYP-01**: game-bridge 连接锁 — `_ensureConnection` 拆分为 `_doConnect` + Promise 链锁，防止并发连接竞争
- **C-TYP-02**: process-state TOCTOU 竞争 — `acquireProcessSlot()` 原子操作替代 `isProcessBusy` + `setProcessBusy` 两步模式
- **C-Q-01**: test_stress GDScript 缩进修复 — 空格改为 tab，修复 mixed indentation 解析错误
- **C-Q-02**: 录制功能重构为 Bridge TCP 模式 — start/stop 通过 Bridge 命令实现，修复跨进程状态不可用的架构断裂
- **I-Q-06**: ik-tools.ts 两处 `as any` 替换为 `readonly string[]` 类型守卫
- **I-Q-07**: 4 处 `as Record` 断言添加运行时 object 类型校验
- **I-Q-08**: 7 处关键空 catch 块（子进程/文件 I/O/网络）添加 `console.debug` 日志

### Changed

- **C-Q-03/04/05**: material-ops 提取 `parseMaterialParam` 共享函数；tilemap-ops 提取 4 个辅助函数（layerArg/nodePreamble/tilemapBranch/tilemapCall），净减 101 行
- **I-Q-01/02**: `ensureNumber`/`clampParam`/`validatePositiveInt` 统一到 `shared.ts`，消除 6 个模块的重复定义
- **C-CI-01**: 新增 ESLint 配置（warn-only）+ CI lint 步骤

### Added

- **C-CI-02**: gdscript-executor 核心函数测试 +38（wrapSnippet/buildSafeEnv/createAutoloadLoaderScript 等）
- **C-CI-03**: delivery.ts 维度测试 +50（scene_tree/script_health/performance/assertions），覆盖率 3% → 80%
- **I-CI-01**: GDScript 代码生成正确性测试 +70（gdEscape/SCENE_TREE_HEADER/stressTest/recordingPlay 等）
- 录制功能 Bridge 端：`mcp_bridge.gd` 新增 `_cmd_recording_start/stop` + `_input` 回调

### Post-Review Fixed

- **C-1**: `scene.ts` query_scene_tree/inspect_node 进程槽泄漏 — 7 条退出路径（early return + timeout/close/error 回调）补充 `setProcessBusy(false)`，修复永久锁死
- **I-4**: `recording.ts` 冗余动态 `await import('./game-bridge.js')` 统一为静态导入

## [0.16.0] - 2026-05-31

### Security

- **SEC-01**: Windows 密钥文件 ACL 验证 — `editor-auth.ts` 和 `game-bridge.ts` 的 `icacls` 调用增加 username 格式校验 + 回读验证，确保权限实际生效
- **SEC-02**: `resolveWithinRoot` 路径穿越防护加强 — 预检 `..` 片段 + `safeRealPath` 回退路径 base 校验，堵死 symlink + 编码绕过
- **SEC-03**: README 移除 `execute_gdscript` 自动批准建议，降低任意代码执行风险
- **SEC-04**: GDScript 执行器输出缓冲区 10MB 上限 — 超限截断并强制终止进程树，防内存耗尽
- **SEC-05**: `splitTopLevel` 元素数量上限 10000，防 O(n²) ReDoS
- **SEC-06**: `project_replace` 扩展名白名单（`.gd/.tscn/.tres` 等）+ 硬编码排除 `.git`/`node_modules`
- **SEC-07**: `add_node`/`batch_add_nodes` 标识符正则校验 (`/^[A-Za-z0-9_]+$/`) + 批量上限 100

### Fixed

- **C-01**: EditorConnection 认证超时不再意外调度重连 — 在 `ws.close()` 前设置 `connectAttempt=true`
- **C-02**: Autoload loader 脚本的错误标记随机化 — `randomizeMarkers` 应用到 loader，防止用户代码伪造错误输出
- **C-03**: 进程替换保护 — `setProcessBusy` 守卫机制，运行中的进程不会被其他工具意外 kill
- **T-01/T-02/T-03**: test-framework 和 validation 的 GDScript 使用 `_initialize()` 替代 `_init()`，修复场景树未就绪时节点查找失败；修复 stress test `await process_frame` 缩进
- **T-04/T-05**: physics-ops raycast 添加 `World3D` null 检查，ik-tools owner 设置添加 root null 检查
- **S-02**: 确认令牌不再截断代码 — 用户可审查完整待执行内容
- **I-03**: 参数键只保留 snake_case 版本，消除 camelCase/snake_case 双键冲突
- **T-09/T-10**: ui-tools 生成的 GDScript 统一使用 tab 缩进；`draw_arc` 补充 `point_count` 参数
- **I-06**: `parseConfigValue` 空白字符串不再被错误解析为数字 0
- **I-01**: `gdEscape()` 移除无效的 `$` 转义 — GDScript 双引号字符串中 `$` 不是特殊字符（仅在表达式级别用于 NodePath）
- **I-02**: `ToolDispatcher` 统一所有错误响应使用 `opsErrorResult()` — 7 条路径从混用纯文本/手动 JSON 改为结构化 JSON
- **A-10**: `editor-auth.ts` 消除 TOCTOU 竞争 — 去掉 `existsSync()` 前置检查，直接 `readFileSync()` + try-catch
- **A-01**: `tscn-parser.ts` parseDictContent 分隔符检查 `:` 优先于 `=`（Godot 4.x 标准用冒号）
- **A-02**: Godot 二进制搜索增强 — `detectProjectPath` 深度 5→15，新增 `GODOT_PROJECT_PATH` / `GODOT_MCP_SEARCH_PATHS` 环境变量，扩展用户目录搜索（Downloads/Desktop）
- **C-01**: `godot_operations.gd` return 语句缩进修复（1tab→2tab）+ 混合行尾统一

### Changed

- **A-11**: `.gitignore` 新增 `.ruff_cache/`、`.reviews/`、`.claude/worktrees/`、`tsconfig.tsbuildinfo` 等条目
- **I-03/I-04/I-05**: `EditorConnection.notify()`、`process-state` 并发安全、`gdscript-executor` 沙箱扫描器局限性 — 补充 JSDoc 文档注释

### Added

- `process-state` 新增 `isProcessBusy()` / `setProcessBusy()` 导出
- 新增 17 个测试：busy guard (6)、parseConfigValue (10)、auth timeout reconnect (1)

## [0.12.0] - 2026-05-23

### Added

- **#10**: CSS Grid 翻译层 — `ui_build_layout` 的 `layout.direction` 支持 `"grid"`，使用 GridContainer，支持 `columns` 参数
- **#11**: EditorConnection 重连上限 — `maxReconnectAttempts` 选项（默认 20），超过后停止重连并触发 `onDisconnect`

### Changed

- **#7**: requestId 取模保护 — `websocket_server.gd` 和 `EditorConnection.ts` 的自增 ID 添加 `%` 取模，防止溢出
- **#9**: L015 lint 规则改为逐行扫描 + `isInCommentOrString` 过滤，消除注释/字符串中的误报
- **#6**: `edit_node` 和 `trySetHelper` 属性名自动 camelCase→snake_case 转换，MCP 调用方无需手动转换

## [0.11.1] - 2026-05-22

### Security

- **C1**: EditorConnection 消息大小限制从 `raw.length`（字符数）改为 `Buffer.byteLength(raw, 'utf8')`（字节数），修复多字节字符绕过 1MB 限制。
- **C2**: TCP Bridge 添加 `MAX_MESSAGE_SIZE`（1MB）缓冲区限制，超限时断连对端，与 WebSocket 服务端对称。
- **C3**: `_cmd_wait_for_property` 添加属性屏蔽检查，防止读取被屏蔽的属性。
- **C4**: 提取 `_is_blocked_property()` 统一函数，检查所有点分路径段而非仅首段。
- **M1**: `_is_blocked_property` 补充 `theme_override` 前缀屏蔽。
- **I2**: 点分段遍历中增加下划线前缀检查。

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

---

## 早期版本概览(v0.1.0–v0.9.0 + v0.13.0 / v0.14.0)

> 早期版本无详细 Added/Fixed 记录,此处保留概览(2026-06-28 从原 ROADMAP 历史里程碑迁移,防丢失)。v0.10.0–v0.12.0 / v0.15.0+ 见上方详细变更;v0.13.0 / v0.14.0 暂仅概览(详细待补)。

### v0.14.0(2026-05-24)

7 轴全维度审查修复 + IK 框架 MVP + 测试基础设施升级。

- IK 框架 MVP(4 工具):ik_modifier_create / ik_modifier_get / ik_modifier_set / ik_list_bones
- 7 轴审查:8 CRITICAL + 20 IMPORTANT + 14 ADVISORY 发现,全部 CRITICAL 已修复
- 测试迁移 node:test → Vitest,1257 测试通过,47% 覆盖率;CI/CD GitHub Actions(Node 20/22 矩阵)

### v0.13.0(2026-05-23)

Bridge 安全加固 + 功能增强(C-01~C-03、requestId 取模、EditorConnection 重连上限、CSS Grid 翻译、edit_node camelCase→snake_case、L015 lint 逐行扫描)。

### v0.9.0(2026-05-16)

审查反馈 + 架构优化(118 工具,463 测试):批量工具 / UI 工具 / 录制系统(5 工具)/ editor_sync / 确认令牌 / Read-Only 模式 / Lite 模式。

### v0.8.0(2026-05-13)

架构升级(96 工具):双模式架构(Editor WebSocket + GDScript 插件 + UndoManager)/ 测试框架 + 导出管理 / 高级工具集(粒子+导航+AnimationTree)。

### v0.7.0 及更早

| 版本 | 日期 | 要点 |
|------|------|------|
| v0.7.0 | 2026-05-08 | 安全加固:输入转义、超时泄漏、类型安全、crypto.randomUUID |
| v0.6.0 | 2026-05-03 | 音频播放控制(4) + TileMap 编辑(8) |
| v0.5.0 | 2026-05-02 | 信号控制(4) + 物理查询(2) + 3D 创建(1) + 导航寻路(1) |
| v0.4.0 | 2026-05-01 | 版本检测 + validate_scripts + search_and_replace |
| v0.3.0 | — | edit_script + batch_add_nodes + validate_project + import_resources |
| v0.2.0 | — | read_scene + read/write_script + query_scene_tree + MCP Resources |
| v0.1.0 | — | 基础功能:项目/场景/执行控制/截图/API 文档 |
