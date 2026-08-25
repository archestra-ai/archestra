import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationModel, SkillMarketplaceRepoModel } from "@/models";
import { marketplaceNameFor } from "@/skills/marketplace/marketplace-name";
import { ApiError, constructResponseSchema } from "@/types";
import { getPublicRequestOrigin } from "../request-origin";
import { SKILL_MARKETPLACE_STATIC_PATH } from "../route-paths";

const SkillMarketplaceResponseSchema = z.object({
  cloneUrl: z.string(),
  marketplaceName: z.string(),
  /**
   * False when the organization publishes the marketplace anonymously, in
   * which case a clone needs no credential at all.
   */
  requiresAuthentication: z.boolean(),
});

const skillMarketplaceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skill-marketplace",
    {
      schema: {
        operationId: RouteId.GetSkillMarketplace,
        description:
          "The static skill marketplace: one clone URL for the whole deployment, which every user installs with their own credential.",
        tags: ["Skills"],
        response: constructResponseSchema(SkillMarketplaceResponseSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user } = request;

      const organization = await OrganizationModel.getById(organizationId);
      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      // Name the repo this caller's clone will actually land on: with
      // anonymous access published they clone without a credential, which
      // resolves the organization's shared view rather than their own.
      const repo = await SkillMarketplaceRepoModel.findForViewer({
        organizationId,
        userId: organization.skillMarketplaceAnonymousAccess ? null : user.id,
      });

      return reply.send({
        cloneUrl: `${getPublicRequestOrigin(request)}${SKILL_MARKETPLACE_STATIC_PATH}`,
        // Once the caller has cloned, their repo owns the name their client
        // registered the marketplace under; re-deriving it after an org rename
        // would print install commands for a plugin they do not have.
        marketplaceName:
          repo?.marketplaceName ??
          marketplaceNameFor({ organizationId, organization }),
        requiresAuthentication: !organization.skillMarketplaceAnonymousAccess,
      });
    },
  );
};

export default skillMarketplaceRoutes;
