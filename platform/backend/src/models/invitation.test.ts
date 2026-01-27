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
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);

      // Check that invitation was updated to accepted
      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });

    test("should accept invitation with custom role and assign that role to user", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const user = await makeUser({ email: "custom-role@example.com" });

      // Create a custom role for the organization
      const customRole = await makeCustomRole(org.id, {
        role: "custom_reader",
        name: "Custom Reader",
        permission: { profile: ["read"] },
      });

      // Create invitation with the custom role
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "custom-role@example.com",
        role: customRole.role,
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
        email: "custom-role@example.com",
        name: "Custom Role User",
        image: null,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await InvitationModel.accept(testSession, testUser, invitation.id);

      // Check that member was created with the custom role
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe(customRole.role);

      // Check that invitation was updated to accepted
      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });

    test("should accept invitation with predefined editor role", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const user = await makeUser({ email: "editor@example.com" });

      // Create invitation with the editor role
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "editor@example.com",
        role: "editor",
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
        email: "editor@example.com",
        name: "Editor User",
        image: null,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await InvitationModel.accept(testSession, testUser, invitation.id);

      // Check that member was created with the editor role
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe("editor");

      // Check that invitation was updated to accepted
      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });

    test("should accept invitation with admin role", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const user = await makeUser({ email: "admin@example.com" });

      // Create invitation with the admin role
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "admin@example.com",
        role: ADMIN_ROLE_NAME,
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
        email: "admin@example.com",
        name: "Admin User",
        image: null,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await InvitationModel.accept(testSession, testUser, invitation.id);

      // Check that member was created with the admin role
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe(ADMIN_ROLE_NAME);

      // Check that invitation was updated to accepted
      const updatedInvitation = await InvitationModel.getById(invitation.id);
      expect(updatedInvitation?.status).toBe("accepted");
    });
  });

  describe("findByEmail", () => {
    test("should find all invitations for an email", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();

      // Create multiple invitations for same email
      await makeInvitation(org.id, inviter.id, { email: "findme@example.com" });
      await makeInvitation(org.id, inviter.id, { email: "findme@example.com" });

      const invitations =
        await InvitationModel.findByEmail("findme@example.com");

      expect(invitations).toHaveLength(2);
      expect(invitations.every((i) => i.email === "findme@example.com")).toBe(
        true,
      );
    });

    test("should return empty array for non-existent email", async () => {
      const invitations = await InvitationModel.findByEmail(
        "nonexistent@example.com",
      );

      expect(invitations).toEqual([]);
    });

    test("should be case-insensitive", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();

      await makeInvitation(org.id, inviter.id, { email: "test@example.com" });

      const invitations = await InvitationModel.findByEmail("test@example.com");

      expect(invitations).toHaveLength(1);
    });
  });

  describe("findPendingByEmail", () => {
    test("should find pending invitation for an email", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();

      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "pending@example.com",
      });

      const found = await InvitationModel.findPendingByEmail(
        "pending@example.com",
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(invitation.id);
      expect(found?.status).toBe("pending");
    });

    test("should return undefined if no pending invitation exists", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();

      // Create an accepted invitation
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "accepted@example.com",
      });
      await InvitationModel.patch(invitation.id, { status: "accepted" });

      const found = await InvitationModel.findPendingByEmail(
        "accepted@example.com",
      );

      expect(found).toBeUndefined();
    });

    test("should return undefined for non-existent email", async () => {
      const found = await InvitationModel.findPendingByEmail(
        "nonexistent@example.com",
      );

      expect(found).toBeUndefined();
    });
  });
});
