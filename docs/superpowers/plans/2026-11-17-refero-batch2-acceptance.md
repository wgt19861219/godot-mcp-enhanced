# Refero 批2 靶子轻量验收记录(order 报告数字 + viewport 形参重演)

> 日期:2026-11-17。执行人:Task 5 验收代理。分支 `feature/refero-batch2-layout-order`(BASE=ca788f4f,Task 1-4 已完成)。
> 验收对象:批2 Task 1-3 全部工具(`solve_from_current` viewport 形参 / measure `theme_constants` 导出 + 间距档位检测 / 对齐线 + 视觉组聚类)对真实靶子的轻量闭环——brief Step 1-2 的执行证据。
> 驱动脚本:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\refero-batch2-acceptance.mjs`(stage 机:`order` → `replay`;`GODOT_PATH` + 靶子存在双门控;全部经**副本场景**进行,finally 删临时文件,靶子 git 状态验收前后硬断言一致)。

## 0. 靶子与环境

| 项 | 值 |
|---|---|
| 靶子项目 | `D:\workspace\projects\DotaLegendGodot`(git 仓库,main 分支) |
| 真实场景 | `res://scenes/ui/daily_login_content.tscn`(36 节点;**只读**——暂存区 `M` 为用户未裁决的批1 锚点化改造,验收用副本) |
| 主题 | `res://resources/themes/default_theme.tres`(实读确认**无 DesignTokens type** → 空档预期) |
| 副本形态 | A(order 轮)= 工作区锚点化形态逐字节复制;B(replay 轮)= `git show HEAD:` 裸 offset 形态(批1 改造前,git 逐字节快照优于手工重构) |
| Godot | 4.7 stable(`GODOT_PATH=D:/godot/Godot_v4.7-stable_win64_console.exe`) |
| 通道 | 与批1 同款 `handleTool` 直调本仓 build 产物 |

## 1. order 报告三轮实跑(brief Step 1)

### 轮 1:g960 × default_theme(空档形态)

`ui_measure_layout(theme_path=default_theme.tres)` 默认视口 960×540,36 节点,`stable_after_frames=3`(非 stalled)。

- **theme_constants = `{}`**(default_theme 无 DesignTokens type,空档静默,Review Focus 2 靶子侧)→ **spacing_scale 缺席、visual_groups 缺席**(无声明不发噪音,空档跳过 ✓)。
- **alignment_lanes ×13**(对齐线检测不依赖档位,恒可用):

| 父 | 线 | lane(px) | 多数派 | 离群 |
|---|---|---|---|---|
| Panel | center | 479.625 | 2(MoneyLay/TopRigLay) | 9 |
| Panel | top | 133.750 | 5 | 6 |
| Panel | bottom | 153.750 | 5 | 6 |
| Panel | vc | 143.583 | 6 | 5 |
| Panel/MoneyLay | top | 62.612 | 2(DataImg2/MonthNum) | 2(DataImg2 −14.36、MonthNum −9.61) |
| **Panel/MoneyLay** | **bottom** | **90.167** | **3(MonthNum/LoginMonthLabel/DataImg2)** | **1(RuleButt −8.14)** |
| **Panel/MoneyLay** | **vc** | **71.250** | **3(DataImg2/MonthNum/RuleButt)** | **1(LoginMonthLabel +4.50)** |
| Panel/TopRigLay | left | 452.417 | 3(ProgressBar/ProgressBj/DayNum1) | 15 |
| Panel/TopRigLay | right | 751.250 | 2 | 16 |
| Panel/TopRigLay | center | 601.750 | 2 | 16 |
| Panel/TopRigLay | top | 75.750 | 8 | 10 |
| Panel/TopRigLay | bottom | 95.750 | 8 | 10 |
| **Panel/TopRigLay** | **vc** | **85.750** | **8(DayNum1-4 + Tian1-4)** | **10** |

- **Task 3 真发现复现 ✓**(脚本硬断言):MoneyLay bottom/vc 线离群 + TopRigLay vc 线 **8 多数派 + 10 离群**——离群名单逐值:MsItem1-4 各 **−18.50**、Pot1-4 + ProgressBar + ProgressBj 各 **+13.50**(与 Task 3 报告「MsItem 系偏 −18.5px、Pot 系偏 +13.5px」一致)。注:真靶子 MoneyLay 有 4 子(单测 fixture 3 子无 RuleButt),多数派成员与 fixture 标定略异——bottom 离群为 RuleButt(−8.14)、vc 离群为 LoginMonthLabel(+4.50),检测语义(最大簇多数派)在真实 4 兄弟下同样成立。
- equidistant ×0(批1 同款:负间距叠压组被 ≥0 门槛抑制)。

### 轮 2:g800 × default_theme(viewport 通道,可选复测)

`viewport={w:800,h:480}`,`viewport_check=effective`(注入视口生效硬证据)。**alignment_lanes ×15**——比例缩放后 Panel 的 left(676.375)/right(698.417)两线从单簇分化为多数派 2 + 离群 9(g960 档这两线全散布,多数派 <2 无共享线语义),其余 13 条与 g960 同构、lane 随 ×(5/6, 8/9) 换算(如 TopRigLay vc 85.750→77.333)。spacing_scale/visual_groups 同样空档缺席。

### 轮 3:g960 × fixture theme(有档形态,自建档位表)

fixture = default_theme.tres 全文 + `[resource]` 段尾追加 `DesignTokens/constants/space_1..6 = 4/8/12/16/24/32`(典型设计档 4 的倍数阶梯,不凑靶子真实间距——落档率是靶子真实状态的诚实呈现)。**走 viewport 通道挂场景根**(原因见 §4 竞态发现),`viewport={960,540}` 与项目视口一致:

- **theme_constants 全量导出** `{"space_1":4,"space_2":8,"space_3":12,"space_4":16,"space_5":24,"space_6":32}` ✓
- **fixture 档 rect 与 default 档 0 容差**(36 节点 compareBaseline ok=true——constants 不影响布局,档位轮数字与无档轮同源可信;alignment_lanes ×13 与轮 1 逐值一致)
- **spacing_scale:on=9/13,rate=69.2%**,off_scale ×4:

| 相邻对(a→b) | gap(px) | 最近档 | 差 |
|---|---|---|---|
| Panel/CountdownTime → Panel/TopRigLay | 100.00 | 32 | 68.0 |
| Panel/MonthTotalPre → Panel/MonthTotalNum | 0.00 | 4 | 4.0(贴邻叠压,档位表无 0 档) |
| Panel/CloseBtn → Panel/CountdownPre | 52.30 | 32 | 20.3 |
| Panel/TopRigLay/MsItem4 → Panel/TopRigLay/DayNum1 | 1.00 | 4 | 3.0 |

- **visual_groups ×2**(阈值取最大档 32 的缺省链):Panel x 轴 2 组([TimeImg+CountdownPre] intraGap=4.25 + [MonthTotalPre+MonthTotalNum] intraGap=0.00);Panel/TopRigLay x 轴 7 组(全部 2 成员对:Tian1+Pot1=16.75、MsItem1+DayNum2=7.50、Tian2+Pot2=16.25、MsItem2+DayNum3=5.50、Tian3+Pot3=16.75、MsItem3+DayNum4=5.50、Tian4+Pot4=17.25)——即真实换行网格的横排紧邻对,与 §1 轮 1 的 TopRigLay 六线形态互为印证。

## 2. viewport 形参重演(brief Step 2,批1 人工补笔的自动化闭环)

副本 B = `git show HEAD:scenes/ui/daily_login_content.tscn`(批1 改造前裸 offset 形态,Panel 段无 anchor 行已断言)。链路七步全绿:

1. **还原正确性**:HEAD 形态 measure(挂 default_theme)与批1 快照 `baseline-g960.json` 的 rect **0 容差**(36 节点 compareBaseline ok=true)——git 来源与批1 验收基线运行时完全一致。
2. **无 viewport 现状锚**:`solve_from_current(dry_run=true)` → `toWrite=34`、`skippedUnresolvedParent=[".","Panel"]`——精确复现批1 `plan-dryrun.json`(根 + 一级 Panel 的盲区)。
3. **viewport 形参生效**:`solve_from_current(dry_run=true, viewport={w:960,h:540})` → **`toWrite=35`(34+Panel)、`skippedUnresolvedParent=["."]`**——Panel 不再被跳过,进改造计划。
4. **与批1 人工补笔逐值恒等**:viewport 计划的 Panel entry `anchor=(left 0.10494791716337204, top 0.06712962687015533, right 0.8950520753860474, bottom 0.9810185432434082),offset 四边全 0`——与批1 验收记录 §3.3 人工补笔落盘值**逐值 `===`**(同一 f32 感知数学,自动化与人工殊途同归的铁证;offset 全 0 即浮点整除干净解,无舍入残差)。
5. **写盘**:`dry_run=false` → **written=35**(工具 34 + Panel viewport 兜底 1,**零人工补笔**)。
6. **0 容差回归**:写盘后 measure 与写盘前基线 `compareBaseline ok=true`(36 节点 × rect 四值严格 `===`,0 mismatch、不放宽)。
7. **形态与审计线索**:写盘后 Panel 段 `layout_mode=1` + 四 anchor;注释 28 行逐字节保留。

快照:`replay-plan-noviewport.json` / `replay-plan-viewport.json` / `replay-after-g960.json`。

> 批1 的「Panel 本体人工补笔」(驱动脚本内 50 行同源数学手搓 patch + 位级守卫)至此被 `viewport` 形参完全取代——同样的锚点值、同样的段落级文本 patch、同样的 0 容差门禁,全部收回工具计划内。

## 3. 靶子 git 状态(只读纪律)

验收前后硬断言一致(脚本首尾各核验一次):

```
M  scenes/ui/daily_login_content.tscn
```

真实场景文件零读写;全部操作经副本(`_batch2_order_copy.tscn` / `_batch2_replay_copy.tscn`)与临时 fixture theme(`_batch2_tokens.tres`)进行,finally 删除,`git status` 与验收前逐字节一致。

## 4. 工具链遗留观察(供批3+ 参考,不在本批修)

- **theme_path 挂载的 root 通道会被项目 autoload 覆盖(实测发现)**:靶子 `scripts/autoload/theme_manager.gd:19` 在 `_ready` 里 `get_tree().root.set_theme(_theme)`——measure 脚本在 `_initialize` 挂 fixture theme 到 root 后,autoload `_ready` 于首帧前把 default_theme 覆盖回去,`theme_constants` 读回恒为空档(本验收轮 3 首跑即命中此形态)。**viewport 通道不受影响**(挂场景根,ThemeManager 不碰)。批1 的 rect 测量无感(ThemeManager 挂的与显式挂的同为 default_theme,语境一致)。若批3 需在「自带 root 主题管理器的项目」上做 tokens 档位,考虑 theme_path 挂载改 scene-root 优先或 _emit 前重挂。
- g800 档对齐线比 g960 多 2 条(Panel left/right)——比例缩放让 g960 的全散布线在 g800 凑出 2 成员多数派;多档验收读对齐线时须按档分别读,不能跨档迁移结论。
- spacing_scale 的「贴邻 gap=0」形态(MonthTotalPre→MonthTotalNum)在档位表无 0 档时报 off——语义正确(0 不在声明档内),项目建 tokens 时若有意允许贴邻叠压可考虑加 space_0=0 档或按需忽略。

## 5. 归档清单

| 文件 | 内容 |
|---|---|
| `scripts/refero-batch2-acceptance.mjs` | 验收驱动(order/replay 双 stage + clean 兜底) |
| `docs/superpowers/plans/refero-batch2-acceptance/order-g960.json` | 轮 1 空档(theme_constants={} / lanes ×13 / quality) |
| `docs/superpowers/plans/refero-batch2-acceptance/order-g800.json` | 轮 2 g800(lanes ×15) |
| `docs/superpowers/plans/refero-batch2-acceptance/order-fixture-g960.json` | 轮 3 有档(spacing_scale 9/13 + visual_groups ×2 + theme_constants) |
| `docs/superpowers/plans/refero-batch2-acceptance/replay-plan-noviewport.json` | 重演现状锚(toWrite=34 / skip=[".","Panel"]) |
| `docs/superpowers/plans/refero-batch2-acceptance/replay-plan-viewport.json` | viewport 计划(toWrite=35 / Panel anchors) |
| `docs/superpowers/plans/refero-batch2-acceptance/replay-after-g960.json` | 写盘后 g960 复测(0 容差通过侧) |
| 本文件 | 验收记录(三轮数字 + 重演七步 + git 状态) |

(以上路径均相对 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\`。)
