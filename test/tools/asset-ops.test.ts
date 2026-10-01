/**
 * T9 单测:asset-ops 工具 schema / 路由 / 错误码 / 裸 as 计数。
 *
 * 覆盖点（对应 brief Step 1）：
 *   1. getToolDefinitions()：1 个 merged asset 工具；action.enum=7 action；shape.enum=SHAPE_NAMES(11)。
 *   2. list_shapes：返 11 shape。
 *   3. list_materials：返 10 预设 + custom_rule/external 字段在。
 *   4. create（editor-only）：无 editor ctx → EDITOR_ONLY。
 *   5. save 非 res:// → INVALID_PATH（TS 侧前置校验，requireProjectPath 之前）。
 *   6. save 缺 resource_path → requireString 抛异常（非返 opsErrorResult）。
 *   7. 非 asset 工具名 → handleTool 返 null。
 *   8. 裸 as 计数：src/tools/asset/ 内 "args.x as" ≤1（仅 action enum 窄化，line 111）。
 *
 * PATH_NOT_ALLOWED（越界）标 skip：test/setup.js 设 GODOT_MCP_UNRESTRICTED=true，
 * isPathInAllowedRoots 恒返 true，该分支不可达；真实越界场景留 T10 E2E。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToolDefinitions, handleTool } from '../../src/tools/asset/asset-ops.js';
import { SHAPES, SHAPE_NAMES, MATERIAL_PRESETS } from '../../src/tools/asset/schema.js';

// list_* 不经 editor，ctx 可为空对象；写动作在本模块都返 EDITOR_ONLY，也不读 ctx。
const NO_CTX = {} as never;

// content[0].text TS union（TextContent|ImageContent|...）未窄化 → 2339。helper 消除重复 + 窄化。
function textOf(r: { content?: Array<{ type?: string; text?: string }> } | null): string {
  const c = r?.content?.[0];
  return c?.text ?? '';
}

describe('asset tool definitions', () => {
  it('注册 1 个 merged asset 工具，7 action', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('asset');
    const props = defs[0].inputSchema!.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(
      ['create', 'path', 'batch', 'undo', 'save', 'list_shapes', 'list_materials'],
    );
  });

  it('11 shape 全在 enum，与 SHAPE_NAMES 一致', () => {
    const props = getToolDefinitions()[0].inputSchema!.properties as Record<string, { enum?: string[] }>;
    expect(props.shape.enum).toEqual([...SHAPE_NAMES]);
    expect(SHAPES).toHaveLength(11);
    expect(SHAPE_NAMES).toHaveLength(11);
  });
});

describe('asset handleTool list_*', () => {
  it('list_shapes 返 11 shape', async () => {
    const r = await handleTool('asset', { action: 'list_shapes' }, NO_CTX);
    expect(r).toBeDefined();
    const parsed = JSON.parse(textOf(r));
    expect(parsed.shapes).toHaveLength(11);
    // 首项是 box（与 SHAPES[0] 一致），验证结构而非空数组
    expect(parsed.shapes[0].name).toBe('box');
  });

  it('list_materials 返 10 预设 + custom_rule/external 字段', async () => {
    const r = await handleTool('asset', { action: 'list_materials' }, NO_CTX);
    expect(r).toBeDefined();
    const parsed = JSON.parse(textOf(r));
    expect(parsed.presets).toEqual([...MATERIAL_PRESETS]);
    expect(parsed.presets).toHaveLength(10);
    expect(parsed.custom_rule).toBeDefined();
    expect(parsed.external).toBeDefined();
    expect(parsed.external).toContain('res://');
  });
});

describe('asset handleTool editor-only actions', () => {
  it('create 在 headless ctx 返 EDITOR_ONLY（isError=true）', async () => {
    // create 不调 requireProjectPath，project_path 仅占位，不触发白名单校验
    const r = await handleTool(
      'asset',
      { action: 'create', shape: 'box', project_path: '/tmp/p' },
      NO_CTX,
    );
    expect(r?.isError).toBe(true);
    expect(textOf(r)).toContain('EDITOR_ONLY');
  });

  it('save 非 res:// resource_path → INVALID_PATH（TS 前置校验，先于 requireProjectPath）', async () => {
    // requireString(resource_path) 通过 → startsWith('res://') 失败 → 返 INVALID_PATH。
    // 此分支在 requireProjectPath(line 154) 之前，project_path 占位值不触发白名单。
    const r = await handleTool(
      'asset',
      { action: 'save', node_path: '/Root/X', resource_path: '/etc/passwd', project_path: '/tmp/p' },
      NO_CTX,
    );
    expect(r?.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain('INVALID_PATH');
    expect(text).toContain('res://');
  });

  it('save 缺 resource_path → requireString 抛异常（非返 opsErrorResult）', async () => {
    // requireString 对 undefined 抛 Error；handleTool 不 try/catch，异常上抛。
    await expect(
      handleTool(
        'asset',
        { action: 'save', node_path: '/Root/X', project_path: '/tmp/p' },
        NO_CTX,
      ),
    ).rejects.toThrow(/resource_path/);
  });

  it('save 缺 project_path → requireProjectPath 内 requireString 抛异常', async () => {
    // resource_path 合法 res:// 通过前置校验后，requireProjectPath 取 project_path
    // → requireString 抛异常（缺 project_path）。
    await expect(
      handleTool(
        'asset',
        { action: 'save', node_path: '/Root/X', resource_path: 'res://out.tscn' },
        NO_CTX,
      ),
    ).rejects.toThrow(/project_path/);
  });

  // PATH_NOT_ALLOWED 越界：test/setup.js 设 GODOT_MCP_UNRESTRICTED=true，
  // isPathInAllowedRoots 恒返 true（path-utils.ts:259-267），该分支不可达。
  // 真实越界（符号链接/allowlist 外写）验证留 T10 E2E（真 Godot editor + 受限 env）。
  it.skip('save resource_path 越界 → PATH_NOT_ALLOWED（需受限 env，留 T10 E2E）', async () => {
    const r = await handleTool(
      'asset',
      { action: 'save', resource_path: 'res://evil.tscn', project_path: '/tmp/p' },
      NO_CTX,
    );
    expect(r?.isError).toBe(true);
    expect(textOf(r)).toContain('PATH_NOT_ALLOWED');
  });
});

describe('asset handleTool 路由', () => {
  it('非 asset 工具名 → 返 null（不归本模块处理）', async () => {
    const r = await handleTool('node', { action: 'list_shapes' }, NO_CTX);
    expect(r).toBeNull();
  });
});

describe('asset 裸 as 断言计数', () => {
  it('src/tools/asset/ 内 "args.x as" 出现 ≤1 次（仅 action enum 窄化）', () => {
    // 禁的是运行时类型断言 `args.x as T`；`as const`（编译期）不算。
    // asset-ops.ts:111 `args.action as string` 是模块唯一允许的裸 as
    // （action 经 inputSchema.enum 校验，TS 无法窄化）。
    // C-2 fix(2026-10-01 审查):原实现 execSync('grep … || true') 依赖 POSIX shell——
    // Windows 下 execSync 走 cmd.exe 继承进程 PATH,纯 cmd/PowerShell 会话(无 Git
    // coreutils)必失败。改 Node 读文件+正则,零 shell 依赖,任何启动环境稳定。
    const BARE_AS_RE = /args\.[a-z_]+ as /g;
    let count = 0;
    for (const f of readdirSync(join(process.cwd(), 'src', 'tools', 'asset'))) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(process.cwd(), 'src', 'tools', 'asset', f), 'utf8');
      count += (src.match(BARE_AS_RE) ?? []).length;
    }
    expect(count).toBeLessThanOrEqual(1);
  });
});
