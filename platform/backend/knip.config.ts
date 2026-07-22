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
  // Browser-side static assets read at runtime via readFileSync (server.ts) —
  // not part of the backend module graph.
  ignore: ["src/static/**"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@archestra/shared",
    // Native CommonJS addon loaded through package exports; knip does not
    // resolve the workspace package's generated N-API entrypoint correctly.
    "@archestra/sandbox-rs",
    "@archestra/app-runtime-rs",
    "@archestra/image-rs",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
  ],
};

export default config;
