import { AnyRoleNameSchema, MEMBER_ROLE_NAME, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { MemberModel, OrganizationRoleModel, UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  MemberSchema,
  UserSchema,
} from "@/types";

/**
 * Schema for member with user details
 */
const MemberWithUserSchema = MemberSchema.extend({
  user: UserSchema.pick({
    id: true,
    name: true,
    email: true,
    image: true,
  }).optional(),
});

/**
 * Schema for user lookup response (user + their membership in current org)
 */
const UserLookupResponseSchema = UserSchema.pick({
  id: true,
  name: true,
  email: true,
  image: true,
  createdAt: true,
}).extend({
  member: MemberSchema.pick({
    id: true,
    role: true,
    createdAt: true,
  }).nullable(),
});

const memberRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all members in the organization
   */
  fastify.get(
    "/api/members",
    {
      schema: {
        operationId: RouteId.GetOrganizationMembers,
        description: "Get all members in the organization",
        tags: ["Members"],
        response: constructResponseSchema(z.array(MemberWithUserSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      const members = await MemberModel.getAllByOrganization(organizationId);
      return reply.send(members);
    },
  );

  /**
   * Get a specific member by user ID
   */
  fastify.get(
    "/api/members/:userId",
    {
      schema: {
        operationId: RouteId.GetOrganizationMember,
        description: "Get a specific member by user ID",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        response: constructResponseSchema(MemberWithUserSchema),
      },
    },
    async ({ params: { userId }, organizationId }, reply) => {
      const member = await MemberModel.getByUserId(userId, organizationId);

      if (!member) {
        throw new ApiError(404, "Member not found in this organization");
      }

      // Get user details
      const user = await UserModel.getById(userId);

      return reply.send({
        ...member,
        user: user
          ? {
              id: user.id,
              name: user.name,
              email: user.email,
              image: user.image,
            }
          : undefined,
      });
    },
  );

  /**
   * Update a member's role in the organization
   * This is the role assignment endpoint for Terraform
   */
  fastify.put(
    "/api/members/:userId/role",
    {
      schema: {
        operationId: RouteId.UpdateMemberRole,
        description:
          "Update a member's role in the organization. Use this to assign or change roles.",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        body: z.object({
          role: AnyRoleNameSchema.describe(
            "Role identifier (predefined role name like 'admin', 'editor', 'member' or custom role identifier)",
          ),
        }),
        response: constructResponseSchema(MemberSchema),
      },
    },
    async (
      { params: { userId }, body: { role }, organizationId, user },
      reply,
    ) => {
      // Check if the member exists in this organization
      const existingMember = await MemberModel.getByUserId(
        userId,
        organizationId,
      );

      if (!existingMember) {
        throw new ApiError(404, "Member not found in this organization");
      }

      // Validate that the role exists (predefined or custom)
      const roleExists = await OrganizationRoleModel.getByIdentifier(
        role,
        organizationId,
      );

      if (!roleExists) {
        throw new ApiError(404, `Role '${role}' not found`);
      }

      // Prevent users from changing their own role (security measure)
      if (userId === user.id) {
        throw new ApiError(403, "You cannot change your own role");
      }

      // Update the member's role
      const updatedMember = await MemberModel.updateRole(
        userId,
        organizationId,
        role,
      );

      if (!updatedMember) {
        throw new ApiError(500, "Failed to update member role");
      }

      return reply.send(updatedMember);
    },
  );

  /**
   * Reset a member's role to the default (member) role
   * This is the "unassign" operation for Terraform
   */
  fastify.delete(
    "/api/members/:userId/role",
    {
      schema: {
        operationId: RouteId.UpdateMemberRole,
        description:
          "Reset a member's role to the default 'member' role. This effectively unassigns any custom or elevated role.",
        tags: ["Members"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        response: constructResponseSchema(MemberSchema),
      },
    },
    async ({ params: { userId }, organizationId, user }, reply) => {
      // Check if the member exists
      const existingMember = await MemberModel.getByUserId(
        userId,
        organizationId,
      );

      if (!existingMember) {
        throw new ApiError(404, "Member not found in this organization");
      }

      // Prevent users from resetting their own role
      if (userId === user.id) {
        throw new ApiError(403, "You cannot change your own role");
      }

      // Reset to default member role
      const updatedMember = await MemberModel.updateRole(
        userId,
        organizationId,
        MEMBER_ROLE_NAME,
      );

      if (!updatedMember) {
        throw new ApiError(500, "Failed to reset member role");
      }

      return reply.send(updatedMember);
    },
  );

  /**
   * User lookup by ID
   * Returns the user and their membership in the current organization
   */
  fastify.get(
    "/api/users/:userId",
    {
      schema: {
        operationId: RouteId.GetUserById,
        description:
          "Look up a user by their ID. Returns user details and their membership in the current organization.",
        tags: ["Users"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        response: constructResponseSchema(UserLookupResponseSchema),
      },
    },
    async ({ params: { userId }, organizationId }, reply) => {
      const user = await UserModel.getById(userId);

      if (!user) {
        throw new ApiError(404, "User not found");
      }

      // Get the user's membership in the current organization
      const member = await MemberModel.getByUserId(userId, organizationId);

      return reply.send({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        createdAt: user.createdAt,
        member: member
          ? {
              id: member.id,
              role: member.role,
              createdAt: member.createdAt,
            }
          : null,
      });
    },
  );

  /**
   * User lookup by email
   * Returns the user and their membership in the current organization
   */
  fastify.get(
    "/api/users/by-email/:email",
    {
      schema: {
        operationId: RouteId.GetUserByEmail,
        description:
          "Look up a user by their email address. Returns user details and their membership in the current organization.",
        tags: ["Users"],
        params: z.object({
          email: z.string().email().describe("User email address"),
        }),
        response: constructResponseSchema(UserLookupResponseSchema),
      },
    },
    async ({ params: { email }, organizationId }, reply) => {
      const user = await UserModel.findByEmail(email);

      if (!user) {
        throw new ApiError(404, `User with email '${email}' not found`);
      }

      // Get the user's membership in the current organization
      const member = await MemberModel.getByUserId(user.id, organizationId);

      return reply.send({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        createdAt: user.createdAt,
        member: member
          ? {
              id: member.id,
              role: member.role,
              createdAt: member.createdAt,
            }
          : null,
      });
    },
  );
};

export default memberRoutes;
