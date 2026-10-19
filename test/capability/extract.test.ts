// test/capability/extract.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../../src/module-loader.js';
import { getAllToolDefinitions, getGroupForTool, TOOL_GROUPS } from '../../src/core/tool-registry.js';
import { extractCapabilities } from '../../src/capability/extract.js';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('extractCapabilities', () => {
  it('returns one record per registered tool with no duplicate names', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    // 每个注册工具一条记录（registry 返回 merged tool 名，实际 ~28 个）
    expect(caps.length).toBe(getAllToolDefinitions().length);
    expect(caps.length).toBeGreaterThan(20);
    // 无重名
    const names = caps.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('populates A/B/C/D fields for a known tool (scene)', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const scene = caps.find(c => c.name === 'scene');
    expect(scene).toBeDefined();
    // A. 真实契约
    expect(scene!.group).toBe(getGroupForTool('scene')); // 'core'
    expect(typeof scene!.description).toBe('string');
    expect(scene!.inputSchema).toBeTypeOf('object');
    expect(Array.isArray(scene!.requiredParams)).toBe(true);
    expect(Array.isArray(scene!.optionalParams)).toBe(true);
    // B. 执行特征
    expect(scene!.readonly).toBe(false);        // scene 含写工具
    expect(scene!.guarded).toBe(true);          // scene 的 actionRisks 含非 read 级别
    expect(scene!.securityLevel).toBe('danger-api'); // core 组（scene 工具 group=core）的 script.ts 含 execute_gdscript 命中 DANGER_PATTERNS → 组级保守标注 danger-api（spec §3.1）
    // C. 依赖条件
    expect(scene!.offlineCapable).toBe(false);  // scene 不在 OFFLINE_TOOLS
    expect(scene!.needsGodot).toBe(true);       // 非 offline
    expect(scene!.groupRequires).toEqual(TOOL_GROUPS[scene!.group]!.requires); // core.requires = []
    expect(scene!.needsEditor).toBe(false);
    // D. 静态 grep + 验证状态
    expect(scene!.gdScriptImpl.headless.exists).toBe(false);
    expect(scene!.verification.l1).toBe('extracted');
    expect(scene!.verification.l2).toBe('none');
    expect(scene!.verification.l3).toBe('unverified');
    expect(scene!.verification.lastRun).toBeNull();
    expect(scene!.relatedDefects).toEqual([]);
  });

  it('offline tool (validation) is offlineCapable + needsGodot false', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const v = caps.find(c => c.name === 'validation');
    expect(v).toBeDefined();
    expect(v!.offlineCapable).toBe(true);
    expect(v!.needsGodot).toBe(false);
  });

  it('populates E. size fields (descBytes/schemaBytes/totalBytes) for each tool', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    expect(caps.length).toBeGreaterThan(0);
    // B4 (2026-10-19): schemaBytes 口径含 outputSchema(typed outputs 进 tools/list 载荷),
    // 无 outputSchema 的工具恰好等于 inputSchema 字节;有则为其增量
    const defByname = new Map(getAllToolDefinitions().map(t => [t.name, t]));
    for (const c of caps) {
      expect(c.size).toBeDefined();
      expect(c.size.descBytes).toBe(Buffer.byteLength(c.description, 'utf8'));
      const def = defByname.get(c.name);
      const expected = Buffer.byteLength(JSON.stringify(def?.inputSchema ?? {}), 'utf8')
        + (def?.outputSchema ? Buffer.byteLength(JSON.stringify(def.outputSchema), 'utf8') : 0);
      expect(c.size.schemaBytes).toBe(expected);
      expect(c.size.totalBytes).toBe(c.size.descBytes + c.size.schemaBytes);
      expect(c.size.descBytes).toBeGreaterThan(0); // 每个工具有非空描述
    }
  });

  // P1-2 review Nit 3: F 组 annotations 字段在 extract 层应定义
  it('F. populates annotations (three boolean hints) for each tool', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    expect(caps.length).toBeGreaterThan(0);
    const missing = caps.filter(
      c =>
        !c.annotations ||
        typeof c.annotations.readOnlyHint !== 'boolean' ||
        typeof c.annotations.destructiveHint !== 'boolean' ||
        typeof c.annotations.idempotentHint !== 'boolean',
    );
    expect(missing.map(c => c.name), `caps missing F.annotations: ${missing.map(c => c.name).join(', ')}`).toEqual([]);
  });
});
