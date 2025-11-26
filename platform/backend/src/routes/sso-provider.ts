import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SsoProviderModel } from "@/models";
import { constructResponseSchema, SelectSsoProviderSchema } from "@/types";

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
      return reply.send(await SsoProviderModel.findAll(organizationId));
    },
  );
};

export default ssoProviderRoutes;
