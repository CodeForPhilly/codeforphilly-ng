import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Screen tests (ProjectEdit, ExpressInterestModal, …) pass alone but
    // exceed the 5 s default under full-suite load in CI-like runs.
    testTimeout: 15_000,
  },
});
