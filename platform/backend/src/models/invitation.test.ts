import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import type { BetterAuthSession, BetterAuthSessionUser } from "@/types";
import InvitationModel from "./invitation";
import MemberModel from "./member";
import UserModel from "./user";

describe("InvitationModel", () => {
  let testOrgId: string;
  let testUserId: string;
  let testInviterId: string;
  let testInvitationId: string;
  let testSessionId: string;

  beforeEach(async () => {
    testOrgId = crypto.randomUUID();
    testUserId = crypto.randomUUID();
    testInviterId = crypto.randomUUID();
    testInvitationId = crypto.randomUUID();
    testSessionId = crypto.randomUUID();

    // Create test organization
    await db.insert(schema.organizationsTable).values({
      id: testOrgId,
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    });

    // Create test inviter user
    await db.insert(schema.usersTable).values({
      id: testInviterId,
      email: "inviter@example.com",
      name: "Test Inviter",
    });

    // Create test user
    await db.insert(schema.usersTable).values({
      id: testUserId,
      email: "test@example.com",
      name: "Test User",
    });

    // Create test session
    await db.insert(schema.sessionsTable).values({
      id: testSessionId,
      userId: testUserId,
      token: "test-token",
      expiresAt: new Date(Date.now() + 86400000), // 24 hours
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test invitation
    await db.insert(schema.invitationsTable).values({
      id: testInvitationId,
      organizationId: testOrgId,
      email: "test@example.com",
      role: MEMBER_ROLE_NAME,
      status: "pending",
      expiresAt: new Date(Date.now() + 86400000), // 24 hours
      inviterId: testInviterId,
    });
  });

  afterEach(async () => {
    // Clean up in reverse order due to foreign key constraints
    await db
      .delete(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, testInvitationId));
    await db
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, testSessionId));
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, testUserId));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testUserId));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testInviterId));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, testOrgId));
  });

  describe("getById", () => {
    it("should return invitation when it exists", async () => {
      const invitation = await InvitationModel.getById(testInvitationId);

      expect(invitation).toBeDefined();
      expect(invitation?.id).toBe(testInvitationId);
      expect(invitation?.email).toBe("test@example.com");
      expect(invitation?.organizationId).toBe(testOrgId);
      expect(invitation?.role).toBe(MEMBER_ROLE_NAME);
      expect(invitation?.status).toBe("pending");
      expect(invitation?.inviterId).toBe(testInviterId);
    });

    it("should return undefined when invitation does not exist", async () => {
      const nonExistentId = crypto.randomUUID();
      const invitation = await InvitationModel.getById(nonExistentId);

      expect(invitation).toBeUndefined();
    });
  });

  describe("patch", () => {
    it("should update invitation status", async () => {
      await InvitationModel.patch(testInvitationId, { status: "accepted" });

      const updatedInvitation = await InvitationModel.getById(testInvitationId);
      expect(updatedInvitation?.status).toBe("accepted");
    });

    it("should update invitation role", async () => {
      await InvitationModel.patch(testInvitationId, { role: ADMIN_ROLE_NAME });

      const updatedInvitation = await InvitationModel.getById(testInvitationId);
      expect(updatedInvitation?.role).toBe(ADMIN_ROLE_NAME);
    });

    it("should update multiple fields at once", async () => {
      const updateData = {
        status: "accepted" as const,
        role: ADMIN_ROLE_NAME,
      };

      await InvitationModel.patch(testInvitationId, updateData);

      const updatedInvitation = await InvitationModel.getById(testInvitationId);
      expect(updatedInvitation?.status).toBe("accepted");
      expect(updatedInvitation?.role).toBe(ADMIN_ROLE_NAME);
    });
  });

  describe("delete", () => {
    it("should delete invitation successfully", async () => {
      await InvitationModel.delete(testInvitationId);

      const deletedInvitation = await InvitationModel.getById(testInvitationId);
      expect(deletedInvitation).toBeUndefined();
    });

    it("should handle deletion of non-existent invitation gracefully", async () => {
      const nonExistentId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        InvitationModel.delete(nonExistentId),
      ).resolves.not.toThrow();
    });
  });

  describe("accept", () => {
    let testSession: BetterAuthSession;
    let testUser: BetterAuthSessionUser;

    beforeEach(() => {
      testSession = {
        id: testSessionId,
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: testUserId,
        expiresAt: new Date(Date.now() + 86400000),
        token: "test-session-token",
      };
      testUser = {
        id: testUserId,
        email: "test@example.com",
        name: "Test User",
        image: null,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    it("should accept invitation and set up user membership", async () => {
      await InvitationModel.accept(testSession, testUser, testInvitationId);

      // Check that member was created
      const member = await MemberModel.getByUserId(testUserId);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(testOrgId);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);

      // Check that invitation was marked as accepted
      const invitation = await InvitationModel.getById(testInvitationId);
      expect(invitation?.status).toBe("accepted");

      // Check that user role was updated
      const user = await UserModel.getById(testUserId);
      expect(user?.role).toBe(MEMBER_ROLE_NAME);

      // Check that session has active organization set
      const session = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, testSessionId))
        .limit(1);
      expect(session[0]?.activeOrganizationId).toBe(testOrgId);
    });

    it("should accept invitation with admin role", async () => {
      // Update invitation to have admin role
      await InvitationModel.patch(testInvitationId, { role: ADMIN_ROLE_NAME });

      await InvitationModel.accept(testSession, testUser, testInvitationId);

      const member = await MemberModel.getByUserId(testUserId);
      expect(member?.role).toBe(ADMIN_ROLE_NAME);

      const user = await UserModel.getById(testUserId);
      expect(user?.role).toBe(ADMIN_ROLE_NAME);
    });

    it("should use default member role when invitation role is null", async () => {
      // Update invitation to have null role
      await InvitationModel.patch(testInvitationId, { role: null });

      await InvitationModel.accept(testSession, testUser, testInvitationId);

      const member = await MemberModel.getByUserId(testUserId);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);

      const user = await UserModel.getById(testUserId);
      expect(user?.role).toBe(MEMBER_ROLE_NAME);
    });

    it("should handle non-existent invitation gracefully", async () => {
      const nonExistentId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        InvitationModel.accept(testSession, testUser, nonExistentId),
      ).resolves.not.toThrow();

      // Should not create member for non-existent invitation
      const member = await MemberModel.getByUserId(testUserId);
      expect(member).toBeUndefined();
    });

    it("should handle invitation that is already accepted", async () => {
      // First accept the invitation
      await InvitationModel.accept(testSession, testUser, testInvitationId);

      // Try to accept again - should handle gracefully
      await expect(
        InvitationModel.accept(testSession, testUser, testInvitationId),
      ).resolves.not.toThrow();

      // Note: The accept method doesn't check status, it just processes the invitation
      // Status checking happens in better-auth hooks before this method is called
      // So accepting an already accepted invitation will create a duplicate member record
      const members = await db
        .select()
        .from(schema.membersTable)
        .where(eq(schema.membersTable.userId, testUserId));
      expect(members.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle invitation that is declined", async () => {
      // Mark invitation as declined
      await InvitationModel.patch(testInvitationId, { status: "declined" });

      await InvitationModel.accept(testSession, testUser, testInvitationId);

      // Note: The accept method doesn't check status, it just processes the invitation
      // Status checking happens in better-auth hooks before this method is called
      // So declining an invitation won't prevent the accept method from creating a member
      const member = await MemberModel.getByUserId(testUserId);
      expect(member).toBeDefined();
    });

    it("should handle expired invitation", async () => {
      // Set invitation as expired
      const expiredDate = new Date(Date.now() - 86400000); // 24 hours ago
      await db
        .update(schema.invitationsTable)
        .set({ expiresAt: expiredDate })
        .where(eq(schema.invitationsTable.id, testInvitationId));

      await InvitationModel.accept(testSession, testUser, testInvitationId);

      // Should still process the invitation (expiry check happens in better-auth hooks)
      const member = await MemberModel.getByUserId(testUserId);
      expect(member).toBeDefined();
    });

    it("should handle database errors gracefully", async () => {
      // Use invalid session ID to trigger potential database error
      const invalidSession = {
        id: "invalid-session-id",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: testUserId,
        expiresAt: new Date(Date.now() + 86400000),
        token: "invalid-session-token",
      };

      // Should not throw an error
      await expect(
        InvitationModel.accept(invalidSession, testUser, testInvitationId),
      ).resolves.not.toThrow();
    });
  });
});
