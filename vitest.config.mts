import { defineConfig } from 'vitest/config';

// Unit tests are *.spec.ts: `claude plugin test` owns *.test.ts in the plugin folder.
export default defineConfig({
  test: {
    include: ['packages/*/unit/**/*.spec.ts', 'packages/vscode-extension/test/**/*.spec.ts'],
    environment: 'node',
  },
});
