import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "index.ts",
    "hey-api/**/*.ts",
    "themes/**/*.ts",
  ],
  project: ["**/*.ts"],
  ignore: [],
};

export default config;

