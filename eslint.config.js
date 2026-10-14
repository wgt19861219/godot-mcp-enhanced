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
  // R2/R3-test(2026-10-14 全维度审查): lint 范围扩至 test/ 与 scripts/(此前 500+ 测试
  // 文件与 28 个脚本零 ESLint,机械门禁文化的最大单点缺口)。
  // test 块策略(增量收紧,不做 2300 项存量大清洗):
  //  - vitest globals 消 no-undef 假阳性(1759 处为 describe/it/expect 未配 globals);
  //  - no-explicit-any 降 warn(存量 ~400 处 as any,测试代码容忍度高;配 --max-warnings
  //    锁定当前值防恶化,新代码增量清偿);
  //  - 其余真 error 保持(修存量后逐步收敛)。
  {
    files: ['test/**/*.{js,ts,mjs}'],
    languageOptions: {
      globals: {
        // vitest globals 模式(vitest.config.ts globals: true)
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        vi: 'readonly', suite: 'readonly', assert: 'readonly', chai: 'readonly',
        // Node 运行时全局(测试在 Node 20+ 直跑,.js 无 import 声明时 no-undef 拿不到)
        process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', AbortController: 'readonly', structuredClone: 'readonly',
        Blob: 'readonly', File: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        crypto: 'readonly', performance: 'readonly', queueMicrotask: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', Buffer: 'readonly',
        globalThis: 'readonly', require: 'readonly',
      },
    },
    rules: {
      // 存量锁定策略(R2/R3-test): test 先纳入 lint 管辖,真 error 项(除 any 外存量
      // ~130 处:unused-vars/require-imports/no-empty 等)降 warn 由 --max-warnings
      // 锁定——新增即红,存量增量清偿;src/ 维持全 error 零容忍不变。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-catch': 'warn',
      'no-empty': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-regex-spaces': 'warn',
      'no-constant-binary-expression': 'warn',
      'no-unsafe-negation': 'warn',
      'no-prototype-builtins': 'warn',
    },
  },
  // scripts/ 构建脚本: node 环境 globals(mjs 无 import 的 require/env 引用兜底)
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        require: 'readonly', module: 'readonly', process: 'readonly', console: 'readonly',
        __dirname: 'readonly', Buffer: 'readonly', fetch: 'readonly', Request: 'readonly',
        Response: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
    rules: {
      // spike-*.mjs 实验脚本存量;同 test 策略 warn + max-warnings 锁定
      'no-useless-assignment': 'warn',
    },
  },
  {
    ignores: ['build/', 'coverage/', 'node_modules/', 'src/scripts/'],
  },
);
