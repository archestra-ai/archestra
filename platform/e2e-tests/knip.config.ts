import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "tests/**/*.ts",
    "playwright.config.ts",
    "auth.setup.ts",
    "consts.ts",
  ],
  project: ["**/*.ts"],
  ignore: [],
};

export default config;

