import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/standalone-scripts/code-runtime-benchmark.ts"],
  outDir: "dist/code-runtime-benchmark",
  clean: true,
  format: ["esm" as const],
  sourcemap: true,
  deps: {
    alwaysBundle: [/^@shared/],
  },
  loader: {
    ".py": "text" as const,
  },
  tsconfig: "./tsconfig.json",
});
