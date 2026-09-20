import { defineConfig } from 'vitest/config';

// Live lane: exercises real services and is never part of `pnpm check`. Run deliberately with
// `pnpm test:live` once the required service is reachable.
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['packages/**/*.live.test.ts', 'apps/**/*.live.test.ts', 'evals/**/*.live.test.ts'], testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false },
});
