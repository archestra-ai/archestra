import {
  providerRequiresPerUserCredential,
  ResourceVisibilityScopeSchema,
  RouteId,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  assertOauthClientTeams,
  authorizeOauthClientCreateScope,
  getOauthClientPermissionChecker,
  type OauthClientPermissionChecker,
  requireOauthClientModifyPermission,
  resolveOauthClientScopeUpdate,
  withOauthClientTeamFkErrorMapped,
} from "@/auth/oauth-client-permissions";
import {
  AgentModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  TeamModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  LlmOauthClientGrantTypeSchema,
  LlmOauthClientSchema,
  LlmOauthClientWithSecretSchema,
} from "@/types";
import type { LlmOauthClient } from "@/types/llm-oauth-client";

const LlmOauthClientProviderKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
  providerApiKeyId: z.string().uuid(),
});

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: requires `allowedLlmProxyIds` (the sole authority) and
 *   `providerApiKeys`; `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`. `allowedLlmProxyIds` is optional
 *   here and acts as an additive, admin-controlled grant (users who authenticate
 *   through the client may reach those proxies on top of their own RBAC).
 *   `providerApiKeys` never apply — the acting user's own keys resolve at call
 *   time.
 *
 * `scope`/`teams` control who can see and manage the client (3-tier visibility
 * like agents), not what its tokens can reach at runtime. Create defaults to
 * `personal`; on update, omitted values leave the current scope/teams untouched.
 */
const LlmOauthClientBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
    allowedLlmProxyIds: z.array(z.string().uuid()).optional(),
    providerApiKeys: z.array(LlmOauthClientProviderKeyBodySchema).optional(),
    redirectUris: z.array(z.string().url()).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teams: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.grantType === "authorization_code") {
      if (!value.redirectUris || value.redirectUris.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["redirectUris"],
          message:
            "At least one redirect URI is required for authorization_code clients",
        });
      }
      return;
    }
    if (!value.allowedLlmProxyIds || value.allowedLlmProxyIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedLlmProxyIds"],
        message:
          "At least one LLM proxy is required for client_credentials clients",
      });
    }
    if (!value.providerApiKeys || value.providerApiKeys.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["providerApiKeys"],
        message:
          "At least one provider API key is required for client_credentials clients",
      });
    }
  });

const CreateLlmOauthClientBodySchema = LlmOauthClientBodySchema;
const UpdateLlmOauthClientBodySchema = LlmOauthClientBodySchema;

const llmOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetLlmOauthClients,
        description: "List LLM OAuth clients that can access LLM proxies",
        tags: ["LLM OAuth Clients"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
          providerApiKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(z.array(LlmOauthClientSchema)),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const checker = await getOauthClientPermissionChecker({
        userId: user.id,
        organizationId,
        resource: "llmOauthClient",
      });
      const oauthClients = await LlmOauthClientModel.findAllByOrganization({
        organizationId,
        search: query.search,
        providerApiKeyId: query.providerApiKeyId,
        viewer: { userId: user.id, isAdmin: checker.isAdmin },
      });
      return reply.send(oauthClients);
    },
  );

  fastify.post(
    "/api/llm-oauth-clients",
    {
      schema: {
        operationId: RouteId.CreateLlmOauthClient,
        description:
          "Create an LLM OAuth client and return its client secret once",
        tags: ["LLM OAuth Clients"],
        body: CreateLlmOauthClientBodySchema,
        response: constructResponseSchema(LlmOauthClientWithSecretSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const checker = await getOauthClientPermissionChecker({
        userId: user.id,
        organizationId,
        resource: "llmOauthClient",
      });
      const scope = body.scope ?? "personal";
      const requestedTeams = body.teams ?? [];
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      authorizeOauthClientCreateScope({
        checker,
        scope,
        teamIds: requestedTeams,
        userTeamIds,
      });
      // Omit teams if scope is not 'team' — scope takes precedence
      const teams = scope === "team" ? requestedTeams : [];
      await assertOauthClientTeams({ scope, teamIds: teams, organizationId });

      await validateLlmOauthClientConfig({
        organizationId,
        allowedLlmProxyIds: body.allowedLlmProxyIds ?? [],
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const { oauthClient, clientSecret } =
        await withOauthClientTeamFkErrorMapped(() =>
          LlmOauthClientModel.create({
            organizationId,
            name: body.name,
            grantType: body.grantType,
            allowedLlmProxyIds: body.allowedLlmProxyIds,
            providerApiKeys: body.providerApiKeys,
            redirectUris: body.redirectUris,
            scope,
            teams,
            authorId: user.id,
          }),
        );
      return reply.send({ ...oauthClient, clientSecret });
    },
  );

  fastify.put(
    "/api/llm-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmOauthClient,
        description: "Update an LLM OAuth client",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        body: UpdateLlmOauthClientBodySchema,
        response: constructResponseSchema(LlmOauthClientSchema),
      },
    },
    async ({ params, body, user, organizationId }, reply) => {
      const { existing, checker, userTeamIds } =
        await authorizeLlmOauthClientModify({
          id: params.id,
          userId: user.id,
          organizationId,
        });

      const resolvedTeams = resolveOauthClientScopeUpdate({
        checker,
        existingScope: existing.scope,
        existingTeamIds: existing.teams.map((team) => team.id),
        requestedScope: body.scope,
        requestedTeamIds: body.teams,
        userTeamIds,
      });
      // Omit teams if the final scope is not 'team' — scope takes precedence
      const finalScope = body.scope ?? existing.scope;
      const teams =
        finalScope === "team"
          ? resolvedTeams
          : resolvedTeams !== undefined
            ? []
            : undefined;
      await assertOauthClientTeams({
        scope: finalScope,
        teamIds: teams ?? existing.teams.map((team) => team.id),
        organizationId,
      });

      await validateLlmOauthClientConfig({
        organizationId,
        allowedLlmProxyIds: body.allowedLlmProxyIds ?? [],
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const oauthClient = await withOauthClientTeamFkErrorMapped(() =>
        LlmOauthClientModel.update({
          id: params.id,
          organizationId,
          name: body.name,
          allowedLlmProxyIds: body.allowedLlmProxyIds,
          providerApiKeys: body.providerApiKeys,
          redirectUris: body.redirectUris,
          scope: body.scope,
          teams,
        }),
      );
      if (!oauthClient) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      return reply.send(oauthClient);
    },
  );

  fastify.post(
    "/api/llm-oauth-clients/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateLlmOauthClientSecret,
        description: "Rotate an LLM OAuth client's client secret",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(LlmOauthClientWithSecretSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await authorizeLlmOauthClientModify({
        id: params.id,
        userId: user.id,
        organizationId,
      });
      const result = await LlmOauthClientModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      return reply.send({
        ...result.oauthClient,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/llm-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmOauthClient,
        description: "Delete an LLM OAuth client",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await authorizeLlmOauthClientModify({
        id: params.id,
        userId: user.id,
        organizationId,
      });
      const success = await LlmOauthClientModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      return reply.send({ success });
    },
  );
};

export default llmOauthClientsRoutes;

/**
 * Load the client and enforce 3-tier scope authorization for
 * update/rotate-secret/delete. Returns the client plus the checker/team
 * context so update can run its scope-change validation without re-fetching.
 */
async function authorizeLlmOauthClientModify(params: {
  id: string;
  userId: string;
  organizationId: string;
}): Promise<{
  existing: LlmOauthClient;
  checker: OauthClientPermissionChecker;
  userTeamIds: string[];
}> {
  const existing = await LlmOauthClientModel.findById({
    id: params.id,
    organizationId: params.organizationId,
  });
  if (!existing) {
    throw new ApiError(404, "LLM OAuth client not found");
  }
  const checker = await getOauthClientPermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "llmOauthClient",
  });
  const userTeamIds = checker.isAdmin
    ? []
    : await TeamModel.getUserTeamIds(params.userId);
  requireOauthClientModifyPermission({
    checker,
    scope: existing.scope,
    authorId: existing.authorId,
    clientTeamIds: existing.teams.map((team) => team.id),
    userTeamIds,
    userId: params.userId,
  });
  return { existing, checker, userTeamIds };
}

async function validateLlmOauthClientConfig(params: {
  organizationId: string;
  allowedLlmProxyIds: string[];
  providerApiKeys: Array<{
    provider: z.infer<typeof SupportedProvidersSchema>;
    providerApiKeyId: string;
  }>;
}) {
  const seenProviders = new Set<string>();
  for (const mapping of params.providerApiKeys) {
    if (seenProviders.has(mapping.provider)) {
      throw new ApiError(
        400,
        `Only one provider API key can be mapped for provider "${mapping.provider}"`,
      );
    }
    seenProviders.add(mapping.provider);
  }

  for (const proxyId of params.allowedLlmProxyIds) {
    const agent = await AgentModel.findById(proxyId);
    if (
      !agent ||
      agent.organizationId !== params.organizationId ||
      agent.agentType !== "llm_proxy"
    ) {
      throw new ApiError(404, "LLM proxy not found");
    }
  }

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
    // user, so a per-user provider (GitHub Copilot) can't be mapped — its token
    // belongs to one person and would be served to every caller.
    if (providerRequiresPerUserCredential(mapping.provider)) {
      throw new ApiError(
        400,
        `${mapping.provider} is per-user and cannot be mapped to an OAuth client; each user connects their own account.`,
      );
    }
  }
}
