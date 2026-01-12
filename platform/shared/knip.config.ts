import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
    // These are provided by devDependencies and used in scripts
    "tsc",
    "tsx",
    "knip",
  ],
  ignoreDependencies: [
    // tsx is used as a binary in scripts (codegen:api-client, codegen:theme-css)
    "tsx",
  ],
};

export default config;
