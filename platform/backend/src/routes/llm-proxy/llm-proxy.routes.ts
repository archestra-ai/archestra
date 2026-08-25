import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { enterpriseTier } from "@/enterprise-tier";
import { AgentModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const LlmProxySchema = z.object({
  id: z.string().uuid(),
  /**
   * Identity provider used for JWT (JWKS) authentication on LLM Proxy
   * requests; null means JWT authentication is off.
   */
  identityProviderId: z.string().nullable(),
});

const UpdateLlmProxyBodySchema = z.object({
  /**
   * Identity provider used for JWT (JWKS) authentication on LLM Proxy
   * requests; null turns JWT authentication off.
   */
  identityProviderId: z.string().nullable(),
});

const llmProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-proxy",
    {
      schema: {
        operationId: RouteId.GetLlmProxy,
        description: "Get the LLM Proxy",
        tags: ["LLM Proxy"],
        response: constructResponseSchema(LlmProxySchema),
      },
    },
    async ({ organizationId }, reply) => {
      const proxy = await AgentModel.getOrgLlmProxy(organizationId);
      return reply.send({
        id: proxy.id,
        identityProviderId: proxy.identityProviderId,
      });
    },
  );

  fastify.patch(
    "/api/llm-proxy",
    {
      schema: {
        operationId: RouteId.UpdateLlmProxy,
        description: "Update the LLM Proxy configuration",
        tags: ["LLM Proxy"],
        body: UpdateLlmProxyBodySchema,
        response: constructResponseSchema(LlmProxySchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      if (body.identityProviderId !== null) {
        // Identity providers are an Enterprise feature; without it none exist.
        if (!enterpriseTier.isCoreActive()) {
          throw new ApiError(404, "Identity provider not found");
        }
        const { default: IdentityProviderModel } = await import(
          // biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
          "@/models/identity-provider.ee"
        );
        const idp = await IdentityProviderModel.findById(
          body.identityProviderId,
          organizationId,
        );
        if (!idp) {
          throw new ApiError(404, "Identity provider not found");
        }
      }
      const proxy = await AgentModel.setOrgLlmProxyIdentityProvider({
        organizationId,
        identityProviderId: body.identityProviderId,
      });
      return reply.send({
        id: proxy.id,
        identityProviderId: proxy.identityProviderId,
      });
    },
  );
};

export default llmProxyRoutes;
