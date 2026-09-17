# 2026-09-17 插件反馈批次 B(scene 序列化) — 独立审查报告

## 审查对象

四批插件反馈修复计划(`D:\workspace\Obsidian\GodotMCP\项目待办.md` 2026-09-16 计划)之批次 B:scene 序列化(tscn 损坏/数据丢失类),五项 B1-B5。分支 `fix/feedback-batch-20260916b`(基于 master `6e66e4e8`,未 push 待用户)。前置:工作区 web-gui「面板独立窗口」批已隔离到分支 `feat/web-gui-app-window`(commit `4d66da8e`,该批自带审查文档 `docs/reviews/2026-09-16-面板独立窗口.md`)。

改动面(git status 实测,25 文件):`src/scripts/godot_operations.gd`、`addons/godot_mcp_server/commands/ui_commands.gd`、`src/tools/ui/types.ts`、`src/tscn/tscn-editor-add.ts`、`src/tscn/tscn-editor.ts`、`src/tools/scene/index.ts`、`src/tools/scene/helpers.ts`、规则模板双副本(`src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-ui.md`)、版本链七文件(package.json/manifest.json/server.json/plugin.cfg/Dockerfile/docs/使用指南.md/package-lock.json → 0.33.4)、CHANGELOG/README、测试五文件(新增 `test/scene-batch-b-contract.test.ts`)、fixture 同步一份(`test/fixtures/real-project/addons/.../ui_commands.gd`)。

## 复现定谳(修复前,fixture 真机 Godot 4.6.3)

| 输入形态 | 修复前行为 | 定性 |
|---|---|---|
| B2 相对 parent("OkBtn") | 落盘 `[node name="OkLbl" parent="OkBtn"]`,Godot load `OkBtn/OkLbl exists=true` | 上游本就正确 |
| B2 根名前缀("GetNewHeroContent/OkBtn") | TS 文本路径诚实报 "Parent node not found";GD 链(M-3)剥根名成功 | 不损坏但两路径分叉 |
| B4 texture="res://icon.png" | 落盘 `texture = "res://icon.png"`,load 不报错但 `Banner.texture=<Object#null>` **纹理静默丢失** | 坐实需修 |
| B3-text color=[0,0,0,0.588] | 落盘 `color = [0, 0, 0, 0.588235]`,load 后 `Shade.color=(0,0,0,1)` **属性静默回退默认值** | 坐实需修(09-10 editor 反馈同族) |
| 反馈原文 `OkBtn#OkLbl`+parent="." 损坏形态 | 当前上游不可复现(文本路径 name 禁 `/`,GD 链 parent 解析失败即报错退出) | 疑反馈时项目内旧版行为 |

## 审查者判定:SHIPPED WITH NITS(无 Blocking)

审查方式:code-reviewer 子 agent 独立静态审查(Read/Grep 实测 58 次工具调用,不预设实现者声明为真);实现者补跑审查者无 Bash 未能执行的验证项(STRICT rules-sync / git blame / 全量测试)。

### 逐维度结论

| 维度 | 结论 | 关键证据 |
|---|---|---|
| B1 三方+双副本对齐 | 通过:headless/editor/TS 三白名单 31 项;`CONTROL_TYPES` 单一来源全链自动生效(index.ts ×5 消费点/ui-create/ui-layout/prototype-import);双副本 4 处文案+清单逐字一致;capability-matrix 已含两类型;版本链七文件 0.33.4 齐 | godot_operations.gd:383-402 / ui_commands.gd:10-18 / types.ts:25-35 / rule-templates.ts:587,597,599,774,836 ↔ godot-mcp-ui.md:23,33,35,210,272 |
| B4/B3-text fallback | 通过:canSerializeProperty 对 res:///uid:// 与 Array 返 false;全消费方清点仅 addNode/addNodes 两处,唯一生产调用点 scene/index.ts:193 的 fallback 分支完整;GD 链承接实证(TYPE_OBJECT load :171-180 / 数学 coerce :187-213);真 Array 属性与 res:// 前缀普通字符串经 GD 链 set 均无损(性能代价非正确性) | tscn-editor-add.ts:72-96 / scene/index.ts:200-219 |
| B2 根名剥离 | 通过:inferSceneRootName(root name 属性→文件名回退,对齐 Godot 行为);与 GD 链 _resolve_parent_node 逐步对齐;"子节点与根同名"边界两路径行为一致(都无条件剥,一致性成立) | helpers.ts:105-115 / scene/index.ts:177-192 / godot_operations.gd:338-352 |
| B5 自检 | 通过:TS verifySceneTree 写前拒写;GD 六 handler 接线全部在 save OK 后、成功 print 前,失败 exit 1 经 _exit_with 登记;CACHE_MODE_IGNORE 一次性回读 get_node_count 即弃,不 instantiate 零脚本副作用、无 ResourceCache 深替换前科风险;batch 部分失败与自检失败退出码交互正确(自检优先短路) | tscn-editor-add.ts:395-415 / godot_operations.gd:568,633,701,796,880,1020 + :317-330 |
| B3 定谳 | 成立:editor 链 handle_add_node → coerce_property_value → coerce_value_for_property TYPE_COLOR 分支(:119-121)完整在位;git blame 由实现者补跑确认 `8cbac217f`(2026-07-11);fixture 旧版副本(29 种)在仓库自证该根因形态现实存在 | node_commands.gd:104-105 / command_helpers.gd:187-215 |
| 仓库级约束 | 通过(一项执行限制由实现者补跑清偿):双副本 STRICT 一致(实现者实跑 `STRICT=1 npm run check:rules-sync` 输出「OK: 9 个模板双向对账一致」);bump 门禁实跑通过;分发产物 check:gdscript fixture 自动同步机制覆盖 | check-rules-content-sync.mjs / check-rules-version-bump.mjs |
| 测试质量 | 良好:新增均为真断言;旧"allows arrays"断言与修复目标冲突,改为 fallback 断言无覆盖丢失;contract 测试是防 drift 快照锚定 | 五测试文件 |

### 实现者补跑的验证(审查者无 Bash 项)

1. `STRICT=1 npm run check:rules-sync` → OK: 9 个模板双向对账一致。
2. `node scripts/check-rules-version-bump.mjs` → ✓ 规则模板变更已伴随 bump。
3. `git blame -L 119,121 addons/.../command_helpers.gd` → `8cbac217f`(2026-07-11 23:40)确认 B3 定谳归属。
4. 全量测试四轮(见下「验证完整性」)。

### Nits 处置

1. **N1 real-project fixture 插件副本白名单漂移**(审查置信度高)→ **已清偿**:同步 `test/fixtures/real-project/addons/.../ui_commands.gd` 与主 addons 一致(diff 验证),并在 scene-batch-b-contract.test.ts 加 fixture 锚定断言(逐项比对)防再漂移;fixture 其余 38 处历史漂移文件不属本批,留档(见挂账)。
2. **N2 parent 前缀正则 `/^\/?root\/?/` 尾斜杠可选致 "rootMain" 误剥成 "Main"**(pre-existing,与 B2 同段)→ **已清偿**:改 `/^\/?root\//`(纯 "root"/"/root" 已被特判覆盖),加 mock 用例断言 "rootMain" 如实报 "Parent node not found"。
3. **N3 create_scene 未接 _verify_saved_scene** → 接受:新建空场景损坏风险极低,记录为已知边界。
4. **N4 verifySceneTree 不校验双 root 与 ExtResource 引用完整性** → 接受:前者文本路径产生不了,后者由 GD 链真实 load 回读兜底,职责边界内合理。

### 验证完整性(实现者执行)

- `npm run lint` → 0 警告 0 错误。
- `npm run build` → 0 TS 错误。
- `npm run check:gdscript` → errors=0 warnings=0。
- 全量 vitest 四轮:轮 1(6636 passed/1 failed=ui-tools 29 断言,本批预期断言更新);轮 2(6642/1,data-import flaky);轮 3(6641/2,ui-import/ui-layout flaky);**轮 4(Nits 清偿后终态)见下方补记**。flaky 项均真机 spawn 集成测试,失败面每轮漂移,单独复跑全绿(data-import 5/5、ui-import+ui-layout 17/17)——环境并发竞争非本批回归(2026-09-02 批同款先例)。
- GD 链真机验证(Godot 4.6.3):TextureButton `IconBtn` 落盘 `parent="OkBtn"`(修复前 Refused);`texture = ExtResource("1_v3dpd")` + `[ext_resource type="Texture2D" path="res://icon.png"]`;`color = Color(0, 0, 0, 0.588235)`;根名前缀剥成 `parent="OkBtn"`;六自检接线全程不误伤成功路径。

> **轮 4 补记(2026-09-17 终态)**:6644 passed / 1 failed(85 skipped)——失败项又是新的(`gdscript-executor-audit-runtime` RID-leak backfill,真机 crash 注入 spawn 测试),单独复跑 3/3 绿。四轮全量失败面每轮漂移(data-import → ui-import/ui-layout → audit-runtime),全部为真机 spawn 集成测试的并发环境竞争,单独复跑均绿,非本批回归;本批相关的确定性测试(ui-tools/tscn-editor×2/scene-operations-mock/scene-batch-b-contract 五文件 235+ 用例)四轮全程绿。

### 值得进 memory 的工程教训(已登)

- 验证 fixture 与分发产物同构性漂移:e2e 靶子 fixture 的插件副本靠手动 cp 维护会系统性滞后,白名单/协议类变更须 checklist 化 fixture 同步,契约测试锚定是机械守护(本批已给 ui_commands 白名单落地,其余 38 处漂移挂账下批)。
- 「save OK ≠ 可加载」三层自检分工:TS 文本拼接 → 写前 parse 链可达校验拒写;GD pack 产物 → 写后 CACHE_MODE_IGNORE 绕缓存回读计数比对;两者永不 instantiate(规避用户脚本 _ready 副作用)。三角模式可复用到其他写文件子系统。
- canSerializeProperty 类「能力边界」函数收窄前必须 grep 全消费方确认 fallback 兜底链存在且对该值型处理正确——本批正面范例。

### 挂账(下批候选)

- real-project fixture addons 其余 38 处文件与主 addons 的历史漂移(本批只同步了 B1 直接相关的 ui_commands.gd;建议下批做全量同步+契约锚定,或给 fixture 建自动同步脚本)。
- 批次 A 审查 N4(规则模板登记挂账)已在本批顺带清偿(B1 触发的 31 种同步即规则模板登记),批次 A 待办中的该挂账可关闭。
