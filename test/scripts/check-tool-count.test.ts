import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkToolCount, readAuthority } from '../../scripts/check-tool-count.mjs';

// 用临时目录构造完整 fixture（覆盖全部 RULES 文件），验证 checkToolCount 逻辑分支。
// 真实仓库的一致性由 `node scripts/check-tool-count.mjs` 端到端验证。

let tmpRoot: string;
const TC = 2;  // fixture 工具数（测试权威值）
const AC = 5;  // fixture action 总数

/** 写齐所有 RULES 涉及的文件，工具数统一用 n（默认权威值 TC） */
function writeAllFiles(root: string, n: number = TC, a: number = AC) {
  writeFileSync(join(root, 'README.md'),
    `工具层:${n} 个 MCP 工具(merged,共 ${a} 个 action)\n| 工具数 | **${n}** |\n> 共 ${n} 个 MCP 工具(merged tool definition,共 ${a} 个 action)\n**顶层工具数:${n}**\n**action 总数:${a}**\n协议层实测通过（${n} 工具全发现`);
  writeFileSync(join(root, 'manifest.json'),
    `{"description":"and ${n} merged tools (${a} actions)","long_description":"provides ${n} merged MCP tools (${a} actions)"}`);
  writeFileSync(join(root, 'README.en.md'),
    `: ${n} MCP tools (merged\n| Tools | **${n}** |\n## Tools (${n})\n> **${n} MCP tools**\n(merged tool definitions, ${a} actions)`);
  mkdirSync(join(root, 'docs', 'distribution'), { recursive: true });
  writeFileSync(join(root, 'server.json'), `{"description": "test — ${n} tools"}`);
  writeFileSync(join(root, 'docs', 'distribution', 'README.md'),
    `with ${n} merged tools\n,${n} 个工具覆盖\nengine. ${n} tools (`);
  writeFileSync(join(root, 'docs', 'migration-from-coding-solo.md'),
    `进化为 ${n} 个 grouped tool\n→ ${n} 个 grouped tool`);
  mkdirSync(join(root, 'src', 'tools'), { recursive: true });
  writeFileSync(join(root, 'src', 'tools', 'rule-templates.ts'),
    `提供 ${n} 个 MCP 工具（${a} 个 action）`);
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(root, '.claude', 'rules', 'godot-mcp-core.md'),
    `提供 ${n} 个 MCP 工具（${a} 个 action）`);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tool-count-'));
  mkdirSync(join(tmpRoot, 'docs'), { recursive: true });
  // 权威源：2 个工具，action 总数 5
  writeFileSync(join(tmpRoot, 'docs', 'capability-matrix.json'), JSON.stringify({
    tools: [
      { name: 'a', riskDistribution: { read: 2, write: 1, destructive: 0, process: 0 } },
      { name: 'b', riskDistribution: { read: 1, write: 1, destructive: 0, process: 0 } },
    ],
  }));
  // 写齐所有业务文件且数字一致（各 case 按需覆盖）
  writeAllFiles(tmpRoot);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readAuthority', () => {
  it('从 capability-matrix.json 读出工具数与 action 总数', () => {
    const { toolCount, actionCount } = readAuthority(tmpRoot);
    expect(toolCount).toBe(TC);
    expect(actionCount).toBe(AC);
  });

  it('权威源缺失时抛错', () => {
    expect(() => readAuthority(join(tmpdir(), 'nonexistent-' + Date.now()))).toThrow(/权威源缺失/);
  });
});

describe('checkToolCount', () => {
  it('全部一致时 consistent=true 无 mismatches', () => {
    writeAllFiles(tmpRoot);  // 写齐所有文件，数字统一为权威值
    const r = checkToolCount(tmpRoot);
    expect(r.consistent).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.expected.toolCount).toBe(TC);
  });

  it('数字不匹配时报漂移', () => {
    writeAllFiles(tmpRoot, 9);  // 故意写错数字 9（≠ 权威 2）
    const r = checkToolCount(tmpRoot);
    expect(r.consistent).toBe(false);
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(r.mismatches.some(m => m.includes('9') && m.includes('2'))).toBe(true);
  });

  it('negate 规则：命中过时口径(130+)报漂移', () => {
    writeAllFiles(tmpRoot);
    // 在 manifest 注入 130+（应被 negate 规则捕获）
    writeFileSync(join(tmpRoot, 'manifest.json'),
      `{"description":"and ${TC} merged tools plus 130+ tools","long_description":"provides ${TC} merged MCP tools"}`);
    const r = checkToolCount(tmpRoot);
    expect(r.consistent).toBe(false);
    expect(r.mismatches.some(m => m.includes('130+'))).toBe(true);
  });

  it('业务文件缺失时报 MISS', () => {
    // 另造一个有权威源但缺业务文件的目录
    const partial = mkdtempSync(join(tmpdir(), 'tool-count-partial-'));
    mkdirSync(join(partial, 'docs'), { recursive: true });
    writeFileSync(join(partial, 'docs', 'capability-matrix.json'), JSON.stringify({
      tools: [{ name: 'x', riskDistribution: { read: 1, write: 0, destructive: 0, process: 0 } }],
    }));
    const r = checkToolCount(partial);
    expect(r.consistent).toBe(false);
    expect(r.mismatches.some(m => m.includes('MISS'))).toBe(true);
    rmSync(partial, { recursive: true, force: true });
  });
});
