/** Every layer above the models, until the split carves them into projects. */
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
 * (`layerOf`). A layer without a `path` holds only the files it pins: a part
 * of a directory that sits above the rest of it. Tests (`*.test.ts`) and the
 * test helpers are not in a layer: they may import anything.
 *
 * `project` is the TypeScript project that checks the layer's files
 * (tsconfig.json lists them); scripts/check-projects.mjs holds the two
 * together. Layers share a project until a slice of the split carves theirs.
 *
 * @type {{ name: string; path?: string; files?: string[]; project: string }[]}
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
    // A new model that reads an agent model belongs in models-upper: pin it
    // there.
    name: "models",
    path: "^src/(models|auth)/",
    project: "tsconfig.models.json",
    files: [
      // The agent runtime health metric, backed by models.
      "src/observability/metrics/agent-runtime-health.ts",
      // The provider key mappings, and the keyless provider credentials that
      // key resolution (models-upper) falls back to.
      "src/utils/provider-key-mappings.ts",
      "src/clients/anthropic-keyless-auth.ts",
      "src/clients/anthropic-vertex.ts",
      "src/clients/anthropic-vertex-request.ts",
      "src/clients/anthropic-workload-identity.ts",
      "src/clients/azure-url.ts",
      "src/clients/azure-openai-credentials.ts",
      // What model resolution reads besides keys: the output budget an agent
      // gets, and whether Gemini runs on Vertex AI.
      "src/agents/agent-output-budget.ts",
      "src/clients/gemini-vertex-ai.ts",
      // Change notification the config-cached models subscribe to, and the
      // notify hubs it runs on.
      "src/services/config-cache.ts",
      "src/services/shared-notify-hub.ts",
      "src/services/pg-notify-hub.ts",
      // Environment isolation, which the catalog, server, skill and tool
      // models filter by.
      "src/services/environments/environment-isolation.ts",
      // Pricing and catalog data the model rows are enriched with, and the
      // price table the Bedrock pricing reads.
      "src/services/media-pricing.ts",
      "src/services/vendor-published-pricing.ts",
      "src/services/cross-provider-pricing.ts",
      "src/services/bedrock-aws-pricing.ts",
      "src/services/bedrock-aws-prices.json",
      "src/clients/models-dev-client.ts",
      // Contracts the agent run and app render diagnostics models store: the
      // runtime contract, and the app diagnostics with the native app runtime
      // they classify.
      "src/services/agent-runtime/runtime-contract.ts",
      "src/services/apps/app-diagnostics.ts",
      "src/services/apps/app-runtime-native.ts",
      // Credential and identity helpers the connected-client, provider key and
      // auth models call.
      "src/services/connected-client-oauth.ts",
      "src/services/github-app-copilot-token.ts",
      "src/services/apps/app-connector-resource.ts",
      // The request origin the auth middleware reads.
      "src/routes/request-origin.ts",
      // The SRE agent's definition the permission and runtime models read, and
      // the runtime image it names.
      "src/services/sre-agent/definition.ts",
      "src/skills-sandbox/runtime-image.ts",
      // The session id header the interaction and routing models parse, and
      // the meta header it is read from.
      "src/routes/proxy/utils/headers/session-id.ts",
      "src/routes/proxy/utils/headers/meta-header.ts",
      // The deployment names the catalog, server and Playwright runtime
      // models store (no Kubernetes client).
      "src/k8s/deployment-names.ts",
      // The ACL token format the knowledge base ACL models store.
      "src/knowledge-base/acl-tokens.ts",
      // The OpenAPPA records' encodings and identities.
      "src/openappa/plaintext-envelope.ts",
      "src/openappa/actor.ts",
      "src/openappa/session-token.ts",
      "src/openappa/policy-test-hashes.ts",
      // The skill file format the skill model reads, and the guide content
      // the built-in skills catalogue (models-agents) embeds.
      "src/skills/built-in-skill-branding.ts",
      "src/skills/appa-guide-archestra-reference.ts",
      "src/skills/appa-guide-contracts.ts",
      "src/skills/appa-guide-validation.ts",
      "src/skills/appa-guide-workflows.ts",
      "src/archestra-mcp-server/app-authoring-guidance.ts",
      "src/services/apps/app-ui-policy.ts",
      "src/skills/parser.ts",
      "src/skills/skill-manifest-serializer.ts",
      // The Archestra tool metadata the tool model reads.
      "src/archestra-mcp-server/metadata.ts",
      // Constants the chatops config model validates against.
      "src/agents/chatops/constants.ts",
      "src/agents/incoming-email/constants.ts",
      // The run link the app MCP backing resync (models-upper) reads.
      "src/services/apps/app-run-link.ts",
    ],
  },
  {
    // The agent models and what they import back: agents with their tools,
    // skills and teams, the MCP servers and catalog they use, users and
    // service accounts, and the access checks over them. They import each
    // other, so they are one layer; the models layer is below them.
    name: "models-agents",
    files: [
      "src/models/agent-access-context.ts",
      "src/models/agent-excluded-skill.ts",
      "src/models/agent-skill.ts",
      "src/models/agent-team.ts",
      "src/models/agent-tool.ts",
      "src/models/agent.ts",
      "src/models/entity-labels.ts",
      "src/models/internal-mcp-catalog.ts",
      "src/models/limit.ts",
      "src/models/mcp-catalog-team.ts",
      "src/models/mcp-server.ts",
      "src/models/proxy-request-context.ts",
      "src/models/service-account.ts",
      "src/models/skill.ts",
      "src/models/tool.ts",
      "src/models/user.ts",
      // The access checks the agent models make and the enterprise tier
      // they count users for.
      "src/auth/permission-gated.ts",
      "src/auth/utils.ts",
      "src/enterprise-tier.ts",
      // The built-in skills catalogue the skill model reads.
      "src/skills/appa-guide.ts",
      "src/skills/built-in-skills.ts",
      "src/skills/runtime-handoff.ts",
    ],
    project: "tsconfig.models-agents.json",
  },
  {
    // What builds on the agent models: conversations and interactions, apps,
    // plugins, projects and environments, provider keys and OAuth clients,
    // tool calls and usage, and the models barrel.
    name: "models-upper",
    files: [
      "src/models/app.ts",
      "src/models/conversation-enabled-tool.ts",
      "src/models/conversation.ts",
      "src/models/environment.ts",
      "src/models/external-mcp-skill-usage-event.ts",
      "src/models/hook-file.ts",
      "src/models/index.ts",
      "src/models/interaction.ts",
      "src/models/invitation.ts",
      "src/models/llm-oauth-client.ts",
      "src/models/llm-provider-api-key.ts",
      "src/models/managed-oauth-client.ts",
      "src/models/mcp-oauth-client.ts",
      "src/models/mcp-tool-call.ts",
      "src/models/playwright-runtime.ts",
      "src/models/plugin-skill-usage-event.ts",
      "src/models/plugin.ts",
      "src/models/project.ts",
      "src/models/schedule-trigger.ts",
      "src/models/skill-usage-actors.ts",
      "src/models/skill-usage-event.ts",
      "src/models/statistics.ts",
      "src/models/usage-statistics.ts",
      "src/models/virtual-api-key.ts",
      // The auth helpers that check access to agents, catalogs, OAuth
      // clients and skills, and the auth barrel.
      "src/auth/agent-type-permissions.ts",
      "src/auth/idp.ee.ts",
      "src/auth/index.ts",
      "src/auth/linked-idp.ts",
      "src/auth/mcp-catalog-permissions.ts",
      "src/auth/oauth-client-permissions.ts",
      "src/auth/request-lookups.ts",
      "src/auth/skill-permissions.ts",
      // Observability setup and the active-user metric, which count through
      // the user model.
      "src/observability/index.ts",
      "src/observability/metrics/active-users.ts",
      // Resource permissions, which the auth helpers check and update, with
      // what an update runs: the credential and MCP server assignability
      // rules, the app MCP backing resync and member removal, and the MCP
      // advanced settings the auth plugin resolves. With them, the linked
      // identity provider check and the team access to a model.
      "src/routes/proxy/utils/model-team-access.ts",
      "src/services/apps/app-mcp-backing.ts",
      "src/services/credential-resource-permissions.ts",
      "src/services/identity-providers/linked-idp-auth.ts",
      "src/services/mcp-advanced-settings.ts",
      "src/services/mcp-server-assignability.ts",
      "src/services/member-removal.ts",
      "src/services/resource-permissions.ts",
      // Provider key and model resolution, which read agents.
      "src/utils/llm-api-key-resolution.ts",
      "src/utils/llm-resolution.ts",
    ],
    project: "tsconfig.models-upper.json",
  },
  {
    name: "runtime",
    path: "^src/(k8s|sandbox-runtime|skills-sandbox)/",
    files: [
      // Runtime-neutral contracts, failure vocabulary, sizing and placement.
      "src/services/agent-runtime/backends/types.ts",
      "src/services/agent-runtime/failure-reason.ts",
      "src/services/agent-runtime/run-failure.ts",
      "src/services/agent-runtime/runtime-tiers.ts",
      // Credential resolution and network policy are shared runtime inputs.
      "src/services/credentials.ts",
      "src/services/credential-access.ts",
      "src/services/github-user-connection.ts",
      "src/services/environments/network-policy.ts",
      "src/services/environments/network-policy-domains.ts",
      // Active-use tracking belongs with the MCP runtime that owns hibernation.
      "src/services/mcp-active-use.ee.ts",
    ],
    project: "tsconfig.runtime.json",
  },
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
    files: [
      // The Better Auth instance and what composes it into the server: the
      // Fastify plugin, the route registry and the routes that serve or wire
      // the instance (the auth handler, API keys, identity providers), the SSO
      // email reconciliation its hooks run, and the JWKS key check that reads
      // its context. Lower layers reach sessions, sign-up and the key check
      // through ports (models/ports.ts).
      "src/auth/better-auth.ts",
      "src/auth/sso-email-reconciliation.ee.ts",
      "src/auth/jwks-signing-key-guard.ts",
      "src/auth/fastify-plugin/index.ts",
      "src/auth/fastify-plugin/plugin.ts",
      "src/auth/fastify-plugin/middleware.ts",
      "src/routes/index.ts",
      "src/routes/index.ee.ts",
      "src/routes/auth.ts",
      "src/routes/api-key.ts",
      "src/routes/identity-provider.ee.ts",
    ],
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
const layers = layerTable.map((layer) => {
  // A layer with neither would match every file.
  if (!layer.path && !layer.files?.length) {
    throw new Error(`Layer ${layer.name} needs a path or pinned files`);
  }
  return {
    name: layer.name,
    project: layer.project,
    path: [
      ...(layer.files?.length
        ? [`^(?:${layer.files.map(escapeRegex).join("|")})$`]
        : []),
      ...(layer.path ? [`^(?!(?:${PINNED})$)(?:${layer.path})`] : []),
    ].join("|"),
  };
});

/** The layer of a source file, or undefined for tests and files in no layer. */
export function layerOf(file) {
  if (TEST_FILE.test(file)) return undefined;
  return LAYER_MATCHERS.find(({ regex }) => regex.test(file))?.layer;
}

/** Tests and test helpers may import any layer. */
const TESTS = "(\\.test\\.ts$|\\.test-[a-z-]+\\.ts$|^src/test/|/__mocks__/)";

const TEST_FILE = new RegExp(TESTS);
const LAYER_MATCHERS = layers.map((layer) => ({
  layer,
  regex: new RegExp(layer.path),
}));

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
  required: [
    {
      name: "entry-point-binds-ports",
      severity: "error",
      comment:
        "Every entry point binds the ports of the layers below before anything uses them: import @/server/composition first, then call assertPortsBound().",
      module: {
        path: "^src/(server\\.ts|standalone-scripts/[^/]+\\.ts)$",
        // Helper modules that scripts or the test setup import, not entry points.
        pathNot: [
          TESTS,
          "^src/standalone-scripts/(hydration-schema|rebuild-interaction-user-activity-command|build-ext-apps-inline)\\.ts$",
        ],
      },
      to: { path: "^src/server/composition\\.ts$" },
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
