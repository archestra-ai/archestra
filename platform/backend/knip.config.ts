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
    // Container/Helm entrypoint; referenced outside the TypeScript module graph.
    "scripts/migrate-with-lock.mjs!",
    // Operator-run concurrent DDL, also shipped in the production image.
    "scripts/create-statistics-index.mjs!",
    // GitHub Actions runs these CLIs to propose stable client version updates.
    "scripts/update-agent-runtime-clis.mjs!",
    "scripts/update-playwright-mcp.mjs!",
    "scripts/update-codex-models-client-version.mjs!",
    "scripts/update-copilot-chat-client-version.mjs!",
    "scripts/update-grok-client-version.mjs!",
    "scripts/update-vscode-client-version.mjs!",
    "scripts/update-openappa-template.mjs!",
    // Test infrastructure used by *.test.ts files (dev-only entries)
    "src/test/**/*.ts",
    // Loaded by `vitest run --config` for the opt-in session storage benchmark.
    "vitest.benchmark.config.ts",
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
    "@archestra/openappa-rs",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
  ],
};

export default config;
