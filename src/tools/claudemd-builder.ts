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

  if (typeof gravity3d === 'number' && gravity3d !== 9.8) {
    lines.push(`- 3D 重力: ${gravity3d}`);
  }
  if (typeof gravity2d === 'number' && gravity2d !== 980) {
    lines.push(`- 2D 重力: ${gravity2d}`);
  }
  if (typeof fps === 'number' && fps !== 60) {
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
    const match = layerPart.match(/layer_(\d+)/);
    if (!match) continue;
    const idx = parseInt(match[1], 10);

    if (!groups[group]) groups[group] = [];
    groups[group].push({ idx, name: value });
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
  return '| 领域 | rules 文件 |\n|------|-----------|\n| 脚本开发 | .claude/rules/godot-mcp.md |';
}

// ─── Merge Engine ─────────────────────────────────────────────────────────

interface Section {
  header: string;
  headerNorm: string;
  body: string;
  isMcp: boolean;
}

function normalizeHeader(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function parseSections(content: string): { title: string; preSections: string; sections: Section[] } {
  const lines = content.split('\n');

  // Extract title (# ...)
  let title = '';
  let titleEndIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^# /.test(lines[i])) {
      title = lines[i];
      titleEndIdx = i + 1;
      break;
    }
  }

  // Collect text between title and first ## header
  let preSections = '';
  let firstSectionIdx = lines.length;
  for (let i = titleEndIdx; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      firstSectionIdx = i;
      break;
    }
    preSections += (preSections ? '\n' : '') + lines[i];
  }
  preSections = preSections.trim();

  // Parse ## sections
  const sections: Section[] = [];
  let current: Section | null = null;

  for (let i = firstSectionIdx; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^##\s+(.*)/);
    if (headerMatch) {
      if (current) sections.push(current);
      const fullHeader = '## ' + headerMatch[1].trim();
      const norm = normalizeHeader(fullHeader);
      current = {
        header: fullHeader,
        headerNorm: norm,
        body: '',
        isMcp: SECTION_IDS.has(norm),
      };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + lines[i];
    }
  }
  if (current) sections.push(current);

  return { title, preSections, sections };
}

export function mergeSections(existing: string, newSections: Array<[string, string]>): string {
  if (!existing.trim()) {
    return newSections.map(([h, b]) => `${h}\n${b}`).join('\n\n') + '\n';
  }

  const { title, preSections, sections } = parseSections(existing);

  // Collect user (non-MCP) sections in original order
  const userSections = sections.filter(s => !s.isMcp);

  // Build output
  const parts: string[] = [];
  if (title) parts.push(title);

  // New MCP sections
  for (const [header, body] of newSections) {
    parts.push(`${header}\n${body}`);
  }

  // User pre-section text
  if (preSections) parts.push(preSections);

  // User sections
  for (const s of userSections) {
    parts.push(s.body.trim() ? `${s.header}\n${s.body}` : s.header);
  }

  return parts.join('\n\n') + '\n';
}
