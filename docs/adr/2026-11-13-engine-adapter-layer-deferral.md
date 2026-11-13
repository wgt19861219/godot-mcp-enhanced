# ADR: 引擎适配层预留但不切分(单引擎直写 + 软约束保底)

- **状态**:已接受(2026-11-13,竞品综述落地批方案批 D)
- **背景批次**:docs/plans/2026-11-13-竞品综述落地批方案.md(综述建议④「跨引擎成为竞品扩张方向」;附建议① 4.8 预跑记录)
- **决策者**:方案论证 + 本 ADR 固化(纯文档批,零代码改动)

## 背景与决策

2026-11-12 竞品综述指出跨引擎成为竞品扩张方向:BuildersGate 加 Unity 支持、IvanMurzak 双引擎同 train 发布、gua 做 Unity DLL 分发校验——Godot MCP 的差异化窗口在收窄,建议 enhanced「架构上应预留引擎适配层切分」。

本 ADR 决策:**预留,但本期不切分**。不把 src/core 与 src/tools 按「引擎无关层 + Godot 适配层」重构目录;「预留」落地为两件零成本动作——引擎无关清单固化(论证 3)+ 新增文件软约束。切分窗口留给第二引擎立项时,届时按 Blender 先例(论证 1 末行)的对称复制模式起步。

## 论证

### 1. 研究事实(workflow wf_87cd0992-309,2026-11-13,证据均为文件:行号级;批评员抽查 10 项关键声称全部成立)

| 维度 | 事实 | 含义 |
|---|---|---|
| core 引擎无关占比 | src/core 62 文件约 50 个引擎无关(研究快照口径;批 A/B 同日落地新增的 error-codes.ts/uncaught-cleanup.ts 亦引擎无关,现 64 文件) | 重构的可移动面小——core 大盘已是引擎无关支撑层 |
| tools Godot 语义占比 | src/tools 115 文件中 45 个含 Godot 语义(.tscn/GDScript/autoload/ClassDB 等) | 切分要把近四成 tools 归入 Godot 适配层,重组成本全沉没(行为不变的结构搬移,不产出用户可见能力) |
| CR-auth 双份平行 | bridge-client.ts:495-531(secret 读取/权限收紧)/:572-770(CR 握手+降级记忆)与 EditorConnection.ts:523-594(performAuth)结构平行:CR 优先 → 降级记忆 TTL(批4-T2) → REQUIRE_CR_AUTH 硬锁 env → legacy 明文降级 | 「跨通道共享逻辑下沉」类诱惑真实存在,但两份各自演化(TCP vs WebSocket、不同 env 名、不同残余面注释),合一需安全专批——已登记独立任务(core/auth-challenge.ts,M 级),与引擎切分正交 |
| Blender 先例 | 本仓 bpy 支持未走抽象引擎接口,走**对称复制**:core/blender-finder.ts(对称 godot-finder 版本签名校验,C-SEC-2 同型防伪造二进制)+ core/blender-spawn.ts(共享 headless-process 的 runHeadlessCollector)+ core/bpy-sandbox.ts(对齐 scanGdscriptSandbox 的危险 API 静态扫描)+ src/tools/blender.ts 标准 ToolModule 注册(TOOL_META 风险标注,复用 args-validation/path-utils/fs-atomic) | 第二引擎已有一次实作路径验证:「对称复制引擎特定安全件 + 共享通用层 + 标准注册」可行,不需要先建抽象适配层 |

### 2. YAGNI:切分时机未到

- **成本确定**:core+tools 约 180 文件级盘点与搬移,期间与并行开发流冲突(本批 A/B/C 同期落地即是例证)。
- **切口不确定**:第二引擎形态未知。Unity DLL 分发校验(gua 路线)、C# Roslyn in-game 执行(IvanMurzak 路线)、Python bpy headless(本仓 Blender 先例)三者对「引擎适配层」的接口诉求完全不同——现在切,切口做错的概率不低;做错的重构比不重构更贵(要二次迁移)。
- **退出速度已有保底**:core ~81%(50/62)引擎无关 + Blender 先例证明新增引擎的边际路径存在。真到第二引擎立项,「晚切」不会显著抬升切分成本,却避免了空窗期的双重维护。

### 3. 引擎无关清单与软约束(本期唯一落地动作)

**清单**(src/core 中引擎无关的支撑层,第二引擎可直接复用):

logger、guard、audit-log、middleware、tool-registry、tool-circuit-breaker、tool-errors/error-codes、health-monitor、fs-atomic、state-store、path-utils、headless-process、instance-*(instance-manager/instance-router/instance-http-server/instance-api-auth)、EditorConnection(传输段)、bridge-client(TCP 传输段)、uncaught-cleanup 等。

(反例即引擎特定件:godot-finder/godot-spawn/godot-variant/gdscript-scanner 与对称复制的 blender-finder/blender-spawn/bpy-sandbox——它们是「适配」本身,不是支撑层。)

**软约束**(此后新增/重构遵守):

1. 新增 src/core 文件应引擎无关(进程/文件/协议/注册表/错误分类类支撑);确需引擎语义(版本签名、脚本语法、场景格式)时,进 src/tools 或按 blender-* 先例对称复制,**不往 core 塞引擎专有逻辑**。
2. Godot 语义进 tools 或由 adapters 注入——core import 链出现对引擎特定模块的新依赖时,审查应质疑(既有的对称复制件互引除外,如 blender-finder 复用 godot-finder 的 buildSafeEnv 属通用件复用)。

### 4. 重评估触发条件

满足任一可重开本决策:

1. **第二引擎正式立项**(Unity/Unreal 任一进入 roadmap)——届时先按 Blender 先例对称复制起步;若第三引擎出现,再评估抽象适配层是否值得;
2. **@modelcontextprotocol typescript-sdk #3115**(内置 OpenTelemetry)落地且其抽象改变 core 传输/可观测层的组织方式;
3. **CR-auth 双份合一**(core/auth-challenge.ts,已登记独立任务)完成后复查——若 core 内「双份平行」形态继续增殖,升级切分优先级。

## 附:Godot 4.8-dev6 编译验证记录(综述建议①,2026-11-13)

- 主会话预跑:`GODOT_PATH=D:\godot\Godot_v4.8-dev6_win64_console.exe npm run check:gdscript` → **errors=0 warnings=0**(addons 全量编译,4.8-dev6 兼容性先行确认)。
- CI 矩阵(godot-matrix job,现 4.6.3 + 4.7.2 双行)**暂不加 4.8-dev 快照行**:dev 每日构建的 releases/download URL 会失效,无法像 stable 那样 pin 住下载地址;等 4.8-beta/stable(URL 稳定)发布后再进矩阵。综述建议①的「4.8 系列预跑」由本次本地验证 + 本记录承接,不构成 CI 义务缺口。

## 关联

- 竞品综述:`D:\GitHub\_notes\2026-11-12-竞品与头部项目更新综述.md`(第五节建议④/建议①)
- 落地方案:`docs/plans/2026-11-13-竞品综述落地批方案.md`(批 D)
- 格式基准 ADR:`docs/adr/2026-10-26-bridge-runtime-script-execution.md`
- CR-auth 合一登记:落地方案「登记不实施」表(M 级独立任务,安全敏感需专批审查)
