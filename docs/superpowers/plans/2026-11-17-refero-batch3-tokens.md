# Refero 批3「tokens 层」实施计划(v2,按外部计划审查修订)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Theme DesignTokens 真源闭环——proto-geometry 颜色字段接受 `"$name"` token 引用(GD 预取 map 注入,翻译器保持纯函数)+ `token_set`/`token_list`(面向 theme **文件**的写入并落盘/全量审计)。

**Architecture:** ① 解析层独立纯函数:`resolveGeometryTokens(geo, tokens)` 在**翻译前**把 `$` 引用替换为字面量——翻译器 `translateGeometry` 零改动零 token 知识,`ui_import_prototype` 与 `ui_pixel_verify` **双链共用**同一解析(pixel_verify 的采样基准同样需要解析后的颜色);② 预取通道在 handler 侧:仅当 geometry 含 `$` 引用才 spawn 一次 GD 脚本(建议 `loadAutoloads: false`)`load(theme_path)` 导出 DesignTokens colors map——TS 侧**不**解析 .tres 文本;③ `token_set` 是**新的文件级 action**(与 `theme_set_property` 的差异:不经场景节点、自带 ResourceSaver 原子落盘;项语义对齐 `theme_type="DesignTokens"`——非"语法糖"表述,spec N6 组合关系按此改写),`token_list` 读全量(colors+constants 双通道)。

**Tech Stack:** TypeScript(vitest + zod strict)、GDScript 生成脚本。

**Spec:** `D:\GitHub\godot-mcp-series\godot-mcp-enhanced\docs\superpowers\specs\2026-11-16-refero-design-system-design.md`(v2 批3 节 + 约束节 + 决策记录 D7;Task 5 一并落 D8 澄清与 D10)

## Global Constraints

- **向后兼容**:新参数/新键全部可选,默认行为不变;无 `$` 引用时 import/pixel_verify 双链**零额外 spawn、输出逐字节兼容**。`$token` 是 ProtoColor 第四分支(与 `#rrggbb`/`[r,g,b]`/`[r,g,b,a]` 并列),不动既有三格式;`translateGeometry` 签名不变。
- **strict schema + 生成物纪律(H-5)**:新分支/新参数全进 schema;**凡改 schema/description 的任务**(Task 3/4)必须 `npm run build-matrix && npm run gen:tool-docs` 并把 `docs/capability-matrix.json`、`docs/capability-matrix.md`、`docs/tools/` 的全部漂移纳入同一 commit(CI H-5 `git diff --exit-code` 门禁;先 build-matrix 再 check:ssot-params/check:budget——两者读 committed matrix)。
- **action 计数纪律(check-tool-count)**:action 274→276 后须同步 9 处计数面——`README.md`(:7/:142/:144 等 8 条正则 + :240 的 read/write 分解)、`README.en.md`、`manifest.json`(双口径)、`server.json`、`docs/distribution/README.md`、`docs/migration-from-coding-solo.md`、`src/tools/rule-templates.ts`(:24)、`.claude/rules/godot-mcp-core.md`(:10)。
- **版本纪律(N-C 四件套)**:改 `rule-templates.ts` 的任务(Task 4)同批 `npm version minor --no-git-tag-version`(0.36.9→0.37.0;**不带 tag**,npm publish/tag 待用户指令)→ `npm run version-sync`(A 类 6 文件:manifest.json/plugin.cfg/server.json/Dockerfile/docs/使用指南.md/src/scripts/mcp_bridge.gd)→ README 版本表首行 `| **v0.37.0**` → CHANGELOG `## [0.37.0] - 2026-11-17` 定版段;**[Unreleased] 必须保留实质内容(去符号后 >50 字符)**——check-changelog-sync STRICT 对无标识符 commit 的兜底只看 [Unreleased],清空即红;`package-lock.json` 若被 npm version 更新一并 add。
- **lint 纪律**:凡改 `src/`、`test/`、`scripts/` 的任务,commit 前跑 `npm run lint`(CI 首步)。
- **token 解析通道 = GD 预取注入(D7)**:翻译器/解析函数零 Godot 依赖;TS 侧**不**解析 .tres 文本。预取是直接 `load()` 资源读 colors,**不经挂载点、不挂树**——批2 发现的「root 通道挂载被 autoload ThemeManager `_ready` 覆盖」竞态只影响"挂载后从挂载点读回"路径(themeConstEmit),**不影响预取通道,勿绕路**。
- **token 名白名单(P1-6)**:`^[A-Za-z_][A-Za-z0-9_-]*$`,schema `$` 引用分支与 token_set handler 双防线;**原型链防线:map 查键用 `Object.hasOwn`**(`$constructor`/`$__proto__` 可过正则);map 值校验有限数×4;theme_path 过 `sanitizeResPath`;`token_set` 进 actionRisks 标 `write`、`token_list` 标 `read`(ACTIONS `satisfies` 编译期穷尽)。
- **TOKEN_NOT_FOUND 语义**:点名 token 名 + theme 路径;错误码进 `ERROR_CODES`(types.ts);handler 侧 catch 按**消息前缀**分流(`TOKEN_NOT_FOUND` 前缀 → 专属码,不得落进共用 INVALID_PARAMS catch)。
- **GD/TS 双侧清单同步**:`DESIGN_TOKENS_TYPE` 常量单源(types.ts),全部 GD 生成点内插(themeConstEmit/预取/token_set/token_list);GD 侧 Color 不能直接 `JSON.stringify`——一律先转 `[r,g,b,a]` 数组。
- **StyleBoxFlatSpec 引用 token 时仍逐节点 override**(共享去重留批4)。
- **靶子约束**:`D:\workspace\projects\DotaLegendGodot` 真实文件**只读**、靶子仓库**不提交**;验收副本全 `_batch3_*` 前缀、finally 删除;**git 断言 = 与验收前形态一致**(靶子暂存区本有用户未裁决改动——记录验收前 `git status --porcelain` 快照,验收后须完全相同,非"干净"断言;批2 scripts/refero-batch2-acceptance.mjs:305-312 同款);`GODOT_PATH` + 靶子存在性双 gate。
- 注释简体中文;commit 风格 `feat(ui)/chore(ui)/docs(ui): ...`(中文描述)。

## Review Focus

1. **`theme file not found` 含 "not found" 子串**会被 `uiErrorMapper` 首位 `includes('not found') → NODE_NOT_FOUND` 分支截胡 → 新消息分支必须**排在通用 'not found' 之前** → Task 4 单测锚(坏路径 token_set → THEME_NOT_FOUND 而非 NODE_NOT_FOUND)。
2. **`$` 引用流经 pixel_verify**:`collectBgTargets`(pixel-verify.ts:112)直接 `normalizeColor(nd.bg)` → 双链都必须在消费前 resolve;漏了 pixel_verify 会以 SCRIPT_EXEC_FAILED 冒泡 → Task 3 mock+e2e 双锚(pixel_verify 带 `$` + theme_path 走预取解析)。
3. **原型链污染**:`$constructor`/`$__proto__` 过字符集正则后 `map[name]` 命中 `Object.prototype` → `Object.hasOwn` 锚 → Task 2 单测。
4. **无 `$` 流量回归**:import/pixel_verify 零额外 spawn、translateGeometry 逐字节兼容 → Task 3 mock "恰一次调用" + 既有测试全绿双锚。
5. **GD 序列化**:Color 直嵌 `JSON.stringify` 运行时报错 → prefetch/token_list 均先转 `[r,g,b,a]` 循环 → Task 3/4 generator 单测锚。
   (浮点 roundtrip 位级一致——预取导出 float32 值 → 字面量 → GD Color → style_verify 读回 delta 0——Task 3 e2e 硬断言;TOKEN_NOT_FOUND 前缀映射不被 INVALID_PARAMS catch 吞——Task 3 mock 锚。)

---

### Task 1: 门禁基线清偿(budget 校准 + 生成物存量漂移)

**Files:**
- Modify: `scripts/check-token-budget.mjs`(THRESHOLDS + 校准史)
- Regenerate: `docs/tools/` 全部 46 文件(存量漂移,`npm run gen:tool-docs` 产物)

**Interfaces:**
- Consumes: 无。
- Produces: `perToolSchema.error = 13000`(原 12000)、`totalSum.warn = 113 * 1024`(原 112*1024);docs/tools 与 matrix 重新一致(H-5 基线归零);校准史注释。

- [ ] **Step 1: 实测记录当前水位**

Run: `npm run check:budget && npm run gen:tool-docs && git status --porcelain docs/tools | wc -l`
Expected: budget 0 error(ui schema **11992B** / error 线 12000B 余量 8B;总量 114376B / warn 余 312B);gen:tool-docs 后 docs/tools 约 **46 文件**脏(批1/批2 改描述/schema 后从未重生成 docs/tools——solve_from_current、theme_path 挂载语义、viewport 等描述漂移)。

- [ ] **Step 2: 校准两线 + 写校准史**

`THRESHOLDS.perToolSchema.error` 12000→13000;`totalSum.warn` 112*1024→113*1024(=115712B)。校准史注释必含:①现状 8B 余量的构成(批1 solve_from_current 四参数 + viewport 多分句 + theme_path 扩展、批2 挂节后处理——正当增量累积);②裁定"校准不瘦身"——批 A(2026-10-26)已留「结构形状不可砍,继续压伤描述可用性」结论,再压会动 description 断言测试换无结构收益;③批3 预计增量 ~340B,校准后余量 ~670B;④error 线校准史首录;⑤totalSum warn 112→113KiB(批3 后预计 ~114.7KB 越 112 旧线,error 120KiB 硬线不动)。

- [ ] **Step 3: commit 基线(两笔,归因分离)**

```bash
git add docs/tools/
git commit -m "chore(docs): gen:tool-docs 存量漂移清偿——批1/批2 描述变更未重生成 docs/tools(H-5 基线归零)"
git add scripts/check-token-budget.mjs
git commit -m "chore(budget): perToolSchema error 线校准 12000→13000——ui schema 正当增量水位接受(批3 首任务)"
```

Run: `npm run check:budget`
Expected: 0 error。

### Task 2: $token 解析层(纯函数,翻译器不动)

**Files:**
- Modify: `src/tools/ui/prototype-import.ts`(ProtoColor 第四分支 + TokenColorMap + resolveGeometryTokens + hasTokenRefs)
- Modify: `src/tools/ui/types.ts`(ERROR_CODES 增 TOKEN_NOT_FOUND)
- Test: `test/prototype-import.test.ts`(扩展;用该文件自有 fixture/helper 风格)

**Interfaces:**
- Consumes: 现有 `translateGeometry(geo): TranslateResult`(签名**不变**)、`normalizeColor`、ProtoColor(prototype-import.ts:91)。
- Produces(Task 3/4 依赖):
  - `export type TokenColorMap = Readonly<Record<string, [number, number, number, number]>>;`
  - `export function resolveGeometryTokens(geo: PrototypeGeometry, tokens?: { map: TokenColorMap; themePath: string }): PrototypeGeometry`——返回 `$` 引用全部替换为字面量 `[r,g,b,a]` 的新 geometry(浅拷贝节点,不动输入);`tokens` 缺省且无 `$` 引用 → 返回语义等价 geometry(回归锚);有 `$` 引用而 `tokens` 缺省 → 抛 `INVALID_PARAMS: $token 引用需要提供 theme_path(DesignTokens 约定路径 res://ui/theme.tres)`;缺键 → 抛 `TOKEN_NOT_FOUND: token "x" 不存在于 <themePath> 的 DesignTokens(现有: 前 10 键)`;查键用 **`Object.hasOwn`**,命中后校验值**长度 4 且四元有限数**,非法值抛 INVALID_PARAMS(点名 token 与值形状);
  - `export function hasTokenRefs(geo: PrototypeGeometry): boolean`——任一节点 `color/bg/fill/border.color` 为 `$` 前缀字符串;
  - `ERROR_CODES.TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND'`(types.ts);
  - ProtoColor 第四分支:`z.string().regex(/^\$[A-Za-z_][A-Za-z0-9_-]*$/)`。

- [ ] **Step 1: 失败单测**——新增 describe(批3 $token 解析层):
  - schema:`bg: '$brand'` parseGeometry 放行;`'$1a'`/`'$a b'`/`'$'` 拒绝;`'brand'`(无 $ 非 hex)仍拒;
  - 解析:`resolveGeometryTokens` 后 `bg` 为 `[0.1,0.2,0.3,0.5]` 字面量,再 `translateGeometry` 得 stylebox `bg_color` 同值;四字段(color/fill/border.color/bg)同通道各一例;
  - 缺键 → TOKEN_NOT_FOUND(含 token 名、theme 路径、现有键列表);无 tokens + `$` → INVALID_PARAMS(含 theme_path);
  - **原型链**:`$constructor`/`$__proto__` 在 map 缺键路径上报 TOKEN_NOT_FOUND(不命中 Object.prototype);
  - **坏值**:map 值 `[0.5, NaN, 0.5, 1]` 或长度 3 → INVALID_PARAMS;
  - `hasTokenRefs` 真/假;无 `$` + 无 tokens → 返回 geometry 与输入语义等价(字段全等断言)。

- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/prototype-import.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——第四分支、types.ts 错误码、`resolveGeometryTokens`(内部 helper `resolveTokenColor` 集中四字段遍历与防线)、`hasTokenRefs`。错误消息全中文。

- [ ] **Step 4: 通过 + lint + commit**

Run: `npx vitest run test/prototype-import.test.ts && npx tsc --noEmit && npm run lint`

```bash
git add src/tools/ui/prototype-import.ts src/tools/ui/types.ts test/prototype-import.test.ts
git commit -m "feat(ui): $token 解析层 resolveGeometryTokens——纯函数+原型链防线(批3)"
```

### Task 3: GD 预取通道 + import/pixel_verify 双链接线

**Files:**
- Create: `src/tools/ui/ui-tokens.ts`(genTokenPrefetchScript;token 生成器独立文件,与 ui-theme/ui-measure 分工一致)
- Modify: `src/tools/ui/types.ts`(DESIGN_TOKENS_TYPE)
- Modify: `src/tools/ui/ui-measure.ts`(themeConstEmit 两处 "DesignTokens" 字面量换 `${DESIGN_TOKENS_TYPE}` 内插——生成产物逐字节不变)
- Modify: `src/tools/ui/index.ts`(双 handler 接线 + TOKEN_NOT_FOUND 前缀分流 + tokens_resolved + description 两处扩写)
- Test: `test/ui-generators.test.ts`(扩展)+ `test/ui-import-prototype.test.ts`(扩展)+ 新建 `test/ui-token-e2e.test.ts`(skipIf 无 GODOT_PATH)

**Interfaces:**
- Consumes: Task 2 全部导出;`executeGdscriptTrusted`/`parseGdscriptResult`/`uiErrorMapper`。
- Produces:
  - `export const DESIGN_TOKENS_TYPE = 'DesignTokens';`(types.ts;头注释登记同步点:themeConstEmit/预取/token_set/token_list 全部 GD 生成点共用,扩名须全点同步);
  - `export function genTokenPrefetchScript(themePath: string): string`(ui-tokens.ts)——SCENE_TREE_HEADER、**无场景加载**:`load(themePath)` → null/非 Theme → `_mcp_output("error", "theme_path load failed: <path>")`(该消息不含 "not found",不撞 mapper 首位分支);`get_color_list(DESIGN_TOKENS_TYPE)` 遍历,**Color 先转 `[r,g,b,a]` 数组再入 dict**;`_mcp_output("token_map", JSON.stringify({"colors": _colors}))`;路径 `escapeForGdLiteral`;
  - index.ts 共享辅助(两 handler 调用,形如 `resolveTokensForGeometry(geo, themePathRaw, projectPath, godot)` → 成功返回 `{ geo, tokensInfo: { theme_path, refs, tokens: string[] } }`,失败返回错误 ToolResult):sanitize 上移 → `hasTokenRefs` 为 false 直接透传(零 spawn);true 而 theme_path 缺 → INVALID_PARAMS;有 → prefetch spawn(**`loadAutoloads: false`**——脚本只 load 资源,不跑 autoload,省启动;timeout 30)→ `uiErrorMapper` 解析(增 `includes('load failed')` → THEME_NOT_FOUND)→ 从 `out.data.token_map.colors` 取 map → `resolveGeometryTokens`;
  - handleUiImportPrototype:parse 后调辅助;**translate/resolve 的既有 catch 按消息前缀分流**(`TOKEN_NOT_FOUND` 前缀 → `opsErrorResult(ERROR_CODES.TOKEN_NOT_FOUND, msg)`,其余保持 INVALID_PARAMS 透传);成功响应 data 增 `tokens_resolved?: { theme_path: string; refs: number; tokens: string[] }`(预取发生才挂;refs = geometry 内 `$` 引用次数,tokens = 去重后已解析 token 名——与主题总 token 数解耦,可审计);
  - handleUiPixelVerify:parse 后调同一辅助,`runPixelVerify` 收解析后 geometry(采样基准 = 解析色);resolution 抛错同样前缀分流(现状无 try 兜底会冒成 SCRIPT_EXEC_FAILED——修正);
  - schema description 扩写:`geometry` 补「颜色字段(bg/color/fill/border.color)可 `"$name"` 引用 theme DesignTokens token(须配 theme_path;import/pixel_verify 均支持;有引用时多一次 Godot 预取 spawn)」;`theme_path` 四语义并列(ui_set_theme save/load 必填;measure/import 主题挂载;import/pixel_verify 的 $token 解析源;后接 Task 4 的 token_set/list)。

- [ ] **Step 1: 失败单测(generator)**——`genTokenPrefetchScript('res://themes/t.tres')`:含 `load(...)`、`get_color_list`、`"DesignTokens"`、`token_map` 输出键、`theme_path load failed` 错误分支;`DESIGN_TOKENS_TYPE === 'DesignTokens'` 同步锚。
- [ ] **Step 2: 失败单测(handler mock,注意既有 beforeEach 会 mockReset——用 `mockResolvedValueOnce` 链排预取→build 两段)**——
  - import 带 `bg: '$brand'` + theme_path:第一次调用 code 含 `get_color_list` 且返回 token_map;第二次 build/measure;最终成功、bg_color 正确、data 含 `tokens_resolved`;
  - **无 `$` 引用 → 恰一次调用**(Review Focus 4);
  - `$` 无 theme_path → INVALID_PARAMS 含 theme_path;
  - 预取 map 缺键 → **错误码 TOKEN_NOT_FOUND**(非 INVALID_PARAMS——前缀分流锚);
  - 预取 error 返回 → THEME_NOT_FOUND;
  - **pixel_verify 带 `$` + theme_path**:mock 预取段 + capture 段,`collectBgTargets` 收到解析后字面量 bg(Review Focus 2);`$` 无 theme_path → INVALID_PARAMS(非 SCRIPT_EXEC_FAILED)。
- [ ] **Step 3: 跑测失败**

Run: `npx vitest run test/ui-generators.test.ts test/ui-import-prototype.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**——按 Interfaces(types.ts → ui-tokens.ts → ui-measure.ts 内插替换(跑既有 ui-measure-theme 测试确认产物不变)→ index.ts 双 handler + description)。
- [ ] **Step 5: 通过 + 生成物 + 门禁 + commit**

Run: `npx vitest run test/ui-generators.test.ts test/ui-import-prototype.test.ts test/ui-measure-theme.test.ts test/prototype-import.test.ts && npx tsc --noEmit && npm run lint && npm run build-matrix && npm run gen:tool-docs && npm run check:ssot-params && npm run check:budget`
Expected: 全绿

```bash
git add src/tools/ui/ui-tokens.ts src/tools/ui/types.ts src/tools/ui/ui-measure.ts src/tools/ui/index.ts test/ui-generators.test.ts test/ui-import-prototype.test.ts docs/capability-matrix.json docs/capability-matrix.md docs/tools/
git commit -m "feat(ui): GD 预取 token map 注入 import/pixel_verify 双链——翻译器纯函数保持(批3)"
```

- [ ] **Step 6: e2e(test/ui-token-e2e.test.ts,skipIf 无 GODOT_PATH;fixture 项目构造仿 test/ui-measure-theme.test.ts:212 模式——project.godot + 场景 + themes/tokens.tres,但本批 fixture 写 **colors**:`DesignTokens/colors/brand = Color(0.5, 0.25, 0.75, 1)` float32 精确值)**
  - `ui_import_prototype`(Panel `bg: '$brand'` + theme_path)→ 成功;`style_verify` 该节点 bg 槽分量 delta = 0(roundtrip 位级硬断言);`tokens_resolved.tokens` 含 `brand`;
  - theme 无 DesignTokens type(裸 Theme)→ TOKEN_NOT_FOUND 点名 `brand` 与路径;
  - theme 文件不存在 → THEME_NOT_FOUND;
  - `ui_pixel_verify` 同 geometry(scene_path 指向 import 产物)→ 预取解析后采样链正常返回(不冒 SCRIPT_EXEC_FAILED;headless 下 capture 不可用则断言错误码非 SCRIPT_EXEC_FAILED 的解析层错误——以实际可用通道为准记录)。

Run: `npx vitest run test/ui-token-e2e.test.ts`
Expected: PASS(有 GODOT_PATH 时)

```bash
git add test/ui-token-e2e.test.ts
git commit -m "test(ui): $token 双链 e2e——float32 roundtrip 位级一致锚(批3)"
```

### Task 4: token_set/token_list + 全部随动面同步(计数/文档/规则/版本)

**Files:**
- Modify: `src/tools/ui/types.ts`(ACTIONS +2)
- Modify: `src/tools/ui/ui-tokens.ts`(genTokenSetScript + genTokenListScript)
- Modify: `src/tools/ui/index.ts`(schema token_name/token_value + action 描述 + 两 case + actionRisks + **uiErrorMapper 顺序修正**)
- Modify: `test/ui-tools.test.js`(**两处 `toBe(14)` → `toBe(16)`**)
- Modify: 计数 9 文件:`README.md`(8 正则位 + :240 read/write 分解 132/116→133/117)、`README.en.md`、`manifest.json`、`server.json`、`docs/distribution/README.md`、`docs/migration-from-coding-solo.md`、`src/tools/rule-templates.ts`、`.claude/rules/godot-mcp-core.md`
- Modify: 规则双副本 `src/tools/rule-templates.ts` + `.claude/rules/godot-mcp-ui.md`(工具清单表 +2 行 +「DesignTokens token 层」小节)
- Modify: `package.json` 等 A 类 6 文件 + `README.md` 版本行 + `CHANGELOG.md` + `package-lock.json`(版本收口)
- Regenerate: `docs/capability-matrix.{json,md}` + `docs/tools/`
- Test: `test/ui-generators.test.ts` + `test/ui-import-prototype.test.ts` + `test/ui-token-e2e.test.ts`(扩展)

**Interfaces:**
- Consumes: `DESIGN_TOKENS_TYPE`;ui-theme.ts 原子落盘段模式(ui-theme.ts:49-74);Task 2/3 导出。
- Produces:
  - ACTIONS 增 `'token_set'`, `'token_list'`;actionRisks `token_set: 'write'`, `token_list: 'read'`;
  - `export function genTokenSetScript(themePath: string, name: string, value: number | number[]): string`(ui-tokens.ts)——load → 缺失 → `_mcp_output("error", "theme file not found: <path>(先 theme_create(scene_path+save_path) 或 ui_set_theme create+save 建主题)")`;array → `set_color(name, DESIGN_TOKENS_TYPE, Color(...))`,number → `set_constant`;原子落盘(tmp+rename);`_mcp_output("token_set", {...})`;
  - `export function genTokenListScript(themePath: string): string`——同款错误分支;colors+constants 双通道,**Color 先转 `[r,g,b,a]`**;`_mcp_output("token_list", JSON.stringify({"colors": ..., "constants": ...}))`;
  - schema:`token_name`(string,description 含白名单)、`token_value`(color `[r,g,b](,[a])` 0-1 或数字常量);action 描述补 `token_set/list=设计 token`;
  - handler(公共执行段,设 `script` 后 break):token_set 必填 theme_path(sanitizeResPath)/token_name(白名单,拒 INVALID_PARAMS)/token_value(array 3-4 元有限数 → color;有限 number → constant;否则 INVALID_PARAMS);token_list 必填 theme_path;
  - **uiErrorMapper 顺序修正**:`includes('theme file not found')` → THEME_NOT_FOUND 的分支**插在通用 `includes('not found')` 之前**(Review Focus 1)。

- [ ] **Step 1: 失败单测**——
  - generator:token_set(color/number 两形态)含 `set_color`/`set_constant`、`Color(`、`ResourceSaver.save`、rename、`theme file not found`;token_list 含 `get_color_list`+`get_constant_list`+`token_list` 键 + Color→数组转换;
  - handler 拒绝路径(校验在 spawn 前,mock 零调用):缺 theme_path/token_name/token_value、`token_name: '1abc'`/`'a b'`、`token_value: 'red'` → INVALID_PARAMS;
  - 契约:ACTIONS 含两新值;actionRisks read/write;schema 声明两新参数;
  - **mapper 顺序**:错误消息 `theme file not found: x` 经 uiErrorMapper → THEME_NOT_FOUND(非 NODE_NOT_FOUND);
  - e2e 扩展(test/ui-token-e2e.test.ts):token_set(color `[0.5,0.25,0.75,1]` + constant `8`)→ token_list 精确读回(逐值 `===`);同名覆盖 → 再 list 验证;theme 缺失 → THEME_NOT_FOUND;裸 Theme → 空 `{colors:{}, constants:{}}` 不报错。
- [ ] **Step 2: 跑测失败**

Run: `npx vitest run test/ui-generators.test.ts test/ui-import-prototype.test.ts test/ui-tools.test.js test/ui-token-e2e.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——types.ts ACTIONS → ui-tokens.ts 两 generator → index.ts(schema/handler/actionRisks/mapper)→ `test/ui-tools.test.js` 两处 14→16。
- [ ] **Step 4: 随动面同步**——①计数 9 文件(274→276,README:240 分解同步);②规则双副本:工具清单表 +2 行 +「DesignTokens token 层」小节(真源约定/`$name` 引用语法与 theme_path 四语义/预取成本提示(多一次 spawn)/token_set 落盘与建主题前置/token_list 审计);③ui 顶层 description 的 `${NON_PERSIST}` 尾注补例外括注(theme_create(save_path)/token_set 直接落盘资源文件);④版本收口:`npm version minor --no-git-tag-version` → `npm run version-sync` → README 版本行 → CHANGELOG(`## [0.37.0] - 2026-11-17` 定版段汇总批3;**[Unreleased] 保留实质内容**——含批1 遗留 docs 条目与批3 验收预告,去符号后 >50 字符)。
- [ ] **Step 5: 全门禁 + commit**

Run: `npx vitest run test/ui-generators.test.ts test/ui-import-prototype.test.ts test/ui-tools.test.js test/ui-token-e2e.test.ts && npx tsc --noEmit && npm run lint && npm run build-matrix && npm run gen:tool-docs && npm run check:ssot-params && npm run check:budget && npm run check:tool-count && STRICT=1 npm run check:rules-sync && npm run version-check && STRICT=1 npm run check:changelog-sync`
Expected: 全绿

```bash
git add src/tools/ui/types.ts src/tools/ui/ui-tokens.ts src/tools/ui/index.ts test/ui-tools.test.js README.md README.en.md manifest.json server.json docs/distribution/README.md docs/migration-from-coding-solo.md src/tools/rule-templates.ts .claude/rules/godot-mcp-core.md .claude/rules/godot-mcp-ui.md package.json package-lock.json plugin.cfg Dockerfile docs/使用指南.md src/scripts/mcp_bridge.gd CHANGELOG.md docs/capability-matrix.json docs/capability-matrix.md docs/tools/ test/ui-generators.test.ts test/ui-import-prototype.test.ts test/ui-token-e2e.test.ts
git commit -m "feat(ui): token_set/token_list 文件级 action+全随动面同步(计数/文档/规则/版本 0.37.0,批3)"
```

(A 类版本文件以 `npm run version-sync` 实际改动为准 add;`git status` 收尾核对零遗漏。)

### Task 5: 靶子验收 + spec 维护(D8 澄清 + D10)

**Files:**
- Create: `docs/superpowers/plans/2026-11-17-refero-batch3-acceptance.md` + `docs/superpowers/plans/refero-batch3-acceptance/` 快照(目录命名沿批1/批2)
- Create: `scripts/refero-batch3-acceptance.mjs`(批2 骨架)
- Modify: spec `docs/superpowers/specs/2026-11-16-refero-design-system-design.md`

**Interfaces:**
- Consumes: Task 3/4 全部工具(handleTool 直调;GODOT_PATH + 靶子双 gate + ALLOWED_PROJECT_PATHS 进程内追加)。
- Produces: 靶子 token 链真实数字存档 + spec D8/D10。

- [ ] **Step 1: spec 维护**——①D8 补字段级纪律(先读 `src/tools/ui/quality-check.ts` 实况再写):节级省略(整节无发现不挂);已挂节的必检字段空数组照挂(`equidistant: []`——区分"检测了无发现"与"未检测");条件性检测字段(spacing_scale/visual_groups)未触发时省略;②**新增 D10**:theme_path 无默认值——`$token` 引用必须显式传 theme_path(spec 批3 节第 3 条「默认 res://ui/theme.tres」收紧为**约定提示语**而非隐式默认,显式优于隐式),批3 节第 3 条同步改写;③批3 节 N6 组合关系表述修正(token_set 是文件级新 action,非 node.theme 语法糖)。
- [ ] **Step 2: 靶子验收驱动脚本**——批2 骨架(双 gate、`_batch3_*` 前缀、finally 清理):**验收前记录 `git -C 靶子 status --porcelain` 快照,验收后断言完全一致**(预存 dirty 是用户未裁决改动,非"干净"断言):
  1. **空档**:副本 theme(`res://resources/themes/_batch3_tokens.tres` = default_theme.tres 逐字节复制)→ `token_list` → 空 `{colors:{}, constants:{}}`(靶子主题无 DesignTokens,诚实空);
  2. **写入+审计+完整性**:token_set ×3(两色 + 一常量,float32 安全值)→ token_list 逐值 `===` 读回;**主题完整性断言**——token_set 前后 `get_type_list()` 与既有代表项(原主题任一既有 color/constant)读数一致(ResourceSaver 对 1845 行真 .tres 的 load+save 未破坏既有内容;compareBaseline 思路,批2 :36-37 先例);
  3. **import 链**:副本场景(`res://scenes/ui/_batch3_import_copy.tscn` = daily_login_content.tscn 复制)+ 小 geometry(`$` 引用副本 theme token)+ theme_path → `ui_import_prototype` → `style_verify` 分量 delta 0 + `tokens_resolved` 数字;
  4. 快照 ×3 落 `docs/superpowers/plans/refero-batch3-acceptance/`;数字誊进验收记录 md。
- [ ] **Step 3: 全量回归 + commit**

Run: `npx vitest run`
Expected: 0 failed

```bash
git add docs/superpowers/plans/2026-11-17-refero-batch3-acceptance.md docs/superpowers/plans/refero-batch3-acceptance/ scripts/refero-batch3-acceptance.mjs docs/superpowers/specs/2026-11-16-refero-design-system-design.md
git commit -m "docs(ui): 批3 靶子 token 链验收记录+spec D8/D10 维护(批3)"
```

### Task 6: 审查文档落档(AGENTS 段 8 强制项)

**Files:**
- Create: `docs/reviews/2026-11-17-refero-batch3.md`

**Interfaces:**
- Consumes: 本批 SDD 全程(任务审查/fix round/整支终审结论——由 orchestrator 在终审后携带汇总派发)。
- Produces: 独立审查文档(AGENTS.md:314-322 要求:每条 spec→plan→实现→验证链路完成后必出)。

- [ ] **Step 1: 落档**——按仓库审查文档惯例(docs/reviews/ 既有格式):审查范围(分支/commit 区间)、维度结论(正确性/契约/测试/门禁/文档)、发现与处置(Critical/Important/Minor 分级,含 fix round 记录)、Ready to merge 判定。**头部声明历史债**:refero 批1/批2 的 SDD 终审当时有做(会话内)但未按 AGENTS 落 docs/reviews/ 文档,属流程债——本条不回补旧档,以本文件为该系列审查文档的起点。
- [ ] **Step 2: commit**

```bash
git add docs/reviews/2026-11-17-refero-batch3.md
git commit -m "docs(review): refero 批3 独立审查文档落档(AGENTS 段 8;批1/批2 缺档声明为历史债)"
```
