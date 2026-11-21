import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: process.platform !== 'win32',
    include: ['src/**/*.test.ts'],
    // Tests run real git, bwrap and worktrees; 5 s is too tight on a busy machine.
    testTimeout: process.platform === 'win32' ? 60_000 : 30_000,
  },
});
