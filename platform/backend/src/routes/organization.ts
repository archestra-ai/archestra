import { OrganizationAppearanceSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationModel } from "@/models";
import { ErrorResponseSchema, RouteId } from "@/types";
import { getUserFromRequest } from "@/utils";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.GetOrganizationAppearance,
        description: "Get organization appearance settings",
        tags: ["Organization"],
        response: {
          200: OrganizationAppearanceSchema,
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

  fastify.put(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.UpdateOrganizationAppearance,
        description: "Update organization appearance settings",
        tags: ["Organization"],
        body: OrganizationAppearanceSchema,
        response: {
          200: OrganizationAppearanceSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
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

        // Only admins can update appearance settings
        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Forbidden: Admin access required",
              type: "forbidden",
            },
          });
        }

        // Get the organization
        const organization =
          await OrganizationModel.getOrCreateDefaultOrganization();

        // Update appearance settings
        const updatedOrg = await OrganizationModel.updateAppearance(
          organization.id,
          request.body,
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
        response: {
          200: z.object({
            success: z.boolean(),
            logo: z.string().nullable(),
          }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          400: ErrorResponseSchema,
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

        // Only admins can upload logos
        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Forbidden: Admin access required",
              type: "forbidden",
            },
          });
        }

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
        response: {
          200: z.object({
            success: z.boolean(),
          }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
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

        // Only admins can delete logos
        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Forbidden: Admin access required",
              type: "forbidden",
            },
          });
        }

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
