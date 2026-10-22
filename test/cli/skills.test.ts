// test/cli/skills.test.ts — P2-2 skills 子命令:list/install 纯函数与 CLI 流程
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listPackagedSkills, installSkills, packagedSkillsDir, runSkills, CLIENT_SKILLS_DIRS,
} from '../../src/cli/skills.js';

// ─── 纯函数:listPackagedSkills / installSkills ─────────────────────────────

describe('skills 纯函数', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-test-'));
    // 造两个 skill + 一个噪声目录(无 SKILL.md 应被忽略)
    mkdirSync(join(dir, 'godot-router'), { recursive: true });
    writeFileSync(join(dir, 'godot-router', 'SKILL.md'), '---\nname: godot-router\ndescription: "路由器 skill"\n---\n\n正文');
    mkdirSync(join(dir, 'screenshot-verify'), { recursive: true });
    writeFileSync(join(dir, 'screenshot-verify', 'SKILL.md'), '---\nname: screenshot-verify\ndescription: "视觉验证"\n---\n\n正文');
    mkdirSync(join(dir, 'not-a-skill'), { recursive: true });
    writeFileSync(join(dir, 'not-a-skill', 'README.md'), 'noise');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only directories containing SKILL.md, sorted', () => {
    const skills = listPackagedSkills(dir);
    expect(skills.map(s => s.name)).toEqual(['godot-router', 'screenshot-verify']);
    expect(skills[0]!.description).toBe('路由器 skill');
  });

  it('install copies SKILL.md to target, skips existing unless --force', () => {
    const target = join(dir, 'target');
    const r1 = installSkills(dir, target, false);
    expect(r1.installed.sort()).toEqual(['godot-router', 'screenshot-verify']);
    expect(existsSync(join(target, 'godot-router', 'SKILL.md'))).toBe(true);

    // 二次安装:已存在 → skip
    const r2 = installSkills(dir, target, false);
    expect(r2.installed).toEqual([]);
    expect(r2.skipped.sort()).toEqual(['godot-router', 'screenshot-verify']);

    // --force 覆盖
    const dst = join(target, 'godot-router', 'SKILL.md');
    writeFileSync(dst, '用户改过的版本');
    const r3 = installSkills(dir, target, true);
    expect(r3.installed).toContain('godot-router');
    expect(readFileSync(dst, 'utf-8')).toContain('路由器 skill');
  });

  it('噪声目录(无 SKILL.md)不被安装', () => {
    const target = join(dir, 'target2');
    installSkills(dir, target, false);
    expect(existsSync(join(target, 'not-a-skill'))).toBe(false);
  });
});

// ─── CLI 流程 ────────────────────────────────────────────────────────────────

describe('runSkills CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('打包目录存在(仓库源码场景,build 后必有 6 个 skill)', () => {
    // 本测试跑在仓库源码根:skills/ 由 npm run build:skills 生成,含 6 个
    const skills = listPackagedSkills(packagedSkillsDir());
    expect(skills.length).toBeGreaterThanOrEqual(6);
    const names = skills.map(s => s.name);
    for (const expected of ['godot-router', 'godot-mcp-safe-edit', 'godot-mcp-verify-loop', 'godot-mcp-bridge-e2e', 'screenshot-verify', 'godot-tween-taste']) {
      expect(names).toContain(expected);
    }
  });

  it('list(默认)列出 skills 且不 install', async () => {
    await runSkills([]);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('godot-router');
    expect(out).toContain('skills install');
  });

  it('--list 子命令等价', async () => {
    await runSkills(['list']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('install --target 装入指定目录并输出 installed 计数;幂等 skip;--force 覆盖', async () => {
    const target = mkdtempSync(join(tmpdir(), 'skills-target-'));
    try {
      await runSkills(['install', '--target', target]);
      const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(out).toContain('installed');
      expect(existsSync(join(target, 'godot-router', 'SKILL.md'))).toBe(true);
      // 幂等:再次 install → skip
      logSpy.mockClear();
      await runSkills(['install', '--target', target]);
      const out2 = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(out2).toContain('already exists');
      // --force 覆盖
      logSpy.mockClear();
      await runSkills(['install', '--target', target, '--force']);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(out2).toContain('Target');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('install --target 缺参数 exits 1', async () => {
    await runSkills(['install', '--target']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('B3: install --client 装入映射目录;--client 与 --target 互斥;未知 client 报错', async () => {
    // 映射重定向 tmp(测试隔离,不写真 ~/.zcode/skills)
    const target = mkdtempSync(join(tmpdir(), 'skills-client-'));
    const orig = CLIENT_SKILLS_DIRS['zcode']!;
    CLIENT_SKILLS_DIRS['zcode'] = () => target;
    try {
      await runSkills(['install', '--client', 'zcode']);
      const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(out).toContain('client: zcode');
      expect(existsSync(join(target, 'godot-router', 'SKILL.md'))).toBe(true);
    } finally {
      CLIENT_SKILLS_DIRS['zcode'] = orig;
      rmSync(target, { recursive: true, force: true });
    }

    // 互斥:--client 与 --target 同时给 → exit 1
    exitSpy.mockClear(); errSpy.mockClear();
    await runSkills(['install', '--client', 'zcode', '--target', 'D:/x']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('mutually exclusive');

    // 未知 client → exit 1 且列支持项
    exitSpy.mockClear(); errSpy.mockClear();
    await runSkills(['install', '--client', 'nope']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Supported');

    // --client 缺参数 → exit 1
    exitSpy.mockClear();
    await runSkills(['install', '--client']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('unknown subcommand exits 1', async () => {
    await runSkills(['bogus']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
