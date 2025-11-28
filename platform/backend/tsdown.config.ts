import { defineConfig, type UserConfig } from "tsdown";

export default defineConfig((options: UserConfig) => {
  const config: UserConfig = {
    // Only bundle the server entry point
    entry: ["src/server.ts"],

    // Copy SQL migrations and other assets that need to exist at runtime
    copy: ["src/database/migrations"],

    // Load SQL files as text strings
    // loader: {
    //   ".sql": "text" as const,  // Load SQL files as text strings
    // },

    clean: true,
    format: ["esm" as const],

    // Generate source maps for better stack traces
    sourcemap: true,

    // Don't bundle dependencies - use them from node_modules, except for @shared
    noExternal: ["@shared"],
    tsconfig: "./tsconfig.json",

    ignoreWatch: [
      ".turbo",
      "**/.turbo/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "src/test/**/*",
      "src/standalone-scripts/**/*",
    ],

    ...options,
  };

  return config;
});
