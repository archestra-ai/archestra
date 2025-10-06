import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      "@/config": resolve(__dirname, "./src/config.ts"),
      "@database": resolve(__dirname, "./src/database"),
      "@/models": resolve(__dirname, "./src/models"),
      "@/types": resolve(__dirname, "./src/types")
    },
  },
  test: {
    globals: true,
    include: ['./src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
});
