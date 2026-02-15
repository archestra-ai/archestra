import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/app/**/*.{ts,tsx}", "sentry.*.config.ts"],
  project: ["src/**/*.{ts,tsx}"],
  ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@shared",
    // Used by Sentry for instrumentation
    "import-in-the-middle",
    "require-in-the-middle",
    // Used in globals.css via @import
    "tw-animate-css",
    // PostCSS is a dependency of @tailwindcss/postcss
    "postcss",
    // Used via dynamic import in use-layout-nodes.ts (Knip doesn't detect the pattern)
    "elkjs",
  ],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
  ],
  rules: {
    // shadcn/ui components export all variants for completeness - intentional pattern
    exports: "off",
    types: "off",
  },
};

export default config;
