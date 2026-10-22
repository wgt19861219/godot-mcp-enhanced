# 2026-10-21 审查:fix/undo-max-steps(编辑器 undo 历史上限 200)

> 分支 `fix/undo-max-steps`(基于 master `fcab502b`)。审查者:code-reviewer 子 agent(独立上下文,不预设实现者声明为真,33 次工具调用逐项 Grep/Read 实测);实现者对审查 Nit-1 的计数另做了管道复核。审查报告全文要点收录如下,Nit 处置与门禁复跑由实现者补记。

## 背景与根因(40GB 内存事故溯源批)

AI 经 MCP 的每次场景 mutation 都 commit 进 Godot 编辑器 undo 栈,而 `UndoRedo.max_steps` 默认 0 = 无上限(官方文档,4.5 与 4.7 双侧核实),长 AI 会话数千次编辑致编辑器内存单调增长(2026-10-21 40GB 事故三因子之一;引擎侧另有 #74698/#82769 已知泄漏叠加)。

## 改动面

- `addons/godot_mcp_server/undo_manager.gd`:新增 `MAX_UNDO_STEPS = 200` + `_cap_undo_history()`(经 `get_history_undo_redo()` 设各 history 的 UndoRedo 上限;global + 当前编辑场景两条都盖,幂等;场景未打开只盖 global);`create_action_mixed()` 每次调用前执行 cap。
- `addons/godot_mcp_server/testing/suites/test_undo_manager.gd`:新增 `test_create_action_caps_undo_history`(断言两条 history 的 max_steps 落位,含 null 防御);头部覆盖清单 5→6 funcs。
- `CHANGELOG.md` [Unreleased] 条目。

## 审查判定:SHIPPED WITH NITS

### 逐维度结论(审查者核实)

- **A 设计正确性 — 通过**:cap 时机在 `create_action` 之前;幂等(`!= MAX_UNDO_STEPS` 才写);两条 history 覆盖与 create_action 无 custom_context 的推断规则(Node→场景 history,非 Node→GLOBAL_HISTORY)匹配;`ei == null`/`scene_root == null` 边界只盖 global,与注释一致;共享栈产品影响已在头注释与 CHANGELOG 如实披露。已知可接受残余窗口:场景切换后新 history 在 AI 首次 mutation 前未 cap(边缘场景,注释覆盖主语义)。
- **B GDScript API 用法 — 通过**:`docs/api/extension_api.json`(4.7 导出)核实 EditorUndoRedoManager 继承 Object 零属性无 max_steps(:108988-109260),UndoRedo 有 max_steps(:332485);`get_history_undo_redo`/`get_object_history_id` 签名匹配;`EditorPlugin.get_editor_interface()` 符合仓库规约(CHANGELOG 0.34.1 批先例);tab 缩进一致。
- **C 测试质量 — 通过(带 Nit)**:test 10 真测行为(删掉 `_cap_undo_history` 则 max_steps 回落 0,测试必红);基座用法与 `mcp_test_suite.gd` 的 assert_eq/skip_suite 语义吻合;不触发 200+ 步真实裁剪的决定合理(避免污染用户 undo 历史,裁剪语义由引擎文档保证)。
- **D 仓库级约束 — 通过**:`rule-templates.ts`/`.claude/rules/` 零涉及(无需版本 bump 与 rules-sync);addons 改动无需 build 同步(打包对象是 `src/scripts/*.gd`,addons 是分发目录);工具清单未变无需 build-matrix;**4.5 分发兼容性经 Godot 4.5 官方文档在线核实成立**(双侧:4.5 文档 + 4.7 extension_api.json)。
- **E 验证完整性 — 基本充分**:check:gdscript 的 fixture 覆盖 addons 全目录(`check-gdscript.ts:52-70`,报告 files=40 = addons 34 + src/scripts 6,精确吻合);test 10 需编辑器上下文本批未运行,如实列为已知缺口,随部署批闭环。

### Blocking Issues

无。

### Nits 与处置

1. **[应修,已修] 生产调用计数错误**:初版 CHANGELOG/头注释写 50 处,审查逐行核对实为 **37 处**——`grep -c` 含文件内注释(node_commands 2 行/ui_commands 6 行/asset_placer 5 行是注释),实现者只剔了跨文件显式注释漏剔文件内注释。实现者管道复核(`grep -vE ':[0-9]+:\s*#'` 后 37 行,分布 node 4/ui 8/animation 7/particle 5/nav 5/animtree 4/scene 2/asset_placer 2)与审查逐行核对一致,**两处文档已修正**。原文件头的历史注释(50/6/14/7)犯的是同一个错。
2. **[已修] test 10 null 防御**:`global_ur`/`scene_ur` 直接取属性改为先 `assert_true(!= null)`(对齐 `mcp_test_suite._collect_histories` 风格),null 时断言失败而非 SCRIPT ERROR。
3. **[留部署批] test 10 运行闭环**:编辑器行为测试需编辑器上下文,部署批执行时把 undo_manager suite 结果贴进部署验证记录。

### Nit 修复后门禁复跑(实现者)

- `npm run lint`:0 errors / 533 warnings(锁定值)✅
- `npm run build` ✅
- `npm test`:7281 passed + 1 failed = `test/integration/ui-import-integration.test.ts:141` 耗时绊线(expected <10000ms,actual 10173ms,超 1.7%)——真跑 Godot 的性能测试,与本次 `.gd` 改动无关(undo cap 不在其执行路径);**单独复跑该文件 10/10 全绿 exit=0**,判机器负载 flake。历史多轮全量亦有两轮 7282 全绿 exit=0。
- `check:gdscript`(Godot 4.7.2 console):errors=0 warnings=0 ✅
- CI 同款断言 `node -e "...r.incomplete||r.errors>0 → exit 1"`:PASS ✅

## 部署注记(方案 B,已于 2026-10-21 执行闭环)

- **回补**:CardGame2 `undo_manager.gd` 已备份(`.bak-undo-20261021`)后覆盖仓库修复版,diff 逐字节一致。
- **行为级验证(Nit-3 闭环)**:本会话 godot MCP server 因重连耗尽已降级 headless、`manage_tools reconnect` 未注册进会话,改用 node+ws 直连编辑器插件复刻 auth 协议(`src/core/EditorConnection.ts` 的 auth_begin→challenge→HMAC proof;0.23 老副本用明文 auth)触发 `test_run`。仓库 fixture 编辑器(Godot 4.7.2)上 **undo_manager 套件 10/10 全绿、0 失败 0 跳过**,含 `test_create_action_caps_undo_history` 的 max_steps=200 断言。
- **CardGame2 冒烟**:4.7.2 编辑器加载回补版插件(`[MCP] Listening on 9090`),直连 `add_node`/`remove_node` 双向走 `create_action_mixed → _cap_undo_history` 执行链,**0 SCRIPT ERROR**。基线:4.7.2 编辑器起手 WS ~1196MB,长期内存收益留待观察(对照测量方法:`UndoRedo.get_history_count()` + 进程内存,N 次 AI 编辑后确认增长截断)。
- **附带发现并修复(commit 79478d34)**:fixture 的 `editor_plugins enabled` 短名格式(Godot 3 残留,Godot 4 不加载)+ addons 残缺副本(check:gdscript 只拷 `.gd` 不拷 `.tscn`,`plugin.gd:17` preload `ui/status_panel.tscn` Parse Error)双重不达——编辑器模式验证前须 `npm run install-plugin` 完整同步。check:gdscript 覆盖的是编译面不是运行面,两者不可互推(教训登 memory `fixture-addons-partial-copy-editor-unloadable`)。
- **遗留**:CardGame2 全量升级 0.35 另批安排;分支 2 commits(20f155b7 + 79478d34)未 push 待用户。

addons 为复制品非符号链接,修复需部署到目标项目方生效。CardGame2 当前 0.23.0(与仓库 0.35.0 有 52 处差异),用户拍板走 B:先单文件回补 `undo_manager.gd` 验证内存收益(0.23 副本调用方经 grep 实测全部只用 `create_action_mixed`,整文件覆盖兼容;其 testing/suites 无 undo 套件),确认有效后再单独安排全量升级 0.35。对照测量:同样执行 N 次 AI 编辑,记录 `UndoRedo.get_history_count()` 与 Godot 进程内存,确认增长被截断(避免"只重启一次就宣称修好"的归因混淆)。

## 值得进 memory 的工程教训

1. **grep count ≠ 调用数**:`grep -c` 含注释行;GDScript 仓统计调用点必须剔 `#` 开头行再求和(本次 50 vs 37 的 13 行误差全部来自文件内注释——实现者剔了跨文件注释仍漏剔文件内注释,两层陷阱)。
2. **EditorUndoRedoManager 与 UndoRedo 的 max_steps 陷阱**:cap 编辑器 undo 历史只能经 `get_history_undo_redo()` 对各 history 的 UndoRedo 设置(直接 `undo_redo.max_steps = N` 会运行时报错);create_action 无 custom_context 时按首个操作推断 history(Node→场景,非 Node→GLOBAL),双 history 都要盖。
