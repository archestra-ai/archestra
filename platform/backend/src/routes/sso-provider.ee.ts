import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "@/auth/better-auth";
import { SSO_PROVIDERS_API_PREFIX } from "@/constants";
import SsoProviderModel from "@/models/sso-provider.ee";
import {
  ApiError,
  constructResponseSchema,
  InsertSsoProviderSchema,
  PublicSsoProviderSchema,
  SelectSsoProviderSchema,
  UpdateSsoProviderSchema,
} from "@/types";

const ssoProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Public endpoint for login page - returns only minimal provider info.
   * Does NOT expose any sensitive configuration data like client secrets.
   * Auth is skipped for this endpoint in middleware.
   */
  fastify.get(
    `${SSO_PROVIDERS_API_PREFIX}/public`,
    {
      schema: {
        operationId: RouteId.GetPublicSsoProviders,
        description:
          "Get public SSO provider list for login page (no secrets exposed)",
        tags: ["SSO Providers"],
        response: constructResponseSchema(z.array(PublicSsoProviderSchema)),
      },
    },
    async (_request, reply) => {
      return reply.send(await SsoProviderModel.findAllPublic());
    },
  );

  /**
   * Admin endpoint - returns full provider config including secrets.
   * Requires authentication and ssoProvider:read permission.
   */
  fastify.get(
    SSO_PROVIDERS_API_PREFIX,
    {
      schema: {
        operationId: RouteId.GetSsoProviders,
        description:
          "Get all SSO providers with full configuration (admin only)",
        tags: ["SSO Providers"],
        response: constructResponseSchema(z.array(SelectSsoProviderSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await SsoProviderModel.findAll(organizationId));
    },
  );

  fastify.get(
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
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
    SSO_PROVIDERS_API_PREFIX,
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
          auth,
        ),
      );
    },
  );

  fastify.put(
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
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
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
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
