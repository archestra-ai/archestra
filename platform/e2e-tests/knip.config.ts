import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["tests/**/*.ts", "auth.*.setup.ts", "consts.ts"],
  project: ["**/*.ts"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@archestra/shared",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
  ],
};

export default config;
