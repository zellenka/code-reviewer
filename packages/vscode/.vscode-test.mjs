import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Pin with VSCODE_TEST_VERSION (e.g. "1.95.0") to test the minimum supported version.
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 20_000 },
});
