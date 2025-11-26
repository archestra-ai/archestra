import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SsoProviderModel } from "@/models";
import {
  constructResponseSchema,
  InsertSsoProviderSchema,
  SelectSsoProviderSchema,
  UpdateSsoProviderSchema,
} from "@/types";

const ssoProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get all SSO providers
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
      return reply.send(await SsoProviderModel.findAll(organizationId));
    },
  );

  // Get single SSO provider
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
        return reply.code(404).send({
          error: {
            message: "SSO provider not found",
            type: "api_not_found_error" as const,
          },
        });
      }
      return reply.send(provider);
    },
  );

  // Create SSO provider
  fastify.post(
    "/api/sso-providers",
    {
      schema: {
        operationId: RouteId.CreateSsoProvider,
        description: "Create a new SSO provider",
        tags: ["SSO Providers"],
        body: InsertSsoProviderSchema.omit({ id: true, organizationId: true }),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async (request, reply) => {
      const { body, organizationId, user } = request;
      // Convert Node.js headers to Web API Headers
      const webHeaders = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          webHeaders.set(key, value);
        } else if (Array.isArray(value)) {
          webHeaders.set(key, value.join(", "));
        }
      }

      const provider = await SsoProviderModel.create(
        {
          ...body,
          userId: user.id,
        },
        organizationId,
        webHeaders,
      );
      return reply.send(provider);
    },
  );

  // Update SSO provider
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
        body: UpdateSsoProviderSchema.omit({
          id: true,
          organizationId: true,
          userId: true,
        }),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ params, body, organizationId }, reply) => {
      const provider = await SsoProviderModel.update(
        params.id,
        body,
        organizationId,
      );
      if (!provider) {
        return reply.code(404).send({
          error: {
            message: "SSO provider not found",
            type: "api_not_found_error" as const,
          },
        });
      }
      return reply.send(provider);
    },
  );

  // Delete SSO provider
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
        return reply.code(404).send({
          error: {
            message: "SSO provider not found",
            type: "api_not_found_error" as const,
          },
        });
      }
      return reply.send({ success: true });
    },
  );
};

export default ssoProviderRoutes;
