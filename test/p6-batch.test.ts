import { describe, it, expect } from 'vitest';
import { tokenize, classifyFirstArgument, type Token } from '../src/core/gdscript-scanner.js';
import { scanGdscriptSandbox } from '../src/gdscript-executor.js';

/**
 * P6 批 (2026-09-11): tokenizer 移植(Erodenn) + Phase 3 非字面量 load 拦截。
 * 架构判断背景(为什么不移植三级 tier):execute_gdscript actionRisk='process' 已 100% 经
 * 确认令牌,Erodenn Tier 2 elicit 在 enhanced 是重复建设且降级是安全回退——只取 tokenizer
 * 的结构化能力(classifyFirstArgument 括号深度感知,正则做不到)。
 */

function chains(code: string): string[] {
  return tokenize(code).filter((t): t is Token & { kind: 'memberChain' } => t.kind === 'memberChain').map(t => t.text);
}

describe('P6-1: tokenizer 基础行为(Erodenn 移植)', () => {
  it('TOK-a: memberChain 合并(OS.execute → 单 token 双段)', () => {
    const c = chains('OS.execute("x")');
    expect(c).toEqual(['OS.execute']);
    const toks = tokenize('OS.execute("x")');
    const mc = toks.find(t => t.kind === 'memberChain') as { chain?: string[] };
    expect(mc.chain).toEqual(['OS', 'execute']);
  });

  it('TOK-b: 字符串/注释内容不产 token(策略绝不匹配 "OS.execute" 字面量内部)', () => {
    const src = 'var s = "OS.execute"\n# OS.execute comment\nprint(s)';
    const toks = tokenize(src);
    expect(toks.some(t => t.kind === 'memberChain' && t.text === 'OS.execute')).toBe(false);
    // 字符串整体一个 token
    expect(toks.filter(t => t.kind === 'string').length).toBe(1);
  });

  it('TOK-c: 空白/换行容忍的链合并(OS .\\n execute 仍是一个链)——Erodenn 的 skeleton key 修复', () => {
    const src = 'OS .\n  execute("x")';
    expect(chains(src)).toEqual(['OS.execute']);
  });

  it('TOK-d: 三引号字符串/$节点路径/^StringName 归一化为 string token', () => {
    const src = 'var a = """multi\nline"""\nvar b = $Foo/Bar\nvar c = ^"name"';
    const toks = tokenize(src);
    const strs = toks.filter(t => t.kind === 'string');
    expect(strs.length).toBe(3);
    expect(strs.map(t => t.text)).toEqual(['<triple-string>', '<node-path>', '<string-name>']);
  });

  it('TOK-e: classifyFirstArgument 三分类(literal/none/nonliteral)', () => {
    // literal: 孤立 string
    let toks = tokenize('f("res://a")');
    let op = toks.findIndex(t => t.kind === 'punct' && t.text === '(');
    expect(classifyFirstArgument(toks, op)).toBe('literal');
    // none: 无参
    toks = tokenize('f()');
    op = toks.findIndex(t => t.kind === 'punct' && t.text === '(');
    expect(classifyFirstArgument(toks, op)).toBe('none');
    // nonliteral: 纯变量
    toks = tokenize('f(p)');
    op = toks.findIndex(t => t.kind === 'punct' && t.text === '(');
    expect(classifyFirstArgument(toks, op)).toBe('nonliteral');
    // nonliteral: 前导字面量拼接("a" + b 不被 "a" 骗过)
    toks = tokenize('f("res://" + evil)');
    op = toks.findIndex(t => t.kind === 'punct' && t.text === '(');
    expect(classifyFirstArgument(toks, op)).toBe('nonliteral');
    // literal: 嵌套括号不误判(depth 感知,整首参仍是单表达式——f(("a")) 内层括号)
    toks = tokenize('f(g(p), "second")');
    op = toks.findIndex(t => t.kind === 'punct' && t.text === '(');
    expect(classifyFirstArgument(toks, op)).toBe('nonliteral');
  });
});

describe('P6-2: Phase 3 非字面量 load 拦截(scanGdscriptSandbox)', () => {
  const NONLITERAL = 'non-literal path';

  it('P3-a: 纯变量 load/preload 被拦(此前正则零特征漏网)', () => {
    expect(scanGdscriptSandbox('var p = "C:/x"\nload(p)')).toEqual(
      expect.arrayContaining([expect.stringContaining('load() with ' + NONLITERAL)]));
    expect(scanGdscriptSandbox('preload(p)')).toEqual(
      expect.arrayContaining([expect.stringContaining('preload() with ' + NONLITERAL)]));
  });

  it('P3-b: 字面量拼接 "res://" + x 被拦(不被前导 res:// 字面量骗过)', () => {
    expect(scanGdscriptSandbox('load("res://" + evil)')).toEqual(
      expect.arrayContaining([expect.stringContaining(NONLITERAL)]));
  });

  it('P3-c: ResourceLoader.load 非字面量同样拦;纯字面量 res:// 放行(回归锚)', () => {
    expect(scanGdscriptSandbox('ResourceLoader.load(p)')).toEqual(
      expect.arrayContaining([expect.stringContaining('ResourceLoader.load() with ' + NONLITERAL)]));
    // 纯字面量 res:// 走既有正则路径(res:// 放行)
    expect(scanGdscriptSandbox('load("res://a.tscn")')).toEqual([]);
  });

  it('P3-d: 函数调用首参被拦;非调用上下文的 load 标识符不误报', () => {
    expect(scanGdscriptSandbox('load(get_path())')).toEqual(
      expect.arrayContaining([expect.stringContaining(NONLITERAL)]));
    // var load = 1(标识符引用,无调用括号)不误报
    expect(scanGdscriptSandbox('var load = 1\nprint(load)').some(w => w.includes(NONLITERAL))).toBe(false);
  });

  it('P3-e: 注释/字符串里的 load(变量) 不误报(tokenizer 剥离)', () => {
    const src = '# load(p) comment\nvar s = "load(p)"\nprint(s)';
    expect(scanGdscriptSandbox(src).some(w => w.includes(NONLITERAL))).toBe(false);
  });

  it('P3-g: runtime 通道只跳 Phase 3,Phase 1/2 防线保留(与全豁免 Trusted 区分)', async () => {
    // skipPhase3: 非字面量 load 不拦
    expect(scanGdscriptSandbox('var p = "x"\nload(p)', { skipPhase3: true }).some(w => w.includes(NONLITERAL))).toBe(false);
    // 但 Phase 1 危险 API 正则仍拦(OS.execute 与非字面量 load 并存时,OS.execute 那条命中)
    const w = scanGdscriptSandbox('var p = "x"\nload(p)\nOS.execute("calc")', { skipPhase3: true });
    expect(w.some(x => x.includes('OS system command'))).toBe(true);
    // Phase 2 拼接仍拦
    const w2 = scanGdscriptSandbox('var s = "OS" + ".execute"\nprint(s)', { skipPhase3: true });
    expect(w2.length).toBeGreaterThan(0);
  });

  it('P3-h: script execute 工具本体保持普通通道(AI 自由代码不豁免)', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    // 批7(2026-09-20) script.ts 拆分后 execute_gdscript 落位 script/execute.ts
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools', 'script', 'execute.ts'), 'utf8');
    expect(src).toContain("executeGdscript } from '../../gdscript-executor.js'");
    expect(src).not.toContain('executeGdscriptRuntime');
  });

  it('P3-f: 内部脚本样本零新增误报(godot_operations.gd 等大量 load(变量) 不在扫描面)', async () => {
    // scanGdscriptSandbox 的输入源全部是 AI 提供代码(execute code/write content/override/assertion),
    // 内部 .gd 直接 spawn 不经扫描——本用例锁定该事实(防止未来有人把内部脚本塞进扫描面
    // 触发大规模误报)。
    const { readFileSync, readdirSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scripts');
    // 模拟"如果"内部脚本被扫描:统计非字面量 load 命中数(预期 >0,证明它们确实不能进扫描面)
    let wouldFlag = 0;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.gd'))) {
      const code = readFileSync(resolve(dir, f), 'utf8');
      if (scanGdscriptSandbox(code).some(w => w.includes(NONLITERAL))) wouldFlag++;
    }
    expect(wouldFlag).toBeGreaterThan(0);  // 内部脚本确有合法 load(变量),佐证隔离设计的必要性
  });
});
