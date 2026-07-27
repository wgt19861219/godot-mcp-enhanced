// src/tools/claudemd-builder.ts
import { existsSync } from 'fs';
import { join } from 'path';
import type { GodotConfig } from '../helpers.js';
import { getLogger } from '../core/logger.js';
import { mergeSections as mergeSectionsGeneric } from './shared/section-merge.js';

// MCP 管理的章节标识（含旧格式，用于识别并替换）
export const SECTION_IDS = new Set([
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射', '## Godot MCP Rules', '## GDScript 类型规范',
  '## 代码最佳实践',
]);

// MCP 章节的固定顺序（仅新格式，用于幂等性检测和输出顺序）
export const SECTION_ORDER: string[] = [
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射', '## GDScript 类型规范', '## 代码最佳实践',
];

// 绑定 CLAUDE.md 的 SECTION_IDS，保持调用方（project.ts）签名不变
export function mergeSections(existing: string, newSections: Array<[string, string]>): string {
  return mergeSectionsGeneric(existing, newSections, SECTION_IDS);
}

// godot-mcp.md 固定模板内容
// {{MCP_VERSION}} 占位符由 setup_project_rules 在写入时插值（与 DETAILED_RULE_TEMPLATES 统一路径）
export const GODOT_MCP_RULES = `# Godot MCP 开发规则

> 适用于 godot-mcp-enhanced {{MCP_VERSION}}+

## 通用原则
- 标注"运行时操作"的工具仅影响当前进程，如需持久化请编辑 .tscn/.gd 文件
- 运行时工具的结果不会跨进程保留

## 脚本开发
- edit_script / write_script 后必须立即调用 validate_scripts 验证
- 验证失败时回滚修改
- project_replace 先用 dry_run=true 预览变更

## 场景管理
- 修改 .tscn 后用 read_scene 验证结构完整性
- 节点路径变更后检查所有 signal 连接是否失效
- remove_node 为破坏性操作，确认后再执行

## 信号系统
- signal_emit 仅支持基本类型（string/number/bool/null）
- 节点重命名/删除后检查关联信号连接

## 动画系统
- animation / animtree 操作为运行时操作
- 动画名称须在 AnimationPlayer 中已存在

## 音频
- 运行时操作，不持久化
- 音量单位 dB（-80 到 24）

## UI
- 运行时操作，不持久化
- 复杂布局优先用 ui_build_layout

## TileMap
- 运行时操作，不持久化
- 坐标为 Vector2i 格式

## 物理
- physics 工具包含 raycast / body_info / diagnose / query_spatial / collision_overlay 五种操作
- diagnose 操作有副作用（使用 move_and_collide test_only）

## 导航
- nav(action=bake_mesh) 为长耗时操作
- 运行时操作，不持久化

## 粒子
- 运行时操作，不持久化
- 推荐用 particles_create 的 preset 参数

## 材质与着色器
- shader_edit write 模式替换整个着色器
- 运行时操作，不持久化

## IK 与 3D
- 运行时操作，不持久化
- TwoBoneIK3D 推荐指定 bone_name 参数

## 运行时管理
- run_project 有超时设置，长时间运行需调整
- launch_editor 启动编辑器 GUI，stop_project 终止运行中的进程
- dev_loop 可执行任意 GDScript 代码

## 截图与调试
- capture_screenshot 为实验性功能（headless 模式下渲染受限）
- profiler 用于性能分析（snapshot/start/stop/get_data）

## 游戏桥接
- 需先安装 bridge 并启动游戏
- game_write 可修改运行时状态，谨慎使用

## 发版门禁
- 提交版本号变更前必须运行 verify_delivery(scope="full")
- 所有维度必须无错误

## GDScript 规范
- 使用静态类型（var x: int = 0）
- 函数必须标注返回类型
- 信号回调以 _on_ 前缀命名
`;

// ─── Simple builders ──────────────────────────────────────────────────────

export function buildEngineVersion(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const features = app['config/features'];
  let version = '';

  if (typeof features === 'string') {
    // PackedStringArray("4.6", ...) → extract first quoted value
    const m = features.match(/PackedStringArray\("([^"]+)"/);
    version = m ? m[1]! : features;
  } else if (Array.isArray(features) && features.length > 0) {
    version = String(features[0]);
  }

  if (!version) version = '4.x（版本未知）';
  return `- Godot ${version}`;
}

export function buildRenderer(config: GodotConfig | null): string | null {
  if (!config) return null;
  const rendering = config.rendering as Record<string, unknown> | undefined;
  if (!rendering) return null;

  const renderer = rendering['renderer/rendering_method'] ?? rendering['renderer'];
  if (!renderer || typeof renderer !== 'string') return null;
  return `- ${renderer}`;
}

export function buildMainScene(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const scene = app['run/main_scene'] ?? app['run_main_scene'];
  if (!scene || typeof scene !== 'string') return null;
  return `- ${scene}`;
}

// ─── KeyPaths & Autoloads builders ────────────────────────────────────────

const KNOWN_DIRS: Array<{ name: string; label: string }> = [
  { name: 'scenes', label: '场景文件' },
  { name: 'scripts', label: 'GDScript 脚本' },
  { name: 'assets', label: '资源文件' },
  { name: 'addons', label: '插件' },
  { name: 'shaders', label: '着色器' },
  { name: 'resources', label: '资源定义' },
  { name: 'sounds', label: '音效' },
  { name: 'music', label: '音乐' },
  { name: 'data', label: '数据文件' },
];

export function buildKeyPaths(projectDir: string): string | null {
  const existing: string[] = [];
  for (const { name, label } of KNOWN_DIRS) {
    try {
      if (existsSync(join(projectDir, name))) {
        existing.push(`├── ${name}/ — ${label}`);
      }
    } catch (err) { getLogger().debug('claudemd', `checking known dirs: ${err instanceof Error ? err.message : err}`); }
  }
  if (existing.length === 0) return null;
  // Fix last prefix: ├── → └──
  existing[existing.length - 1] = existing[existing.length - 1]!.replace('├──', '└──');
  return existing.join('\n');
}

export function buildAutoloads(config: GodotConfig | null): string | null {
  if (!config) return null;
  const autoload = config.autoload as Record<string, unknown> | undefined;
  if (!autoload) return null;

  const entries = Object.entries(autoload);
  if (entries.length === 0) return null;

  const rows = entries.map(([name, rawPath]) => {
    const path = typeof rawPath === 'string' ? rawPath.replace(/^\*/, '') : String(rawPath);
    const display = path.length > 40 ? path.slice(0, 37) + '…' : path;
    return `| ${name} | ${display} |`;
  });

  return '| 名称 | 路径 |\n|------|------|\n' + rows.join('\n');
}

// Godot 引擎默认物理参数（4.x）
const GODOT_DEFAULTS = { gravity3d: 9.8, gravity2d: 980, physicsFps: 60 };

// ─── InputMap, Physics, LayerNames, McpMapping builders ────────────────────

export function buildInputMap(config: GodotConfig | null): string | null {
  if (!config) return null;
  const input = config.input as Record<string, unknown> | undefined;
  if (!input) return null;

  const actions = Object.keys(input);
  if (actions.length === 0) return null;

  if (actions.length > 15) {
    const shown = actions.slice(0, 15).join(', ');
    return `- actions: ${shown}，等 ${actions.length} 项`;
  }

  const lines: string[] = [];
  for (let i = 0; i < actions.length; i += 5) {
    lines.push('- ' + actions.slice(i, i + 5).join(', '));
  }
  return lines.join('\n');
}

export function buildPhysics(config: GodotConfig | null): string | null {
  if (!config) return null;
  const physics = config.physics as Record<string, unknown> | undefined;
  if (!physics) return null;

  const lines: string[] = [];
  const gravity3d = physics['3d/default_gravity'];
  const gravity2d = physics['2d/default_gravity'];
  const fps = physics['common/physics_fps'];

  if (typeof gravity3d === 'number' && gravity3d !== GODOT_DEFAULTS.gravity3d) {
    lines.push(`- 3D 重力: ${gravity3d}`);
  }
  if (typeof gravity2d === 'number' && gravity2d !== GODOT_DEFAULTS.gravity2d) {
    lines.push(`- 2D 重力: ${gravity2d}`);
  }
  if (typeof fps === 'number' && fps !== GODOT_DEFAULTS.physicsFps) {
    lines.push(`- 物理 FPS: ${fps}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildLayerNames(config: GodotConfig | null): string | null {
  if (!config) return null;
  const layers = config.layer_names as Record<string, unknown> | undefined;
  if (!layers) return null;

  const groups: Record<string, Array<{ idx: number; name: string }>> = {};

  for (const [key, value] of Object.entries(layers)) {
    if (!value || typeof value !== 'string') continue;
    const parts = key.split('/');
    if (parts.length !== 2) continue;
    const group = parts[0];
    const layerPart = parts[1];
    const match = layerPart!.match(/layer_(\d+)/);
    if (!match) continue;
    const idx = parseInt(match[1]!, 10);

    if (!groups[group!]) groups[group!] = [];
    groups[group!]!.push({ idx, name: value });
  }

  const LABELS: Record<string, string> = {
    '2d_physics': '2D 物理', '2d_render': '2D 渲染',
    '3d_physics': '3D 物理', '3d_render': '3D 渲染',
  };

  const lines: string[] = [];
  for (const [group, items] of Object.entries(groups)) {
    items.sort((a, b) => a.idx - b.idx);
    const label = LABELS[group] ?? group;
    const summary = items.map(it => `${it.idx}=${it.name}`).join(', ');
    lines.push(`- ${label}: ${summary}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildMcpMapping(): string {
  return [
    '| 领域 | rules 文件 |',
    '|------|-----------|',
    '| 全部工具规则 | .claude/rules/godot-mcp.md |',
    '| 核心决策树 | .claude/rules/godot-mcp-core.md |',
    '| Game Bridge | .claude/rules/godot-mcp-bridge.md |',
    '| 编辑器模式 | .claude/rules/godot-mcp-editor.md |',
    '| UI 布局 | .claude/rules/godot-mcp-ui.md |',
    '| 录制回放 | .claude/rules/godot-mcp-recording.md |',
    '| 引擎陷阱 | .claude/rules/godot-mcp-engine-quirks.md |',
  ].join('\n');
}

export function buildTypeGuide(): string {
  return [
    '- **严格类型标注**: `var speed: float = 100.0` (不要 `var speed = 100`)',
    '- **函数参数和返回值**: `func move(dir: Vector2) -> void:`',
    '- **@export 带类型**: `@export var health: int = 100`',
    '- **@onready 带类型**: `@onready var sprite: Sprite2D = $Sprite2D`',
    '- **信号用过去式**: `signal health_changed(new_value: int)`',
    '- **常量 UPPER_SNAKE**: `const MAX_SPEED: float = 300.0`',
    '- **PascalCase 节点名, snake_case 变量**',
    '- **class_name 注册可复用类**: `class_name Player extends CharacterBody3D`',
    '',
    '> 为什么重要：动态类型是 MCP 工具调用失败的首要原因（DEV.to 2026-05-20 横评确认）。',
  ].join('\n');
}

export function buildBestPractices(): string {
  return [
    '### 信号代替轮询',
    '- **用信号驱动状态变化**，而非在 `_process` 中轮询检查',
    '  ```gdscript',
    '  # ❌ 每帧检查',
    '  func _process(delta):',
    '      if enemy.dead: queue_free()',
    '',
    '  # ✅ 信号驱动',
    '  func _ready():',
    '      enemy.died.connect(queue_free)',
    '  ```',
    '- **缓存节点引用**：在 `_ready()` 中用 `@onready` 获取，不要在 `_process` 内 `get_node()`',
    '',
    '### 分离关注点',
    '- **管理器类只管逻辑**，UI 类只管显示，数据类只管状态',
    '- 典型拆分：`BuildManager`（逻辑）+ `BuildUI`（界面）+ `BuildingData`（数据）',
    '- 单个脚本超过 300 行时考虑拆分',
    '',
    '### 避免常见陷阱',
    '- **检查父类成员**：`velocity`、`position`、`state` 等常见名在 `extends CharacterBody3D` 时会覆盖基类属性',
    '- **Godot 4 API 变更**：`AnimationPlayer.add_animation()` 已移除，用 `get_animation_library("").add_animation()`',
    '- **默认动画库可能不存在**：首次添加动画前检查 `has_animation_library("")` 或创建 `AnimationLibrary`',
    '- **减少每帧计算**：避免 `_process` 内的字符串拼接、数组创建、复杂数学运算',
  ].join('\n');
}

// ─── Merge Engine ─────────────────────────────────────────────────────────
// parseSections / mergeSections / Section / normalizeHeader 已抽离到
// src/tools/shared/section-merge.ts（参数化 sectionIds，供 AGENTS.md builder 复用）。
// 本文件通过上方 mergeSections 包装绑定 SECTION_IDS，保持 project.ts 零改动。

