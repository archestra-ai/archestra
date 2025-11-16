import { PermissionsSchema, PredefinedRoleNameSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationRoleModel, UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectOrganizationRoleSchema,
  UuidIdSchema,
} from "@/types";

const CreateUpdateRoleNameSchema = z
  .string()
  .min(1, "Role name is required")
  .max(50, "Role name must be less than 50 characters")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Role name can only contain letters, numbers, hyphens, and underscores",
  );

const CustomRoleIdSchema = UuidIdSchema.describe("Custom role ID");
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

  fastify.post(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Roles"],
        body: z.object({
          name: CreateUpdateRoleNameSchema,
          permission: PermissionsSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async ({ body: { name, permission }, user, organizationId }, reply) => {
      // Check role name uniqueness
      const isUnique = await OrganizationRoleModel.isNameUnique(
        name,
        organizationId,
      );

      if (!isUnique) {
        throw new ApiError(400, "Role name already exists or is reserved");
      }

      // Get user's permissions to validate they can grant these permissions
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

      return reply.send(
        await OrganizationRoleModel.create({
          name,
          permission,
          organizationId,
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

  fastify.put(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.UpdateRole,
        description: "Update a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: CustomRoleIdSchema,
        }),
        body: z.object({
          name: CreateUpdateRoleNameSchema.optional(),
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

      // Check name uniqueness if name is being changed
      if (name) {
        const isUnique = await OrganizationRoleModel.isNameUnique(
          name,
          organizationId,
          roleId,
        );

        if (!isUnique) {
          throw new ApiError(400, "Role name already exists or is reserved");
        }
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
