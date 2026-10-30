import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
  { ignores: ['dist/', '.wrangler/', 'node_modules/', 'worker-configuration.d.ts', 'playwright-report/', 'test-results/', '.claude/', '.agents/'] },
  js.configs.recommended,
  ...ts.configs.strict,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // With `noUncheckedIndexedAccess`, `!` after a bounds-checked index is the idiom. Nullable
      // *state* must still be modelled properly (reviewed, not suppressed).
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': [
        'error',
        { selector: 'SwitchStatement[cases.length>6]', message: 'Use a handler registry instead of a long switch (open/closed).' },
      ],
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] } },
  },
  {
    files: ['*.config.*', '.dependency-cruiser.cjs', 'tests/**'],
    languageOptions: { globals: { ...globals.node } },
  },
);
