import { RouteId, SupportedProvidersSchema } from "@shared";
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
  LlmOauthClientSchema,
  LlmOauthClientWithSecretSchema,
} from "@/types";

const LlmOauthClientProviderKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
  chatApiKeyId: z.string().uuid(),
});

const CreateLlmOauthClientBodySchema = z.object({
  name: z.string().min(1).max(256),
  chatApiKeyId: z.string().uuid().nullable().optional(),
  allowedLlmProxyIds: z.array(z.string().uuid()).min(1),
  modelRouterProviderApiKeys: z.array(LlmOauthClientProviderKeyBodySchema),
});

const UpdateLlmOauthClientBodySchema = CreateLlmOauthClientBodySchema;

const llmOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetLlmOauthClients,
        description: "List LLM OAuth clients that can access LLM proxies",
        tags: ["LLM OAuth Clients"],
        response: constructResponseSchema(z.array(LlmOauthClientSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      const oauthClients =
        await LlmOauthClientModel.findAllByOrganization(organizationId);
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
      await validateLlmOauthClientConfig({ ...body, organizationId });
      const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
        organizationId,
        name: body.name,
        chatApiKeyId: body.chatApiKeyId ?? null,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        modelRouterProviderApiKeys: body.modelRouterProviderApiKeys,
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
      await validateLlmOauthClientConfig({ ...body, organizationId });
      const oauthClient = await LlmOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        chatApiKeyId: body.chatApiKeyId ?? null,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        modelRouterProviderApiKeys: body.modelRouterProviderApiKeys,
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
  chatApiKeyId?: string | null;
  allowedLlmProxyIds: string[];
  modelRouterProviderApiKeys: Array<{
    provider: z.infer<typeof SupportedProvidersSchema>;
    chatApiKeyId: string;
  }>;
}) {
  if (!params.chatApiKeyId && params.modelRouterProviderApiKeys.length === 0) {
    throw new ApiError(
      400,
      "Provider API key is required unless Model Router provider keys are configured",
    );
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

  if (params.chatApiKeyId) {
    const apiKey = await LlmProviderApiKeyModel.findById(params.chatApiKeyId);
    if (!apiKey || apiKey.organizationId !== params.organizationId) {
      throw new ApiError(404, "LLM provider API key not found");
    }
  }

  for (const mapping of params.modelRouterProviderApiKeys) {
    const apiKey = await LlmProviderApiKeyModel.findById(mapping.chatApiKeyId);
    if (!apiKey || apiKey.organizationId !== params.organizationId) {
      throw new ApiError(404, "LLM provider API key not found");
    }
    if (apiKey.provider !== mapping.provider) {
      throw new ApiError(
        400,
        `Provider API key "${apiKey.name}" is for ${apiKey.provider}, not ${mapping.provider}`,
      );
    }
  }
}
