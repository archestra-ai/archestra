import {
  isPermissionActionGranted,
  ManagedResourceSchema,
  PermissionsSchema,
  PLAYWRIGHT_MCP_CATALOG_ID,
  ResourcePermissionActionSchema,
  ResourcePermissionScopeSchema,
  RouteId,
  withoutWildcardCoveredGrants,
} from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPermissionsForUserContext } from "@/auth/utils";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ResourcePermissions } from "@/services/resource-permissions";
// SPDX-SnippetEnd
import { getUserPermissions } from "@/services/user";
import {
  AgentCredentialReadinessSchema,
  ApiError,
  AppearanceSettingsSchema,
  AssignedToolSchema,
  ChatAgentRosterSchema,
  constructResponseSchema,
  LlmProviderApiKeyWithScopeInfoSchema,
  SelectAgentSchema,
  SelectConversationSchema,
  SelectOrganizationSchema,
  SuggestedPromptInputSchema,
  UuidIdSchema,
} from "@/types";
import {
  getAgentCredentialReadinessForUser,
  getAgentDefaultSuggestedPrompts,
  getChatRosterBootstrap,
  getReadableAgent,
} from "./agent";
import {
  AgentDelegationTargetSchema,
  getAgentDelegationsForUser,
  getAgentToolsForUser,
} from "./agent-tool";
import { readConversationForRequest } from "./chat/routes";
import {
  ConfigResponseSchema,
  getConfigResponse,
  getPublicConfigResponse,
  PublicConfigResponseSchema,
} from "./config";
import {
  getAvailableLlmProviderApiKeys,
  getVisibleLlmProviderApiKeys,
} from "./llm-provider-api-keys";
import { getAvailableLlmModels, LlmModelSchema } from "./llm-provider-models";

/** The new-chat composer's parts; see `/api/bootstrap/new-chat`. */
const NewChatBootstrapSchema = z.object({
  /** `GET /api/agents/chat-roster?bootstrap=true` */
  roster: z.array(ChatAgentRosterSchema),
  /** `GET /api/llm-provider-api-keys` */
  apiKeys: z.array(LlmProviderApiKeyWithScopeInfoSchema),
  /** `GET /api/llm-provider-api-keys/available`, null for a caller that endpoint refuses */
  availableApiKeys: z.array(LlmProviderApiKeyWithScopeInfoSchema).nullable(),
  /** `GET /api/llm-models/available` */
  models: z.array(LlmModelSchema),
  agent: z
    .object({
      id: z.string().uuid(),
      /** `GET /api/agents/:id` */
      detail: SelectAgentSchema,
      /** `GET /api/agents/:id/delegations` */
      delegations: z.array(AgentDelegationTargetSchema),
      /** `GET /api/agents/credential-readiness?ids=:id` */
      credentialReadiness: z.array(AgentCredentialReadinessSchema),
      /** `GET /api/agents/:id/tools?catalogId=<Playwright catalog>` */
      browserTools: z.array(AssignedToolSchema),
      /** `GET /api/agents/:id/default-suggested-prompts`, only when the agent has no prompts of its own */
      defaultSuggestedPrompts: z.array(SuggestedPromptInputSchema).nullable(),
      /** `GET /api/llm-models/available?apiKeyId=:llmApiKeyId`, only when the agent has a key */
      keyModels: z.array(LlmModelSchema).nullable(),
    })
    .nullable(),
  /**
   * `GET /api/llm-models/available?apiKeyId=:chatApiKeyId` for the
   * member's saved default key, when it is set and is not the
   * starting agent's key: the composer then picks its model from
   * that key's list.
   */
  memberDefaultKeyModels: z
    .object({
      apiKeyId: z.string().uuid(),
      models: z.array(LlmModelSchema),
    })
    .nullable(),
});

/** How many of its last messages a seeded conversation document carries. */
const CONVERSATION_SEED_TAIL = 30;

/**
 * The reads the app shell needs before it can draw a page, in one round trip.
 * The frontend fires this alongside the session check on a cold load and
 * seeds each part into the query its own endpoint feeds, so the shell skips a
 * second wave of requests. Each part is exactly what its own endpoint returns
 * (`/api/user/permissions`, `/api/resource-permissions`, `/api/organization`,
 * `/api/config`, `/api/config/public`, `/api/organization/appearance-settings`,
 * `/api/members/default-agent`, `/api/members/default-model`).
 */
const bootstrapRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/bootstrap",
    {
      schema: {
        operationId: RouteId.GetBootstrap,
        description:
          "Get the signed-in user's permissions, organization, platform config, appearance settings, and chat defaults in one request",
        tags: ["Config"],
        response: constructResponseSchema(
          z.object({
            permissions: PermissionsSchema,
            scopedCapabilities: z.array(
              z.object({
                organizationId: z.string(),
                resource: ManagedResourceSchema,
                scope: ResourcePermissionScopeSchema,
                action: ResourcePermissionActionSchema,
              }),
            ),
            organization: SelectOrganizationSchema.nullable(),
            config: ConfigResponseSchema,
            publicConfig: PublicConfigResponseSchema,
            appearance: AppearanceSettingsSchema,
            memberDefaultAgent: z.object({
              defaultAgentId: z.string().uuid().nullable(),
              personalChatAgentId: z.string().uuid().nullable(),
            }),
            memberDefaultModel: z.object({
              modelId: z.string().uuid().nullable(),
              chatApiKeyId: z.string().uuid().nullable(),
            }),
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const [
        permissions,
        scopedCapabilities,
        organization,
        publicConfig,
        appearance,
        defaultAgentId,
        personalChatAgentId,
        memberDefaultModel,
      ] = await Promise.all([
        getUserPermissions({ userId: user.id, organizationId }),
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        ResourcePermissions.resolveAll({
          userId: user.id,
          organizationId,
        }).then(withoutWildcardCoveredGrants),
        // SPDX-SnippetEnd
        OrganizationModel.getById(organizationId),
        getPublicConfigResponse(),
        OrganizationModel.getAppearanceSettings(),
        MemberModel.getDefaultAgentId(user.id, organizationId),
        // A lookup only: reading the defaults must never seed an assistant.
        AgentModel.findPersonalChatAgentId({
          userId: user.id,
          organizationId,
        }),
        MemberModel.getDefaultModelSelection(user.id, organizationId),
      ]);

      return reply.send({
        permissions,
        scopedCapabilities,
        organization: organization ?? null,
        config: getConfigResponse(),
        publicConfig,
        appearance,
        memberDefaultAgent: { defaultAgentId, personalChatAgentId },
        memberDefaultModel,
      });
    },
  );

  /**
   * What the new-chat composer reads before it can send, in one round trip.
   * The frontend server reads this for a full load of `/chat` and seeds each
   * part into the query its own endpoint feeds, so the browser starts with
   * the composer ready. Each part is exactly what its own endpoint returns.
   * The agent is the one a new chat starts on, resolved as the composer does
   * from what the server knows: the member's default, then the
   * organization's default, then the first personal agent, then the first
   * agent. A browser that picks another agent (a saved pick when neither
   * default is set) loads that agent's parts itself.
   */
  fastify.get(
    "/api/bootstrap/new-chat",
    {
      schema: {
        operationId: RouteId.GetNewChatBootstrap,
        description:
          "Get the new-chat composer's agents, provider keys, models, and the starting agent's details in one request",
        tags: ["Config"],
        response: constructResponseSchema(NewChatBootstrapSchema),
      },
    },
    async ({ user, organizationId }, reply) => {
      return reply.send(
        await getNewChatComposer({ userId: user.id, organizationId }),
      );
    },
  );

  /**
   * An existing conversation's first screen in one round trip: its end (the
   * same as `GET /api/chat/conversations/:id?tail=30`) and the composer's
   * parts for the conversation's agent (the same as the new-chat bootstrap's,
   * with that agent as the starting one). The frontend server reads this for
   * a full load of `/chat/<id>`, so the HTML carries the last messages and a
   * ready composer; the rest of the history loads after paint.
   */
  fastify.get(
    "/api/bootstrap/conversation/:id",
    {
      schema: {
        operationId: RouteId.GetConversationBootstrap,
        description:
          "Get the end of a conversation and its composer's agent, keys and models in one request",
        tags: ["Config"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          z.object({
            /** `GET /api/chat/conversations/:id?tail=30` */
            conversation: SelectConversationSchema,
            /** The new-chat bootstrap with the conversation's agent */
            composer: NewChatBootstrapSchema,
          }),
        ),
      },
    },
    async (request, reply) => {
      const conversation = await readConversationForRequest({
        request,
        id: request.params.id,
        tail: CONVERSATION_SEED_TAIL,
      });
      // A deleted agent comes back as null.
      const agent = conversation.agent
        ? {
            id: conversation.agent.id,
            llmApiKeyId: conversation.agent.llmApiKeyId,
          }
        : null;
      return reply.send({
        conversation,
        composer: await getNewChatComposer({
          userId: request.user.id,
          organizationId: request.organizationId,
          agent,
        }),
      });
    },
  );
};

export default bootstrapRoutes;

// ===

/**
 * The new-chat composer's parts (see `/api/bootstrap/new-chat`). With `agent`,
 * that agent's parts instead of the starting agent the member's and the
 * organization's defaults choose; an agent the caller cannot read leaves the
 * agent part empty.
 */
async function getNewChatComposer(params: {
  userId: string;
  organizationId: string;
  agent?: { id: string; llmApiKeyId: string | null } | null;
}) {
  const { userId, organizationId } = params;
  const [
    roster,
    apiKeys,
    availableApiKeys,
    models,
    memberDefaultAgentId,
    organization,
    memberDefaultModel,
  ] = await Promise.all([
    getChatRosterBootstrap({ userId, organizationId }),
    getVisibleLlmProviderApiKeys({ query: {}, userId, organizationId }),
    // Read with the other parts, and only for a caller its own endpoint
    // would answer.
    canCallEndpoint({
      routeId: RouteId.GetAvailableLlmProviderApiKeys,
      userId,
      organizationId,
    }).then((allowed) =>
      allowed
        ? getAvailableLlmProviderApiKeys({
            query: {},
            userId,
            organizationId,
          })
        : null,
    ),
    getAvailableLlmModels({ query: {}, userId, organizationId }),
    MemberModel.getDefaultAgentId(userId, organizationId),
    OrganizationModel.getById(organizationId),
    MemberModel.getDefaultModelSelection(userId, organizationId),
  ]);

  const candidates = roster.filter((agent) => !agent.builtIn);
  const byId = (id: string | null | undefined) =>
    id ? candidates.find((agent) => agent.id === id) : undefined;
  const startingAgent =
    params.agent !== undefined
      ? (params.agent ?? undefined)
      : (byId(memberDefaultAgentId) ??
        byId(organization?.defaultAgentId) ??
        candidates.find((agent) => agent.scope === "personal") ??
        candidates[0]);

  const memberKeyId = memberDefaultModel.chatApiKeyId;
  const [agent, memberDefaultKeyModels] = await Promise.all([
    startingAgent
      ? getNewChatAgentParts({
          agentId: startingAgent.id,
          llmApiKeyId: startingAgent.llmApiKeyId,
          userId,
          organizationId,
        }).catch((error) => {
          // A given agent the caller cannot read (a shared chat's agent)
          // leaves the part empty; its endpoints refuse the caller too.
          if (
            params.agent &&
            error instanceof ApiError &&
            error.statusCode === 404
          ) {
            return null;
          }
          throw error;
        })
      : null,
    memberKeyId && memberKeyId !== startingAgent?.llmApiKeyId
      ? getAvailableLlmModels({
          query: { apiKeyId: memberKeyId },
          userId,
          organizationId,
        }).then((keyModels) => ({
          apiKeyId: memberKeyId,
          models: keyModels,
        }))
      : null,
  ]);

  return {
    roster,
    apiKeys,
    availableApiKeys,
    models,
    agent,
    memberDefaultKeyModels,
  };
}

/**
 * Whether the caller holds every permission an endpoint's route check asks
 * for, so a bundled part is left out exactly when its own endpoint would
 * refuse the caller. One read of the caller's permissions answers for the
 * whole map, however many resources and actions it lists.
 */
async function canCallEndpoint(params: {
  routeId: keyof typeof requiredEndpointPermissionsMap;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const required = requiredEndpointPermissionsMap[params.routeId] ?? {};
  const granted = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  return Object.entries(required).every(([resource, actions]) =>
    (actions ?? []).every((action) =>
      isPermissionActionGranted({
        resource: resource as GrantCheck["resource"],
        grantedActions: granted[resource as keyof typeof granted] ?? [],
        requiredAction: action as GrantCheck["requiredAction"],
      }),
    ),
  );
}

type GrantCheck = Parameters<typeof isPermissionActionGranted>[0];

async function getNewChatAgentParts(params: {
  agentId: string;
  llmApiKeyId: string | null;
  userId: string;
  organizationId: string;
}) {
  const { agentId, llmApiKeyId, userId, organizationId } = params;
  const [
    detail,
    delegations,
    credentialReadiness,
    browserTools,
    keyModels,
    platformPrompts,
  ] = await Promise.all([
    getReadableAgent({ id: agentId, userId, organizationId }),
    getAgentDelegationsForUser({ agentId, userId, organizationId }),
    getAgentCredentialReadinessForUser({
      ids: [agentId],
      userId,
      organizationId,
    }),
    getAgentToolsForUser({
      agentId,
      catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
      userId,
      organizationId,
    }),
    llmApiKeyId
      ? getAvailableLlmModels({
          query: { apiKeyId: llmApiKeyId },
          userId,
          organizationId,
        })
      : null,
    getAgentDefaultSuggestedPrompts({ id: agentId, userId, organizationId }),
  ]);
  // The composer asks for the platform's prompts only for an agent without
  // its own: they are read with the other parts and kept in that case alone.
  const defaultSuggestedPrompts =
    detail.suggestedPrompts.length === 0 ? platformPrompts : null;
  return {
    id: agentId,
    detail,
    delegations,
    credentialReadiness,
    browserTools,
    defaultSuggestedPrompts,
    keyModels,
  };
}
