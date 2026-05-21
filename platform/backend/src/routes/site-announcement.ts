import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { SiteAnnouncementModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectSiteAnnouncementSchema,
  UpsertSiteAnnouncementSchema,
} from "@/types";

const NullableSiteAnnouncementSchema = SelectSiteAnnouncementSchema.nullable();

const siteAnnouncementRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.GetSiteAnnouncement,
        description:
          "Get the configured site announcement for the organization",
        tags: ["Site Announcement"],
        response: constructResponseSchema(NullableSiteAnnouncementSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const announcement =
        await SiteAnnouncementModel.getForOrganization(organizationId);
      return reply.send(announcement);
    },
  );

  fastify.get(
    "/api/site-announcement/active",
    {
      schema: {
        operationId: RouteId.GetActiveSiteAnnouncement,
        description: "Get the current unexpired site announcement",
        tags: ["Site Announcement"],
        response: constructResponseSchema(NullableSiteAnnouncementSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const announcement =
        await SiteAnnouncementModel.getActiveForOrganization(organizationId);
      return reply.send(announcement);
    },
  );

  fastify.put(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.UpsertSiteAnnouncement,
        description:
          "Create or replace the organization-wide site announcement",
        tags: ["Site Announcement"],
        body: UpsertSiteAnnouncementSchema,
        response: constructResponseSchema(SelectSiteAnnouncementSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      const announcement = await SiteAnnouncementModel.upsert({
        organizationId,
        userId: user.id,
        markdown: body.markdown,
        expiresAt: body.expiresAt,
      });

      return reply.send(announcement);
    },
  );

  fastify.delete(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.DeleteSiteAnnouncement,
        description: "Delete the organization-wide site announcement",
        tags: ["Site Announcement"],
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const deleted = await SiteAnnouncementModel.delete(organizationId);
      if (!deleted) {
        throw new ApiError(404, "Site announcement not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default siteAnnouncementRoutes;
