import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: process.platform !== 'win32',
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    include: ['src/**/*.test.ts'],
  },
});
