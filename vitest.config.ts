import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'evals/**/*.test.ts'], exclude: ['**/*.integration.test.ts', '**/*.live.test.ts', '**/node_modules/**'], testTimeout: 15_000 },
});
