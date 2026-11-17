# Refero 批1「布局约束保真」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 直译的 Godot UI 具备布局约束——measure 主题语境修正、四类品质机检、既有场景锚点改造工具,验收钉在 DotaLegendGodot 双档不错位。

**Architecture:** 三层递进:① measure 链修正(`theme_path`/`viewport` 参数 → 生成脚本注入挂载/视口行,executor 不动);② 纯函数检查器(`quality-check.ts` 消费 `MeasuredNode[]`,输出 quality/order 报告节,仅有发现时给);③ `solve_from_current` 唯一写盘工具(授权几何 = tscn 文本直解,`anchor-rebase.ts` + `src/tscn/` 既有 patch 原语,浮点 offset 写回 0 容差)。

**Tech Stack:** TypeScript(vitest 单测)、GDScript 生成脚本(headless extends SceneTree)、zod strict schema。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-16-refero-design-system-design.md`(v2,批1 节 §1a-§1e + 决策记录 D3-D6/D8-D9 + 开放问题 1-4)

## Global Constraints

- 0 容差:960 档改造前后逐节点 rect 完全一致;`solve_from_current` 写**浮点 offset**(禁 `Math.round`,spec 反目标节)。
- 向后兼容:所有新参数可选、默认行为与现状逐字节一致;`flow_gap`/`flow_align` 为平级新键,不动 `flow` 枚举(D6)。
- strict schema:新参数全进 inputSchema;每个改 schema 的任务验证步骤**必须先 `npm run build-matrix` 再 `npm run check:ssot-params`**(老 matrix 假绿)。
- `solve_from_current` 进 `types.ts` ACTIONS + `ui/index.ts` TOOL_META.actionRisks 标 `'write'`(编译期穷尽检查)。
- 资源路径参数过 `sanitizeResPath`(先例 `ui-theme.ts:207`);节点名/token 名进 GDScript 前白名单校验。
- 改 `.claude/rules/godot-mcp-ui.md` 必须**双副本同步** `src/tools/rule-templates.ts` 同段,并触发 version bump(`check:rules-sync` + `check-rules-version-bump` 双门禁)。
- 每任务 commit 前:`npm run check:budget`;每任务(或整批收尾)更新 CHANGELOG(`check:changelog-sync`)。
- 全仓注释与提交信息用简体中文;commit 风格对齐近期历史(如 `feat(ui): ...`)。
- 靶子项目路径 `D:\workspace\projects\DotaLegendGodot` 不在本仓——靶子 e2e 一律 `GODOT_PATH` + 靶子目录存在性**双重 skipIf**,CI 不依赖。
- GDScript 生成模板约定:新注入语句放 `_initialize()` 函数体内、`var _frames := 0` 锚点**之后**的语句区(锚点前 class body 声明会破坏 `ui-import-single.ts` 截取拼接,先例见 `ui-measure.ts:39-43` 注释)。

## Review Focus

1. **theme_path 加载失败静默**——GD `load()` 返回 null 时 `set_theme(null)` 行为未定;期望:显式报错退出,不产出错语境 measure(Task 1 e2e 断言)。
2. **viewport 参数假绿**——参数传了但 headless 下视口没真变,布局原样;期望:防护断言失败并警告(Task 2 专门步骤)。
3. **Container 子节点写锚点被运行时覆盖**(静默失败)——期望:跳过并逐节点点名,响应可审计(Task 5 测试)。
4. **裸壳判定误报面失控**(Panel 带 stylebox、纯装饰 Control 全被报)——期望:判据标定 + 报告量预估,fixture 用靶子真实结构(Task 4 步骤含标定)。
5. **tscn 授权几何解析鲁棒性**——节点段无 offset 行(全缺省)、anchors 行存在但 offset 缺省、多 ext_resource 交错;期望:解析器对缺省字段取 Godot 缺省值 0,不崩不静默跳节点(Task 5 单测覆盖三种变体)。

---

### Task 1: measure 主题挂载(`theme_path` 参数)

**Files:**
- Modify: `src/tools/ui/ui-measure.ts`(genUiMeasureScript)
- Modify: `src/tools/ui/index.ts`(ui_measure_layout + ui_import_prototype 的 inputSchema 与 handler 透传)
- Test: `test/ui-measure-theme.test.ts`(新建,单测)+ 靶子 e2e 并入本文件 skipIf 段

**Interfaces:**
- Consumes: `genUiMeasureScript(scenePath, nodePath, maxDepth, styleExpect)`(现状签名,ui-measure.ts:26-31)。
- Produces: `genUiMeasureScript(scenePath, nodePath, maxDepth, styleExpect, opts?: { themePath?: string })`;后续任务在 opts 上扩展 `viewport`。`theme_path` 为 inputSchema 新可选 string 参数(沿用 `ui_set_theme` 同名,description 注明"measure 前挂载到 root,主题敏感场景必传")。

- [ ] **Step 1: 写失败单测**——`test/ui-measure-theme.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { genUiMeasureScript } from '../src/tools/ui/ui-measure.js';

describe('genUiMeasureScript theme 挂载', () => {
  it('无 themePath 时生成脚本与旧行为一致(不含 set_theme 行)', () => {
    const script = genUiMeasureScript('res://a.tscn', undefined, 16);
    expect(script).not.toContain('set_theme');
  });
  it('有 themePath 时注入挂载行且在场景加载之后', () => {
    const script = genUiMeasureScript('res://a.tscn', undefined, 16, undefined, { themePath: 'res://resources/themes/default_theme.tres' });
    expect(script).toContain('root.set_theme(load("res://resources/themes/default_theme.tres"))');
    expect(script.indexOf('set_theme')).toBeGreaterThan(script.indexOf('_mcp_load_scene'));
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run test/ui-measure-theme.test.ts`
Expected: FAIL(opts 参数不存在,生成脚本不含 set_theme)

- [ ] **Step 3: 实现**——`genUiMeasureScript` 加 `opts?: { themePath?: string }` 形参;`_initialize()` 内 `_mcp_load_scene` 成功分支之后注入(themePath 经 `escapeForGdLiteral` 内插,同 sp 先例):

```gdscript
var _theme_res = load("<themePath>")
if _theme_res == null or not _theme_res is Theme:
	_mcp_output("error", "theme_path load failed: <themePath>")
	_mcp_done()
	return
root.set_theme(_theme_res)
```

Review Focus 1 在此落位:null/非 Theme 显式报错退出。`index.ts` 两工具 schema 加 `theme_path`(string, optional)+ handler 透传进 opts。

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run test/ui-measure-theme.test.ts`
Expected: PASS(2 例)

- [ ] **Step 5: 靶子 e2e(spec 开放问题 3 的最小 spike)**——同文件加 skipIf 段(`GODOT_PATH` + `D:\workspace\projects\DotaLegendGodot` 存在双门控):对 `res://scenes/ui/daily_login_content.tscn` 分别无 theme/有 theme(`res://resources/themes/default_theme.tres`)各 measure 一次,断言:① 挂主题后 `LoginMonthLabel` 等带 `theme_type_variation` 节点的 `rect.h` **与无主题时不同或相等均记录数值**(量化 P0-2 偏差量级,断言只要求两轮 measure 都成功且 viewport 相同);② 传错路径时返回 error 而非成功。跑通后把量级数字记入 spec 开放问题 3 的答案(改 spec 文件该节)。

Run: `GODOT_PATH=<godot> npx vitest run test/ui-measure-theme.test.ts`
Expected: skipIf 不触发时 PASS

- [ ] **Step 6: 仓库登记 + commit**

Run: `npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/ui-measure.ts src/tools/ui/index.ts test/ui-measure-theme.test.ts docs/superpowers/specs/2026-11-16-refero-design-system-design.md
git commit -m "feat(ui): measure 链 theme_path 挂载——主题敏感场景 rect 语境修正(批1 1a)"
```

### Task 2: measure viewport 参数 + 假绿防护

**Files:**
- Modify: `src/tools/ui/ui-measure.ts`、`src/tools/ui/index.ts`
- Test: `test/ui-measure-viewport.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `opts` 形参。
- Produces: `opts.viewport?: { w: number; h: number }`(须正整数,handler 侧校验);inputSchema 新键 `viewport: { w, h }`(object, optional)。GD 侧 `_vp` 改为:viewport 参数注入时优先返回注入值。

- [ ] **Step 1: 失败单测**——① 无 viewport 时脚本不含视口覆写行;② 有 `{w:800,h:480}` 时注入行存在且在 `_mcp_load_scene` **之前**(视口须先于场景加载设置,布局才会按新视口算);③ 非正数由 handler 拒(该断言可先 skip,Task 内 Step 5 补)。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-measure-viewport.test.ts`
Expected: FAIL

- [ ] **Step 3: spike——headless 下视口覆写的真实生效通道**(spec 开放问题 1)。`root.content_scale_size` 是 project 设置的映射(ui-measure.ts:104-108 注释),直接赋值是否驱动重布局**未证实**。实现顺序:先写一次性 GD 探针(headless 跑:设 `root.content_scale_size = Vector2(800,480)` → load 场景 → measure 全铺背景节点 rect.w),断言 rect.w == 800 而非 960。探针结论二选一:
  - **生效** → 注入行用 `root.content_scale_size = Vector2(w, h)`;
  - **不生效** → 备选通道 `root.set_size`/`Window.content_scale_size` 逐一试;全部不生效则**计划内降级**:viewport 参数只改 `_vp` 上报值 + 响应附 `"viewport_override_effective": false` 与指引(g800 复测走窗口模式 `run_project` + `dump_layout_tree`),并把结论写回 spec 开放问题 1。
  探针脚本不留仓库,结论写进本测试文件顶注释与 spec。

- [ ] **Step 4: 实现**——按 spike 结论注入;`_emit()` 的 viewport 字段在注入生效时返回注入值。

- [ ] **Step 5: 假绿防护(Review Focus 2)**——TS 侧:响应后处理中,若 viewport 参数注入生效标志为真,检查 measure 节点里至少一个**非全铺节点**(rect.w < viewport.w 的节点存在)的 rect 相对默认视口下基线发生变化;无法确认时在响应 `data.measure` 附 `"viewport_check": "inconclusive"` 警告字段。e2e(双 skipIf):靶子场景 viewport 800x480 下,全铺 `Bj` 节点 rect.w 应为 800(而非 960)——这是生效的硬断言。

- [ ] **Step 6: 通过 + 登记 + commit**

Run: `npx vitest run test/ui-measure-viewport.test.ts && npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/ui-measure.ts src/tools/ui/index.ts test/ui-measure-viewport.test.ts
git commit -m "feat(ui): measure viewport 参数+假绿防护——g800 复测通道(批1 1a)"
```

### Task 3: 基线快照与 0 容差比对(`quality-check.ts` 起建)

**Files:**
- Create: `src/tools/ui/quality-check.ts`
- Test: `test/ui-quality-check.test.ts`

**Interfaces:**
- Produces:
  - `compareBaseline(measured: MeasuredNode[], baseline: MeasuredNode[]): { ok: boolean; mismatches: Array<{ path: string; field: 'x'|'y'|'w'|'h'; expected: number; actual: number }> }`——逐节点 rect 四值 0 容差(严格 `===`,浮点直接比,不经 round);路径集差异(基线有/实测无)也进 mismatches(field 置 `'x'`、数值 NaN 标注)。
  - `export interface QualityReport`(本任务先空壳,Task 4 填充字段)。

- [ ] **Step 1: 失败单测**——三例:① 完全一致 → ok:true;② 某节点 w 差 0.0001 → ok:false 且 mismatches 点名 field:'w' expected/actual;③ 基线有节点实测缺 → mismatches 含该 path。fixture 手写 `MeasuredNode`(类型从 `layout-diff.ts` 导入)。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-quality-check.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 compareBaseline**——纯函数,按 path 建 Map 双向比对;NaN 用 `Number.isNaN` 显式处理(不落 `!==` 陷阱)。

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run test/ui-quality-check.test.ts`
Expected: PASS(3 例)

- [ ] **Step 5: commit**

```bash
git add src/tools/ui/quality-check.ts test/ui-quality-check.test.ts
git commit -m "feat(ui): 0 容差基线比对 compareBaseline(批1 1b)"
```

### Task 4: 四类品质检查器(quality/order 报告节)

**Files:**
- Modify: `src/tools/ui/quality-check.ts`(扩展)
- Modify: `src/tools/ui/index.ts`(measure/ui_import_prototype 响应挂 quality/order 节)
- Test: `test/ui-quality-check.test.ts`(扩展)

**Interfaces:**
- Consumes: `MeasuredNode`(layout-diff.ts)、Task 3 的 `QualityReport`。
- Produces:
  - `detectBareShell(measured): Array<{ path: string; childCount: number }>`——Control 壳(类型为 `Control` 且无 text/texture 子属性)下子节点 ≥2 且全部四 anchor == 0 且存在非零 offset;
  - `detectShouldFollow(measured, tolerancePx = 2): Array<{ path: string; parent: string }>`——子 rect 与父 rect 四边差均 ≤2px 但 anchor 全 0;
  - `detectViewportOverflow(measured, viewport: { w: number; h: number }, marginPx = 4): Array<{ path: string; overflow: { w: number; h: number } }>`——global rect 越 viewport 界(补根/一级子盲区,P1-1);
  - `detectEquidistant(measured, tolerancePx = 2): Array<{ parent: string; axis: 'x'|'y'; members: string[]; gap: number }>`——同父兄弟沿轴相邻间距差 ≤2px 且成员 ≥3(进 order 节);
  - `buildQualityReport(measured, opts): QualityReport | null`——聚合上述 + 既有 `detectOutOfBounds`;**null 语义 = 无发现时省略输出**(D8);调用方 `stalled === true` 时不调用。

- [ ] **Step 1: 失败单测**——每检测函数至少:① 命中例;② 不命中例(反向保护);③ 裸壳判定用靶子真实结构标定(Review Focus 4):fixture 含 `MoneyLay`(裸 Control 壳+3 个 anchor 全 0 子)→ 命中;`Panel` 带 stylebox override(从 `styles` 字段判定)→ **不算裸壳**(装饰面板豁免);`Bj` TextureRect 全铺但 anchor 全 0 → detectShouldFollow 命中。`buildQualityReport` 两例:空输入集 → null;有发现 → 报告对象且含 `stalled` 抑制由调用方负责的注释契约。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-quality-check.test.ts`
Expected: FAIL(函数未定义)

- [ ] **Step 3: 实现四检测 + 聚合**——全纯函数;"非渲染件"判据:`type === 'Control'` 且无 `text` 字段且无 styles override;间距 = 后缘−前缘(兄弟按 global rect 排序)。

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run test/ui-quality-check.test.ts`
Expected: PASS

- [ ] **Step 5: index.ts 挂节**——ui_measure_layout / ui_import_prototype 响应:`stalled !== true && report !== null` 时挂 `quality`(含 viewport 溢出)/`order`(等距组)字段;报告节内每条目附建议文案(中文,一句话,指向 `solve_from_current` 或容器化)。

- [ ] **Step 6: 靶子 e2e(报告量预估,spec 1c)**——双 skipIf:靶子场景挂主题 measure 一次,断言 quality 报告命中 `MoneyLay` 裸壳(名单化基线),把全部命中路径数记入 spec §1c 报告量预估行。

- [ ] **Step 7: 登记 + commit**

Run: `npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/quality-check.ts src/tools/ui/index.ts test/ui-quality-check.test.ts
git commit -m "feat(ui): 四类品质检查器 quality/order 报告节(批1 1c)"
```

### Task 5: `solve_from_current` 锚点改造工具

**Files:**
- Modify: `src/tools/ui/anchor-solver.ts`(导出无取整变体)
- Create: `src/tools/ui/anchor-rebase.ts`
- Modify: `src/tools/ui/types.ts`(ACTIONS)、`src/tools/ui/index.ts`(schema/handler/actionRisks)
- Test: `test/ui-anchor-rebase.test.ts`、`test/ui-anchor-solver.test.ts`(扩展)

**Interfaces:**
- Consumes: `CONTAINER_CONTROL_TYPES`、`solveAnchors`(anchor-solver.ts 现有导出)、`src/tscn/` 解析与段落编辑原语(`tscn-parser.ts`/`tscn-editor.ts`,实现者按其现有 API 取用节点段与行级替换)。
- Produces:
  - `solveAnchorsUnrounded(parent: { w: number; h: number }, child: Rect): AnchorsOffsets`——与 `solveAnchors` 同语义(offset 不 `Math.round`,浮点直出);
  - `parseAuthoredGeometry(tscnText: string): Array<{ path: string; type: string; offsets?: Record<'left'|'right'|'top'|'bottom', number>; anchors?: Record<...>; parentPath: string; parentType: string }>`——从 tscn 文本直接解析(缺省字段取 0,Review Focus 5);
  - `planRebase(parsed: ReturnType<typeof parseAuthoredGeometry>, filter?: { include?: string[]; exclude?: string[] }): { toWrite: Array<{ path: string; anchors: AnchorsOffsets }>; skippedContainerChildren: string[]; skippedByFilter: string[] }`;
  - MCP action `solve_from_current`:参数 `scene_path`(必填)、`node_path`(可选,子树限定)、`include`/`exclude`(可选节点名数组)、`dry_run`(默认 true——**先看计划再写盘**)。

- [ ] **Step 1: 失败单测(anchor-solver 扩展)**——`solveAnchorsUnrounded`:父 758.5×493.5、子 x=11.5 w=225 → `anchor_left` 为 `11.5/758.5` 未吸附值、`offset_left` 为浮点且重算 `anchor*parentW + offset === child.x` 严格成立(`===`,0 容差数学恒等断言)。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-anchor-solver.test.ts`
Expected: FAIL(导出不存在)

- [ ] **Step 3: 实现 solveAnchorsUnrounded**——复用 snap;offset 直接 `child.x - al * parent.w` 不取整。

- [ ] **Step 4: 通过 + commit(小步)**

```bash
git add src/tools/ui/anchor-solver.ts test/ui-anchor-solver.test.ts
git commit -m "feat(ui): solveAnchorsUnrounded 浮点 offset 变体(批1 1d)"
```

- [ ] **Step 5: 失败单测(anchor-rebase)**——① parseAuthoredGeometry:用靶子 `daily_login_content.tscn` 真实片段作 fixture(含 `[node name="MoneyLay" type="Control" parent="Panel"]` 段),断言路径/类型/offset 值正确;**三变体**:无任何 offset 行的节点(全缺省 0)、有 anchors 无 offset、多 ext_resource 交错段(Review Focus 5);② planRebase:Container 父子节点进 `skippedContainerChildren` 不进 `toWrite`(Review Focus 3);exclude 过滤进 `skippedByFilter`;③ patch 写回:写后 tscn 文本保留原注释行( fixture 含注释)、目标节点段出现 `layout_mode = 1` + 四 anchor + 四 offset 浮点字面量。

- [ ] **Step 6: 跑测失败**

Run: `npx vitest run test/ui-anchor-rebase.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 anchor-rebase.ts + index.ts 登记**——解析走 tscn-parser;写回走段落级文本替换(仅动目标 `[node]` 段内的 layout_mode/anchor/offset 行,段外字节不动);ACTIONS 加 `solve_from_current`;actionRisks 标 `'write'`;`scene_path` 过 `sanitizeResPath`;节点名进 GD/正则前白名单(`^[A-Za-z_][A-Za-z0-9_]*$`,Godot 节点名约束);`dry_run=true` 默认只返回 planRebase 结果不写盘。

- [ ] **Step 8: 跑测通过**

Run: `npx vitest run test/ui-anchor-rebase.test.ts`
Expected: PASS

- [ ] **Step 9: 靶子 e2e(0 容差闭环,批1 验收 3 预演)**——双 skipIf:① 挂主题 measure 取基线;② `solve_from_current(dry_run=false)` 改造 `MoneyLay` 子树;③ 再 measure,`compareBaseline` 与基线 `ok === true`(严格,Review Focus 5 之外的终极断言:授权几何反解 + 浮点 offset 的数学恒等);④ git 还原靶子 tscn(靶子是用户项目,验收后 `git -C 靶子 checkout` 还原,或 dry_run 副本场景验证——**用临时副本场景文件验证写盘,不动靶子原文件**;真改造留给 Task 7 手工验收)。

- [ ] **Step 10: 登记 + commit**

Run: `npm run build-matrix && npm run check:ssot-params && npm run check:budget && npx tsc --noEmit`

```bash
git add src/tools/ui/anchor-solver.ts src/tools/ui/anchor-rebase.ts src/tools/ui/types.ts src/tools/ui/index.ts test/ui-anchor-rebase.test.ts test/ui-anchor-solver.test.ts
git commit -m "feat(ui): solve_from_current 既有场景锚点改造——授权几何+浮点offset+tscn文本patch(批1 1d)"
```

### Task 6: 提取脚本 flex 自动检测 + `flow_gap`/`flow_align` + 多层 flow 翻译

**Files:**
- Modify: `src/tools/ui/prototype-import.ts`(schema + 翻译器)
- Modify: `src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-ui.md`(**双副本**,evaluate 模板段)
- Test: `test/prototype-import.test.ts`(扩展)

**Interfaces:**
- Consumes: proto-geometry strictObject(prototype-import.ts:133 `flow` 枚举不动)。
- Produces: schema 新可选键 `flow_gap: z.number().finite().min(0)`、`flow_align: z.enum(['start', 'center', 'end'])`;翻译器对任意深度 flow 壳生成 Container 子树,`flow_gap` → 容器 separation(MarginContainer/HBox/VBox 的 theme override 常量);evaluate 模板(computed style 检测 flex/grid + gap/align 带出,`data-flow` 显式优先)。

- [ ] **Step 1: 失败单测**——① schema:`{flow: 'row', flow_gap: 8}` 通过,`{flow_gap: -1}` 拒,`{flow: {dir: 'row'}}` 仍拒(枚举形态不变,BC 断言);② 翻译器:三层嵌套 flow 壳(根 flow row > 子 flow column > 孙 Label)产出 Container 嵌套树,孙不再走 rect 锚点;`flow_gap: 8` 产出 separation override 行;③ 无 flow_gap 时行为与现状逐字节一致(回归锚)。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/prototype-import.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 schema + 翻译器**(纯函数,翻译器保持零 Godot 依赖)。

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run test/prototype-import.test.ts`
Expected: PASS

- [ ] **Step 5: 双副本规则文档同步 + version bump**——`.claude/rules/godot-mcp-ui.md` evaluate 模板段更新(模板 JS:对每个 `[data-name]` 元素读 `getComputedStyle` 的 `display`,flex/grid 时输出 flow/flow_gap/flow_align,显式 `data-flow` 优先);`src/tools/rule-templates.ts` 同段同步;按门禁跑:

Run: `npm run check:rules-sync && node scripts/check-rules-version-bump.mjs`
Expected: 按脚本指引完成 version bump 后双绿

- [ ] **Step 6: 登记 + commit**

Run: `npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/prototype-import.ts src/tools/rule-templates.ts .claude/rules/godot-mcp-ui.md test/prototype-import.test.ts
git commit -m "feat(ui): 提取脚本 flex 自动检测+flow_gap/flow_align 平级新键+多层 flow 翻译(批1 1e)"
```

### Task 7: 靶子手工验收(daily_login 双档闭环)

**Files:**
- Create: `docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md`(验收记录,含处置名单)

**Interfaces:**
- Consumes: Task 1-5 全部工具(MCP 侧调用,非代码)。
- Produces: 验收记录文档(spec 批1 验收 1-5 的执行证据)。

- [ ] **Step 1: g960 基线**——`ui_measure_layout(scene_path=daily_login_content.tscn, theme_path=default_theme.tres)`,快照存验收记录(1b 格式:rect + anchors/offsets 原值)。
- [ ] **Step 2: 检查报告名单化**——quality/order 报告全命中项列表,每项标注「改造 / 豁免(纯静态装饰理由)」。
- [ ] **Step 3: 改造**——按名单跑 `solve_from_current(dry_run=true)` 核对计划 → `dry_run=false` 写盘;等距组由人工决策是否容器化(工具只建议)。
- [ ] **Step 4: 0 容差回归**——再 measure,`compareBaseline` ok:true;失败即回滚写盘并回 Task 5 修。
- [ ] **Step 5: g800 复测**——viewport 通道(Task 2 spike 结论):800×480 下全铺 Bj rect.w=800、一级 Panel 不越视口、位置/中心线对齐抽查(记录数值)。
- [ ] **Step 6: 验收记录落盘 + commit**

```bash
git add docs/superpowers/plans/2026-11-16-refero-batch1-acceptance.md
git commit -m "docs(ui): 批1 daily_login 双档验收记录(0容差/g800位置对齐)"
```

- [ ] **Step 7: 收尾**——CHANGELOG 补批1 条目(`npm run check:changelog-sync` 绿);`npm run test:all` 全绿;靶子项目侧改动(若 Task 7 写盘保留)与用户确认去留。
