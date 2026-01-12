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
    // React DOM is used implicitly by Next.js for rendering
    "react-dom",
    // Testing library DOM is a peer dependency of @testing-library/react
    "@testing-library/dom",
    // Type definitions for react-dom
    "@types/react-dom",
    // Tailwind CSS is used via @tailwindcss/postcss in postcss.config.mjs
    "tailwindcss",
  ],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
    // These are provided by devDependencies and used in scripts
    "vitest",
    "knip",
    "next",
    "tsc",
  ],
  rules: {
    // shadcn/ui components export all variants for completeness - intentional pattern
    exports: "off",
    types: "off",
  },
};

export default config;
