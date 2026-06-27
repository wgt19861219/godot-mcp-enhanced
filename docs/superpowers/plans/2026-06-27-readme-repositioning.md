# README 重定位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `godot-mcp-enhanced` 的 README 从「Coding-Solo 原版增强衍生品」重定位为「免费 · 开源 · 全功能 赛道独立方案」。

**Architecture:** 整体重写 `README.md` 为新结构(Hero → 对比表 → 安全 → 核心能力 → 工具列表 → 快速开始 → 收尾),重写节给全量内容,可复用节(全量工具表 / 快速开始主体 / 更新日志 / 致谢对象 / 系统要求)从现版原样搬入。验证用 grep 工具数校验 + 9 条验收清单 + GitHub markdown 目视渲染。

**Tech Stack:** GitHub-flavored Markdown

## Global Constraints

- **工具数全文统一「128+」**:完成后 `grep -nE "100\+|130\+|140\+" README.md` 应 0 命中(或仅出现在"128+"的上下文里无独立 100+/130+/140+);`grep -cE "^\| \`[a-z0-9_]+\`" README.md` ≈ 128
- **LICENSE 不动**:已含双版权(`Copyright (c) 2026 wgt19861219` + `Copyright (c) 2025 Solomon Elias (https://github.com/Coding-Solo/godot-mcp)`),本 plan 不改 LICENSE
- **保留原样**:全量工具表(128 个工具逐行列)、快速开始的「一键配置/首次使用/环境变量/多版本 Godot/手动配置」、更新日志表、致谢对象、系统要求
- **衍生定位淡化**:开头删除「基于 Coding-Solo/godot-mcp 二次开发,填补了关键能力空白」;渊源句保留但移入致谢节
- **诚实口径**:所有断言用「截至 2026-06-27 调研,罕见/少见」范围表述;禁止「唯一」「赛道独占」「绝大多数不提供」绝对断言
- **CodeBuddy 口径(I3 B 方案)**:Hero 不列 CodeBuddy;CodeBuddy 仅在快速开始出现并标注「端到端接入验证待补」
- **分支**:从 `feat/args-validator` 开 `docs/readme-repositioning` 分支工作(LICENSE 已在该分支改双版权,一并带过去)

## File Structure

- **Modify:** `D:\GitHub\godot-mcp-enhanced\README.md`(整体重写为新结构)
- **不动:** `LICENSE`(已双版权)、`CHANGELOG.md`、`docs/capability-matrix.md`(工具列表链接目标)、`package.json`
- **过渡处理:** `README.en.md` 顶部加滞后注(A2);完整双语同步列为后续待办,不在本 plan 内

**现版 README 节顺序(行号近似,作搬迁锚点):**
1. 标题+介绍(1-7)→ 重写为 Hero
2. 「与原版 godot-mcp 对比」(9-59)→ 重写为「与同类方案对比」
3. 「核心亮点」(61-95)+「闭环开发工作流」(97-102)+「闭环开发示例」(555-580)→ 合并重写为「核心能力」
4. 「安全边界」(104-114)→ 重写为「安全体系」(双层)
5. 「工具描述语言策略」(116-122)→ 删除(并入 Hero 一句话)
6. 「快速开始」(124-238)→ 保留 + 插入 CodeBuddy 小节
7. 「工具列表(140+ 个)」(240-519)→ 标题改「工具一览(128+)」,内容原样
8. 「MCP 资源」(521-553)→ 降位为核心能力后独立小节,内容原样
9. 「致谢」(582-593)→ 保留对象 + 移入渊源句
10. 「系统要求」(595-599)→ 原样,置收尾
11. 「截图功能平台说明」(601-611)→ 折叠 `<details>`
12. 「许可证 MIT」(613-615)→ 改为链接 `[LICENSE](LICENSE)`
13. 「更新日志」(617-648)→ 原样

---

### Task 1: 开分支

**Files:** 无(仅 git 操作)

- [ ] **Step 1: 从当前分支开新分支**

```bash
git -C "D:/GitHub/godot-mcp-enhanced" checkout -b docs/readme-repositioning
```

Expected: `Switched to a new branch 'docs/readme-repositioning'`(LICENSE 双版权改动随当前工作树带过来)

- [ ] **Step 2: 确认起点干净**

```bash
git -C "D:/GitHub/godot-mcp-enhanced" status --short
```

Expected: 看到 `LICENSE`、`README.md`(未改)、`docs/superpowers/specs/...`、`docs/superpowers/plans/...`(本 plan)等未提交改动,正常。

---

### Task 2: 整体重写 README.md

**Files:**
- Modify: `D:\GitHub\godot-mcp-enhanced\README.md`(整体 Write 覆盖为新结构)

**Interfaces:**
- Consumes: 现版 README.md 的「工具列表」(128 工具)、「快速开始」主体、「MCP 资源」、「致谢」对象、「系统要求」、「截图功能平台说明」、「更新日志」—— 原样搬入
- Produces: 新 README.md,按下方各节内容

**执行策略:** 因涉及节重排(新顺序 ≠ 现版顺序),用整体 Write 覆盖最稳妥。下方给「重写节」的全量 markdown + 「复用节」的搬运指令。组装时按列出的节顺序拼接。

- [ ] **Step 1: 撰写新 README.md,按以下节顺序拼接**

#### 节 1 — Hero(重写,全量)

```markdown
# Godot MCP Enhanced

> 免费 · 开源 · 全功能 —— 截至 2026-06-27 调研,Godot MCP 赛道里
> 罕见「免费 + 开源 + 128+ 工具」的方案。

给 AI(Claude Code、Cursor 等 MCP 客户端)一个能真正读、写、跑、验证 Godot 项目的
工具层:128+ 工具覆盖场景/脚本/UI/动画/物理/粒子/导航/音频/测试/导出,三层架构
(headless + editor + game bridge)+ 路径白名单 / 注入防御 / sandbox 安全体系。

**[English](README.en.md)** · 工具描述为简体中文,服务中文 Godot 开发者社区;欢迎 i18n PR。
```

#### 节 2 — 与同类方案对比(重写,全量,含脚注)

```markdown
## 与同类方案对比

> **本项目不追求"工具数量第一"。** 赛道里,godot-mcp-pro 有 175 个工具但闭源收 $15;
> 免费的 Coding-Solo 仅 13 个。真正稀缺的是「免费 + 开源 + 全功能 + 安全」的组合。
> 数据截至 2026-06-27(stars / 工具数 / 价格均可能变化,详见各项目仓库)。

| 维度 | **本项目** | godot-mcp-pro | GDAI MCP | Coding-Solo/godot-mcp |
|---|:---:|:---:|:---:|:---:|
| 价格 | **免费** | $15 买断 [^p1] | $19 买断 [^p2] | 免费 [^p3] |
| 开源 | **✅ MIT** | ❌ server 预编译闭源 [^p1] | ❌ [^p2] | ✅ [^p3] |
| 工具数 | 128+ | 175 [^p1] | ~30 [^p1] | 13 [^p1] |
| 安全特性 | **✅ 路径白名单 / 注入防御 / sandbox / 确认令牌 / 输出防伪** | — | — | — |
| 架构 | **三层 headless + editor + bridge** | 单 editor WS [^p1] | stdio [^p1] | headless CLI [^p1] |
| Godot 4.5–4.7 兼容矩阵 | **✅** | — | — | — |
| 中文工具描述 | **✅** | — | — | ❌ |

[^p1]: https://github.com/youichi-uda/godot-mcp-pro README(含其自带竞品对比表),抓取 2026-06-27
[^p2]: GDAI MCP,数据转引自 godot-mcp-pro 对比表,2026-06-27
[^p3]: https://github.com/Coding-Solo/godot-mcp,抓取 2026-06-27

_"—" 表示该项目公开 README 未披露相应能力,不代表必然缺失;欢迎 PR 修正。_
```

#### 节 3 — 安全体系(重写,全量,双层)

```markdown
## 安全体系

截至 2026-06-27 调研,Godot MCP 赛道内少见提供系统化安全特性的方案。本项目内置多层防护,
适合对可信边界有要求的开发场景:

- **路径访问控制** — `ALLOWED_PROJECT_PATHS` 白名单(deny-by-default),防 junction / 符号链接绕过
- **GDScript 注入防御** — 危险 API 模式扫描 + 字符串拼接绕过检测
- **危险操作确认令牌** — 删节点等操作需显式确认
- **输出标记防伪造** — 每次执行随机标记,防 GDScript 伪造 MCP 输出
- **本地运行** — 无远程暴露,无第三方数据上传

<details>
<summary><b>⚠️ 诚实的边界(展开必读)</b></summary>

以上是**防误操作层**,不是不可绕过的安全边界。GDScript 拥有完整系统访问权限,
沙箱可被间接方式绕过(`call()` 动态分派、多步变量构造 API 名等)。

- 需真正隔离:容器 / VM + `GODOT_MCP_ALLOW_UNSAFE=false`
- 关闭扫描:`GODOT_MCP_SANDBOX=disabled`(仅开发)
- 本工具**仅限本地可信环境**,不提供远程认证或加密

</details>
```

#### 节 4 — 核心能力(重写,全量;合并现版核心亮点 + 闭环工作流 + 闭环示例)

```markdown
## 核心能力

### 三层架构 — 静态编辑 / 实时调试 / 运行时验证

不是单一连接,而是按场景分工的三层(自动检测,互不冲突):

| 层 | 连接方式 | 适用场景 |
|---|---|---|
| **Headless CLI** | 独立 Godot 进程 | 文件读写、批量创建、一次性验证(默认) |
| **Editor WebSocket** | 连接运行中的编辑器 | 实时操作当前场景、Undo、场景树同步 |
| **Game Bridge** | TCP 连接运行中的游戏 | E2E 测试、运行时调试、输入模拟、状态验证 |

### 动态 GDScript 执行

`execute_gdscript` 让 AI 在 headless 模式执行任意 GDScript:代码片段模式(自动包装 `extends SceneTree`)、结构化输出(`_mcp_output`)、超时控制、Autoload 上下文(`load_autoloads=true`)、结构化错误(类型/文件/行号/修复建议)。

### AI 开发闭环 — 不只是工具堆砌

\```
read_scene / read_script → 理解结构 → write_script / edit_script
→ run_and_verify(错误分析)→ validate_scripts → verify_delivery(交付门禁)
\```

- **`verify_delivery`** — 端到端交付门禁:场景树完整性 + 脚本健康 + 性能 + 自定义断言
- **`validate_scripts`** — 触发 Godot 完整编译(含跨文件依赖),捕获 headless 遗漏的 Parse Error
- **`dev_loop`** — 执行 → 验证 → 截图一体化,支持 acceptance 验收标准

闭环示例:AI 用 `read_scene` 理解 → `write_script` 改 → `run_and_verify(capture_tree=true)` 跑+分析 → `validate_project` 查资源 → `batch_add_nodes` 批建 → `import_resources` 注册 → 有问题回到改脚本。
```

#### 节 5 — 工具一览(复用现版,仅改标题)

把现版 README.md 第 240 行起「## 工具列表(140+ 个)」整节(到「## MCP 资源」前,含所有 128 个工具的分类表)原样搬入,仅做两处改动:
- 标题改为 `## 工具一览(128+)`
- 保留末尾「运行时工具不持久化」提示原样

#### 节 6 — MCP 资源(复用现版,降位独立小节)

把现版「## MCP 资源(Resources)」整节(静态资源表 + 资源模板 + 安全限制 + 使用示例)原样搬入,位置在「工具一览」之后。

#### 节 7 — 快速开始(复用现版 + 插入 CodeBuddy 小节)

把现版「## 快速开始」整节原样搬入(1 分钟配置 Claude Code / Cursor-Cline-Windsurf / 一键配置 / 首次使用 / 环境变量 / 多版本 Godot / 手动配置),在「#### Cursor / Cline / Windsurf / 其他」小节**之后**插入:

```markdown
#### 腾讯 CodeBuddy(国内用户)
CodeBuddy 文档(2026-06-27 实测)支持外部 stdio MCP Server:**设置 → MCP 标签 → Add MCP**,
粘贴与上面相同的 json。也可从其 MCP Market 一键安装(上架后)。
> ⚠️ 端到端接入验证待补:配置方法基于 CodeBuddy MCP 文档,godot-mcp-enhanced 尚未在其内跑通。
```

注:现版 Cursor 小节标题若为「Cursor / Cline / 其他」,保持原样即可(Codex 不单列)。

#### 节 8 — 致谢(复用对象 + 移入渊源句)

把现版「## 致谢」整节搬入(原版 godot-mcp / Hastur / CCGS 三项原样),在「[godot-mcp](...) — 原始项目」条目的描述里补渊源句:

```markdown
- [godot-mcp](https://github.com/Coding-Solo/godot-mcp) — 原始项目,本项目基于其二次开发(Copyright (c) 2025 Solomon Elias,MIT,见 [LICENSE](LICENSE))
```

#### 节 9 — 系统要求(复用现版,原样)

把现版「## 系统要求」整节原样搬入。

#### 节 10 — 截图功能平台说明(复用现版,折叠)

把现版「## 截图功能平台说明」整节内容搬入,但整体包进 `<details>`:

```markdown
<details>
<summary><b>截图功能平台说明</b></summary>

(原样搬入现版截图平台说明正文 + 平台表格)

</details>
```

#### 节 11 — 许可证(改链接)

```markdown
## 许可证

[MIT](LICENSE) — 含上游 [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) 版权。
```

#### 节 12 — 更新日志(复用现版,原样)

把现版「## 更新日志」整节(含版本表格 + CHANGELOG 链接)原样搬入。

- [ ] **Step 2: 验证写入完整**

Run: `grep -cE "^\| \`[a-z0-9_]+\`" "D:/GitHub/godot-mcp-enhanced/README.md"`
Expected: `128`(工具表原样搬入,行数不变)

Run: `grep -nE "基于.*Coding-Solo.*二次开发|填补了关键能力空白" "D:/GitHub/godot-mcp-enhanced/README.md"`
Expected: 无命中(开头衍生句已删;渊源句在致谢节用不同措辞,不含"填补关键能力空白")

- [ ] **Step 3: Commit**

```bash
git -C "D:/GitHub/godot-mcp-enhanced" add README.md
git -C "D:/GitHub/godot-mcp-enhanced" commit -m "docs(readme): 重定位为免费+开源+全功能赛道方案

- Hero: 删'唯一'绝对断言改'罕见'范围表述,工具数统一128+
- 对比表: 点名godot-mcp-pro/GDAI/Coding-Solo + 逐项脚注来源
- 安全: 双层话术(卖点摘要+折叠诚实边界),'少见'替代'赛道独占'
- 核心能力: 双模式升级为三层(补GameBridge)+ 闭环门禁
- 衍生定位: 开头删除'基于Coding-Solo二次开发',渊源移入致谢
- CodeBuddy: 仅快速开始出现并标注验证状态
- 许可证: 链接LICENSE(含双版权)"
```

---

### Task 3: 工具数全文统一校验

**Files:** 已改的 `README.md`

- [ ] **Step 1: 确认无残留旧数字**

Run: `grep -nE "100\+|130\+|140\+" "D:/GitHub/godot-mcp-enhanced/README.md"`
Expected: 0 命中(若有,定位并改为「128+」)

- [ ] **Step 2: 确认 128+ 出现且一致**

Run: `grep -nE "128\+" "D:/GitHub/godot-mcp-enhanced/README.md"`
Expected: 命中 Hero 定位句 + Hero 描述句 + 工具一览节标题(至少 3 处,口径一致)

- [ ] **Step 3: 若 Step 1 有残留,修复后重跑 Step 1 直至 0 命中**

如残留出现在更新日志历史版本描述里(如「v0.10.0(124 工具)」),**保留不改**——那是历史事实记录,不属于"当前工具数"叙事。仅改"当前定位"语境的数字。

- [ ] **Step 4: Commit(若有修复)**

```bash
git -C "D:/GitHub/godot-mcp-enhanced" add README.md
git -C "D:/GitHub/godot-mcp-enhanced" commit -m "docs(readme): 工具数全文统一为128+"
```
(若 Step 1 已 0 命中,跳过本 commit)

---

### Task 4: README.en.md 过渡注 + 最终验收

**Files:**
- Modify: `D:\GitHub\godot-mcp-enhanced\README.en.md`(顶部加滞后注)

- [ ] **Step 1: README.en.md 顶部加过渡注**

在 `README.en.md` 的英文标题/介绍之后插入:

```markdown
> **Note:** This English version may lag behind the Chinese `README.md`. The Chinese version is authoritative.
```

- [ ] **Step 2: 9 条验收逐条核对**

对照 `D:\GitHub\godot-mcp-enhanced\docs\superpowers\specs\2026-06-27-readme-repositioning-design.md` 的「验收标准」9 条,逐条在 README.md 中确认:
- [ ] Hero 第一眼可见"免费+开源+全功能"真空地带叙事
- [ ] 对比表点名 ≥3 个真实竞品 + 标注 2026-06-27 日期 + 逐项脚注来源
- [ ] 安全节卖点摘要在前、诚实详情折叠在后,标题用范围表述非"独占"
- [ ] "双模式"表述全部升级为"三层"(含 Game Bridge)
- [ ] 开头不再以"基于 Coding-Solo 二次开发"为主定位
- [ ] CodeBuddy 出现在快速开始并标注验证状态;Hero 与快速开始口径一致(Hero 不列 CodeBuddy)
- [ ] LICENSE 文件被许可证节链接,且含上游 Solomon Elias copyright
- [ ] 全文工具数统一为「128+」(Task 3 已验)
- [ ] Hero 无"唯一"绝对断言

- [ ] **Step 3: GitHub markdown 渲染目视检查**

在 GitHub 上预览 README.md(或用 markdown 预览工具),确认:
- 对比表脚注 `[^p1]` 正确渲染为可点击链接
- 安全节 `<details>` 可折叠
- 截图说明 `<details>` 可折叠
- 三层架构表格、工具表渲染正常

- [ ] **Step 4: Commit**

```bash
git -C "D:/GitHub/godot-mcp-enhanced" add README.en.md
git -C "D:/GitHub/godot-mcp-enhanced" commit -m "docs(readme-en): 加中文版优先过渡注(A2)"
```

---

## Self-Review

**1. Spec coverage:** r2 设计文档的 7 节结构(Hero/对比表/安全/核心能力/工具/快速开始/收尾)+ 9 项 review 修订(C1/I1-I5/A1-A3)均映射到任务:
- C1(LICENSE 双版权)→ Global Constraints 声明已修 + Task 2 节 11 链接 + 验收第 7 条
- I1(工具数)→ Global Constraints + Task 3 专门校验 + 验收第 8 条
- I2(Hero 唯一)→ Task 2 节 1 全量 + 验收第 9 条
- I3(CodeBuddy)→ Task 2 节 1(Hero 不列)+ 节 7(快速开始标注)+ 验收第 6 条
- I4(脚注来源)→ Task 2 节 2 全量含 [^p1-3]
- I5(验收补工具数)→ Task 3 + 验收第 8 条
- A1(安全少见)→ Task 2 节 3
- A2(README.en 过渡)→ Task 4 Step 1
- A3(LICENSE 衔接)→ 验收第 7 条

**2. Placeholder scan:** 无 TBD/TODO。复用节给精确搬迁锚点(现版节标题 + 行号近似)。重写节给全量 markdown。

**3. Type consistency:** 工具数全文统一「128+」(grep 校验);CodeBuddy 口径一致(Hero 不列 / 快速开始标注)。

**待补 spec 要求无遗漏。**

---

## Execution Handoff

Plan complete and saved to `D:\GitHub\godot-mcp-enhanced\docs\superpowers\plans\2026-06-27-readme-repositioning.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 我为每个 task 派一个新 subagent,任务间审查,迭代快
2. **Inline Execution** — 本会话内按 executing-plans 批量执行,带检查点

哪种?(README 重构是文档改动,任务 2 的整体 Write 是主干,Inline 执行更直接;若你想每节独立审查则 Subagent-Driven。)
