import { PredefinedRoleNameSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { createPaginatedResult } from "@/database/utils/pagination";
import { OrganizationRoleModel, ROLE_SORT_COLUMNS } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  PaginationQuerySchema,
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
        querystring: z
          .object({
            search: z.string().optional(),
          })
          .merge(PaginationQuerySchema)
          .merge(createSortingQuerySchema(ROLE_SORT_COLUMNS)),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectOrganizationRoleSchema),
        ),
      },
    },
    async ({ organizationId, headers, query }, reply) => {
      const { search, limit, offset, sortBy, sortDirection } = query;
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      const { success: canManageRoles } = await hasPermission(
        { ac: ["create"] },
        headers,
      );

      if (!canManageRoles) {
        // Non-admin users only see predefined roles
        let predefinedRoles =
          OrganizationRoleModel.getPredefinedOnly(organizationId);

        if (search) {
          const searchLower = search.toLowerCase();
          predefinedRoles = predefinedRoles.filter(
            (r) =>
              r.name.toLowerCase().includes(searchLower) ||
              (r.description?.toLowerCase().includes(searchLower) ?? false),
          );
        }

        const total = predefinedRoles.length;
        const paginatedRoles = predefinedRoles.slice(
          pagination.offset,
          pagination.offset + pagination.limit,
        );

        return reply.send(
          createPaginatedResult(paginatedRoles, total, pagination),
        );
      }

      return reply.send(
        await OrganizationRoleModel.getAllPaginated({
          organizationId,
          pagination,
          sorting,
          search,
        }),
      );
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
