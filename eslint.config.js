import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // TS-specific rules — warn only
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Downgrade recommended errors to warnings to avoid breaking existing code
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-useless-catch': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  {
    ignores: ['build/', 'coverage/', 'node_modules/', 'src/scripts/'],
  },
);
