import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'src/enhanced-import/vendor/**',
      'dist/',
      'public/',
      'node_modules/',
      'client/node_modules/',
      '*.js',
      '!eslint.config.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['client/src/enhanced-renderer/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'navigator',
          'console',
          'URL',
          'AbortController',
          'MutationObserver',
          'NodeFilter',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooksPlugin },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts', 'mcp/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  eslintConfigPrettier,
);
