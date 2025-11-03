import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { ErrorResponseSchema, RouteId } from "@/types";
import { getUserFromRequest } from "@/utils";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Update organization limit cleanup interval (Admin only)
   */
  fastify.patch(
    "/api/organization/cleanup-interval",
    {
      schema: {
        operationId: RouteId.UpdateOrganizationCleanupInterval,
        description: "Update organization limit cleanup interval (Admin only)",
        tags: ["Organization"],
        body: z.object({
          limitCleanupInterval: z
            .enum(["1h", "12h", "24h", "1w", "1m"])
            .nullable(),
        }),
        response: {
          200: z.object({
            limitCleanupInterval: z
              .enum(["1h", "12h", "24h", "1w", "1m"])
              .nullable(),
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can update cleanup interval",
              type: "forbidden",
            },
          });
        }

        if (!user.organizationId) {
          return reply.status(400).send({
            error: {
              message: "No organization found",
              type: "bad_request",
            },
          });
        }

        const [organization] = await db
          .update(schema.organizationsTable)
          .set({
            limitCleanupInterval: request.body.limitCleanupInterval,
          })
          .where(eq(schema.organizationsTable.id, user.organizationId))
          .returning({
            limitCleanupInterval:
              schema.organizationsTable.limitCleanupInterval,
          });

        if (!organization) {
          return reply.status(404).send({
            error: {
              message: "Organization not found",
              type: "not_found",
            },
          });
        }

        return reply.send({
          limitCleanupInterval: organization.limitCleanupInterval,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  /**
   * Get organization details including cleanup interval
   */
  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            limitCleanupInterval: z
              .enum(["1h", "12h", "24h", "1w", "1m"])
              .nullable(),
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.organizationId) {
          return reply.status(400).send({
            error: {
              message: "No organization found",
              type: "bad_request",
            },
          });
        }

        const [organization] = await db
          .select({
            id: schema.organizationsTable.id,
            name: schema.organizationsTable.name,
            slug: schema.organizationsTable.slug,
            limitCleanupInterval:
              schema.organizationsTable.limitCleanupInterval,
          })
          .from(schema.organizationsTable)
          .where(eq(schema.organizationsTable.id, user.organizationId));

        if (!organization) {
          return reply.status(404).send({
            error: {
              message: "Organization not found",
              type: "not_found",
            },
          });
        }

        return reply.send(organization);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default organizationRoutes;
