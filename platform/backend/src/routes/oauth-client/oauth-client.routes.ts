import { randomUUID } from "node:crypto";
import {
  createPaginatedResponseSchema,
  credentialRequiresPerUserScope,
  PaginationQuerySchema,
  parseLabelsParam,
  perUserCredentialLabel,
  providerRequiresPerUserCredential,
  ResourceAccessQuerySchema,
  ResourceOwnerQuerySchema,
  ResourcePermissionGrantSchema,
  ResourceSharedWithQuerySchema,
  RouteId,
  SupportedProvidersSchema,
} from "@archestra/shared";
import {
  A2A_OAUTH_SCOPE,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
  OAuthClientScopeSchema,
} from "@archestra/shared/oauth";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOauthClientAccess } from "@/auth/oauth-client-permissions";
import {
  LlmProviderApiKeyModel,
  ManagedOauthClientModel,
  OauthClientLabelModel,
} from "@/models";
import AgentModel from "@/models/agent";
import ResourcePermissionSubjectModel from "@/models/resource-permission-subject";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { credentialBilling } from "@/services/credential-billing";
import { validateOauthServiceAccountBinding } from "@/services/oauth-service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  CredentialSpendCapInputSchema,
  constructResponseSchema,
  LabelWithDetailsSchema,
  LlmOauthClientGrantTypeSchema,
  ManagedOauthClientSchema,
  ManagedOauthClientWithSecretSchema,
} from "@/types";
import { assertValidProviderKeyMappings } from "@/utils/provider-key-mappings";
import {
  BulkDeleteBodySchema,
  BulkOutcomeSchema,
  runBulk,
} from "../bulk-route";
import { registerEntityLabelRoutes } from "../entity-labels";

const LlmOauthClientProviderKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
  providerApiKeyId: z.string().uuid(),
});

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: a shared application credential scoped to the
 *   organization; requires selected `providerApiKeys` or current-and-future
 *   provider access when LLM Proxy is enabled. `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`; its tokens are user-bound, so
 *   the proxy resolves the acting user's own provider keys, cost limits, and
 *   policies. `providerApiKeys` never apply — the acting user's own keys
 *   resolve at call time.
 *
 * Who can see and manage the client is its grants, edited on its Permissions
 * tab; they never change what its tokens can reach.
 */
const OauthClientFields = z
  .object({
    name: z.string().min(1).max(256),
    serviceAccountId: z.string().uuid().nullable().optional(),
    scopes: z
      .array(OAuthClientScopeSchema)
      .min(1)
      .max(3)
      .refine(
        (scopes) => new Set(scopes).size === scopes.length,
        "Duplicate scopes are not allowed",
      ),
    allowedGatewayIds: z.array(z.string().uuid()).optional(),
    grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
    providerApiKeys: z.array(LlmOauthClientProviderKeyBodySchema).optional(),
    includeFutureProviders: z
      .boolean()
      .optional()
      .describe(
        "Use current and future shared primary provider keys, with selected keys as overrides. " +
          "Defaults to false on creation; omit on update to preserve the mode. " +
          "Only valid for client_credentials with LLM Proxy access.",
      ),
    redirectUris: z.array(z.string().url()).optional(),
    labels: z
      .array(LabelWithDetailsSchema)
      .optional()
      .describe(
        "Key/value labels. Omit to leave existing labels untouched; pass [] " +
          "to clear them.",
      ),
    billingTeamId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Team a client_credentials client's spend is charged to. Omit to " +
          "keep it; null stops billing a team. Signed-in users of an " +
          "authorization_code client pay for themselves.",
      ),
    spendCap: CredentialSpendCapInputSchema.nullable()
      .optional()
      .describe(
        "Spend cap for the whole client, stored as a token_cost limit on it. " +
          "Omit to keep it; null removes it.",
      ),
  })
  .strict();

const validateOauthClientBody = (
  value: z.infer<typeof OauthClientFields>,
  ctx: z.RefinementCtx,
) => {
  if (
    value.includeFutureProviders &&
    (value.grantType !== "client_credentials" ||
      !value.scopes.includes(LLM_PROXY_OAUTH_SCOPE))
  )
    ctx.addIssue({
      code: "custom",
      path: ["includeFutureProviders"],
      message:
        "Current and future providers require a client_credentials client with LLM Proxy access.",
    });
  if (value.grantType === "authorization_code") {
    if (value.serviceAccountId)
      ctx.addIssue({
        code: "custom",
        path: ["serviceAccountId"],
        message:
          "Only client_credentials clients can act as a service account.",
      });
    if (!value.redirectUris || value.redirectUris.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["redirectUris"],
        message:
          "At least one redirect URI is required for authorization_code clients",
      });
    }
    if (value.billingTeamId) {
      ctx.addIssue({
        code: "custom",
        path: ["billingTeamId"],
        message:
          "authorization_code clients cannot bill a team: each signed-in user pays for their own usage",
      });
    }
    return;
  }
  if (
    value.scopes.some(
      (scope) => scope === MCP_GATEWAY_OAUTH_SCOPE || scope === A2A_OAUTH_SCOPE,
    ) &&
    !value.allowedGatewayIds?.length
  )
    ctx.addIssue({
      code: "custom",
      path: ["allowedGatewayIds"],
      message: "Select at least one gateway or agent",
    });
  if (
    value.scopes.includes(LLM_PROXY_OAUTH_SCOPE) &&
    !value.includeFutureProviders &&
    (!value.providerApiKeys || value.providerApiKeys.length === 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["providerApiKeys"],
      message:
        "At least one provider API key is required for client_credentials clients",
    });
  }
};

const CreateOauthClientBodySchema = OauthClientFields.extend({
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  initialGrants: z
    .array(ResourcePermissionGrantSchema)
    .max(200)
    .optional()
    .describe(
      "Who else starts with access, beside the creator who always gets full access.",
    ),
  // SPDX-SnippetEnd
}).superRefine(validateOauthClientBody);
// Validate the merged configuration after loading the client: omitted access
// fields preserve its mode and explicit mappings.
const UpdateOauthClientBodySchema = OauthClientFields;

const oauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/oauth-clients",
    tag: "OAuth Clients",
    entityNamePlural: "OAuth clients",
    model: OauthClientLabelModel,
    keysOperationId: RouteId.GetOauthClientLabelKeys,
    valuesOperationId: RouteId.GetOauthClientLabelValues,
  });

  fastify.get(
    "/api/oauth-clients",
    {
      schema: {
        operationId: RouteId.GetOauthClients,
        description:
          "List managed OAuth clients and their enabled API capabilities",
        tags: ["OAuth Clients"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().trim().min(1).optional(),
          capability: OAuthClientScopeSchema.optional().describe(
            "Include clients that grant this API capability, including clients with other capabilities.",
          ),
          providerApiKeyId: z.string().uuid().optional(),
          grantType: LlmOauthClientGrantTypeSchema.optional(),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
          access: ResourceAccessQuerySchema,
          sharedWith: ResourceSharedWithQuerySchema,
          owner: ResourceOwnerQuerySchema,
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(ManagedOauthClientSchema),
        ),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const result = await ManagedOauthClientModel.findPageByOrganization({
        organizationId,
        pagination: { limit: query.limit, offset: query.offset },
        search: query.search,
        capabilities: query.capability ? [query.capability] : undefined,
        providerApiKeyId: query.providerApiKeyId,
        grantType: query.grantType,
        labels: parseLabelsParam(query.labels),
        viewer: { userId: user.id },
        access: await ResourcePermissionSubjectModel.resolveAccessFilter({
          userId: user.id,
          organizationId,
          relations: query.access,
          sharedWith: query.sharedWith,
          ownerIds: query.owner,
        }),
      });
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/oauth-clients",
    {
      schema: {
        operationId: RouteId.CreateOauthClient,
        description: "Create an OAuth client and return its client secret once",
        tags: ["OAuth Clients"],
        body: CreateOauthClientBodySchema,
        response: constructResponseSchema(ManagedOauthClientWithSecretSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (body.includeFutureProviders) {
        await ResourcePermissions.require({
          organizationId,
          userId: user.id,
          resource: "llmProviderApiKey",
          scope: "*",
          action: "use",
        });
      }
      // SPDX-SnippetEnd
      if (body.initialGrants?.length) {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId: user.id,
          resource: "oauthClient",
          grants: body.initialGrants,
          target: {
            id: randomUUID(),
            name: body.name,
            authorId: user.id,
          },
        });
        // SPDX-SnippetEnd
      }

      await validateGatewayConfig({
        organizationId,
        scopes: body.scopes,
        ids: body.allowedGatewayIds ?? [],
      });
      await validateLlmOauthClientConfig({
        organizationId,
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      await credentialBilling.assertCanSetBillingTeam({
        organizationId,
        userId: user.id,
        teamId: body.billingTeamId,
      });
      const serviceAccountId = await validateOauthServiceAccountBinding({
        ...body,
        organizationId,
        userId: user.id,
        creating: true,
      });
      const created = await ManagedOauthClientModel.create({
        organizationId,
        name: body.name,
        serviceAccountId,
        grantType: body.grantType,
        scopes: body.scopes,
        allowedGatewayIds: body.allowedGatewayIds,
        providerApiKeys: body.providerApiKeys,
        includeFutureProviders: body.includeFutureProviders,
        redirectUris: body.redirectUris,
        authorId: user.id,
        initialGrants: body.initialGrants,
        billingTeamId: body.billingTeamId,
      });
      if (body.labels?.length) {
        await OauthClientLabelModel.syncLabels(
          created.oauthClient.id,
          body.labels,
        );
      }
      await credentialBilling.applySpendCap({
        entityType: "llm_oauth_client",
        entityId: created.oauthClient.id,
        cap: body.spendCap,
      });
      const oauthClient = await ManagedOauthClientModel.findById({
        id: created.oauthClient.id,
        organizationId,
      });
      if (!oauthClient) {
        throw new ApiError(500, "OAuth client disappeared after creation");
      }
      return reply.send({ ...oauthClient, clientSecret: created.clientSecret });
    },
  );

  fastify.put(
    "/api/oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.UpdateOauthClient,
        description: "Update an OAuth client",
        tags: ["OAuth Clients"],
        params: z.object({ id: z.string() }),
        body: UpdateOauthClientBodySchema,
        response: constructResponseSchema(ManagedOauthClientSchema),
      },
    },
    async ({ params, body, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "oauthClient",
        id: params.id,
        action: "update",
      });

      const existing = await ManagedOauthClientModel.findById({
        id: params.id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "OAuth client not found");
      }
      if (body.grantType !== existing.grantType)
        throw new ApiError(400, "The sign-in mode cannot be changed");
      const config = OauthClientFields.superRefine(
        validateOauthClientBody,
      ).safeParse({
        ...body,
        includeFutureProviders:
          body.includeFutureProviders ?? existing.includeFutureProviders,
        providerApiKeys:
          body.providerApiKeys ??
          existing.providerApiKeys.map(({ provider, providerApiKeyId }) => ({
            provider,
            providerApiKeyId,
          })),
        allowedGatewayIds: body.allowedGatewayIds ?? existing.allowedGatewayIds,
        redirectUris: body.redirectUris ?? existing.redirectUris,
      });
      if (!config.success)
        throw new ApiError(
          400,
          config.error.issues.map((issue) => issue.message).join("; "),
        );
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (body.includeFutureProviders && !existing.includeFutureProviders) {
        await ResourcePermissions.require({
          organizationId,
          userId: user.id,
          resource: "llmProviderApiKey",
          scope: "*",
          action: "use",
        });
      }
      // SPDX-SnippetEnd
      await validateGatewayConfig({
        organizationId,
        scopes: body.scopes,
        ids: body.allowedGatewayIds ?? existing.allowedGatewayIds,
      });
      await validateLlmOauthClientConfig({
        organizationId,
        providerApiKeys:
          existing.grantType === "client_credentials"
            ? (body.providerApiKeys ?? existing.providerApiKeys)
            : [],
      });
      await credentialBilling.assertCanSetBillingTeam({
        organizationId,
        userId: user.id,
        teamId: body.billingTeamId,
        currentTeamId: existing.billingTeamId,
      });
      await credentialBilling.assertCanSetSpendCap({
        organizationId,
        userId: user.id,
        cap: body.spendCap,
        current: existing.spendCap,
      });
      const serviceAccountId = await validateOauthServiceAccountBinding({
        ...body,
        organizationId,
        userId: user.id,
      });
      const updated = await ManagedOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        serviceAccountId,
        scopes: body.scopes,
        allowedGatewayIds: body.allowedGatewayIds,
        providerApiKeys: body.providerApiKeys,
        includeFutureProviders: body.includeFutureProviders,
        redirectUris: body.redirectUris,
        billingTeamId: body.billingTeamId,
      });
      if (!updated) {
        throw new ApiError(404, "OAuth client not found");
      }
      await credentialBilling.applySpendCap({
        entityType: "llm_oauth_client",
        entityId: params.id,
        cap: body.spendCap,
      });
      const oauthClient =
        body.spendCap === undefined
          ? updated
          : ((await ManagedOauthClientModel.findById({
              id: params.id,
              organizationId,
            })) ?? updated);
      // Only touch labels when the caller sent them, so an update that omits
      // the field leaves existing labels alone.
      if (body.labels !== undefined) {
        await OauthClientLabelModel.syncLabels(params.id, body.labels);
        return reply.send({
          ...oauthClient,
          labels: await OauthClientLabelModel.getLabelsFor(params.id),
        });
      }
      return reply.send(oauthClient);
    },
  );

  fastify.post(
    "/api/oauth-clients/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateOauthClientSecret,
        description: "Rotate an OAuth client's client secret",
        tags: ["OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(ManagedOauthClientWithSecretSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "oauthClient",
        id: params.id,
        action: "update",
      });
      const result = await ManagedOauthClientModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "OAuth client not found");
      }
      return reply.send({
        ...result.oauthClient,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.DeleteOauthClient,
        description: "Delete an OAuth client",
        tags: ["OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "oauthClient",
        id: params.id,
        action: "delete",
      });
      const success = await ManagedOauthClientModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "OAuth client not found");
      }
      return reply.send({ success });
    },
  );

  fastify.delete(
    "/api/oauth-clients/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteOauthClients,
        description:
          "Delete several OAuth clients in one request. Each id is " +
          "authorized exactly as the single-client delete authorizes its " +
          "own, so a client the caller cannot see or manage is reported in " +
          "`failed` while the rest of the batch still applies.",
        tags: ["OAuth Clients"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;

      const snapshot = async (ids: string[]) => {
        const clients = await ManagedOauthClientModel.findByIds({
          ids,
          organizationId,
        });
        return {
          oauthClients: clients
            .map(({ id, name }) => ({ id, name }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "OAuth clients bulk delete",
        notFoundMessage: "OAuth client not found",
        unexpectedMessage: "Could not delete this OAuth client",
        load: async (ids) =>
          new Map(
            (
              await ManagedOauthClientModel.findByIds({
                ids,
                organizationId,
                viewer: { userId: user.id },
              })
            ).map((client) => [client.id, client]),
          ),
        describe: (client) => client.name,
        authorize: async (client) => {
          await requireOauthClientAccess({
            organizationId,
            userId: user.id,
            resource: "oauthClient",
            id: client.id,
            action: "delete",
          });
        },
        applyEach: async (_client, id) => {
          const deleted = await ManagedOauthClientModel.delete({
            id,
            organizationId,
          });
          if (!deleted) {
            throw new ApiError(404, "OAuth client not found");
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );
};

export default oauthClientsRoutes;

async function validateLlmOauthClientConfig(params: {
  organizationId: string;
  providerApiKeys: Array<{
    provider: z.infer<typeof SupportedProvidersSchema>;
    providerApiKeyId: string;
  }>;
}) {
  assertValidProviderKeyMappings(params.providerApiKeys);

  for (const mapping of params.providerApiKeys) {
    const apiKey = await LlmProviderApiKeyModel.findById(
      mapping.providerApiKeyId,
    );
    if (!apiKey || apiKey.organizationId !== params.organizationId) {
      throw new ApiError(404, "LLM provider API key not found");
    }
    if (apiKey.provider !== mapping.provider) {
      throw new ApiError(
        400,
        `Provider API key "${apiKey.name}" is for ${apiKey.provider}, not ${mapping.provider}`,
      );
    }
    // OAuth client credentials are a shared service credential with no acting
    // user. Resolve credential-level markers as well as provider-level cases:
    // OpenAI/xAI may contain either a normal API key or one person's subscription.
    const secret =
      apiKey.secretId && !providerRequiresPerUserCredential(mapping.provider)
        ? ((await getSecretValueForLlmProviderApiKey(apiKey.secretId)) as
            | string
            | undefined)
        : undefined;
    if (
      credentialRequiresPerUserScope({
        provider: mapping.provider,
        apiKey: secret,
      })
    ) {
      throw new ApiError(
        400,
        `${perUserCredentialLabel({ provider: mapping.provider, apiKey: secret })} is per-user and cannot be mapped to an OAuth client; each user connects their own account.`,
      );
    }
  }
}

async function validateGatewayConfig(params: {
  organizationId: string;
  scopes: Array<"mcp" | "a2a" | "llm:proxy">;
  ids: string[];
}) {
  for (const id of params.ids) {
    const agent = await AgentModel.findById(id);
    if (
      !agent ||
      agent.organizationId !== params.organizationId ||
      (agent.agentType !== "mcp_gateway" && agent.agentType !== "agent")
    )
      throw new ApiError(404, "Gateway or agent not found");
    if (
      (agent.agentType === "mcp_gateway" &&
        !params.scopes.includes(MCP_GATEWAY_OAUTH_SCOPE)) ||
      (agent.agentType === "agent" &&
        !params.scopes.includes(A2A_OAUTH_SCOPE) &&
        !params.scopes.includes(MCP_GATEWAY_OAUTH_SCOPE))
    )
      throw new ApiError(
        400,
        "Enable the scope for every selected gateway or agent",
      );
  }
}
