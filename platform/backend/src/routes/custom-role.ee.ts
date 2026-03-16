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
} from "@/types";

const CreateUpdateRoleNameSchema = z
  .string()
  .min(1, "Role name is required")
  .max(50, "Role name must be less than 50 characters");
const RoleDescriptionSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .optional()
  .transform((value) => (value ? value : undefined));

const CustomRoleIdSchema = z
  .string()
  .min(1)
  .describe("Custom role ID (base62)");
const PredefinedRoleNameOrCustomRoleIdSchema = z
  .union([PredefinedRoleNameSchema, CustomRoleIdSchema])
  .describe("Predefined role name or custom role ID");

/**
 * Generates an immutable role identifier from a human-readable name
 */
const generateRoleIdentifier = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores
};

/**
 * Custom role CRUD routes (Enterprise Edition only)
 * GET routes are in organization-role.ts (open-source)
 */
const customRoleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Roles"],
        body: z.object({
          name: CreateUpdateRoleNameSchema,
          description: RoleDescriptionSchema,
          permission: PermissionsSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (request, reply) => {
      const { name, description, permission } = request.body;
      const { organizationId, user } = request;

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

      const roleIdentifier = generateRoleIdentifier(name);

      logger.info(
        {
          name,
          roleIdentifier,
          permission,
          organizationId,
        },
        "Creating role",
      );

      try {
        const result = await betterAuth.api.createOrgRole({
          headers: request.headers as HeadersInit,
          body: {
            role: roleIdentifier,
            permission,
            additionalFields: {
              name,
              description,
            },
            organizationId,
          },
        });

        if (!result.roleData) {
          throw new ApiError(500, "Role created but data not returned");
        }

        logger.info({ role: result.roleData }, "Role created successfully");
        return reply.send(normalizeRoleResponse(result.roleData));
      } catch (error) {
        const err = error as {
          status?: string;
          statusCode?: number;
          message?: string;
          body?: { message?: string };
        };
        logger.error({ error }, "Failed to create role");
        throw new ApiError(
          err.statusCode || 400,
          err.body?.message || err.message || "Failed to create role",
        );
      }
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
          roleId: PredefinedRoleNameOrCustomRoleIdSchema,
        }),
        body: z.object({
          name: CreateUpdateRoleNameSchema.optional(),
          description: RoleDescriptionSchema,
          permission: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (
      {
        params: { roleId },
        body: { name, description, permission },
        user,
        organizationId,
        headers,
      },
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

      // Build update data
      const updateData: Record<string, unknown> = {};
      if (name) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (permission) updateData.permission = permission;

      const result = await betterAuth.api.updateOrgRole({
        headers: headers as HeadersInit,
        body: {
          roleId,
          organizationId,
          data: updateData,
        },
      });

      if (!result.roleData) {
        throw new ApiError(500, "Role updated but data not returned");
      }

      return reply.send(normalizeRoleResponse(result.roleData));
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
    async ({ params: { roleId }, organizationId, headers }, reply) => {
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

      await betterAuth.api.deleteOrgRole({
        headers: headers as HeadersInit,
        body: {
          roleId,
          organizationId,
        },
      });

      return reply.send({ success: true });
    },
  );
};

export default customRoleRoutes;

// === Internal helpers

function normalizeRoleResponse(roleData: {
  id: string;
  organizationId: string;
  role: string;
  name: string;
  description?: string | null;
  permission: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}) {
  return {
    id: roleData.id,
    organizationId: roleData.organizationId,
    role: roleData.role,
    name: roleData.name,
    description: roleData.description ?? null,
    permission: parsePermissions(roleData.permission),
    createdAt: toDate(roleData.createdAt),
    updatedAt: roleData.updatedAt ? toDate(roleData.updatedAt) : null,
    predefined: false,
  };
}

function parsePermissions(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      logger.warn(
        { error, permission: value },
        "Failed to parse custom role permissions JSON",
      );
      return {};
    }
  }

  return value;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
