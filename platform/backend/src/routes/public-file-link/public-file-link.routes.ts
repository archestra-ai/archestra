import { PaginationQuerySchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { PublicFileLinkModel } from "@/models";
import { publicFileSharing } from "@/public-files/public-file-sharing";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";
import { PublicFileLinkListResponseSchema } from "@/types/public-file-link";

/**
 * The public file links agents created with `share_file_publicly`.
 * `publicFileLink:read`/`delete` cover the caller's own links;
 * `publicFileLink:admin` lifts both to every link in the organization.
 * Revoking is immediate for the backend (the link 404s from then on); a CDN in
 * front may keep serving a cached copy until its `Cache-Control` max-age runs
 * out.
 */
const publicFileLinkRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/public-file-links",
    {
      schema: {
        operationId: RouteId.GetPublicFileLinks,
        description:
          "List public file links, newest first, revoked ones included. `scope=mine` (the default) lists the caller's own links; `scope=organization` lists every link in the organization and needs publicFileLink:admin.",
        tags: ["Public File Links"],
        querystring: PaginationQuerySchema.extend({
          scope: z.enum(["mine", "organization"]).default("mine"),
        }),
        response: constructResponseSchema(PublicFileLinkListResponseSchema),
      },
    },
    async ({ organizationId, user, query: { scope, ...pagination } }) => {
      if (
        scope === "organization" &&
        !(await canManageAll({ userId: user.id, organizationId }))
      ) {
        throw new ApiError(
          403,
          "Listing every public file link requires publicFileLink:admin",
        );
      }
      const result = await PublicFileLinkModel.list({
        organizationId,
        createdByUserId: scope === "mine" ? user.id : undefined,
        pagination,
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
          "Revoke a public file link you created, or any link in the organization with publicFileLink:admin. The link stops serving immediately; revoking an already-revoked link is a no-op.",
        tags: ["Public File Links"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, user, params: { id } }) => {
      const found = await publicFileSharing.revoke({
        id,
        organizationId,
        userId: user.id,
        canRevokeAny: await canManageAll({ userId: user.id, organizationId }),
      });
      if (!found) {
        throw new ApiError(404, "Public file link not found");
      }
      return { success: true };
    },
  );
};

export default publicFileLinkRoutes;

// === internal ===

function canManageAll(params: { userId: string; organizationId: string }) {
  return userHasPermission(
    params.userId,
    params.organizationId,
    "publicFileLink",
    "admin",
  );
}
