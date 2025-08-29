import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setupTests.ts',
    coverage: {
      provider: 'c8',
      reporter: ['text', 'html'],
    },
  },
});
