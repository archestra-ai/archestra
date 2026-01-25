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
        description:
          "Get all roles in the organization. Optionally filter by name.",
        tags: ["Roles"],
        querystring: z.object({
          name: z
            .string()
            .optional()
            .describe("Filter roles by name (exact match)"),
        }),
        response: constructResponseSchema(
          z.array(SelectOrganizationRoleSchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      // Get all roles including predefined ones
      const allRoles = await OrganizationRoleModel.getAll(organizationId);

      // If name filter provided, filter results
      if (query.name) {
        const filtered = allRoles.filter(
          (role) => role.name === query.name || role.role === query.name,
        );
        return reply.send(filtered);
      }

      return reply.send(allRoles);
    },
  );

  /**
   * Lookup a role by its name/identifier
   * Returns 404 if not found (useful for Terraform data sources)
   */
  fastify.get(
    "/api/roles/by-name/:name",
    {
      schema: {
        operationId: RouteId.GetRoleByName,
        description:
          "Get a role by its name or identifier. Returns 404 if not found.",
        tags: ["Roles"],
        params: z.object({
          name: z.string().min(1).describe("Role name or identifier"),
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async ({ params: { name }, organizationId }, reply) => {
      const result = await OrganizationRoleModel.getByIdentifier(
        name,
        organizationId,
      );

      if (!result) {
        throw new ApiError(404, `Role with name '${name}' not found`);
      }

      return reply.send(result);
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
