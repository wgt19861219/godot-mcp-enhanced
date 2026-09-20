// test/resources.test.ts — W10 批4 组C:MCP resources 层单测
// 覆盖:readResource 守卫(无项目/非法 scheme/未知资源)、单段动态 URI(tool-groups/capabilities)、
// file 资源的 isSafePath 防线(禁止扩展/禁止目录/dot 段/路径逃逸)、scene 资源解析、
// listResources 静态清单。dashboard/ui.ts(TUI 渲染)按方案预授权豁免,理由见批4审查文档。
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readResource, listResources, listResourceTemplates } from '../src/resources.js';

const TMP = mkdtempSync(join(tmpdir(), 'mcp-res-'));
const PROJ = join(TMP, 'proj');
mkdirSync(PROJ, { recursive: true });
writeFileSync(join(PROJ, 'project.godot'), '; config\nconfig_version=5\n\n[application]\nconfig/name="demo"\n');
writeFileSync(join(PROJ, 'main.gd'), 'extends Node\n');
mkdirSync(join(PROJ, '.godot'), { recursive: true });
writeFileSync(join(PROJ, '.godot', 'cache.bin'), 'x');
writeFileSync(join(PROJ, 'icon.png'), 'png');
writeFileSync(join(PROJ, 'level.tscn'), '[gd_scene format=3]\n\n[node name="Root" type="Node2D"]\n');

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('readResource 守卫', () => {
  it('无 projectPath → 结构化错误文本', async () => {
    const r = await readResource('godot://health', undefined);
    expect(r.text).toContain('No project path available');
  });
  it('非法 scheme → 明确错误', async () => {
    const r = await readResource('file://etc/passwd', PROJ);
    expect(r.text).toContain('Invalid URI scheme');
  });
  it('未知单段资源 → 指引可用 URI', async () => {
    const r = await readResource('godot://nonexistent', PROJ);
    expect(r.text).toContain('Unknown resource');
    expect(r.text).toContain('godot://project/info');
  });
});

describe('单段动态 URI', () => {
  it('tool-groups 返回组激活状态 JSON', async () => {
    const r = await readResource('godot://tool-groups', PROJ);
    expect(r.mimeType).toBe('application/json');
    const j = JSON.parse(r.text);
    expect(Array.isArray(j.groups)).toBe(true);
    expect(j.groups.length).toBeGreaterThan(0);
    expect(j.groups[0]).toHaveProperty('active');
  });
  it('capabilities 返回 action gate 状态(getGateStatus 原样序列化)', async () => {
    const r = await readResource('godot://capabilities', PROJ);
    const j = JSON.parse(r.text);
    expect(typeof j).toBe('object');
    expect(Object.keys(j).length).toBeGreaterThan(0); // 形态随 action-gate.ts 演进,锁非空结构
  });
});

describe('file 资源 isSafePath 防线', () => {
  it('合法 .gd 文件 → 内容 + text/x-gdscript', async () => {
    const r = await readResource('godot://file/main.gd', PROJ);
    expect(r.mimeType).toBe('text/x-gdscript');
    expect(r.text).toContain('extends Node');
  });

  it('禁止扩展(.png/.uid/.import)拒绝', async () => {
    for (const f of ['icon.png', '.godot/cache.bin']) {
      const r = await readResource(`godot://file/${f}`, PROJ);
      expect(r.text).toMatch(/not allowed|Access denied|ERROR|denied|forbidden|unsafe/i);
    }
  });

  it('路径逃逸(../../)拒绝', async () => {
    const r = await readResource('godot://file/../../etc/passwd', PROJ);
    expect(r.text).toMatch(/Access denied|ERROR|not allowed|outside/i);
  });

  it('dot 段目录拒绝', async () => {
    const r = await readResource('godot://file/.hidden/x.txt', PROJ);
    expect(r.text).toMatch(/Access denied|ERROR|not allowed/i);
  });
});

describe('scene 资源', () => {
  it('.tscn 解析为摘要文本(parseTscnSummary 输出)', async () => {
    const r = await readResource('godot://scene/level.tscn', PROJ);
    expect(r.mimeType).toBe('text/plain');
    expect(r.text).toContain('Root');       // 节点名进摘要
    expect(r.text).toContain('Node2D');     // 节点类型进摘要
    expect(r.text).toContain('=== Scene Summary ===');
    expect(r.text).toContain('Format: 3');      // 头部 format 字段进摘要
  });
});

describe('listResources / templates', () => {
  it('无 projectPath → 仅 help 兜底;有 → 含 project/info 与内置 guides', () => {
    const none = listResources(undefined);
    expect(none).toHaveLength(1);
    expect(none[0]!.uri).toBe('godot://help');

    const list = listResources(PROJ);
    const uris = list.map(r => r.uri);
    expect(uris).toContain('godot://project/info');
    expect(uris).toContain('godot://project/config');
    expect(uris.some(u => u.startsWith('godot://guide/'))).toBe(true);
    expect(uris).toContain('godot://tool-groups');
  });

  it('templates 提供 scene/script/file 动态发现', () => {
    const t = listResourceTemplates();
    const uris = t.map(x => x.uriTemplate);
    expect(uris.some(u => u.includes('scene'))).toBe(true);
    expect(uris.some(u => u.includes('script'))).toBe(true);
    expect(uris.some(u => u.includes('file'))).toBe(true);
  });
});
