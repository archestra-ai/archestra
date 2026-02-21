import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
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
