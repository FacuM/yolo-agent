import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/e2e/**/*.test.js',
  version: 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
  },
});
