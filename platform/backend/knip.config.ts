import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    // API surface — schemas/types exported for OpenAPI spec and SDK codegen
    "src/types/**/*.ts!",
    "src/database/schemas/**/*.ts!",
    // Fastify route plugins are registered dynamically via `Object.values(routes)` in
    // src/server.ts, so knip can't statically see individual route exports as used.
    "src/routes/**/*.ts!",
    // Standalone scripts run via `tsx` from package.json scripts (not picked up by tsdown plugin)
    "src/standalone-scripts/**/*.ts!",
    // Test infrastructure used by *.test.ts files (dev-only entries)
    "src/test/**/*.ts",
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
