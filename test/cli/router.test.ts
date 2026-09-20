import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSubcommand, isCliInvocation, isUnknownCommand, SUBCOMMANDS } from '../../src/cli/router.js';

describe('router', () => {
  describe('parseSubcommand', () => {
    it('parses setup subcommand', () => {
      const result = parseSubcommand(['setup', '--project=/foo']);
      expect(result).toEqual({ subcommand: 'setup', rest: ['--project=/foo'] });
    });

    it('returns null for empty args', () => {
      expect(parseSubcommand([])).toBeNull();
    });

    it('returns null for flags', () => {
      expect(parseSubcommand(['--profile=full'])).toBeNull();
    });

    it('returns null for --help', () => {
      expect(parseSubcommand(['--help'])).toBeNull();
    });

    it('parses all valid subcommands', () => {
      for (const cmd of ['setup', 'configure', 'doctor', 'init', 'dashboard', 'install', 'uninstall'] as const) {
        expect(parseSubcommand([cmd])).toEqual({ subcommand: cmd, rest: [] });
      }
    });
  });

  it('SUBCOMMANDS 覆盖 install/uninstall 对(可移植性:卸载链与安装链对称)', () => {
    expect(SUBCOMMANDS).toContain('install');
    expect(SUBCOMMANDS).toContain('uninstall');
  });

  describe('isCliInvocation', () => {
    it('returns true for setup', () => {
      expect(isCliInvocation(['setup'])).toBe(true);
    });

    it('returns true for --help', () => {
      expect(isCliInvocation(['--help'])).toBe(true);
    });

    it('returns true for --version', () => {
      expect(isCliInvocation(['--version'])).toBe(true);
    });

    it('returns true for -v', () => {
      expect(isCliInvocation(['-v'])).toBe(true);
    });

    it('returns false for empty args', () => {
      expect(isCliInvocation([])).toBe(false);
    });

    it('returns false for --profile flag', () => {
      expect(isCliInvocation(['--profile=full'])).toBe(false);
    });

    it('returns false for --minimal flag', () => {
      expect(isCliInvocation(['--minimal'])).toBe(false);
    });

    it('returns false for unknown flag', () => {
      expect(isCliInvocation(['--unknown'])).toBe(false);
    });
  });

  describe('isUnknownCommand(2026-08-21 架构审查 MAJOR-1:堵静默挂起)', () => {
    it('returns true for misspelled command', () => {
      expect(isUnknownCommand(['intsll'])).toBe(true);
      expect(isUnknownCommand(['Setup'])).toBe(true);  // 大小写敏感,非子命令
    });

    it('returns true for bare path-like arg', () => {
      expect(isUnknownCommand(['D:/some/project'])).toBe(true);
    });

    it('returns false for all known subcommands', () => {
      // P3(2026-08-21 七维度审核): 从 router 导入单一真相源,新增子命令自动跟随
      // (此前硬编码重复清单,新增命令时测试不自动同步)
      for (const cmd of SUBCOMMANDS) {
        expect(isUnknownCommand([cmd])).toBe(false);
      }
    });

    it('returns false for flags(归 MCP 模式)与空参数', () => {
      expect(isUnknownCommand([])).toBe(false);
      expect(isUnknownCommand(['--profile=full'])).toBe(false);
      expect(isUnknownCommand(['--unknown-flag'])).toBe(false);
    });
  });

  // M-2(2026-09-17 审查批)源码契约:dashboard 子命令旗标接线——routeCommand 内
  // process.exit/真实 registry 目录副作用不可直驱,以契约断言锁定接线与打码形态
  // (先例:server-http.test.ts M-1 源码契约)。行为级断言在 web-gui 层测试
  // (registry.test.ts rotateSharedToken / open.test.ts showToken 打码)。
  describe('dashboard 旗标接线契约(M-2)', () => {
    it('--rotate-token/--show-token 经 hasFlag 接线;rotate 输出打码(前 4 位)非全量', () => {
      const src = readFileSync(new URL('../../src/cli/router.ts', import.meta.url), 'utf-8');
      expect(src).toContain("hasFlag(parsed.rest, 'rotate-token')");
      expect(src).toContain("hasFlag(parsed.rest, 'show-token')");
      expect(src).toContain('rotateSharedToken');
      // 打码形态:console 输出只取 slice(0, 4)(全量 token 不落终端)
      expect(src).toMatch(/\.slice\(0,\s*4\)/);
      // 防回退:不允许直接 console.log 整个 rotate 返回值
      expect(src).not.toMatch(/console\.log\(\s*(newToken|t|token)\s*\)/);
    });
  });
});
