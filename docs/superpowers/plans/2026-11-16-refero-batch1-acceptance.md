# Refero 批1 靶子手工验收记录(daily_login 双档闭环)

> 日期:2026-11-17。执行人:Task 7 验收代理。分支 `feature/refero-batch1-layout`。
> 验收对象:批1 Task 1-6 全工具链(`theme_path` 挂载 / `viewport` SubViewport 通道 / `compareBaseline` 0 容差 / 四类品质检查器 / `solve_from_current` 锚点改造)对真实靶子的端到端闭环——spec「批1 验收 1-5」的执行证据。
> 驱动脚本:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\refero-batch1-acceptance.mjs`(stage 机:baseline → plan → write → verify → g800;`GODOT_PATH` + 靶子存在双门控;写盘幂等护栏 = 靶子场景 git 干净断言;0 容差失败自动 `git checkout` 回滚)。

## 0. 靶子与环境

| 项 | 值 |
|---|---|
| 靶子项目 | `D:\workspace\projects\DotaLegendGodot`(git 仓库,验收前工作区干净) |
| 场景 | `res://scenes/ui/daily_login_content.tscn`(36 节点静态 chrome,LF/UTF-8,tscn 注释承载审计线索) |
| 主题 | `res://resources/themes/default_theme.tres`(`theme_path` 显式传参,双保险) |
| 项目视口 | 960×540,`canvas_items` stretch(project.godot 实读,g800 复测即 800×480 注入) |
| Godot | 4.7 stable(`GODOT_PATH=D:/godot/Godot_v4.7-stable_win64_console.exe`) |
| 运行通道 | 与既有 e2e 同款 `handleTool` 直调(本仓 build 产物),无 MCP 传输层损耗 |

## 1. 基线快照(spec 验收 1;brief Step 1)

**来源**:`ui_measure_layout(scene_path=daily_login_content.tscn, theme_path=default_theme.tres)` 挂主题 g960 档整树 measure,`stable_after_frames=3`(非 stalled,rect 可信),viewport 960×540,节点数 36。
**快照文件**:`docs/superpowers/plans/refero-batch1-acceptance/baseline-g960.json`(1b 格式:逐节点 rect + anchors/offsets 原值;下表为其全文,含 g800 复测值对照)。

### 基线全文(1b 格式:rect | anchors l,r,t,b | offsets l,t,r,b;末列 = 改造后 g800 复测)

| 路径 | 类型 | g960 rect(引擎实测) | anchors | offsets(授权原值) | g800 rect(改造后) |
|---|---|---|---|---|---|
| (场景根) | Control | 0, 0, 960, 540 | 0, 1, 0, 1 | 0, 0, 0, 0 | 0.00, 0.00, 800.00, 480.00 |
| Panel | Control | 100.75, 36.25, 758.5, 493.5 | 0, 0, 0, 0 | 100.75, 36.25, 859.25, 529.75 | 83.96, 32.22, 632.08, 438.67 |
| Panel/Bj | TextureRect | 100.75, 36.25, 758.5, 493.5 | 0, 0, 0, 0 | 0, 0, 758.5, 493.5 | 83.96, 32.22, 632.08, 438.67 |
| Panel/CloseBtn | TextureButton | 810.55, 55.05, 26.40, 26.40 | 0, 0, 0, 0 | 709.80, 18.80, 736.20, 45.20 | 675.46, 48.93, 22.00, 23.47 |
| Panel/MoneyLay | Control | 112.25, 44.75, 225, 64 | 0, 0, 0, 0 | 11.5, 8.5, 236.5, 72.5 | 93.54, 39.78, 187.50, 56.89 |
| Panel/MoneyLay/DataImg2 | TextureRect | 120.75, 48.25, 43, 43 | 0, 0, 0, 0 | 8.5, 3.5, 51.5, 46.5 | 100.63, 42.89, 35.83, 38.22 |
| Panel/MoneyLay/MonthNum | TextureRect | 156, 53, 46.5, 36.5 | 0, 0, 0, 0 | 43.75, 8.25, 90.25, 44.75 | 130.00, 47.11, 38.75, 32.44 |
| Panel/MoneyLay/LoginMonthLabel | Label | 199.25, 61.75, 100, 28 | 0, 0, 0, 0 | 87, 17, 187, 41 | 166.04, 54.89, 83.33, 28.00 |
| Panel/MoneyLay/RuleButt | TextureButton | 268.48, 63.47, 18.55, 18.55 | 0, 0, 0, 0 | 156.23, 18.73, 174.77, 37.28 | 223.73, 56.42, 15.46, 16.49 |
| Panel/MoneyLay/RuleButt/RuleMark | TextureRect | 274.60, 64.17, 6.30, 17.15 | 0, 0, 0, 0 | 6.13, 0.70, 12.43, 17.85 | 228.83, 57.04, 5.25, 15.24 |
| Panel/TopRigLay | Control | 446.75, 44.75, 400, 64 | 0, 0, 0, 0 | 346, 8.5, 746, 72.5 | 372.29, 39.78, 333.33, 56.89 |
| Panel/TopRigLay/ProgressBar | TextureRect | 452.25, 93.75, 299, 11 | 0, 0, 0, 0 | 5.5, 49, 304.5, 60 | 376.88, 83.33, 249.17, 9.78 |
| Panel/TopRigLay/ProgressBj | TextureRect | 452.25, 93.75, 299, 11 | 0, 0, 0, 0 | 5.5, 49, 304.5, 60 | 376.88, 83.33, 249.17, 9.78 |
| Panel/TopRigLay/Pot1 | TextureRect | 502.5, 92.75, 12.5, 13 | 0, 0, 0, 0 | 55.75, 48, 68.25, 61 | 418.75, 82.44, 10.42, 11.56 |
| Panel/TopRigLay/Pot2 | TextureRect | 580.5, 92.75, 12.5, 13 | 0, 0, 0, 0 | 133.75, 48, 146.25, 61 | 483.75, 82.44, 10.42, 11.56 |
| Panel/TopRigLay/Pot3 | TextureRect | 661, 92.75, 12.5, 13 | 0, 0, 0, 0 | 214.25, 48, 226.75, 61 | 550.83, 82.44, 10.42, 11.56 |
| Panel/TopRigLay/Pot4 | TextureRect | 741.5, 92.75, 12.5, 13 | 0, 0, 0, 0 | 294.75, 48, 307.25, 61 | 617.92, 82.44, 10.42, 11.56 |
| Panel/TopRigLay/DayNum1 | Label | 452.75, 75.75, 30, 20 | 0, 0, 0, 0 | 6, 31, 36, 48 | 377.29, 67.33, 25.00, 20.00 |
| Panel/TopRigLay/DayNum2 | Label | 531.25, 75.75, 30, 20 | 0, 0, 0, 0 | 84.5, 31, 114.5, 48 | 442.71, 67.33, 25.00, 20.00 |
| Panel/TopRigLay/DayNum3 | Label | 607.75, 75.75, 30, 20 | 0, 0, 0, 0 | 161, 31, 191, 48 | 506.46, 67.33, 25.00, 20.00 |
| Panel/TopRigLay/DayNum4 | Label | 687.75, 75.75, 30, 20 | 0, 0, 0, 0 | 241, 31, 271, 48 | 573.13, 67.33, 25.00, 20.00 |
| Panel/TopRigLay/Tian1 | Label | 465.75, 75.75, 20, 20 | 0, 0, 0, 0 | 19, 31, 39, 48 | 388.13, 67.33, 16.67, 20.00 |
| Panel/TopRigLay/Tian2 | Label | 544.25, 75.75, 20, 20 | 0, 0, 0, 0 | 97.5, 31, 117.5, 48 | 453.54, 67.33, 16.67, 20.00 |
| Panel/TopRigLay/Tian3 | Label | 624.25, 75.75, 20, 20 | 0, 0, 0, 0 | 177.5, 31, 197.5, 48 | 520.21, 67.33, 16.67, 20.00 |
| Panel/TopRigLay/Tian4 | Label | 704.25, 75.75, 20, 20 | 0, 0, 0, 0 | 257.5, 31, 277.5, 48 | 586.88, 67.33, 16.67, 20.00 |
| Panel/TopRigLay/MsItem1 | Control | 508.75, 59.75, 15, 15 | 0, 0, 0, 0 | 62, 15, 77, 30 | 423.96, 53.11, 12.50, 13.33 |
| Panel/TopRigLay/MsItem2 | Control | 587.25, 59.75, 15, 15 | 0, 0, 0, 0 | 140.5, 15, 155.5, 30 | 489.38, 53.11, 12.50, 13.33 |
| Panel/TopRigLay/MsItem3 | Control | 667.25, 59.75, 15, 15 | 0, 0, 0, 0 | 220.5, 15, 235.5, 30 | 556.04, 53.11, 12.50, 13.33 |
| Panel/TopRigLay/MsItem4 | Control | 747.25, 59.75, 15, 15 | 0, 0, 0, 0 | 300.5, 15, 315.5, 30 | 622.71, 53.11, 12.50, 13.33 |
| Panel/TimeImg | TextureRect | 125.5, 136.75, 11.5, 12 | 0, 0, 0, 0 | 24.75, 100.5, 36.25, 112.5 | 104.58, 121.56, 9.58, 10.67 |
| Panel/CountdownPre | Label | 141.25, 133.75, 200, 20 | 0, 0, 0, 0 | 40.5, 97.5, 240.5, 114.5 | 117.71, 118.89, 166.67, 20.00 |
| Panel/CountdownTime | Label | 290.75, 133.75, 56, 20 | 0, 0, 0, 0 | 190, 97.5, 240, 114.5 | 242.29, 118.89, 56.00, 20.00 |
| Panel/MonthTotalSuf | Label | 812.75, 133.75, 20, 20 | 0, 0, 0, 0 | 712, 97.5, 732, 114.5 | 677.29, 118.89, 16.67, 20.00 |
| Panel/MonthTotalNum | Label | 782.75, 133.75, 30, 20 | 0, 0, 0, 0 | 682, 97.5, 712, 114.5 | 652.29, 118.89, 25.00, 20.00 |
| Panel/MonthTotalPre | Label | 662.75, 133.75, 120, 20 | 0, 0, 0, 0 | 562, 97.5, 682, 114.5 | 552.29, 118.89, 100.00, 20.00 |
| Panel/DayItemPos | Control | 119.25, 154.25, 720, 355 | 0, 0, 0, 0 | 18.5, 118, 738.5, 473 | 99.38, 137.11, 600.00, 315.56 |

注:LoginMonthLabel 授权 h=24、引擎实测 28(主题 20 号字最小行高顶开,Task 1 spike 同现象);基线以引擎实测为准,0 容差比对两侧同为实测值,不受影响。

## 2. 检查报告与名单化处置(spec 验收 2/5;brief Step 2)

挂主题 g960 measure 一次,quality/order 报告全命中项与 Task 4 实测完全一致(**裸壳 A.1 ×3 / 应跟随 A.2 ×1 / 父级越界 ×0 / 视口溢出 ×0 / 等距组 A.3 ×0**),逐项处置如下——**无未处置项,零豁免**:

| # | 报告项 | 类别 | 处置 | 通道 |
|---|---|---|---|---|
| 1 | `Panel`(裸壳,11 子纯 offset) | A.1 | **改造** | 子女 11+孙 23 = 34 节点走 `solve_from_current`(dry_run 核对后写盘);**Panel 本体人工补笔**(见 §3 边界说明) |
| 2 | `Panel/MoneyLay`(裸壳,5 子) | A.1 | **改造** | `solve_from_current` 整树计划内(MoneyLay + DataImg2/MonthNum/LoginMonthLabel/RuleButt/RuleMark 共 6 节点) |
| 3 | `Panel/TopRigLay`(裸壳,18 子) | A.1 | **改造** | `solve_from_current` 整树计划内(TopRigLay + 18 后代共 19 节点) |
| 4 | `Panel/Bj`(rect 贴合 Panel 但 anchor 全 0) | A.2 | **改造** | `solve_from_current` 反解为 `anchor=(0,0,1,1) + offset=0` 全跟随(改造后 g800 Bj rect === Panel rect,实测见 §5) |

- **等距组 A.3 ×0**:实测 0 组(靶子 6 组负间距叠压被 ≥0 门槛正确抑制,Task 4 已记)——无容器化人工决策项,场景结构未为此改动。
- **溢出 D ×0(g960)**:无。
- **g800 档新增命中**:改造后复测 g800 亦全零(裸壳 0/应跟随 0/溢出 0/等距 0)——改造本身消解了 g800 档将暴露的 Panel 越视口(改造前 Panel 右缘 859.25 > 800、下缘 529.75 > 480)。

## 3. 改造(brief Step 3):dry_run 核对 → 写盘

1. **dry_run=true 计划核对**:`toWrite=34`、`skippedUnresolvedParent=[".","Panel"]`、容器子/过滤/无几何均 0;名单项(Bj / MoneyLay 系 / TopRigLay 系)全部在计划内(脚本硬断言)。计划快照:`plan-dryrun.json`。
2. **dry_run=false 写盘**:written=34(段落级文本 patch,`layout_mode=1` + 四 anchor + 四 offset 浮点字面量,注释 28 行逐字节保留)。
3. **Panel 本体人工补笔(工具已知边界的验收侧补全,诚实声明)**:`solve_from_current` 对场景根直接子节点因「父尺寸=视口依赖」进 `skippedUnresolvedParent`(anchor-rebase.ts 头注 + Task5 报告自查 3 记录的边界,brief 参数集无 viewport 形参)。而 g800 验收硬指标(一级 Panel 不越 800 视口 + 中心线 400)只有 Panel 比例锚点可达——补笔用**同一导出原语 + 同一 f32 感知数学**(`parseAuthoredGeometry`/`simulateMargins`/`snap`/`applyRebasePatch`,公式与 `planRebase.solve` 逐字同源),父尺寸取靶子 project.godot 声明视口 960×540(脚本实读断言,非硬编码信任),写前过 `fr(fr(fr(a)·p)+o) === 当前边距` 位级守卫,写后受 §4 的 0 容差门禁覆盖(数学错则 g960 比对必挂并自动回滚)。落盘值:`anchor=(0.10494791716337204, 0.06712962687015533, 0.8950520753860474, 0.9810185432434082)`,`offset` 四边全 0.0(浮点整除干净解,无舍入残差)。
4. 合计写盘 **35 节点**(工具 34 + Panel 补笔 1);场景根维持既有全铺锚点(0,1,0,1)不动。全链先行于副本场景(`_acceptance_rehearsal.tscn`)排练一轮全绿后才触真靶子。

## 4. 0 容差回归(spec 验收 3;brief Step 4)

`ui_measure_layout`(同主题、同默认视口)复测 → `compareBaseline(after, baseline)`:

- **ok = true**——36 节点 × rect 四值(x/y/w/h)浮点**严格 `===`**,0 mismatch、0 容差、不放宽(含 Panel 人工补笔节点与全部 Label 的最小行高钳制值)。
- 快照:`after-g960.json`。TS 侧同源证据:Task 5 e2e 已锚定 `simulateMargins` patch 前后逐值 `===`(本场景 35 节点同数学)。
- 结论:**g960 档逐节点 rect 与基线 0 容差一致**——「坐标是圣经」的反目标判据成立。

## 5. g800 复测(spec 验收 4;brief Step 5,SubViewport 通道)

`ui_measure_layout(viewport={w:800,h:480}, theme_path=...)`,快照 `g800.json`:

| 门禁 | 实测 | 结果 |
|---|---|---|
| 视口生效硬证据 | `viewport_check=effective`;**全铺场景根 rect=800×480**(唯一真全铺节点 DailyLoginContent,Bj 改造前是硬 offset 758.5 不随视口——改造后跟随 Panel) | ✓ |
| 一级 Panel 不越视口 | Panel rect=(83.96, 32.22, 632.08, 438.67),右缘 **716.04** ≤ 800、下缘 **470.89** ≤ 480(改造前 859.25/529.75 双越界) | ✓ |
| 中心线对齐 | Panel 水平中心 = **400.0000**(视口中心 400,Δ=0.0000;官方 g960 即居中设计,比例锚点保中心) | ✓ |
| 位置比例落位 | 抽查 7 节点(根/Panel/MoneyLay/TopRigLay/DayItemPos/DataImg2/CloseBtn):g800 = g960 × (x,w×5/6, y,h×8/9),**Δx/Δy 全部 0.000px**(容差 0.5px) | ✓ |
| 应跟随改造生效 | **Bj rect === Panel rect**(四值相等,w=632.083)——A.2 项改造后真跟随 | ✓ |
| g800 档 quality 报告 | 裸壳 0 / 应跟随 0 / 父级越界 0 / **视口溢出 0** / 等距 0 | ✓ |

**尺寸容偏记录(D2 声明的容偏区间)**:Panel w 758.5→632.083(×0.83333 = 5/6 等比),h 493.5→438.667(×0.88889 = 8/9 高度档)——h 相对美术等比(5/6)偏 **+6.7%**,即「双档换算非均匀,高度偏容忍」的实测形态;Bj `expand_mode=1` 拉伸贴 rect,同口径。Label 类(最小行高钳制域)只记录不断言:LoginMonthLabel h 保持 28(20 号字行高);CountdownTime w 保持 56(文本最小宽钳制,比例值 46.67);DayNum 系 h 保持 20——位置全部精确落位。

> brief Step 5 原文「全铺 Bj rect.w=800」的字面读法与本靶子物理不符(Bj ⊂ Panel ⊂ 视口,官方设计面板宽 79% 居中,Bj 恒等于 Panel 宽而非视口宽)。按 dispatch 上下文更正口径(「唯一真全铺节点 = DailyLoginContent 根,Bj 改造后才跟随」)执行:**视口生效证据 = 全铺场景根 rect.w=800;Bj 的验收形态 = rect === Panel rect(全铺跟随)**,两者均已硬断言通过。

## 6. 靶子 git 状态(去留由用户决定,未 commit)

```
 M scenes/ui/daily_login_content.tscn
 scenes/ui/daily_login_content.tscn | 487 ++++++++++++++++++++++++-------------
 1 file changed, 315 insertions(+), 172 deletions(-)
```

- 唯一改动文件 `D:\workspace\projects\DotaLegendGodot\scenes\ui\daily_login_content.tscn`:35 个 [node] 段的布局行改写(`layout_mode=1` + 比例 anchor + 浮点 offset),注释/纹理引用/其他属性逐字节保留;g960 运行时 rect 位级不变(daily_login_panel.gd 经节点路径取用 chrome,行为不变)。
- **未 commit、未 add**——保留在工作区由用户裁决;若需还原:`git -C D:\workspace\projects\DotaLegendGodot checkout -- scenes/ui/daily_login_content.tscn`。

## 7. 工具链遗留观察(供批2+ 参考,不在本批修)

- `solve_from_current` 的 `skippedUnresolvedParent` 边界使「场景根直接子节点」成为工具盲区——本次以导出原语人工补笔收口。若批2+ 高频出现该形态,可评估给 `solve_from_current` 加可选 `viewport` 形参(授权几何侧根尺寸显式化),让 Panel 类节点进工具计划。
- Label 最小行高/最小宽钳制(主题语境)使 Label 的 g800 尺寸不随比例缩放(位置仍精确)——「位置对齐尺寸容偏」基准下可接受,批2 间距档位检查时需注意该噪声源。

## 8. 归档清单

| 文件 | 内容 |
|---|---|
| `scripts/refero-batch1-acceptance.mjs` | 验收驱动(排练通道 `ACCEPTANCE_SCENE` env) |
| `docs/superpowers/plans/refero-batch1-acceptance/baseline-g960.json` | g960 基线(1b 格式) |
| `docs/superpowers/plans/refero-batch1-acceptance/plan-dryrun.json` | dry_run 计划快照 |
| `docs/superpowers/plans/refero-batch1-acceptance/after-g960.json` | 改造后 g960 复测 |
| `docs/superpowers/plans/refero-batch1-acceptance/g800.json` | g800 复测(含 quality/order) |
| 本文件 | 验收记录(名单化表 + 0 容差 + g800 数值 + 靶子 git 状态) |

(以上路径均相对 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\`。)
