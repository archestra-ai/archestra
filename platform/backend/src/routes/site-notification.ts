import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import SiteNotificationModel from "@/models/site-notification";
import { auditLogExporter } from "@/observability/audit-log-export";
import {
  ApiError,
  constructResponseSchema,
  SelectAuditLogSchema,
} from "@/types";
import { extractAuditSourceIp } from "@/utils/audit-snapshot";
import { callRustApi } from "@/utils/rust-api";

const NotificationSchema = z.object({
  id: z.string(),
  content: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  isActive: z.boolean(),
});
const CommittedNotificationSchema = z.object({
  notification: NotificationSchema,
  audit: SelectAuditLogSchema.extend({
    createdAt: z.coerce.date(),
    occurredAt: z.coerce.date(),
  }),
});

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
              isActive: z.boolean(),
            })
            .nullable(),
        ),
      },
    },
    async (request, reply) => {
      const organizationId = request.organizationId;

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
        isActive: notification.isActive,
      });
    },
  );

  app.get(
    "/api/site-notification/settings",
    {
      schema: {
        operationId: RouteId.GetSiteNotificationSettings,
        description: "Get the latest site notification for settings management",
        tags: ["Site Notification"],
        response: constructResponseSchema(
          z
            .object({
              id: z.string(),
              content: z.string(),
              expiresAt: z.string().nullable(),
              createdAt: z.string(),
              isActive: z.boolean(),
            })
            .nullable(),
        ),
      },
    },
    async (request, reply) => {
      const notification = await SiteNotificationModel.getLatest(
        request.organizationId,
      );

      if (!notification) {
        return reply.send(null);
      }

      return reply.send(serializeNotification(notification));
    },
  );

  app.post(
    "/api/site-notification",
    {
      schema: {
        operationId: RouteId.CreateSiteNotification,
        description:
          "Replace the organization site notification, optionally keeping it inactive.",
        tags: ["Site Notification"],
        body: z.object({
          content: z.string().min(1),
          expiresAt: z.string().datetime().optional(),
          isActive: z.boolean().optional(),
        }),
        response: constructResponseSchema(NotificationSchema),
      },
    },
    async (request, reply) => {
      const organizationId = request.organizationId;

      if (config.database.rustSiteNotificationEnabled) {
        const socketPath = config.database.rustAuditLogSocket;
        if (!socketPath) throw new ApiError(503, "Rust API is not configured");
        const result = await callRustApi({
          socketPath,
          path: "/internal/v1/site-notification/replace",
          json: JSON.stringify({
            ...request.body,
            organizationId,
            audit: {
              actorId: request.user.id,
              actorType:
                request.authMethod === "api_key" ||
                request.authMethod === "service_account"
                  ? request.authMethod
                  : "user",
              actorName: request.user.name ?? null,
              actorEmail: request.user.email,
              impersonatedBy: request.impersonatedBy ?? null,
              requestId: request.id,
              occurredAt: (request.auditOccurredAt ?? new Date()).toISOString(),
              sourceIp: extractAuditSourceIp(request),
              userAgent: request.headers["user-agent"] ?? null,
            },
          }),
        });
        // Axum committed the success record in the same transaction.
        request.auditSkip = true;
        const committed = CommittedNotificationSchema.parse(result);
        auditLogExporter.export(committed.audit);
        return reply.send(committed.notification);
      }

      const notification = await SiteNotificationModel.replaceCurrent({
        organizationId,
        content: request.body.content,
        expiresAt: request.body.expiresAt
          ? new Date(request.body.expiresAt)
          : undefined,
        isActive: request.body.isActive ?? true,
      });

      return reply.send(serializeNotification(notification));
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
            isActive: z.boolean(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await SiteNotificationModel.getById(id);
      if (!existing || existing.organizationId !== request.organizationId) {
        throw new ApiError(404, "Notification not found");
      }

      if (request.body.isActive === true) {
        await SiteNotificationModel.deactivateAll(request.organizationId);
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

      if (!notification) {
        throw new ApiError(404, "Notification not found");
      }

      return reply.send(serializeNotification(notification));
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
      const existing = await SiteNotificationModel.getById(id);
      if (!existing || existing.organizationId !== request.organizationId) {
        throw new ApiError(404, "Notification not found");
      }

      await SiteNotificationModel.delete(id);
      return reply.send({});
    },
  );
};

export default routes;

function serializeNotification(notification: {
  id: string;
  content: string;
  expiresAt: Date | null;
  createdAt: Date;
  isActive: boolean;
}) {
  return {
    id: notification.id,
    content: notification.content,
    expiresAt: notification.expiresAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    isActive: notification.isActive,
  };
}
