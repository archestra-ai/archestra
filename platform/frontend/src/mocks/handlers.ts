// Import from the leaf `interactions/client` module, not the root barrel: the
// barrel (`@archestra/shared`) transitively imports a JSON module without an
// import attribute, which the Playwright integration-test ESM loader rejects.
// `client.ts` depends only on zod.
import {
  type ClientFilter,
  ClientFilterSchema,
  clientFilterToAgentIds,
} from "@archestra/shared/interactions/client";
import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import { agentsSeed, makeAgent } from "./data/agents";
import {
  adminPermissionsSeed,
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

export const handlers: HttpHandler[] = [
  ...getJson("/api/auth/get-session", sessionSeed),
  ...getJson("/api/auth/default-credentials-status", { enabled: false }),
  ...getJson("/api/auth/organization/list", []),
  ...getJson("/api/auth/organization/get-full-organization", betterAuthOrgSeed),
  // The role behind `useIsGlobalAdmin` — admin, matching the session identity,
  // so admin-only affordances (permanent delete) render.
  ...getJson("/api/auth/organization/get-active-member-role", {
    role: sessionSeed.user.role,
  }),
  ...getJson("/api/user/permissions", adminPermissionsSeed),
  ...getJson("/api/config", configSeed),
  ...getJson("/api/config/public", publicConfigSeed),
  ...getJson("/health", healthSeed),
  ...getJson("/api/organization", organizationSeed),
  // The roster behind owner pickers and the scope filter's "member" facet —
  // the seeded admin, mirroring the session identity.
  ...getJson("/api/organization/members", [
    {
      id: sessionSeed.user.id,
      name: sessionSeed.user.name,
      email: sessionSeed.user.email,
    },
  ]),
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
      "feedback:popup",
    ],
  }),
  ...postJson("/api/onboarding/seen-nav-items", { items: [] }),
  ...getJson("/api/onboarding/survey-eligibility", { eligible: false }),
  ...postJson("/api/onboarding/survey", { ok: true }),
  ...getJson("/api/onboarding/feedback-popup-activation", {
    activatedAt: null,
  }),
  ...getJson("/api/organization/mcp-preset-entries", []),
  ...getJson("/api/projects", []),
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
  // Fetched by the catalog form's Environment selector (and the Environments
  // section). Empty list keeps the strict unhandled-request guard satisfied.
  ...getJson("/api/environments", {
    environments: [],
    defaultAssignedCatalogCount: 0,
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
  ...getJson("/api/internal_mcp_catalog/labels/keys", []),
  ...getJson("/api/internal_mcp_catalog/:catalogId/children", []),
  ...getJson("/api/mcp_server", installedServersSeed),
  // Org-wide auto-mode roster; per-test seeds override when a test needs
  // auto-mode agents in the usage surfaces.
  ...getJson("/api/mcp_server/auto_mode_agents", []),
  ...getJson("/api/secrets/type", { type: "DB", meta: {} }),
  ...getJson("/api/k8s/image-pull-secrets", []),
  ...getJson("/api/k8s/capabilities", {
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

  // Gateway tokens, read by the agent detail page's connect panel. No tokens
  // issued and no org/team token access, which is the quiet default: the panel
  // renders its empty state instead of a roster.
  ...getJson("/api/tokens", {
    tokens: [],
    permissions: { canAccessOrgToken: false, canAccessTeamTokens: false },
  }),
  ...getJson("/api/user-tokens/me", {
    id: "test-user-token",
    name: "Test Admin's token",
    tokenStart: "archestra_",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
  }),

  // Agents
  ...getJson("/api/agents", agentsSeed),
  ...getJson("/api/agents/all", []),
  ...getJson("/api/agents/labels/keys", []),
  ...getJson("/api/agents/labels/values", []),
  ...getJson("/api/agents/:id", makeAgent()),
  ...getJson("/api/agents/:id/export", {}),
  ...getJson("/api/agents/:id/tools", []),
  ...getJson("/api/agents/:id/delegations", []),
  ...getJson("/api/agents/default-mcp-gateway", null),
  // The agents list asks which of the caller's agents is their personal
  // default; unmocked, it reaches the real backend and trips the leak guard.
  ...getJson("/api/members/default-agent", { defaultAgentId: null }),
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

  // LLM OAuth clients (paginated envelope) — used by the OAuth Clients tab and
  // the LLM keys delete dialog as a blocking-deps probe.
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

  // Virtual API keys (paginated envelope)
  ...getJson("/api/llm-virtual-keys", virtualKeysSeed),
  ...postJson("/api/llm-virtual-keys", makeCreatedVirtualKey()),
  ...patchJson("/api/llm-virtual-keys/:id", makeCreatedVirtualKey()),
  ...deleteJson("/api/llm-virtual-keys/:id"),

  // Skills (list page, the "new skill" chooser, and the GitHub import dialog)
  ...getJson("/api/skills", skillsListSeed),
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
      const isExpectedPayload =
        body.repoUrl === catalogSkillSeed.repo &&
        body.skillPaths?.length === 1 &&
        body.skillPaths[0] === catalogSkillSeed.skillPath;
      return HttpResponse.json(
        isExpectedPayload
          ? { created: [makeImportedSkill()], skipped: [], skippedFiles: [] }
          : { created: [], skipped: body.skillPaths ?? [], skippedFiles: [] },
      );
    }),
  ),

  // LLM proxy logs (/llm/logs list, session detail, interaction detail).
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
  ...getJson("/api/llm-models/by-provider", []),
  ...getJson("/api/llm-models/with-api-keys", []),
  ...getJson("/api/knowledge-bases", []),
  ...getJson("/api/connectors", paginated([connectorSeed])),
  ...getJson("/api/connectors/:id", connectorSeed),
  ...getJson(
    "/api/connectors/:id/runs",
    paginated(connectorRunsSeed, { total: 178 }),
  ),
  ...getJson("/api/connectors/:id/knowledge-bases", { data: [] }),
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
];

const USAGE_STATISTICS_BY_SKILL: Record<
  string,
  typeof skillUsageStatisticsSeed
> = {
  "skill-jira-task": skillUsageStatisticsSeed,
  "skill-release-checklist": skillUsageStatisticsQuietSeed,
  "skill-incident-postmortem": skillUsageStatisticsEmptySeed,
};
