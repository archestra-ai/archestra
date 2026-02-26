import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome and concurrently are in the workspace root package.json
    "biome",
    "concurrently",
  ],
};

export default config;
