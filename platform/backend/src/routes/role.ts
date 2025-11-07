import {
  ActionSchema,
  getPredefinedRolePermissions,
  isCustomRole,
  ResourceSchema,
  RoleSchema,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "@/auth";
import { constructResponseSchema, RouteId } from "@/types";
import { getUserFromRequest } from "@/utils";
import {
  canDeleteRole,
  getMemberCountForRole,
  getUserPermissions,
  isRoleNameUnique,
  listRolesByOrganization,
  validateRolePermissions,
} from "@/utils/role-validation";

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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Get all roles including predefined ones
        const roles = await listRolesByOrganization(user.organizationId);

        // Enrich with member counts and isCustom flag
        const enrichedRoles = await Promise.all(
          roles.map(async (role) => {
            const memberCount = await getMemberCountForRole(
              role.name,
              user.organizationId,
            );

            return {
              id: role.id,
              name: role.name,
              isCustom: isCustomRole(role.name),
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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Check role name uniqueness
        const isUnique = await isRoleNameUnique(
          request.body.name,
          user.organizationId,
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
        const userPermissions = await getUserPermissions(
          user.id,
          user.organizationId,
        );

        const validation = validateRolePermissions(
          userPermissions,
          request.body.permissions,
        );

        if (!validation.valid) {
          return reply.status(403).send({
            error: {
              message: `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
              type: "forbidden",
            },
          });
        }

        // Create role using better-auth
        const result = await auth.api.createRole({
          body: {
            name: request.body.name,
            permissions: request.body.permissions,
            organizationId: user.organizationId,
          },
        });

        if (!result?.data) {
          return reply.status(500).send({
            error: {
              message: "Failed to create role",
              type: "api_error",
            },
          });
        }

        return reply.send({
          id: result.data.id,
          name: result.data.name,
          permissions: result.data.permissions,
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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { roleId } = request.params;

        // Check if it's a predefined role
        if (!isCustomRole(roleId)) {
          const permissions = getPredefinedRolePermissions(roleId);

          return reply.send({
            id: roleId,
            name: roleId,
            permissions,
            isCustom: false,
          });
        }

        // Fetch custom role
        const result = await auth.api.getRole({
          body: {
            roleId,
            organizationId: user.organizationId,
          },
        });

        if (!result?.data) {
          return reply.status(404).send({
            error: {
              message: "Role not found",
              type: "not_found",
            },
          });
        }

        return reply.send({
          id: result.data.id,
          name: result.data.name,
          permissions: result.data.permissions,
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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { roleId } = request.params;

        // Cannot update predefined roles
        if (!isCustomRole(roleId)) {
          return reply.status(403).send({
            error: {
              message: "Cannot update predefined roles",
              type: "forbidden",
            },
          });
        }

        // Check if role exists
        const existingRole = await auth.api.getRole({
          body: {
            roleId,
            organizationId: user.organizationId,
          },
        });

        if (!existingRole?.data) {
          return reply.status(404).send({
            error: {
              message: "Role not found",
              type: "not_found",
            },
          });
        }

        // Check name uniqueness if name is being changed
        if (request.body.name) {
          const isUnique = await isRoleNameUnique(
            request.body.name,
            user.organizationId,
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
        if (request.body.permissions) {
          const userPermissions = await getUserPermissions(
            user.id,
            user.organizationId,
          );

          const validation = validateRolePermissions(
            userPermissions,
            request.body.permissions,
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

        // Update role
        const result = await auth.api.updateRole({
          body: {
            roleId,
            organizationId: user.organizationId,
            name: request.body.name,
            permissions: request.body.permissions,
          },
        });

        if (!result?.data) {
          return reply.status(500).send({
            error: {
              message: "Failed to update role",
              type: "api_error",
            },
          });
        }

        return reply.send({
          id: result.data.id,
          name: result.data.name,
          permissions: result.data.permissions,
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
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { roleId } = request.params;

        // Check if role can be deleted
        const deleteCheck = await canDeleteRole(roleId, user.organizationId);

        if (!deleteCheck.canDelete) {
          return reply.status(400).send({
            error: {
              message: deleteCheck.reason || "Cannot delete role",
              type: "validation_error",
            },
          });
        }

        // Delete role using better-auth
        const result = await auth.api.deleteRole({
          body: {
            roleId,
            organizationId: user.organizationId,
          },
        });

        if (!result?.data?.success) {
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
