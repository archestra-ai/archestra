import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  InteractionModel,
  McpToolCallModel,
  OrganizationModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  PublicAppearanceSchema,
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
      const organization = await OrganizationModel.getById(organizationId);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
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
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.get(
    "/api/organization/onboarding-status",
    {
      schema: {
        operationId: RouteId.GetOnboardingStatus,
        description: "Check if organization onboarding is complete",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            hasLlmProxyLogs: z.boolean(),
            hasMcpGatewayLogs: z.boolean(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      // Check if onboarding is complete by checking if there are any logs
      const interactionCount = await InteractionModel.getCount();
      const mcpToolCallCount = await McpToolCallModel.getCount();

      return reply.send({
        hasLlmProxyLogs: interactionCount > 0,
        hasMcpGatewayLogs: mcpToolCallCount > 0,
      });
    },
  );

  fastify.get(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.GetPublicAppearance,
        description:
          "Get public appearance settings (theme, logo, font) for unauthenticated pages",
        tags: ["Organization"],
        response: constructResponseSchema(PublicAppearanceSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await OrganizationModel.getPublicAppearance());
    },
  );
};

export default organizationRoutes;
