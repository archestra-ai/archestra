import { AUTO_PROVISIONED_INVITATION_STATUS, RouteId } from "@shared";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import {
  InteractionModel,
  InvitationModel,
  McpToolCallModel,
  MemberModel,
  OrganizationModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  PublicAppearanceSchema,
  SelectOrganizationSchema,
  UpdateOrganizationSchema,
} from "@/types";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.getById(organizationId);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.UpdateOrganization,
        description: "Update organization details",
        tags: ["Organization"],
        body: UpdateOrganizationSchema.partial(),
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.get(
    "/api/organization/onboarding-status",
    {
      schema: {
        operationId: RouteId.GetOnboardingStatus,
        description: "Check if organization onboarding is complete",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            hasLlmProxyLogs: z.boolean(),
            hasMcpGatewayLogs: z.boolean(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      // Check if onboarding is complete by checking if there are any logs
      const interactionCount = await InteractionModel.getCount();
      const mcpToolCallCount = await McpToolCallModel.getCount();

      return reply.send({
        hasLlmProxyLogs: interactionCount > 0,
        hasMcpGatewayLogs: mcpToolCallCount > 0,
      });
    },
  );

  /**
   * Get signup status for organization members.
   * Returns members that don't have an account record (auto-provisioned, haven't signed up),
   * along with the provider they were auto-provisioned from.
   */
  fastify.get(
    "/api/organization/members/signup-status",
    {
      schema: {
        operationId: RouteId.GetMemberSignupStatus,
        description:
          "Get which members have completed signup (have an account record)",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            pendingSignupMembers: z.array(
              z.object({
                userId: z.string(),
                provider: z.string().nullable(),
                invitationId: z.string().nullable(),
              }),
            ),
          }),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      // Get all member user IDs for this organization
      const members = await db
        .select({ userId: schema.membersTable.userId })
        .from(schema.membersTable)
        .where(eq(schema.membersTable.organizationId, organizationId));

      if (members.length === 0) {
        return reply.send({ pendingSignupMembers: [] });
      }

      const memberUserIds = members.map((m) => m.userId);

      // Find which of these users have an account record
      const usersWithAccounts = await db
        .select({ userId: schema.accountsTable.userId })
        .from(schema.accountsTable)
        .where(inArray(schema.accountsTable.userId, memberUserIds));

      const hasAccountSet = new Set(usersWithAccounts.map((a) => a.userId));
      const pendingUserIds = memberUserIds.filter(
        (id) => !hasAccountSet.has(id),
      );

      if (pendingUserIds.length === 0) {
        return reply.send({ pendingSignupMembers: [] });
      }

      // Look up auto-provisioned invitations to get provider and invitation ID
      const invitations = await db
        .select({
          id: schema.invitationsTable.id,
          email: schema.invitationsTable.email,
          status: schema.invitationsTable.status,
        })
        .from(schema.invitationsTable)
        .where(
          like(
            schema.invitationsTable.status,
            `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
          ),
        );

      // Build email → { provider, invitationId } map
      const emailToInvitation = new Map<
        string,
        { provider: string | null; invitationId: string }
      >();
      for (const inv of invitations) {
        const parts = inv.status.split(":");
        emailToInvitation.set(inv.email, {
          provider: parts.length === 2 ? parts[1] : null,
          invitationId: inv.id,
        });
      }

      // Get emails for pending users
      const pendingUsers = await db
        .select({ id: schema.usersTable.id, email: schema.usersTable.email })
        .from(schema.usersTable)
        .where(inArray(schema.usersTable.id, pendingUserIds));

      const pendingSignupMembers = pendingUsers.map((u) => {
        const inv = emailToInvitation.get(u.email);
        return {
          userId: u.id,
          provider: inv?.provider ?? null,
          invitationId: inv?.invitationId ?? null,
        };
      });

      return reply.send({ pendingSignupMembers });
    },
  );

  /**
   * Delete an auto-provisioned member who hasn't completed signup.
   * Removes the member, invitation, user token, and user record.
   */
  fastify.delete(
    "/api/organization/members/:userId/pending-signup",
    {
      schema: {
        operationId: RouteId.DeletePendingSignupMember,
        description:
          "Delete an auto-provisioned member who hasn't completed signup",
        tags: ["Organization"],
        params: z.object({ userId: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, params }, reply) => {
      const { userId } = params;

      // Verify user has no account (is actually pending signup)
      const [account] = await db
        .select({ userId: schema.accountsTable.userId })
        .from(schema.accountsTable)
        .where(eq(schema.accountsTable.userId, userId))
        .limit(1);

      if (account) {
        throw new ApiError(
          400,
          "Cannot delete a member who has already completed signup",
        );
      }

      // Get user email to find their invitation
      const user = await UserModel.getById(userId);
      if (!user) {
        throw new ApiError(404, "User not found");
      }

      // Delete invitation(s) with auto-provisioned status for this email
      const invitations = await db
        .select({ id: schema.invitationsTable.id })
        .from(schema.invitationsTable)
        .where(
          and(
            eq(schema.invitationsTable.email, user.email),
            like(
              schema.invitationsTable.status,
              `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
            ),
          ),
        );

      for (const inv of invitations) {
        await InvitationModel.delete(inv.id);
      }

      // Delete personal tokens
      await UserTokenModel.deleteByUserAndOrg(userId, organizationId);

      // Delete member record
      await MemberModel.deleteByMemberOrUserId(userId, organizationId);

      // Delete user record (no other memberships since auto-provisioned)
      await UserModel.delete(userId);

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.GetPublicAppearance,
        description:
          "Get public appearance settings (theme, logo, font) for unauthenticated pages",
        tags: ["Organization"],
        response: constructResponseSchema(PublicAppearanceSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await OrganizationModel.getPublicAppearance());
    },
  );
};

export default organizationRoutes;
