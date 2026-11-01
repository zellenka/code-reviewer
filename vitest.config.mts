import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests: deterministic, no network, run on every PR.
// Extension tests (packages/vscode/test) run separately via `pnpm test:ext`.
export default defineConfig({
  resolve: {
    // Test against workspace sources, so unit tests don't need a build first.
    alias: {
      '@ai-review/core': fileURLToPath(new URL('packages/core/src/index.ts', import.meta.url)),
      '@ai-review/node-host': fileURLToPath(
        new URL('packages/node-host/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'evals/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    testTimeout: 20_000,
  },
});
