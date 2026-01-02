import { PredefinedRoleNameSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationRoleModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  SelectOrganizationRoleSchema,
} from "@/types";

const CustomRoleIdSchema = z
  .string()
  .min(1)
  .describe("Custom role ID (base62)");
const PredefinedRoleNameOrCustomRoleIdSchema = z
  .union([PredefinedRoleNameSchema, CustomRoleIdSchema])
  .describe("Predefined role name or custom role ID");

const organizationRoleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.GetRoles,
        description: "Get all roles in the organization",
        tags: ["Roles"],
        response: constructResponseSchema(
          z.array(SelectOrganizationRoleSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      // Get all roles including predefined ones
      return reply.send(await OrganizationRoleModel.getAll(organizationId));
    },
  );

  fastify.get(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.GetRole,
        description: "Get a specific role by ID",
        tags: ["Roles"],
        params: z.object({
          roleId: PredefinedRoleNameOrCustomRoleIdSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      const result = await OrganizationRoleModel.getById(
        roleId,
        organizationId,
      );

      if (!result) {
        throw new ApiError(404, "Role not found");
      }

      return reply.send(result);
    },
  );
};

export default organizationRoleRoutes;
