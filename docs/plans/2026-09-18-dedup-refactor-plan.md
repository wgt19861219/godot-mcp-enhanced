# 2026-09-18 代码重复收敛重构方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 2026-09-18 重复分析确认的 5 组无意 copy-paste（animation 双工具生成器 ~200 行、material shader 前奏 ~80 行、ops 执行样板 10 文件 ~100 行、core 四处中小重复 ~80 行、GD 两处前奏 ~50 行），全程行为锁定测试先行，分 6 批独立分支交付，预计净减 450~530 行、TS 重复率 4.0% → 约 3.3%。

**Architecture:** 每批一个独立分支、独立验证、可独立 revert。收敛落点全部复用既有共享基础设施（`animation-shared.ts`、`tools/shared/` 聚合桶、`core/` 内新 `headless-process.ts`）。两工具对外 JSON 契约与生成 GDScript 的逐字输出保持不变——由 inline snapshot 特征测试双向证明（重构前填充快照 → 重构后必须全绿）。

**Tech Stack:** TypeScript(ES2022/strict/ESM, Node16 模块解析, import 带 `.js`) + GDScript(Godot 4.5–4.7) + Vitest(globals 模式)。

**Spec:** `D:\workspace\Obsidian\GodotMCP\开发日志\2026-09-18 代码重复分析.md`（分析结论与定性依据；执行者两份都读）。本文行号均为 2026-09-18 快照，执行时以 grep 重定位为准。

---

## Global Constraints

- **每任务门禁**（顺序执行，任一失败修复后重跑）：`npm run lint` → `npm run build` → `npm test`。
- **GD 改动加验**：凡改 `addons/**/*.gd` 或 `src/scripts/*.gd`，必须跑 `npm run check:gdscript`（项目级完整编译；`validate_scripts` 逐文件 parse 有缩进盲区，见 AGENTS.md §6 教训）。需 `GODOT_PATH` 环境变量。
- **分支策略**：每批独立分支（`refactor/dedup-<批名>`），从 `master` 切出；不在 `master` 直接 commit。批内每 Task 一个 commit。
- **Commit 规范**：Conventional Commits，`refactor:` 前缀，subject 中文祈使句 ≤40 汉字。例：`refactor(animation): 收敛双工具重复生成器至 animation-shared`。
- **默认不发版**（AGENTS.md 定规）：不 bump 版本、不动 README 版本表、不跑 `version-sync`；变更记入 `CHANGELOG.md` 的 `[Unreleased]` 段（Keep a Changelog，`refactor` + `changed` 小节）。本方案不触碰 `src/tools/rule-templates.ts` 与 `.claude/rules/`，不触发版本 bump 硬门禁。
- **分层约束**：不新增 core→tools 依赖（eslint `no-restricted-imports` 门禁已有）；不新增模块级 setter；新代码走纯函数/常量导出。
- **验证产物**：`build/`、`docs/capability-matrix.*` 是生成产物，不手改。本方案不改工具清单（不动 `getToolDefinitions` 的 name/schema/description），**无需** `build-matrix`；若执行中发现 schema 变化，停下按 AGENTS.md §5 补跑。
- **明确不触碰清单**（有意冗余，2026-09-18 分析已定性）：
  - 三域 Keep-in-sync 副本：`godot_operations.gd` / `mcp_bridge.gd` / `addons/.../command_helpers.gd` 的 `_coerce_math_value`/`_math_comp`/`_comp_white`、`mcp_bridge.gd:715/731` 标注 `DUPLICATE` 的安全函数对。
  - `detectStringConcatBypass`(`gdscript-executor.ts:249`) ↔ `detectBpyStringConcatBypass`(`bpy-sandbox.ts:55`) 安全双实现（正则/token 有语义差异，合并有绕过风险）。
  - addons 各 `*_commands.gd` 头部 `setup()/cleanup()` 接口样板。
  - `inspect_node.gd` ↔ `query_scene_tree.gd` 入口（headless `--script` 自包含设计）。
- **测试文件命名**：新测试放 `test/<主题>.test.js`（与邻文件一致用 JS + globals）。

---

## 批次总览

| 批 | 分支 | 内容 | 净减(估) | 依赖 |
|---|---|---|---|---|
| 1 | `refactor/dedup-animation` | animation 双工具生成器收敛 | ~200 行 | 无 |
| 2 | `refactor/dedup-material` | material shader 前奏抽片段 | ~80 行 | 无 |
| 3 | `refactor/dedup-ops-runner` | ops 执行样板抽 `runOpsScript`（10 文件） | ~100 行 | 无 |
| 4 | `refactor/dedup-core-ts` | spawn/error-analyzer/orphan-cleanup/frame-verify | ~80 行 | 无 |
| 5 | `refactor/dedup-gd` | godot_operations 前奏 + nav_commands sync/async | ~50 行 | 无 |
| 6 | `docs/dedup-review-close` | 第三方审查 + memory + CHANGELOG + 复测 | — | 批 1–5 全部合并 |

批 1–5 相互独立，可任意顺序或并行（不同分支）；批 6 必须最后。

---

## 批 1：animation 双工具生成器收敛

**背景**：`src/tools/animation/animation-ops.ts` 与 `src/tools/animation/animation-track.ts` 的 GDScript 生成器族共享同一段守卫前奏（AP 定位 → AnimationPlayer 校验 → animation 存在性 → `_anim` 获取 → track 范围 → 可选 keyframe 范围），其中两对函数**逐字相同**：

| animation-ops.ts | animation-track.ts | 关系 |
|---|---|---|
| `genRemoveTrack`(:384) | `genAnimationTrackRemove`(:102) | 逐字相同 → 单一实现 |
| `genRemoveKeyframe`(:450) | `genAnimationKeyframeRemove`(:163) | 逐字相同 → 单一实现 |
| `genAddTrack`(:354) | `genAnimationTrackAdd`(:70) | 守卫相同，result 行不同（ops 版含 `track_path` 且 `track_type` 带引号；track 版 `track_type` 为数值枚举）→ 共享守卫片段 |
| `genAddKeyframe`(:408) | `genAnimationKeyframeAdd`(:126) | 守卫相同；ops 版多 method 轨道分支；result 键不同（track 版多 `track_index`）→ 共享守卫片段 |
| `genUpdateKeyframe`(:478) | `genAnimationKeyframeUpdate`(:191) | 守卫相同；ops 版多 time/rotation 分支 → 共享守卫片段 |
| — | `genAnimationCurve`(:226) | track 独有，共享守卫片段 | 

**约束**：两工具对外 JSON 输出（result 行）**必须逐字保持**——这是 MCP 对外契约，不是可统一项。`animation-ops.ts:536` 现有 `export {...} from './animation-track.js'` 测试兼容 re-export 块，收敛后改为从 `animation-shared.js` re-export，**所有既有导出名保持不变**。

### Task 1.1：特征锁定测试（重构护栏，先行）

**Files:**
- Create: `test/animation-dedup-lock.test.js`

**Interfaces:**
- Consumes: `genRemoveTrack`/`genRemoveKeyframe`/`genAddTrack`/`genAddKeyframe`/`genUpdateKeyframe`（from `src/tools/animation/animation-ops.js`）；`genAnimationTrackRemove`/`genAnimationKeyframeRemove`/`genAnimationKeyframeAdd`/`genAnimationCurve`（from `src/tools/animation/animation-track.js`）
- Produces: 快照基线，后续所有任务不得使其变红。

- [ ] **Step 1: 写锁定测试**

```js
// test/animation-dedup-lock.test.js
// 重构护栏:批1 收敛前先固化当前生成脚本输出。重构后本文件必须全绿且快照零漂移。
import { describe, it, expect } from 'vitest';
import {
  genRemoveTrack, genRemoveKeyframe, genAddTrack, genAddKeyframe, genUpdateKeyframe,
} from '../src/tools/animation/animation-ops.js';
import {
  genAnimationTrackRemove, genAnimationKeyframeRemove,
  genAnimationKeyframeAdd, genAnimationCurve,
} from '../src/tools/animation/animation-track.js';

const P = '/root/Main/Player';

describe('animation 双工具等价性锁定', () => {
  it('remove_track 两实现输出逐字一致', () => {
    expect(genAnimationTrackRemove(P, 'run', 1)).toBe(genRemoveTrack(P, 'run', 1));
  });
  it('remove_keyframe 两实现输出逐字一致', () => {
    expect(genAnimationKeyframeRemove(P, 'run', 0, 2)).toBe(genRemoveKeyframe(P, 'run', 0, 2));
  });
});

describe('生成脚本快照锁定(重构前基线)', () => {
  it('ops add_track', () => {
    expect(genAddTrack(P, 'run', 'value', 'Sprite2D:position')).toMatchInlineSnapshot();
  });
  it('ops add_keyframe(含 method 分支)', () => {
    expect(genAddKeyframe(P, 'run', 0, 1.5, [1, 2, 3], 2.0)).toMatchInlineSnapshot();
  });
  it('ops update_keyframe', () => {
    expect(genUpdateKeyframe(P, 'run', 0, 1, 2.0, [0, 0, 0], 1.5)).toMatchInlineSnapshot();
  });
  it('track add_keyframe', () => {
    expect(genAnimationKeyframeAdd(P, 'run', 0, 1.5, [1, 2, 3], undefined)).toMatchInlineSnapshot();
  });
  it('track set_curve', () => {
    expect(genAnimationCurve(P, 'run', 0, 1, { x: 0, y: 0 }, { x: 1, y: 1 })).toMatchInlineSnapshot();
  });
});
```

- [ ] **Step 2: 填充快照并确认绿**

Run: `npx vitest run test/animation-dedup-lock.test.js -u`
Expected: 全部 PASS（快照已写入测试文件）。若 import 报错（导出名缺失），先核对两文件底部 export 块，补齐缺失名后重跑。

- [ ] **Step 3: 确认既有测试绿（基线）**

Run: `npx vitest run test/animation-track.test.js test/animation-ops.test.js test/animation-shared.test.js`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add test/animation-dedup-lock.test.js
git commit -m "test(animation): 锁定双工具生成器输出基线(重构护栏)"
```

### Task 1.2：animation-shared.ts 增共享实现

**Files:**
- Modify: `src/tools/animation/animation-shared.ts`（头部 import 区 + 文件末尾追加）

**Interfaces:**
- Produces（后续任务依赖的确切签名）:
  - `animPreamble(nodePath: string, animName: string): string`
  - `trackRangeGuard(trackIdx: number): string`
  - `keyframeRangeGuard(trackIdx: number, kfIdx: number): string`
  - `genRemoveTrackScript(nodePath: string, animName: string, trackIdx: number): string`
  - `genRemoveKeyframeScript(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string`

- [ ] **Step 1: 头部补 import**

在 `src/tools/animation/animation-shared.ts:1`（现有 `import { ensureNumber, valueToGd } from '../shared.js';`）处扩为：

```ts
import { ensureNumber, valueToGd, SCENE_TREE_HEADER, gdEscape, escapeForGdLiteral } from '../shared.js';
```

- [ ] **Step 2: 文件末尾追加共享片段与单一实现**

```ts
// ─── 共享 GDScript 生成片段(animation 与 animation_track 复用,2026-09-18 重复分析收敛) ──
// 守卫前奏:AP 定位 → AnimationPlayer 校验 → animation 存在性 → 取 _anim。
// 两工具 8 个 gen 函数共享此前奏;result 输出行属各工具对外契约,不在此统一。
export function animPreamble(nodePath: string, animName: string): string {
  return `\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")`;
}

export function trackRangeGuard(trackIdx: number): string {
  return `\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn`;
}

export function keyframeRangeGuard(trackIdx: number, kfIdx: number): string {
  return `\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn`;
}

// 以下两函数在两工具中原本逐字相同(2026-09-18 分析确认),收敛为单一实现。
export function genRemoveTrackScript(nodePath: string, animName: string, trackIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
\t_anim.remove_track(${trackIdx})
\t_mcp_output("result", {"removed_track": ${trackIdx}})
\t_mcp_done()
`;
}

export function genRemoveKeyframeScript(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
${trackRangeGuard(trackIdx)}
${keyframeRangeGuard(trackIdx, kfIdx)}
\t_anim.track_remove_key(${trackIdx}, ${kfIdx})
\t_mcp_output("result", {"removed_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}
```

- [ ] **Step 3: 编译验证**

Run: `npm run build`
Expected: 零错误。

- [ ] **Step 4: Commit**

```bash
git add src/tools/animation/animation-shared.ts
git commit -m "refactor(animation-shared): 抽守卫前奏片段与 remove 单一实现"
```

### Task 1.3：animation-track.ts 重写为拼接

**Files:**
- Modify: `src/tools/animation/animation-track.ts:70-253`（6 个 gen 函数）

**Interfaces:**
- Consumes: Task 1.2 的 5 个导出。
- Produces: 导出名全部不变（`genAnimationTrackAdd/Remove/KeyframeAdd/KeyframeRemove/KeyframeUpdate/Curve`）。

- [ ] **Step 1: import 区接入共享实现**

在现有 `import { TRACK_TYPES, ensureNumber, valueToGd, animErrorMapper } from './animation-shared.js';` 扩为：

```ts
import {
  TRACK_TYPES, ensureNumber, valueToGd, animErrorMapper,
  animPreamble, trackRangeGuard, keyframeRangeGuard,
  genRemoveTrackScript as genAnimationTrackRemove,
  genRemoveKeyframeScript as genAnimationKeyframeRemove,
} from './animation-shared.js';
```

同时**删除** `genAnimationTrackRemove`(:102-124) 与 `genAnimationKeyframeRemove`(:163-189) 两个函数体（import 别名即本地绑定，底部 export 块 `export { genAnimationTrackRemove, ... }` 不需要改）。

- [ ] **Step 2: 重写其余 4 个函数为拼接式**

`genAnimationTrackAdd`（保留其独有 result：`track_type` 为数值枚举、无 `track_path`）：

```ts
function genAnimationTrackAdd(nodePath: string, animName: string, trackType: string, trackPath: string | undefined, insertAt: number | undefined): string {
  const typeVal = TRACK_TYPES.indexOf(trackType);
  const insertLine = insertAt !== undefined && insertAt >= 0
    ? `_anim.add_track(${typeVal}, ${insertAt})`
    : `_anim.add_track(${typeVal})`;
  const pathLine = trackPath
    ? `\n\t_anim.track_set_path(_anim.get_track_count() - 1, NodePath("${escapeForGdLiteral(trackPath)}"))`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
${animPreamble(nodePath, animName)}
\t${insertLine}
\tvar _idx: int = _anim.get_track_count() - 1${pathLine}
\t_mcp_output("result", {"track_index": _idx, "track_type": ${typeVal}})
\t_mcp_done()
`;
}
```

> ⚠️ 执行时先 diff 原函数的 result 行与 `${pathLine}` 结构，逐字保留——上例以 2026-09-18 快照为准（原 :70-99）。**任何输出差异都会被 Task 1.1 快照测试抓住**，以测试红为信号回退修正，而不是改快照。

`genAnimationKeyframeAdd` / `genAnimationKeyframeUpdate` / `genAnimationCurve` 同型重写：`${SCENE_TREE_HEADER}\nfunc _initialize():\n\t_mcp_load_main_scene()\n${animPreamble(...)}\n${trackRangeGuard(...)}\n` + 各自保留的 body/result 行（KeyframeAdd 的类型分派 if/elif 链、Update 的 valueLine/transLine、Curve 的 inLine/outLine 原样内嵌）。

- [ ] **Step 3: 验证（核心闸门）**

Run: `npx vitest run test/animation-dedup-lock.test.js test/animation-track.test.js`
Expected: 全绿，**快照零漂移**（不得带 `-u` 重跑）。

- [ ] **Step 4: 全门禁 + Commit**

```bash
npm run lint && npm run build && npm test
git add src/tools/animation/animation-track.ts
git commit -m "refactor(animation-track): 生成器改用共享守卫片段拼接"
```

### Task 1.4：animation-ops.ts 重写为拼接

**Files:**
- Modify: `src/tools/animation/animation-ops.ts:354-516`（5 个 gen 函数）+ :536 re-export 块

- [ ] **Step 1: import 接入 + 删除逐字相同的两函数体**

```ts
import {
  LOOP_MODES, TRACK_TYPES, ensureNumber, valueToGd, argsToGd, animErrorMapper,
  animPreamble, trackRangeGuard, keyframeRangeGuard,
  genRemoveTrackScript as genRemoveTrack,
  genRemoveKeyframeScript as genRemoveKeyframe,
} from './animation-shared.js';
```

删除 `genRemoveTrack`(:384-406)、`genRemoveKeyframe`(:450-476) 函数体。

- [ ] **Step 2: 重写 genAddTrack / genAddKeyframe / genUpdateKeyframe 为拼接式**

同 Task 1.3 Step 2 模式；**ops 版差异点逐字保留**：`genAddTrack` result 含 `"track_path": "${escapeForGdLiteral(trackPath)}"` 且 `"track_type": "${gdEscape(trackType)}"`（带引号）；`genAddKeyframe` 保留 `${methodBlock}`（TYPE_METHOD 分支）与 rotValueStr；`genUpdateKeyframe` 保留 timeLine 与 rotation 感知 valueLine。

- [ ] **Step 3: 改 re-export 块来源**

`src/tools/animation/animation-ops.ts:536` 的 `export { genAnimationTrackAdd, ... } from './animation-track.js'` 改为 `from './animation-shared.js'` 并纳入 track 侧同款五段式？——**不改内容只改来源会缺名字**（add/update/curve 仍在 animation-track.ts）。正确做法：保持该块原样 `from './animation-track.js'`（名字与来源都不动，实现已收敛到 shared，re-export 链 track→shared 自动生效）。**此 Step 为 no-op，仅确认不动。**

- [ ] **Step 4: 验证 + Commit**

```bash
npx vitest run test/animation-dedup-lock.test.js test/animation-ops.test.js test/animation-advanced.test.js
npm run lint && npm run build && npm test
git add src/tools/animation/animation-ops.ts
git commit -m "refactor(animation): ops 生成器收敛至共享片段,净减约 200 行"
```

---

## 批 2：material shader 前奏抽片段

**背景**：`src/tools/material-ops.ts` 的 `genShaderReadScript`(:405)、`genShaderWriteScript`(:438)、`genShaderLoadFileScript`(:489)、`genShaderApplyTemplateScript`(:544) 四函数各自内嵌同一段 ~20 行「节点定位 → 材质三层 fallback → ShaderMaterial 校验」前奏（`genShaderSaveFileScript`(:525) 不含此段，不动）。

### Task 2.1：锁定测试

- [ ] **Step 1: 创建 `test/material-shader-lock.test.js`**

```js
// 批2 重构护栏:四个 shader 生成函数输出基线。
import { describe, it, expect } from 'vitest';
import {
  genShaderReadScript, genShaderWriteScript, genShaderLoadFileScript, genShaderApplyTemplateScript,
} from '../src/tools/material-ops.js';

describe('shader 生成脚本快照锁定', () => {
  it('shader_read', () => {
    expect(genShaderReadScript('/root/M/Sprite', 0)).toMatchInlineSnapshot();
  });
  it('shader_write', () => {
    expect(genShaderWriteScript('/root/M/Sprite', 0, 'shader_type canvas_item;\nvoid fragment() {}')).toMatchInlineSnapshot();
  });
  it('shader_load_file', () => {
    expect(genShaderLoadFileScript('/root/M/Sprite', 0, 'res://shaders/a.gdshader')).toMatchInlineSnapshot();
  });
  it('shader_apply_template', () => {
    expect(genShaderApplyTemplateScript('/root/M/Sprite', 0, 'fire')).toMatchInlineSnapshot();
  });
});
```

- [ ] **Step 2: 填充快照**：`npx vitest run test/material-shader-lock.test.js -u` → 全 PASS。
- [ ] **Step 3: 基线**：`npx vitest run test/material-ops.test.js` → PASS。
- [ ] **Step 4: Commit**：`git commit -m "test(material): 锁定 shader 生成器输出基线"`。

### Task 2.2：抽前奏片段并替换

**Files:**
- Modify: `src/tools/material-ops.ts:405-589`（4 函数）

- [ ] **Step 1: 在 shader 生成器区（:403 注释下方）加片段函数**

```ts
// 共享前奏:节点定位 → 材质三层 fallback(material → surface_override → mesh.surface)→
// ShaderMaterial 校验。四个 shader_edit 系生成函数复用(2026-09-18 重复分析收敛)。
function shaderMatPreamble(nodePath: string, materialIndex: number): string {
  return `func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar mat = node.get("material")
\tif mat == null and node.has_method("get_surface_override_material"):
\t\tmat = node.get_surface_override_material(${materialIndex})
\tif mat == null:
\t\tvar _mesh = node.get("mesh")
\t\tif _mesh != null and _mesh.has_method("surface_get_material"):
\t\t\tmat = _mesh.surface_get_material(${materialIndex})
\tif mat == null:
\t\t_mcp_output("error", "No material on node")
\t\t_mcp_done()
\t\treturn
\tif not mat is ShaderMaterial:
\t\t_mcp_output("error", "Not a ShaderMaterial")
\t\t_mcp_done()
\t\treturn`;
}
```

- [ ] **Step 2: 四函数模板改为 `${SCENE_TREE_HEADER}\n${shaderMatPreamble(nodePath, materialIndex)}\n` + 各自保留段**

`genShaderReadScript` 在拼接后保留其独有的 `if mat.shader == null` 检查与 `shader_code` 输出；`genShaderWriteScript`/`genShaderApplyTemplateScript` 保留 F-7 注释、`duplicate()`、JSON.parse 往返与 C-BUG-1 compile_result 段；`genShaderLoadFileScript` 保留 `ResourceLoader.exists` 检查。逐字保留，以快照测试为闸。

- [ ] **Step 3: 验证 + 门禁 + Commit**

```bash
npx vitest run test/material-shader-lock.test.js test/material-ops.test.js
npm run lint && npm run build && npm test
git add src/tools/material-ops.ts test/material-shader-lock.test.js
git commit -m "refactor(material): 四个 shader 生成器复用材质前奏片段"
```

---

## 批 3：ops 执行样板抽 `runOpsScript`（10 文件）

**背景**：action switch 尾部的 `executeGdscript({godotPath, projectPath, code, timeout, loadAutoloads})` + `errorMapper` + `parseGdscriptResult`(±`appendRuntimePersistWarning`) 样板横跨 10 个标准形态文件。**两个异形态文件明确排除**：`profiler-ops.ts`（timeout 是变量、`get_data` 分支早返回）、`script.ts`（`timeout = validateTimeout(args.timeout)`、`loadAutoloads` undefined 有自动检测语义）。

**差异矩阵**（替换时的确切参数，grep 实测于 2026-09-18）：

| 文件 | timeout | warnPersist | paramWarnings |
|---|---|---|---|
| audio-ops / node-3d-ops / particles / physics-ops / signal-ops / tilemap-ops / animtree / ik-tools | 30 | audio/node-3d/particles/physics/signal/tilemap=true；animtree/ik=false | 各文件原值 |
| navigation | 不显式（传 undefined 保持 executeGdscript 内部默认） | true | 原值 |
| uid-ops | 60 | false | 原值 |

`errorMapper` 一律保留在各文件内（这是每个工具的真实差异，不进 helper）。

### Task 3.1：新建 ops-runner

**Files:**
- Create: `src/tools/shared/ops-runner.ts`
- Modify: `src/tools/shared.ts`（聚合桶挂载）

**Interfaces:**
- Produces: `runOpsScript(opts): Promise<ToolResult>`（签名见代码）。

- [ ] **Step 1: 创建 helper**

```ts
// src/tools/shared/ops-runner.ts
// ops 工具 action-switch 尾部执行样板收敛(2026-09-18 重复分析,原 10 文件各自内联)。
// errorMapper 是各工具的真实差异,保留在调用方;此处只统一 execute→parse→warn 链。
import type { ToolResult } from '../../types.js';
import { executeGdscriptRuntime } from '../../gdscript-executor.js';
import { parseGdscriptResult } from '../../core/shared/errors.js';
import { appendRuntimePersistWarning } from './persistence-warning.js';

export interface RunOpsScriptOptions {
  godot: string;
  projectPath: string;
  script: string;
  loadAutoloads: boolean;
  errorMapper: (msg: string) => string;
  /** appendRuntimePersistWarning 的 action 参数(持久化提示中引用的 action 名) */
  action: string;
  /** 不传则用 executeGdscript 内部默认(navigation 行为依赖此默认) */
  timeoutSec?: number;
  paramWarnings?: string[];
  /** true 时包 appendRuntimePersistWarning(运行时改动不落盘提示) */
  warnRuntimePersist?: boolean;
}

export async function runOpsScript(opts: RunOpsScriptOptions): Promise<ToolResult> {
  const result = await executeGdscriptRuntime({
    godotPath: opts.godot,
    projectPath: opts.projectPath,
    code: opts.script,
    timeout: opts.timeoutSec,
    loadAutoloads: opts.loadAutoloads,
  });
  const parsed = parseGdscriptResult(result, opts.paramWarnings ?? [], opts.errorMapper);
  return opts.warnRuntimePersist
    ? appendRuntimePersistWarning(parsed, opts.action)
    : parsed;
}
```

- [ ] **Step 2: 聚合桶挂载**：`src/tools/shared.ts` 追加一行 `export * from './shared/ops-runner.js';`
- [ ] **Step 3: 验证**：`npm run lint && npm run build` → 零错误。
- [ ] **Step 4: Commit**：`git commit -m "refactor(tools): 新增 runOpsScript 执行样板 helper"`。

### Task 3.2：替换组 A（warn=true，7 文件）

以 `src/tools/audio-ops.ts:231-242` 为代表，替换前后对照：

```ts
// 替换前(:231-242)
const result = await executeGdscript({
  godotPath: godot, projectPath, code: script, timeout: 30, loadAutoloads,
});
const errorMapper = (msg: string) =>
  (msg.includes('not found') || msg.includes('not an Audio')) ? ERROR_CODES.AUDIO_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;
return appendRuntimePersistWarning(parseGdscriptResult(result, paramWarnings, errorMapper), action);

// 替换后
const errorMapper = (msg: string) =>
  (msg.includes('not found') || msg.includes('not an Audio')) ? ERROR_CODES.AUDIO_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;
return runOpsScript({ godot, projectPath, script, loadAutoloads, timeoutSec: 30,
  errorMapper, paramWarnings, warnRuntimePersist: true, action });
```

同型替换 7 文件：audio-ops(:231)、node-3d-ops(:154)、particles(:493)、physics-ops(:435)、signal-ops(:211)、tilemap-ops(:470)、navigation(:502，`timeoutSec` 省略)。每文件替换后立即跑该文件测试（`test/audio-ops.test.js` 等对应存在；navigation 用 `test/navigation-tools.test.js`）。

- [ ] 逐文件替换 + 测试（每文件一个 sub-step，绿一个过一个）
- [ ] 门禁：`npm run lint && npm run build && npm test`
- [ ] Commit：`refactor(tools): 七个 ops 工具接入 runOpsScript(warn 族)`

### Task 3.3：替换组 B（warn=false，3 文件）

`animtree.ts:440`、`ik-tools.ts:297`（`paramWarnings` 传 `[]`）、`uid-ops.ts:424`（`timeoutSec: 60`）。形态同 Task 3.2，去掉 `warnRuntimePersist`。验证：`test/animtree.test.js`、`test/ik-tools.test.js`；uid 无专属测试文件，靠 `npm test` 全量。
- [ ] 替换 + 测试 + 门禁
- [ ] Commit：`refactor(tools): 三个 ops 工具接入 runOpsScript(无 warn 族)`

---

## 批 4：core 四处中小收敛

### Task 4.1：headless spawn 进程编排收敛

**背景**：`runBlenderHeadless`(`src/core/blender-spawn.ts:15-51`) 与 `runGodotHeadless`(`src/core/godot-spawn.ts:18-57`) 除命令/路径/注释外逐字相同；返回类型字段一致 `{exitCode, stdout, stderr}`。**错误文本前缀是历史测试断言依赖**（`runGodotHeadless: failed to spawn`），必须参数化保留。

**Files:**
- Create: `src/core/headless-process.ts`
- Modify: `src/core/blender-spawn.ts`、`src/core/godot-spawn.ts`（变薄壳，导出名/签名/接口名不变）

- [ ] **Step 1: 新建共享实现**

```ts
// src/core/headless-process.ts
// runBlenderHeadless / runGodotHeadless 的共享进程编排(2026-09-18 重复分析收敛):
// spawn + Buffer[] 累积(C-PERF-01) + 超时 forceKillTree + error/close。
// label 参与错误文本前缀——blender/godot 各自的历史测试断言依赖该前缀,不可统一。
import { spawn } from 'child_process';
import { forceKillTree } from './process-state.js';
import { buildSafeEnv } from '../helpers.js';

export interface HeadlessRunResult {
  exitCode: number | null;  // null = 超时被杀
  stdout: string;
  stderr: string;
}

export function runHeadlessCollector(
  label: string, binPath: string, args: string[], timeoutMs: number,
): Promise<HeadlessRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildSafeEnv() });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      forceKillTree(proc);
      resolve({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn ${binPath}: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}
```

- [ ] **Step 2: 两个原文件变薄壳**（保留原导出与 doc 注释）

```ts
// blender-spawn.ts 全量替换为:
export interface BlenderRunResult {
  exitCode: number | null;  // null = 超时被杀
  stdout: string;
  stderr: string;
}
/** spawn blender headless + 累积 stdio + 超时 forceKillTree 杀进程树。对称 runGodotHeadless。 */
export function runBlenderHeadless(
  args: string[], blenderPath: string, timeoutMs: number = 60_000,
): Promise<BlenderRunResult> {
  return runHeadlessCollector('runBlenderHeadless', blenderPath, args, timeoutMs);
}
```

`godot-spawn.ts` 同型（label `'runGodotHeadless'`，保留原 doc 注释中「禁止在调用方重写 spawn」的约束说明）。

- [ ] **Step 3: 验证**：`npx vitest run test/gdscript-spawn-orphan.test.ts test/run-tests-spawn-register.test.ts` + `npm run lint && npm run build && npm test`
- [ ] **Step 4: Commit**：`refactor(core): spawn 进程编排收敛至 runHeadlessCollector`

### Task 4.2：error-analyzer 双分支 helper

**背景**：`src/error-analyzer.ts` SCRIPT ERROR 分支(:318-344) 与 ERROR 分支(:346-375) 重复「pattern 循环分类 + ParsedError 组装 + enrich + push」。差异仅默认 type/suggestion，及 SCRIPT 分支多 `if (pattern.type === 'parse_error') continue;`。

- [ ] **Step 1: 在 `ERROR_PATTERNS` 定义之后加 helper**

```ts
function classifyError(
  message: string,
  defaultType: ParsedError['type'],
  defaultSuggestion: string,
  options: ParseOptions,
  skipParseError: boolean,
): { type: ParsedError['type']; suggestion: string } {
  for (const pattern of ERROR_PATTERNS) {
    if (skipParseError && pattern.type === 'parse_error') continue; // parse_error 已在上游处理
    if (pattern.test(message, options)) {
      return { type: pattern.type, suggestion: pattern.suggestion(message) };
    }
  }
  return { type: defaultType, suggestion: defaultSuggestion };
}
```

- [ ] **Step 2: 两分支调用**

SCRIPT ERROR 分支：`const { type: errorType, suggestion } = classifyError(message, 'script_error', 'Review the script logic and ensure all variables and methods are correctly referenced.', options, true);`
ERROR 分支：`... classifyError(message, 'runtime_error', 'An engine error occurred. Check the Godot documentation for this error message.', options, false);`
（`ParseOptions` 类型名以 `src/error-analyzer.ts` 实际为准 grep 确认。）

- [ ] **Step 3: 验证**：`npx vitest run test/error-analyzer.test.js` + 门禁
- [ ] **Step 4: Commit**：`refactor(error-analyzer): 双分支错误分类收敛至 classifyError`

### Task 4.3：orphan-cleanup 双 shell 分支骨架

**背景**：`src/core/orphan-cleanup.ts` Windows(:108-154) / Unix(:158-197) 分支重复「settled + ORPHAN_SCAN_TIMEOUT_MS 定时器 + out/stderr 收集 + error handler」。差异：spawn 命令、pid 解析、kill 方式（`taskkill` vs `process.kill SIGTERM`）。

- [ ] **Step 1: 抽骨架 helper（文件内私有）**

```ts
function runShellScan(
  command: string, shellArgs: string[],
  parsePids: (out: string) => number[],
  killPid: (pid: number) => void,
  excludePids: number[],
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const ps = spawn(command, shellArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    // P2: unref orphan-scan spawn so close() doesn't block Node exit on in-flight scan.
    ps.unref?.();
    const timer = setTimeout(() => {
      if (!settled && !ps.killed) { settled = true; ps.kill(); resolve(0); }
    }, ORPHAN_SCAN_TIMEOUT_MS);
    let out = '';
    let stderr = '';
    ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    ps.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const pids = parsePids(out).filter(n => n > 0 && !excludePids.includes(n));
      for (const pid of pids) killPid(pid);
      if (stderr) getLogger().debug('orphan-cleanup', `orphan scan stderr: ${stderr.slice(0, 200)}`);
      resolve(pids.length);
    });
    ps.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      getLogger().debug('orphan-cleanup', `orphan scan error: ${err.message}`);
      resolve(0);
    });
  });
}
```

注意：原 Windows 分支 pid 解析在 close 内做 `.map(Number).filter(...)`，Unix 分支多一步 `/^\d+$/` 行过滤——分别作为两个 `parsePids` 闭包传入；Windows `taskkill` spawn + `tk.on('error', () => {})` 守卫与 Unix `try { process.kill } catch {}` 分别作为 `killPid` 闭包传入，逐字搬移。

- [ ] **Step 2: 两分支改为一次 `runShellScan(...)` 调用**
- [ ] **Step 3: 验证**：`npx vitest run test/orphan-multibucket.test.ts test/p2-orphan-pure.test.ts test/batch-add-nodes-orphan-guard.test.ts` + 门禁
- [ ] **Step 4: Commit**：`refactor(core): orphan 扫描双分支收敛至 runShellScan 骨架`

### Task 4.4：frame-verify 相似度辅助片段常量

**背景**：`src/tools/frame-verify/gdscripts.ts` 两个模板各自内嵌 `_mcp_output`/`_mcp_done`/`_embed`(32×32 归一化)/`_cos`(点积)（:14-47 与 :88-121 逐字相同）。生成的 GDScript 仍须自包含——收敛发生在 TS 模板层（共享常量拼接），不改变生成产物。

- [ ] **Step 1: 顶部加常量**

```ts
// 两模板共享的 GDScript 辅助函数段(输出协议 + 32×32 归一化 embed + 余弦点积)。
// 生成的脚本必须自包含,故以常量拼接而非 Godot 侧共享。
const SIM_HELPERS_GD = `var _outputs := []

func _mcp_output(key, value):
\t_outputs.append({"key": key, "value": value})

func _mcp_done():
\tprint(JSON.stringify(_outputs))
\tquit()

func _embed(path: String) -> PackedFloat32Array:
\tvar img := Image.load_from_file(path)
\timg.resize(32, 32)
\tvar raw := img.get_data()
\tvar v := PackedFloat32Array()
\tv.resize(32 * 32 * 3)
\tvar sum_sq := 0.0
\tfor i in range(32 * 32):
\t\tvar r := raw[i * 4] / 255.0
\t\tvar g := raw[i * 4 + 1] / 255.0
\t\tvar b := raw[i * 4 + 2] / 255.0
\t\tv[i * 3] = r
\t\tv[i * 3 + 1] = g
\t\tv[i * 3 + 2] = b
\t\tsum_sq += r * r + g * g + b * b
\tvar norm := sqrt(sum_sq) + 1e-8
\tfor i in range(v.size()):
\t\tv[i] = v[i] / norm
\treturn v

func _cos(a: PackedFloat32Array, b: PackedFloat32Array) -> float:
\tvar s := 0.0
\tfor i in range(a.size()):
\t\ts += a[i] * b[i]
\treturn s`;
```

- [ ] **Step 2: 两模板内联段替换为 `${SIM_HELPERS_GD}`**（首模板保留其独有的 `_frames_dir` 变量声明）
- [ ] **Step 3: 验证**：`npm run lint && npm run build && npm test`（frame-verify 若有专属测试文件 `ls test/ | grep frame` 确认并先跑）
- [ ] **Step 4: Commit**：`refactor(frame-verify): 相似度辅助段收敛为共享常量`

---

## 批 5：GDScript 两处前奏收敛

> ⚠️ 本批改分发产物与 headless 主脚本。每 Task 收尾必跑 `npm run check:gdscript`（需 `GODOT_PATH`）；`addons` 改动评估向后兼容（目标项目 Godot 版本可能为 4.5–4.7，不使用 4.6+ 专有 API——本批只做函数抽取，无新 API）。

### Task 5.1：godot_operations.gd 场景加载前奏

**背景**：`edit_node`(:601) 与 `remove_node`(:675) 共享「sanitize → globalize → file_exists → load → instantiate」+「node_path 剥 `/root/`、`root/`、`/` 前缀与场景根名」两段共 ~26 行。

- [ ] **Step 1: 在两函数之前加两个 helper**

```gdscript
# 2026-09-18 重复收敛:edit_node/remove_node 共享的场景加载与路径规范化前奏。
# 返回 {"root": scene_root, "abs": absolute_scene_path};失败已 _exit_with(1),返回 {} 表示中止。
func _load_scene_or_exit(params) -> Dictionary:
	var full_scene_path = _sanitize_res_path(params.scene_path)
	var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
	if not FileAccess.file_exists(absolute_scene_path):
		log_error("Scene file does not exist: " + absolute_scene_path)
		_exit_with(1)
		return {}
	var scene = load(full_scene_path)
	if not scene:
		log_error("Failed to load scene: " + full_scene_path)
		_exit_with(1)
		return {}
	return {"root": scene.instantiate(), "abs": absolute_scene_path}

# TS 侧 normalizeNodePath 传 "/root/Root/X" 形式;scene_root 未挂 SceneTree,需剥前缀。
# 再剥场景根名前缀(query_scene_tree 拷贝路径含根名,get_node_or_null 相对 scene_root 自身)。
func _normalize_scene_node_path(node_path: String, scene_root) -> String:
	if node_path.begins_with("/root/"):
		node_path = node_path.substr(6)
	elif node_path.begins_with("root/"):
		node_path = node_path.substr(5)
	elif node_path.begins_with("/"):
		node_path = node_path.substr(1)
	if node_path.begins_with(scene_root.name + "/"):
		node_path = node_path.substr(scene_root.name.length() + 1)
	return node_path
```

- [ ] **Step 2: 两函数替换为调用**（`edit_node` 前段 → `var loaded = _load_scene_or_exit(params); if loaded.is_empty(): return; var scene_root = loaded.root; var absolute_scene_path = loaded.abs` + `var node_path = _normalize_scene_node_path(params.node_path, scene_root)`；`remove_node` 同型，其后的 root 特判/`cleanup_and_quit` 逻辑保留原位）
- [ ] **Step 3: 验证**：`npm run check:gdscript`（零错误）+ `npm test`
- [ ] **Step 4: Commit**：`refactor(gd): edit_node/remove_node 复用场景加载前奏 helper`

### Task 5.2：nav_commands.gd sync/async 前奏

**背景**：`handle_nav_create_region`(sync, :74) 与 `handle_nav_create_region_async`(:134) 前半段（root/parent 解析 → 建 NavigationRegion3D → position → mesh 初始化）逐字重复 ~24 行。

- [ ] **Step 1: 文件内加 helper（置于两 handler 之间）**

```gdscript
# 2026-09-18 重复收敛:sync/async 两版 nav_create_region 共享的节点构建前奏。
# 返回 {"nav": nav, "parent": parent_node};失败返回 {"error": {...}}(code -32002/-32003)。
func _create_nav_region(params: Dictionary, root: Node) -> Dictionary:
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}
	var node_name: String = params.get("name", "NavRegion")
	var parent_path: String = params.get("parent", "")
	var parent_node: Node = CommandHelpers.find_node(root, parent_path) if parent_path != "" else root
	if parent_node == null:
		return {"error": {"code": -32002, "message": "Parent not found: " + parent_path}}
	var nav = NavigationRegion3D.new()
	nav.name = node_name
	var pos = params.get("position")
	if pos != null and pos is Dictionary:
		nav.position = Vector3(float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0)))
	# P0-2: mesh 在入栈前初始化(附着 nav,随 reference 保护,undo/redo 不丢)
	var mesh = NavigationMesh.new()
	mesh.geometry_parsed_collision_mask = 0xFFFFFFFF
	nav.navigation_mesh = mesh
	return {"nav": nav, "parent": parent_node}
```

- [ ] **Step 2: 两 handler 前段替换为** `var created = _create_nav_region(params, root); if created.has("error"): return created; var nav = created.nav; var parent_node = created.parent`（sync 版把原 root==null 检查一并移入 helper；async 版同步替换）
- [ ] **Step 3: 验证**：`npm run check:gdscript` + `npm test`（addons testing/suites 无 nav 套件——已确认；依赖完整编译 + editor 手工冒烟 `launch_editor` 后调一次 `nav_create_region`）
- [ ] **Step 4: Commit**：`refactor(nav): sync/async 版 nav_create_region 复用构建前奏`

---

## 批 6：收尾合规（分支 `docs/dedup-review-close`）

- [ ] **Task 6.1 复测重复率**：重跑检测脚本（方法论见 Spec 日志；脚本核心=归一化行 + 6 行窗口指纹 + 对齐链聚类），对比 4.0%/4.1% 基线，数字写入审查文档（快照护栏：实测后写）。
- [ ] **Task 6.2 第三方审查**：派 `code-reviewer` 子代理产出 `docs/reviews/2026-09-18-dedup-refactor.md`——独立 grep/read 实测所有声明，含仓库级约束核查（AGENTS.md「独立副本同步约束」「分发产物边界」逐项过，不只对照本方案清单；源于 2026-07-27 教训）。格式：SHIPPED / SHIPPED WITH NITS / BLOCKING + 逐维度 file:line 证据。
- [ ] **Task 6.3 memory 登记**：`feature-decision-log`（含被拒方案：三副本不收敛的理由）+ 工程教训（特征锁定测试模式）。
- [ ] **Task 6.4 CHANGELOG `[Unreleased]`**：`### Changed` 下按批列 refactor 条目（不 bump 版本）。
- [ ] **Task 6.5 Obsidian 日志**：`D:\workspace\Obsidian\GodotMCP\开发日志\2026-09-18 代码重复收敛落地.md`，回链分析日志。

---

## 风险登记与回滚

| 风险 | 批 | 概率/影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| 生成脚本输出漂移（MCP 契约破坏） | 1/2/4.4 | 低/高 | inline snapshot 先行锁定，禁 `-u` 重跑；红即回退修正代码而非快照 | revert 单 commit |
| `animation-track` import 兼容破坏（测试/模块加载） | 1 | 中/中 | import 别名保本地绑定；导出名逐一不变；既有 3 个测试文件兜底 | revert 批 1 分支 |
| ESM 聚合桶循环 import | 3 | 低/中 | ops-runner 从 `core/shared/errors.js`、`shared/persistence-warning.js` 子模块直连，不经 `tools/shared.ts` | revert Task 3.1 |
| navigation 隐式 timeout 语义漂移 | 3 | 低/中 | `timeoutSec` 不传→`undefined` 直传，保持 executeGdscript 内部默认 | revert Task 3.2 该文件 |
| spawn 错误文本断言破坏 | 4.1 | 低/中 | label 参数化保留 `runXxxHeadless: failed to spawn` 前缀；spawn 相关测试先跑 | revert Task 4.1 |
| GD 改动缩进/结构 bug 逃逸 | 5 | 中/高 | 必跑 `check:gdscript`（完整编译），不信 `validate_scripts`；addons 无 nav 套件→editor 手工冒烟 | revert 批 5 分支 |
| addons 分发兼容性 | 5.2 | 低/中 | 仅函数抽取，无新引擎 API；Godot 4.5–4.7 语法兼容 | revert Task 5.2 |

## 自审记录

1. **Spec 覆盖**：分析报告 P0（批1）、P1×2（批2/3）、P2×4（批4）、P2-GD×2（批5）、合规四件套（批6）全部有对应任务；「不动清单」进入 Global Constraints。✓
2. **占位符扫描**：Task 1.3 Step 2 的「同型重写」指向 Task 1.2 的确切代码与保留清单（差异点已枚举：result 行/methodBlock/timeLine/rotation），配合快照测试兜底，非 TBD；Task 3.2/3.3 以代表示例 + 差异矩阵表给出每文件确切参数。✓
3. **类型一致性**：`animPreamble`/`trackRangeGuard`/`keyframeRangeGuard`/`genRemoveTrackScript`/`genRemoveKeyframeScript` 签名在 Task 1.2 定义、1.3/1.4 消费一致；`runOpsScript` 的 `action` 字段已在 Task 3.1 内更正声明；`HeadlessRunResult` 与两个既有 `*RunResult` 字段一致。✓
4. **已知待执行时确认项**（grep 重定位性质，非方案缺口）：Task 1.1 导出名与底部 export 块核对、Task 4.2 `ParseOptions` 实名、Task 4.4 frame-verify 测试文件存在性。
