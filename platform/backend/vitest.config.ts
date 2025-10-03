import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['./src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test-setup.ts'],
  },
});
