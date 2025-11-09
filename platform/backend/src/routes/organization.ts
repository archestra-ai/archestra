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

<<<<<<< HEAD
        // Check for LLM proxy logs (interactions)
        const [interaction] = await db
          .select()
          .from(schema.interactionsTable)
          .limit(1);
        const hasLlmProxyLogs = !!interaction;

        // Check for MCP gateway logs (mcp tool calls)
        const [mcpToolCall] = await db
          .select()
          .from(schema.mcpToolCallsTable)
          .limit(1);
        const hasMcpGatewayLogs = !!mcpToolCall;

        // Compute onboarding complete based on log existence
        const onboardingComplete = hasLlmProxyLogs || hasMcpGatewayLogs;

        return reply.send({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          limitCleanupInterval: organization.limitCleanupInterval,
          onboardingComplete,
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
   * Update organization appearance settings
   */
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
          400: ErrorResponseSchema,
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
=======
        if ("logo" in body) {
>>>>>>> main
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
