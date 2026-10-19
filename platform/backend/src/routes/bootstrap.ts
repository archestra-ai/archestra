import {
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
import { userHasPermission } from "@/auth";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ResourcePermissions } from "@/services/resource-permissions";
// SPDX-SnippetEnd
import { getUserPermissions } from "@/services/user";
import {
  AgentCredentialReadinessSchema,
  AppearanceSettingsSchema,
  AssignedToolSchema,
  ChatAgentRosterSchema,
  constructResponseSchema,
  LlmProviderApiKeyWithScopeInfoSchema,
  SelectAgentSchema,
  SelectOrganizationSchema,
  SuggestedPromptInputSchema,
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
        response: constructResponseSchema(
          z.object({
            /** `GET /api/agents/chat-roster?bootstrap=true` */
            roster: z.array(ChatAgentRosterSchema),
            /** `GET /api/llm-provider-api-keys` */
            apiKeys: z.array(LlmProviderApiKeyWithScopeInfoSchema),
            /** `GET /api/llm-provider-api-keys/available`, null for a caller that endpoint refuses */
            availableApiKeys: z
              .array(LlmProviderApiKeyWithScopeInfoSchema)
              .nullable(),
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
                defaultSuggestedPrompts: z
                  .array(SuggestedPromptInputSchema)
                  .nullable(),
                /** `GET /api/llm-models/available?apiKeyId=:llmApiKeyId`, only when the agent has a key */
                keyModels: z.array(LlmModelSchema).nullable(),
              })
              .nullable(),
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const userId = user.id;
      const [
        roster,
        apiKeys,
        canReadAvailableKeys,
        models,
        memberDefaultAgentId,
        organization,
      ] = await Promise.all([
        getChatRosterBootstrap({ userId, organizationId }),
        getVisibleLlmProviderApiKeys({ query: {}, userId, organizationId }),
        canCallEndpoint({
          routeId: RouteId.GetAvailableLlmProviderApiKeys,
          userId,
          organizationId,
        }),
        getAvailableLlmModels({ query: {}, userId, organizationId }),
        MemberModel.getDefaultAgentId(userId, organizationId),
        OrganizationModel.getById(organizationId),
      ]);
      const availableApiKeys = canReadAvailableKeys
        ? await getAvailableLlmProviderApiKeys({
            query: {},
            userId,
            organizationId,
          })
        : null;

      const candidates = roster.filter((agent) => !agent.builtIn);
      const byId = (id: string | null | undefined) =>
        id ? candidates.find((agent) => agent.id === id) : undefined;
      const startingAgent =
        byId(memberDefaultAgentId) ??
        byId(organization?.defaultAgentId) ??
        candidates.find((agent) => agent.scope === "personal") ??
        candidates[0];

      return reply.send({
        roster,
        apiKeys,
        availableApiKeys,
        models,
        agent: startingAgent
          ? await getNewChatAgentParts({
              agentId: startingAgent.id,
              llmApiKeyId: startingAgent.llmApiKeyId,
              userId,
              organizationId,
            })
          : null,
      });
    },
  );
};

export default bootstrapRoutes;

// ===

/**
 * Whether the caller holds every permission an endpoint's route check asks
 * for, so a bundled part is left out exactly when its own endpoint would
 * refuse the caller.
 */
async function canCallEndpoint(params: {
  routeId: keyof typeof requiredEndpointPermissionsMap;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const required = requiredEndpointPermissionsMap[params.routeId] ?? {};
  const checks = Object.entries(required).flatMap(([resource, actions]) =>
    (actions ?? []).map((action) =>
      userHasPermission(
        params.userId,
        params.organizationId,
        resource as Parameters<typeof userHasPermission>[2],
        action as Parameters<typeof userHasPermission>[3],
      ),
    ),
  );
  return (await Promise.all(checks)).every(Boolean);
}

async function getNewChatAgentParts(params: {
  agentId: string;
  llmApiKeyId: string | null;
  userId: string;
  organizationId: string;
}) {
  const { agentId, llmApiKeyId, userId, organizationId } = params;
  const [detail, delegations, credentialReadiness, browserTools, keyModels] =
    await Promise.all([
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
    ]);
  // The composer asks for the platform's prompts only for an agent without
  // its own, so they are read in that case alone.
  const defaultSuggestedPrompts =
    detail.suggestedPrompts.length === 0
      ? await getAgentDefaultSuggestedPrompts({
          id: agentId,
          userId,
          organizationId,
        })
      : null;
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
