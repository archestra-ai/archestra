import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/app/**/*.{ts,tsx}",
    "src/instrumentation.ts",
    "src/instrumentation-client.ts",
    "next.config.ts",
    "sentry.*.config.ts",
  ],
  project: ["src/**/*.{ts,tsx}"],
  ignore: [
    "src/**/*.test.{ts,tsx}",
    "src/**/*.spec.{ts,tsx}",
  ],
  ignoreDependencies: [
    // Next.js internal dependencies
    "@next/env",
    // Sentry webpack plugin dependencies
    "@sentry/webpack-plugin",
  ],
};

export default config;

