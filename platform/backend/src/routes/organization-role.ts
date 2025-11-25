import { PermissionsSchema, PredefinedRoleNameSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import logger from "@/logging";
import { OrganizationRoleModel, UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectOrganizationRoleSchema,
  UuidIdSchema,
} from "@/types";

const CreateUpdateRoleTitleSchema = z
  .string()
  .min(1, "Role title is required")
  .max(50, "Role title must be less than 50 characters");

const CustomRoleIdSchema = z
  .string()
  .min(1)
  .describe("Custom role ID (base62)");
const PredefinedRoleNameOrCustomRoleIdSchema = z
  .union([PredefinedRoleNameSchema, CustomRoleIdSchema])
  .describe("Predefined role name or custom role ID");

/**
 * Generate an immutable role name from a title
 * Converts to lowercase and replaces spaces/special chars with underscores
 */
const generateRoleName = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores
};

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

  fastify.post(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Roles"],
        body: z.object({
          name: CreateUpdateRoleTitleSchema,
          permission: PermissionsSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (request, reply) => {
      const { name, permission } = request.body;
      const { organizationId } = request;

      // Generate immutable role identifier from name
      const roleIdentifier = generateRoleName(name);

      logger.info(
        {
          name,
          roleIdentifier,
          permission,
          organizationId,
        },
        "🔍 Creating role with better-auth API",
      );

      // Use better-auth's createOrgRole API
      try {
        const result = await betterAuth.api.createOrgRole({
          headers: request.headers as HeadersInit,
          body: {
            role: roleIdentifier,
            permission,
            additionalFields: {
              name, // Pass display name in additionalFields
            },
            organizationId,
          },
        });

        logger.info({ result }, "✅ Better-auth createOrgRole result");

        // Extract the role data from better-auth response
        if (!result.roleData) {
          throw new ApiError(500, "Role created but data not returned");
        }

        const roleData = result.roleData;

        // Transform to our expected format
        const responseData = {
          id: roleData.id,
          role: roleData.role,
          name: roleData.name || name,
          organizationId: roleData.organizationId,
          permission: roleData.permission,
          predefined: false,
          createdAt: roleData.createdAt,
          updatedAt: roleData.updatedAt || roleData.createdAt,
        };

        return reply.send(responseData);
      } catch (error) {
        const err = error as { status?: number; message?: string };
        logger.error({ error }, "❌ Better-auth createOrgRole failed");
        // Better-auth returns detailed error messages
        throw new ApiError(
          err.status || 400,
          err.message || "Failed to create role",
        );
      }
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

  fastify.put(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.UpdateRole,
        description:
          "Update a custom role (name and/or permissions only, role identifier is immutable)",
        tags: ["Roles"],
        params: z.object({
          roleId: PredefinedRoleNameOrCustomRoleIdSchema,
        }),
        body: z.object({
          name: CreateUpdateRoleTitleSchema.optional(),
          permission: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (
      { params: { roleId }, body: { name, permission }, user, organizationId },
      reply,
    ) => {
      // Cannot update predefined roles
      if (OrganizationRoleModel.isPredefinedRole(roleId)) {
        throw new ApiError(403, "Cannot update predefined roles");
      }

      // Check if role exists
      const existingRole = await OrganizationRoleModel.getById(
        roleId,
        organizationId,
      );

      if (!existingRole) {
        throw new ApiError(404, "Role not found");
      }

      // Validate permissions if being changed
      if (permission) {
        const userPermissions = await UserModel.getUserPermissions(
          user.id,
          organizationId,
        );

        const validation = OrganizationRoleModel.validateRolePermissions(
          userPermissions,
          permission,
        );

        if (!validation.valid) {
          throw new ApiError(
            403,
            `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
          );
        }
      }

      return reply.send(
        await OrganizationRoleModel.update(roleId, {
          name,
          permission: permission ?? existingRole.permission,
        }),
      );
    },
  );

  fastify.delete(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.DeleteRole,
        description: "Delete a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: CustomRoleIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      // Check if role exists first
      const role = await OrganizationRoleModel.getById(roleId, organizationId);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      // Check if role can be deleted
      const deleteCheck = await OrganizationRoleModel.canDelete(
        roleId,
        organizationId,
      );

      if (!deleteCheck.canDelete) {
        throw new ApiError(400, deleteCheck.reason || "Cannot delete role");
      }

      return reply.send({
        success: await OrganizationRoleModel.delete(roleId),
      });
    },
  );
};

export default organizationRoleRoutes;
