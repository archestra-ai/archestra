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

const CustomRoleIdSchema = UuidIdSchema.describe("Custom role ID");
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
          title: CreateUpdateRoleTitleSchema,
          permission: PermissionsSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async ({ body: { title, permission }, request, organizationId }, reply) => {
      // Generate immutable name from title
      const name = generateRoleName(title);

      logger.info({
        title,
        name,
        permission,
        organizationId,
      }, "🔍 Creating role with better-auth API");

      // Use better-auth's createRole API
      try {
        const result = await betterAuth.api.organization.createRole({
          headers: request.headers as HeadersInit,
          body: {
            role: name,
            permission,
            data: {
              title, // Store title in additionalFields
            },
          },
        });

        logger.info({ result }, "✅ Better-auth createRole result");

        return reply.send(result);
      } catch (error: any) {
        logger.error({ error }, "❌ Better-auth createRole failed");
        // Better-auth returns detailed error messages
        throw new ApiError(
          error.status || 400,
          error.message || "Failed to create role",
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
        description: "Update a custom role (title and/or permissions only, name is immutable)",
        tags: ["Roles"],
        params: z.object({
          roleId: PredefinedRoleNameOrCustomRoleIdSchema,
        }),
        body: z.object({
          title: CreateUpdateRoleTitleSchema.optional(),
          permission: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (
      { params: { roleId }, body: { title, permission }, user, organizationId },
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
          title,
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
