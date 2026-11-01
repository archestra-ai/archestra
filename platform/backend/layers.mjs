/**
 * The layers of the backend program, lowest first. A file may import files of
 * its own layer and of layers below it, never above: the split of the backend
 * into referenced TypeScript projects (one per layer, or several) needs an
 * acyclic project graph, and each project must fit a 4 GiB container's check
 * budget. `pnpm check:layers` enforces the order against a baseline of the
 * imports that still break it; every slice of the split shrinks that baseline.
 * This module is also that check's dependency-cruiser configuration (below).
 *
 * Paths are dependency-cruiser regexes relative to `backend/`. A file belongs
 * to the first layer whose pattern matches it. Tests (`*.test.ts`) and the
 * test helpers are not in a layer: they may import anything.
 *
 * @type {{ name: string; path: string }[]}
 */
export const layers = [
  {
    // Drizzle tables and the types and zod schemas derived from them.
    name: "schema",
    path: "^src/(types/|database/schemas/|database/schema\\.ts$|agents/a2a/a2a-protocol\\.ts$|utils/(billable-usage|network|sanitize-svg|schedule-trigger|uuid)\\.ts$)",
  },
  {
    // Configuration, logging, the database client and the helpers below models.
    name: "core",
    path: "^src/((config|app-version|cache-manager|in-memory-lru-cache|process-local-cache-registry|constants|templating|enterprise-tier)\\.ts$|utils/|logging/|database/|log-content/|content-encryption/|secrets-manager/|observability/|integrations/|tokenizers/|git-hosts/|app-templates/)",
  },
  { name: "models", path: "^src/(models|auth)/" },
  { name: "runtime", path: "^src/(k8s|sandbox-runtime|skills-sandbox)/" },
  { name: "kb", path: "^src/knowledge-base/" },
  {
    name: "policy",
    path: "^src/(openappa|proxy|auto-routing|skills|task-queue|plugins|features|data-retention)/",
  },
  { name: "services", path: "^src/services/" },
  { name: "mcp", path: "^src/(archestra-mcp-server|agents|clients)/" },
  { name: "routes-proxy", path: "^src/routes/proxy/" },
  { name: "routes-chat", path: "^src/routes/(chat|mcp-gateway)/" },
  { name: "routes-rest", path: "^src/routes/" },
  {
    // The Fastify server, the websocket, middleware and the entry scripts.
    name: "server",
    path: "^src/((server|fastify-instance|websocket|startup-health|metrics-registration|middleware|ngrok-tunnel-manager)\\.ts$|server/|middleware/|hooks/|entrypoints/|openapi/|standalone-scripts/)",
  },
];

/** Tests and test helpers may import any layer. */
const TESTS = "(\\.test\\.ts$|\\.test-[a-z-]+\\.ts$|^src/test/|/__mocks__/)";

/**
 * The dependency-cruiser configuration `pnpm check:layers` runs. It forbids
 * every import from a layer to a layer above it, type imports and `import()`
 * included: they put files into the TypeScript program just as runtime
 * imports do. scripts/check-layers.mjs compares the result with
 * layers.known-upward-imports.json.
 */
export default {
  forbidden: [
    ...layers.slice(0, -1).map((layer, index) => ({
      name: `${layer.name}-imports-no-higher-layer`,
      severity: "error",
      comment: `A ${layer.name} file may import only ${layers
        .slice(0, index + 1)
        .map((lower) => lower.name)
        .join(
          ", ",
        )} files. Move the imported code down, the importing code up, or invert the dependency (layers.mjs).`,
      // A file belongs to the first layer whose pattern matches it.
      from: {
        path: layer.path,
        pathNot: [TESTS, ...layers.slice(0, index).map((lower) => lower.path)],
      },
      to: {
        path: layers
          .slice(index + 1)
          .map((higher) => higher.path)
          .join("|"),
        // A file of a higher layer's directory may sit in a lower layer
        // (e.g. utils/uuid.ts in schema): it is not above the importer.
        pathNot: [
          TESTS,
          ...layers.slice(0, index + 1).map((lower) => lower.path),
        ],
      },
    })),
    {
      name: "source-file-in-a-layer",
      severity: "error",
      comment:
        "Every backend source file belongs to a layer, so the order covers it. Add its directory to a layer in layers.mjs.",
      from: {
        path: "^src/",
        pathNot: [TESTS, "^src/static/", ...layers.map((layer) => layer.path)],
      },
      to: {},
    },
    {
      name: "source-imports-no-test-code",
      severity: "error",
      comment:
        "Test helpers, mocks and tests are not part of any layer; source files may not import them.",
      from: { pathNot: TESTS },
      to: { path: TESTS },
    },
  ],
  options: {
    includeOnly: "^src/",
    // Tests are roots that nothing imports; their imports are not checked.
    doNotFollow: { path: TESTS },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    skipAnalysisNotInRules: true,
  },
};
