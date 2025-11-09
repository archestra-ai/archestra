import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import type { BetterAuthSession, BetterAuthSessionUser } from "@/types";
import InvitationModel from "./invitation";
import MemberModel from "./member";

describe("InvitationModel", () => {
  describe("getById", () => {
    test("should return invitation when it exists", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "test@example.com",
      });

      const found = await InvitationModel.getById(invitation.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(invitation.id);
      expect(found?.email).toBe("test@example.com");
      expect(found?.organizationId).toBe(org.id);
      expect(found?.role).toBe(MEMBER_ROLE_NAME);
      expect(found?.status).toBe("pending");
      expect(found?.inviterId).toBe(inviter.id);
    });

    test("should return undefined when invitation does not exist", async () => {
      const nonExistentId = crypto.randomUUID();
      const invitation = await InvitationModel.getById(nonExistentId);

      expect(invitation).toBeUndefined();
    });
  });

  describe("patch", () => {
    test("should update invitation status", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id);

      await InvitationModel.patch(invitation.id, { status: "accepted" });

      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });

    test("should update invitation role", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id);

      await InvitationModel.patch(invitation.id, { role: ADMIN_ROLE_NAME });

      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.role).toBe(ADMIN_ROLE_NAME);
    });

    test("should update multiple fields at once", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id);

      const updateData = {
        status: "accepted" as const,
        role: ADMIN_ROLE_NAME,
      };

      await InvitationModel.patch(invitation.id, updateData);

      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
      expect(updatedInvitation?.role).toBe(ADMIN_ROLE_NAME);
    });
  });

  describe("delete", () => {
    test("should delete invitation successfully", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id);

      await InvitationModel.delete(invitation.id);

      const deletedInvitation = await InvitationModel.getById(invitation.id);
      expect(deletedInvitation).toBeUndefined();
    });

    test("should handle deletion of non-existent invitation gracefully", async () => {
      const nonExistentId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        InvitationModel.delete(nonExistentId),
      ).resolves.not.toThrow();
    });
  });

  describe("accept", () => {
    test("should accept invitation and set up user membership", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const user = await makeUser({ email: "test@example.com" });
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "test@example.com",
      });

      const testSession: BetterAuthSession = {
        id: crypto.randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: user.id,
        expiresAt: new Date(Date.now() + 86400000),
        token: "test-session-token",
      };

      const testUser: BetterAuthSessionUser = {
        id: user.id,
        email: "test@example.com",
        name: "Test User",
        image: null,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await InvitationModel.accept(testSession, testUser, invitation.id);

      // Check that member was created
      const member = await MemberModel.getByUserId(user.id);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);

      // Check that invitation was updated to accepted
      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });
  });
});
