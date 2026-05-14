import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import SiteNotificationModel from "@/models/site-notification";
import { constructResponseSchema } from "@/types";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/site-notification",
    {
      schema: {
        operationId: RouteId.GetSiteNotification,
        description:
          "Get the active site notification for the current organization",
        tags: ["Site Notification"],
        response: constructResponseSchema(
          z
            .object({
              id: z.string(),
              content: z.string(),
              expiresAt: z.string().nullable(),
              createdAt: z.string(),
            })
            .nullable(),
        ),
      },
    },
    async (request, reply) => {
      const organizationId = request.organizationId;
      if (!organizationId) {
        throw new Error("Organization ID not found");
      }

      const notification =
        await SiteNotificationModel.getActive(organizationId);

      if (!notification) {
        return reply.send(null);
      }

      return reply.send({
        id: notification.id,
        content: notification.content,
        expiresAt: notification.expiresAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
      });
    },
  );

  app.post(
    "/api/site-notification",
    {
      schema: {
        operationId: RouteId.CreateSiteNotification,
        description: "Create a new site notification",
        tags: ["Site Notification"],
        body: z.object({
          content: z.string().min(1),
          expiresAt: z.string().datetime().optional(),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            content: z.string(),
            expiresAt: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const organizationId = request.organizationId;
      if (!organizationId) {
        throw new Error("Organization ID not found");
      }

      await SiteNotificationModel.deactivateAll(organizationId);

      const notification = await SiteNotificationModel.create({
        organizationId,
        content: request.body.content,
        expiresAt: request.body.expiresAt
          ? new Date(request.body.expiresAt)
          : undefined,
        isActive: true,
      });

      return reply.send({
        id: notification.id,
        content: notification.content,
        expiresAt: notification.expiresAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
      });
    },
  );

  app.put(
    "/api/site-notification/:id",
    {
      schema: {
        operationId: RouteId.UpdateSiteNotification,
        description: "Update an existing site notification",
        tags: ["Site Notification"],
        params: z.object({
          id: z.string(),
        }),
        body: z.object({
          content: z.string().min(1).optional(),
          expiresAt: z.string().datetime().nullable().optional(),
          isActive: z.boolean().optional(),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            content: z.string(),
            expiresAt: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await SiteNotificationModel.getById(id);
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { message: "Notification not found" } });
      }

      const notification = await SiteNotificationModel.update(id, {
        content: request.body.content,
        expiresAt:
          request.body.expiresAt !== undefined
            ? request.body.expiresAt
              ? new Date(request.body.expiresAt)
              : null
            : undefined,
        isActive: request.body.isActive,
      });

      return reply.send({
        id: notification?.id ?? "",
        content: notification?.content ?? "",
        expiresAt: notification?.expiresAt?.toISOString() ?? null,
        createdAt:
          notification?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    },
  );

  app.delete(
    "/api/site-notification/:id",
    {
      schema: {
        operationId: RouteId.DeleteSiteNotification,
        description: "Delete a site notification",
        tags: ["Site Notification"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(z.object({})),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      await SiteNotificationModel.delete(id);
      return reply.send({});
    },
  );
};

export default routes;
