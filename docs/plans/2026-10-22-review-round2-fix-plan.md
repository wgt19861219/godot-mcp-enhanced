# 2026-10-22 审查第二轮修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `docs/reviews/2026-10-22-全维度项目审查-第二轮.md` 确认的全部缺陷（2 项 Critical/Blocking + 6 项 High + 9 项 Medium + 29 项 Low），按 P0→P1→P2→P3 四批落地，每批独立可验证、可合并。

**Architecture:** 全部为存量代码缺陷修复，不引入新子系统。P0 批（发布阻断）：动态工具 action 级风险解析（嵌套 actions 映射）、Dockerfile 启动配置、截图陈旧文件、断言结构化协议、install 非交互退出码。P1 批：frame_sequence 受信通道、文档生成门禁、snippet 词法安全重命名、autoload 入树、POSIX SIGKILL、close 幂等、集成测试串行化。P2/P3 为局部修复清单。

**Tech Stack:** TypeScript(ES2022/strict/ESM) + GDScript(Godot 4.5-4.7) + Vitest 4 + ESLint + GitHub Actions。

**Spec:** `docs/reviews/2026-10-22-全维度项目审查-第二轮.md`（已独立复核验证，24 项抽查断言无一失实，验证记录见 memory `review-verification-2026-10-22-round2`）。

## Global Constraints

- **完成前强制检查**：每批结束前依次跑 `npm run lint`（≤533 warnings，src/ 零 error）→ `npm run build`（零错误）→ `npm test`（全绿），全绿才允许 commit/合并。
- **分支规范**：master 不开 commit。每批开独立分支：`fix/2026-10-22-review2-p0`、`-p1`、`-p2`、`-p3`。
- **默认不发版**：批次合并不 bump 版本、不走版本链（例外：若改动 `src/tools/rule-templates.ts` 或 `.claude/rules/`，本计划无此改动；若执行中意外涉及，按 AGENTS.md「独立副本同步约束」处理）。
- **双副本同步**：`src/core/dynamic-risk-map.ts` 与 `scripts/check-command-docs-drift.mjs` 的 `METHOD_TO_TOOL` 是独立副本，Task 1 必须两处同改，contract 测试同步。
- **改动 `addons/**/*.gd` 后必须跑** `npm run check:gdscript`（需 `GODOT_PATH`，统一入口 `D:\godot\godot.cmd` 指向 v4.7.2）。本计划仅 Task 9 改 GD 模板字符串（在 TS 内），不改 `.gd` 文件本体。
- **本机环境陷阱**：当前 shell 残留 `GODOT_MCP_ALLOW_UNSAFE_CONFIRM` 环境变量。任何启动行为验证必须用 `env -u GODOT_MCP_ALLOW_UNSAFE_CONFIRM -u GODOT_MCP_UNRESTRICTED node build/index.js` 排除干扰（2026-10-22 验证时实测踩到）。
- **每批落地后**：出第三方审查文档到 `docs/reviews/`、登 memory（feature-decision-log + engineering-lesson）。P0 批落地后回写审查报告关联。

---

## 批次总览与依赖

| 批次 | 任务 | 来源缺陷 | 可并行 |
|---|---|---|---|
| P0（Task 1-5） | 发布阻断 | C-1 / B-1 / H-1 / H-3 / H-4 | 五任务相互独立 |
| P1（Task 6-12） | 本迭代 | H-2 / H-5 / H-6 / M-1 / M-2 / M-3 / M-7 | Task 12 改测试基建，最后做 |
| P2（Task 13-18） | 下迭代 | M-4 / M-5 / M-6 / M-8 / M-9 + Low 安全组 L-15/16/17/18/21/23 | 独立 |
| P3（清单） | Low 清理 | L-1~L-14、L-19/20/22/24/25/26/27/28/29 | 独立 |

---

# Batch 1（P0：发布阻断）

## Task 1: C-1 动态工具按真实 action 解析风险（嵌套 actions 映射 + fail-closed）

**Files:**
- Modify: `src/core/dynamic-risk-map.ts`（全文件重构映射结构）
- Modify: `src/core/ToolDispatcher.ts:397-401`（confirm 门）、`:455`、`:651-655`、`:964-968`（审计路径）
- Modify: `scripts/check-command-docs-drift.mjs:28`（METHOD_TO_TOOL 独立副本）+ `:287` 附近用法
- Test: `test/core/dynamic-risk-map.test.ts`（现有 64 行 contract 测试）、`test/core/ToolDispatcher.test.ts`（现有 2404 行，`:712` 起有 requires_confirmation 断言模式可套用）
- 注：`test/core/dynamic-risk-map.test.ts` 注释里写的路径 `test/dynamic-risk-map.test.ts` 已过时，以实际路径为准。

**Interfaces:**
- Produces: `resolveDynamicTool(toolName: string, actualAction?: string): { tool: string; action: string } | undefined`——第二参可选；返回 `undefined` = fail-closed（调用方要求确认）。

- [ ] **Step 1: 写失败测试（contract 层）**

在 `test/core/dynamic-risk-map.test.ts` 追加：

```ts
describe('C-1 真实 action 解析（2026-10-22 审查第二轮）', () => {
  it('animation_keyframe + remove → remove_keyframe（destructive）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'remove'))
      .toEqual({ tool: 'animation_track', action: 'remove_keyframe' });
  });
  it('animation_keyframe + update → update_keyframe（destructive）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'update'))
      .toEqual({ tool: 'animation_track', action: 'update_keyframe' });
  });
  it('animation_track + remove → remove_track（destructive）', () => {
    expect(resolveDynamicTool('animation_track', 'remove'))
      .toEqual({ tool: 'animation_track', action: 'remove_track' });
  });
  it('已登记 method + 未登记 action → undefined（fail-closed）', () => {
    expect(resolveDynamicTool('animation_keyframe', 'evil_action')).toBeUndefined();
  });
  it('无内部 action 的 method 不受 actualAction 影响', () => {
    expect(resolveDynamicTool('engine_call_method', 'whatever'))
      .toEqual({ tool: 'engine', action: 'call_method' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/dynamic-risk-map.test.ts`
Expected: 新增用例 FAIL（现签名只收一个参数，`resolveDynamicTool('animation_keyframe', 'remove')` 返回默认 `add_keyframe` 映射而非 undefined/报错）。

- [ ] **Step 3: 重构映射结构**

`src/core/dynamic-risk-map.ts`——`METHOD_TO_TOOL` 值类型改为：

```ts
/** 动态 method → 静态工具映射。actions 仅在 method 含内部 action 参数（GD 短名）时登记。 */
export interface DynamicToolMapping {
  readonly tool: string;
  /** 默认静态 action（无 actions 表，或 actualAction 未传时使用） */
  readonly action: string;
  /** GD 内部短 action → 静态全名 action。有此表的 method：actualAction 不在表中 = fail-closed。 */
  readonly actions?: Readonly<Record<string, string>>;
}
```

仅三处条目加 `actions`（其余 44 条原样不动；GD 端 action 取值见 `addons/godot_mcp_server/commands/animation_commands.gd:19`（add/remove）与 `:32`（add/remove/update））：

```ts
  // ─── animation_commands:split(3 个→animation_track,1 个→animation) ────
  // C-1(2026-10-22 审查):animation_track/animation_keyframe 的 GD method 含内部短 action
  // 参数(add/remove/update),风险必须按真实 action 解析;actions 表缺该 action → fail-closed。
  animation_track:    { tool: 'animation_track', action: 'add_track', actions: { add: 'add_track', remove: 'remove_track' } },
  animation_keyframe: { tool: 'animation_track', action: 'add_keyframe', actions: { add: 'add_keyframe', remove: 'remove_keyframe', update: 'update_keyframe' } },
  animation_curve:    { tool: 'animation_track', action: 'set_curve' },
```

`resolveDynamicTool` 改为：

```ts
export function resolveDynamicTool(toolName: string, actualAction?: string): { tool: string; action: string } | undefined {
  const m = METHOD_TO_TOOL[toolName];
  if (!m) return undefined;
  if (m.actions) {
    if (actualAction === undefined) return { tool: m.tool, action: m.action };
    const mapped = m.actions[actualAction];
    return mapped !== undefined ? { tool: m.tool, action: mapped } : undefined; // fail-closed
  }
  return { tool: m.tool, action: m.action };
}
```

- [ ] **Step 4: ToolDispatcher confirm 门接真实 action（`:397-401`）**

```ts
      const legacyMap = tryLegacyMapping(name);
      // C-1(2026-10-22 审查):含内部 action 参数的动态 method 按真实 args.action 解析静态风险;
      // actions 表查不到该 action → resolveDynamicTool 返 undefined → 下方 fail-closed 要求确认。
      const actualAction = typeof args.action === 'string' ? args.action : undefined;
      const dynMap = isDynamicToolName(name) ? resolveDynamicTool(name, actualAction) : undefined;
      const guardName = legacyMap?.tool ?? dynMap?.tool ?? name;
      const guardArgs = (legacyMap ?? dynMap) ? { ...args, action: legacyMap?.action ?? dynMap?.action } : args;
      const confirmRequired = (isDynamicToolName(name) && !dynMap) || requiresConfirmation(guardName, guardArgs);
```

同步审计路径（同一文件 `:455`、`:651-655`、`:964-968`）：凡 `resolveDynamicTool(ctx.toolName / pending.toolName)` 处补第二参 `typeof ctx.toolArgs?.action === 'string' ? ctx.toolArgs.action : undefined`（按现场变量名适配，审计风险计算与 confirm 门必须同一口径）。

- [ ] **Step 5: 同步 mjs 独立副本与 contract 测试**

`scripts/check-command-docs-drift.mjs:28` 的 `METHOD_TO_TOOL` 加同款 `actions` 三条（结构与 TS 侧逐字一致）；`:287` 附近消费处（`const mapping = METHOD_TO_TOOL[method]`）确认只读 `mapping.tool`/`mapping.action`，默认 action 语义不变则无需改。`test/core/dynamic-risk-map.test.ts` 现有「TS 表 vs mjs 表逐条比对」用例若因结构断言失败，同步其断言形状（加 `actions` 字段比对）。

- [ ] **Step 6: dispatcher 级回归测试**

在 `test/core/ToolDispatcher.test.ts` 的 requires_confirmation describe（`:712` 模式）追加，mock 环境复用该文件现有 beforeEach 设施：

```ts
    it('C-1: 动态 animation_keyframe{action:"remove"} 必须要求确认令牌', async () => {
      registerDynamicTools(['animation_keyframe']);
      const result = await dispatcher.executeToolCall('animation_keyframe', {
        node_path: 'Player', animation_name: 'a', track_index: 0, action: 'remove', keyframe_index: 0,
      });
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.requires_confirmation).toBe(true);
    });

    it('C-1: 动态 animation_keyframe{action:"add"}（read）不要求确认', async () => {
      registerDynamicTools(['animation_keyframe']);
      const result = await dispatcher.executeToolCall('animation_keyframe', {
        node_path: 'Player', animation_name: 'a', track_index: 0, action: 'add', time: 0.5,
      });
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.requires_confirmation).toBeUndefined();
    });
```

（`registerDynamicTools` 从 `../../src/core/tool-registry.js` import；若现有用例的 dispatcher 构造方式不同，适配构造、断言不变。）

- [ ] **Step 7: 全量验证 + 提交**

Run: `npx vitest run test/core/dynamic-risk-map.test.ts test/core/ToolDispatcher.test.ts` → 全 PASS；再跑 Global Constraints 三连。
```bash
git checkout -b fix/2026-10-22-review2-p0
git add src/core/dynamic-risk-map.ts src/core/ToolDispatcher.ts scripts/check-command-docs-drift.mjs test/core/
git commit -m "fix(security): C-1 动态工具按真实 action 解析确认风险,actions 表缺项 fail-closed"
```

## Task 2: B-1 Dockerfile 启动配置 + CI smoke

**Files:**
- Modify: `Dockerfile:11-13`
- Modify: `.github/workflows/ci.yml`（新增 `docker-smoke` job，与现有 `check`/`godot-matrix`/`macos-smoke` 平级）

- [ ] **Step 1: 删除触发 FATAL 的 ENV**

`Dockerfile` 第 11-13 行替换为：

```dockerfile
# Glama check 只发 initialize/tools/list,不调工具,无需任何安全旁路 env。
# B-1(2026-10-22 审查):曾设 GODOT_MCP_UNRESTRICTED=true,与 index.ts runStartupSequence
# 的生产模式 FATAL 检查冲突,容器启动即 exit 1。已删除。
```

- [ ] **Step 2: 本地验证启动行为（不经 Docker，验证同一启动路径）**

Run: `env -u GODOT_MCP_ALLOW_UNSAFE_CONFIRM -u GODOT_MCP_UNRESTRICTED timeout 3 node build/index.js < /dev/null 2>&1 | head -3; echo EXIT=$?`
Expected: 打印 `[user-settings] ...` / `[security] ALLOWED_PROJECT_PATHS is not set ...` 后正常挂起到 timeout（EXIT=124）。基线已验证（2026-10-22），删 ENV 后应一致。

- [ ] **Step 3: CI 加 docker-smoke job**

`.github/workflows/ci.yml` 顶层 jobs 追加（与现有 job 同缩进；actions 版本tag与文件现状保持一致，SHA 固定属 L-28 不混批）：

```yaml
  docker-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        run: docker build -f Dockerfile -t godot-mcp-smoke .
      - name: stdio initialize handshake
        run: |
          printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}\n' \
            | docker run -i --rm godot-mcp-smoke | grep -q '"serverInfo"'
```

- [ ] **Step 4: 提交**

```bash
git add Dockerfile .github/workflows/ci.yml
git commit -m "fix(ci): B-1 删除 Dockerfile 生产模式危险 env,补 docker stdio smoke 门禁"
```

## Task 3: H-1 截图运行前删除旧文件

**Files:**
- Modify: `src/screenshot.ts`（captureScreenshot，`runScreenshot` 首次调用前；`import { existsSync, statSync }` 行补 `unlinkSync`）
- Test: `test/screenshot-core.test.js`（现有 mock 模式）

- [ ] **Step 1: 写失败测试**

在 `test/screenshot-core.test.js` 追加（复用该文件现有 captureScreenshot mock 设施；若其 mock 的是 Godot 子进程，则让本次调用失败）：

```js
it('H-1: Godot 失败且存在旧截图文件时必须返回失败并删除旧文件', async () => {
  const outputPath = join(tmpProjDir, 'screenshot.png');
  writeFileSync(outputPath, Buffer.from('stale-png-bytes'));
  // mock 本次 Godot 运行失败(退出码非 0 且不产出文件)——按现有文件的 mock 手法适配
  const result = await captureScreenshot({ godotPath: fakeGodot, projectPath: tmpProjDir, outputPath });
  expect(result.success).toBe(false);
  expect(existsSync(outputPath)).toBe(false); // 旧文件不得存活充当假证据
});
```

- [ ] **Step 2: 确认失败**：`npx vitest run test/screenshot-core.test.js` → 新用例 FAIL（现实现 `existsSync` 命中旧文件返回 success:true）。

- [ ] **Step 3: 实现**

`src/screenshot.ts` captureScreenshot 中、`--- Attempt 1 ---` 注释前插入：

```ts
  // H-1(2026-10-22 审查):运行前删除旧输出,防 Godot 失败/超时时 existsSync 命中上次
  // 陈旧文件返回假成功。重试分支无需再删——仅在 !existsSync 时进入,天然无旧文件。
  try { unlinkSync(outputPath); } catch { /* ENOENT: 首次截图无旧文件 */ }
```

- [ ] **Step 4: 验证 + 提交**

Run: `npx vitest run test/screenshot-core.test.js test/screenshot-2d.test.ts test/screenshot-detail.test.ts` → 全 PASS。
```bash
git add src/screenshot.ts test/screenshot-core.test.js
git commit -m "fix(verify): H-1 截图前删除旧输出文件,堵陈旧截图假成功"
```

## Task 4: H-3 断言结构化协议（assert_protocol_pass 字段 + 强制产出）

**Files:**
- Modify: `src/tools/shared/assertions.ts:26-39`（wrapper 生成代码）
- Modify: `src/tools/workflow.ts:666-670`（判定）
- Modify: `src/tools/delivery.ts:461-466`（判定，与 workflow 同款）
- Test: `test/workflow-acceptance.test.js` + 新增 `test/shared/assertions-protocol.test.ts`

**Interfaces:**
- Produces: `resolveAssertionPass(outputs: Array<{key: string; value: unknown}>, expect?: string): boolean`（放 `src/tools/shared/assertions.ts` 导出，workflow/delivery 共用）。wrapper 生成的 GDScript 新增输出 key `assert_protocol_pass`，值为字符串 `"true"`/`"false"`。

- [ ] **Step 1: 写失败测试（判定函数 + wrapper 文本）**

新增 `test/shared/assertions-protocol.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { wrapAssertionCode, resolveAssertionPass } from '../../src/tools/shared/assertions.js';

describe('H-3 断言协议（2026-10-22 审查第二轮）', () => {
  it('wrapper 生成结构化 assert_protocol_pass 两分支', () => {
    const code = wrapAssertionCode('pass', 'd', true);
    expect(code).toContain('_mcp_output("assert_protocol_pass", "true")');
    expect(code).toContain('_mcp_output("assert_protocol_pass", "false")');
  });
  it('无 expect:协议字段缺失 → fail（空代码/忘输出必假红）', () => {
    expect(resolveAssertionPass([{ key: 'assert_result', value: 'anything' }])).toBe(false);
    expect(resolveAssertionPass([])).toBe(false);
  });
  it('无 expect:assert_result 非空且非 "false" → pass', () => {
    expect(resolveAssertionPass([{ key: 'assert_result', value: 'ok' }])).toBe(true);
  });
  it('无 expect:assert_result 为字符串 "false" → fail（修语义错误）', () => {
    expect(resolveAssertionPass([{ key: 'assert_result', value: 'false' }])).toBe(false);
  });
  it('有 expect:协议 pass 且 actual==expect → pass', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'true' },
      { key: 'assert_result', value: '42' },
    ], '42')).toBe(true);
  });
  it('有 expect:协议 pass 但 actual!=expect → fail', () => {
    expect(resolveAssertionPass([
      { key: 'assert_protocol_pass', value: 'true' },
      { key: 'assert_result', value: '43' },
    ], '42')).toBe(false);
  });
});
```

- [ ] **Step 2: 确认失败**：`npx vitest run test/shared/assertions-protocol.test.ts` → FAIL（resolveAssertionPass 未定义）。

- [ ] **Step 3: 实现 assertions.ts**

(a) `:26-27` passCond 修正 "false" 语义；`:28-39` assertGenCode 两分支各加一行 `_mcp_output`：

```ts
  const escapedExpected = expected != null ? escapeForGdLiteral(expected) : '';
  // H-3: 未给 expected 时 "false" 字符串视为失败证据(原 != "" 语义错误);结构化协议字段供 TS 判定。
  const passCond = expected != null ? `if _ar == "${escapedExpected}":` : 'if _ar != "" and _ar != "false":';
  const assertGenCode = [
    '\tvar _ar: String = ""',
    '\tfor _e in _mcp_outputs:',
    '\t\tvar _entry: Dictionary = _e',
    '\t\tif String(_entry["key"]) == "assert_result":',
    '\t\t\t_ar = String(_entry["value"])',
    '\t\t\tbreak',
    `\t${passCond}`,
    '\t\t_mcp_output("assert_protocol_pass", "true")',
    '\t\tprint("ASSERT PASS: " + _desc)',
    '\telse:',
    '\t\t_mcp_output("assert_protocol_pass", "false")',
    '\t\tprint("ASSERT FAIL: " + _desc)',
  ].join('\n') + '\n';
```

(b) 同文件追加导出判定函数：

```ts
/** H-3: acceptance 断言唯一判定口径——协议字段必须存在且为 "true";expect 匹配由 wrapper 内嵌,TS 侧只读协议结论。 */
export function resolveAssertionPass(
  outputs: Array<{ key: string; value: unknown }>,
  _expect?: string,
): boolean {
  const protocol = outputs.find(e => e.key === 'assert_protocol_pass');
  if (!protocol || String(protocol.value) !== 'true') return false;
  return true;
}
```

（`_mcp_output(key, value)` helper 已存在于 `src/core/shared/gdscript-templates.ts:73`，值经 `str()` 存储，读回即字符串 `"true"`/`"false"`。）

- [ ] **Step 4: workflow.ts / delivery.ts 判定切换**

`src/tools/workflow.ts:666-670` 的 else 分支改为：

```ts
              } else {
                const actual = String(assertResult.outputs.find(e => e.key.startsWith('assert_') || e.key === 'assert_result')?.value ?? '');
                // H-3: 判定唯一依据结构化协议字段;旧协议/空代码/忘输出 assert_result 一律 fail
                const passed = resolveAssertionPass(assertResult.outputs, a.expect);
                assertionResults.push({ description: desc, passed, actual, expected: a.expect });
              }
```

`src/tools/delivery.ts:461-466` else 分支做同款替换（`expected`/`actual` 字段保留供报告诊断；import 补 `resolveAssertionPass`）。delivery 的 ASSERT stdout 聚合（visual_proof 维度）不受影响——print 文本保留。

- [ ] **Step 5: 适配现有集成用例 + 提交**

Run: `npx vitest run test/shared/assertions-protocol.test.ts test/workflow-acceptance.test.js test/workflow.test.js`；`test/e2e-full-tool-verification.test.ts` 若有 acceptance 断言用例一并跑。现有「会输出 assert_result 的用例」应继续通过；若有用例断言旧行为（无 expect 必过），按新语义修正该用例并在其注释标注 H-3。

```bash
git add src/tools/shared/assertions.ts src/tools/workflow.ts src/tools/delivery.ts test/
git commit -m "fix(verify): H-3 断言协议结构化,空代码/假证据字符串必假红"
```

## Task 5: H-4 install 非交互退出码 + --yes

**Files:**
- Modify: `src/cli/godot-installer.ts:259-263`（runInstall）
- Test: 新增 `test/cli/install-noninteractive.test.ts`（或并入现有 cli 测试目录就近文件）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';

describe('H-4 install 非交互退出码（2026-10-22 审查第二轮）', () => {
  it('非 TTY 且无 --yes:exit 2 且不发起下载', async () => {
    vi.resetModules();
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(false);
    const installGodot = vi.fn();
    vi.doMock('../../src/cli/godot-installer-internal.js', () => ({ installGodot })); // 按实际导出模块名适配
    const { runInstall } = await import('../../src/cli/godot-installer.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runInstall([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(installGodot).not.toHaveBeenCalled();
  });
});
```

（若 `installGodot` 与 `runInstall` 同文件无法 doMock，则改为：把 confirm 决策提为可测纯函数 `shouldProceedInstall(isTTY: boolean, assumeYes: boolean): 'proceed' | 'confirm' | 'reject'` 导出并单测之，`runInstall` 内消费——二选一，以能落单测为准。）

- [ ] **Step 2: 确认失败**：`npx vitest run test/cli/install-noninteractive.test.ts` → FAIL。

- [ ] **Step 3: 实现（对齐 `src/cli/uninstall.ts:144-147` 先例）**

`runInstall` 开头改为：

```ts
export async function runInstall(args: string[]): Promise<void> {
  const versionTag = args.find(a => !a.startsWith('--'));
  const assumeYes = args.includes('--yes');   // H-4:对齐 uninstall 非交互约定
  console.log('📥 Godot 自动安装(官方 GitHub releases,SHA512 同源校验)\n');
  if (!assumeYes && !process.stdin.isTTY) {
    console.error('✗ 非交互环境(管道/CI)拒绝默认确认。重跑加 --yes:');
    console.error('  执行: npx godot-mcp-enhanced install --yes [-- <versionTag>]');
    process.exit(2);
    return;
  }
  const { confirmYesNo } = await import('./confirm.js');
  const confirm = () => (assumeYes ? Promise.resolve(true) : confirmYesNo('确认下载并安装?'));
  const { godotPath, versionTag: tag } = await installGodot({
    versionTag,
    confirm,
    onProgress: (msg) => console.log(`  ${msg}`),
  });
  // ……以下原样保留
```

`src/index.ts:286` 的 `/cancelled by user/ → exitCode 0` 路径保留（TTY 主动取消非错误）；非交互路径已不会走到该分支。

- [ ] **Step 4: 验证 + 提交**

Run: `npx vitest run test/cli/`；手工冒烟：`echo | npx godot-mcp-enhanced install; echo EXIT=$?`（项目 bin 链到 build，需先 `npm run build`）→ EXIT=2。
```bash
git add src/cli/godot-installer.ts test/cli/
git commit -m "fix(cli): H-4 install 非交互无 --yes 退出码 2,补 --yes 旗标"
```

---

# Batch 2（P1：本迭代）

## Task 6: H-2 frame_sequence 走受信通道 + 路径转义 + acceptance 纳入帧错误

**Files:** `src/tools/workflow.ts:472-498`（copyScript 与 acceptance 汇总）、`src/tools/frame-verify/proof-bundle.ts`（不变）、Test 就近 workflow 测试。

1. `:482` 的 `executeGdscript` → `executeGdscriptTrusted`（`src/gdscript-executor.ts:127` 已导出；正当性：copyScript 全部由服务端拼接，仅 `run.dir`（服务端 mkdirSync 产物）+ 定值 frameName + `user://mcp_frame_N.png` 参与，无用户输入）。import 处补 `executeGdscriptTrusted`。
2. copyScript 生成前转义：`const gdRunDir = run.dir.replace(/\\/g, '/').replace(/"/g, '\\"');`，模板中 `"${gdRunDir}/${frameName}"`（修 Windows 反斜杠非法转义）。
3. acceptance 汇总（`:679-682`）纳入帧错误；且 frame_sequence 有 error 而断言列表为空时也要落 `result.acceptance`：

```ts
          const frameSeqError = (result.frame_sequence as { error?: string } | undefined)?.error;
          result.acceptance = {
            passed: assertionResults.every(r => r.passed) && !frameSeqError,   // H-2: 帧捕获失败即 acceptance 失败
            results: assertionResults,
            ...(frameSeqError ? { frame_sequence_error: frameSeqError } : {}),
          };
```

（该汇总移出 `if (assertionList.length > 0)` 块，改为「有 acceptance 对象即汇总」；assertionList 为空时 `assertionResults` 为空数组。注意保留 `:505` 超 20 条早退路径。）
4. 测试：(a) 单测 copyScript 含正斜杠路径与转义引号（对生成脚本做字符串断言或 mock `executeGdscriptTrusted` 捕获入参）；(b) mock `sendToBridge('take_screenshot')` 返回 error → `acceptance.passed === false` 且 `frame_sequence_error` 存在。
5. 验证：`npx vitest run test/workflow.test.js test/workflow-acceptance.test.js` + 三连门禁。commit：`fix(verify): H-2 frame_sequence 受信通道+路径转义,帧错误纳入 acceptance`。

## Task 7: H-5 文档再生成 + 漂移门禁 + 计数修正

**Files:** `docs/tools/**`（生成物）、`docs/capability-matrix.{json,md}`（生成物）、`src/tools/manage-tools.ts:65,119`、`README.md:240`、`README.en.md:5,165`、`src/instructions.md:3`、`.github/workflows/ci.yml`（check job 加 step）。

1. 重生成：`npm run build-matrix && npm run gen:tool-docs` → 46 篇页脚 v0.33.8→0.35.0（生成物不手改，跑命令）。
2. `manage-tools.ts:65` 与 `:119`：「全量 45 工具×action」→「全量工具×action」（措辞去数字，防再漂移）。
3. `README.md:240`：`read 134+write 112` → `read 133+write 113`（实测 matrix 聚合 133/113/10/16，2026-10-22 验证）。
4. `README.en.md:5`：`240+ actions` → `272 actions`。
5. `README.en.md:165` 附近段落：legacy 工具名 `edit_script`/`write_script`/`validate_scripts` 改为合并工具表述（`script` 工具 + action；`validate_scripts` 注明 legacy 映射；「触发完整编译」描述改为指向 `npm run check:gdscript`）。
6. `src/instructions.md:3`：删 ` / docs/capability-matrix.md` 引用，保留 `manage_tools`（npm files 不含 matrix，不扩 files 防包体积增长）。
7. CI 门禁（ci.yml `check` job 内、build 步骤后）：

```yaml
      - name: Generated docs drift gate (H-5)
        run: |
          npm run build-matrix
          npm run gen:tool-docs
          git diff --exit-code docs/capability-matrix.json docs/capability-matrix.md docs/tools
```

8. 验证：门禁本地预跑 `npm run build-matrix && npm run gen:tool-docs && git diff --exit-code docs/` → 无 diff；`node scripts/check-tool-count.mjs` → 46/272。commit：`docs: H-5 工具文档再生成至 0.35.0,补生成物漂移 CI 门禁`。

## Task 8: H-6 snippet root 重命名词法安全化

**Files:** `src/gdscript-executor.ts:406-429`（wrapSnippet）；测试就近 gdscript-executor 测试文件。

1. 两层修复：(a) `declaresRoot` 守卫——declarationLines 无 `var root` 声明时整段跳过重命名（修主害：`get_node("/root/Main")`、字符串/注释不再被误改）；(b) 有声明时替换仅作用于非字符串字面量、非注释段：

```ts
const STRING_SPLIT = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
/** H-6: 仅对字符串字面量之外、# 注释之前的代码段做 token 替换。 */
function renameOutsideLiterals(line: string, pattern: RegExp, reserved: string): string {
  // 找引号外首个 # 作为注释起点,注释段整段保留
  let inStr: string | null = null;
  let commentIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') { commentIdx = i; break; }
  }
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : '';
  const renamed = codePart.split(STRING_SPLIT)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(pattern, `_mcp_user_${reserved}`)))
    .join('');
  return renamed + commentPart;
}
```

2. `:413-429` 循环改：先 `const declaresReserved = declarationLines.some(l => new RegExp(`^(var\\s+)${reserved}\\b`).test(l));`，`if (!declaresReserved) continue;`；随后 declarationLines 的 Step2 替换与 statementLines 的替换均改走 `renameOutsideLiterals`（Step1 声明行重命名维持原 `declPattern` 整行替换——声明行自身是代码非字面量）。
3. 测试三例：`wrapSnippet('print("root")')` 不含 `_mcp_user_root`；`wrapSnippet('get_node("/root/Main")')` 保留原文；`wrapSnippet('var root = 1\nprint(root)')` 标识符被改写且字符串若同现则字符串保留。
4. 验证：就近测试文件 + `npx vitest run test/core/gdscript-executor*.test.*`（按实际文件名）+ 三连。commit：`fix(core): H-6 snippet root 重命名跳过字符串与注释,无声明零替换`。

## Task 9: M-1 autoload 实例入树

**Files:** `src/gdscript-executor.ts:1096-1099`（createAutoloadLoaderScript）。

1. `var instance` 行后插入 `'\tadd_child(instance)',`（loader `MCPLoader` 本身在树中，add_child 后 `instance.get_tree()` 可用），保持 `has_method("_initialize")` 判定在其后；`:509` 附近注释「runs as Node child in loader scene」自此成真，无需改。
2. 验证：需真 Godot——`GODOT_PATH=D:/godot/godot.cmd npm run check:gdscript`（模板改动经 build 进 fixture 编译）；再跑就近 autoload 相关集成测试；三连门禁。commit：`fix(core): M-1 autoload snippet 实例 add_child 入树,get_tree 可用`。

## Task 10: M-2 POSIX 超时升级 SIGKILL

**Files:** `src/core/process-state.ts`（forceKillTree `:25-26`、killProcess `:80-92` 附近）。

1. `forceKillTree(proc, opts: { ignoreKilled?: boolean } = {})`，首行 `if (proc.killed && !opts.ignoreKilled) return;`。
2. `killProcess` 的 5s 兜底 timer 改调 `forceKillTree(proc, { ignoreKilled: true })`（POSIX 分支因此落到 `proc.kill('SIGKILL')` 升级；Windows 二次 taskkill 幂等无害）。
3. 测试：就近 process-state 测试加——mock proc `{ killed: true, pid: 123, kill: vi.fn() }`（非 Windows 分支）断言 `ignoreKilled:true` 时仍调用 `process.kill`/`proc.kill('SIGKILL')`（按现场实现 mock 系统调用）。
4. commit：`fix(core): M-2 超时兜底强杀不再被 killed 标志短路,SIGKILL 升级可达`。

## Task 11: M-3 close() 实例级幂等

**Files:** `src/GodotServer.ts:861`（close）、`:698` 附近（onSelfRestart）。

1. 类字段 `private _closePromise: Promise<void> | undefined;`；`close()` 改为入口复用：`if (this._closePromise) return this._closePromise; this._closePromise = this._closeInternal(); return this._closePromise;`，原函数体挪入 `private async _closeInternal()`（局部 `serverClosed` 标志保留在内部）。
2. `onSelfRestart` 路径核查：close() 已含 transport 关闭链，确认重启序列为 `await close()` 后才 `process.exit(0)`；若 stdio transport 关闭晚于清理链，把 transport close 提为清理链第一步（读 `:698` 现场后落位，原则：停止收新请求先于进程级清理）。
3. 测试：连续两次 `await server.close()` 并发（`Promise.all([s.close(), s.close()])`）断言不抛且清理步骤（mock 各 manager）仅执行一次。
4. commit：`fix(core): M-3 GodotServer.close 实例级幂等,并发/重入复用同一 Promise`。

## Task 12: M-7 真 Godot 集成测试串行化（vitest workspace 拆分）

**Files:** 新增 `vitest.workspace.ts`、修改 `vitest.config.ts`（保留为 unit project 配置载体或收编）、`package.json` scripts。

1. `vitest.workspace.ts`：

```ts
import { defineWorkspace } from 'vitest/config';

const COMMON = {
  globals: true,
  globalSetup: ['test/global-setup.ts'] as string[],
  setupFiles: ['test/setup.js'] as string[],
  testTimeout: 10_000,
};

export default defineWorkspace([
  {
    test: {
      ...COMMON,
      name: 'unit',
      include: ['test/**/*.test.{js,ts}'],
      exclude: ['test/integration/**', 'test/tools/*integration*.test.ts', 'test/e2e-full-tool-verification.test.ts'],
    },
  },
  {
    test: {
      ...COMMON,
      name: 'godot-integration',
      include: ['test/integration/**', 'test/tools/*integration*.test.ts'],
      fileParallelism: false,   // M-7: 真 Godot 共享可变 fixture,必须文件级串行
    },
  },
]);
```

2. `package.json`：`"test": "vitest run"`（workspace 存在时自动聚合两个 project）；补 `"test:unit": "vitest run --project unit"`、`"test:integration": "vitest run --project godot-integration"`。原 `test:integration` script 若已存在则改指向新 project。
3. 覆盖率：`test:coverage` 脚本按现状保留；若 workspace 下聚合异常，在各 project 的 test 内共享根 coverage 配置（从 vitest.config.ts 的 coverage 块迁移到 workspace 根 project），阈值不变。
4. e2e smoke（`test/e2e-full-tool-verification.test.ts`）归 unit project（现状全量跑即含它；若其依赖真 Godot 且不稳定，移入 godot-integration——以两轮全量跑全绿为准）。
5. 验证：`npm test` 两轮全绿（2026-10-22 基线：全量 7296 passed/0 failed/95 skipped，69s；拆分后 integration 串行预计 +1-2min）；`npm run test:coverage` 阈值达标。commit：`test: M-7 真 Godot 集成测试 workspace 串行化,消除共享 fixture 并行冲突`。

---

# Batch 3（P2：下迭代）任务卡

## Task 13: M-4 project_replace dry-run 零副作用
`src/tools/script/project-replace.ts:36-62` 残留清理块整体移入 `if (!dryRun)` 写入路径（Phase 2 前执行）；同时清理后缀改 `['.bak', '.tmp']`（写入实际产生 `.tmp`:156 与 `.bak`:162，`.mcp-tmp` 是从未产生过的命名空间，注释 `:36` 一并修正）。测试：dry-run 调用后预置的 `save.gd.bak` 仍存在。commit：`fix(tools): M-4 project_replace dry-run 零删除,残留清理对齐真实临时后缀`。

## Task 14: M-5 setup/uninstall 失败退出码
`src/cli/setup.ts:82` catch 处累计 `failed++`，函数尾 `if (failed > 0) process.exitCode = 1`；「No new clients to configure」输出区分 `configured===0 && failed===0`（无可做）与 `failed>0`（有失败）。`src/cli/uninstall.ts:170`（unconfigure catch）与 `:277`（--purge 删除失败）同款累计；退出码非 0。测试：mock adapter.configure 抛错 → exitCode 1。commit：`fix(cli): M-5 setup/uninstall 失败累计非零退出码`。

## Task 15: M-6 npx 路径判定收紧
`src/cli/setup.ts:20` `hasTempSegment` 改为显式临时段集合：`const TEMP_SEGS = new Set(['.package', '.staging', '.package-tmp']); const hasTempSegment = pathSegments.some(seg => TEMP_SEGS.has(seg));`；`inGlobalNodeModules` 主判据已是 `node_modules+godot-mcp-enhanced` 共存（`:22-24`），点目录启发式删除后 `~/.npm/_npx/...` 正确判为全局 → 输出 `npx godot-mcp-enhanced`。测试：构造 `~/.npm/_npx/<hash>/node_modules/godot-mcp-enhanced/build/index.js` 断言返回 npx 命令。commit：`fix(cli): M-6 临时路径判定改显式集合,npx 缓存路径不再误判`。

## Task 16: M-8 JSONC unconfigure 注释保护
`src/cli/clients/json-adapter.ts:107`（unconfigure）复用 configure 路径的 JSONC 解析/备份策略：若 configure 侧有 `readJsoncWithBackup` 类设施（`json-adapter.ts` 头部确认），unconfigure 同款调用并在剥离注释前写 `.jsonc-backup`；无该设施则最小实现：检测原文件含 `//` 或 `/*` 注释时拒绝重写并提示手动处理（宁可不清理，不静默毁注释）。`antigravity`/`opencode` 同源适配器（`:120` 注释指向）一并核查。测试：带注释 JSON unconfigure → 注释保留或拒绝+备份。commit：`fix(cli): M-8 JSON 客户端反配置不再静默剥离 JSONC 注释`。

## Task 17: M-9 editor-e2e 权限补全
`.github/workflows/editor-e2e.yml:29-30` 改：

```yaml
permissions:
  contents: read
  issues: write
```

commit：`ci: M-9 editor-e2e 补 contents: read,防私有 fork checkout 失败`。

## Task 18: Low 安全组六项
- **L-15** `src/core/headless-process.ts:26`：超时分支等 `close` 事件或 `setTimeout(destroy)` 后再 resolve（对齐 killProcess 模式，destroy 后立即 resolve 可接受，禁止裸 resolve 后流句柄悬空）。
- **L-16** `src/cli/zip-extract.ts:193`：目录条目同样过 `assertSafeEntryName`；解压完成后校验全部产出路径前缀都在目标根内。
- **L-17** `src/cli/godot-installer.ts:103` 附近 fetch 全部补 `AbortSignal.timeout(30_000)`（版本查询 10s/下载 300s 分档），重试上限 2。
- **L-18** `src/cli/uninstall.ts:223`：addon 目录删除前比对本仓分发清单（`addons/godot_mcp_server/` 文件清单硬编码或读 manifest），未匹配时逐文件比对哈希，不匹配文件保留并警告。
- **L-21** `src/web-gui/server.ts:870`：非 Windows 平台 kill 前用 `lsof -ti :<port>`（或 `ss -tlnp`）回验 PID 归属，失败拒绝 kill。
- **L-23** `src/web-gui/open.ts:43`：改 `execFile(browser, [url])` 参数数组；token 不入 URL——改由本地临时 HTML 中转（读 `?token=` 一次后写 sessionStorage）或至少改为 hash fragment（不入 server 日志）。实现取 execFile + hash fragment 两步，临时 HTML 方案留待后续。
每项独立 commit（`fix(...): L-xx ...`），测试就近。

---

# Batch 4（P3：Low 清理）清单卡

执行方式：每卡一独立小 commit，同一分支 `fix/2026-10-22-review2-p3` 收尾一次三连门禁。

| # | 文件:行 | 改法 | 验证 |
|---|---|---|---|
| L-1 | `src/index.ts:250` 附近 | 未知 `--flag`（非子命令且无匹配）→ 打印 usage + `process.exitCode = 2` | `node build/index.js --bogus; echo $?` → 2 |
| L-2 | `src/cli/web.ts:18` | `/^\d+$/` 且 1-65535 才 `Number`，否则 `console.error` + exit 2 | `web --port abc` → 报错 |
| L-3 | `src/gdscript-executor.ts:934` | 10MB 截断时在 result 显式置 `truncated: true` 且 `run_success: false` | 就近单测 |
| L-4 | `src/tools/workflow.ts:677` | proof 清理移入 finally（或 acceptance 块出口统一 `cleanupProofRun`，覆盖无断言仅有 frame_sequence 场景） | mock 帧捕获后 proof 目录被清 |
| L-5 | `src/tools/workflow.ts:310` | `(cmd.params.ms as number) ?? 100` + `Number.isFinite` 校验 | `waitMs(0)` 单测 |
| L-6 | `src/tools/game-bridge.ts:1214` | `game_input`/`click_button` 风险 `read`→`write`，meta 注释标注「输入注入改变运行态」（与 L-7 一并审） | requires_confirmation 测试 |
| L-7 | `src/tools/game-bridge.ts:521` | `ensureProjectDir` 显式 `args.project_path` 优先，错误信息注明活动项目回退语义 | 就近单测 |
| L-8 | `src/GodotServer.ts:414` | 通知 handler 统一 `void Promise.resolve(handler(...)).catch(...)` 包装 | 就近单测 |
| L-9 | `src/core/EditorConnection.ts:200` | 重连 terminate 前遍历 pending 逐个 reject（错误码 `do_not_retry`） | 就近单测 |
| L-11 | `src/core/bridge-client.ts:901` | `resetBridgeState` 补清 `_bridgeLegacyAuth*` 字段 | 就近单测 |
| L-12 | `src/core/EditorToolExecutor.ts:52` | `destroy()` 补 `offNotification('scene_tree_changed', ...)`（登记处对齐） | 就近单测 |
| L-13 | `src/core/inflight.ts:57` | mark/clear 改「写临时文件 + 原子 rename」（同 key 并发覆盖消除） | 并发单测 |
| L-14 | `src/core/audit-log.ts:175` | 轮转前 lock 文件探测（同机多实例 `~/.godot-mcp/` 下 `.audit.lock`，持有者存活则跳过轮转） | 双进程单测 |
| L-19 | `scripts/install-plugin.js:12` | usage 文案改 `node scripts/install-plugin.js ...`（路由表无该子命令，改文案不补子命令） | 文本核对 |
| L-20 | `src/web-gui/server.ts:456` | 加 Host 校验（仅 localhost/127.0.0.1），无 Origin 的写请求拒绝 | 就近单测 |
| L-22 | `src/web-gui/registry.ts:190` | `typeof x === 'number'` → `Number.isInteger(x) && x >= 0 && x <= 65535`（pid 上限放宽到 2^31） | 就近单测 |
| L-24 | `src/scoring/generate-score.ts:53` | 报告路径显式 `join(dirname(outPath), 'score-report.md')`，与输入同名即追加后缀 | 就近单测 |
| L-25 | `src/tscn/tscn-parser.ts:634` | 摘要递归加 visited Set（按节点 id）+ 深度上限 64 | 构造 parent 环单测 |
| L-26 | `scripts/check-tool-count.mjs` 尾部 | `if (import.meta.url === pathToFileURL(process.argv[1]).href) main();`（补 `import { pathToFileURL } from 'url'`） | `node -e "import('./scripts/check-tool-count.mjs')"` 不再执行 main |
| L-27 | `src/resources.ts:64` | 项目信息/配置读取前 `statSync` 大小 >10MB 拒读（错误非崩溃） | 大文件单测 |
| L-28 | `.github/workflows/ci.yml:10` | actions 由 tag 改 SHA 固定；changelog 门禁去 `continue-on-error`；`diff-matrix` 比较项扩描述/可选参数/size；budget 改在 build-matrix 后即时校验 | CI 绿 |
| L-29 | `src/cli/clients/json-adapter.ts:120` | 并入 Task 16 统一 JSONC 策略（同批验收） | 同 Task 16 |

**明确不修（决策项，随本计划留档）**：
- **L-10**（EditorConnection legacy 明文认证降级）：已披露的本机威胁模型取舍，高安全部署走 `GODOT_MCP_EDITOR_REQUIRE_CR_AUTH=true`。保持现状，不改代码。
- 审查报告 §6.7 所述 GD 端行为：C-1 修复全部在 TS 侧，`addons/` 无需改动。

---

## 执行注意事项（新会话必读）

1. **先读本计划 + 审查报告全文**（`docs/reviews/2026-10-22-全维度项目审查-第二轮.md`），再开工 Task 1。
2. **本机 env 残留**：`GODOT_MCP_ALLOW_UNSAFE_CONFIRM` 在 shell 环境中存在，启动行为验证一律 `env -u` 排除（Global Constraints）。
3. **Godot 统一入口** `D:\godot\godot.cmd`（v4.7.2）；真 Godot 集成测试与 `check:gdscript` 均用它。
4. **测试基线**：2026-10-22 全量 7296 passed / 0 failed / 95 skipped（503 文件，69s）。任何批次后全量结果差于此基线（新增 failed）即回查本批改动。
5. **每批收尾**：三连门禁 + 分支合并（不 bump 版本）+ 第三方审查文档（`docs/reviews/2026-10-22-review2-pN-fix.md`）+ memory 登记。
6. Task 1 改动安全核心，落地后须额外跑 `node scripts/check-command-docs-drift.mjs` 与 `STRICT=1 npm run check:rules-sync`（后者与本批无关但顺手验证不受牵连）。
