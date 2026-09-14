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
  {
    ignores: ['build/', 'coverage/', 'node_modules/', 'src/scripts/'],
  },
);
