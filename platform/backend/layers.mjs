/** Every layer above core, until the split carves them into projects. */
const APP = "tsconfig.app.json";

/**
 * The layers of the backend program, lowest first. A file may import files of
 * its own layer and of layers below it, never above: the split of the backend
 * into referenced TypeScript projects (one per layer, or several) needs an
 * acyclic project graph, and each project must fit a 4 GiB container's check
 * budget. `pnpm check:layers` enforces the order against a baseline of the
 * imports that still break it; every slice of the split shrinks that baseline.
 * This module is also that check's dependency-cruiser configuration (below).
 *
 * `path` is a dependency-cruiser regex relative to `backend/`. `files` pins
 * files to a layer other than the one their path suggests: a small module that
 * lower layers need, or a helper whose imports belong higher. A file belongs to
 * the layer that pins it, else to the first layer whose `path` matches it
 * (`layerOf`). Tests (`*.test.ts`) and the test helpers are not in a layer:
 * they may import anything.
 *
 * `project` is the TypeScript project that checks the layer's files
 * (tsconfig.json lists them); scripts/check-projects.mjs holds the two
 * together. Layers share a project until a slice of the split carves theirs.
 *
 * @type {{ name: string; path: string; files?: string[]; project: string }[]}
 */
const layerTable = [
  {
    // Drizzle tables and the types and zod schemas derived from them, and the
    // ambient declarations every TypeScript project includes.
    name: "schema",
    path: "^src/(ambient/|types/|database/schemas/|database/schema\\.ts$|agents/a2a/a2a-protocol\\.ts$|utils/(billable-usage|network|sanitize-svg|schedule-trigger|uuid)\\.ts$)",
    project: "tsconfig.schema.json",
  },
  {
    // Configuration, logging, the database client and the helpers below models.
    name: "core",
    path: "^src/((config|app-version|cache-manager|in-memory-lru-cache|process-local-cache-registry|constants|templating)\\.ts$|utils/|logging/|database/|log-content/|content-encryption/|secrets-manager/|observability/|integrations/|tokenizers/|git-hosts/)",
    files: [
      // The API route table config.ts and the request metrics read.
      "src/routes/route-paths.ts",
      // The app name, used in copy across every layer.
      "src/archestra-mcp-server/branding.ts",
      // The stores of the cache manager, content encryption and secrets.
      "src/models/cache-entry.ts",
      "src/models/content-encryption-state.ee.ts",
      "src/models/encryption-key-canary.ts",
      "src/models/secret.ts",
      // A size-capped response reader the git host client uses.
      "src/plugins/bounded-response.ts",
      // The upload file name rules utils/upload-filename.ts applies.
      "src/skills-sandbox/file-path.ts",
      // Bedrock credentials, which the secrets manager resolves.
      "src/clients/bedrock-client.ts",
      "src/clients/bedrock-credentials.ts",
      // The upstream fetch the LLM metrics wrap, and the Responses API usage
      // reader they share with the proxy.
      "src/clients/llm-upstream-dispatcher.ts",
      "src/clients/llm-upstream-fetch.ts",
      "src/routes/proxy/adapters/responses-usage.ts",
    ],
    project: "tsconfig.core.json",
  },
  {
    name: "models",
    path: "^src/(models|auth)/",
    files: [
      // Count users through the user model.
      "src/enterprise-tier.ts",
      // Observability setup and the metrics backed by models.
      "src/observability/index.ts",
      "src/observability/metrics/active-users.ts",
      "src/observability/metrics/agent-runtime-health.ts",
      // Provider key resolution reads keys through the models; the keyless
      // provider credentials it falls back to come with it.
      "src/utils/llm-api-key-resolution.ts",
      "src/utils/provider-key-mappings.ts",
      "src/utils/llm-resolution.ts",
      "src/clients/anthropic-keyless-auth.ts",
      "src/clients/anthropic-vertex.ts",
      "src/clients/anthropic-vertex-request.ts",
      "src/clients/anthropic-workload-identity.ts",
      "src/clients/azure-url.ts",
      "src/clients/azure-openai-credentials.ts",
    ],
    project: APP,
  },
  { name: "runtime", path: "^src/(k8s|sandbox-runtime|skills-sandbox)/", project: APP },
  { name: "kb", path: "^src/knowledge-base/", project: APP },
  {
    name: "policy",
    path: "^src/(openappa|proxy|auto-routing|skills|task-queue|plugins|features|data-retention)/",
    // Git access resolves runtime credentials for the skill and plugin imports.
    files: ["src/git-hosts/git-access.ts"],
    project: APP,
  },
  {
    name: "services",
    path: "^src/(services|app-templates)/",
    // Reads the error tracker's report of the previous container's exit.
    files: ["src/observability/previous-termination-report.ts"],
    project: APP,
  },
  { name: "mcp", path: "^src/(archestra-mcp-server|agents|clients)/", project: APP },
  { name: "routes-proxy", path: "^src/routes/proxy/", project: APP },
  { name: "routes-chat", path: "^src/routes/(chat|mcp-gateway)/", project: APP },
  { name: "routes-rest", path: "^src/routes/", project: APP },
  {
    // The Fastify server, the websocket, middleware and the entry scripts.
    name: "server",
    path: "^src/((server|fastify-instance|websocket|startup-health|metrics-registration|middleware|ngrok-tunnel-manager)\\.ts$|server/|middleware/|hooks/|entrypoints/|openapi/|standalone-scripts/)",
    project: APP,
  },
];

/** Every pinned file, as a regex alternative. */
const PINNED = layerTable
  .flatMap((layer) => layer.files ?? [])
  .map(escapeRegex)
  .join("|");

/**
 * The layers with the patterns dependency-cruiser and the checks match: a
 * layer's pinned files, or its `path` for any file no layer pins.
 *
 * @type {{ name: string; path: string; project: string }[]}
 */
export const layers = layerTable.map((layer) => ({
  name: layer.name,
  project: layer.project,
  path: [
    ...(layer.files?.length
      ? [`^(?:${layer.files.map(escapeRegex).join("|")})$`]
      : []),
    `^(?!(?:${PINNED})$)(?:${layer.path})`,
  ].join("|"),
}));

/** The layer of a source file, or undefined for tests and files in no layer. */
export function layerOf(file) {
  if (new RegExp(TESTS).test(file)) return undefined;
  return layers.find((layer) => new RegExp(layer.path).test(file));
}

/** Tests and test helpers may import any layer. */
export const TESTS = "(\\.test\\.ts$|\\.test-[a-z-]+\\.ts$|^src/test/|/__mocks__/)";

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

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
