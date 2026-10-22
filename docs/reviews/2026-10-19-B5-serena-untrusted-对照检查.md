# B5:serena untrusted 清单对照安全检查报告

> **日期**:2026-10-19
> **性质**:只读检查,本批不改代码(方案 `D:\GitHub\_notes\2026-10-19-五条建议落地方案.md` B5)
> **对照对象**:serena v2 信任体系(untrusted 项目 activation_command 忽略 / symlink+跨盘逃逸拒绝 / tsserver 钉托管版 / untrusted ≠ 沙箱诚实边界)
> **检查方式**:grep + Read 实测,行号为 2026-10-19 快照

## 总判定

**1 项阻塞级发现(发现-1:项目级 godot_path 覆盖面缺 override 语义),其余三项对照无新漏洞。**

## 检查项 1:项目级配置加载面清单(grep 实测)

项目内文件能影响 server 行为的全部入口:

| 项目内文件/目录 | 影响面 | 信任边界评估 |
|---|---|---|
| `.godot/mcp-godot.json` `godot_path` | **Godot 二进制选择**(`src/core/godot-finder.ts:242-256` tryProjectOverride A) | 🔴 **发现-1** |
| `project.godot` `[godot_mcp]` `godot_path` | 同上(B,`godot-finder.ts:258-275`) | 🔴 **发现-1**(同链) |
| `.godot-version` | 版本 spec → 仅在 `~/.godots/versions/` 前缀匹配解析(`godot-finder.ts:301-339`),**不含项目内任意路径** | ✅ 不放大 |
| `project.godot` 其余段 | autoload 名解析(沙箱白名单辅助,`sandbox-scanner.ts:144-171`)、features 版本比对 warn(`godot-finder.ts:583-600`)、orphan autoload 修复(`sandbox-scanner.ts:204-218`) | ✅ 无行为覆盖 |
| `.godot/mcp_editor.key` | editor 对称 secret(`editor-auth.ts:73-123`) | ✅ 对称密钥,项目本就是被操作方 |
| `addons/godot_mcp_server/` + `mcp_bridge.gd` | Godot 进程内(editor/游戏)代码 | ✅ 用户显式运行后的信任域,非 server 侧新面 |
| (对照)`buildSafeEnv` | spawn env 白名单(`godot-finder.ts:548-576`),仅透传 `GODOT_MCP_BRIDGE_*`/`GODOT_MCP_EDITOR_*` 前缀 | ✅ 项目配置不可注入 env |

结论:**唯一需要信任边界裁量的就是 godot_path 覆盖链**(发现-1)。

## 检查项 2:路径解析对照 serena(normpath+realpath+commonpath)

`src/core/path-utils.ts`:

- **deny-by-default** ✅:`isPathInAllowedRoots`(`path-utils.ts:270-318`),未配置 ALLOWED_PROJECT_PATHS 时限 cwd(C-07)。
- **junction/symlink 双侧 realpath** ✅:requestedPath 与 allowlist 条目都过 `safeRealPath + normalize` 再前缀匹配(`path-utils.ts:290-316`,C-1/C-SEC-1 注释详述 junction 绕过防线);`resolveWithinRoot`(`path-utils.ts:156-206`)含 UNC 拒/设备名拒/迭代解码/段级 `..` 拒/realpath+relative 兜底。
- **Windows 跨盘**:匹配用 `startsWith(ensureSep(root))` 含分隔符边界(`path-utils.ts:255-257,316`)——跨盘路径字符串前缀天然不匹配 → 拒,语义等价 serena "commonpath 抛 ValueError 视为逃逸" ✅。
- **TOCTOU 窗口**:已声明(`path-utils.ts:288-289` I-3 注释:"本地单用户信任场景的安全边界,非多用户/不可信输入硬隔离")✅。
- ⚠️ 低风险标注(非漏洞,留观):大小写归一依赖 `realpathSync` 的系统行为,未见显式 toLowerCase;双侧同过 realpathSync 由文件系统统一,未发现绕过实例。serena 同样依赖 normpath 的大小写保留语义,无差距。

## 检查项 3:Godot 二进制解析链(发现-1,阻塞级)

### 现状链路(实测)

`findGodot(projectPath)`(`godot-finder.ts:391-484`)优先级:

1. 缓存(仍过白名单)
2. **项目级 override**(`tryProjectOverride`)← **最高,先于 env**
3. `GODOT_PATH` env(origin 校验失败显性报错,B-7③)
4. `~/.godot-mcp/godot-paths.json` / PATH / registry / scoop / 平台搜索

项目级候选校验:`validateGodotBinary(candidate)`(`godot-finder.ts:251,269`)——**单参调用,origin 默认 `'auto'`**。

### 威胁链(与 M-2 已认定模型同构)

`isGodotPathAllowed` 的 origin 语义(`godot-finder.ts:112-133`,2026-10-13 M-2 加固):

- `origin='override'`(工具参数 godot_path,AI 可控面)→ 白名单未配置时 **fail-closed**;
- `origin='auto'`(env/自动发现)→ 白名单未配置时 back-compat **放行**(签名校验兜底)。

**项目级配置文件同样是 AI 可控写盘面**(write_script/edit_script 在白名单项目内即可写 `.godot/mcp-godot.json`),M-2 注释自认签名可伪造("伪造成本从打印 4.6 提高到伪造形如 Godot 版本签名的输出……无法防御会完整伪造 --version 输出的攻击者")。完整链:

1. AI(或恶意 repo 作者)在项目内写 `.godot/mcp-godot.json` `{"godot_path": "<项目内>/fake.exe"}` + 一个打印 `4.6.3.stable.official...` 的可执行文件;
2. 用户已把该项目加入 `ALLOWED_PROJECT_PATHS`(操作前提,本来就要加)、未配置 `GODOT_MCP_ALLOWED_GODOT_PATHS`(默认态);
3. 任一 headless 工具调用 → `findGodot(projectPath)` → 项目 override 命中(优先级高于用户 env)→ `validateGodotBinary` origin='auto' 放行(签名伪造过)→ **spawn 恶意 exe = 任意代码执行**。

### 与 serena 对照

serena:tsserver 钉死托管版,**untrusted 项目不加载项目内工具链**;本仓库相反——项目级覆盖优先级最高(项目文件 > 用户显式 GODOT_PATH env),且未纳入 override fail-closed。

### 缓解与触发前提

- 缓解在位:配置了 `GODOT_MCP_ALLOWED_GODOT_PATHS` 或 `~/.godot-mcp/godot-paths.json`(CLI install 登记)即拦;`GODOT_MCP_UNRESTRICTED=true` 全放行(用户自担)。
- 触发前提:项目在白名单内 + godot 白名单未配置 + 项目内可写。恶意 repo 分发 + 用户加白开发是现实场景(AI 辅助开发的开箱默认态即无 godot 白名单)。

### 修复建议(单开小批)

1. `tryProjectOverride` 的 A/B 候选(mcp-godot.json / project.godot 的绝对路径)改调 `validateGodotBinaryDetailed(candidate, 'override')`——与工具参数面同语义 fail-closed;C(.godot-version → ~/.godots)不含项目内路径,保持 auto。
2. 顺手评估优先级:项目 override 是否应降到 GODOT_PATH env 之后(用户显式 env 意图 > 项目文件),或至少在项目 override 命中时 warn 留痕。

## 检查项 4:诚实边界声明对照

AGENTS.md「安全体系」段已声明"防误操作层,不是不可绕过的安全边界"——覆盖 GDScript 沙箱语义。发现-1 属**声明之外的攻击面识别**(spawn 前置的二进制选择链),修复前应在该段补一句项目级 godot_path 面的提示(或随修复批一并落)。

## 出口动作

- 本报告:`docs/reviews/2026-10-19-B5-serena-untrusted-对照检查.md`
- 发现-1 达插件反馈门槛(安全/数据风险)→ 应登 `D:\workspace\Obsidian\GodotMCP\插件反馈与改进建议.md`(bridge/headless 分区,状态 🔴 open)+ `D:\workspace\Obsidian\GodotMCP\项目待办.md`(小修单开批)。**注:本会话 obsidian MCP 工具不可用,条目文案见附录,待工具可用时补录。**
- 修复批建议命名:`fix/project-godot-path-override-origin`。

## 附录:待补录 Obsidian 反馈条目文案

> - **发现日期**:2026-10-19 | **场景**:godot-mcp-enhanced 自查(B5 serena 对照) | **现象**:项目级 `.godot/mcp-godot.json`/`project.godot [godot_mcp]` 的 godot_path 走 origin='auto' 校验(白名单未配置放行),且优先级高于 GODOT_PATH env;与 2026-10-13 M-2 已收紧的工具参数面(override fail-closed)威胁模型同构(项目内可写 + 签名可伪造 → spawn 任意 exe) | **建议**:tryProjectOverride A/B 候选改 origin='override';评估项目 override 优先级降至 env 之后 | **状态**:🔴 open(报告 `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\reviews\2026-10-19-B5-serena-untrusted-对照检查.md`)
