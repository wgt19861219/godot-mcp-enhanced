# B4:typed outputs 试点报告

> **日期**:2026-10-19
> **方案**:`D:\GitHub\_notes\2026-10-19-五条建议落地方案.md` B4
> **结论**:试点完成,SHIPPED——3 个现代消费点结构化 + 2 个工具带 outputSchema;token 增量 1350B(实测)在预算内;建议全量迁移按"单形态 JSON 工具先行,多 action 工具只做输出侧"分批推进。

## 一、落地形态与方案偏差(重要)

**方案原定试点**:find_ui_elements、monitor_poll、watch_poll。
**偏差原因**:这三者是 `game` 工具的 **action**,而 outputSchema 是 MCP 协议的**工具级**字段(tools/list 的 Tool 对象)——给多 action 的 game 工具声明 outputSchema 等于宣称所有 action 共用一个返回结构,是撒谎式声明。
**落地调整**(忠实于方案意图:机器消费型工具优先):

| 试点点 | 形态 | outputSchema | 说明 |
|---|---|---|---|
| `godot_get_context` | 完整试点 | ✅(750B) | 单形态 JSON 独立工具,声明+双通道+wire 测试 |
| `godot_list_instances` | 完整试点 | ✅(600B) | 同上 |
| `game` action ×3(find_ui_elements / monitor_poll / watch_poll) | 输出侧增强 | ❌(不声明) | 只挂 structuredContent(content 文本零变化);工具级 schema 对多 action 工具不可行 |

## 二、实现

1. `src/types.ts`:新增 `structuredResult(obj, text?)`——双通道(content 保留 JSON 文本 + structuredContent 挂同一对象;默认 text = JSON.stringify(obj, null, 2),与 github-mcp-server modern era 的 "text == JSON(structuredContent)" 约定一致)。
2. `src/tools/get-context.ts` / `src/tools/instance-tools.ts`:定义加 outputSchema(手写 JSON Schema,从实际返回提炼,含字段级降级的 nullable 语义);handler 成功路径改 `structuredResult(...)`(get-context 异常降级路径保持 textResult,不承诺结构化)。
3. `src/tools/game-bridge.ts` `bridgeAction`:3 个试点 method 的对象型成功响应挂 structuredContent;其余 method 零变化。
4. `src/capability/extract.ts`:schemaBytes 口径修正——outputSchema 同样进 tools/list 载荷,计入统计(原口径漏报增量)。

## 三、token 增量实测

- outputSchema 净增量:**1350B**(godot_get_context 750 + godot_list_instances 600,`Buffer.byteLength(JSON.stringify(outputSchema))` 实测)。
- tools/list 总量:115174B → **116524B**(含口径修正后的 outputSchema);warn 线 116KB(118782B,B1 批校准),余量 2258B;`check:budget` 0 error 通过。
- 每 token 收益:modern 客户端对声明工具免文本 parse + 可 schema 校验;1350B ≈ 338 tokens,对 46 工具总载荷 ~0.4KB/工具,可接受。

## 四、wire 测试结果

`test/b4-typed-outputs-wire.test.ts`(真实 SDK Server + InMemoryTransport + 手写 JSON-RPC 握手,照 qa-tasks-wire 先例),3 用例全绿:

1. **广告侧**:tools/list 中 godot_get_context / godot_list_instances 定义携带 outputSchema(required: [data, success])。
2. **结果侧**:call godot_get_context → structuredContent 存在,过声明 schema 的关键字段(status/mode/failedFields/toolGroups/rules 形态),且 `JSON.parse(content text)` deepEqual structuredContent(双通道等值)。
3. **legacy 回归**:2025-06-18 协议版本连接下 call → content 文本仍可解析出同结构(旧客户端零回归)。

game action 输出侧增强由 `test/game-bridge.test.ts` mock 断言覆盖(find_ui_elements/monitor_poll/watch_poll 的 structuredContent 与文本等值;非试点 method 不挂)。

## 五、全量迁移策略建议(以试点数据为准)

1. **优先迁**:单形态 JSON 独立工具——`godot_get_context`(已迁)、`godot_list_instances`(已迁)、`help`、`godot_list_dynamic_routes`、`audit`(get_log 形态稳定)、`profiler`(snapshot)。这些工具级 schema 可如实声明,是 outputSchema 的正射目标。
2. **只做输出侧**:多 action 复合工具(game/scene/script/validation/qa/analysis/docs……)——handler 返回处改 structuredResult 即可,不动声明。按高频消费 action 分批(MCP 响应 parse 是 agent 侧真实成本,输出侧无 token 代价,收益/风险比极高)。
3. **不迁**:纯文本/自由格式返回(markdown 文档类、错误提示类)。
4. **节奏**:每批 ≤5 工具/≤10 action,`check:budget` 余量监控(warn 线余量 <1KB 时收紧 schema 字段);每批带 wire 断言(广告/双通道/legacy 三件套,照本试点测试模式)。
5. **SDK 侧观察**:TS SDK Skills/typed-tools 相关演进未进 stable,当前手写 schema + structuredResult 双通道不依赖 SDK codec,后续 SDK 提供工具时可平移。

## 六、验证记录

- `npm run lint`:0 errors,533 warnings(上限内)
- `npm run build`:零错误
- `npm test`:7288+ passed(新增 wire 3 + game 输出侧 1 + extract 口径 1 用例)
- `npm run build-matrix` + `diff-matrix`:no drift(46 工具)
- `npm run check:budget`:0 error(116524B < 118782B warn 线)
