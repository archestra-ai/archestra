import { defineConfig, type Options } from "tsup";

export default defineConfig((options: Options) => ({
  // Only bundle the server entry point
  entry: ["src/server.ts"],
  
  // Copy SQL migrations and other assets that need to exist at runtime
  publicDir: false,
  
  // Copy patterns for files that should be copied as-is
  loader: {
    ".sql": "copy",  // Copy SQL files as-is, don't try to bundle them
  },
  
  clean: true,
  format: ["esm"],  // Changed from "cjs" to "esm" since you have "type": "module"
  
  // Generate source maps for better stack traces
  sourcemap: true,
  
  // Exclude test files
  exclude: [
    "**/*.test.ts",
    "**/*.spec.ts",
    "src/test-setup.ts",
    "src/standalone-scripts/**/*",
  ],
  
  // Don't bundle dependencies - use them from node_modules, except for @shared
  noExternal: ["@shared"],
  
  ...options,
}));
