import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests run real git, bwrap and worktrees; 5 s is too tight on a busy machine.
    testTimeout: 30_000,
  },
});
