import { OrganizationAppearanceSchema, RouteId } from "@shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { OrganizationModel } from "@/models";
import { constructResponseSchema } from "@/types";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.patch(
    "/api/organization/cleanup-interval",
    {
      schema: {
        operationId: RouteId.UpdateOrganizationCleanupInterval,
        description: "Update organization limit cleanup interval",
        tags: ["Organization"],
        body: z.object({
          limitCleanupInterval: z
            .enum(["1h", "12h", "24h", "1w", "1m"])
            .nullable(),
        }),
        response: constructResponseSchema(
          z.object({
            limitCleanupInterval: z
              .enum(["1h", "12h", "24h", "1w", "1m"])
              .nullable(),
          }),
        ),
      },
    },
    async ({ organizationId, body: { limitCleanupInterval } }, reply) => {
      try {
        const [organization] = await db
          .update(schema.organizationsTable)
          .set({
            limitCleanupInterval,
          })
          .where(eq(schema.organizationsTable.id, organizationId))
          .returning({
            limitCleanupInterval:
              schema.organizationsTable.limitCleanupInterval,
          });

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

  fastify.get(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.GetOrganizationAppearance,
        description: "Get organization appearance settings",
        tags: ["Organization"],
        response: constructResponseSchema(OrganizationAppearanceSchema),
      },
    },
    async (_request, reply) => {
      try {
        // Get the organization
        const organization =
          await OrganizationModel.getOrCreateDefaultOrganization();

        if (!organization) {
          return reply.status(404).send({
            error: {
              message: "Organization not found",
              type: "not_found",
            },
          });
        }

        // Return only appearance-related fields
        return reply.send({
          theme: organization.theme || "cosmic-night",
          customFont: organization.customFont || "lato",
          logoType: organization.logoType || "default",
          logo: organization.logo || null,
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

  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            limitCleanupInterval: z
              .enum(["1h", "12h", "24h", "1w", "1m"])
              .nullable(),
          }),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      try {
        const [organization] = await db
          .select()
          .from(schema.organizationsTable)
          .where(eq(schema.organizationsTable.id, organizationId))
          .limit(1);

        if (!organization) {
          return reply.status(404).send({
            error: {
              message: "Organization not found",
              type: "not_found",
            },
          });
        }

        return reply.send({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
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

  fastify.put(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.UpdateOrganizationAppearance,
        description: "Update organization appearance settings",
        tags: ["Organization"],
        body: OrganizationAppearanceSchema,
        response: constructResponseSchema(OrganizationAppearanceSchema),
      },
    },
    async ({ body }, reply) => {
      try {
        // Get the organization
        const organization =
          await OrganizationModel.getOrCreateDefaultOrganization();

        // Update appearance settings
        const updatedOrg = await OrganizationModel.updateAppearance(
          organization.id,
          body,
        );

        if (!updatedOrg) {
          return reply.status(500).send({
            error: {
              message: "Failed to update organization",
              type: "api_error",
            },
          });
        }

        return reply.send({
          theme: updatedOrg.theme || "cosmic-night",
          customFont: updatedOrg.customFont || "lato",
          logoType: updatedOrg.logoType || "default",
          logo: updatedOrg.logo,
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

  fastify.post(
    "/api/organization/logo",
    {
      schema: {
        operationId: RouteId.UploadOrganizationLogo,
        description: "Upload a custom organization logo (PNG only, max 2MB)",
        tags: ["Organization"],
        body: z.object({
          logo: z.string(), // Base64 encoded image
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            logo: z.string().nullable(),
          }),
        ),
      },
    },
    async (request, reply) => {
      try {
        const { logo } = request.body;

        // Validate logo is base64 encoded PNG
        if (!logo.startsWith("data:image/png;base64,")) {
          return reply.status(400).send({
            error: {
              message: "Logo must be a PNG image in base64 format",
              type: "validation_error",
            },
          });
        }

        // Check size (rough estimate: base64 is ~1.33x original size)
        // 2MB * 1.33 = ~2.66MB in base64
        const maxSize = 2.66 * 1024 * 1024; // ~2.66MB
        if (logo.length > maxSize) {
          return reply.status(400).send({
            error: {
              message: "Logo must be less than 2MB",
              type: "validation_error",
            },
          });
        }

        // Get the organization
        const organization =
          await OrganizationModel.getOrCreateDefaultOrganization();

        // Update logo
        const updatedOrg = await OrganizationModel.updateAppearance(
          organization.id,
          {
            logo,
            logoType: "custom",
          },
        );

        if (!updatedOrg) {
          return reply.status(500).send({
            error: {
              message: "Failed to upload logo",
              type: "api_error",
            },
          });
        }

        return reply.send({
          success: true,
          logo: updatedOrg.logo || null,
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

  fastify.delete(
    "/api/organization/logo",
    {
      schema: {
        operationId: RouteId.DeleteOrganizationLogo,
        description: "Remove custom organization logo and revert to default",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      try {
        // Get the organization
        const organization =
          await OrganizationModel.getOrCreateDefaultOrganization();

        // Remove logo
        const updatedOrg = await OrganizationModel.updateAppearance(
          organization.id,
          {
            logo: null,
            logoType: "default",
          },
        );

        if (!updatedOrg) {
          return reply.status(500).send({
            error: {
              message: "Failed to delete logo",
              type: "api_error",
            },
          });
        }

        return reply.send({
          success: true,
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
};

export default organizationRoutes;
