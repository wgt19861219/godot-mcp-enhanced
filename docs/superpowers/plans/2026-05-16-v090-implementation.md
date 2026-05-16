# godot-mcp-enhanced v0.9.0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三线并行升级 godot-mcp-enhanced：功能补齐（100→~123 工具）、质量提升（拆分大文件）、性能优化（缓存机制），零新依赖。

**Architecture:** 新工具模块遵循 `TOOL_NAMES → getToolDefinitions() → handleTool() → TOOL_META` 模式，通过 GDScript 代码生成 + headless 执行实现功能。godot-ops.ts（1112 行）拆分为 4 个专注模块后删除原文件。缓存采用模块级变量，进程生命周期有效。

**Tech Stack:** TypeScript, Node.js, Godot 4.x headless, GDScript 代码生成, node:test

---

### Task 1: 拆分 godot-ops.ts — signal-ops.ts（4 工具）

**Files:**
- Create: `src/tools/signal-ops.ts`
- Modify: `src/GodotServer.ts`（注册新模块）
- Test: `test/signal-ops.test.js`

从 `godot-ops.ts` 提取信号相关工具。原文件中共享辅助函数（`gdEscape`, `normalizeNodePath`, `validateVector3`, `clampParam`, `TYPE_WHITELIST`）保留在原文件直到 Task 2 完成。

**提取的工具：**
- `signal_connect`
- `signal_disconnect`
- `signal_emit`
- `signal_list`

- [ ] **Step 1: 写 signal-ops.ts 的测试**

创建 `test/signal-ops.test.js`：

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('signal-ops', () => {
  describe('genConnectScript', () => {
    it('generates valid GDScript for signal connection', async () => {
      const { getSignalOps } = await import('../src/tools/signal-ops.ts');
      // 通过 handleTool 间接测试或直接导入生成函数
    });
  });

  describe('genDisconnectScript', () => {
    it('generates valid GDScript for signal disconnection', async () => {
      // 测试断开连接脚本生成
    });
  });

  describe('genEmitScript', () => {
    it('generates valid GDScript for signal emission with args', async () => {
      // 测试带参数的信号发射
    });
  });

  describe('genListScript', () => {
    it('generates valid GDScript for signal listing', async () => {
      // 测试信号列表查询
    });
  });

  describe('TOOL_NAMES', () => {
    it('exports exactly 4 signal tool names', async () => {
      const mod = await import('../src/tools/signal-ops.ts');
      assert.equal(mod.TOOL_NAMES.length, 4);
      assert.ok(mod.TOOL_NAMES.includes('signal_connect'));
      assert.ok(mod.TOOL_NAMES.includes('signal_disconnect'));
      assert.ok(mod.TOOL_NAMES.includes('signal_emit'));
      assert.ok(mod.TOOL_NAMES.includes('signal_list'));
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/signal-ops.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 创建 signal-ops.ts**

从 `godot-ops.ts` 复制信号相关代码到新文件。保留相同的 `gen*Script()` 函数签名和 GDScript 代码。需要从 godot-ops.ts 导入共享辅助函数：

```typescript
import type { ToolDefinition, ToolResult } from '../types.js';
import { executeGdscript } from '../gdscript-executor.js';
import { textResult } from '../types.js';
import { SCENE_TREE_HEADER, opsSuccess, opsErrorResult, parseGdscriptResult } from './shared.js';
import { gdEscape, normalizeNodePath } from './godot-ops.js';

export const TOOL_NAMES = ['signal_connect', 'signal_disconnect', 'signal_emit', 'signal_list'] as const;

// 从 godot-ops.ts 复制 genSignalConnectScript, genSignalDisconnectScript,
// genSignalEmitScript, genSignalListScript 函数
// 复制对应的 getToolDefinitions 和 handleTool 中的信号处理分支
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test test/signal-ops.test.js`
Expected: PASS

- [ ] **Step 5: 注册新模块到 GodotServer.ts**

在 `src/GodotServer.ts` 的 `toolModules` 数组中添加 signal-ops 导入：

```typescript
import * as signalOps from './tools/signal-ops.js';
// 在 toolModules 数组中添加 signalOps
```

- [ ] **Step 6: 提交**

```bash
git add src/tools/signal-ops.ts test/signal-ops.test.js src/GodotServer.ts
git commit -m "refactor: extract signal tools from godot-ops.ts into signal-ops.ts (4 tools)"
```

---

### Task 2: 拆分 godot-ops.ts — 剩余模块 + 删除原文件

**Files:**
- Create: `src/tools/node-3d-ops.ts`（node_create_3d + collision_overlay）
- Create: `src/tools/physics-ops.ts`（physics_raycast + body_info + diagnose_physics + query_spatial）
- Create: `src/tools/audio-ops.ts`（audio_play + stop + set_param + query）
- Modify: `src/tools/navigation.ts`（迁入 nav_query_path）
- Delete: `src/tools/godot-ops.ts`
- Modify: `src/GodotServer.ts`（更新模块注册）
- Test: `test/node-3d-ops.test.js`, `test/physics-ops.test.js`, `test/audio-split.test.js`

**提取的工具映射：**

| 新模块 | 工具 |
|--------|------|
| node-3d-ops.ts | node_create_3d, collision_overlay |
| physics-ops.ts | physics_raycast, physics_body_info, diagnose_physics, query_spatial |
| audio-ops.ts | audio_play, audio_stop, audio_set_param, audio_query |
| navigation.ts（已有） | nav_query_path（从 godot-ops 迁入） |

**共享辅助函数处理：** 将 `gdEscape`, `normalizeNodePath`, `validateVector3`, `clampParam`, `TYPE_WHITELIST` 移入 `shared.ts` 或各自内联。`ERROR_CODES` 各模块各自定义。

- [ ] **Step 1: 写拆分后模块的测试**

每个新模块创建测试文件，验证 TOOL_NAMES 导出和基础工具定义结构。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/node-3d-ops.test.js test/physics-ops.test.js test/audio-split.test.js`
Expected: FAIL

- [ ] **Step 3: 创建 node-3d-ops.ts**

从 godot-ops.ts 提取 `node_create_3d` 和 `collision_overlay` 相关代码。

- [ ] **Step 4: 创建 physics-ops.ts**

从 godot-ops.ts 提取 `physics_raycast`, `physics_body_info`, `diagnose_physics`, `query_spatial` 相关代码。

- [ ] **Step 5: 创建 audio-ops.ts**

从 godot-ops.ts 提取 `audio_play`, `audio_stop`, `audio_set_param`, `audio_query` 相关代码。

- [ ] **Step 6: 迁移 nav_query_path 到 navigation.ts**

将 `nav_query_path` 的生成函数、工具定义、处理逻辑从 godot-ops.ts 移入已有 navigation.ts。更新 navigation.ts 的 TOOL_NAMES 和 getToolDefinitions。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx tsx --test test/node-3d-ops.test.js test/physics-ops.test.js test/audio-split.test.js`
Expected: PASS

- [ ] **Step 8: 更新 GodotServer.ts 注册**

替换 godot-ops 导入为 node3dOps, physicsOps, audioOps。更新 signal-ops 的共享函数导入来源。

- [ ] **Step 9: 验证所有工具名仍可解析**

Run: `npx tsx -e "import {GodotServer} from './src/GodotServer.js'; const s = new GodotServer(); console.log('tools:', s.getToolCount())"`
Expected: 100（工具数不变，仅内部重组）

- [ ] **Step 10: 删除 godot-ops.ts + 提交**

```bash
git rm src/tools/godot-ops.ts
git add src/tools/node-3d-ops.ts src/tools/physics-ops.ts src/tools/audio-ops.ts src/tools/navigation.ts src/GodotServer.ts test/
git commit -m "refactor: complete godot-ops.ts split into 4 focused modules + nav migration (15 tools)

- signal-ops.ts: 4 tools (connect/disconnect/emit/list) [Task 1]
- node-3d-ops.ts: 2 tools (node_create_3d/collision_overlay)
- physics-ops.ts: 4 tools (raycast/body_info/diagnose/query_spatial)
- audio-ops.ts: 4 tools (play/stop/set_param/query)
- navigation.ts: +1 tool (nav_query_path migrated)
- godot-ops.ts: DELETED (1112 lines → 0)"
```

---

### Task 3: P0 性能优化 — Godot 二进制路径缓存

**Files:**
- Modify: `src/gdscript-executor.ts`
- Test: `test/gdscript-executor-cache.test.js`

在 `gdscript-executor.ts` 中缓存 `findGodot()` 结果到模块级变量，避免每次执行 GDScript 都搜索文件系统。

- [ ] **Step 1: 写缓存测试**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Godot path cache', () => {
  it('caches findGodot result after first call', async () => {
    // 验证第二次调用不重新搜索文件系统
  });

  it('returns same path on subsequent calls', async () => {
    // 路径一致性验证
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现路径缓存**

在 `gdscript-executor.ts` 顶部添加：

```typescript
let cachedGodotPath: string | null = null;

export function getCachedGodotPath(): string | null {
  return cachedGodotPath;
}

// 在 findGodot 成功后设置缓存
async function findGodotCached(): Promise<string | null> {
  if (cachedGodotPath !== null) {
    return cachedGodotPath;
  }
  const path = await findGodot();
  if (path !== null) {
    cachedGodotPath = path;
  }
  return path;
}
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-executor-cache.test.js
git commit -m "perf: cache Godot binary path in gdscript-executor (P0)"
```

---

### Task 4: P0 性能优化 — API 文档缓存

**Files:**
- Modify: `src/godot-docs.ts`
- Test: `test/godot-docs-cache.test.js`

缓存 `extension_api.json` 解析结果到模块级变量。

- [ ] **Step 1: 写缓存测试**

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现单条目缓存**

```typescript
let cachedApiData: ApiData | null = null;

async function loadApiData(projectPath: string): Promise<ApiData> {
  if (cachedApiData !== null) {
    return cachedApiData;
  }
  // 原有加载逻辑...
  cachedApiData = result;
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/godot-docs.ts test/godot-docs-cache.test.js
git commit -m "perf: cache extension_api.json parse result (P0)"
```

---

### Task 5: P1 UI 工具（Part 1） — 控件创建 + 布局

**Files:**
- Create: `src/tools/ui-tools.ts`
- Test: `test/ui-tools.test.js`

实现 4 个 UI 工具：`ui_create_control`, `ui_set_layout`, `ui_get_layout`, `ui_anchor_preset`。

- [ ] **Step 1: 写控件白名单和锚点预设的测试**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ui-tools Part 1', () => {
  describe('CONTROL_TYPE_WHITELIST', () => {
    it('contains all 29 required Control types', async () => {
      const { CONTROL_TYPE_WHITELIST } = await import('../src/tools/ui-tools.ts');
      assert.equal(CONTROL_TYPE_WHITELIST.length, 29);
      assert.ok(CONTROL_TYPE_WHITELIST.includes('Button'));
      assert.ok(CONTROL_TYPE_WHITELIST.includes('Label'));
      // ... 验证所有类型
    });
  });

  describe('ANCHOR_PRESETS', () => {
    it('maps all 16 LayoutPreset names', async () => {
      const { ANCHOR_PRESETS } = await import('../src/tools/ui-tools.ts');
      assert.equal(Object.keys(ANCHOR_PRESETS).length, 16);
      assert.ok('full_rect' in ANCHOR_PRESETS);
      assert.ok('center' in ANCHOR_PRESETS);
    });
  });

  describe('genCreateControlScript', () => {
    it('rejects invalid control type', async () => {
      // 测试白名单校验
    });
    it('generates GDScript for valid Button creation', async () => {
      // 测试脚本生成
    });
  });

  describe('genSetLayoutScript', () => {
    it('generates anchor + margin GDScript', async () => {
      // 测试布局设置
    });
  });

  describe('genGetLayoutScript', () => {
    it('generates layout query GDScript', async () => {
      // 测试布局查询
    });
  });

  describe('genAnchorPresetScript', () => {
    it('rejects invalid preset name', async () => {
      // 测试预设名校验
    });
    it('generates full_rect preset GDScript', async () => {
      // 测试预设应用
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现 ui-tools.ts Part 1**

```typescript
import type { ToolDefinition, ToolResult } from '../types.js';
import { executeGdscript } from '../gdscript-executor.js';
import { textResult } from '../types.js';
import { SCENE_TREE_HEADER, opsSuccess, opsErrorResult, parseGdscriptResult, NON_PERSIST } from './shared.js';

export const TOOL_NAMES = [
  'ui_create_control', 'ui_set_layout', 'ui_get_layout', 'ui_anchor_preset',
] as const;

export const CONTROL_TYPE_WHITELIST = [
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect',
  'ColorPickerButton', 'TabContainer', 'Tree', 'ItemList',
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer',
  'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
] as const;

export const ANCHOR_PRESETS: Record<string, number> = {
  top_left: 0, top_right: 1, bottom_left: 2, bottom_right: 3,
  center_left: 4, center_top: 5, center_right: 6, center_bottom: 7,
  center: 8, left_wide: 9, top_wide: 10, right_wide: 11,
  bottom_wide: 12, vcenter_wide: 13, hcenter_wide: 14, full_rect: 15,
};

export const UI_ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
};

// genCreateControlScript — GDScript 代码生成
// genSetLayoutScript — GDScript 代码生成
// genGetLayoutScript — GDScript 代码生成
// genAnchorPresetScript — GDScript 代码生成
// getToolDefinitions — 返回 4 个工具的 JSON Schema 定义
// handleTool — 路由到对应处理函数
// TOOL_META — 注册元数据
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: 注册到 GodotServer.ts**

- [ ] **Step 6: 提交**

```bash
git add src/tools/ui-tools.ts test/ui-tools.test.js src/GodotServer.ts
git commit -m "feat: add UI control/layout tools (Part 1: 4 tools) (P1)"
```

---

### Task 6: P1 UI/Theme 工具（Part 2） — 主题 + 容器

**Files:**
- Modify: `src/tools/ui-tools.ts`（追加 4 个工具）
- Modify: `test/ui-tools.test.js`（追加测试）

实现 4 个工具：`ui_set_theme`, `ui_container_add`, `theme_create`, `theme_set_property`。

- [ ] **Step 1: 写 Theme 操作测试**

```javascript
describe('ui-tools Part 2', () => {
  describe('genSetThemeScript', () => {
    it('generates theme creation and attachment GDScript', async () => {});
    it('generates theme save to .tres GDScript', async () => {});
  });

  describe('genContainerAddScript', () => {
    it('generates child add with container properties', async () => {});
  });

  describe('genThemeCreateScript', () => {
    it('generates empty Theme creation', async () => {});
    it('generates Theme extraction from node', async () => {});
  });

  describe('genThemeSetPropertyScript', () => {
    it('handles default_font item_type', async () => {});
    it('handles color item_type', async () => {});
    it('handles constant item_type', async () => {});
    it('handles stylebox item_type', async () => {});
    it('rejects invalid item_type', async () => {});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 在 ui-tools.ts 中追加 4 个工具**

更新 TOOL_NAMES：
```typescript
export const TOOL_NAMES = [
  'ui_create_control', 'ui_set_layout', 'ui_get_layout', 'ui_anchor_preset',
  'ui_set_theme', 'ui_container_add', 'theme_create', 'theme_set_property',
] as const;
```

实现 Theme 相关 GDScript 代码生成，使用 `ResourceSaver.save()` 持久化 .tres 文件（与 material-ops.ts 相同模式）。

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/tools/ui-tools.ts test/ui-tools.test.js
git commit -m "feat: add UI theme/container tools (Part 2: 4 tools, total 8) (P1)"
```

---

### Task 7: P2 高级动画编辑（5 工具）

**Files:**
- Modify: `src/tools/animation-ops.ts`（新增 animation_track/keyframe/curve/blend）
- Modify: `src/tools/animtree.ts`（新增 animtree_state_edit）
- Test: `test/animation-advanced.test.js`

- [ ] **Step 1: 写动画工具测试**

```javascript
describe('animation advanced tools', () => {
  describe('genTrackScript', () => {
    it('generates track add/remove GDScript with all 9 types', async () => {});
  });

  describe('genKeyframeScript', () => {
    it('generates keyframe add/remove/update GDScript', async () => {});
    it('sets transition curve correctly', async () => {});
  });

  describe('genCurveScript', () => {
    it('generates bezier handle GDScript', async () => {});
  });

  describe('genBlendScript', () => {
    it('generates AnimationPlayer.play() with blend_time', async () => {});
  });

  describe('genAnimtreeStateEditScript', () => {
    it('generates state position update GDScript', async () => {});
  });

  describe('TRACK_TYPES', () => {
    it('maps all 9 Godot TrackType values', async () => {});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 在 animation-ops.ts 追加 4 个工具**

新增 `animation_track`, `animation_keyframe`, `animation_curve`, `animation_blend`。animation_blend 使用 `AnimationPlayer.play(anim_name, blend_time, speed)`，不涉及 AnimationTree。

- [ ] **Step 4: 在 animtree.ts 追加 animtree_state_edit**

允许编辑状态机中状态的位置和混合值。

- [ ] **Step 5: 运行测试确认通过**

- [ ] **Step 6: 提交**

```bash
git add src/tools/animation-ops.ts src/tools/animtree.ts test/animation-advanced.test.js
git commit -m "feat: add advanced animation editing tools (5 tools) (P2)"
```

---

### Task 8: P3 录制/回放系统（5 工具）

**Files:**
- Create: `src/tools/recording.ts`
- Test: `test/recording.test.js`

实现 `recording_start`, `recording_stop`, `recording_save`, `recording_load`, `recording_play`。

- [ ] **Step 1: 写录制系统测试**

```javascript
describe('recording tools', () => {
  describe('sanitizeRecordingFileName', () => {
    it('accepts valid recording filenames', async () => {});
    it('rejects filenames with path traversal', async () => {
      // 测试 ".." / "/" / "\" 都被拒绝
    });
  });

  describe('genStartRecordingScript', () => {
    it('generates _input() callback registration GDScript', async () => {});
  });

  describe('genStopRecordingScript', () => {
    it('generates callback unregistration + event dump GDScript', async () => {});
  });

  describe('genSaveRecordingScript', () => {
    it('generates JSON file save to res://recordings/', async () => {});
  });

  describe('genLoadRecordingScript', () => {
    it('generates JSON file read GDScript', async () => {});
    it('rejects invalid filename format', async () => {});
  });

  describe('genPlayRecordingScript', () => {
    it('generates Timer-based event replay GDScript', async () => {});
    it('applies speed multiplier correctly', async () => {});
  });

  describe('event format validation', () => {
    it('produces valid event sequence JSON structure', async () => {});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 创建 recording.ts**

关键安全措施：
- 文件名由系统生成：`recording_YYYYMMDD_HHMMSS.json`
- `sanitizeRecordingFileName()` 拒绝 `/`、`..`、`\`
- 使用 `resolveWithinRoot()` 校验最终路径
- Bridge 未连接时返回 `BRIDGE_NOT_CONNECTED` 错误

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: 注册到 GodotServer.ts + 提交**

```bash
git add src/tools/recording.ts test/recording.test.js src/GodotServer.ts
git commit -m "feat: add recording/replay system (5 tools) (P3)"
```

---

### Task 9: P4 编辑器同步命令模块

**Files:**
- Create: `addons/mcp_bridge/commands/ui_commands.gd`（8 命令）
- Create: `addons/mcp_bridge/commands/animation_commands.gd`（4 命令）
- Create: `addons/mcp_bridge/commands/recording_commands.gd`（3 命令）

为编辑器插件创建同步命令，与 headless 工具共享参数格式。

- [ ] **Step 1: 创建 ui_commands.gd**

```gdscript
extends Node

var _command_handler: Node

func _ready():
	_command_handler = get_parent()

func _register_commands() -> void:
	_command_handler.register_command("ui_create_control", _ui_create_control)
	_command_handler.register_command("ui_set_layout", _ui_set_layout)
	_command_handler.register_command("ui_get_layout", _ui_get_layout)
	_command_handler.register_command("ui_anchor_preset", _ui_anchor_preset)
	_command_handler.register_command("ui_set_theme", _ui_set_theme)
	_command_handler.register_command("ui_container_add", _ui_container_add)
	_command_handler.register_command("theme_create", _theme_create)
	_command_handler.register_command("theme_set_property", _theme_set_property)

# 每个命令函数接受 params: Dictionary，返回 Dictionary 结果
```

- [ ] **Step 2: 创建 animation_commands.gd**

注册 `animation_track`, `animation_keyframe`, `animation_curve`, `animation_blend` 命令。

- [ ] **Step 3: 创建 recording_commands.gd**

注册 `recording_start`, `recording_stop`, `recording_play` 命令。

- [ ] **Step 4: 验证命令格式**

确保每个命令文件的 `_register_commands()` 函数被 command_handler.gd 正确加载。

- [ ] **Step 5: 提交**

```bash
git add addons/mcp_bridge/commands/ui_commands.gd addons/mcp_bridge/commands/animation_commands.gd addons/mcp_bridge/commands/recording_commands.gd
git commit -m "feat: add editor sync command modules for UI/animation/recording (P4)"
```

---

### Task 10: 版本号更新 + ROADMAP + 最终验证

**Files:**
- Modify: `package.json`（version: "0.7.0" → "0.9.0"）
- Modify: `src/GodotServer.ts`（VERSION 常量）
- Modify: `ROADMAP.md`（添加 v0.9.0 记录）

- [ ] **Step 1: 更新 package.json 版本号**

```json
{
  "version": "0.9.0"
}
```

- [ ] **Step 2: 更新 GodotServer.ts VERSION 常量**

- [ ] **Step 3: 更新 ROADMAP.md**

添加 v0.9.0 已完成记录：

```markdown
## v0.9.0 已完成（2026-05-16）

### P0 — 性能优化
- [x] Godot 二进制路径缓存（模块级变量）
- [x] API 文档单条目缓存（extension_api.json）

### P1 — UI/Theme 系统 + 架构重构
- [x] godot-ops.ts 完整拆分为 signal-ops/node-3d-ops/physics-ops/audio-ops + nav 迁移
- [x] UI/Theme 8 工具（控件创建/布局/主题/容器）

### P2 — 高级动画编辑
- [x] 5 个动画工具（轨道/关键帧/曲线/混合/状态编辑）

### P3 — 录制/回放系统
- [x] 5 个录制工具（开始/停止/保存/加载/回放）

### P4 — 编辑器插件扩展
- [x] 3 个同步命令模块（UI/动画/录制）

### 统计
- 工具数: 100 → ~123
- 测试覆盖: 0.12:1 → 0.18-0.20:1
- 新依赖: 0
```

- [ ] **Step 4: 运行全量测试**

Run: `npx tsx --test test/*.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 验证工具数**

Run: `npx tsx -e "import {GodotServer} from './src/GodotServer.js'; ..."` 
Expected: ~123

- [ ] **Step 6: 提交**

```bash
git add package.json src/GodotServer.ts ROADMAP.md
git commit -m "chore: bump version to 0.9.0, update ROADMAP"
```

- [ ] **Step 7: 最终验证提交**

确认所有 10 个 Task 的提交都在分支上，工具数正确，测试全绿。
