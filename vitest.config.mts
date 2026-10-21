import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests need a real VS Code; they run through `pnpm test:integration`.
    include: ['test/unit/**/*.test.ts'],
  },
});
