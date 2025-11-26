import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SsoProviderModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  CreateSsoProviderSchema,
  DeleteObjectResponseSchema,
  SelectSsoProviderSchema,
  UpdateSsoProviderSchema,
} from "@/types";

const SsoProviderIdSchema = z.string().min(1).describe("SSO Provider ID");

const ssoProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/sso-providers",
    {
      schema: {
        operationId: RouteId.GetSsoProviders,
        description: "Get all SSO providers for the organization",
        tags: ["SSO"],
        response: constructResponseSchema(
          z.array(SelectSsoProviderSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await SsoProviderModel.getByOrganizationId(organizationId),
      );
    },
  );

  fastify.post(
    "/api/sso-providers",
    {
      schema: {
        operationId: RouteId.CreateSsoProvider,
        description: "Create a new SSO provider",
        tags: ["SSO"],
        body: CreateSsoProviderSchema,
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      // Validate OIDC-specific fields
      if (body.type === "oidc") {
        if (!body.clientId || !body.clientSecret || !body.issuer) {
          throw new ApiError(400, "OIDC providers require clientId, clientSecret, and issuer");
        }
      }

      // Validate SAML-specific fields
      if (body.type === "saml") {
        if (!body.entryPoint || !body.cert) {
          throw new ApiError(400, "SAML providers require entryPoint and cert");
        }
      }

      const provider = await SsoProviderModel.create(organizationId, body);
      return reply.send(provider);
    },
  );

  fastify.get(
    "/api/sso-providers/:id",
    {
      schema: {
        operationId: RouteId.GetSsoProvider,
        description: "Get SSO provider by ID",
        tags: ["SSO"],
        params: z.object({
          id: SsoProviderIdSchema,
        }),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ organizationId, params: { id } }, reply) => {
      const provider = await SsoProviderModel.getById(id);

      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }

      // Verify the provider belongs to the organization
      if (provider.organizationId !== organizationId) {
        throw new ApiError(403, "Access denied");
      }

      return reply.send(provider);
    },
  );

  fastify.put(
    "/api/sso-providers/:id",
    {
      schema: {
        operationId: RouteId.UpdateSsoProvider,
        description: "Update an SSO provider",
        tags: ["SSO"],
        params: z.object({
          id: SsoProviderIdSchema,
        }),
        body: UpdateSsoProviderSchema.partial(),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ organizationId, params: { id }, body }, reply) => {
      // Verify the provider exists and belongs to the organization
      const existing = await SsoProviderModel.getById(id);

      if (!existing) {
        throw new ApiError(404, "SSO provider not found");
      }

      if (existing.organizationId !== organizationId) {
        throw new ApiError(403, "Access denied");
      }

      // Validate type-specific fields if type is being updated
      if (body.type === "oidc" || (existing.type === "oidc" && !body.type)) {
        const finalType = body.type || existing.type;
        if (finalType === "oidc") {
          const clientId = body.clientId ?? existing.clientId;
          const clientSecret = body.clientSecret ?? existing.clientSecret;
          const issuer = body.issuer ?? existing.issuer;

          if (!clientId || !clientSecret || !issuer) {
            throw new ApiError(
              400,
              "OIDC providers require clientId, clientSecret, and issuer",
            );
          }
        }
      }

      if (body.type === "saml" || (existing.type === "saml" && !body.type)) {
        const finalType = body.type || existing.type;
        if (finalType === "saml") {
          const entryPoint = body.entryPoint ?? existing.entryPoint;
          const cert = body.cert ?? existing.cert;

          if (!entryPoint || !cert) {
            throw new ApiError(
              400,
              "SAML providers require entryPoint and cert",
            );
          }
        }
      }

      const provider = await SsoProviderModel.update(id, organizationId, body);

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
        description: "Delete an SSO provider",
        tags: ["SSO"],
        params: z.object({
          id: SsoProviderIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params: { id } }, reply) => {
      // Verify the provider exists and belongs to the organization
      const existing = await SsoProviderModel.getById(id);

      if (!existing) {
        throw new ApiError(404, "SSO provider not found");
      }

      if (existing.organizationId !== organizationId) {
        throw new ApiError(403, "Access denied");
      }

      const deleted = await SsoProviderModel.delete(id, organizationId);

      if (!deleted) {
        throw new ApiError(404, "SSO provider not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default ssoProviderRoutes;
