// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/.vscode-test/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Everything except the VS Code extension must stay host-agnostic:
    // the same engine runs in the CLI, evals and the GitHub Action.
    files: ['packages/**/*.ts'],
    ignores: ['packages/vscode/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'Only packages/vscode may import "vscode". Keep core host-agnostic.',
            },
          ],
          patterns: [{ group: ['vscode/*'], message: 'Only packages/vscode may import "vscode".' }],
        },
      ],
    },
  },
  {
    files: ['packages/vscode/test/**/*.ts'],
    languageOptions: { globals: { ...globals.mocha } },
  },
  prettier,
);
