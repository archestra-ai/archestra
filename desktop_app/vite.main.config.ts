/// <reference types="vitest" />
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@backend': path.resolve(__dirname, './src/backend'),
      '@constants': path.resolve(__dirname, './src/constants.ts'),
      '@ui': path.resolve(__dirname, './src/ui'),
    },
    /**
     * `conditions` and `mainFields` are responsible for backend hot-reloading
     *
     * see https://github.com/electron/forge/issues/682#issuecomment-1793552649
     */
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
  plugins: [
    /**
     * The `restart` plugin, configured as such, is responsible for backend hot-reloading
     *
     * see https://github.com/electron/forge/issues/682#issuecomment-1793552649
     */
    {
      name: 'restart',
      closeBundle() {
        process.stdin.emit('data', 'rs');
      },
    },
  ],
  test: {
    silent: true, // suppress all console logs from tests
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          setupFiles: ['./src/ui/setup-tests.ts'],
          include: ['src/ui/**/*.test.{ts,tsx}'],
          name: {
            label: 'browser',
            color: 'yellow',
          },
          environment: 'jsdom',
        },
      },
      {
        extends: true,
        test: {
          setupFiles: ['./src/backend/setup-tests.ts'],
          include: ['src/backend/**/*test.{ts,tsx}'],
          name: {
            label: 'node',
            color: 'green',
          },
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          setupFiles: [],
          include: ['src/*test.{ts,tsx}'],
          name: {
            label: 'common',
            color: 'blue',
          },
          environment: 'node',
        },
      },
    ],
  },
});
