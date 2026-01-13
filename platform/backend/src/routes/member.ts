import { RouteId, MEMBER_ROLE_NAME } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { MemberModel, OrganizationRoleModel, UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  flattenPermissions,
} from "@/types";

/**
 * Response schema for user lookup (org-scoped)
 */
const MemberUserResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: z.string().nullable(),
  banned: z.boolean().nullable(),
  banReason: z.string().nullable(),
  banExpires: z.string().nullable(),
  twoFactorEnabled: z.boolean().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Response schema for role assignment
 */
const RoleAssignmentResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  roleId: z.string(),
  assignedAt: z.string(),
});

/**
 * Response schema for role assignment read (includes role details)
 */
const RoleAssignmentWithRoleResponseSchema = z.object({
  assignment: z.object({
    id: z.string(),
    userId: z.string(),
    roleId: z.string(),
    assignedAt: z.string(),
  }),
  role: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    permissions: z.array(z.string()),
    organizationId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});


const memberRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Lookup user by ID (org-scoped)
   * GET /api/members/:userId
   */
  fastify.get(
    "/api/members/:userId",
    {
      schema: {
        operationId: RouteId.GetMember,
        description: "Get a user by ID within the current organization",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID to look up"),
        }),
        response: constructResponseSchema(MemberUserResponseSchema),
      },
    },
    async ({ params: { userId }, organizationId }, reply) => {
      logger.debug(
        { userId, organizationId },
        "GET /api/members/:userId - looking up user",
      );

      // First check if user is a member of this organization
      const member = await MemberModel.getByUserId(userId, organizationId);

      if (!member) {
        throw new ApiError(404, "User not found in this organization");
      }

      // Get user details
      const user = await UserModel.getById(userId);

      if (!user) {
        throw new ApiError(404, "User not found");
      }

      return reply.send({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        role: member.role,
        banned: user.banned,
        banReason: user.banReason,
        banExpires: user.banExpires?.toISOString() ?? null,
        twoFactorEnabled: user.twoFactorEnabled,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      });
    },
  );

  /**
   * OPERATION 2: Assign role to existing user
   * PUT /api/members/:userId/role
   *
   * CRITICAL: If the same role is already assigned, return 200 with existing assignment.
   * NEVER return 409 for duplicate assignment.
   */
  fastify.put(
    "/api/members/:userId/role",
    {
      schema: {
        operationId: RouteId.AssignMemberRole,
        description: "Assign a role to an existing member in the organization",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID to assign role to"),
        }),
        body: z.object({
          roleId: z.string().describe("Role ID or identifier to assign"),
        }),
        response: constructResponseSchema(RoleAssignmentResponseSchema),
      },
    },
    async (
      { params: { userId }, body: { roleId }, organizationId, user },
      reply,
    ) => {
      logger.debug(
        { userId, roleId, organizationId },
        "PUT /api/members/:userId/role - assigning role",
      );

      // Check if user is a member of this organization
      const member = await MemberModel.getByUserId(userId, organizationId);

      if (!member) {
        throw new ApiError(404, "User not found in this organization");
      }

      // Validate role exists
      const role = await OrganizationRoleModel.getById(roleId, organizationId);

      if (!role) {
        // Also try by identifier (e.g., "member", "admin", or custom role identifier)
        const roleByIdentifier = await OrganizationRoleModel.getByIdentifier(
          roleId,
          organizationId,
        );
        if (!roleByIdentifier) {
          throw new ApiError(404, "Role not found");
        }
      }

      const resolvedRole =
        role ||
        (await OrganizationRoleModel.getByIdentifier(roleId, organizationId));
      const roleIdentifier = resolvedRole!.role;

      // If same role is already assigned, return 200 with existing assignment (idempotent)
      if (member.role === roleIdentifier) {
        logger.debug(
          { userId, roleId: roleIdentifier },
          "Role already assigned, returning existing assignment",
        );
        return reply.send({
          id: member.id,
          userId: member.userId,
          roleId: roleIdentifier,
          assignedAt: member.createdAt.toISOString(),
        });
      }

      // Validate caller can grant this role's permissions
      const userPermissions = await UserModel.getUserPermissions(
        user.id,
        organizationId,
      );
      const validation = OrganizationRoleModel.validateRolePermissions(
        userPermissions,
        resolvedRole!.permission,
      );

      if (!validation.valid) {
        throw new ApiError(
          403,
          `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
        );
      }

      // Update member's role
      const updated = await MemberModel.updateRole(
        userId,
        organizationId,
        roleIdentifier,
      );

      if (!updated) {
        throw new ApiError(500, "Failed to update member role");
      }

      logger.info(
        { userId, roleId: roleIdentifier, organizationId },
        "Role assigned successfully",
      );

      return reply.send({
        id: updated.id,
        userId: updated.userId,
        roleId: updated.role,
        assignedAt: updated.createdAt.toISOString(),
      });
    },
  );

  /**
   * OPERATION 3: Remove role from user
   * DELETE /api/members/:userId/role/:roleId
   *
   * IMPORTANT: Returns 404 if assignment does not exist
   */
  fastify.delete(
    "/api/members/:userId/role/:roleId",
    {
      schema: {
        operationId: RouteId.RemoveMemberRole,
        description: "Remove a role assignment from a member",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID"),
          roleId: z
            .string()
            .describe("Role ID or identifier to remove assignment for"),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { userId, roleId }, organizationId }, reply) => {
      logger.debug(
        { userId, roleId, organizationId },
        "DELETE /api/members/:userId/role/:roleId - removing role",
      );

      // Check if user is a member of this organization
      const member = await MemberModel.getByUserId(userId, organizationId);

      if (!member) {
        throw new ApiError(404, "User not found in this organization");
      }

      // Resolve the role identifier
      const role = await OrganizationRoleModel.getById(roleId, organizationId);
      const roleByIdentifier = role
        ? null
        : await OrganizationRoleModel.getByIdentifier(roleId, organizationId);
      const resolvedRole = role || roleByIdentifier;

      if (!resolvedRole) {
        throw new ApiError(404, "Role not found");
      }

      const roleIdentifier = resolvedRole.role;

      // Check if this role is actually assigned to the user
      if (member.role !== roleIdentifier) {
        // Return 404 for missing assignment
        throw new ApiError(
          404,
          "Role assignment does not exist for this user",
        );
      }

      // Remove the role by assigning the default "member" role
      logger.info(
        { userId, roleId: roleIdentifier, organizationId },
        "Removing role assignment and assigning default member role",
      );

      await MemberModel.updateRole(userId, organizationId, MEMBER_ROLE_NAME);

      logger.info(
        { userId, previousRole: roleIdentifier, newRole: MEMBER_ROLE_NAME, organizationId },
        "Role assignment removed, user assigned to member role",
      );

      return reply.send({ success: true });
    },
  );

  /**
   * OPERATION 4: Read user-role assignment
   * GET /api/members/:userId/role/:roleId
   */
  fastify.get(
    "/api/members/:userId/role/:roleId",
    {
      schema: {
        operationId: RouteId.GetMemberRoleAssignment,
        description: "Get a specific role assignment for a member",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID"),
          roleId: z.string().describe("Role ID or identifier to check"),
        }),
        response: constructResponseSchema(RoleAssignmentWithRoleResponseSchema),
      },
    },
    async ({ params: { userId, roleId }, organizationId }, reply) => {
      logger.debug(
        { userId, roleId, organizationId },
        "GET /api/members/:userId/role/:roleId - reading assignment",
      );

      // Check if user is a member of this organization
      const member = await MemberModel.getByUserId(userId, organizationId);

      if (!member) {
        throw new ApiError(404, "User not found in this organization");
      }

      // Resolve the role
      const role = await OrganizationRoleModel.getById(roleId, organizationId);
      const roleByIdentifier = role
        ? null
        : await OrganizationRoleModel.getByIdentifier(roleId, organizationId);
      const resolvedRole = role || roleByIdentifier;

      if (!resolvedRole) {
        throw new ApiError(404, "Role not found");
      }

      const roleIdentifier = resolvedRole.role;

      // Check if this role is actually assigned to the user
      if (member.role !== roleIdentifier) {
        // Return 404 for missing assignment
        throw new ApiError(
          404,
          "Role assignment does not exist for this user",
        );
      }

      // Flatten permissions to array format
      const permissionsArray = flattenPermissions(resolvedRole.permission);

      return reply.send({
        assignment: {
          id: member.id,
          userId: member.userId,
          roleId: roleIdentifier,
          assignedAt: member.createdAt.toISOString(),
        },
        role: {
          id: resolvedRole.id,
          name: resolvedRole.name,
          description: null, // Backend doesn't have description field
          permissions: permissionsArray,
          organizationId: organizationId,
          createdAt: resolvedRole.createdAt.toISOString(),
          updatedAt: (resolvedRole.updatedAt ?? resolvedRole.createdAt).toISOString(),
        },
      });
    },
  );
};

export default memberRoutes;
