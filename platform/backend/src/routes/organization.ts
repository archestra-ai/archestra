import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { OrganizationModel } from "@/models";
import {
  constructResponseSchema,
  SelectOrganizationSchema,
  UpdateOrganizationSchema,
} from "@/types";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      try {
        const organization = await OrganizationModel.getById(organizationId);

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

  fastify.patch(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.UpdateOrganization,
        description: "Update organization details",
        tags: ["Organization"],
        body: UpdateOrganizationSchema.partial(),
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      try {
        const organization = await OrganizationModel.patch(
          organizationId,
          body,
        );

        if (!organization) {
          return reply.status(404).send({
            error: {
              message: "Organization not found",
              type: "not_found",
            },
          });
        }

        if ("logo" in body) {
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
