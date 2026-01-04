import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { OrganizationModel } from "@/models";
import { constructResponseSchema, PublicAppearanceSchema } from "@/types";

/**
 * Public appearance routes - accessible without authentication.
 * Used by login pages to display custom branding (theme, logo, fonts).
 */
const appearanceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/appearance/public",
    {
      schema: {
        operationId: RouteId.GetPublicAppearance,
        description:
          "Get public appearance settings (theme, logo, font) for unauthenticated pages",
        tags: ["Appearance"],
        response: constructResponseSchema(PublicAppearanceSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await OrganizationModel.getPublicAppearance());
    },
  );
};

export default appearanceRoutes;
