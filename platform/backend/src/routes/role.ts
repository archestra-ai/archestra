import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isCustomRole, getPredefinedRolePermissions } from "@shared";
import {
  CreateRoleBodySchema,
  ErrorResponseSchema,
  RoleListItemSchema,
  RoleResponseSchema,
  RouteId,
  UpdateRoleBodySchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";
import {
  canDeleteRole,
  getMemberCountForRole,
  getUserPermissions,
  isRoleNameUnique,
  listRolesByOrganization,
  validateRolePermissions,
} from "@/utils/role-validation";
import { auth } from "@/auth";

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
        response: {
          200: z.array(RoleListItemSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
              organizationId: role.organizationId,
              createdAt: new Date().toISOString(), // Better-auth should provide this
              updatedAt: new Date().toISOString(), // Better-auth should provide this
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
        body: CreateRoleBodySchema,
        response: {
          200: RoleResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
          organizationId: user.organizationId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
          roleId: z.string(),
        }),
        response: {
          200: RoleResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
        if (roleId === "admin" || roleId === "member") {
          const permissions = getPredefinedRolePermissions(
            roleId as "admin" | "member",
          );

          return reply.send({
            id: roleId,
            name: roleId,
            permissions,
            isCustom: false,
            organizationId: user.organizationId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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
          organizationId: user.organizationId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
          roleId: z.string(),
        }),
        body: UpdateRoleBodySchema,
        response: {
          200: RoleResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
        if (roleId === "admin" || roleId === "member") {
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
          organizationId: user.organizationId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
          roleId: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
