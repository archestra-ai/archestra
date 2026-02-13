import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
  ],
};

export default config;
