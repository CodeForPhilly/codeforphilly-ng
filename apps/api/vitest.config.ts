import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Git-heavy tests (createTestRepo, scrubRepo) run multiple git subprocess
    // calls under the hood; 30s per test is ample at CI scale.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files serially. Parallel file execution causes cross-file
    // flakes for gitsheets-backed tests (shared temp-layer churn + module
    // singletons in the API graph such as the facet cache).
    fileParallelism: false,
  },
});
