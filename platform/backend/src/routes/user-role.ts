import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import {
  RoleModel,
  UserRoleAssignmentModel,
} from "@/models";
import {
  ApiError,
  AssignRoleToUserBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectUserRoleAssignmentSchema,
  SelectRoleSchema,
} from "@/types";

const userRoleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * POST /api/users/:userId/roles
   * Assign a role to a user
   */
  fastify.post(
    "/api/users/:userId/roles",
    {
      schema: {
        operationId: RouteId.AssignRoleToUser,
        description: "Assign a role to a user",
        tags: ["User Management"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        body: AssignRoleToUserBodySchema,
        response: constructResponseSchema(SelectUserRoleAssignmentSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to assign roles (org updater/rbac-admin)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can assign roles",
        );
      }

      const { userId } = request.params;
      const { roleId } = request.body;

      // Verify role exists and belongs to organization
      const role = await RoleModel.findById(roleId);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role not found");
      }

      const assignment = await UserRoleAssignmentModel.create({
        userId,
        roleId,
      });

      return reply.send(assignment);
    },
  );

  /**
   * GET /api/users/:userId/roles
   * Get all roles assigned to a user
   */
  fastify.get(
    "/api/users/:userId/roles",
    {
      schema: {
        operationId: RouteId.GetUserRoles,
        description: "Get all roles assigned to a user",
        tags: ["User Management"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        response: constructResponseSchema(
          z.array(
            z.object({
              assignment: SelectUserRoleAssignmentSchema,
              role: SelectRoleSchema,
            }),
          ),
        ),
      },
    },
    async (request, reply) => {
      // Check if user has permission to view roles (admin only)
      // Users can only view their own roles
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["admin"] },
        request.headers,
      );

      const { userId } = request.params;

      if (
        !hasAdminPermission &&
        userId !== request.user.id
      ) {
        throw new ApiError(
          403,
          "You can only view your own roles",
        );
      }

      const assignments =
        await UserRoleAssignmentModel.findByUser(userId);

      // Get full role details for each assignment
      const assignmentsWithRoles = await Promise.all(
        assignments.map(async (assignment) => {
          const role = await RoleModel.findById(assignment.roleId);
          if (!role) {
            throw new ApiError(500, "Role data inconsistency");
          }
          return { assignment, role };
        }),
      );

      return reply.send(assignmentsWithRoles);
    },
  );

  /**
   * GET /api/users/:userId/roles/:roleId
   * Get a specific role assignment
   */
  fastify.get(
    "/api/users/:userId/roles/:roleId",
    {
      schema: {
        operationId: RouteId.GetUserRoleAssignment,
        description: "Get a specific role assignment for a user",
        tags: ["User Management"],
        params: z.object({
          userId: z.string().describe("User ID"),
          roleId: z.string().describe("Role ID"),
        }),
        response: constructResponseSchema(
          z.object({
            assignment: SelectUserRoleAssignmentSchema,
            role: SelectRoleSchema,
          }),
        ),
      },
    },
    async (request, reply) => {
      // Check if user has permission
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      const { userId, roleId } = request.params;

      if (
        !hasAdminPermission &&
        userId !== request.user.id
      ) {
        throw new ApiError(
          403,
          "You can only view your own roles",
        );
      }

      const assignment =
        await UserRoleAssignmentModel.findByUserAndRole(userId, roleId);

      if (!assignment) {
        throw new ApiError(404, "Role assignment not found");
      }

      const role = await RoleModel.findById(roleId);
      if (!role) {
        throw new ApiError(500, "Role data inconsistency");
      }

      // Verify role belongs to user's organization
      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role assignment not found");
      }

      return reply.send({ assignment, role });
    },
  );

  /**
   * DELETE /api/users/:userId/roles/:roleId
   * Remove a role from a user
   */
  fastify.delete(
    "/api/users/:userId/roles/:roleId",
    {
      schema: {
        operationId: RouteId.RemoveRoleFromUser,
        description: "Remove a role from a user",
        tags: ["User Management"],
        params: z.object({
          userId: z.string().describe("User ID"),
          roleId: z.string().describe("Role ID"),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to remove roles (org updater/rbac-admin)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can remove roles",
        );
      }

      const { userId, roleId } = request.params;

      // Verify role exists and belongs to organization
      const role = await RoleModel.findById(roleId);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role not found");
      }

      await UserRoleAssignmentModel.deleteByUserAndRole(userId, roleId);

      return reply.send({ success: true });
    },
  );
};

export default userRoleRoutes;
