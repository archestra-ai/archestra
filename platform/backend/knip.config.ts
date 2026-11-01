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
    // The `!` script entries below are package.json scripts too, so the dev
    // pass calls them redundant; the production pass needs them.
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
    // Provides tsc, which scripts/type-check.ts runs for `pnpm type-check`.
    "typescript-7",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
    // System tools that tests run where the machine has them.
    "kubectl",
    "unshare",
    "pwsh",
    "flock",
  ],
  // An export its own file names in a type (a schema behind a z.infer, a type
  // in a public signature) is not dead, as knip 5 judged it. Exports used in
  // their own file only at runtime are still reported.
  ignoreExportsUsedInFile: { type: true, interface: true },
  rules: {
    // knip runs per workspace, outside the root that holds pnpm's catalog,
    // so it cannot resolve `catalog:`; pnpm install already fails on a bad one.
    catalogReferences: "off",
  },
};

export default config;
