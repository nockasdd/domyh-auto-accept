import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/domain/**', 'src/payload/**'],
    },
    alias: {
      vscode: resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
});
