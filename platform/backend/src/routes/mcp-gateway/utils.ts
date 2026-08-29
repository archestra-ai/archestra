import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ARCHESTRA_MCP_CATALOG_ID,
  extractMcpExecutedAs,
  hasArchestraTokenPrefix,
  isAgentTool,
  isAlwaysExposedArchestraToolShortName,
  isSkillTool,
  MCP_EXECUTED_AS_META_KEY,
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_REFERENCE_PREFIX,
  OAUTH_TOKEN_ID_PREFIX,
  parseFullToolName,
  platformExecutedAs,
  TOOL_CANCEL_TASK_SHORT_NAME,
  TOOL_COPY_FILE_SHORT_NAME,
  TOOL_GET_TASK_SHORT_NAME,
  TOOL_LIST_TASKS_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_START_TASK_SHORT_NAME,
  TOOL_STEER_TASK_SHORT_NAME,
} from "@archestra/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyRequest } from "fastify";
import {
  archestraMcpBranding,
  executeArchestraTool,
  filterToolNamesByPermission,
  getAgentTools,
  getArchestraMcpTools,
  getSkillDelegationTools,
} from "@/archestra-mcp-server";
import {
  getUnassignedDiscoverableTools,
  resolveDynamicTool,
} from "@/archestra-mcp-server/dynamic-tools";
import { structuredToolErrorResult } from "@/archestra-mcp-server/helpers";
import { userHasPermission } from "@/auth/utils";
import { LRUCacheManager } from "@/cache-manager";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import { isToolRejectedForMcpHeaders } from "@/clients/mcp-param-headers";
import config from "@/config";
import { evaluateSingleMcpToolInvocationPolicy } from "@/guardrails/tool-invocation";
import { buildPolicyBlockedToolResult } from "@/guardrails/tool-policy-link";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  AgentTeamModel,
  InternalMcpCatalogModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  McpOauthClientModel,
  McpToolCallModel,
  MemberModel,
  OAuthAccessTokenModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { findAgentAccessContextById } from "@/models/agent-access-context";
import { metrics } from "@/observability";
import {
  ATTR_MCP_IS_ERROR_RESULT,
  startActiveMcpSpan,
} from "@/observability/tracing";
import { skillsSurfaceEnabled } from "@/services/agent-skill-resolution";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { isAppConnectorAudienceRef } from "@/services/apps/app-connector-resource";
import {
  appLaunchToolDescription,
  appLaunchToolTitle,
  sanitizeAppNameForToolMetadata,
} from "@/services/apps/app-run-link";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import {
  discoverOidcJwksUrl,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import { jwksValidator } from "@/services/jwks-validator";
import { isPlatformSkillUri } from "@/skills/skill-uri";
import {
  type AgentAccessContext,
  type AgentType,
  agentOwner,
  type CommonToolCall,
  type SelectTeamToken,
  type SelectUserToken,
  type ToolExposureMode,
} from "@/types";
import { APP_LAUNCH_TOOL_NAME } from "@/types/app";
import { deriveAuthMethod } from "@/utils/auth-method";
import { estimateToolResultContentLength } from "@/utils/tool-result-preview";
import {
  buildInputRequiredResult,
  clientSupportsInputRequest,
  deriveStatePrincipal,
  encodeRequestState,
  GATEWAY_INPUT_REQUEST_KEY,
  InputRequiredSignal,
  type InputResponses,
  isInputRequiredSignal,
  MAX_INPUT_ROUNDS,
} from "./mrtr";
import {
  buildGatewayServerCapabilities,
  buildPrivateListCacheHint,
  isResourceUnavailableError,
  RESOURCE_NOT_FOUND_ERROR_CODE,
  withCompleteResultEnvelope,
  withPrivateCacheHint,
} from "./protocol";
import { serveSkillResource } from "./skills";
import {
  clientDeclaredTasks,
  runToolCallMaybeTask,
  TASK_TTL_MS,
} from "./tasks";

export { deriveAuthMethod };

/**
 * Token authentication result
 */
export interface TokenAuthResult {
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  /** Organization ID the token belongs to */
  organizationId: string;
  /** True if this is a personal user token */
  isUserToken?: boolean;
  /** User ID for user tokens */
  userId?: string;
  /** True if authenticated via external IdP JWKS */
  isExternalIdp?: boolean;
  /** Raw JWT token for propagation to underlying MCP servers */
  rawToken?: string;
}

/**
 * Why gateway authentication failed, so a caller can act on the answer instead
 * of guessing at a blanket "invalid token".
 *
 * What is safe to disclose turns on whether the JWT's signature was verified
 * first. `no_email_claim`, `unknown_user`, `not_org_member` and
 * `no_gateway_access` are only ever reached by a caller holding a token this
 * organization's own IdP signed — already inside the trust boundary — so naming
 * the configuration problem tells them nothing they could not already learn.
 * `idp_not_linked` / `idp_misconfigured` are decided before any signature check
 * but reveal only that a gateway is (not) set up for JWKS, never anything about
 * a user. Everything decided by the signature check itself — bad signature,
 * expiry, issuer or audience mismatch — collapses into `invalid_token`, since
 * distinguishing those would help tune a forgery.
 */
export type GatewayAuthFailureReason =
  | "invalid_token"
  | "idp_not_linked"
  | "idp_misconfigured"
  | "no_email_claim"
  | "unknown_user"
  | "not_org_member"
  | "no_gateway_access";

/** Outcome of gateway authentication: a result, or the reason there isn't one. */
export type GatewayAuthOutcome =
  | { result: TokenAuthResult; reason: null }
  | { result: null; reason: GatewayAuthFailureReason };

/**
 * Client-facing explanation for a failed gateway authentication. Kept next to
 * {@link GatewayAuthFailureReason} so the disclosure rules and the wording that
 * implements them stay in one place.
 */
export function describeGatewayAuthFailure(
  reason: GatewayAuthFailureReason,
): string {
  switch (reason) {
    case "idp_not_linked":
      return `Invalid token for this profile. This gateway has no Identity Provider linked, so it cannot accept an external IdP JWT — link one to the gateway, or authenticate with an ${archestraMcpBranding.appName} token or OAuth.`;
    case "idp_misconfigured":
      return "Invalid token for this profile. The gateway's Identity Provider cannot be used to validate JWTs: it must be an OIDC provider with a client ID and a discoverable JWKS endpoint.";
    case "no_email_claim":
      return "Token validated, but it carries no email claim. Set the Identity Provider's Email Claim attribute mapping to the claim holding the email (IdPs that namespace custom claims do not populate the standard `email` claim).";
    case "unknown_user":
      return `Token validated, but its email does not match any ${archestraMcpBranding.appName} user.`;
    case "not_org_member":
      return "Token validated, but its user is not a member of this gateway's organization.";
    case "no_gateway_access":
      return "Token validated, but its user does not have access to this gateway. Grant access via a shared team.";
    case "invalid_token":
      return "Invalid token for this profile";
  }
}

export type AgentInfo = {
  name: string;
  id: string;
  agentType?: AgentType;
  labels?: Array<{ key: string; value: string }>;
  passthroughHeaders?: string[] | null;
};

type TokenHashes = {
  cacheKey: string;
  oauthTokenHash: string;
  rawTokenHash: string;
};

type ResolvedArchestraToken =
  | {
      type: "team";
      token: SelectTeamToken;
    }
  | {
      type: "user";
      token: SelectUserToken;
    };

/**
 * Archestra built-ins whose effect exists only on the internal chat surface, so
 * an external MCP client is never offered them: `render_app` mounts an app from
 * its own result, which only Archestra's chat does, and `copy_file` exchanges
 * files with the app the user has open there — off that surface there is
 * neither a conversation nor an open app, and every call can only refuse.
 */
const CHAT_ONLY_ARCHESTRA_SHORT_NAMES = new Set<string>([
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_COPY_FILE_SHORT_NAME,
]);

const TOKEN_AUTH_CACHE_TTL_MS = 30_000;
const TOKEN_AUTH_CACHE_MAX_ENTRIES = 1_000;
const tokenAuthCache = new LRUCacheManager<TokenAuthResult | null>({
  maxSize: TOKEN_AUTH_CACHE_MAX_ENTRIES,
  defaultTtl: TOKEN_AUTH_CACHE_TTL_MS,
});
const rawArchestraTokenCache =
  new LRUCacheManager<ResolvedArchestraToken | null>({
    maxSize: TOKEN_AUTH_CACHE_MAX_ENTRIES,
    defaultTtl: TOKEN_AUTH_CACHE_TTL_MS,
  });

/**
 * Creates an MCP server for the given agent.
 */
export async function createAgentServer(params: {
  agentId: string;
  tokenAuth?: TokenAuthContext;
  executionId?: string;
  /**
   * Answers the client supplied on an MRTR retry, keyed as they were issued.
   * Absent on a first attempt, which is what makes the gateway elicit.
   */
  mrtr?: {
    enabled: boolean;
    inputResponses?: InputResponses;
    clientCapabilities?: unknown;
    /** Rounds already spent, read from a verified requestState. */
    round?: number;
  };
}): Promise<{ server: McpServer; agent: AgentInfo }> {
  const { agentId, tokenAuth, executionId, mrtr } = params;
  const mrtrEnabled = mrtr?.enabled === true;

  /**
   * Stamp an ordinary result. Deliberately not applied to the MRTR
   * InputRequiredResult, which carries `input_required` instead.
   */
  const complete = <T extends object>(result: T): T =>
    withCompleteResultEnvelope(result, {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
    });
  const mcpServer = new McpServer(
    {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
    },
    {
      // The legacy revision's capability set: `initialize` is only ever
      // answered for 2025-11-25-and-older clients, which have no notification
      // channel, so `tools.listChanged` stays false here. `server/discover`
      // deliberately passes the negotiated revision instead and may advertise
      // `tools.listChanged: true`, backed by `subscriptions/listen`.
      capabilities: buildGatewayServerCapabilities(),
    },
  );
  const { server } = mcpServer;

  // Slim lookup: this runs on every stateless gateway request, and the tool
  // handlers below only read scalar agent config plus labels — never the
  // tools/teams/knowledge/connector hydration `findById` performs.
  const agent = await AgentModel.findGatewayAgentById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  // Fetch the agent's teams and the calling user's teams (with labels) for
  // trace span team attributes.
  const teams = await AgentTeamModel.getTeamLabelInfoForAgent(agentId);
  const userTeams =
    tokenAuth?.userId && tokenAuth.organizationId
      ? await TeamModel.getTeamLabelInfoForUser({
          userId: tokenAuth.userId,
          organizationId: tokenAuth.organizationId,
        })
      : [];

  // Create a map of Archestra tool names to their titles
  // This is needed because the database schema doesn't include a title field
  const archestraTools = getArchestraMcpTools();
  const archestraToolTitles = new Map(
    archestraTools.map((tool: Tool) => [tool.name, tool.title]),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Get MCP tools (from connected MCP servers + Archestra built-in tools)
    // Excludes proxy-discovered tools
    // Fetch fresh on every request to ensure we get newly assigned tools
    // Per-agent exclusions (Auto-tool mode): excluded assigned tools must not
    // be advertised, and their catalogs must not be named in the search_tools
    // description built below. Every built-in except the search_tools/run_tool
    // meta tools (rejected at write time) is a valid exclusion target — this
    // filter runs BEFORE filterExposedTools, so an excluded always-exposed
    // built-in is dropped here and never re-admitted below. Empty (no-op)
    // unless the agent's accessAllTools setting is on.
    const { tools: fetchedMcpTools } =
      await agentToolExclusionsService.getFilteredMcpToolsByAgent(agentId);

    // SEP-2243: a tool definition with an invalid x-mcp-header annotation must
    // be excluded from tools/list (with a warning), so one malformed upstream
    // definition cannot poison the rest of the list.
    const mcpTools = fetchedMcpTools.filter(
      (tool) =>
        !isToolRejectedForMcpHeaders({
          toolName: tool.name,
          inputSchema: tool.parameters,
        }),
    );

    // A tools/list is served to one of two surfaces, and the whole gateway/chat
    // difference lives in this policy. An internal chat (agentType "agent") is
    // host and server both: it mounts an app from the tool RESULT — render_app
    // for owned apps, run_tool for any UI tool — resolving the `ui://` resource
    // from its own catalog, so it advertises render_app and NO UI-providing tool,
    // keeping the list compact. An external MCP client on any other surface
    // (mcp_gateway, legacy profile) renders from a discovery-time tool
    // DEFINITION (per the MCP Apps extension), so it must advertise the
    // UI-providing tools the agent ASSIGNS — and drops the chat-only built-ins,
    // which no-op for it. Both flags are independently motivated; they coincide
    // on agentType, the surface signal this codebase keys on throughout.
    //
    // Neither surface widens this list with the tools Auto mode can reach
    // DYNAMICALLY: that set is the caller's whole accessible corpus, which
    // grows without bound (every Archestra App contributes a `__open` launch
    // tool), so advertising it is exactly the context-window cost Auto mode
    // exists to avoid. Dynamically-reached tools are found with search_tools
    // and dispatched with run_tool, whose result still carries the tool's
    // `ui://` pointer for a host that renders from results.
    const surface =
      agent.agentType === "agent"
        ? { advertiseUiTools: false, keepChatOnlyTools: true }
        : { advertiseUiTools: true, keepChatOnlyTools: false };

    const implicitMetaTools =
      agent.toolExposureMode === "search_and_run_only"
        ? getImplicitArchestraMetaTools()
        : [];

    // Delegation tools resolve through the Auto/Custom subagent seam, not the
    // assigned-rows query: Auto mode synthesizes caller-scoped tools that have
    // no agent_tools rows at all, and exclusions/user access apply in both
    // modes. Drop the raw delegation rows and splice in the resolved surface so
    // the gateway advertises the same delegation set the dispatch path accepts.
    const [delegationTools, skillDelegationTools] = await Promise.all([
      getAgentTools({
        agentId,
        organizationId: agent.organizationId,
        userId: tokenAuth?.userId,
      }),
      // Agent-designated skills surface as skill__<slug> delegation tools,
      // resolved per calling user with the same env/access symmetry.
      getSkillDelegationTools({
        agentId,
        organizationId: agent.organizationId,
        userId: tokenAuth?.userId,
      }),
    ]);
    const hasTaskStarter =
      delegationTools.length > 0 ||
      mcpTools.some(
        (tool) =>
          archestraMcpBranding.getToolShortName(tool.name) ===
          TOOL_START_TASK_SHORT_NAME,
      );
    // A task handle is not useful without its lifecycle controls. Dynamic
    // per-Agent delegation tools do not have assignment rows, so expose the
    // controls as protocol support whenever this gateway can start a task.
    // The handlers still scope every task to the authenticated actor and the
    // call path keeps its normal RBAC check.
    const implicitTaskControlTools = hasTaskStarter
      ? getImplicitTaskControlTools()
      : [];
    const candidateTools = dedupeToolsByName(
      [
        ...mcpTools.filter((tool) => !tool.delegateToAgentId),
        ...implicitMetaTools,
        ...implicitTaskControlTools,
        ...[...delegationTools, ...skillDelegationTools].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          meta: {
            annotations: (tool.annotations ?? {}) as Record<string, unknown>,
            _meta: tool._meta,
          },
        })),
      ].map(toMcpListTool),
    );

    // Filter Archestra tools based on user RBAC permissions
    const permittedNames = await filterToolNamesByPermission(
      candidateTools.map((t) => t.name),
      tokenAuth?.userId,
      tokenAuth?.organizationId,
    );
    const exposureFiltered = filterExposedTools({
      toolExposureMode: agent.toolExposureMode ?? "full",
      advertiseUiResourceTools: surface.advertiseUiTools,
      autoToolMode: agent.accessAllTools,
      tools: candidateTools.filter((t) => permittedNames.has(t.name)),
    });
    const permittedTools = surface.keepChatOnlyTools
      ? exposureFiltered
      : exposureFiltered.filter((tool) => {
          // A null short name is not an Archestra built-in at all, so it is
          // never one of the chat-only ones.
          const shortName = archestraMcpBranding.getToolShortName(tool.name);
          return (
            shortName === null ||
            !CHAT_ONLY_ARCHESTRA_SHORT_NAMES.has(shortName)
          );
        });

    // Resolve the backing catalogs of the advertised tools once: their names
    // feed both the search_tools description and the app launch-tool title and
    // description below. Only assigned tools can be advertised, so only their
    // catalogs are needed here; buildSearchToolsDescription fetches the
    // catalogs of the dynamically discoverable tools it names itself.
    const catalogsById = await InternalMcpCatalogModel.getByIds([
      ...new Set(
        mcpTools
          .map((tool) => tool.catalogId)
          .filter(
            (id): id is string =>
              Boolean(id) && id !== ARCHESTRA_MCP_CATALOG_ID,
          ),
      ),
    ]);

    // An app's launch tool keeps its unique slug `name` for invocation, but a
    // gateway client should show a human label and description. Both derive from
    // the backing catalog name (kept in lockstep with the app) so they never go
    // stale and are sanitized regardless of the stored value. `appLaunchCatalog`
    // is the single gate: the catalog only when this row IS the app's `__open`
    // launch tool, so a non-launch tool that ever shares an app catalog is never
    // mislabeled. Non-app tools keep their existing title/description.
    const appLaunchCatalog = (
      catalogId: string | null | undefined,
      toolName: string,
    ) => {
      const catalog = catalogId ? catalogsById.get(catalogId) : undefined;
      return catalog?.serverType === "app" &&
        ToolModel.unslugifyName(toolName) === APP_LAUNCH_TOOL_NAME
        ? catalog
        : undefined;
    };
    const appLaunchTitle = (
      catalogId: string | null | undefined,
      toolName: string,
    ): string | undefined => {
      const catalog = appLaunchCatalog(catalogId, toolName);
      return catalog ? appLaunchToolTitle(catalog.name) : undefined;
    };
    const appLaunchDescription = (
      catalogId: string | null | undefined,
      toolName: string,
    ): string | undefined => {
      const catalog = appLaunchCatalog(catalogId, toolName);
      return catalog ? appLaunchToolDescription(catalog.name) : undefined;
    };

    // Dynamically enrich the knowledge sources tool description with the
    // agent's actual knowledge base names and connector types, and the
    // search_tools description with the servers in its search space. The
    // latter involves resolving the dynamically discoverable tool space, so
    // skip it when search_tools is not in the advertised list anyway ("full"
    // exposure mode hides the meta tools).
    const advertisesSearchTools = permittedTools.some(
      (tool) =>
        archestraMcpBranding.getToolShortName(tool.name) ===
        TOOL_SEARCH_TOOLS_SHORT_NAME,
    );
    const [kbToolDescription, searchToolsDescription] = await Promise.all([
      buildKnowledgeSourcesDescription(agentId),
      advertisesSearchTools
        ? buildSearchToolsDescription({
            mcpTools,
            agentId,
            userId: tokenAuth?.userId,
            organizationId: tokenAuth?.organizationId,
            prefetchedCatalogs: catalogsById,
          })
        : null,
    ]);

    const toolsList: McpListTool[] = permittedTools.map(
      ({ name, description, parameters, meta, catalogId }) => ({
        name,
        title:
          archestraToolTitles.get(name) ||
          appLaunchTitle(catalogId, name) ||
          name,
        description:
          name ===
            archestraMcpBranding.getToolName(
              TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
            ) && kbToolDescription
            ? kbToolDescription
            : name ===
                  archestraMcpBranding.getToolName(
                    TOOL_SEARCH_TOOLS_SHORT_NAME,
                  ) && searchToolsDescription
              ? searchToolsDescription
              : (appLaunchDescription(catalogId, name) ??
                description ??
                undefined),
        inputSchema: parameters,
        annotations: meta?.annotations || {},
        _meta: meta?._meta || {},
      }),
    );

    // Log tools/list request
    try {
      await McpToolCallModel.create({
        agentId,
        mcpServerName: "mcp-gateway",
        method: "tools/list",
        toolCall: null,
        // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
        toolResult: { tools: toolsList } as any,
        userId: tokenAuth?.userId ?? null,
        executionId: executionId ?? null,
        authMethod: deriveAuthMethod(tokenAuth) ?? null,
      });
      logger.info(
        { agentId, toolsCount: toolsList.length },
        "Saved tools/list request",
      );
    } catch (dbError) {
      logger.warn({ err: dbError }, "Failed to persist tools/list request:");
    }

    // SEP-2549 freshness hints. Always private: this list is filtered per
    // caller, so it must never be shared across users by an intermediary.
    // Deterministic order: the revision asks servers to return tools stably so
    // client-side caching and LLM prompt caches can actually hit. Without it
    // the ttlMs hint above advertises freshness for a list that reshuffles.
    toolsList.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return complete({ tools: toolsList, ...buildPrivateListCacheHint() });
  });

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params: { uri } }) => {
      logger.info(
        { agentId, uri },
        "MCP gateway read resource request received",
      );

      // Skills (SEP-2640) are served from this platform's own database, never
      // proxied upstream. This is the one part of the skills surface that is
      // an ordinary SDK request — the extension's own methods are intercepted
      // at the route in index.ts — so the branch lives here. The whole
      // skill://archestra authority is reserved in every state: with the
      // surface disabled (flag off, backfill pending), the skill unexposed,
      // or the URI malformed, it answers not-found rather than falling
      // through, so an upstream server can never serve its own bytes under
      // the platform's prefix. Within the namespace an unexposed skill and a
      // nonexistent one still answer identically.
      if (isPlatformSkillUri(uri)) {
        let skillResource: Awaited<ReturnType<typeof serveSkillResource>> =
          null;
        try {
          if (skillsSurfaceEnabled()) {
            skillResource = await serveSkillResource({ uri, agentId });
          }
        } catch (error) {
          logger.error(
            {
              agentId,
              uri,
              error: error instanceof Error ? error.message : "Unknown error",
            },
            "Skill resource read failed",
          );
          throw { code: -32603, message: "Resource read failed" };
        }
        if (skillResource) {
          return complete(withPrivateCacheHint(skillResource));
        }
        // The current revision's code for a missing resource: SEP-2164 retired
        // the MCP-specific -32002 in favor of JSON-RPC's Invalid Params, and
        // SEP-2640 pins unknown skill resources to the same code. Every reason
        // for not-found — unexposed, deleted, never existed, malformed, surface
        // disabled — still answers the same way, so the surface stays
        // unprobeable.
        throw {
          code: RESOURCE_NOT_FOUND_ERROR_CODE,
          message: `Resource not found: ${uri}`,
          data: { uri },
        };
      }

      try {
        const result = await mcpClient.readResource(uri, agentId, tokenAuth);
        logger.info(
          { agentId, uri, resultType: typeof result },
          "Resource read successful",
        );
        return complete(withPrivateCacheHint(result));
      } catch (error) {
        // A third-party tool can advertise a `ui://` UI resource whose upstream
        // server does not actually implement `resources/read` (returning -32601
        // Method not found) or has no such resource. That is an expected upstream
        // limitation, not a platform fault — the client degrades to the plain
        // tool result — so log it at a lower severity to avoid flooding error
        // logs. Genuine failures still log at error.
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const logContext = {
          agentId,
          uri,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        };
        if (isUnavailableResourceError(error)) {
          logger.info(logContext, "Resource read unavailable (upstream)");
        } else {
          logger.error(logContext, "Resource read failed");
        }
        throw {
          code: -32603,
          message: "Resource read failed",
          data: message,
        };
      }
    },
  );

  // SEP-1865: resources/list, resources/templates/list, prompts/list
  // Proxy to all upstream MCP servers connected to this agent and aggregate results.
  // Each carries SEP-2549 cache hints, always private: these aggregate upstream
  // servers reached with the caller's own credentials, so results differ per
  // caller and must not be shared by an intermediary.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return complete(
      withPrivateCacheHint(await mcpClient.listResources(agentId, tokenAuth)),
    );
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return complete(
      withPrivateCacheHint(
        await mcpClient.listResourceTemplates(agentId, tokenAuth),
      ),
    );
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return complete(
      withPrivateCacheHint(await mcpClient.listPrompts(agentId, tokenAuth)),
    );
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Tasks extension (io.modelcontextprotocol/tasks): an eligible call —
    // the client declared the extension in this request's _meta — races the
    // sync threshold and detaches into a durable background task when it
    // outlives it. Everything below (dispatch, policies, envelope, metrics,
    // persistence) runs identically either way; only who is waiting for the
    // outcome changes.
    const taskEligible =
      mrtrEnabled && clientDeclaredTasks({ params: request.params });

    const executeCallToolRequest = async (
      taskAbortSignal: AbortSignal,
    ): Promise<Record<string, unknown>> => {
      const startTime = Date.now();
      const mcpServerName = parseFullToolName(name).serverName ?? "unknown";

      // Resolve user identity for OTEL span attributes
      let mcpUser: {
        id: string;
        email?: string;
        name?: string;
      } | null = null;
      if (tokenAuth?.userId) {
        const userDetails = await UserModel.getById(tokenAuth.userId);
        if (userDetails) {
          mcpUser = {
            id: userDetails.id,
            email: userDetails.email,
            name: userDetails.name,
          };
        }
      }

      try {
        // Check if this is an Archestra tool or a delegation tool (agent or
        // skill delegation — both dispatch through executeArchestraTool)
        const isArchestraTool = archestraMcpBranding.isToolName(name);
        const isAgentDelegationTool = isAgentTool(name);
        const isSkillDelegationTool = isSkillTool(name);
        const contextIsTrusted = !agent.considerContextUntrusted;

        // An all-tools agent's dynamically-accessible tools are not advertised
        // by tools/list (see the surface policy above), but a caller that knows
        // a name — from search_tools, or from a definition it cached before —
        // may still call one directly rather than through run_tool. Two
        // gates on this path only know assigned tools and must be told about
        // the dynamic resolution, exactly as run_tool's own dispatch does
        // (archestra-mcp-server/run-tool.ts): the invocation-policy evaluator
        // (whose enabled-tools filter otherwise refuses the unassigned name as
        // "disabled"), and executeToolCallForOwner (which only accepts an
        // unassigned tool via a pre-resolved availableTool). A no-op for
        // assigned tools; policies still evaluate the dynamic tool itself.
        //
        // Fetch the agent's assigned names once (all-tools agents only): they
        // gate the dynamic lookup — an already-assigned name is reachable
        // without it, so skip the heavier resolveDynamicTool — and feed the
        // invocation-policy enabled-tools filter below, so neither path
        // re-queries assignments.
        const assignedToolNames =
          !isArchestraTool &&
          !isAgentDelegationTool &&
          !isSkillDelegationTool &&
          agent.accessAllTools &&
          tokenAuth?.userId &&
          tokenAuth.organizationId
            ? await ToolModel.getAssignedToolNames(agent.id)
            : null;
        const dynamicTool =
          assignedToolNames &&
          !assignedToolNames.has(name) &&
          tokenAuth?.userId &&
          tokenAuth.organizationId
            ? await resolveDynamicTool({
                toolName: name,
                agentId,
                userId: tokenAuth.userId,
                organizationId: tokenAuth.organizationId,
              })
            : null;
        // Direct-call availability stays limited to the UI-providing subset.
        // Accepting those is not a widening — Auto mode already grants the
        // caller dynamic access and run_tool would dispatch the same tool under
        // the same policies — and it keeps an MCP Apps host working when it
        // calls a launch tool by a name it already holds. A non-UI dynamic tool
        // stays behind search_tools/run_tool: resolving it here would silently
        // make every hidden tool name directly executable.
        const availableTool =
          dynamicTool && providesUiResource(dynamicTool)
            ? dynamicTool
            : undefined;

        const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
          agentId: agent.id,
          toolName: name,
          toolInput: args ?? {},
          organizationId: tokenAuth?.organizationId,
          contextIsTrusted,
          // The only way this path starts untrusted is the agent's own
          // "treat context as sensitive" setting, so name that origin in
          // any sensitive-context block.
          sensitiveContextOrigin: contextIsTrusted
            ? undefined
            : { kind: "agent_configured" },
          ...(availableTool &&
            assignedToolNames && {
              enabledToolNames: new Set([...assignedToolNames, name]),
            }),
          // The dynamically-resolved All-mode row that will execute: evaluate the
          // policy against it and ride its id along on a block so the "Edit
          // policy" modal can resolve a tool with no agent_tools assignment.
          resolvedToolId: availableTool?.id,
        });
        if (policyBlock) {
          // Carry the machine-readable policy_denied error alongside the prose
          // (in _meta + structuredContent) so MCP clients render the block
          // structurally instead of scraping the refusal text. When the caller
          // can edit guardrails, both gain a deep link to this tool's policy
          // editor so the external client can offer to review/modify it.
          const { error, text } = await buildPolicyBlockedToolResult({
            policyBlock,
            userId: tokenAuth?.userId,
            organizationId: tokenAuth?.organizationId,
          });
          const blockedResult = structuredToolErrorResult({ error, text });

          // Blocked calls are still tool calls: report metrics and persist them
          // (isError) so they show up in the MCP gateway logs and dashboards
          // rather than vanishing before any recording.
          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.mcp.reportMcpToolCall({
            agentId: agent.id,
            agentName: agent.name,
            agentType: agent.agentType ?? null,
            mcpServerName,
            toolName: name,
            durationSeconds,
            isError: true,
            agentLabels: agent.labels,
            requestSizeBytes: args ? JSON.stringify(args).length : undefined,
          });

          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName,
              method: "tools/call",
              toolCall: {
                id: `blocked-${Date.now()}`,
                name,
                arguments: args || {},
              },
              toolResult: blockedResult,
              userId: tokenAuth?.userId ?? null,
              executionId: executionId ?? null,
              authMethod: deriveAuthMethod(tokenAuth) ?? null,
            });
          } catch (dbError) {
            logger.info(
              { err: dbError },
              "Failed to persist blocked tool call",
            );
          }

          return blockedResult;
        }

        if (isArchestraTool || isAgentDelegationTool || isSkillDelegationTool) {
          logger.info(
            {
              agentId,
              toolName: name,
              toolType: isAgentDelegationTool
                ? "agent-delegation"
                : isSkillDelegationTool
                  ? "skill-delegation"
                  : "archestra",
            },
            isAgentDelegationTool || isSkillDelegationTool
              ? "Delegation tool call received"
              : "Archestra MCP tool call received",
          );

          // Handle Archestra and agent delegation tools directly
          const response = await startActiveMcpSpan({
            toolName: name,
            mcpServerName,
            agent,
            teams,
            userTeams,
            agentType: agent.agentType,
            toolCallId: `archestra-${Date.now()}`,
            toolArgs: args,
            user: mcpUser,
            callback: async (span) => {
              const result = await executeArchestraTool(name, args, {
                agent: { id: agent.id, name: agent.name },
                agentId: agent.id,
                userId: tokenAuth?.userId,
                organizationId: tokenAuth?.organizationId,
                tokenAuth,
                contextIsTrusted,
              });
              span.setAttribute(
                ATTR_MCP_IS_ERROR_RESULT,
                result.isError ?? false,
              );
              return result;
            },
          });

          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.mcp.reportMcpToolCall({
            agentId: agent.id,
            agentName: agent.name,
            agentType: agent.agentType ?? null,
            mcpServerName,
            toolName: name,
            durationSeconds,
            isError: false,
            agentLabels: agent.labels,
            requestSizeBytes: args ? JSON.stringify(args).length : undefined,
            responseSizeBytes: response.content
              ? JSON.stringify(response.content).length
              : undefined,
          });

          logger.info(
            {
              agentId,
              toolName: name,
            },
            isAgentDelegationTool
              ? "Agent delegation tool call completed"
              : "Archestra MCP tool call completed",
          );

          // `run_tool` dispatches reach a real server, and that call already
          // named the connection that served it — keep it. Anything else here
          // Archestra ran itself, with the caller's permissions, so the log and
          // the client still learn who it ran for.
          const archestraResult = {
            ...response,
            _meta: {
              ...(response._meta as Record<string, unknown> | undefined),
              [MCP_EXECUTED_AS_META_KEY]:
                extractMcpExecutedAs(response) ??
                platformExecutedAs(tokenAuth?.userId),
            },
          };

          // Persist archestra/agent delegation tool call to database
          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName: archestraMcpBranding.serverName,
              method: "tools/call",
              toolCall: {
                id: `archestra-${Date.now()}`,
                name,
                arguments: args || {},
              },
              toolResult: archestraResult,
              userId: tokenAuth?.userId ?? null,
              executionId: executionId ?? null,
              authMethod: deriveAuthMethod(tokenAuth) ?? null,
            });
          } catch (dbError) {
            logger.info(
              { err: dbError },
              "Failed to persist archestra tool call",
            );
          }

          return archestraResult;
        }

        logger.info(
          {
            agentId,
            toolName: name,
            argumentKeys: args ? Object.keys(args) : [],
            argumentsSize: JSON.stringify(args || {}).length,
          },
          "MCP gateway tool call received",
        );

        // Generate a unique ID for this tool call
        const toolCallId = `mcp-call-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        // Create CommonToolCall for McpClient
        const toolCall: CommonToolCall = {
          id: toolCallId,
          name,
          arguments: args || {},
        };

        // Execute the tool call via McpClient with tracing
        const result = await startActiveMcpSpan({
          toolName: name,
          mcpServerName,
          agent,
          teams,
          userTeams,
          agentType: agent.agentType,
          toolCallId,
          toolArgs: args,
          user: mcpUser,
          callback: async (span) => {
            const r = await mcpClient.executeToolCallForOwner(
              toolCall,
              agentOwner(agentId),
              tokenAuth,
              {
                availableTool,
                // Tasks: tasks/cancel on this replica aborts the gateway-side
                // await; whether the upstream stops working is up to the
                // upstream (stateless HTTP servers run on — see tasks.ts).
                abortSignal: taskAbortSignal,
                // A call that may detach is bounded by the task TTL, not the
                // synchronous patience window (see mcp-client).
                ...(taskEligible ? { upstreamTimeoutMs: TASK_TTL_MS } : {}),
                elicitationHandler: async (request) => {
                  // MRTR: a retry already carries the answer, so consume it
                  // instead of asking again.
                  const supplied =
                    mrtr?.inputResponses?.[GATEWAY_INPUT_REQUEST_KEY];
                  if (supplied !== undefined) {
                    return ElicitResultSchema.parse(supplied);
                  }

                  // Under 2026-07-28 a server may not open a request mid-call,
                  // so unwind and let the handler answer with an
                  // InputRequiredResult carrying this request.
                  if (mrtrEnabled) {
                    throw new InputRequiredSignal({
                      key: GATEWAY_INPUT_REQUEST_KEY,
                      request: {
                        method: "elicitation/create",
                        params: request.params as Record<string, unknown>,
                      },
                    });
                  }

                  try {
                    return await extra.sendRequest(request, ElicitResultSchema);
                  } catch (error) {
                    logger.warn(
                      {
                        agentId,
                        toolName: name,
                        mode: request.params.mode ?? "form",
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      },
                      "MCP elicitation request was not completed by caller",
                    );
                    throw error;
                  }
                },
              },
            );
            span.setAttribute(ATTR_MCP_IS_ERROR_RESULT, r.isError ?? false);
            return r;
          },
        });

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          agentId: agent.id,
          agentName: agent.name,
          agentType: agent.agentType ?? null,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: result.isError ?? false,
          agentLabels: agent.labels,
          requestSizeBytes: args ? JSON.stringify(args).length : undefined,
          responseSizeBytes: result.content
            ? JSON.stringify(result.content).length
            : undefined,
        });

        const contentLength = estimateToolResultContentLength(result.content);
        logger.info(
          {
            agentId,
            toolName: name,
            resultContentLength: contentLength.length,
            resultContentLengthEstimated: contentLength.isEstimated,
            isError: result.isError,
          },
          result.isError
            ? "MCP gateway tool call completed with error result"
            : "MCP gateway tool call completed",
        );

        // Transform CommonToolResult to MCP response format
        // When isError is true, we still return the content so the LLM can see
        // the error message and potentially try a different approach
        return complete({
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result.content) }],
          isError: result.isError,
          _meta: result._meta,
          structuredContent: result.structuredContent,
        });
      } catch (error) {
        // MRTR: not a failure. The call needs input the gateway does not have,
        // so it answers with an InputRequiredResult and the client retries the
        // whole call with the answer attached. Handled before the metrics below
        // so it is not counted as an errored tool call.
        if (isInputRequiredSignal(error)) {
          if (
            !clientSupportsInputRequest({
              clientCapabilities: mrtr?.clientCapabilities,
              request: error.request,
            })
          ) {
            // Asking a client for something it never declared is forbidden, and
            // it could not answer anyway — fail with a result the model can act
            // on rather than eliciting into the void.
            return structuredToolErrorResult({
              error: {
                type: "generic",
                message: `This tool needs ${error.request.method}, which this client does not support.`,
              },
            });
          }

          const nextRound = (mrtr?.round ?? 0) + 1;
          if (nextRound > MAX_INPUT_ROUNDS) {
            // Each round re-runs the tool from the top, so an upstream that
            // keeps asking would re-execute its side effects once per round
            // and prompt the user indefinitely. Stop rather than loop.
            logger.warn(
              { agentId, toolName: name, rounds: nextRound },
              "MCP tool exceeded the input-round cap; refusing to elicit again",
            );
            return structuredToolErrorResult({
              error: {
                type: "generic",
                message: `This tool asked for input more than ${MAX_INPUT_ROUNDS} times without completing.`,
              },
            });
          }

          return buildInputRequiredResult({
            inputRequests: { [error.key]: error.request },
            requestState: encodeRequestState({
              round: nextRound,
              principal: deriveStatePrincipal({
                userId: tokenAuth?.userId,
                tokenId: tokenAuth?.tokenId,
                organizationId: tokenAuth?.organizationId,
              }),
              method: "tools/call",
              requestParams: { name, arguments: args ?? {} },
              keys: [error.key],
            }),
          });
        }

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          agentId: agent.id,
          agentName: agent.name,
          agentType: agent.agentType ?? null,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: true,
          agentLabels: agent.labels,
          requestSizeBytes: args ? JSON.stringify(args).length : undefined,
        });

        if (typeof error === "object" && error !== null && "code" in error) {
          throw error; // Re-throw JSON-RPC errors
        }

        throw {
          code: -32603, // Internal error
          message: "Tool execution failed",
          data: error instanceof Error ? error.message : "Unknown error",
        };
      }
    };

    return runToolCallMaybeTask({
      eligible: taskEligible,
      agentId,
      principal: deriveStatePrincipal({
        userId: tokenAuth?.userId,
        tokenId: tokenAuth?.tokenId,
        organizationId: tokenAuth?.organizationId,
      }),
      toolName: name,
      execute: executeCallToolRequest,
    });
  });

  logger.info({ agentId }, "MCP server instance created");
  return { server: mcpServer, agent };
}

/**
 * Create a stateless transport for a request
 * Each request gets a fresh transport with no session persistence
 */
export function createStatelessTransport(
  agentId: string,
): StreamableHTTPServerTransport {
  logger.info({ agentId }, "Creating stateless transport instance");

  // Create transport in stateless mode (no session persistence)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode - no sessions
    enableJsonResponse: true, // Use JSON responses instead of SSE
  });

  logger.info({ agentId }, "Stateless transport instance created");
  return transport;
}

/**
 * Hono's Node adapter drains unread request bodies by calling
 * `request.socket.destroySoon()`. Fastify inject uses a socket-like test object
 * without that legacy method, so provide the method only when the socket lacks it.
 */
export function ensureRequestSocketDestroySoon(request: IncomingMessage): void {
  const socket = request.socket as
    | (IncomingMessage["socket"] & {
        destroySoon?: () => void;
        end?: () => void;
      })
    | undefined;

  if (!socket || typeof socket.destroySoon === "function") {
    return;
  }

  socket.destroySoon = () => {
    if (typeof socket.destroy === "function") {
      socket.destroy();
      return;
    }

    socket.end?.();
  };
}

/**
 * Extract bearer token from Authorization header
 * Returns the token string if valid, null otherwise
 */
export function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization as string | undefined;
  if (!authHeader) {
    return null;
  }

  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return tokenMatch?.[1] ?? null;
}

/**
 * Extract profile ID from URL path and token from Authorization header.
 * URL format: /v1/mcp/:profileId (accepts both UUID and slug)
 */
export async function extractProfileIdAndTokenFromRequest(
  request: FastifyRequest,
): Promise<{ profileId: string; token: string } | null> {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  // Extract profile ID or slug from URL path (last segment)
  const idOrSlug = request.url.split("/").at(-1)?.split("?")[0];
  if (!idOrSlug) {
    return null;
  }

  const profileId = await AgentModel.resolveIdFromIdOrSlug(idOrSlug);
  return profileId ? { profileId, token } : null;
}

/**
 * Extract headers from an incoming request that match the gateway's passthrough allowlist.
 * Returns a map of header name → value, or undefined if none matched.
 */
export function extractPassthroughHeaders(
  allowlist: string[] | null | undefined,
  requestHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> | undefined {
  if (!allowlist || allowlist.length === 0) {
    return undefined;
  }
  const extracted: Record<string, string> = {};
  for (const headerName of allowlist) {
    const value = requestHeaders[headerName.toLowerCase()];
    if (typeof value === "string") {
      extracted[headerName] = value;
    } else if (Array.isArray(value)) {
      extracted[headerName] = value.join(", ");
    }
  }
  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

/**
 * Validate a platform-managed token for a specific profile
 * Returns token auth info if valid, null otherwise
 *
 * Validates that:
 * 1. The token is valid (exists and matches)
 * 2. The profile is accessible via this token:
 *    - Org token: profile must belong to the same organization
 *    - Team token: profile must be assigned to that team
 */
export async function validateTeamToken(
  profileId: string,
  tokenValue: string,
  agentAccessContext?: AgentAccessContext | null,
): Promise<TokenAuthResult | null> {
  // Validate the token itself
  const token = await TeamTokenModel.validateToken(tokenValue);
  if (!token) {
    return null;
  }

  return validateResolvedTeamToken({
    profileId,
    token,
    agentAccessContext,
  });
}

async function validateResolvedTeamToken(params: {
  profileId: string;
  token: SelectTeamToken;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  const { profileId, token, agentAccessContext } = params;

  // Check if profile is accessible via this token
  if (!token.isOrganizationToken) {
    // Team token: profile must be assigned to this team, or be teamless (org-wide)
    const hasAccess = await AgentTeamModel.teamHasAgentAccess(
      profileId,
      token.teamId,
      agentAccessContext,
    );
    if (!hasAccess) {
      logger.warn(
        { profileId, tokenTeamId: token.teamId },
        "Profile not accessible via team token",
      );
      return null;
    }
  }
  // Org token: any profile in the organization is accessible
  // (organization membership is verified in the route handler)

  return {
    tokenId: token.id,
    teamId: token.teamId,
    isOrganizationToken: token.isOrganizationToken,
    organizationId: token.organizationId,
  };
}

/**
 * Validate a user token for a specific profile
 * Returns token auth info if valid, null otherwise
 *
 * Validates that:
 * 1. The token is valid (exists and matches)
 * 2. The profile is accessible via this token:
 *    - User has mcpGateway:admin permission (can access all gateways), OR
 *    - User is a member of at least one team that the profile is assigned to
 */
export async function validateUserToken(
  profileId: string,
  tokenValue: string,
  agentAccessContext?: AgentAccessContext | null,
): Promise<TokenAuthResult | null> {
  // Validate the token itself
  const token = await UserTokenModel.validateToken(tokenValue);
  if (!token) {
    logger.debug(
      { profileId, tokenPrefix: tokenValue.substring(0, 14) },
      "validateUserToken: token not found in user_token table",
    );
    return null;
  }

  return validateResolvedUserToken({
    profileId,
    token,
    agentAccessContext,
  });
}

async function validateResolvedUserToken(params: {
  profileId: string;
  token: SelectUserToken;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  const { profileId, token, agentAccessContext } = params;

  // Check if user has MCP gateway admin permission (can access all gateways)
  const isGatewayAdmin = await userHasPermission(
    token.userId,
    token.organizationId,
    "mcpGateway",
    "admin",
  );

  if (isGatewayAdmin) {
    return {
      tokenId: token.id,
      teamId: null, // User tokens aren't scoped to a single team
      isOrganizationToken: false,
      organizationId: token.organizationId,
      isUserToken: true,
      userId: token.userId,
    };
  }

  // Non-admin: user can access profile if it's teamless (org-wide) or shares a team
  if (
    !(await AgentTeamModel.userHasAgentAccess(
      token.userId,
      profileId,
      false,
      agentAccessContext,
    ))
  ) {
    logger.warn(
      { profileId, userId: token.userId },
      "Profile not accessible via user token (no shared teams)",
    );
    return null;
  }

  return {
    tokenId: token.id,
    teamId: null, // User tokens aren't scoped to a single team
    isOrganizationToken: false,
    organizationId: token.organizationId,
    isUserToken: true,
    userId: token.userId,
  };
}

/**
 * Validate an OAuth access token for a specific profile.
 * Looks up the token by its SHA-256 hash in the oauth_access_token table
 * (matching better-auth's hashed token storage), then checks user access.
 *
 * Returns token auth info if valid, null otherwise.
 */
export async function validateOAuthToken(params: {
  profileId: string;
  tokenValue: string;
}): Promise<TokenAuthResult | null>;
export async function validateOAuthToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null>;
export async function validateOAuthToken(
  profileIdOrParams:
    | string
    | {
        profileId: string;
        tokenValue: string;
      },
  tokenValueArg?: string,
): Promise<TokenAuthResult | null> {
  const profileId =
    typeof profileIdOrParams === "string"
      ? profileIdOrParams
      : profileIdOrParams.profileId;
  const tokenValue =
    typeof profileIdOrParams === "string"
      ? tokenValueArg
      : profileIdOrParams.tokenValue;

  if (!tokenValue) {
    return null;
  }

  const oauthTokenHash = buildOAuthTokenHash(tokenValue);
  return validateOAuthTokenByHash({ profileId, oauthTokenHash });
}

async function validateOAuthTokenByHash(params: {
  profileId: string;
  oauthTokenHash: string;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  try {
    const agent =
      params.agentAccessContext ??
      (await findAgentAccessContextById(params.profileId));
    if (!agent) {
      return null;
    }

    // Look up the hashed token via the model
    const accessToken = await OAuthAccessTokenModel.getByTokenHash(
      params.oauthTokenHash,
    );

    if (!accessToken) {
      return null;
    }

    // Check if associated refresh token has been revoked
    if (accessToken.refreshTokenRevoked) {
      logger.debug(
        { profileId: params.profileId },
        "validateOAuthToken: associated refresh token is revoked",
      );
      return null;
    }

    // Check token expiry
    if (accessToken.expiresAt < new Date()) {
      logger.debug(
        { profileId: params.profileId },
        "validateOAuthToken: token expired",
      );
      return null;
    }

    if (
      accessToken.referenceId?.startsWith(MCP_RESOURCE_REFERENCE_PREFIX) &&
      accessToken.referenceId !==
        `${MCP_RESOURCE_REFERENCE_PREFIX}${params.profileId}`
    ) {
      logger.warn(
        {
          profileId: params.profileId,
          tokenReferenceId: accessToken.referenceId,
        },
        "validateOAuthToken: token is bound to a different MCP resource",
      );
      return null;
    }

    // A token audience-bound to a shareable-App connector is valid only at that
    // connector, never at the MCP gateway — reject it before the user-access
    // branch would otherwise accept it on team membership alone.
    if (isAppConnectorAudienceRef(accessToken.referenceId)) {
      logger.warn(
        { profileId: params.profileId },
        "validateOAuthToken: rejecting an app-connector-bound token at the MCP gateway",
      );
      return null;
    }

    // Application (client_credentials) tokens minted for an MCP OAuth client
    // carry no acting user. Authorize them against the client's allowed gateways
    // instead of a user's team membership.
    if (
      accessToken.referenceId?.startsWith(MCP_OAUTH_CLIENT_REFERENCE_PREFIX)
    ) {
      return validateMcpOauthClientToken({
        accessToken,
        profileId: params.profileId,
        organizationId: agent.organizationId,
      });
    }

    const userId = accessToken.userId;
    if (!userId) {
      return null;
    }
    const organizationId = agent.organizationId;

    // Check if user has MCP gateway admin permission (can access all gateways)
    const isGatewayAdmin = await userHasPermission(
      userId,
      organizationId,
      "mcpGateway",
      "admin",
    );

    if (isGatewayAdmin) {
      return {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        isUserToken: true,
        userId,
      };
    }

    // Non-admin access has two additive sources:
    //   1. the user's own RBAC (profile is teamless/org-wide or shares a team), or
    //   2. an admin-controlled grant on the authorization_code MCP OAuth client
    //      that minted this token — its allowedGatewayIds may grant access to
    //      gateways the user could not otherwise reach (e.g. a gateway reachable
    //      only through a specific pre-registered app).
    const hasRbacAccess = await AgentTeamModel.userHasAgentAccess(
      userId,
      params.profileId,
      false,
      agent,
    );
    const hasClientGrant =
      hasRbacAccess || !accessToken.clientId
        ? false
        : await mcpOauthClientGrantsGatewayAccess({
            clientId: accessToken.clientId,
            profileId: params.profileId,
            organizationId,
          });

    if (!hasRbacAccess && !hasClientGrant) {
      logger.warn(
        { profileId: params.profileId, userId },
        "validateOAuthToken: profile not accessible via OAuth token (no RBAC access and no client grant)",
      );
      return null;
    }

    return {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId,
      isUserToken: true,
      userId,
    };
  } catch (error) {
    logger.debug(
      {
        profileId: params.profileId,
        error: error instanceof Error ? error.message : "unknown",
      },
      "validateOAuthToken: token validation failed",
    );
    return null;
  }
}

/**
 * Authorize a client_credentials access token minted for an MCP OAuth client.
 *
 * These are application tokens (machine-to-machine): there is no acting user,
 * so authorization is the client's explicit `allowedGatewayIds` list rather
 * than team membership. The per-gateway check here is the real authorization
 * gate — a successful result grants access to exactly the requested gateway and
 * nothing broader (teamId/isOrganizationToken stay null/false, so no downstream
 * code re-broadens access).
 *
 * Note: an MCP OAuth client is a shared application credential with no acting
 * user, so gateway tools that resolve per-user/dynamic upstream credentials at
 * call time are not supported — assign shared/org-scoped credentials to those
 * tools.
 */
async function validateMcpOauthClientToken(params: {
  accessToken: {
    id: string;
    clientId: string | null;
    referenceId: string | null;
    scopes: string[] | null;
  };
  profileId: string;
  organizationId: string;
}): Promise<TokenAuthResult | null> {
  const { accessToken, profileId, organizationId } = params;

  // Require the mcp scope (parallels the llm:proxy scope check on the LLM path).
  if (!accessToken.scopes?.includes(MCP_GATEWAY_OAUTH_SCOPE)) {
    return null;
  }
  if (!accessToken.clientId) {
    return null;
  }

  // findByClientId returns null when the client was deleted or disabled.
  const oauthClient = await McpOauthClientModel.findByClientId(
    accessToken.clientId,
  );
  if (!oauthClient) {
    return null;
  }

  // Defense in depth: the token's referenceId must point at this exact client.
  if (
    accessToken.referenceId !==
    `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`
  ) {
    return null;
  }

  // Cross-org tokens are never valid for this gateway.
  if (oauthClient.organizationId !== organizationId) {
    return null;
  }

  // The client must be explicitly scoped to the requested gateway.
  if (!oauthClient.allowedGatewayIds.includes(profileId)) {
    logger.warn(
      { profileId, clientId: oauthClient.clientId },
      "validateOAuthToken: MCP OAuth client not authorized for this gateway",
    );
    return null;
  }

  return {
    tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
    teamId: null,
    isOrganizationToken: false,
    organizationId,
  };
}

/**
 * Whether the authorization_code MCP OAuth client that minted a user-bound token
 * grants access to a gateway beyond the user's own RBAC. This is an additive,
 * admin-controlled access grant: only client_credentials clients use
 * allowedGatewayIds as a sole authority, whereas an authorization_code client's
 * list confers extra access to anyone who authenticates through it. Disabled or
 * deleted clients (findByClientId returns null) grant nothing.
 */
async function mcpOauthClientGrantsGatewayAccess(params: {
  clientId: string;
  profileId: string;
  organizationId: string;
}): Promise<boolean> {
  const oauthClient = await McpOauthClientModel.findByClientId(params.clientId);
  if (!oauthClient || oauthClient.grantType !== "authorization_code") {
    return false;
  }
  if (oauthClient.organizationId !== params.organizationId) {
    return false;
  }
  return oauthClient.allowedGatewayIds.includes(params.profileId);
}

/**
 * Validate any token for a specific profile.
 * Tries external IdP JWKS first (if configured), then team/org tokens, user tokens, and OAuth tokens.
 * Returns token auth info if valid, null otherwise.
 */
export async function validateMCPGatewayToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  return (await authenticateMCPGatewayRequest(profileId, tokenValue)).result;
}

/**
 * Resolve which organization a platform token belongs to, without naming an
 * agent.
 *
 * Every other entry point here answers "may this token reach *this* agent",
 * which needs the agent up front. Enumerating agents inverts that, so it needs
 * the principal first. This deliberately grants nothing: it only narrows the
 * candidate set to one organization, and the caller still has to run the
 * ordinary per-agent check on each candidate.
 *
 * Only platform tokens can be resolved this way. An external IdP JWT is
 * validated against a JWKS configured *on an agent*, and an OAuth token is
 * looked up per agent, so neither has an agent-independent identity to read.
 */
export async function resolveTokenOrganizationId(
  tokenValue: string,
): Promise<string | null> {
  if (!hasArchestraTokenPrefix(tokenValue)) {
    return null;
  }

  const rawTokenHash = createHash("sha256").update(tokenValue).digest("hex");
  const resolved = await resolveArchestraToken(tokenValue, rawTokenHash);
  return resolved?.token.organizationId ?? null;
}

/**
 * Same as {@link validateMCPGatewayToken}, but also reports why authentication
 * failed so the gateway route can return an actionable 401 instead of a
 * catch-all. Failures are never cached (see `cacheTokenAuthResult`), so the
 * reason is always computed against fresh state.
 */
export async function authenticateMCPGatewayRequest(
  profileId: string,
  tokenValue: string,
): Promise<GatewayAuthOutcome> {
  const tokenHashes = buildTokenHashes(profileId, tokenValue);
  const cachedResult = getCachedTokenAuthResult(tokenHashes.cacheKey);
  if (cachedResult) {
    return { result: cachedResult, reason: null };
  }

  let agentAccessContextPromise: Promise<AgentAccessContext | null> | undefined;
  const getAgentAccessContext =
    async (): Promise<AgentAccessContext | null> => {
      if (!agentAccessContextPromise) {
        agentAccessContextPromise = findAgentAccessContextById(profileId);
      }
      return agentAccessContextPromise;
    };

  // Try external IdP JWKS validation first (if profile has an IdP configured)
  let externalIdpReason: GatewayAuthFailureReason | null = null;
  if (!hasArchestraTokenPrefix(tokenValue)) {
    const externalIdp = await authenticateExternalIdpToken(
      profileId,
      tokenValue,
    );
    if (externalIdp.result) {
      cacheTokenAuthResult(tokenHashes.cacheKey, externalIdp.result);
      return externalIdp;
    }
    externalIdpReason = externalIdp.reason;
  }

  if (hasArchestraTokenPrefix(tokenValue)) {
    const resolvedToken = await resolveArchestraToken(
      tokenValue,
      tokenHashes.rawTokenHash,
    );
    if (resolvedToken?.type === "team") {
      const teamTokenResult = await validateResolvedTeamToken({
        profileId,
        token: resolvedToken.token,
        agentAccessContext: resolvedToken.token.isOrganizationToken
          ? null
          : await getAgentAccessContext(),
      });
      if (teamTokenResult) {
        cacheTokenAuthResult(tokenHashes.cacheKey, teamTokenResult);
        return { result: teamTokenResult, reason: null };
      }
    }

    if (resolvedToken?.type === "user") {
      const userTokenResult = await validateResolvedUserToken({
        profileId,
        token: resolvedToken.token,
        agentAccessContext: await getAgentAccessContext(),
      });
      if (userTokenResult) {
        cacheTokenAuthResult(tokenHashes.cacheKey, userTokenResult);
        return { result: userTokenResult, reason: null };
      }
    }

    logger.warn(
      { profileId, tokenPrefix: tokenValue.substring(0, 14) },
      "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
    );
    cacheTokenAuthResult(tokenHashes.cacheKey, null);
    return { result: null, reason: "invalid_token" };
  }

  // Try OAuth token validation (for MCP clients like Open WebUI)
  const oauthResult = await validateOAuthTokenByHash({
    profileId,
    oauthTokenHash: tokenHashes.oauthTokenHash,
    agentAccessContext: await getAgentAccessContext(),
  });
  if (oauthResult) {
    // This cache is intentionally short-lived and process-local. Revocations
    // may take up to TOKEN_AUTH_CACHE_TTL_MS to fully age out across requests.
    cacheTokenAuthResult(tokenHashes.cacheKey, oauthResult);
    return { result: oauthResult, reason: null };
  }

  logger.warn(
    { profileId, tokenPrefix: tokenValue.substring(0, 14) },
    "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
  );
  cacheTokenAuthResult(tokenHashes.cacheKey, null);

  // A non-JWT that failed here was never a JWKS candidate, so an IdP-specific
  // reason would be misleading — it most likely meant to be an OAuth token.
  return {
    result: null,
    reason:
      externalIdpReason && isJwtShaped(tokenValue)
        ? externalIdpReason
        : "invalid_token",
  };
}

/**
 * Validate a JWT from an external Identity Provider via JWKS.
 * Only attempted when the profile has an associated SSO provider with OIDC config.
 *
 * @returns TokenAuthResult with external identity info, or null if validation fails
 */
export async function validateExternalIdpToken(
  profileId: string,
  tokenValue: string,
  permissionResource: "mcpGateway" | "llmProxy" = "mcpGateway",
): Promise<TokenAuthResult | null> {
  const { result } = await authenticateExternalIdpToken(
    profileId,
    tokenValue,
    permissionResource,
  );
  return result;
}

/**
 * Same as {@link validateExternalIdpToken}, but reports *why* authentication
 * failed so the gateway can answer with something more useful than a blanket
 * "invalid token". See {@link GatewayAuthFailureReason} for what is safe to
 * hand back to an unauthenticated caller.
 */
async function authenticateExternalIdpToken(
  profileId: string,
  tokenValue: string,
  permissionResource: "mcpGateway" | "llmProxy" = "mcpGateway",
): Promise<GatewayAuthOutcome> {
  try {
    // Look up the agent to check if it has an identity provider configured
    const agent = await AgentModel.findGatewayAgentById(profileId);
    if (!agent?.identityProviderId) {
      return { result: null, reason: "idp_not_linked" };
    }

    // Look up the identity provider to get OIDC config
    const idpProvider = await findExternalIdentityProviderById(
      agent.identityProviderId,
    );
    if (!idpProvider) {
      logger.warn(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: Identity provider not found",
      );
      return { result: null, reason: "idp_misconfigured" };
    }

    if (!idpProvider.oidcConfig) {
      logger.warn(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: identity provider has no OIDC config",
      );
      return { result: null, reason: "idp_misconfigured" };
    }

    const oidcConfig = idpProvider.oidcConfig;

    if (!oidcConfig.clientId) {
      logger.warn(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: identity provider OIDC clientId is required for audience validation",
      );
      return { result: null, reason: "idp_misconfigured" };
    }

    // Use the JWKS endpoint from OIDC config if available (avoids OIDC discovery
    // round-trip, and works when the issuer URL isn't reachable from the backend
    // e.g. in CI where the issuer is a NodePort URL but the backend runs in a pod).
    // Fall back to OIDC discovery from the issuer URL.
    const jwksUrl =
      oidcConfig.jwksEndpoint ??
      (await discoverOidcJwksUrl(idpProvider.issuer));
    if (!jwksUrl) {
      logger.warn(
        { profileId, issuer: idpProvider.issuer },
        "validateExternalIdpToken: could not determine JWKS URL",
      );
      return { result: null, reason: "idp_misconfigured" };
    }

    // Validate the JWT. The IdP's attribute mapping decides which claim holds
    // the email: an IdP that namespaces custom claims populates something like
    // `https://example.com/email` and leaves the standard `email` claim unset.
    const result = await jwksValidator.validateJwt({
      token: tokenValue,
      issuerUrl: idpProvider.issuer,
      jwksUrl,
      audience: oidcConfig.clientId,
      emailClaim: oidcConfig.mapping?.email ?? null,
    });

    if (!result) {
      return { result: null, reason: "invalid_token" };
    }

    logger.info(
      {
        profileId,
        identityProviderId: agent.identityProviderId,
        sub: result.sub,
        email: result.email,
      },
      "validateExternalIdpToken: JWT validated via external IdP JWKS",
    );

    // Match JWT email claim to an Archestra user for access control. Some IdPs
    // use the subject as the user email and omit the email claim.
    const userEmail = result.email ?? getEmailFromSubject(result.sub);
    if (!userEmail) {
      logger.warn(
        {
          profileId,
          sub: result.sub,
          configuredEmailClaim: oidcConfig.mapping?.email ?? null,
        },
        "validateExternalIdpToken: JWT has no email claim, cannot match to Archestra user",
      );
      return { result: null, reason: "no_email_claim" };
    }

    const user = await UserModel.findByEmail(userEmail);
    if (!user) {
      logger.warn(
        { profileId, email: userEmail },
        "validateExternalIdpToken: JWT email does not match any Archestra user",
      );
      return { result: null, reason: "unknown_user" };
    }

    const member = await MemberModel.getByUserId(user.id, agent.organizationId);
    if (!member) {
      logger.warn(
        { profileId, userId: user.id, email: userEmail },
        "validateExternalIdpToken: user is not a member of the gateway's organization",
      );
      return { result: null, reason: "not_org_member" };
    }

    // Check if user has admin permission for the target resource (MCP Gateway or LLM Proxy)
    const isAdmin = await userHasPermission(
      user.id,
      agent.organizationId,
      permissionResource,
      "admin",
    );

    const authenticated: TokenAuthResult = {
      tokenId: `external_idp:${agent.identityProviderId}:${result.sub}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: agent.organizationId,
      isUserToken: true,
      userId: user.id,
      isExternalIdp: true,
      rawToken: tokenValue,
    };

    if (isAdmin) {
      return { result: authenticated, reason: null };
    }

    // Non-admin: user can access profile if it's teamless (org-wide) or shares a team
    if (!(await AgentTeamModel.userHasAgentAccess(user.id, profileId, false))) {
      logger.warn(
        { profileId, userId: user.id },
        "validateExternalIdpToken: profile not accessible via external IdP (no shared teams)",
      );
      return { result: null, reason: "no_gateway_access" };
    }

    return { result: authenticated, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.warn(
      { profileId, error: message, stack },
      "validateExternalIdpToken: unexpected error",
    );
    return { result: null, reason: "invalid_token" };
  }
}

/**
 * Whether a token even looks like a JWT (three base64url segments). Used only
 * to decide whether a JWKS-specific failure reason is worth reporting.
 */
function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

/**
 * Delimiters IdPs use to namespace a composite subject (`google-apps|a@b.com`,
 * `oidc:a@b.com`). Such a subject satisfies a naive "looks like an email" test
 * — `|` and `:` are legal in an address local part — but never matches a stored
 * user, so accepting it turns a missing-email-claim misconfiguration into a
 * misleading "no matching user".
 */
const COMPOSITE_SUBJECT_DELIMITERS = /[|:\\/]/;

function getEmailFromSubject(subject: string | undefined): string | null {
  // This fallback exists for IdPs whose subject *is* the user's email. It is
  // otherwise deliberately loose: after token validation succeeds, it only
  // decides whether an email-shaped subject can be used for lookup.
  if (!subject || COMPOSITE_SUBJECT_DELIMITERS.test(subject)) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) {
    return null;
  }
  return subject;
}

/**
 * TTL cache for buildKnowledgeSourcesDescription to avoid repeated DB queries
 * on every tools/list request. Invalidated after 30 seconds.
 */
const kbDescriptionCache = new Map<
  string,
  { description: string | null; expiresAt: number }
>();
const KB_DESCRIPTION_CACHE_TTL_MS = 30_000;

function getCachedTokenAuthResult(
  cacheKey: string,
): TokenAuthResult | null | undefined {
  return tokenAuthCache.get(cacheKey);
}

function getCachedRawArchestraToken(
  rawTokenHash: string,
): ResolvedArchestraToken | null | undefined {
  return rawArchestraTokenCache.get(rawTokenHash);
}

function cacheTokenAuthResult(
  cacheKey: string,
  result: TokenAuthResult | null,
): void {
  // Negative results are intentionally NOT cached. Caching auth failures
  // creates a "cache treadmill" where every retry refreshes the negative
  // entry: a transient race during agent/IdP creation fails the first
  // call, the failure is cached, the test/client retries within the cache
  // TTL window, that retry finds (and refreshes) the cached `null`, and
  // the cycle repeats forever (or until the polling budget is exhausted).
  //
  // This was the root cause of intermittent 401s in CI for the JWKS /
  // enterprise-managed-credentials e2e suites — those tests create an
  // identity provider + agent + IdP-binding within milliseconds of the
  // first gateway call, and the negative cache kept the early failure
  // sticky long after the underlying state stabilized.
  //
  // The defensive benefit of negative caching (less DB load on rejected
  // tokens) is small: invalid-token requests already pay an upstream
  // auth-rate-limit cost, and the validator's DB lookups are indexed and
  // fast. Skipping the cache for failures lets every request re-evaluate
  // against fresh state — eliminating the race entirely.
  if (result === null) {
    return;
  }
  tokenAuthCache.set(cacheKey, result, TOKEN_AUTH_CACHE_TTL_MS);
}

function cacheRawArchestraToken(
  rawTokenHash: string,
  result: ResolvedArchestraToken | null,
): void {
  // Same rationale as cacheTokenAuthResult: don't cache failures, to
  // avoid the negative-cache treadmill that turns a transient creation
  // race into a sticky 5-second window of 401s.
  if (result === null) {
    return;
  }
  rawArchestraTokenCache.set(rawTokenHash, result, TOKEN_AUTH_CACHE_TTL_MS);
}

function buildTokenHashes(profileId: string, tokenValue: string): TokenHashes {
  const digest = createHash("sha256").update(tokenValue).digest();
  return {
    cacheKey: `${profileId}:${digest.toString("hex")}`,
    oauthTokenHash: digest.toString("base64url"),
    rawTokenHash: digest.toString("hex"),
  };
}

function buildOAuthTokenHash(tokenValue: string): string {
  return createHash("sha256").update(tokenValue).digest("base64url");
}

async function resolveArchestraToken(
  tokenValue: string,
  rawTokenHash: string,
): Promise<ResolvedArchestraToken | null> {
  const cached = getCachedRawArchestraToken(rawTokenHash);
  if (cached !== undefined) {
    return cached;
  }

  const teamToken = await TeamTokenModel.validateToken(tokenValue);
  if (teamToken) {
    const result: ResolvedArchestraToken = {
      type: "team",
      token: teamToken,
    };
    cacheRawArchestraToken(rawTokenHash, result);
    return result;
  }

  const userToken = await UserTokenModel.validateToken(tokenValue);
  if (userToken) {
    const result: ResolvedArchestraToken = {
      type: "user",
      token: userToken,
    };
    cacheRawArchestraToken(rawTokenHash, result);
    return result;
  }

  cacheRawArchestraToken(rawTokenHash, null);
  return null;
}

/**
 * Build a dynamic description for the query_knowledge_sources tool that includes
 * the agent's actual knowledge base names and connector sources.
 * Results are cached per agentId with a 30s TTL.
 */
export async function buildKnowledgeSourcesDescription(
  agentId: string,
): Promise<string | null> {
  const cached = kbDescriptionCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.description;
  }

  const [kbAssignments, directConnectorIds] = await Promise.all([
    AgentKnowledgeBaseModel.findByAgent(agentId),
    AgentConnectorAssignmentModel.getConnectorIds(agentId),
  ]);

  if (kbAssignments.length === 0 && directConnectorIds.length === 0) {
    kbDescriptionCache.set(agentId, {
      description: null,
      expiresAt: Date.now() + KB_DESCRIPTION_CACHE_TTL_MS,
    });
    return null;
  }

  const kbIds = kbAssignments.map((a) => a.knowledgeBaseId);

  const [knowledgeBases, kbConnectors, directConnectors] = await Promise.all([
    kbIds.length > 0 ? KnowledgeBaseModel.findByIds(kbIds) : [],
    kbIds.length > 0
      ? // Query scope: the description lists the sources queries may span,
        // which includes auto-sync-permissions connectors for every user.
        KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(kbIds, {
          visibilityScope: "query",
        })
      : [],
    KnowledgeBaseConnectorModel.findByIds(directConnectorIds),
  ]);

  const kbNames = knowledgeBases.map((kb) => kb.name);
  const allConnectors = [...kbConnectors, ...directConnectors];
  const connectorTypes = [
    ...new Set(allConnectors.map((c) => c.connectorType)),
  ];

  // Written as a PROACTIVE trigger, and deliberately naming files/images/photos
  // and the verbs a user actually uses ("show me", "find"). The previous
  // reactive wording ("a question you cannot answer from your training data")
  // excluded imperatives: asked to "show me a man with lobsters" the model went
  // looking for an image-GENERATION tool and answered that it cannot show
  // pictures, with the indexed photo one call away. This string is also the
  // text search_tools ranks on, so the vocabulary matters twice.
  let description =
    "Search the organization's indexed knowledge — documents, files, images, photos, " +
    "and records synced from its connected sources. " +
    "Use it whenever the user refers to something that may live in this workspace rather " +
    "than in your training data: a question about internal material, or a request to find, " +
    "look up, show, open, or describe a document, file, or picture. " +
    "Prefer searching over answering from memory or replying that you cannot see files or " +
    "images — this workspace's own content is reachable only through this tool. " +
    "Pass the user's original query as-is — do not rephrase, summarize, or expand it. " +
    "The system performs its own query optimization internally.";

  if (kbNames.length > 0) {
    const kbList = kbNames.join(", ");
    description +=
      kbList.length > 500
        ? ` Available knowledge bases: ${kbList.slice(0, 500)}...`
        : ` Available knowledge bases: ${kbList}.`;
  }
  if (connectorTypes.length > 0) {
    description += ` Connected sources: ${connectorTypes.join(", ")}.`;
  }

  kbDescriptionCache.set(agentId, {
    description,
    expiresAt: Date.now() + KB_DESCRIPTION_CACHE_TTL_MS,
  });

  return description;
}

/**
 * The single point where the advertised tool list is finalized. Every
 * contributor (assigned catalog tools, Archestra Apps, built-ins, delegation
 * tools) funnels through here, so a new tool source cannot reintroduce a leak
 * by skipping a filter of its own.
 */
function filterExposedTools(params: {
  toolExposureMode: ToolExposureMode;
  advertiseUiResourceTools: boolean;
  autoToolMode: boolean;
  tools: McpListToolCandidate[];
}) {
  const { toolExposureMode, advertiseUiResourceTools, autoToolMode, tools } =
    params;
  return tools.filter((tool) => {
    // `search_and_run_only` hides every tool behind search_tools/run_tool, but
    // the meta tools themselves and the always-exposed skill path must stay
    // top-level. UI-providing tools (app launch tools, external ext-apps tools)
    // stay too, on two conditions. First, only on a surface that advertises
    // them: an MCP Apps host renders a UI from a tool DEFINITION listed at
    // discovery time, so a gateway must keep it top-level; the chat surface
    // renders from the tool result instead, so it reaches UI tools through
    // search_tools/run_tool and keeps its list compact. Second, only when the
    // agent is NOT in Auto tool mode: Auto mode promises a list that never
    // burns context on the catalog, and its reachable set is the caller's
    // entire accessible corpus, so no per-class carve-out may widen it — the
    // model discovers those tools with search_tools instead. A Custom-mode
    // agent advertises the UI tools it explicitly assigns, a bounded set the
    // operator chose. `full` mode hides only the meta tools.
    return toolExposureMode === "search_and_run_only"
      ? isArchestraMetaTool(tool.name) ||
          isTaskControlTool(tool.name) ||
          isAlwaysExposedTool(tool.name) ||
          (advertiseUiResourceTools &&
            !autoToolMode &&
            providesUiResource(tool))
      : !isArchestraMetaTool(tool.name);
  });
}

type McpListTool = ListToolsResult["tools"][number];

type McpToolForSearchDescription = {
  name: string;
  catalogId: string | null;
};

type McpListToolCandidate = {
  name: string;
  description: string | null;
  parameters: McpListTool["inputSchema"];
  catalogId?: string | null;
  meta?: {
    annotations?: McpListTool["annotations"];
    _meta?: McpListTool["_meta"];
  };
};

function toMcpListTool(tool: {
  name: string;
  description?: string | null;
  catalogId?: string | null;
  parameters?: unknown;
  inputSchema?: unknown;
  meta?: {
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  } | null;
}): McpListToolCandidate {
  return {
    name: tool.name,
    description: tool.description ?? null,
    parameters: normalizeToolInputSchema(tool.parameters ?? tool.inputSchema),
    catalogId: tool.catalogId,
    meta: tool.meta ?? undefined,
  };
}

function getImplicitArchestraMetaTools() {
  return getArchestraMcpTools().filter((tool) =>
    isArchestraMetaTool(tool.name),
  );
}

function getImplicitTaskControlTools() {
  return getArchestraMcpTools().filter((tool) => isTaskControlTool(tool.name));
}

// First occurrence wins: callers (getMcpToolsByAgent) order candidates with
// a healthy MCP server connection first, so when two catalog items' installs
// collide on display name, the working one is the one advertised.
function dedupeToolsByName<T extends { name: string }>(tools: T[]) {
  const deduped = new Map<string, T>();
  for (const tool of tools) {
    if (!deduped.has(tool.name)) {
      deduped.set(tool.name, tool);
    }
  }
  return Array.from(deduped.values());
}

// Caps for the server list appended to the search_tools description: how many
// servers are named (past this the list degrades to ", and N more") and how
// much of each server's own description is quoted alongside its name.
const SEARCH_TOOLS_DESCRIPTION_MAX_SERVERS = 100;
const SEARCH_TOOLS_DESCRIPTION_MAX_SERVER_DESCRIPTION_LENGTH = 200;

async function buildSearchToolsDescription(params: {
  mcpTools: McpToolForSearchDescription[];
  agentId: string;
  userId?: string;
  organizationId?: string;
  prefetchedCatalogs?: Awaited<
    ReturnType<typeof InternalMcpCatalogModel.getByIds>
  >;
}) {
  const { agentId, mcpTools, organizationId, prefetchedCatalogs, userId } =
    params;
  const searchTool = getArchestraMcpTools().find(
    (tool) =>
      archestraMcpBranding.getToolShortName(tool.name) ===
      TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const baseDescription = searchTool?.description;
  if (!baseDescription) {
    return null;
  }

  // Mirror search_tools' actual search space: the catalogs backing the
  // assigned tools, widened by the dynamically discoverable ones when the
  // agent's "access all tools" setting is on (getUnassignedDiscoverableTools
  // self-gates on that setting and a real authenticated user).
  const discoverableTools = await getUnassignedDiscoverableTools({
    assignedToolNames: new Set(mcpTools.map((tool) => tool.name)),
    agentId,
    userId,
    organizationId,
  });

  const catalogIds = [
    ...new Set(
      [...mcpTools, ...discoverableTools]
        .map((tool) => tool.catalogId)
        .filter(
          (catalogId): catalogId is string =>
            Boolean(catalogId) && catalogId !== ARCHESTRA_MCP_CATALOG_ID,
        ),
    ),
  ];

  if (catalogIds.length === 0) {
    return baseDescription;
  }

  const catalogs = new Map(prefetchedCatalogs ?? []);
  const missingCatalogIds = catalogIds.filter((id) => !catalogs.has(id));
  if (missingCatalogIds.length > 0) {
    const fetched = await InternalMcpCatalogModel.getByIds(missingCatalogIds);
    for (const [id, catalog] of fetched) {
      catalogs.set(id, catalog);
    }
  }

  const resolvedCatalogs = catalogIds
    .map((catalogId) => catalogs.get(catalogId))
    .filter((catalog) => catalog !== undefined);
  const catalogSummaries = resolvedCatalogs
    .slice(0, SEARCH_TOOLS_DESCRIPTION_MAX_SERVERS)
    .map((catalog) => {
      // Author-controlled catalog name/description flow into this model-facing
      // description, so neutralize control/format/whitespace before embedding.
      const name = sanitizeAppNameForToolMetadata(catalog.name);
      return catalog.description
        ? `${name} (${summarizeCatalogDescription(catalog.description)})`
        : name;
    });

  if (catalogSummaries.length === 0) {
    return baseDescription;
  }

  const remainingCount = resolvedCatalogs.length - catalogSummaries.length;
  const remainingText =
    remainingCount > 0 ? `, and ${remainingCount} more` : "";

  return `${baseDescription} Available MCP servers for this gateway include: ${catalogSummaries.join(", ")}${remainingText}. Use this tool first when the user names one of these servers or asks for capabilities that may be provided by connected MCP servers.`;
}

// One-line, length-capped rendering of a catalog's own description for
// embedding in the search_tools description. Collapses control/format
// characters (bidi overrides, and conservatively ZWJ/ZWNJ) alongside
// whitespace so an author-set description cannot reshape the model-facing text.
function summarizeCatalogDescription(description: string): string {
  const collapsed = description.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return collapsed.length >
    SEARCH_TOOLS_DESCRIPTION_MAX_SERVER_DESCRIPTION_LENGTH
    ? `${collapsed.slice(0, SEARCH_TOOLS_DESCRIPTION_MAX_SERVER_DESCRIPTION_LENGTH)}…`
    : collapsed;
}

/** @public — also consumed by the app MCP server (mcp-app-gateway.utils.ts). */
export function normalizeToolInputSchema(
  schema: unknown,
): McpListTool["inputSchema"] {
  if (isRecord(schema) && schema.type === "object") {
    return schema as McpListTool["inputSchema"];
  }

  return { type: "object", properties: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArchestraMetaTool(toolName: string) {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  return (
    shortName === TOOL_SEARCH_TOOLS_SHORT_NAME ||
    shortName === TOOL_RUN_TOOL_SHORT_NAME
  );
}

function isTaskControlTool(toolName: string) {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  return (
    shortName === TOOL_GET_TASK_SHORT_NAME ||
    shortName === TOOL_LIST_TASKS_SHORT_NAME ||
    shortName === TOOL_STEER_TASK_SHORT_NAME ||
    shortName === TOOL_CANCEL_TASK_SHORT_NAME
  );
}

function isAlwaysExposedTool(toolName: string) {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  return shortName !== null && isAlwaysExposedArchestraToolShortName(shortName);
}

/**
 * True when the tool carries an MCP App `ui://` resource in its definition —
 * canonical `_meta.ui.resourceUri` or the legacy flat `ui/resourceUri` key.
 * Mirrors {@link toolUiResourceUriSql} (models/tool.ts) so the in-memory gate and
 * the DB-side `providesUi` predicate never drift.
 */
function providesUiResource(tool: {
  meta?: McpListToolCandidate["meta"] | null;
}): boolean {
  const meta = tool.meta?._meta as
    | { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown }
    | undefined;
  // Scheme-check each key independently before falling back, matching the SQL's
  // per-key `like 'ui://%'` inside coalesce — so a non-ui:// canonical value
  // doesn't mask a valid legacy one.
  const isUiUri = (value: unknown): boolean =>
    typeof value === "string" && value.startsWith("ui://");
  return isUiUri(meta?.ui?.resourceUri) || isUiUri(meta?.["ui/resourceUri"]);
}

/**
 * Whether a resource-read failure is an expected "the upstream server can't
 * serve this" condition rather than a genuine platform fault. A third-party
 * tool can advertise a `ui://` UI resource whose server never implemented
 * `resources/read`; the client degrades to the plain tool result, so the
 * gateway logs this quietly instead of at error level.
 *
 * Code matching is delegated so the SEP-2164 migration of missing-resource
 * errors (-32002 to the generic -32602) does not silently reclassify these as
 * platform faults once upstreams move to the newer revision.
 */
function isUnavailableResourceError(error: unknown): boolean {
  if (
    error instanceof Error &&
    /method not found|resource not found/i.test(error.message)
  ) {
    return true;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return isResourceUnavailableError({
      code,
      message: typeof message === "string" ? message : undefined,
    });
  }
  return false;
}
