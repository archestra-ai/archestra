import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    // Please make sure that '@tanstack/router-plugin' is passed before '@vitejs/plugin-react'
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: path.resolve(__dirname, './src/ui/routes'),
      generatedRouteTree: path.resolve(__dirname, './src/ui/routeTree.gen.ts'),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@backend': path.resolve(__dirname, './src/backend'),
      '@constants': path.resolve(__dirname, './src/constants.ts'),
      '@ui': path.resolve(__dirname, './src/ui'),
    },
  },
  server: {
    proxy: {
      /**
       * Proxy all API requests to the backend server
       *
       * https://vite.dev/config/server-options.html#server-proxy
       */
      '^/(api|mcp_proxy|llm|mcp).*': {
        target: 'http://localhost:54587',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:54588',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
