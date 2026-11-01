import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/mocks/**/*.ts", "sentry.*.config.ts"],
  project: ["src/**/*.{ts,tsx}", "tests-integration/**/*.{ts,tsx}"],
  ignore: [],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@archestra/shared",
    // Used by Sentry for instrumentation
    "import-in-the-middle",
    "require-in-the-middle",
    // Used in globals.css via @import
    "tw-animate-css",
    // PostCSS is a dependency of @tailwindcss/postcss
    "postcss",
    // Used via dynamic import in use-layout-nodes.ts (Knip doesn't detect the pattern)
    "elkjs",
    // Provides tsc, which scripts/type-check.ts runs for `pnpm type-check`.
    "typescript-7",
  ],
  ignoreBinaries: [
    // biome, concurrently, and tsx are in the workspace root package.json
    "biome",
    "concurrently",
    "tsx",
  ],
  rules: {
    // shadcn/ui components export all variants for completeness - intentional pattern
    exports: "off",
    types: "off",
  },
};

export default config;
