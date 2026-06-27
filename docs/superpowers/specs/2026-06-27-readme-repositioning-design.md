# README 重定位设计(2026-06-27)

> **修订 r2(2026-06-27)**:经独立 review(`D:\workspace\review\.claude\reviews\2026-06-27-readme-repositioning-design-review.md`)修正 C1/I1/I2/I3/I5/A1/A3 共 7 项(1 CRITICAL + 4 IMPORTANT + 2 ADVISORY)。修订记录见文末。

## 背景

基于 2026-06-27 竞品调研:GitHub 336 个 godot-mcp repo,本项目 59 stars(第二梯队);赛道两极分化(免费的功能都少 10–39,功能全的都闭源付费 $15–19);安全维度赛道少见;腾讯 CodeBuddy 是 MCP client 可借力分发。

现版 README 以「基于 Coding-Solo/godot-mcp 二次开发,填补关键能力空白」自我定位(衍生品心态),对比表只 vs 2025 原版(Coding-Solo 现仅 13 工具,对比已无意义),安全埋在第 104 行且是免责话术。需重定位为赛道独立方案。

详见 `D:\workspace\Obsidian\godot-mcp-enhanced\系统文档\资料-Godot MCP 竞品与赛道分析.md`。

## 设计决策(brainstorming 已确认 + review 修正)

1. **头号定位标签**:免费 · 开源 · 功能全(赛道真空地带叙事)
2. **对比表**:点名真实竞品(godot-mcp-pro $15 / GDAI $19 / Coding-Solo)+ 标注数据日期 2026-06-27 + **逐项脚注来源**(I4)
3. **安全卖点**:双层话术(正面卖点摘要 + 折叠诚实详情)
4. **编排**:营销优先 —— Hero → 对比表 → 安全 → 核心能力 → 工具列表 → 快速开始 → 收尾
5. **诚实口径统一**(I2/I3/A1):所有断言改「截至 2026-06-27 调研」范围表述,删除"唯一/赛道独占"绝对断言;Hero 只列已端到端验证的 client

## 新 README 结构总览

1. Hero(头号标签 + 已验证 client 列举)
2. 与同类方案对比(点名竞品 + 日期 + 脚注来源)
3. 安全体系(少见,双层话术)
4. 核心能力(三层架构 + AI 开发闭环)
5. 工具一览(**128+**,保留现版全量工具表原样)
6. 快速开始(CodeBuddy 配置 + 明确标注验证状态)
7. 收尾(双版权 LICENSE / 致谢 / 更新日志 / 系统要求)

---

## 各节实施蓝本

### 1. Hero

```markdown
# Godot MCP Enhanced

> 免费 · 开源 · 全功能 —— 截至 2026-06-27 调研,Godot MCP 赛道里
> 罕见「免费 + 开源 + 128+ 工具」的方案。

给 AI(Claude Code、Cursor 等 MCP 客户端)一个能真正读、写、跑、验证 Godot 项目的
工具层:128+ 工具覆盖场景/脚本/UI/动画/物理/粒子/导航/音频/测试/导出,三层架构
(headless + editor + game bridge)+ 路径白名单 / 注入防御 / sandbox 安全体系。

[可选 badges: MIT License · GitHub stars · Godot 4.x · 中文友好]
```

要点(r2 修正):
- **删除"唯一"绝对断言**(I2)→ 「截至 2026-06-27 调研,罕见」范围表述,与对比表"不诽谤"口径一致
- **工具数全文统一 128+**(I1)—— grep 实测现版工具表 128 行
- **Hero 只列已端到端验证的 client(Claude Code / Cursor)**(I3 B 方案);CodeBuddy 不在 Hero,仅出现在快速开始并标注验证状态
- **中文策略**并入此处一句话:"工具描述为简体中文,服务中文 Godot 开发者社区;欢迎 i18n PR。"

### 2. 与同类方案对比

引言先给两极分化叙事框架,再放表。诚实标注:工具数 128+ < 175(不假装最多);未披露用 "—" 不用 "❌"(不诽谤);加粗只标本项目优势格。

竞品列 4 个:godot-mcp-pro($15)/ GDAI MCP($19)/ Coding-Solo(免费少功能)/ 本项目。数据截至 2026-06-27。

维度行:价格 / 开源 / 工具数 / 安全特性 / 架构 / Godot 4.5–4.7 兼容矩阵 / 中文工具描述。

**逐项脚注来源**(I4):每个竞品的价格/工具数/连接方式加脚注,如:
```
godot-mcp-pro 工具数 175 [^1]
[^1]: https://github.com/youichi-uda/godot-mcp-pro README,抓取 2026-06-27
```
来源统一指向 `资料-Godot MCP 竞品与赛道分析.md` 的调研数据。脚注既支撑诚实叙事,也方便后续 PR 修正。

脚注:"—" 表示该项目公开 README 未披露相应能力,不代表必然缺失;欢迎 PR 修正。

### 3. 安全体系(少见提供系统化安全特性)

开头一句定调(r2 A1 修正):「截至 2026-06-27 调研,Godot MCP 赛道内少见提供系统化安全特性的方案。」(删除"赛道独占""绝大多数不提供"绝对断言)

5 条正面能力表述:路径访问控制 / GDScript 注入防御 / 危险操作确认令牌 / 输出标记防伪造 / 本地运行。

诚实警告完整保留,折叠进 `<details><summary>⚠️ 诚实的边界(展开必读)</summary>`:沙箱是防误操作层非安全边界、可被间接绕过、需容器/VM + `GODOT_MCP_ALLOW_UNSAFE=false`、仅限本地可信环境。

### 4. 核心能力

**三层架构**:现版"双模式"升级为"三层"(补 Game Bridge)。表格列三层(Headless CLI / Editor WebSocket / Game Bridge)+ 连接方式 + 适用场景。

**AI 开发闭环**:`read_scene/read_script → write_script/edit_script → run_and_verify → validate_scripts → verify_delivery`。突出 `verify_delivery`/`validate_scripts`/`dev_loop` 三个门禁工具(差异化)。现版"闭环开发示例"并入此节。

### 5. 工具一览(128+)

**保留现版全量工具表原样**(每个工具逐行列,按执行/验证/动态执行/项目/场景/脚本/运行时/音频/TileMap/API文档/材质/Game Bridge/工作流/动画/性能/3D/测试导出/粒子/导航/AnimTree/IK/验证交付/游戏设计/代码模板/UI/录制/编辑器同步 分类)。

仅调整:标题从"工具列表(140+ 个)"→"工具一览(128+)";保留"运行时工具不持久化"提示。

> 工具数口径:128 = 2026-06-27 grep 实测 README 工具表行数(`^\| \`[a-z0-9_]+\``)。若含子操作(如 animation/animtree 的多个子命令),暴露给 MCP 的 tool 数更高,以源码 ToolRegistry 为准 —— 但 README 对外统一报「128+」。

### 6. 快速开始

现版保留:1 分钟配置(Claude Code `-s user` / Cursor-Cline-Windsurf)/ 一键配置 / 首次使用(setup_project_rules)/ 环境变量 / 多版本 Godot / 手动配置。

**新增 CodeBuddy 小节**(I3 B 方案,在 Cursor之后,明确标注验证状态):
```markdown
#### 腾讯 CodeBuddy(国内用户)
CodeBuddy 文档(2026-06-27 实测)支持外部 stdio MCP Server:**设置 → MCP 标签 → Add MCP**,
粘贴与 Cursor 相同的 json。也可从其 MCP Market 一键安装(上架后)。
> ⚠️ 端到端接入验证待补:配置方法基于 CodeBuddy MCP 文档,godot-mcp-enhanced 尚未在其内跑通。
```
口径与 Hero 一致(Hero 不宣称 CodeBuddy 开箱即用)。

### 7. 收尾

- **许可证**:MIT + 链接 `[LICENSE](LICENSE)`(r2:**已含双版权** —— `Copyright (c) 2026 wgt19861219` + `Copyright (c) 2025 Solomon Elias (Coding-Solo/godot-mcp)`,符合 MIT fork 要求)
- **致谢**:保留对象(原版 godot-mcp / Hastur / CCGS)。**"基于 Coding-Solo 二次开发"从开头移入致谢**——渊源诚实保留,但不作为主定位
- **更新日志**:保留(链接 CHANGELOG.md)
- **系统要求**:保留末尾
- **截图平台说明**:折叠进 `<details>`

---

## 次要节处理

| 现版节 | 去向 |
|---|---|
| 工具描述语言策略 | 并入 Hero 一句话 |
| MCP Resources(godot://) | 作为核心能力后的独立小节保留(内容不动,仅降位置) |
| 闭环开发示例 | 并入核心能力的闭环小节 |
| 截图平台说明 | 折叠 `<details>` |
| 系统要求 | 保留末尾 |

## 衍生定位淡化

现版开头 "基于 [godot-mcp](https://github.com/Coding-Solo/godot-mcp) 二次开发,填补了关键能力空白" → **移除开头**。渊源保留在致谢节(诚实)。项目当前 128+ 工具 + 三层架构 + 安全体系,已是赛道独立方案,不再以"填补原版空白"自我定位。

## 实施待办(README 外)

- [ ] 申请上架 CodeBuddy MCP Market(借力分发,调研结论)
- [ ] CodeBuddy 端到端接入验证(验证后可移入 Hero 兼容列表 + 去掉快速开始的警告)
- [ ] README.en.md 同步重构(双语);过渡期在 README.en 顶部加注「本英文版可能滞后于中文版,以 README.md 为准」(A2)

## 不改的部分

- 快速开始的"一键配置 / 首次使用 / 环境变量 / 多版本 Godot / 手动配置"
- 全量工具表(逐个列)
- 更新日志表
- 致谢对象(仅位置调整)
- 系统要求

## 验收标准

- [ ] Hero 第一眼可见"免费+开源+全功能"真空地带叙事
- [ ] 对比表点名 ≥3 个真实竞品 + 标注 2026-06-27 日期 + **逐项脚注来源**(I4)
- [ ] 安全节卖点摘要在前、诚实详情折叠在后,标题用范围表述非"独占"(A1)
- [ ] "双模式"表述全部升级为"三层"(含 Game Bridge)
- [ ] 开头不再以"基于 Coding-Solo 二次开发"为主定位
- [ ] CodeBuddy 出现在快速开始并标注验证状态;Hero 与快速开始口径一致(I3)
- [ ] LICENSE 文件被许可证节链接,**且含上游 Solomon Elias copyright**(C1/A3)
- [ ] **全文工具数统一为「128+」单一数字**(I1/I5):`grep -nE "100\+|130\+|140\+" README.md` 应只命中 0 处或仅 128+ 上下文;`grep -cE "^\| \`[a-z0-9_]+\`" README.md` ≈ 128
- [ ] Hero 无"唯一"绝对断言,改为「截至 2026-06-27 调研,罕见」(I2)

---

## Review 修订记录(r2, 2026-06-27)

来源:`D:\workspace\review\.claude\reviews\2026-06-27-readme-repositioning-design-review.md`(CRITICAL ×1 / IMPORTANT ×5 / ADVISORY ×3)。核实后全部成立,无需 push back。

| ID | 级别 | finding | 核实 | 处理 |
|---|---|---|---|---|
| C1 | CRITICAL | LICENSE 抹上游 Coding-Solo 版权 | ✅ Coding-Solo = MIT,版权人 `Solomon Elias 2025`;本项目继承其核心工具(启动/运行/调试) | LICENSE 改双版权(已修);许可证节 + 验收反映 |
| I1 | IMPORTANT | 工具数 100+/130+/140+ 打架 | ✅ grep 实测现版工具表 128 行 | 全文统一「128+」 |
| I2 | IMPORTANT | Hero「唯一」vs 对比表「不诽谤」 | ✅ 绝对断言可证伪 | 改「截至 2026-06-27 调研,罕见」 |
| I3 | IMPORTANT | CodeBuddy Hero 兼容 vs 快速开始未验证 | ✅ 口径冲突 | 选 B 方案:Hero 只列已验证 client,CodeBuddy 仅快速开始标注 |
| I4 | IMPORTANT | 对比表数字缺来源 | ✅ 来源在调研笔记 | 对比表加逐项脚注 |
| I5 | IMPORTANT | 验收漏工具数统一 | ✅ | 验收补第 8 条 + grep 机器校验 |
| A1 | ADVISORY | 安全「赛道独占」同 I2 | ✅ | 改「少见提供系统化安全特性」 |
| A2 | ADVISORY | README.en 同步滞后 | ✅ | 过渡期加滞后注 |
| A3 | ADVISORY | LICENSE 衔接 | ✅ 承接 C1 | 验收补「LICENSE 含上游 copyright」 |

**未处理(留 plan/实施)**:I4 脚注的具体 markdown 编写、A2 过渡注措辞 —— 属实施细节。

### 关于 review 待拍板

1. **C1 沉淀进 defects.md**:该文件位于 review 仓库(`D:\workspace\review\.claude\knowledge\defects.md`),非项目仓库,且 reviewer 指出已 modified 未提交。C1 已在本项目直接修复(LICENSE 双版权),无需再作为 open defect 沉淀。若 review 工作站为闭环统计需要留痕,由 reviewer 自行写入更妥(我不便跨仓改文件)。
2. **两个 read-only 核实**:已完成 —— (a) 工具数 128(grep);(b) Coding-Solo MIT + Solomon Elias(raw LICENSE)。结果已用于上述修复。
