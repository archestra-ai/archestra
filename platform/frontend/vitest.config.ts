import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    include: ['./src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./vitest-setup.ts'],
  },
});
