import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGodotProjectRoots, summarizeActions, runRules } from '../../src/cli/rules.js';
import { SUBCOMMANDS } from '../../src/cli/router.js';

// P2-1(2026-10-24 规则分发可靠性批):CLI rules 子命令——批量分发与 MCP
// setup_project_rules 同源(distributeRules),CLI 进程恒新免疫旧进程毒化。

describe('findGodotProjectRoots(白名单条目 → Godot 项目根探测)', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'cli-rules-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('root 自身是 Godot 项目 → 直接返回 root', () => {
    writeFileSync(join(base, 'project.godot'), '');
    expect(findGodotProjectRoots(base)).toEqual([base]);
  });

  it('子目录是项目(monorepo 形态 TMXYH5/client)→ 深度 2 内探测到', () => {
    mkdirSync(join(base, 'TMXYH5', 'client'), { recursive: true });
    writeFileSync(join(base, 'TMXYH5', 'client', 'project.godot'), '');
    expect(findGodotProjectRoots(base)).toEqual([join(base, 'TMXYH5', 'client')]);
  });

  it('多个项目全探测到', () => {
    for (const name of ['projA', 'projB']) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(join(base, name, 'project.godot'), '');
    }
    const found = findGodotProjectRoots(base);
    expect(found).toHaveLength(2);
  });

  it('深度超限(>2)不探测', () => {
    mkdirSync(join(base, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(base, 'a', 'b', 'c', 'project.godot'), '');
    expect(findGodotProjectRoots(base)).toEqual([]);
  });

  it('隐藏目录跳过 + 不存在的 root 返回空(不抛)', () => {
    mkdirSync(join(base, '.git', 'deep'), { recursive: true });
    writeFileSync(join(base, '.git', 'deep', 'project.godot'), '');
    expect(findGodotProjectRoots(base)).toEqual([]);
    expect(findGodotProjectRoots(join(base, 'nope'))).toEqual([]);
  });
});

describe('summarizeActions(report.actions → 单行摘要)', () => {
  it('提取 rules 前缀行,拼接为一行', () => {
    const line = summarizeActions([
      'hooks: updated .claude/settings.json',
      'CLAUDE.md: merged new sections into existing file',
      'rules: 更新 3 个文件（a.md, b.md）',
      'rules: content-drift 修复 1 个文件（ui.md）— 内容指纹不符',
      'AGENTS.md: updated (force)',
    ]);
    expect(line).toContain('更新 3 个文件');
    expect(line).toContain('content-drift 修复 1 个文件');
    expect(line).not.toContain('hooks');
  });

  it('check 全新 → 全部最新', () => {
    expect(summarizeActions(['rules: 全部最新'])).toBe('全部最新');
  });

  it('无 rules 行 → no rules actions', () => {
    expect(summarizeActions(['hooks: updated'])).toBe('no rules actions');
    expect(summarizeActions(undefined)).toBe('no actions');
  });
});

describe('router 注册', () => {
  it('SUBCOMMANDS 含 rules', () => {
    expect(SUBCOMMANDS).toContain('rules');
  });
});

describe('runRules 参数校验(usage 严格,退出码 2)', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('EXIT_CALLED');
  }) as never);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    exitSpy.mockClear();
    logSpy.mockClear();
    errSpy.mockClear();
  });

  it('--all 与 --paths 均不给 → usage + exit 2', async () => {
    await expect(runRules([])).rejects.toThrow('EXIT_CALLED');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('--all 与 --paths 同时给 → 互斥报错 + exit 2', async () => {
    await expect(runRules(['--all', '--paths', 'D:/x'])).rejects.toThrow('EXIT_CALLED');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('互斥');
  });

  it('--mode 非法 → exit 2', async () => {
    await expect(runRules(['--paths', 'D:/x', '--mode', 'bogus'])).rejects.toThrow('EXIT_CALLED');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe('runRules 目标解析失败路径', () => {
  it('--paths 指向非 Godot 目录 → 无目标 + exit 1(OPERATION_FAILED)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cli-rules-none-'));
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('EXIT_CALLED');
      }) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await expect(runRules(['--paths', empty])).rejects.toThrow('EXIT_CALLED');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(logSpy.mock.calls.flat().join('\n')).toContain('未探测到 project.godot');
      } finally {
        exitSpy.mockRestore(); errSpy.mockRestore(); logSpy.mockRestore();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('runRules 端到端(--paths 显式项目,update 模式)', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cli-rules-e2e-'));
    writeFileSync(join(project, 'project.godot'), '[application]\nconfig/name="Test"\n');
  });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it('单项目分发成功:输出 ✓ + 汇总,规则文件落盘,退出 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT_CALLED');
    }) as never);
    const logLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logLines.push(a.join(' '));
    });
    try {
      await runRules(['--paths', project, '--mode', 'update']);
      const out = logLines.join('\n');
      expect(out).toContain(`✓ ${project}`);
      expect(out).toContain('汇总: 1 成功 / 0 失败');
      expect(exitSpy).not.toHaveBeenCalled();  // 无失败不退出
      // 规则文件 + manifest 真实落盘
      expect(existsSync(join(project, '.claude', 'rules', 'godot-mcp.md'))).toBe(true);
      expect(existsSync(join(project, '.claude', 'rules', '.godot-mcp-manifest.json'))).toBe(true);
      expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
