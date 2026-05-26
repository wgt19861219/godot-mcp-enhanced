// src/tools/claudemd-builder.ts
import { readdirSync } from 'fs';
import { join } from 'path';
import type { GodotConfig } from '../helpers.js';

// MCP 管理的章节标识（用于合并检测）
export const SECTION_IDS = new Set([
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射', '## Godot MCP Rules',
]);

// MCP 章节的固定顺序
export const SECTION_ORDER: string[] = [
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射',
];

// godot-mcp.md 固定模板内容
export const GODOT_MCP_RULES = `# Godot MCP 开发规则

## 脚本编辑
- edit_script / write_script 后必须立即调用 validate_scripts 验证
- 验证失败时回滚修改

## 发版门禁
- 提交版本号变更前必须运行 verify_delivery(scope="full")
- 所有维度必须无错误

## 场景操作
- 修改 .tscn 后用 read_scene 验证结构完整性
- 节点路径变更后检查所有 signal 连接是否失效

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
    version = m ? m[1] : features;
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
      if (readdirSync(join(projectDir, name))) {
        existing.push(`├── ${name}/ — ${label}`);
      }
    } catch { /* not found */ }
  }
  if (existing.length === 0) return null;
  // Fix last prefix: ├── → └──
  existing[existing.length - 1] = existing[existing.length - 1].replace('├──', '└──');
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
