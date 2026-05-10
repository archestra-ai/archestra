import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationModel } from "@/models";
import {
  ApiError,
  SiteAnnouncementPayloadSchema,
  SiteAnnouncementResponseSchema,
} from "@/types";

const siteAnnouncementRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.GetSiteAnnouncement,
        description: "Get the active site announcement",
        tags: ["Site Announcement"],
        response: {
          200: SiteAnnouncementResponseSchema,
        },
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.getById(organizationId);
      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send({
        announcement: getActiveAnnouncement(organization),
      });
    },
  );

  fastify.get(
    "/api/site-announcement/settings",
    {
      schema: {
        operationId: RouteId.GetSiteAnnouncementSettings,
        description: "Get site announcement settings",
        tags: ["Site Announcement"],
        response: {
          200: SiteAnnouncementResponseSchema,
        },
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.getById(organizationId);
      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send({
        announcement: toAnnouncement(organization),
      });
    },
  );

  fastify.post(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.CreateSiteAnnouncement,
        description: "Create a site announcement",
        tags: ["Site Announcement"],
        body: SiteAnnouncementPayloadSchema,
        response: {
          200: SiteAnnouncementResponseSchema,
        },
      },
    },
    async ({ organizationId, body }, reply) => {
      const current = await OrganizationModel.getById(organizationId);
      if (!current) {
        throw new ApiError(404, "Organization not found");
      }
      if (current.siteAnnouncementContent) {
        throw new ApiError(409, "Site announcement already exists");
      }

      const organization = await OrganizationModel.patch(organizationId, {
        siteAnnouncementContent: body.content,
        siteAnnouncementExpiresAt: parseExpiration(body.expiresAt),
      });

      return reply.send({
        announcement: toAnnouncement(organization),
      });
    },
  );

  fastify.patch(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.UpdateSiteAnnouncement,
        description: "Update the site announcement",
        tags: ["Site Announcement"],
        body: SiteAnnouncementPayloadSchema,
        response: {
          200: SiteAnnouncementResponseSchema,
        },
      },
    },
    async ({ organizationId, body }, reply) => {
      const current = await OrganizationModel.getById(organizationId);
      if (!current) {
        throw new ApiError(404, "Organization not found");
      }
      if (!current.siteAnnouncementContent) {
        throw new ApiError(404, "Site announcement not found");
      }

      const organization = await OrganizationModel.patch(organizationId, {
        siteAnnouncementContent: body.content,
        siteAnnouncementExpiresAt: parseExpiration(body.expiresAt),
      });

      return reply.send({
        announcement: toAnnouncement(organization),
      });
    },
  );

  fastify.delete(
    "/api/site-announcement",
    {
      schema: {
        operationId: RouteId.DeleteSiteAnnouncement,
        description: "Delete the site announcement",
        tags: ["Site Announcement"],
        response: {
          200: z.object({ success: z.literal(true) }),
        },
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, {
        siteAnnouncementContent: null,
        siteAnnouncementExpiresAt: null,
      });
      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default siteAnnouncementRoutes;

type AnnouncementSource = {
  siteAnnouncementContent: string | null;
  siteAnnouncementExpiresAt: Date | null;
};

function getActiveAnnouncement(source: AnnouncementSource) {
  const announcement = toAnnouncement(source);
  if (!announcement) {
    return null;
  }

  if (
    announcement.expiresAt &&
    new Date(announcement.expiresAt).getTime() <= Date.now()
  ) {
    return null;
  }

  return announcement;
}

function toAnnouncement(source: AnnouncementSource | null) {
  if (!source?.siteAnnouncementContent) {
    return null;
  }

  return {
    content: source.siteAnnouncementContent,
    expiresAt: source.siteAnnouncementExpiresAt?.toISOString() ?? null,
  };
}

function parseExpiration(expiresAt: string | null) {
  return expiresAt ? new Date(expiresAt) : null;
}
