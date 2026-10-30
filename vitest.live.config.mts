import { defineConfig } from 'vitest/config';

// Live tests call real providers and need secrets (e.g. ANTHROPIC_API_KEY).
// Run on demand only: `pnpm test:live`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.live.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});
