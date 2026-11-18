import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  PredefinedRoleNameSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
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
        querystring: PaginationQuerySchema.extend({
          name: z.string().optional(),
          kind: z
            .enum(["custom"])
            .optional()
            .describe(
              "Limit the list to one kind of role. `custom` leaves out the built-in roles, which cannot be edited.",
            ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectOrganizationRoleSchema),
        ),
      },
    },
    async ({ organizationId, headers, query }, reply) => {
      const { success: canManageRoles } = await hasPermission(
        { ac: ["create"] },
        headers,
      );
      const { limit, offset, name, kind } = query;

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId,
        limit,
        offset,
        name,
        customOnly: kind === "custom",
        isAdmin: canManageRoles,
      });

      return reply.send({
        data: result.data,
        pagination: calculatePaginationMeta(result.total, { limit, offset }),
      });
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
