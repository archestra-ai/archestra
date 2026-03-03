import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome, concurrently, and tsx are in the workspace root package.json
    "biome",
    "concurrently",
    "tsx",
  ],
};

export default config;
