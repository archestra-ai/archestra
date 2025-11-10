import { PermissionsSchema, PredefinedRoleNameSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationRoleModel, UserModel } from "@/models";
import {
  constructResponseSchema,
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
      try {
        // Get all roles including predefined ones
        return reply.send(await OrganizationRoleModel.getAll(organizationId));
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
      try {
        // Check role name uniqueness
        const isUnique = await OrganizationRoleModel.isNameUnique(
          name,
          organizationId,
        );

        if (!isUnique) {
          return reply.status(400).send({
            error: {
              message: "Role name already exists or is reserved",
              type: "validation_error",
            },
          });
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
          return reply.status(403).send({
            error: {
              message: `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
              type: "forbidden",
            },
          });
        }

        return reply.send(
          await OrganizationRoleModel.create({
            name,
            permission,
            organizationId,
          }),
        );
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
      try {
        const result = await OrganizationRoleModel.getById(
          roleId,
          organizationId,
        );

        if (!result) {
          return reply.status(404).send({
            error: {
              message: "Role not found",
              type: "not_found",
            },
          });
        }

        return reply.send(result);
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
      try {
        // Cannot update predefined roles
        if (OrganizationRoleModel.isPredefinedRole(roleId)) {
          return reply.status(403).send({
            error: {
              message: "Cannot update predefined roles",
              type: "forbidden",
            },
          });
        }

        // Check if role exists
        const existingRole = await OrganizationRoleModel.getById(
          roleId,
          organizationId,
        );

        if (!existingRole) {
          return reply.status(404).send({
            error: {
              message: "Role not found",
              type: "not_found",
            },
          });
        }

        // Check name uniqueness if name is being changed
        if (name) {
          const isUnique = await OrganizationRoleModel.isNameUnique(
            name,
            organizationId,
            roleId,
          );

          if (!isUnique) {
            return reply.status(400).send({
              error: {
                message: "Role name already exists or is reserved",
                type: "validation_error",
              },
            });
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
            return reply.status(403).send({
              error: {
                message: `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
                type: "forbidden",
              },
            });
          }
        }

        return reply.send(
          await OrganizationRoleModel.update(roleId, {
            name,
            permission: permission ?? existingRole.permission,
          }),
        );
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      try {
        // Check if role can be deleted
        const deleteCheck = await OrganizationRoleModel.canDelete(
          roleId,
          organizationId,
        );

        if (!deleteCheck.canDelete) {
          return reply.status(400).send({
            error: {
              message: deleteCheck.reason || "Cannot delete role",
              type: "validation_error",
            },
          });
        }

        return reply.send({
          success: await OrganizationRoleModel.delete(roleId),
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
};

export default organizationRoleRoutes;
