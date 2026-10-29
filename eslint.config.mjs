import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    ignores: ['dist', 'node_modules', 'coverage', '.benchmark-results/**', '**/*.js', '*.mjs', '*.cjs', 'tests/**', 'benchmarks/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: Object.fromEntries(['require', 'module', '__dirname', 'process', 'console', 'fetch', 'AbortSignal'].map(name => [name, 'readonly'])),
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
