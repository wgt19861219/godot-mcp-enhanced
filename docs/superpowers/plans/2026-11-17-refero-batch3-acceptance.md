# Refero 批3 靶子轻量验收记录(tokens 层:token_set/token_list/$token import 链)

> 日期:2026-11-17。执行人:Task 5 验收代理。分支 `feature/refero-batch3-tokens`(Task 1-4 已完成,版本 0.37.0 已收口)。
> 验收对象:批3 Task 3/4 全部工具(`$token` 预取解析双链 / `token_set`/`token_list` 文件级读写)对真实靶子的轻量闭环——brief Step 2 三步的执行证据。
> 驱动脚本:`D:\GitHub\godot-mcp-series\godot-mcp-enhanced\scripts\refero-batch3-acceptance.mjs`(`GODOT_PATH` + 靶子存在双门控;无 stage 参数——三步共享同一副本 theme 生命周期;`clean` 子命令兜底清理;全部经 `_batch3_*` 副本进行,finally 删除)。

## 0. 靶子与环境

| 项 | 值 |
|---|---|
| 靶子项目 | `D:\workspace\projects\DotaLegendGodot`(git 仓库) |
| 真实主题 | `res://resources/themes/default_theme.tres`(2487 行;实读确认**无 DesignTokens type** → 空档预期;**只读**) |
| 真实场景 | `res://scenes/ui/daily_login_content.tscn`(36 节点;**只读**) |
| 副本形态 | theme 副本 `res://resources/themes/_batch3_tokens.tres` = default_theme.tres **逐字节复制**;场景副本 `res://scenes/ui/_batch3_import_copy.tscn` = daily_login_content.tscn 复制(③ import 的落盘目标) |
| Godot | 4.7 stable(`GODOT_PATH=D:\godot\Godot_v4.7-stable_win64.exe`,非 console 版——子进程管道读 stdout 正常,驱动 spike 实测) |
| 通道 | 与批1/批2 同款 `handleTool` 直调本仓 build 产物(验收前 `npm run build` 同步最新源) |
| 主题完整性探针 | 驱动脚本自 spawn 一次 Godot(`--headless --path 靶子 --script <os.tmpdir()>/batch3-theme-probe-*.gd`,探针文件不进靶子)读 `get_type_list()` + 每 type 的 colors/constants/font_sizes **值**(Color 转 `[r,g,b,a]`)+ fonts/styleboxes 名单 + variation base;输出 `__BATCH3_PROBE__` 前缀 JSON 行,驱动侧按前缀过滤(引擎 banner 噪音隔离) |

## 1. ① 空档:token_list 诚实空

副本 theme(逐字节复制,无 DesignTokens)→ `token_list`:

```
token_list → {colors:{}, constants:{}}
```

审计语义缺失 ≠ 错误(裸 Theme 不报错,与 Task 4 e2e 锚一致)。探针 before 快照:**types x379**(无 DesignTokens),每 type 值级读数入内存供 ② 前后比对。

## 2. ② 写入 + 审计 + 主题完整性

### token_set ×3 → token_list 逐值 === 读回

写入值全 float32 安全值(2 的幂次,.tres → Color(float32) → JSON → 读回全链位级无损,Task 3 e2e 同款取值依据):

| token | kind | 写入值 | 读回(token_list) |
|---|---|---|---|
| `brand` | color | `[0.5, 0.25, 0.75, 1]` | `[0.5, 0.25, 0.75, 1]` 逐分量 `===` |
| `accent` | color | `[0.25, 0.5, 0.75, 1]` | `[0.25, 0.5, 0.75, 1]` 逐分量 `===` |
| `space_1` | constant | `8` | `8`(`===`) |

计数断言:恰 2 色 + 1 常量,无多余键。三次 `token_set` 返回 `{name, path, kind}` 逐项匹配。

### 主题完整性断言(ResourceSaver 对真 .tres 的 load+save 不破坏既有内容)

token_set ×3 前后探针比对(compareBaseline 思路的 theme 版;实现强度 = **全量**比对而非代表项抽样):

- **types 379 → 380,恰多出 `DesignTokens`**(added = `["DesignTokens"]`,removed = 0);
- **既有 379 type 的值级读数逐项一致**:每 type 的 colors(Color 四分量)/constants/font_sizes **值** + fonts/styleboxes 名单 + variation base,canonical 序列化(键序无关)前后全等;
- 新增 `DesignTokens` 段恰为写入的 3 token(无旁写、无丢失)。

结论:`token_set` 的 ResourceSaver 原子落盘对 2487 行真主题的既有内容零扰动——写入语义是"增量追加命名空间",不是"重写主题"。

## 3. ③ import 链:$ 引用 → style_verify 位级 delta 0

副本场景 + 小 geometry(两 Panel 的 `bg` 均 `$` 引用,视口 960×540 与靶子一致)+ `theme_path` 指副本 theme → `ui_import_prototype`(固定 persist,落盘目标 = 副本场景,finally 与副本一并清理):

```json
geometry.nodes = [
  { name: 'TokenPanel',   rect: {x:40, y:40,  w:240, h:80}, type: 'Panel', bg: '$brand' },
  { name: 'AccentPanel',  rect: {x:40, y:140, w:240, h:40}, type: 'Panel', bg: '$accent' }
]
```

- **`tokens_resolved` = `{theme_path: <副本 theme>, refs: 2, tokens: ['brand', 'accent']}`**——refs = geometry 内 `$` 引用次数(逐次计数),tokens = 去重后已解析名(与主题总 token 数解耦,可审计);
- **`style_verify` 分量 delta = 0(位级)**:TokenPanel / AccentPanel 的 panel 槽 `bg_color` 分量 delta 均 `[0,0,0,0]` 且 `ok=true`——$token 预取 → 字面量 → build Color → measure 读回全链 float32 无损(Task 3 e2e 位级锚在真靶子复现);
- **`layout_verify` 数字**:diff **3/3 全 ok 且 delta 全 0**(_PrototypeRoot 合成根 + 两目标节点,几何侧同样零偏差);overlaps x45——**既有形态如实呈现而非本批缺陷**:44 条为副本场景 daily_login 既有节点的叠压(Panel/Bj 全铺背景与前景件的既有交叠,批2 记录已知的叠压形态)+ 1 条为 `_PrototypeRoot` 与场景根 Panel 的交叠(挂 root 下、两者都占视口区域,挂载语义使然);out_of_bounds x0。

## 4. 靶子 git 状态(只读纪律)

**断言语义 = 与验收前形态一致**(orchestrator 裁决覆盖 brief 的"干净"表述——靶子暂存区可能持有用户未裁决改动,验收不得改变它):驱动脚本验收开始前记录 `git -C 靶子 status --porcelain` 动态快照,finally 清理副本后断言逐行一致。

本次实测:验收前快照 = **干净(空)**(批2 时期的 staged `daily_login_content.tscn` 已被用户裁决收编)→ 验收后逐行一致 ✓。真实 theme/场景文件零读写。

> 驱动脚本两道防线(首跑 parse error 实测教训):① `fail()` 抛异常而非 `process.exit`——exit 会跳过 finally 导致副本残留污染靶子;② 快照前幂等预清理 `_batch3_*` 残留,防历史垃圾混入"验收前快照"扭曲断言语义。

## 5. 快照 ×3 归档

| 文件 | 内容 |
|---|---|
| `docs/superpowers/plans/refero-batch3-acceptance/token-empty-baseline.json` | ① 空档 token_list + 探针 types 计数 |
| `docs/superpowers/plans/refero-batch3-acceptance/token-after-write.json` | ② token_set ×3 返回 + 写后 token_list + 探针 types/DesignTokens 段 + 完整性计数 |
| `docs/superpowers/plans/refero-batch3-acceptance/import-token-chain.json` | ③ geometry + tokens_resolved + style_verify 全量 + layout_verify + build_warnings |
| 本文件 | 验收记录(三步数字 + git 状态 + 探针实现说明) |

(以上路径均相对 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\`。)

## 6. spec 维护同步摘要(本 Task Step 1,详情见 spec diff)

- **D8 补字段级纪律**(按 `src/tools/ui/quality-check.ts` 实况):节级省略(整节无发现不挂,null 语义)/ 已挂节的必检字段空数组照挂(`equidistant: []` 区分"检测了无发现"与"未检测")/ 条件性检测字段(`spacing_scale` 依赖档位声明、`visual_groups` 依赖阈值缺省链)未触发时省略。
- **新增 D10**:theme_path 无默认值——`$token` 引用必须显式传 theme_path,`res://ui/theme.tres` 仅为错误提示语中的约定路径建议(显式优于隐式);批3 节第 3 条同步改写。
- **批3 节 token_set 表述修正**:「语法糖 + ResourceSaver 落盘」→「文件级新 action(项语义对齐 theme_type="DesignTokens",自带 ResourceSaver 原子落盘;不经场景节点)」。
- spec 状态行 v2 → v3(2026-11-17 维护注记)。
