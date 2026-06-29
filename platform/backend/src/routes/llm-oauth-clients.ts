import {
  providerRequiresPerUserCredential,
  RouteId,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  LlmOauthClientGrantTypeSchema,
  LlmOauthClientSchema,
  LlmOauthClientWithSecretSchema,
} from "@/types";

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
 */
const LlmOauthClientBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
    allowedLlmProxyIds: z.array(z.string().uuid()).optional(),
    providerApiKeys: z.array(LlmOauthClientProviderKeyBodySchema).optional(),
    redirectUris: z.array(z.string().url()).optional(),
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
    async ({ organizationId, query }, reply) => {
      const oauthClients = await LlmOauthClientModel.findAllByOrganization({
        organizationId,
        search: query.search,
        providerApiKeyId: query.providerApiKeyId,
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
    async ({ body, organizationId }, reply) => {
      await validateLlmOauthClientConfig({
        organizationId,
        allowedLlmProxyIds: body.allowedLlmProxyIds ?? [],
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
        organizationId,
        name: body.name,
        grantType: body.grantType,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        providerApiKeys: body.providerApiKeys,
        redirectUris: body.redirectUris,
      });
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
    async ({ params, body, organizationId }, reply) => {
      await validateLlmOauthClientConfig({
        organizationId,
        allowedLlmProxyIds: body.allowedLlmProxyIds ?? [],
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const oauthClient = await LlmOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        providerApiKeys: body.providerApiKeys,
        redirectUris: body.redirectUris,
      });
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
    async ({ params, organizationId }, reply) => {
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
    async ({ params, organizationId }, reply) => {
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
