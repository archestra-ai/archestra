import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome and concurrently are in the workspace root package.json
    "biome",
    "concurrently",
    // These are provided by devDependencies (typescript, vitest, tsx, knip)
    // but knip doesn't resolve them in a pnpm monorepo
    "tsc",
    "vitest",
    "tsx",
    "knip",
  ],
  ignoreDependencies: [
    // tsx is used as a binary in scripts
    "tsx",
  ],
};

export default config;
