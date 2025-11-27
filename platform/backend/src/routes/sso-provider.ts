import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SsoProviderModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  InsertSsoProviderSchema,
  SelectSsoProviderSchema,
  UpdateSsoProviderSchema,
} from "@/types";

const ssoProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/sso-providers",
    {
      schema: {
        operationId: RouteId.GetSsoProviders,
        description: "Get all SSO providers",
        tags: ["SSO Providers"],
        response: constructResponseSchema(z.array(SelectSsoProviderSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      const providers = await SsoProviderModel.findAll(organizationId);
      fastify.log.info({ providers }, "SSO providers found");
      return reply.send(providers);
    },
  );

  fastify.get(
    "/api/sso-providers/:id",
    {
      schema: {
        operationId: RouteId.GetSsoProvider,
        description: "Get SSO provider by ID",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const provider = await SsoProviderModel.findById(
        params.id,
        organizationId,
      );
      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.post(
    "/api/sso-providers",
    {
      schema: {
        operationId: RouteId.CreateSsoProvider,
        description: "Create a new SSO provider",
        tags: ["SSO Providers"],
        body: InsertSsoProviderSchema,
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      return reply.send(
        await SsoProviderModel.create(
          {
            ...body,
            userId: user.id,
          },
          organizationId,
          headers as HeadersInit,
        ),
      );
    },
  );

  fastify.put(
    "/api/sso-providers/:id",
    {
      schema: {
        operationId: RouteId.UpdateSsoProvider,
        description: "Update SSO provider",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateSsoProviderSchema,
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const provider = await SsoProviderModel.update(id, body, organizationId);
      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.delete(
    "/api/sso-providers/:id",
    {
      schema: {
        operationId: RouteId.DeleteSsoProvider,
        description: "Delete SSO provider",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const success = await SsoProviderModel.delete(params.id, organizationId);
      if (!success) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send({ success: true });
    },
  );
};

export default ssoProviderRoutes;
