import { PaginationQuerySchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PublicFileLinkModel } from "@/models";
import { publicFileSharing } from "@/public-files/public-file-sharing";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";
import { PublicFileLinkListResponseSchema } from "@/types/public-file-link";

/**
 * Admin oversight of the public file links agents created with
 * `share_file_publicly`: list them all, and revoke any of them. Revoking is
 * immediate for the backend (the link 404s from then on); a CDN in front may
 * keep serving a cached copy until its `Cache-Control` max-age runs out.
 */
const publicFileLinkRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/public-file-links",
    {
      schema: {
        operationId: RouteId.GetPublicFileLinks,
        description:
          "List the organization's public file links, newest first, revoked ones included.",
        tags: ["Public File Links"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(PublicFileLinkListResponseSchema),
      },
    },
    async ({ organizationId, query }) => {
      const result = await PublicFileLinkModel.listForOrganization({
        organizationId,
        pagination: query,
      });
      return {
        ...result,
        data: result.data.map((link) => ({
          ...link,
          url: publicFileSharing.buildUrl(link),
        })),
      };
    },
  );

  fastify.delete(
    "/api/public-file-links/:id",
    {
      schema: {
        operationId: RouteId.RevokePublicFileLink,
        description:
          "Revoke a public file link. The link stops serving immediately; revoking an already-revoked link is a no-op.",
        tags: ["Public File Links"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params: { id } }) => {
      const found = await PublicFileLinkModel.revoke({ id, organizationId });
      if (!found) {
        throw new ApiError(404, "Public file link not found");
      }
      return { success: true };
    },
  );
};

export default publicFileLinkRoutes;
