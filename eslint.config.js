import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // TS-specific rules — enforce in CI (upgraded from warn, zero warnings at time of change)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Downgrade recommended errors to warnings to avoid breaking existing code
      'no-useless-escape': 'warn',
      'prefer-const': 'error',
      'no-useless-catch': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  // 2026-08-21 架构审查 MEDIUM-2:core→tools 分层门禁(机械约束替代纪律)。
  // 历史上 core→tools 倒置收敛后仅剩 module-loader.ts 一个组合根(C-ARCH-01 有意例外);
  // D-2 同批已把它移到 src/ 根(应用层组合根的真实位置),core 层零 tools 依赖——
  // 此规则防新增倒置:若经 tools/shared barrel(30+ 消费方)反向引用,会瞬间形成
  // core→tools→core 大环。
  // 2026-09-14 follow-up:约束面扩至 web-gui(同为应用层子系统,core 不得反向依赖)。
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(\\.\\./)+(tools|web-gui)/',
          message: 'core 层禁止依赖 tools/web-gui(分层约束,2026-08-21 架构审查)。组合根已移至 src/module-loader.ts;新增工具模块请在其中加 import 行后跑 npm run generate:modules。',
        }],
      }],
    },
  },
  // 2026-09-20 可维护性批1(审查 Observation 采纳):tscn→tools 倒置门禁——W1 修复
  // (BLOCKED_PROPS 下沉 core/shared)前,tscn-editor-add.ts 从上层 tools 目录取安全常量。
  // core 有门禁而 tscn 没有,W1 类倒置无机械防线防复发,补齐(底层解析子系统同不得
  // 反向依赖应用层;依赖 core/types 不受限)。
  {
    files: ['src/tscn/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(\\.\\./)+tools/',
          message: 'tscn 层禁止依赖 tools(底层解析子系统反向依赖应用层,W1 于 2026-09-20 清零)。共享常量放 core/shared 或 src 根。',
        }],
      }],
    },
  },
  // 2026-10-04 批次1(stdout 纪律门禁,方案 docs/plans/2026-10-04-竞品回流验证与可靠性落地方案.md):
  // MCP server 进程(stdio 模式)可达的模块禁 console.log——stdio 模式下 stdout 是独占
  // JSON-RPC 通道,任何日志行污染流即 -32000 断连(yanhuifair v1.12.5 教训的机械化防线)。
  // console.error/warn 走 stderr 不拦;CLI 子命令/构建脚本/dashboard TUI 是独立进程不拦。
  // 文件面 = server 进程实际可达面(I-1 审查修复:初版漏 tools/**/settings-api/module-loader/
  // gdscript-executor/tscn——module-loader import 全部工具模块,tools 层恰是最高频改动面):
  // 入口 + GodotServer + module-loader + gdscript-executor + core + daemon + tools + tscn +
  // web-gui server 进程内文件(server/registry/settings-api)。
  {
    files: [
      'src/index.ts', 'src/GodotServer.ts', 'src/module-loader.ts', 'src/gdscript-executor.ts',
      'src/core/**/*.ts', 'src/daemon/**/*.ts', 'src/tools/**/*.ts', 'src/tscn/**/*.ts',
      'src/web-gui/server.ts', 'src/web-gui/registry.ts', 'src/web-gui/settings-api.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
        message: 'MCP server 进程可达模块禁用 console.log——stdio 模式下 stdout 是独占 JSON-RPC 通道,污染即 -32000 断连(批次1-1 门禁)。人类可读输出走 console.error(stderr);CLI 子命令/dashboard 等独立进程模块不受此限。',
      }],
    },
  },
  {
    ignores: ['build/', 'coverage/', 'node_modules/', 'src/scripts/'],
  },
);
