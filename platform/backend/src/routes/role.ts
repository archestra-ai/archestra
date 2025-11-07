import { ActionSchema, ResourceSchema, RoleSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import { RoleModel, UserModel } from "@/models";
import { constructResponseSchema, RouteId } from "@/types";

const CreateUpdateRoleNameSchema = z
  .string()
  .min(1, "Role name is required")
  .max(50, "Role name must be less than 50 characters")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Role name can only contain letters, numbers, hyphens, and underscores",
  );

const PermissionsSchema = z.record(ResourceSchema, z.array(ActionSchema));

const RoleResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissions: PermissionsSchema,
  isCustom: z.boolean(),
});

const roleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all roles in the organization
   */
  fastify.get(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.GetRoles,
        description: "Get all roles in the organization",
        tags: ["Roles"],
        response: constructResponseSchema(
          z.array(
            z.object({
              id: RoleSchema,
              name: z.string(),
              isCustom: z.boolean(),
              memberCount: z.number().default(0),
            }),
          ),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      try {
        // Get all roles including predefined ones
        const roles = await RoleModel.listRolesByOrganization(organizationId);

        // Enrich with member counts and isCustom flag
        const enrichedRoles = await Promise.all(
          roles.map(async (role) => {
            const memberCount = await RoleModel.getMemberCountForRole(
              role.name,
              organizationId,
            );

            return {
              id: role.id,
              name: role.name,
              isCustom: RoleModel.isCustomRole(role.name),
              memberCount,
            };
          }),
        );

        return reply.send(enrichedRoles);
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

  /**
   * Create a new custom role (requires organization:update permission)
   */
  fastify.post(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Roles"],
        body: z.object({
          name: CreateUpdateRoleNameSchema,
          permissions: PermissionsSchema,
        }),
        response: constructResponseSchema(RoleResponseSchema),
      },
    },
    async ({ body: { name, permissions }, user, organizationId }, reply) => {
      try {
        // Check role name uniqueness
        const isUnique = await RoleModel.isRoleNameUnique(name, organizationId);

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

        const validation = RoleModel.validateRolePermissions(
          userPermissions,
          permissions,
        );

        if (!validation.valid) {
          return reply.status(403).send({
            error: {
              message: `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
              type: "forbidden",
            },
          });
        }

        const result = await RoleModel.create(
          name,
          permissions,
          organizationId,
        );

        if (!result) {
          return reply.status(500).send({
            error: {
              message: "Failed to create role",
              type: "api_error",
            },
          });
        }

        return reply.send({
          id: result.id,
          name: result.role,
          permissions: result.permission,
          isCustom: true,
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

  /**
   * Get a specific role by ID
   */
  fastify.get(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.GetRole,
        description: "Get a specific role by ID",
        tags: ["Roles"],
        params: z.object({
          roleId: RoleSchema,
        }),
        response: constructResponseSchema(RoleResponseSchema),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      try {
        // Check if it's a predefined role
        if (!RoleModel.isCustomRole(roleId)) {
          const permissions = RoleModel.getPredefinedRolePermissions(roleId);

          return reply.send({
            id: roleId,
            name: roleId,
            permissions,
            isCustom: false,
          });
        }

        // Fetch custom role
        const result = await RoleModel.getRoleById(roleId, organizationId);

        if (!result) {
          return reply.status(404).send({
            error: {
              message: "Role not found",
              type: "not_found",
            },
          });
        }

        // For predefined roles, get their permissions
        const permissions = RoleModel.isCustomRole(result.name)
          ? {} // Custom role permissions would come from better-auth, but we don't have access to them in the getRoleById response
          : RoleModel.getPredefinedRolePermissions(result.name);

        return reply.send({
          id: result.id,
          name: result.name,
          permissions,
          isCustom: RoleModel.isCustomRole(result.name),
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

  /**
   * Update a custom role (requires organization:update permission)
   */
  fastify.put(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.UpdateRole,
        description: "Update a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: RoleSchema,
        }),
        body: z.object({
          name: CreateUpdateRoleNameSchema.optional(),
          permissions: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(RoleResponseSchema),
      },
    },
    async (
      { params: { roleId }, body: { name, permissions }, user, organizationId },
      reply,
    ) => {
      try {
        // Cannot update predefined roles
        if (!RoleModel.isCustomRole(roleId)) {
          return reply.status(403).send({
            error: {
              message: "Cannot update predefined roles",
              type: "forbidden",
            },
          });
        }

        // Check if role exists
        const existingRole = await RoleModel.getRoleById(
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
          const isUnique = await RoleModel.isRoleNameUnique(
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
        if (permissions) {
          const userPermissions = await UserModel.getUserPermissions(
            user.id,
            organizationId,
          );

          const validation = RoleModel.validateRolePermissions(
            userPermissions,
            permissions,
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

        const result = await RoleModel.update(
          roleId,
          name,
          permissions,
          organizationId!,
        );

        if (!result) {
          return reply.status(500).send({
            error: {
              message: "Failed to update role",
              type: "api_error",
            },
          });
        }

        return reply.send({
          id: result.id,
          name: result.role,
          permissions: result.permission,
          isCustom: true,
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

  /**
   * Delete a custom role (requires organization:update permission)
   */
  fastify.delete(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.DeleteRole,
        description: "Delete a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: RoleSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      try {
        // Check if role can be deleted
        const deleteCheck = await RoleModel.canDeleteRole(
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

        const result = await RoleModel.delete(roleId, organizationId);

        if (!result) {
          return reply.status(500).send({
            error: {
              message: "Failed to delete role",
              type: "api_error",
            },
          });
        }

        return reply.send({ success: true });
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

export default roleRoutes;
