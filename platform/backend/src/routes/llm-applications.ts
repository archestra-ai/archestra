import { RouteId, SupportedProvidersSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentModel,
  LlmApplicationModel,
  LlmProviderApiKeyModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  LlmApplicationSchema,
  LlmApplicationWithSecretSchema,
} from "@/types";

const LlmApplicationProviderKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
  chatApiKeyId: z.string().uuid(),
});

const CreateLlmApplicationBodySchema = z.object({
  name: z.string().min(1).max(256),
  allowedLlmProxyIds: z.array(z.string().uuid()).min(1),
  modelRouterProviderApiKeys: z
    .array(LlmApplicationProviderKeyBodySchema)
    .min(1),
});

const UpdateLlmApplicationBodySchema = CreateLlmApplicationBodySchema;

const llmApplicationsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-applications",
    {
      schema: {
        operationId: RouteId.GetLlmApplications,
        description: "List LLM applications that can access the Model Router",
        tags: ["LLM Applications"],
        response: constructResponseSchema(z.array(LlmApplicationSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      const applications =
        await LlmApplicationModel.findAllByOrganization(organizationId);
      return reply.send(applications);
    },
  );

  fastify.post(
    "/api/llm-applications",
    {
      schema: {
        operationId: RouteId.CreateLlmApplication,
        description:
          "Create an LLM application and return its client secret once",
        tags: ["LLM Applications"],
        body: CreateLlmApplicationBodySchema,
        response: constructResponseSchema(LlmApplicationWithSecretSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      await validateLlmApplicationConfig({ ...body, organizationId });
      const { application, clientSecret } = await LlmApplicationModel.create({
        organizationId,
        name: body.name,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        modelRouterProviderApiKeys: body.modelRouterProviderApiKeys,
      });
      return reply.send({ ...application, clientSecret });
    },
  );

  fastify.put(
    "/api/llm-applications/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmApplication,
        description: "Update an LLM application",
        tags: ["LLM Applications"],
        params: z.object({ id: z.string() }),
        body: UpdateLlmApplicationBodySchema,
        response: constructResponseSchema(LlmApplicationSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      await validateLlmApplicationConfig({ ...body, organizationId });
      const application = await LlmApplicationModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        allowedLlmProxyIds: body.allowedLlmProxyIds,
        modelRouterProviderApiKeys: body.modelRouterProviderApiKeys,
      });
      if (!application) {
        throw new ApiError(404, "LLM application not found");
      }
      return reply.send(application);
    },
  );

  fastify.post(
    "/api/llm-applications/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateLlmApplicationSecret,
        description: "Rotate an LLM application's client secret",
        tags: ["LLM Applications"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(LlmApplicationWithSecretSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const result = await LlmApplicationModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "LLM application not found");
      }
      return reply.send({
        ...result.application,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/llm-applications/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmApplication,
        description: "Delete an LLM application",
        tags: ["LLM Applications"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const success = await LlmApplicationModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "LLM application not found");
      }
      return reply.send({ success });
    },
  );
};

export default llmApplicationsRoutes;

async function validateLlmApplicationConfig(params: {
  organizationId: string;
  allowedLlmProxyIds: string[];
  modelRouterProviderApiKeys: Array<{
    provider: z.infer<typeof SupportedProvidersSchema>;
    chatApiKeyId: string;
  }>;
}) {
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
