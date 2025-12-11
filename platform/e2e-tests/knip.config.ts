import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "tests/**/*.ts",
    "playwright.config.ts",
    "auth.setup.ts",
    "consts.ts",
  ],
  project: ["**/*.ts"],
  ignore: ["auth.*.setup.ts"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@shared",
  ],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
    // tsc is in root package.json (typescript)
    "tsc",
  ],
};

export default config;
