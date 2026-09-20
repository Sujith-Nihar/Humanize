import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'], exclude: ['**/*.live.test.ts', '**/node_modules/**'], testTimeout: 30_000, fileParallelism: false },
});
