import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["tests/**/*.ts", "auth.*.setup.ts", "consts.ts"],
  project: ["**/*.ts"],
  ignore: [
    // Standalone fixture MCP servers are built/run independently of the e2e workspace graph.
    "test-mcp-servers/**",
  ],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@shared",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
  ],
};

export default config;
