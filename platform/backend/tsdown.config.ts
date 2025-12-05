import { spawn } from "node:child_process";
import { defineConfig, type UserConfig } from "tsdown";

/**
 * Properly manage server process lifecycle using AbortSignal.
 * When tsdown rebuilds, it triggers the signal which automatically
 * terminates the previous server process - preventing orphan processes.
 *
 * Set DEBUG=1 to enable Node.js inspector (e.g., DEBUG=1 pnpm dev)
 *
 * @see https://tsdown.dev/advanced/hooks
 * @see https://nodejs.org/api/child_process.html#optionssignal
 */
const onSuccessHandler: UserConfig["onSuccess"] = (_config, signal) => {
  const args = ["--enable-source-maps"];

  if (process.env.DEBUG) {
    args.push("--inspect");
  }

  args.push("dist/server.mjs");

  const child = spawn("node", args, {
    stdio: "inherit",
    signal, // AbortSignal kills this process when tsdown rebuilds
  });

  child.on("error", (err) => {
    // AbortError is expected when tsdown rebuilds
    if (err.name !== "AbortError") {
      console.error("Server process error:", err);
    }
  });

  // Don't wait for the server to exit - return immediately
  // so tsdown can continue watching for changes
};

export default defineConfig((options: UserConfig) => {
  return {
    // Spread CLI options first so our config takes precedence
    ...options,

    // Only bundle the server entry point
    entry: ["src/server.ts"],

    // Copy SQL migrations and other assets that need to exist at runtime
    copy: ["src/database/migrations"],

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

    // Only set onSuccess handler when in watch mode
    onSuccess: options.watch ? onSuccessHandler : undefined,
  };
});
