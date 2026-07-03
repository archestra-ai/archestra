// Import from the leaf `interactions/client` module, not the root barrel: the
// barrel (`@archestra/shared`) transitively imports a JSON module without an
// import attribute, which the Playwright integration-test ESM loader rejects.
// `client.ts` depends only on zod.
import {
  CLAUDE_CLIENT_FILTER,
  isClaudeClientAgentId,
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
} from "./data/skill-share";
import {
  catalogSkillSeed,
  githubDiscoverSeed,
  githubPreviewSeed,
  makeImportedSkill,
  skillCatalogSearchSeed,
  skillsListSeed,
} from "./data/skills";

// Register each endpoint twice: absolute URL for SSR (Next.js server
// components fetch the backend origin directly) and relative URL for the
// browser (served via Next.js rewrites). MSW path-to-regexp does not accept
// `*/...` host wildcards.
const BACKEND_ORIGIN =
  process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";

function paired(path: string): [string, string] {
  return [`${BACKEND_ORIGIN}${path}`, path];
}

function getJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paired(path).map((url) =>
    http.get(url, () => HttpResponse.json(body)),
  );
}

function postJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paired(path).map((url) =>
    http.post(url, () => HttpResponse.json(body)),
  );
}

function putJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paired(path).map((url) =>
    http.put(url, () => HttpResponse.json(body)),
  );
}

function patchJson(path: string, body: JsonBodyType): HttpHandler[] {
  return paired(path).map((url) =>
    http.patch(url, () => HttpResponse.json(body)),
  );
}

function deleteJson(
  path: string,
  body: JsonBodyType = { success: true },
): HttpHandler[] {
  return paired(path).map((url) =>
    http.delete(url, () => HttpResponse.json(body)),
  );
}

export const handlers: HttpHandler[] = [
  ...getJson("/api/auth/get-session", sessionSeed),
  ...getJson("/api/auth/default-credentials-status", { enabled: false }),
  ...getJson("/api/auth/organization/list", []),
  ...getJson("/api/auth/organization/get-full-organization", betterAuthOrgSeed),
  ...getJson("/api/user/permissions", adminPermissionsSeed),
  ...getJson("/api/config", configSeed),
  ...getJson("/api/config/public", publicConfigSeed),
  ...getJson("/health", healthSeed),
  ...getJson("/api/organization", organizationSeed),
  ...getJson("/api/organization/appearance-settings", appearanceSettingsSeed),
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
  ...getJson("/api/internal_mcp_catalog/labels/keys", []),
  ...getJson("/api/internal_mcp_catalog/:catalogId/children", []),
  ...getJson("/api/mcp_server", installedServersSeed),
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
    },
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
  ...getJson("/api/agents/default-llm-proxy", null),
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
  ...postJson("/api/llm-provider-api-keys", makeLlmProviderApiKey()),
  ...patchJson("/api/llm-provider-api-keys/:id", makeLlmProviderApiKey()),
  ...deleteJson("/api/llm-provider-api-keys/:id"),

  // LLM OAuth clients — used by the LLM keys delete dialog as a blocking-deps probe.
  ...getJson("/api/llm-oauth-clients", []),

  // Virtual API keys (paginated envelope)
  ...getJson("/api/llm-virtual-keys", virtualKeysSeed),
  ...postJson("/api/llm-virtual-keys", makeCreatedVirtualKey()),
  ...patchJson("/api/llm-virtual-keys/:id", makeCreatedVirtualKey()),
  ...deleteJson("/api/llm-virtual-keys/:id"),

  // Skills (list page, the "new skill" chooser, and the GitHub import dialog)
  ...getJson("/api/skills", skillsListSeed),
  ...getJson("/api/skills/source-repos", { repos: [] }),
  ...getJson("/api/skills/catalog/search", skillCatalogSearchSeed),
  ...postJson("/api/skills/github/discover", githubDiscoverSeed),
  ...postJson("/api/skills/github/preview", githubPreviewSeed),
  // Conditional on the request payload: `mswControl.use(...)` overrides can
  // only return static bodies, so the import spec asserts the request payload
  // indirectly — the import only succeeds for the exact body the catalog flow
  // must send. Any other payload is reported skipped, which keeps the import
  // dialog open and fails the spec's dialog-closed assertion.
  ...paired("/api/skills/github/import").map((url) =>
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
  ...paired("/api/interactions/sessions").map((url) =>
    http.get(url, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const sessionId = params.get("sessionId");
      const client = params.get("client");
      const source = params.get("source");
      let data = llmLogsSessionsSeed;
      if (sessionId) data = data.filter((s) => s.sessionId === sessionId);
      if (client === CLAUDE_CLIENT_FILTER) {
        data = data.filter((s) =>
          s.externalAgentIds.some(isClaudeClientAgentId),
        );
      }
      if (source) data = data.filter((s) => s.source === source);
      return HttpResponse.json(paginated(data));
    }),
  ),
  ...getJson("/api/interactions/user-ids", []),
  ...getJson("/api/interactions/external-agent-ids", []),
  ...getJson("/api/interactions", paginated([])),
  ...getJson("/api/interactions/:interactionId", makeInteraction()),

  // /connection probes the org's default gateway/proxy to preselect them
  ...getJson("/api/mcp-gateways/default", makeAgent()),
  ...getJson("/api/llm-proxy/default", makeAgent()),

  // Skill share links (the marketplace step on /connection). The create and
  // rotate handlers are conditional on the request payload for the same
  // reason as the github import handler above: success (snippets revealed)
  // pins the exact body the step must send.
  ...getJson("/api/skill-share-links", { links: [] }),
  ...paired("/api/skill-share-links").map((url) =>
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
  ...paired("/api/skill-share-links/:id/rotate").map((url) =>
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
  ...getJson("/api/connectors", []),
  ...getJson("/api/identity-providers", []),
];
