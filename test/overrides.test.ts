import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installOverride,
  uninstallOverride,
  uninstallAllOverrides,
  deriveOverrideEntry,
  installOverrides,
  OVERRIDE_AUTOLOAD_PREFIX,
} from '../src/core/overrides.js';
import { asUnrestrictedPath, isolatePathEnv } from './helpers/path-isolation.js';

// P2-1 overrides 测试:验证 autoload 注入/卸载逻辑 + 路径白名单 + 幂等
// 用真实 tmp 目录建 mock 项目(绕过 isPathInAllowedRoots 需 UNRESTRICTED)
// P2-C (2026-08-08): env 操作迁移到 asUnrestrictedPath/isolatePathEnv 消除直接赋值 footgun

let tmpRoot: string;
let projectDir: string;
let sourceScriptDir: string;
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = asUnrestrictedPath(); // stubEnv 模式，afterEach restore 自动清
  tmpRoot = join(tmpdir(), `overrides-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  projectDir = join(tmpRoot, 'MyProject');
  sourceScriptDir = join(tmpRoot, 'sources');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sourceScriptDir, { recursive: true });
  // mock project.godot
  writeFileSync(join(projectDir, 'project.godot'),
    'config_version=5\n[application]\nconfig/name="Test"\n', 'utf-8');
});

afterEach(() => {
  restoreEnv();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('P2-1 overrides.ts', () => {
  describe('deriveOverrideEntry', () => {
    it('derives autoload key and dest script name from source path', () => {
      const entry = deriveOverrideEntry('/some/path/debug_log.gd', '/project');
      expect(entry.autoloadKey).toBe('MCPOVERRIDE_debug_log');
      expect(entry.destScriptName).toBe('mcpoverride_debug_log.gd');
      expect(entry.destScriptPath).toBe(join('/project', 'mcpoverride_debug_log.gd'));
    });

    it('sanitizes non-alphanumeric characters in stem', () => {
      const entry = deriveOverrideEntry('/path/my-debug hook.gd', '/project');
      expect(entry.autoloadKey).toBe('MCPOVERRIDE_my_debug_hook');
    });
  });

  describe('installOverride', () => {
    it('installs script into project [autoload] section and copies script', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      const entry = installOverride(srcScript, projectDir);
      expect(entry!.autoloadKey).toBe('MCPOVERRIDE_log');

      // 脚本拷贝到项目根
      expect(existsSync(join(projectDir, 'mcpoverride_log.gd'))).toBe(true);

      // project.godot 含 autoload 条目(G-5: 键名无 autoload/ 前缀 — 键名即 Godot 节点名)
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).toMatch(/^MCPOVERRIDE_log="\*res:\/\/mcpoverride_log\.gd"$/m);
      expect(config).not.toContain('autoload/MCPOVERRIDE_log');
    });

    it('is idempotent — second install returns null', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      const first = installOverride(srcScript, projectDir);
      const second = installOverride(srcScript, projectDir);
      expect(first?.autoloadKey).toBe('MCPOVERRIDE_log');
      expect(second).toBeNull();
    });

    // 反馈 2026-08-30 (fr2-standalone-game): 幂等跳过曾从不比对内容——源脚本改后重复
    // install 返回成功但目标仍是旧版。修:内容漂移 → 重拷贝 + updated:true;一致 → null。
    it('re-installs with updated:true when source content drifted (dest file refreshed)', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\nvar version = 1\n', 'utf-8');
      installOverride(srcScript, projectDir);

      // 修改源脚本后重复 install
      writeFileSync(srcScript, 'extends Node\nvar version = 2\n', 'utf-8');
      const re = installOverride(srcScript, projectDir);
      expect(re).not.toBeNull();
      expect(re!.updated).toBe(true);
      expect(re!.autoloadKey).toBe('MCPOVERRIDE_log');
      // 目标文件已刷新为新内容
      expect(readFileSync(join(projectDir, 'mcpoverride_log.gd'), 'utf-8')).toContain('version = 2');
      // autoload 注册不重复(仍只有一行)
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config.match(/^MCPOVERRIDE_log=/gm)?.length).toBe(1);

      // 内容一致时再次 install → null(幂等不受影响)
      expect(installOverride(srcScript, projectDir)).toBeNull();
    });

    it('re-scan sandbox on content-drift re-install (new content = new threat surface)', () => {
      const srcScript = join(sourceScriptDir, 'driftscan.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      installOverride(srcScript, projectDir);

      // 漂移成危险内容(含字符串拼接 OS.execute 模式)→ 重复 install 须被沙箱拦截
      writeFileSync(srcScript, 'extends Node\nvar cmd = "cmd" + ".exe"\nOS.execute(cmd, [])\n', 'utf-8');
      expect(() => installOverride(srcScript, projectDir)).toThrow(/sandbox/i);
    });

    it('creates [autoload] section if missing', () => {
      const srcScript = join(sourceScriptDir, 'hook.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      installOverride(srcScript, projectDir);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).toMatch(/\[autoload\]/);
      expect(config).toMatch(/^MCPOVERRIDE_hook=/m);
    });

    it('appends to existing [autoload] section', () => {
      // 项目已有 [autoload] 段
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n\n[autoload]\n\n[application]\nconfig/name="Test"\n', 'utf-8');
      const srcScript = join(sourceScriptDir, 'snap.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      installOverride(srcScript, projectDir);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      // MCPOVERRIDE 在 [autoload] 后、[application] 前
      const autoloadIdx = config.indexOf('[autoload]');
      const overrideIdx = config.indexOf('MCPOVERRIDE_snap');
      const appIdx = config.indexOf('[application]');
      expect(overrideIdx).toBeGreaterThan(autoloadIdx);
      expect(overrideIdx).toBeLessThan(appIdx);
    });

    it('反馈坑3: 插到 [autoload] 段末尾——在游戏 autoload 条目之后(不插段头)', () => {
      // autoload 声明顺序即 _ready 执行顺序;段头插入曾致 override _ready 先于 GameData._ready
      // 执行,访问游戏单例得 null(2026-08-19 反馈四坑之三)。
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n\n[autoload]\nGameData="*res://game_data.gd"\n\n[application]\nconfig/name="Test"\n', 'utf-8');
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      installOverride(srcScript, projectDir);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      const gameIdx = config.indexOf('GameData=');
      const overrideIdx = config.indexOf('MCPOVERRIDE_log=');
      const appIdx = config.indexOf('[application]');
      expect(overrideIdx, 'override 须在游戏 autoload 之后(_ready 可访问游戏单例)').toBeGreaterThan(gameIdx);
      expect(overrideIdx, 'override 不得越过下一 section').toBeLessThan(appIdx);
    });

    it('反馈坑3: [autoload] 段即文件末(无尾换行)——补行插末尾', () => {
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n\n[autoload]\nGameData="*res://game_data.gd"', 'utf-8');
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      installOverride(srcScript, projectDir);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      const lines = config.split('\n');
      // 配置以 \n 结尾,split 末元素为空串——倒数第二行才是最后一条真实条目
      expect(lines[lines.length - 2] ?? '', '末条目应为 override(带尾换行)').toMatch(/^MCPOVERRIDE_log=/);
      expect(config.indexOf('MCPOVERRIDE_log='), '仍在 GameData 之后').toBeGreaterThan(config.indexOf('GameData='));
    });

    it('反馈坑3: 多次安装保持安装顺序(第二次插在第一次之后)', () => {
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n\n[autoload]\nGameData="*res://game_data.gd"\n\n[application]\n', 'utf-8');
      const a = join(sourceScriptDir, 'alpha.gd');
      const b = join(sourceScriptDir, 'beta.gd');
      writeFileSync(a, 'extends Node\n', 'utf-8');
      writeFileSync(b, 'extends Node\n', 'utf-8');

      installOverride(a, projectDir);
      installOverride(b, projectDir);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config.indexOf('MCPOVERRIDE_beta='), '后装在后').toBeGreaterThan(config.indexOf('MCPOVERRIDE_alpha='));
    });

    it('throws if source script not found', () => {
      expect(() => installOverride(join(sourceScriptDir, 'nope.gd'), projectDir))
        .toThrow(/source script not found/i);
    });

    it('throws if project.godot not found', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      const emptyDir = join(tmpRoot, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      expect(() => installOverride(srcScript, emptyDir))
        .toThrow(/project\.godot not found/i);
    });
  });

  describe('uninstallOverride', () => {
    it('removes autoload entry and deletes copied script', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      installOverride(srcScript, projectDir);

      const removed = uninstallOverride(srcScript, projectDir);
      expect(removed).toBe(true);
      expect(existsSync(join(projectDir, 'mcpoverride_log.gd'))).toBe(false);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toMatch(/MCPOVERRIDE_log/);
    });

    it('returns false if override not registered', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      const removed = uninstallOverride(srcScript, projectDir);
      expect(removed).toBe(false);
    });

    // D4 (2026-09-17 反馈批次D, 09-06 CardGame2 反馈): Godot 4.4+ 为 .gd 生成伴生 .uid,
    // 卸载删脚本不清 .uid 留孤儿(git status 残留误导排查)
    it('D4: 清理伴生 .gd.uid 残留(存在时一并删除)', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      installOverride(srcScript, projectDir);
      // 模拟 Godot 4.4+ 为拷贝进项目的脚本生成的伴生 .uid
      writeFileSync(join(projectDir, 'mcpoverride_log.gd.uid'), 'uid://abcdefgh\n', 'utf-8');

      const removed = uninstallOverride(srcScript, projectDir);
      expect(removed).toBe(true);
      expect(existsSync(join(projectDir, 'mcpoverride_log.gd'))).toBe(false);
      expect(existsSync(join(projectDir, 'mcpoverride_log.gd.uid')), '.uid 孤儿须一并清理').toBe(false);
    });

    it('D4: 无伴生 .uid(旧版 Godot)时卸载正常(不报错)', () => {
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');
      installOverride(srcScript, projectDir);

      const removed = uninstallOverride(srcScript, projectDir);
      expect(removed).toBe(true);
    });
  });

  describe('uninstallAllOverrides', () => {
    it('removes all MCPOVERRIDE_* entries', () => {
      // 装两个 override
      for (const name of ['a', 'b']) {
        const src = join(sourceScriptDir, `${name}.gd`);
        writeFileSync(src, 'extends Node\n', 'utf-8');
        installOverride(src, projectDir);
      }
      const count = uninstallAllOverrides(projectDir);
      expect(count).toBe(2);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toMatch(/MCPOVERRIDE_/);
    });

    it('returns 0 if no overrides', () => {
      expect(uninstallAllOverrides(projectDir)).toBe(0);
    });
  });

  describe('installOverrides (batch)', () => {
    it('installs multiple scripts atomically', () => {
      const paths = ['x', 'y'].map(n => {
        const p = join(sourceScriptDir, `${n}.gd`);
        writeFileSync(p, 'extends Node\n', 'utf-8');
        return p;
      });
      const installed = installOverrides(paths, projectDir);
      expect(installed.length).toBe(2);
    });

    it('throws atomically if any source missing (none installed)', () => {
      const good = join(sourceScriptDir, 'good.gd');
      writeFileSync(good, 'extends Node\n', 'utf-8');
      const bad = join(sourceScriptDir, 'bad.gd');
      expect(() => installOverrides([good, bad], projectDir))
        .toThrow(/source script not found/i);
      // good 也不应被装(atomic)
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toMatch(/MCPOVERRIDE_good/);
    });
  });

  describe('OVERRIDE_AUTOLOAD_PREFIX constant', () => {
    it('uses MCPOVERRIDE_ prefix (unprefixed — G-5: autoload 键名即 Godot 节点名)', () => {
      expect(OVERRIDE_AUTOLOAD_PREFIX).toBe('MCPOVERRIDE_');
    });
  });

  // ── G-5 (2026-08-14 批D实测发现): 旧带前缀键(autoload/MCPOVERRIDE_*)迁移与双键清理 ──
  describe('G-5: legacy prefixed key migration & dual-key cleanup', () => {
    it('installOverride 迁移旧带前缀键: 删旧行写新行(旧项目自愈)', () => {
      // 预置旧版写入的带前缀键
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n[autoload]\nautoload/MCPOVERRIDE_log="*res://mcpoverride_log.gd"\n', 'utf-8');
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      const entry = installOverride(srcScript, projectDir);
      expect(entry).not.toBeNull();
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toContain('autoload/MCPOVERRIDE_log=');  // 旧行移除
      expect(config).toMatch(/^MCPOVERRIDE_log="\*res:\/\/mcpoverride_log\.gd"$/m);  // 新行写入
    });

    it('uninstallOverride 清理旧带前缀键(未迁移的旧项目遗留)', () => {
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n[autoload]\nautoload/MCPOVERRIDE_log="*res://mcpoverride_log.gd"\n', 'utf-8');
      writeFileSync(join(projectDir, 'mcpoverride_log.gd'), 'extends Node\n', 'utf-8');
      const srcScript = join(sourceScriptDir, 'log.gd');
      writeFileSync(srcScript, 'extends Node\n', 'utf-8');

      const removed = uninstallOverride(srcScript, projectDir);
      expect(removed).toBe(true);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toMatch(/MCPOVERRIDE_log/);
      expect(existsSync(join(projectDir, 'mcpoverride_log.gd'))).toBe(false);
    });

    it('uninstallAllOverrides 清理旧带前缀行(批量,兼容遗留)', () => {
      writeFileSync(join(projectDir, 'project.godot'),
        'config_version=5\n[autoload]\nautoload/MCPOVERRIDE_a="*res://mcpoverride_a.gd"\nMCPOVERRIDE_b="*res://mcpoverride_b.gd"\n', 'utf-8');
      const count = uninstallAllOverrides(projectDir);
      expect(count).toBe(2);
      const config = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
      expect(config).not.toMatch(/MCPOVERRIDE_/);
    });
  });

  // N-2 (P2-4 审查): 路径白名单强制测试 —— 不设 UNRESTRICTED 时越权路径必须抛错
  describe('path allowlist enforcement (N-2)', () => {
    it('installOverride 拒绝越权源脚本路径(不设 UNRESTRICTED)', () => {
      // P2-C: 用 isolatePathEnv 替代手动 delete（deny-by-default 姿态）
      const restore = isolatePathEnv();
      try {
        // 越权路径:/outside/allow/evil.gd(不在 tmpRoot 也不在 cwd)
        const outside = join(tmpdir(), `outside-${Date.now()}.gd`);
        writeFileSync(outside, 'extends Node\n', 'utf-8');
        expect(() => installOverride(outside, projectDir)).toThrow(/outside allowed project roots/i); // 审查 I-D: 收口 PathError 后的消息模板
        // 清理
        try { require('fs').unlinkSync(outside); } catch { /* best effort */ }
      } finally {
        restore();
      }
    });

    it('installOverride 拒绝越权目标项目路径(不设 UNRESTRICTED)', () => {
      const restore = isolatePathEnv();
      try {
        const srcScript = join(sourceScriptDir, 'log.gd');
        writeFileSync(srcScript, 'extends Node\n', 'utf-8');
        // projectDir 在 tmpRoot,但 UNRESTRICTED 关闭后须 ALLOWED_PROJECT_PATHS 显式允许
        expect(() => installOverride(srcScript, projectDir)).toThrow(/outside allowed project roots/i); // 审查 I-D
      } finally {
        restore();
      }
    });
  });

  // 2026-08-06 审查 P1：overrides 注入须对称走 scanGdscriptSandbox（与 execute_gdscript 同威胁面）
  describe('sandbox scan (P1 fix)', () => {
    it('installOverride 拒绝含 OS.execute 的危险 override 脚本', () => {
      // 默认 UNRESTRICTED=true（beforeEach 设），路径白名单过；但沙箱扫描应拦
      const srcScript = join(sourceScriptDir, 'evil.gd');
      writeFileSync(srcScript, 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf", "/"])\n', 'utf-8');
      expect(() => installOverride(srcScript, projectDir)).toThrow(/failed sandbox scan/i);
      // 脚本不应被拷贝到项目根
      expect(existsSync(join(projectDir, 'mcpoverride_evil.gd'))).toBe(false);
    });

    it('installOverride 接受安全脚本（无危险 API）', () => {
      // 现有测试已隐式验证（extends Node 的脚本都装成功），显式断言一次
      const srcScript = join(sourceScriptDir, 'safe.gd');
      writeFileSync(srcScript, 'extends Node\nfunc _ready():\n\tprint("hello")\n', 'utf-8');
      const entry = installOverride(srcScript, projectDir);
      expect(entry).not.toBeNull();
      expect(existsSync(join(projectDir, 'mcpoverride_safe.gd'))).toBe(true);
    });

    it('installOverride 允许危险脚本通过双 opt-in 旁路（UNRESTRICTED + DISABLE_SAFETY，对齐 execute_gdscript）', () => {
      // N-1 修复：原测试只设 DISABLE_SAFETY 单 env（beforeEach 隐式 UNRESTRICTED），但代码
      // 现要求真双 opt-in（UNRESTRICTED && DISABLE_SAFETY），对齐 execute_gdscript。
      // P2-C: 用 vi.stubEnv 替代直接赋值（afterEach restore 自动清）
      // beforeEach 已设 UNRESTRICTED=true（asUnrestrictedPath），这里补 DISABLE_SAFETY。
      vi.stubEnv('GODOT_MCP_DISABLE_SAFETY', 'true');
      const srcScript = join(sourceScriptDir, 'danger.gd');
      writeFileSync(srcScript, 'extends Node\nfunc _ready():\n\tOS.execute("calc")\n', 'utf-8');
      const entry = installOverride(srcScript, projectDir);
      expect(entry).not.toBeNull(); // 双 opt-in 旁路成功
    });

    it('installOverride 单 DISABLE_SAFETY（无 UNRESTRICTED）不旁路 — 双 opt-in 强制', () => {
      // N-1 修复后：单 env 不够，须 UNRESTRICTED + DISABLE_SAFETY 同时设
      // P2-C: 用 isolatePathEnv 撤销 UNRESTRICTED（deny 姿态）+ stubEnv 设 DISABLE_SAFETY
      const restore = isolatePathEnv();
      vi.stubEnv('GODOT_MCP_DISABLE_SAFETY', 'true');
      try {
        const srcScript = join(sourceScriptDir, 'danger2.gd');
        writeFileSync(srcScript, 'extends Node\nfunc _ready():\n\tOS.execute("calc")\n', 'utf-8');
        expect(() => installOverride(srcScript, projectDir)).toThrow(/outside allowed project roots|failed sandbox scan/i); // 审查 I-D
      } finally {
        restore();
      }
    });
  });
});
