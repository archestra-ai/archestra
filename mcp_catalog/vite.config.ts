/// <reference types="vitest" />
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@archestra/types': path.resolve(__dirname, './src/types.ts'),
      '@constants': path.resolve(__dirname, './src/constants.ts'),
      '@lib/*': path.resolve(__dirname, './src/lib/*'),
      '@schemas': path.resolve(__dirname, './src/schemas/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.config.*', '**/types.ts'],
    },
  },
});
