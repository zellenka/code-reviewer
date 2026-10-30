import { defineConfig } from 'vitest/config';

// Unit tests: deterministic, no network, run on every PR.
// Extension tests (packages/vscode/test) run separately via `pnpm test:ext`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});
