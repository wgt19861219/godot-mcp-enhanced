# Refero 批2「布局秩序 verify + 批1 收口」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** measure 链产出布局秩序报告(间距档位/对齐线/视觉组聚类)+ solve_from_current viewport 形参根治一级子盲区 + 批1 终审四个顺手项收口。

**Architecture:** ① `planRebase` 加 `opts.viewport` 兜底根尺寸,场景根直接子进改造计划(闭环批1 Panel 人工补笔的根因);② measure GD 脚本在 theme_path 存在时导出 `DesignTokens` constants,TS 侧三个新纯检测函数(间距档位/对齐线/视觉组)进既有 `OrderSection`;③ index.ts 后处理三段合并单次 parse。全部纯检测只读,纪律沿用批1(D8 无发现省略/stalled 抑制)。

**Tech Stack:** TypeScript(vitest)、GDScript 生成脚本、zod strict schema。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-16-refero-design-system-design.md`(v2 批2 节 + 决策记录 D8;批1 终审 triage 的批2 项)

## Global Constraints

- 纯检测只读:order 三项新检测不改场景不写盘;**无声明不发噪音**——无 theme 档位时跳过间距档位与视觉组检测(视觉组阈值默认取档位表最大值,无档位且未显式传 `threshold_px` 则跳过),对齐线检测不依赖档位、恒可用。
- 输出纪律 D8 沿用:`OrderSection` 各子节独立省略(空数组不挂);`stalled === true` 时不出任何判定(调用方契约不变)。
- solve_from_current viewport 形参:正整数 handler 侧校验(同 measure 侧),授权几何侧兜底语义——**仅当父尺寸无法从 tscn 解析(场景根直接子)时**用 viewport 作父尺寸,不改既有已解析父的求解路径(0 容差行为不变)。
- strict schema:新参数全进 inputSchema;改 schema 的任务跑 `npm run build-matrix && npm run check:ssot-params && npm run check:budget` 全绿后 commit。
- 间距 = 后缘−前缘(global rect 排序),非中心距(批1 detectEquidistant 同款语义);容差统一 2px。
- 全部注释简体中文;commit 风格 `feat(ui)/fix(ui)/chore(ui): ...`(中文描述)。
- 靶子 e2e 双 skipIf(GODOT_PATH + `D:\workspace\projects\DotaLegendGodot` 存在);靶子真实文件**只读**(暂存区有用户未裁决改动,验收用副本场景)。

## Review Focus

1. **viewport 形参兜底误伤**——已解析父尺寸的节点被 viewport 覆盖 → 0 容差回归破坏;期望:viewport 只救 skippedUnresolvedParent 命中者,既有路径逐字节不变(Task 1 双锚测试)。
2. **DesignTokens type 不存在**(项目没建 token)→ GD 导出空/报错;期望:空档位表静默跳过两项检测,measure 照常成功(Task 2 e2e)。
3. **档位表单档或全零间距**——聚类/落档除零或空分母;期望:单档表正常报落档率,零兄弟对时省略节(Task 2 单测)。
4. **对齐线在少子节点父**——2 个兄弟无"多数派"可言;期望:<3 兄弟的父不参与对齐线检测(多数派无意义)(Task 3 单测)。
5. **视觉组阈值无依据时**——无档位且未传 threshold_px 却仍聚类 → 阈值凭空;期望:跳过该检测并可在响应说明(诚实无依据不猜)(Task 3 单测)。

---

### Task 1: solve_from_current viewport 形参(闭环批1 Important#1)

**Files:**
- Modify: `src/tools/ui/anchor-rebase.ts`(planRebase + 头注 instance= 边界)
- Modify: `src/tools/ui/index.ts`(solve_from_current schema/handler)
- Modify: `src/tools/ui/quality-check.ts`(根子建议文案泛化)
- Test: `test/ui-anchor-rebase.test.ts`(扩展)

**Interfaces:**
- Consumes: `planRebase(parsed: AuthoredNode[], filter?: RebaseFilter): RebasePlan`(现状);`skippedUnresolvedParent` 语义(anchor-rebase.ts:209)。
- Produces: `planRebase(parsed, filter?, opts?: { viewport?: { w: number; h: number } })`——父尺寸无法解析(场景根直接子)且 viewport 存在时,以 viewport 为父尺寸求解进 `toWrite`(f32 感知推导同款);viewport 缺失时行为与现状逐字节一致。MCP 入参 `viewport`(object {w,h},可选,handler 校验正整数)。

- [ ] **Step 1: 失败单测**——① 一级子(父=根,parseAuthoredGeometry 产 parentPath 为根形态)无 viewport → 进 skippedUnresolvedParent(现状锚,回归保护);② 同节点传 `{viewport:{w:960,h:540}}` → 进 toWrite,四 anchor 按视口比例、offset 浮点、位级恒等断言(f32 同款 `fr(fr(a·p)+o)===margin`);③ 已解析父节点(Panel/Bj 形态)传 viewport → 求解结果与不传**逐字节相同**(Review Focus 1 双锚)。
- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-anchor-rebase.test.ts`
Expected: FAIL(opts 形参不存在)

- [ ] **Step 3: 实现**——planRebase 加 opts;父尺寸解析失败分支(`!ps || !(ps.w>0) || !(ps.h>0)`)先查 opts.viewport(正数守卫),命中则 ps=viewport 继续既有求解;头注"已知边界"补一句:instance= 场景内部子节点不在文本节点段,不参与解析(终审 T5③)。
- [ ] **Step 4: quality-check.ts 根子文案泛化**——bare_shells 根子提示从"需人工补笔(参照验收记录 §3.3 方式)或待批2 viewport 形参"改为"传 viewport 形参即可处理(以视口为父尺寸求解)"(未来时→现在时,去仓内文档引用);既有断言若引用旧文案同步更新。
- [ ] **Step 5: index.ts 接线**——solve_from_current inputSchema 加 viewport(description 注明"场景根直接子的父尺寸兜底,须与项目视口一致,正整数");handler 校验(Number.isInteger && >0)透传 planRebase opts。
- [ ] **Step 6: 跑测通过 + 门禁 + commit**

Run: `npx vitest run test/ui-anchor-rebase.test.ts test/ui-quality-check.test.ts && npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/anchor-rebase.ts src/tools/ui/index.ts src/tools/ui/quality-check.ts test/ui-anchor-rebase.test.ts
git commit -m "feat(ui): solve_from_current viewport 形参——一级子盲区根治(批2/批1终审 Important#1)"
```

### Task 2: measure theme constants 导出 + 间距档位检测

**Files:**
- Modify: `src/tools/ui/ui-measure.ts`(genUiMeasureScript:theme constants 导出)
- Modify: `src/tools/ui/quality-check.ts`(detectSpacingScale + OrderSection 扩展)
- Modify: `src/tools/ui/index.ts`(buildQualityReport 调用点传档位)
- Test: `test/ui-measure-theme.test.ts`(扩展)+ `test/ui-quality-check.test.ts`(扩展)

**Interfaces:**
- Consumes: `genUiMeasureScript(..., opts?: { themePath?: string; viewport?: {w,h} })`(批1 签名);themeMount 挂载点(root 或 SubViewport 激活时的场景根)。
- Produces:
  - measure 输出新增 `theme_constants: Record<string, number>`(GD 侧从挂载点 Theme 读 `DesignTokens` type 的 constants;type 不存在 → 空对象,不报错);
  - `detectSpacingScale(measured: MeasuredNode[], scale: number[], tolerancePx = 2): { on_scale: number; total: number; rate: number; off_scale: Array<{ a: string; b: string; gap: number; nearest: number }> } | null`——null = scale 空或无可比对兄弟对(不发噪音);间距=后缘−前缘(同 detectEquidistant 语义,复用其兄弟分组与排序逻辑可提取共享 helper,注意 DRY);
  - `OrderSection` 增 `spacing_scale?: { ...上述返回 }` 字段。

- [ ] **Step 1: 失败单测(GD 生成侧)**——genUiMeasureScript 带 themePath 时产物含 DesignTokens constants 导出片段(字符串断言:`get_constant_list` 与 `"DesignTokens"`);无 themePath 时不含(逐字节兼容锚)。
- [ ] **Step 2: 失败单测(检测侧)**——① 兄弟间距 [8,8,16,13] 档位 [4,8,12,16,24] → rate=0.75,off_scale 含 13→nearest 12 一条;② 单档表 [8] 间距 [8,9] → rate=0.5;③ 零兄弟对 → null;④ scale 空 → null(Review Focus 3)。
- [ ] **Step 3: 跑测失败**

Run: `npx vitest run test/ui-measure-theme.test.ts test/ui-quality-check.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**——ui-measure.ts:_emit 输出 theme_constants(GD:挂载点 `get_theme()`,null 或无该 type → `{}`;遍历 `get_constant_list("DesignTokens")` + `get_constant(name, "DesignTokens")`,数值经 JSON);quality-check.ts:detectSpacingScale(兄弟对遍历逻辑与 detectEquidistant 提共享 helper `siblingsByParent`);OrderSection 扩展 + buildQualityReport opts 加 `spacingScale?: number[]`;index.ts 调用点从 measure 输出的 theme_constants 取档位(键名约定 `space_*`,取**值**数组排序)传入。
- [ ] **Step 5: e2e(Review Focus 2)**——双 skipIf:靶子副本场景挂 default_theme.tres(无 DesignTokens type)→ measure 成功且 theme_constants 为 {}、order 节不含 spacing_scale(空档跳过);自建带 DesignTokens 的 fixture theme → theme_constants 导出正确、spacing_scale 有值。
- [ ] **Step 6: 通过 + 门禁 + commit**

Run: `npx vitest run test/ui-measure-theme.test.ts test/ui-quality-check.test.ts && npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/ui-measure.ts src/tools/ui/quality-check.ts src/tools/ui/index.ts test/ui-measure-theme.test.ts test/ui-quality-check.test.ts
git commit -m "feat(ui): measure DesignTokens 档位导出+间距档位检测进 order 节(批2)"
```

### Task 3: 对齐线 + 视觉组聚类(order 节,同形态双检测)

**Files:**
- Modify: `src/tools/ui/quality-check.ts`
- Test: `test/ui-quality-check.test.ts`(扩展)

**Interfaces:**
- Consumes: Task 2 的 `siblingsByParent` helper 与 `OrderSection`。
- Produces:
  - `detectAlignmentLanes(measured: MeasuredNode[], tolerancePx = 2): Array<{ parent: string; kind: 'left'|'right'|'center'|'top'|'bottom'|'vc'; lane: number; majority: string[]; outliers: Array<{ path: string; offset: number }> }>`——同父 **≥3** 兄弟(Review Focus 4)对六条线(x 系 left/right/center 由 global rect.x/x+w/x+w/2,y 系 top/bottom/vc 同理)各聚类;每线最大簇为多数派,簇外成员为离群者(offset=成员值−簇中心);仅报告有离群者的线(全对齐无线可报);
  - `detectVisualGroups(measured: MeasuredNode[], thresholdPx: number): Array<{ parent: string; axis: 'x'|'y'; groups: Array<{ members: string[]; intraGap: number }> }>`——兄弟按轴排序后单链接聚类(相邻间距 ≤thresholdPx 归同簇),报告 ≥2 簇且簇内有 ≥2 成员的父(intraGap=簇内平均间距);
  - `OrderSection` 增 `alignment_lanes` / `visual_groups` 字段;buildQualityReport opts 加 `visualThresholdPx?: number`(缺省取 spacingScale 最大值,无档位且未传 → 跳过视觉组检测,Review Focus 5)。

- [ ] **Step 1: 失败单测**——① 对齐线:4 兄弟 3 个左对齐 x=24、1 个 x=27 → majority 3 成员、outlier 1 条 offset≈3;② 全对齐 → 空(无线可报);③ 2 兄弟 → 不参与(≥3 守卫);④ 视觉组:间距 [8,8,80,8] 阈值 32 → 两簇 [3 成员]+[2 成员],intraGap≈8;⑤ 间距全大(>阈值)→ 单成员簇不报;⑥ 阈值缺省链:无档位未传 → 检测跳过;有档位 [4,8,16,24] → 阈值 24。
- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-quality-check.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——两检测 + OrderSection 扩展 + buildQualityReport 接线;suggestion 文案(中文一句:对齐线"多数派 N 节点共享 {kind} 对齐线 {lane}px,离群 {path} 偏 {offset}px";视觉组"建议容器化为 HBox/VBox")。
- [ ] **Step 4: 通过 + 门禁 + commit**

Run: `npx vitest run test/ui-quality-check.test.ts && npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/quality-check.ts test/ui-quality-check.test.ts
git commit -m "feat(ui): 对齐线+视觉组聚类进 order 节(批2)"
```

### Task 4: 终审顺手项——后处理单次 parse + viewport 整数标注

**Files:**
- Modify: `src/tools/ui/index.ts`(measure 后处理三段合并)
- Test: `test/ui-measure-viewport.test.ts`(扩展 description 断言)+ 既有回归(重构无行为变化)

**Interfaces:**
- Consumes: index.ts:546-603 附近三段后处理(expect_tree 注入 / viewport_check / quality+order 挂节,各自 JSON.parse 全响应)。
- Produces: 行为等价的重构——单次 parse、单次重写;measure 链与 import 链两处同款合并(import 链若同形态一并)。

- [ ] **Step 1: 回归锚先行**——跑既有 ui 回归全绿记录为重构前基线(`npx vitest run test/ui-quality-check.test.ts test/ui-measure-theme.test.ts test/ui-measure-viewport.test.ts test/prototype-import.test.ts`)。
- [ ] **Step 2: 实现**——三段合并单次 parse/单次重写;viewport 参数的 schema description 补"measure 侧须正整数(SubViewport 尺寸)"(终审 T2①)。
- [ ] **Step 3: 复跑回归全绿(行为等价)+ tsc + 门禁 + commit**

Run: `npx vitest run test/ui-quality-check.test.ts test/ui-measure-theme.test.ts test/ui-measure-viewport.test.ts test/prototype-import.test.ts && npx tsc --noEmit && npm run build-matrix && npm run check:ssot-params && npm run check:budget`

```bash
git add src/tools/ui/index.ts test/ui-measure-viewport.test.ts
git commit -m "chore(ui): measure 后处理合并单次 parse+viewport 整数标注(批1终审顺手项)"
```

### Task 5: 靶子轻量验收(order 报告数字存档)

**Files:**
- Create: `docs/superpowers/plans/2026-11-17-refero-batch2-acceptance.md`(轻量验收记录)

**Interfaces:**
- Consumes: Task 1-3 全部工具(handleTool e2e 模式,同批1 Task 7)。
- Produces: 靶子真实 order 报告数字 + viewport 形参重演记录。

- [ ] **Step 1: order 报告实跑**——靶子 daily_login **副本场景**(真实文件只读,暂存区改动是用户的)挂主题 g960 + g800 各 measure 一次,记录 spacing_scale(靶子 default_theme.tres 无 DesignTokens → 预期跳过;则自建档位表 fixture 补一轮有档位运行)、alignment_lanes、visual_groups 的真实数字进验收记录。
- [ ] **Step 2: viewport 形参重演**——副本场景含裸 offset 一级子(还原批1 改造前形态的 Panel 段)→ `solve_from_current(viewport={w:960,h:540})` 不再 skippedUnresolvedParent、进 toWrite、g960 0 容差(compareBaseline)——批1 人工补笔路径的自动化闭环证明。
- [ ] **Step 3: 记录落盘 + commit**

```bash
git add docs/superpowers/plans/2026-11-17-refero-batch2-acceptance.md
git commit -m "docs(ui): 批2 order 报告靶子数字+viewport 形参重演验收记录"
```
