// Import from the leaf `interactions/client` module, not the root barrel: the
// barrel (`@archestra/shared`) transitively imports a JSON module without an
// import attribute, which the Playwright integration-test ESM loader rejects.
// `client.ts` depends only on zod.
import { DEFAULT_INTERNAL_API_BASE_URL } from "@archestra/shared/consts";
import {
  type ClientFilter,
  ClientFilterSchema,
  clientFilterToAgentIds,
} from "@archestra/shared/interactions/client";
import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import {
  agentsSeed,
  builtInAgentsSeed,
  makeAgent,
  makeAgentCatalog,
} from "./data/agents";
import {
  adminPermissionsSeed,
  adminScopedCapabilitiesSeed,
  betterAuthOrgSeed,
  sessionSeed,
} from "./data/auth";
import { catalogSeed } from "./data/catalog";
import { configSeed, healthSeed, publicConfigSeed } from "./data/config";
import {
  CONNECTOR_ID,
  connectorRunsSeed,
  connectorSeed,
} from "./data/connectors";
import {
  llmLogsInteractionsSeed,
  llmLogsSessionsSeed,
  makeInteraction,
  paginated,
} from "./data/interactions";
import {
  llmProviderApiKeysSeed,
  makeCreatedVirtualKey,
  makeLlmProviderApiKey,
  virtualKeysSeed,
} from "./data/llm-keys";
import { findMcpToolCall, mcpToolCallsSeed } from "./data/mcp-tool-calls";
import {
  appearanceSettingsSeed,
  organizationSeed,
  teamsSeed,
} from "./data/organization";
import { installedServersSeed } from "./data/servers";
import {
  activeShareLinkSeed,
  makeShareLinkCreateResult,
  shareableSkillIds,
  skillMarketplaceSeed,
} from "./data/skill-share";
import {
  skillUsageStatisticsEmptySeed,
  skillUsageStatisticsQuietSeed,
  skillUsageStatisticsSeed,
} from "./data/skill-usage";
import {
  catalogSkillSeed,
  githubDiscoverSeed,
  githubPreviewSeed,
  makeImportedSkill,
  makeSkillDetail,
  skillCatalogSearchSeed,
  skillsListSeed,
} from "./data/skills";
import {
  agentStatisticsFor,
  appStatisticsFor,
  appUsageFor,
  costStatisticsFor,
  myStatisticsFor,
  myUsageBreakdownFor,
  proxyCostStatisticsFor,
  skillStatisticsFor,
  skillUsageFor,
  teamStatisticsFor,
  toolCallUsageFor,
  userStatisticsFor,
} from "./data/statistics";
import { registryHandlers } from "./registry";
import { scheduledRunsHandlers } from "./scheduled-runs";

// Every endpoint is registered once, under its backend-relative path, which
// MSW matches against any origin. Both consumers arrive that way: the browser
// worker sees same-origin `/api/...` requests, and the mock backend route
// (`/internal-test/api/[...path]`) strips its own prefix before matching, so
// SSR calls land on the same paths. Returned as an array because several
// handlers below map over it to build a custom resolver.
function paths(path: string): [string] {
  return [path];
}

function getJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paths(path).map((url) => http.get(url, () => HttpResponse.json(body)));
}

function notFound(path: string): HttpHandler[] {
  return paths(path).map((url) => http.get(url, () => notFoundResponse()));
}

/** The backend's 404 body for a missing item. */
function notFoundResponse(message = "Not found") {
  return HttpResponse.json(
    { error: { message, type: "api_not_found_error" } },
    { status: 404 },
  );
}

function statisticsJson(
  path: string,
  build: (query: URLSearchParams) => JsonBodyType,
): HttpHandler[] {
  return paths(path).map((url) =>
    http.get(url, ({ request }) =>
      HttpResponse.json(build(new URL(request.url).searchParams)),
    ),
  );
}

function postJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paths(path).map((url) =>
    http.post(url, () => HttpResponse.json(body)),
  );
}

function putJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paths(path).map((url) => http.put(url, () => HttpResponse.json(body)));
}

function patchJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paths(path).map((url) =>
    http.patch(url, () => HttpResponse.json(body)),
  );
}

function deleteJson(
  path: string,
  body: JsonBodyType = { success: true },
): HttpHandler[] {
  return paths(path).map((url) =>
    http.delete(url, () => HttpResponse.json(body)),
  );
}

/**
 * Every entity that carries key/value labels serves the same two lookup
 * endpoints behind its filter chrome, and the filter mounts as soon as the
 * list page renders. Registered from one list rather than per entity so that
 * labelling a new entity cannot silently leak a request past MSW.
 */
const LABELLED_ENTITY_PATHS = [
  "/api/agents",
  "/api/apps",
  "/api/environments",
  "/api/internal_mcp_catalog",
  "/api/knowledge-base-connectors",
  "/api/knowledge-bases",
  "/api/knowledge-files",
  "/api/limits",
  "/api/llm-oauth-clients",
  "/api/llm-provider-api-keys",
  "/api/llm-provider-models",
  "/api/llm-virtual-keys",
  "/api/mcp-oauth-clients",
  "/api/plugins",
  "/api/service-accounts",
  "/api/skills",
  "/api/teams",
];

export const handlers: HttpHandler[] = [
  ...(process.env.NEXT_PUBLIC_SCHEDULE_REVIEW === "enabled"
    ? scheduledRunsHandlers
    : []),
  http.get("/api/skill-sandbox/artifacts/preview-fixture-wide.csv", () => {
    const headers = [
      "Team",
      "Region",
      "Owner",
      "Status",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "Notes",
    ];
    const rows = Array.from({ length: 150 }, (_, i) =>
      [
        `Example team ${i + 1}`,
        "North America",
        `Owner ${i + 1}`,
        i % 2 ? "Pending" : "Ready",
        ...Array.from({ length: 8 }, (_, m) => String((i + 1) * (m + 3))),
        `Synthetic comparison row ${i + 1}: a longer note that keeps its full text`,
      ].join(","),
    );
    return HttpResponse.text([headers.join(","), ...rows].join("\n"), {
      headers: { "Content-Type": "text/csv" },
    });
  }),
  // Byte-response fixture for the real project file preview (JSON overrides
  // cannot represent a raw CSV response with quoted commas and newlines).
  http.get("/api/skill-sandbox/artifacts/preview-fixture-report.csv", () =>
    HttpResponse.text(
      'Team,Total,Status\n"Example, Alpha",42,Ready\n"Example\nBeta",18,Pending',
      {
        headers: { "Content-Type": "text/csv" },
      },
    ),
  ),
  // Read-back routes for API clients such as Terraform; no install or binding
  // is seeded, so single reads answer as the backend does for an unknown id.
  ...getJson("/api/openappa/credential-bindings", []),
  ...notFound("/api/openappa/credential-bindings/:variable"),
  ...notFound("/api/openappa/battery-installs/:id"),
  ...getJson("/api/openappa/trust-audience", {
    trust: ["suspicious", "trusted"],
    audiences: [
      { name: "public", kind: "builtin" },
      { name: "internal", kind: "builtin" },
      { name: "self", kind: "builtin" },
    ],
  }),
  ...getJson("/api/openappa/remedies", {
    authorities: [
      {
        kind: "authority",
        name: "human",
        source: { entry: null, battery: null, line: 12 },
        implementation: { kind: "hitl", detail: "hitl" },
        tags: [],
        permits: {
          attention: ["*"],
          audienceMissing: [],
          trustBelow: null,
          effectsContaining: [],
        },
        lastConsult: null,
      },
    ],
    sanitizers: [
      {
        kind: "sanitizer",
        name: "attest-schema",
        source: { entry: null, battery: null, line: 20 },
        implementation: { kind: "builtin", detail: "attest-schema" },
        tags: [],
        on: ["tool_output"],
        permits: { kind: "trust", from: "suspicious", to: "trusted" },
        lastConsult: null,
      },
    ],
    blocks: [
      {
        kind: "trust",
        level: "suspicious",
        approvers: [],
        cleaners: ["attest-schema"],
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "audience",
        level: "internal",
        approvers: [],
        cleaners: [],
        unservedMarks: [],
        covered: false,
      },
      {
        kind: "audience",
        level: "self",
        approvers: [],
        cleaners: [],
        unservedMarks: [],
        covered: false,
      },
    ],
  }),
  ...getJson("/api/openappa/remedies/activity", {
    timeZone: "UTC",
    days: [
      { date: "2026-10-02", blocked: 1, approved: 3, cleaned: 2 },
      { date: "2026-10-03", blocked: 0, approved: 0, cleaned: 0 },
      { date: "2026-10-04", blocked: 2, approved: 5, cleaned: 6 },
      { date: "2026-10-05", blocked: 3, approved: 2, cleaned: 1 },
      { date: "2026-10-06", blocked: 0, approved: 4, cleaned: 3 },
      { date: "2026-10-07", blocked: 1, approved: 1, cleaned: 5 },
      { date: "2026-10-08", blocked: 1, approved: 2, cleaned: 2 },
    ],
  }),
  ...getJson("/api/openappa/policy-tests/runs", []),
  // A session trace reads its guardrail checks and label history; none by default.
  ...getJson("/api/openappa/external-consults", {
    data: [],
    pagination: { limit: 100, hasNext: false, nextCursor: null },
  }),
  ...getJson("/api/openappa/label-changes", { data: [] }),
  ...getJson("/api/openappa/yells/summary", { unresolved: 0 }),
  ...getJson("/api/openappa/yells", {
    data: [],
    pagination: { limit: 20, hasNext: false, nextCursor: null },
  }),
  // Label lookups for every labelled entity (see LABELLED_ENTITY_PATHS).
  // First in the array so no entity-specific pattern can shadow them.
  ...LABELLED_ENTITY_PATHS.flatMap((entity) => [
    ...getJson(`${entity}/labels/keys`, []),
    ...getJson(`${entity}/labels/values`, []),
  ]),
  ...getJson("/api/auth/get-session", sessionSeed),
  // Every signed-in user loads the banner; no notice is active by default.
  ...getJson("/api/site-notification", null),
  ...getJson("/api/auth/default-credentials-status", { enabled: false }),
  ...getJson("/api/auth/organization/list", []),
  ...getJson("/api/auth/organization/get-full-organization", betterAuthOrgSeed),
  // The role behind `useIsGlobalAdmin` — admin, matching the session identity,
  // so admin-only affordances (permanent delete) render.
  ...getJson("/api/auth/organization/get-active-member-role", {
    role: sessionSeed.user.role,
  }),
  // Unavailable by default, so the shell falls back to the individual reads
  // below and per-test overrides of those endpoints keep taking effect.
  ...paths("/api/bootstrap").map((url) =>
    http.get(url, () => HttpResponse.json(null, { status: 401 })),
  ),
  // The new-chat composer's bundle: unavailable by default for the same
  // reason, so the composer loads from the individual reads.
  ...paths("/api/bootstrap/new-chat").map((url) =>
    http.get(url, () => HttpResponse.json(null, { status: 401 })),
  ),
  // A conversation's first screen: unavailable by default, so the page loads
  // the conversation and composer from the individual reads.
  ...paths("/api/bootstrap/conversation/:id").map((url) =>
    http.get(url, () => HttpResponse.json(null, { status: 401 })),
  ),
  ...getJson("/api/user/permissions", adminPermissionsSeed),
  ...getJson("/api/resource-permissions", adminScopedCapabilitiesSeed),
  // Recipients for an object not created yet: the admin may share with
  // everyone. Registered before the per-object route, which would match it.
  ...getJson("/api/resource-permissions/:resource/creation-subjects", [
    {
      subject: { type: "organization", id: "*" },
      name: "Everyone in the organization",
    },
  ]),
  // An object's own permissions: none beyond the admin's, who may edit them.
  ...paths("/api/resource-permissions/:resource/:scope").map((url) =>
    http.get(url, ({ params }) =>
      HttpResponse.json({
        resource: params.resource,
        scope: params.scope,
        name: "",
        revision: 0,
        actorSubjects: [],
        canShareOrganizationWide: true,
        grants: [],
        inheritedGrants: [],
        effectiveActions: [
          "read",
          "use",
          "update",
          "delete",
          "manage-permissions",
        ],
      }),
    ),
  ),
  ...getJson("/api/resource-permissions/:resource/:scope/subjects", []),
  ...getJson("/api/user/permission-sources", [
    {
      role: sessionSeed.user.role,
      team: null,
      permissions: adminPermissionsSeed,
    },
  ]),
  ...getJson("/api/credentials", []),
  // GitHub Apps and GitLab tokens offered by the Git setup steps.
  ...getJson("/api/git-credentials", []),
  ...getJson("/api/git-credentials/:id/repositories", []),
  ...getJson("/api/git-credentials/:id/namespaces", []),
  ...getJson("/api/config", configSeed),
  ...getJson("/api/config/public", publicConfigSeed),
  ...getJson("/api/guardrails-deployment", {
    enabled: false,
    featureEnabled: false,
    active: false,
  }),
  ...getJson("/health", healthSeed),
  ...getJson("/ready", {
    ...healthSeed,
    database: "connected",
    sandbox: "disabled",
  }),
  ...getJson("/api/organization", organizationSeed),
  ...getJson("/api/default-user-limits", []),
  // Per-user limit usage on the Limits page: no members, nothing spent.
  ...getJson("/api/default-user-limits/users", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
    summary: {
      total: 0,
      at: 0,
      near: 0,
      custom: 0,
      none: 0,
      organizationDefault: 0,
      environmentDefault: 0,
      flaggedCustom: 0,
      spent: 0,
      resetsAt: null,
      environments: [],
    },
  }),
  ...getJson("/api/organization/appearance-settings", appearanceSettingsSeed),
  // Onboarding nudges: everything already seen / nothing eligible, so neither
  // the red dots nor the survey/feedback dialogs interfere with other tests.
  ...getJson("/api/onboarding/seen-nav-items", {
    items: [
      "nav:projects",
      "nav:apps",
      "nav:connect",
      "nav:model-providers",
      "nav:mcp-registry",
      "nav:guardrails",
    ],
  }),
  ...postJson("/api/onboarding/seen-nav-items", { items: [] }),
  ...getJson("/api/onboarding/survey-eligibility", { eligible: false }),
  ...postJson("/api/onboarding/survey", { ok: true }),
  ...getJson("/api/organization/mcp-preset-entries", []),
  ...getJson("/api/connected-clients", []),
  ...getJson("/api/chat/agents/:agentId/mcp-tools", []),
  // Connect reads the gateway's served tool list and initial context cost.
  ...getJson("/api/agents/:id/mcp-tool-preview", {
    toolExposureMode: "full",
    tools: [],
    tokenCount: { total: 0, source: "estimate", model: null, observedAt: null },
  }),
  ...getJson("/api/projects", paginated([], { limit: 20 })),
  ...getJson("/api/apps", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 100,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  // The Audit Logs page's resource picker searches this when it opens, and
  // reads one entry to label a resource filter carried in the URL. No
  // matches keeps the strict unhandled-request guard satisfied.
  ...getJson("/api/audit-logs/resources", { data: [] }),
  // Fetched by the catalog form's Environment selector (and the Environments
  // section). Empty list keeps the strict unhandled-request guard satisfied.
  ...getJson("/api/environments", {
    environments: [],
    defaultAssignedCatalogCount: 0,
  }),
  // Fetched by the agent settings page's messaging-channels section, and by
  // the record's own Messaging Channels tab. No configured providers and no
  // bindings keep the strict unhandled-request guard satisfied while the
  // editor still renders its provider setup links and an empty assignment
  // table.
  ...getJson("/api/chatops/status", { providers: [] }),
  ...getJson("/api/chatops/config/slack", {
    configured: false,
    updatedAt: null,
    enabled: false,
    appId: null,
    connectionMode: "socket",
  }),
  ...getJson("/api/chatops/config/ms-teams", {
    configured: false,
    updatedAt: null,
    enabled: false,
    appId: null,
    tenantId: null,
    groupChatFileSignIn: false,
    signInRedirectUri:
      "http://localhost:3000/api/webhooks/chatops/ms-teams/sign-in/callback",
  }),
  ...getJson("/api/chatops/config/telegram", {
    configured: false,
    updatedAt: null,
    enabled: false,
  }),
  // The record's Slack bot section: no bots, Slack not connected. The agent
  // edit page mounts it on every step, so it is read whichever step opens.
  ...getJson("/api/chatops/config/slack/agents", {
    bots: [],
    canCreateApps: false,
    oneClickInstall: false,
    unassignedApp: null,
    workspaceName: null,
  }),
  ...getJson("/api/chatops/bindings", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 100,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
    // The record's tab reads these counts; the settings page does not.
    counts: { configured: 0, unassigned: 0 },
  }),
  ...getJson("/api/teams", teamsSeed),
  ...getJson("/api/members", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 50,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  ...getJson("/api/internal_mcp_catalog", catalogSeed),
  // Batched catalog tools (the tool pickers' one-request replacement for the
  // per-catalog fan-out). Ahead of the `:catalogId` patterns below so a literal
  // "tools" segment can never be read as a catalog id.
  ...getJson("/api/internal_mcp_catalog/tools", []),
  ...getJson("/api/internal_mcp_catalog/:catalogId/children", []),
  // Paged search, issue index and by-id reads, derived from the lists above.
  ...registryHandlers,
  ...getJson("/api/mcp_server", installedServersSeed),
  // Org-wide auto-mode roster; per-test seeds override when a test needs
  // auto-mode agents in the usage surfaces.
  ...getJson("/api/mcp_server/auto_mode_agents/page", {
    data: [],
    totalAutoCount: 0,
    organizationId: organizationSeed.id,
    pagination: { limit: 20, hasNext: false, nextCursor: null },
  }),
  ...getJson("/api/mcp_server/auto_mode_agents", []),
  // One install with its agents, which the list leaves out. The uninstall
  // confirmation reads it to name the agents that lose access. After the
  // literal `auto_mode_agents` paths so they are never read as an id.
  ...paths("/api/mcp_server/:id").map((url) =>
    http.get(url, ({ params }) => {
      const server = installedServersSeed.find(
        (candidate) => candidate.id === params.id,
      );
      return server
        ? HttpResponse.json(server)
        : notFoundResponse("MCP server not found");
    }),
  ),
  ...getJson("/api/secrets/type", { type: "DB", meta: {} }),
  ...getJson("/api/k8s/image-pull-secrets", []),
  ...getJson("/api/k8s/capabilities", {
    agentSandbox: {
      installed: false,
      missingResources: [
        "sandboxes.agents.x-k8s.io",
        "sandboxclaims.extensions.agents.x-k8s.io",
        "sandboxtemplates.extensions.agents.x-k8s.io",
        "sandboxwarmpools.extensions.agents.x-k8s.io",
      ],
      message: "The Agent Sandbox controller is not installed.",
    },
    networkPolicy: {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes",
      supportsFqdn: false,
      supportsHttpMethods: false,
      message: null,
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      probe: "enforced",
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  }),

  // The caller's personal gateway token, read by the connect panels.
  ...getJson("/api/user-tokens/me", {
    id: "test-user-token",
    name: "Test Admin's token",
    tokenStart: "archestra_",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
  }),

  // Agents
  ...getJson("/api/agents", agentsSeed),
  ...paths("/api/agent-catalog").map((url) =>
    http.get(url, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const includeBuiltIn =
        params.get("includeBuiltIn") === "true" ||
        params.get("scope") === "built_in";
      const agents =
        includeBuiltIn && params.get("pinned") !== "true"
          ? builtInAgentsSeed.filter((agent) =>
              agent.name
                .toLowerCase()
                .includes((params.get("name") ?? "").toLowerCase()),
            )
          : [];
      return HttpResponse.json(makeAgentCatalog({ agents }));
    }),
  ),
  ...getJson("/api/agents/chat-roster", []),
  ...getJson("/api/agents/credential-readiness", []),
  ...getJson("/api/agents/options/page", {
    data: [],
    pagination: { limit: 20, nextCursor: null, hasNext: false },
  }),
  ...getJson("/api/agents/options/ids", []),
  ...getJson("/api/agents/options", {
    data: [],
    pagination: { limit: 100, nextCursor: null, hasNext: false },
  }),
  // Keep literal agent routes before `:id`, or MSW treats the literal segment
  // as an id and returns an agent-shaped response to the activation editor.
  ...getJson("/api/agents/activation-skills", {
    enabled: true,
    data: [],
    pagination: {
      currentPage: 1,
      limit: 100,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  ...getJson("/api/agents/:id", makeAgent()),
  ...getJson("/api/agents/:id/export", {}),
  ...getJson("/api/agents/:id/tools", []),
  ...getJson("/api/agent-tools", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 1,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  ...getJson("/api/agents/:id/default-suggested-prompts", []),
  ...getJson("/api/agents/:id/delegations", []),
  ...getJson("/api/agents/:id/a2a-delegations", []),
  ...getJson("/api/a2a/remote-agents", []),
  ...getJson("/api/agents/default-mcp-gateway", null),
  // The agents list asks which of the caller's agents is their personal
  // default; unmocked, it reaches the real backend and trips the leak guard.
  ...getJson("/api/members/default-agent", { defaultAgentId: null }),
  // The new-chat page asks for the member's saved model too; unmocked, the
  // request escapes to the real backend and trips the leak guard.
  ...getJson("/api/members/default-model", {
    modelId: null,
    chatApiKeyId: null,
  }),
  ...postJson("/api/agents", makeAgent()),
  ...postJson(
    "/api/agents/:id/clone",
    makeAgent({ id: "test-agent-clone", name: "test-agent-clone" }),
  ),
  // SDK uses PUT for updateAgent; keep PATCH too in case a test overrides
  // generically via `mswControl.use(method: "patch")`.
  ...putJson("/api/agents/:id", makeAgent()),
  ...patchJson("/api/agents/:id", makeAgent()),
  ...deleteJson("/api/agents/:id"),

  // Chat / role list / model availability — fired by the agent dialog +
  // sidebar. Default empty so dialog open doesn't blow up the leak guard.
  ...getJson("/api/chat/conversations", []),
  ...getJson("/api/chat/conversations/:id/openappa-status", null),
  ...getJson("/api/roles", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  ...getJson("/api/llm-models/available", []),
  ...getJson("/api/internal_mcp_catalog/:catalogId/tools", []),

  // LLM provider API keys (plain array — not paginated)
  ...getJson("/api/llm-provider-api-keys", llmProviderApiKeysSeed),
  ...getJson("/api/llm-provider-api-keys/available", []),
  // Deep-linkable detail dialogs refetch the opened key by id; keep this after
  // "/available" so that route isn't swallowed by ":id".
  ...getJson("/api/llm-provider-api-keys/:id", makeLlmProviderApiKey()),
  ...postJson("/api/llm-provider-api-keys", makeLlmProviderApiKey()),
  ...patchJson("/api/llm-provider-api-keys/:id", makeLlmProviderApiKey()),
  ...deleteJson("/api/llm-provider-api-keys/:id"),

  // MCP OAuth clients (bare array, unlike the LLM half's envelope) — the
  // unified OAuth Clients page reads both.
  ...getJson("/api/mcp-oauth-clients", []),
  // LLM OAuth clients (paginated envelope) — used by the OAuth Clients page.
  ...getJson("/api/llm-oauth-clients", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),
  // Managed OAuth clients (paginated envelope) — the LLM keys delete dialog
  // lists the clients that map the key from here, because this list carries
  // the current-and-future-providers flag the dialog needs.
  ...getJson("/api/oauth-clients", {
    data: [],
    pagination: {
      currentPage: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    },
  }),

  // Virtual API keys (paginated envelope)
  ...getJson("/api/llm-virtual-keys", virtualKeysSeed),
  ...postJson("/api/llm-virtual-keys", makeCreatedVirtualKey()),
  ...patchJson("/api/llm-virtual-keys/:id", makeCreatedVirtualKey()),
  ...deleteJson("/api/llm-virtual-keys/:id"),

  // Skills (list page, the "new skill" chooser, and the GitHub import dialog)
  ...getJson("/api/skills", skillsListSeed),
  ...getJson("/api/skills/plugins", []),
  ...getJson("/api/plugins", []),
  ...paths("/api/skills/:id").map((url) =>
    http.get(url, ({ params }) =>
      HttpResponse.json(makeSkillDetail(String(params.id))),
    ),
  ),
  // Usage analytics per skill. Which seed answers depends on the skill, so the
  // Usage tab can be seen in all three of its states — a crowded skill worth
  // searching, a quiet one, and one nobody has run.
  ...paths("/api/skills/:id/usage-statistics").map((url) =>
    http.get(url, ({ params }) =>
      HttpResponse.json(
        USAGE_STATISTICS_BY_SKILL[String(params.id)] ??
          skillUsageStatisticsSeed,
      ),
    ),
  ),
  ...getJson("/api/skills/source-repos", { repos: [] }),
  ...getJson("/api/skills/catalog/search", skillCatalogSearchSeed),
  ...postJson("/api/skills/github/discover", githubDiscoverSeed),
  ...postJson("/api/skills/github/preview", githubPreviewSeed),
  // Conditional on the request payload: `mswControl.use(...)` overrides can
  // only return static bodies, so the import spec asserts the request payload
  // indirectly — the import only succeeds for the exact body the catalog flow
  // must send. Any other payload is reported skipped, which keeps the import
  // dialog open and fails the spec's dialog-closed assertion.
  ...paths("/api/skills/github/import").map((url) =>
    http.post(url, async ({ request }) => {
      const body = (await request.json()) as {
        repoUrl?: string;
        skillPaths?: string[];
      };
      // The dialog sends the repository's full address.
      const isExpectedPayload =
        body.repoUrl?.replace(/^https:\/\/github\.com\//, "") ===
          catalogSkillSeed.repo &&
        body.skillPaths?.length === 1 &&
        body.skillPaths[0] === catalogSkillSeed.skillPath;
      return HttpResponse.json(
        isExpectedPayload
          ? { created: [makeImportedSkill()], skipped: [], skippedFiles: [] }
          : { created: [], skipped: body.skillPaths ?? [], skippedFiles: [] },
      );
    }),
  ),

  // LLM proxy logs (/llm/logs list and the session detail page).
  ...getJson("/api/interactions/sessions/:sessionId/lineage", {
    forkedFrom: null,
    forks: [],
    forksTruncated: false,
  }),
  // The sessions handler is query-aware: it filters the seed by the params the
  // frontend actually sends (sessionId / client / source), so the Client/Source
  // filter specs genuinely exercise the request wiring rather than asserting
  // against a pre-baked body. Specs needing other data still override it via
  // `mswControl.use(...)` (overrides take precedence).
  ...paths("/api/interactions/sessions").map((url) =>
    http.get(url, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const sessionId = params.get("sessionId");
      const client = params.get("client");
      const source = params.get("source");
      let data = llmLogsSessionsSeed;
      if (sessionId) data = data.filter((s) => s.sessionId === sessionId);
      if (client && ClientFilterSchema.safeParse(client).success) {
        const ids = new Set(
          clientFilterToAgentIds(client as ClientFilter).map((id) =>
            id.toLowerCase(),
          ),
        );
        data = data.filter((s) =>
          s.externalAgentIds.some((a) => ids.has(a.toLowerCase())),
        );
      }
      if (source) data = data.filter((s) => s.source === source);
      return HttpResponse.json(paginated(data));
    }),
  ),
  ...getJson("/api/interactions/user-ids", []),
  ...getJson("/api/interactions/external-agent-ids", []),
  ...getJson("/api/interactions", paginated(llmLogsInteractionsSeed)),
  ...getJson("/api/interactions/:interactionId", makeInteraction()),

  // /connection probes the org's default gateway + the single LLM Proxy
  ...getJson("/api/mcp-gateways/default", makeAgent()),
  ...getJson("/api/llm-proxy", makeAgent()),

  // The connection approval page an installer opens (/connection with a
  // connectRequest): its request, the skill names it lists, and the setup it
  // prepares (on the server with the document, else in the browser).
  ...getJson("/api/client-connections/:id", {
    clientId: "opencode",
    platform: "linux",
    exclude: [],
    gateway: null,
    plugins: null,
    deviceName: "test-laptop",
    userCode: "ABCD-1234",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }),
  ...getJson("/api/skills/names", { data: [], total: 0 }),
  ...postJson("/api/connection-setups", {
    id: "setup-1",
    // A mock of the setup command, on the loopback address the platform
    // dials itself by (see shared/loopback-dial.test.ts).
    command: `curl -fsSL '${DEFAULT_INTERNAL_API_BASE_URL}/api/connection-setups/tok' | bash`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    tokenStart: "tok",
    plugins: [],
  }),

  // The static marketplace (the primary install path in the /connection step).
  ...getJson("/api/skill-marketplace", skillMarketplaceSeed),

  // Skill share links (the marketplace step on /connection). The create and
  // rotate handlers are conditional on the request payload for the same
  // reason as the github import handler above: success (snippets revealed)
  // pins the exact body the step must send.
  ...getJson("/api/skill-share-links", { links: [] }),
  ...paths("/api/skill-share-links").map((url) =>
    http.post(url, async ({ request }) => {
      const body = (await request.json()) as { skillIds?: string[] };
      const isExpectedPayload =
        [...(body.skillIds ?? [])].sort().join() ===
        [...shareableSkillIds].sort().join();
      return isExpectedPayload
        ? HttpResponse.json(makeShareLinkCreateResult("created0"))
        : HttpResponse.json(
            { error: { message: "unexpected create payload", type: "test" } },
            { status: 400 },
          );
    }),
  ),
  ...paths("/api/skill-share-links/:id/rotate").map((url) =>
    http.post(url, async ({ request, params }) => {
      const body = (await request.json()) as {
        skillIds?: string[];
        expiresAt?: string | null;
      };
      const isExpectedPayload =
        params.id === activeShareLinkSeed.id &&
        body.expiresAt === activeShareLinkSeed.expiresAt &&
        [...(body.skillIds ?? [])].sort().join() ===
          [...shareableSkillIds].sort().join();
      return isExpectedPayload
        ? HttpResponse.json(makeShareLinkCreateResult("rotated0"))
        : HttpResponse.json(
            { error: { message: "unexpected rotate payload", type: "test" } },
            { status: 400 },
          );
    }),
  ),
  ...deleteJson("/api/skill-share-links/:id", { success: true }),

  // Misc endpoints the agent dialog and key dialogs probe at open. Default
  // empty so the strict-mode unhandled-request guard doesn't fire on
  // background fetches we don't actually care about for these tests.
  ...getJson("/api/llm-models", []),
  ...getJson("/api/llm-models/key-model-ids", []),
  ...getJson("/api/llm-models/options", []),
  ...getJson("/api/llm-models/by-provider", []),
  ...getJson("/api/llm-models/with-api-keys", []),
  ...getJson("/api/knowledge-bases", []),
  ...getJson("/api/connectors", paginated([connectorSeed])),
  ...getJson("/api/connectors/:id", connectorSeed),
  ...getJson(
    "/api/connectors/:id/runs",
    paginated(connectorRunsSeed, { total: 178 }),
  ),
  ...getJson("/api/connectors/:id/permission-coverage", {
    connectorId: CONNECTOR_ID,
    totalDocuments: connectorSeed.totalDocsIngested,
    failClosedDocuments: 0,
    nextScheduledAt: "2026-08-27T08:00:00.000Z",
  }),
  ...getJson("/api/mcp-tool-calls", paginated(mcpToolCallsSeed)),
  ...paths("/api/mcp-tool-calls/:mcpToolCallId").map((url) =>
    http.get(url, ({ params }) =>
      HttpResponse.json(findMcpToolCall(String(params.mcpToolCallId))),
    ),
  ),
  ...getJson("/api/identity-providers", []),
  // Costs and My Usage: generated from one seeded activity curve so the
  // endpoints reconcile and honour timeframe, groupBy, filters and paging.
  ...statisticsJson("/api/statistics/costs", costStatisticsFor),
  ...statisticsJson("/api/statistics/llm-proxy", proxyCostStatisticsFor),
  ...statisticsJson("/api/statistics/users", userStatisticsFor),
  ...statisticsJson("/api/statistics/teams", teamStatisticsFor),
  ...statisticsJson("/api/statistics/agents", agentStatisticsFor),
  ...statisticsJson("/api/statistics/app-usage", appUsageFor),
  ...statisticsJson("/api/statistics/skill-usage", skillUsageFor),
  ...statisticsJson("/api/statistics/mcp-tool-calls", toolCallUsageFor),
  ...statisticsJson("/api/statistics/apps", appStatisticsFor),
  ...statisticsJson("/api/statistics/skills", skillStatisticsFor),
  ...statisticsJson("/api/statistics/me", myStatisticsFor),
  ...statisticsJson("/api/statistics/me/breakdown", myUsageBreakdownFor),
];

const USAGE_STATISTICS_BY_SKILL: Record<
  string,
  typeof skillUsageStatisticsSeed
> = {
  "skill-jira-task": skillUsageStatisticsSeed,
  "skill-release-checklist": skillUsageStatisticsQuietSeed,
  "skill-incident-postmortem": skillUsageStatisticsEmptySeed,
};
